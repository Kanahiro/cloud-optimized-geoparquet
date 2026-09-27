import { throwIfAborted } from './abort.js';
import { requireGeometry, type FeatureSource, type GeometryColumn } from './geometry.js';
import { formatPropertyValue } from './properties.js';
import {
  clipLineString,
  clipPolygonRing,
  pointInBbox,
  type ClipBbox,
  type Position,
} from './clip.js';

/** Tile coordinate extent written by `toMvt`. */
export const MVT_EXTENT = 4096;
/** Clip buffer around each tile, in `MVT_EXTENT` units. */
export const MVT_BUFFER = 64;
const DEFAULT_LAYER_NAME = 'cogp';
const MVT_CLIP_BBOX: ClipBbox = [
  -MVT_BUFFER,
  -MVT_BUFFER,
  MVT_EXTENT + MVT_BUFFER,
  MVT_EXTENT + MVT_BUFFER,
];

const MAX_MERCATOR_LATITUDE = 85.0511287798066;
const textEncoder = new TextEncoder();

export interface MvtTileOptions {
  z: number;
  x: number;
  y: number;
  /** Default: `cogp`. */
  layer?: string;
  /** Checked every 1024 rows. */
  signal?: AbortSignal;
}

/**
 * Encode lon/lat rows as one Web Mercator MVT tile. Geometry is projected,
 * clipped to the buffered extent and dropped when null or off-tile. IDs must be
 * non-negative safe integers; properties are written as display strings.
 * Columns are read in place: no GeoJSON or per-row feature object is built.
 */
export function toMvt(source: FeatureSource, options: MvtTileOptions): ArrayBuffer {
  const geometry = requireGeometry(source);
  const ids = source.rowIndex;
  const projection = new TileProjection(options.z, options.x, options.y);
  const encoded: EncodedMvtFeature[] = [];
  for (let row = 0; row < geometry.length; row++) {
    if ((row & 1023) === 0) throwIfAborted(options.signal);
    const feature = encodeGeometry(geometry, row, projection, ids?.[row]);
    if (feature) { feature.row = row; encoded.push(feature); }
  }
  throwIfAborted(options.signal);
  const columns = source.columns ? Object.entries(source.columns) : [];
  return writeTile(encoded, options.layer ?? DEFAULT_LAYER_NAME, (feature, tag) => {
    for (const [key, values] of columns) tag(key, values[feature.row!]);
  });
}

/** Encoded geometry, stable source-row identity, and optional attributes. */
export interface EncodedMvtFeature {
  id?: number | undefined;
  type: 1 | 2 | 3;
  geometry: Uint8Array;
  properties?: Record<string, unknown>;
  /** Source row in the encoded `GeometryColumn`. */
  row?: number;
}

/** Encode one row of a `GeometryColumn` for tile z/x/y. */
export function encodeGeometryRow(
  column: GeometryColumn,
  row: number,
  z: number,
  x: number,
  y: number,
  id?: number,
): EncodedMvtFeature | null {
  return encodeGeometry(column, row, new TileProjection(z, x, y), id);
}

/** Assemble features whose properties are plain objects. */
export function encodeMvtTile(features: readonly EncodedMvtFeature[], layerName = DEFAULT_LAYER_NAME): ArrayBuffer {
  return writeTile(features, layerName, (feature, tag) => {
    for (const [key, value] of Object.entries(feature.properties ?? {})) tag(key, value);
  });
}

function writeTile(
  features: readonly EncodedMvtFeature[],
  layerName: string,
  properties: (feature: EncodedMvtFeature, tag: (key: string, value: unknown) => void) => void,
): ArrayBuffer {
  const layer = new ByteWriter();
  layer.writeVarintField(15, 2);
  layer.writeStringField(1, layerName);
  const keys = new Map<string, number>();
  const values = new Map<string, number>();
  for (const feature of features) {
    const tags = new ByteWriter();
    properties(feature, (key, value) => {
      const text = formatPropertyValue(value);
      if (!keys.has(key)) keys.set(key, keys.size);
      if (!values.has(text)) values.set(text, values.size);
      tags.writeVarint(keys.get(key)!);
      tags.writeVarint(values.get(text)!);
    });
    writeFeature(layer, feature, tags.finish());
  }
  for (const key of keys.keys()) layer.writeStringField(3, key);
  // Display strings are deduplicated across features within a tile.
  for (const text of values.keys()) {
    const value = new ByteWriter();
    value.writeStringField(1, text);
    layer.writeBytesField(4, value.finish());
  }
  layer.writeVarintField(5, MVT_EXTENT);

  const tile = new ByteWriter(layer.length + 16);
  tile.writeBytesField(3, layer.finish());
  return tile.finish().buffer as ArrayBuffer;
}

/**
 * Write MVT command integers directly from the column's coordinate arrays.
 * CogpReader selects candidate rows; reject distant parts here before
 * projecting and clipping their coordinates to the buffered tile extent.
 */
function encodeGeometry(
  column: GeometryColumn,
  row: number,
  projection: TileProjection,
  id: number | undefined,
): EncodedMvtFeature | null {
  const type = column.types[row];
  if (!type) return null;
  const { geometryOffsets: go, polygonOffsets: po, ringOffsets: ro } = column;
  const p0 = go[row]!, p1 = go[row + 1]!;
  const c0 = ro[po[p0]!]!, c1 = ro[po[p1]!]!;
  if (c0 === c1) return null;
  const mvtType = type === 1 || type === 4 ? 1 : type === 2 || type === 5 ? 2 : 3;
  const commands = new ByteWriter();
  const cursor = { x: 0, y: 0 };
  if (mvtType === 1) {
    if (!partIntersectsTile(column, projection, c0, c1)) return null;
    writePoints(commands, column, projection, cursor, c0, c1);
  } else {
    for (let p = p0; p < p1; p++) {
      const firstRing = po[p]!, lastRing = po[p + 1]!;
      if (mvtType === 3 && (firstRing === lastRing
        || !partIntersectsTile(column, projection, ro[firstRing]!, ro[lastRing]!))) continue;
      for (let r = firstRing; r < lastRing; r++) {
        if (mvtType === 3) writePolygonRing(commands, column, projection, cursor, ro[r]!, ro[r + 1]!, r === firstRing);
        else if (partIntersectsTile(column, projection, ro[r]!, ro[r + 1]!)) {
          writeLine(commands, column, projection, cursor, ro[r]!, ro[r + 1]!);
        }
      }
    }
  }
  return commands.length === 0 ? null : { id, type: mvtType, geometry: commands.finish() };
}

/** Reject a part before projecting or clipping all its coordinates. */
function partIntersectsTile(column: GeometryColumn, projection: TileProjection, start: number, end: number): boolean {
  if (start >= end) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = start; i < end; i++) {
    const x = column.x[i]!, y = column.y[i]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  // Leave non-finite inputs to the existing projection and clipping path.
  if (!Number.isFinite(minX) || !Number.isFinite(minY)
    || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return true;
  const west = column.offset[0] + column.scale[0] * minX;
  const east = column.offset[0] + column.scale[0] * maxX;
  if (!projection.intersectsLongitudeRange(Math.min(west, east), Math.max(west, east))) return false;
  const south = projection.y(column.offset[1] + column.scale[1] * minY);
  const north = projection.y(column.offset[1] + column.scale[1] * maxY);
  return Math.max(south, north) >= MVT_CLIP_BBOX[1] && Math.min(south, north) <= MVT_CLIP_BBOX[3];
}

function writePoints(
  commands: ByteWriter,
  column: GeometryColumn,
  projection: TileProjection,
  cursor: { x: number; y: number },
  start: number,
  end: number,
): void {
  const coordinates: Position[] = [];
  for (let i = start; i < end; i++) {
    const px = projectX(column, projection, i);
    const py = projectY(column, projection, i);
    if (!pointInBbox(px, py, MVT_CLIP_BBOX)) continue;
    coordinates.push([px, py]);
  }
  if (coordinates.length === 0) return;
  commands.writeVarint(command(1, coordinates.length));
  for (const [px, py] of coordinates) {
    commands.writeVarint(zigZag(px - cursor.x));
    commands.writeVarint(zigZag(py - cursor.y));
    cursor.x = px;
    cursor.y = py;
  }
}

function writeLine(
  commands: ByteWriter,
  column: GeometryColumn,
  projection: TileProjection,
  cursor: { x: number; y: number },
  start: number,
  end: number,
): void {
  const coordinates = projectPart(column, projection, start, end, false);
  for (const part of clipLineString(coordinates, MVT_CLIP_BBOX)) {
    writePath(commands, cursor, part, false);
  }
}

function writePolygonRing(
  commands: ByteWriter,
  column: GeometryColumn,
  projection: TileProjection,
  cursor: { x: number; y: number },
  start: number,
  end: number,
  exterior: boolean,
): void {
  const coordinates = projectPart(column, projection, start, end, true);
  const clipped = clipPolygonRing(coordinates, MVT_CLIP_BBOX);
  // MVT uses clockwise exteriors in screen coordinates (Y points down).
  let area = 0;
  for (let i = 0; i < clipped.length; i++) {
    const a = clipped[i]!;
    const b = clipped[(i + 1) % clipped.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  if ((area > 0) !== exterior) clipped.reverse();
  writePath(commands, cursor, clipped, true);
}

function projectPart(
  column: GeometryColumn,
  projection: TileProjection,
  start: number,
  end: number,
  closed: boolean,
): Position[] {
  const repeatsFirst = closed
    && end - start > 1
    && column.x[start] === column.x[end - 1]
    && column.y[start] === column.y[end - 1];
  const limit = end - (repeatsFirst ? 1 : 0);
  const coordinates: Position[] = [];
  let previousPartX: number | undefined;
  for (let index = start; index < limit; index++) {
    const px = projectX(column, projection, index, previousPartX);
    coordinates.push([px, projectY(column, projection, index)]);
    previousPartX = px;
  }
  return coordinates;
}

function writePath(
  commands: ByteWriter,
  cursor: { x: number; y: number },
  coordinates: readonly Position[],
  close: boolean,
): void {
  const count = coordinates.length;
  if (count < (close ? 3 : 2)) return;

  commands.writeVarint(command(1, 1));
  for (let i = 0; i < count; i++) {
    if (i === 1) commands.writeVarint(command(2, count - 1));
    const [px, py] = coordinates[i]!;
    commands.writeVarint(zigZag(px - cursor.x));
    commands.writeVarint(zigZag(py - cursor.y));
    cursor.x = px;
    cursor.y = py;
  }
  if (close) commands.writeVarint(command(7, 1));
}

function projectX(column: GeometryColumn, projection: TileProjection, index: number, reference?: number): number {
  return projection.x(column.offset[0] + column.scale[0] * column.x[index]!, reference);
}

function projectY(column: GeometryColumn, projection: TileProjection, index: number): number {
  return projection.y(column.offset[1] + column.scale[1] * column.y[index]!);
}

function writeFeature(layer: ByteWriter, value: EncodedMvtFeature, tags: Uint8Array): void {
  // Protobuf requires the nested message length first. Its fields already have
  // known sizes, so write directly into the layer without a temporary buffer.
  const length = (value.id === undefined ? 0 : 1 + varintLength(value.id))
    + (tags.byteLength ? 1 + varintLength(tags.byteLength) + tags.byteLength : 0)
    + 1 + varintLength(value.type)
    + 1 + varintLength(value.geometry.byteLength) + value.geometry.byteLength;
  layer.writeVarint(2 * 8 + 2);
  layer.writeVarint(length);
  if (value.id !== undefined) layer.writeVarintField(1, value.id);
  if (tags.byteLength) layer.writeBytesField(2, tags);
  layer.writeVarintField(3, value.type);
  layer.writeBytesField(4, value.geometry);
}

function varintLength(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid protobuf varint');
  let length = 1;
  while (value >= 0x80) {
    value = Math.floor(value / 0x80);
    length++;
  }
  return length;
}

function command(id: 1 | 2 | 7, count: number): number {
  return count * 8 + id;
}

function zigZag(value: number): number {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 0x7fff_ffff) {
    throw new Error('MVT coordinate delta exceeds signed 32-bit range');
  }
  return value < 0 ? -value * 2 - 1 : value * 2;
}

class TileProjection {
  private readonly tiles: number;
  private readonly tileX: number;
  private readonly worldSize: number;

  constructor(
    z: number,
    x: number,
    private readonly tileY: number,
  ) {
    this.tiles = 2 ** z;
    this.tileX = ((x % this.tiles) + this.tiles) % this.tiles;
    this.worldSize = this.tiles * MVT_EXTENT;
  }

  x(longitude: number, reference = MVT_EXTENT / 2): number {
    let local = (((longitude + 180) / 360) * this.tiles - this.tileX) * MVT_EXTENT;
    local += Math.round((reference - local) / this.worldSize) * this.worldSize;
    return Math.round(local);
  }

  intersectsLongitudeRange(minimum: number, maximum: number): boolean {
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return true;
    // A ring crossing the antimeridian can follow the short path outside its
    // raw longitude interval; keep such wide intervals for exact clipping.
    if (maximum - minimum >= 180) return true;
    const left = (((minimum + 180) / 360) * this.tiles - this.tileX) * MVT_EXTENT;
    const right = (((maximum + 180) / 360) * this.tiles - this.tileX) * MVT_EXTENT;
    // TileProjection.x can shift a part by whole worlds. Check every possible
    // shifted copy, with one pixel of slack for coordinate rounding.
    const first = Math.ceil((MVT_CLIP_BBOX[0] - 1 - right) / this.worldSize);
    const last = Math.floor((MVT_CLIP_BBOX[2] + 1 - left) / this.worldSize);
    return first <= last;
  }

  y(latitude: number): number {
    const clamped = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
    const sin = Math.sin((clamped * Math.PI) / 180);
    const worldY = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
    return Math.round((worldY * this.tiles - this.tileY) * MVT_EXTENT);
  }
}

class ByteWriter {
  private bytes: Uint8Array;
  private offset = 0;

  constructor(capacity = 256) {
    this.bytes = new Uint8Array(Math.max(16, capacity));
  }

  get length(): number {
    return this.offset;
  }

  writeVarintField(field: number, value: number): void {
    this.writeVarint(field * 8);
    this.writeVarint(value);
  }

  writeStringField(field: number, value: string): void {
    this.writeBytesField(field, textEncoder.encode(value));
  }

  writeBytesField(field: number, value: Uint8Array): void {
    this.writeVarint(field * 8 + 2);
    this.writeVarint(value.byteLength);
    this.reserve(value.byteLength);
    this.bytes.set(value, this.offset);
    this.offset += value.byteLength;
  }

  writeVarint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid protobuf varint');
    this.reserve(10);
    while (value >= 0x80) {
      this.bytes[this.offset++] = (value % 0x80) + 0x80;
      value = Math.floor(value / 0x80);
    }
    this.bytes[this.offset++] = value;
  }

  finish(): Uint8Array {
    return this.bytes.slice(0, this.offset);
  }

  private reserve(extra: number): void {
    const required = this.offset + extra;
    if (required <= this.bytes.byteLength) return;
    let capacity = this.bytes.byteLength;
    while (capacity < required) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.bytes);
    this.bytes = grown;
  }
}
