import type { QuantizedOverviewGeometry } from 'cogp';

import { formatPropertyValue } from './properties.js';

import { MVT_LAYER_NAME } from './cogp-types.js';
import {
  clipLineString,
  clipPolygonRing,
  pointInBbox,
  type ClipBbox,
  type Position,
} from './clip.js';

export const MVT_EXTENT = 4096;
export const MVT_BUFFER = 64;
const MVT_CLIP_BBOX: ClipBbox = [
  -MVT_BUFFER,
  -MVT_BUFFER,
  MVT_EXTENT + MVT_BUFFER,
  MVT_EXTENT + MVT_BUFFER,
];

const MAX_MERCATOR_LATITUDE = 85.0511287798066;
const textEncoder = new TextEncoder();

/** Geometry, stable source-row identity, and optional popup attributes. */
export interface EncodedMvtFeature {
  id: number;
  type: 1 | 2 | 3;
  geometry: Uint8Array;
  properties?: Record<string, unknown>;
}

/**
 * Build a decoder for CogpReader.readRows. It consumes the selected overview's
 * typed arrays in place and writes MVT command integers directly: no WKB,
 * GeoJSON coordinate tree, geojson-vt index, or Point wrapper is allocated.
 *
 * CogpReader bbox-prunes candidates at page granularity. Clipping them here
 * to the buffered extent avoids sending whole large geometries to MapLibre.
 */
export function createOverviewMvtEncoder(
  z: number,
  x: number,
  y: number,
): (
  overview: QuantizedOverviewGeometry | null,
  id: number,
) => EncodedMvtFeature | null {
  const projection = new TileProjection(z, x, y);
  return (overview, id) => overview
    ? encodeOverviewFeature(overview, projection, id)
    : null;
}

/** Encode primary geometry decoded by the reader when no overviews are declared. */
export function encodePrimaryFeature(
  geometry: unknown,
  z: number,
  x: number,
  y: number,
  id = 0,
): EncodedMvtFeature | null {
  const value = geometry as {
    type?: string;
    coordinates?: unknown;
  } | null;
  if (!value) return null;
  const projection = new TileProjection(z, x, y);
  const commands = new ByteWriter();
  let cursorX = 0;
  let cursorY = 0;

  if (value.type === 'Point') {
    const coordinate = value.coordinates as readonly number[];
    if (!validCoordinate(coordinate)) return null;
    const px = projection.x(coordinate[0]!);
    const py = projection.y(coordinate[1]!);
    if (!pointInBbox(px, py, MVT_CLIP_BBOX)) return null;
    commands.writeVarint(command(1, 1));
    commands.writeVarint(zigZag(px - cursorX));
    commands.writeVarint(zigZag(py - cursorY));
  } else if (value.type === 'MultiPoint') {
    const coordinates = value.coordinates as readonly (readonly number[])[];
    const clipped: Position[] = [];
    for (const coordinate of coordinates) {
      if (!validCoordinate(coordinate)) continue;
      const px = projection.x(coordinate[0]!);
      const py = projection.y(coordinate[1]!);
      if (pointInBbox(px, py, MVT_CLIP_BBOX)) clipped.push([px, py]);
    }
    if (clipped.length === 0) return null;
    commands.writeVarint(command(1, clipped.length));
    for (const [px, py] of clipped) {
      commands.writeVarint(zigZag(px - cursorX));
      commands.writeVarint(zigZag(py - cursorY));
      cursorX = px;
      cursorY = py;
    }
  } else {
    const type = ({ LineString: 2, Polygon: 3, MultiLineString: 5, MultiPolygon: 6 } as const)[value.type as 'LineString'];
    if (!type) return null;
    const xs: number[] = [];
    const ys: number[] = [];
    const partEnds: number[] = [];
    const polygonEnds: number[] = [];
    const part = (coordinates: readonly (readonly number[])[]) => {
      for (const coordinate of coordinates) {
        if (!validCoordinate(coordinate)) throw new Error('invalid primary coordinate');
        xs.push(coordinate[0]!); ys.push(coordinate[1]!);
      }
      partEnds.push(xs.length);
    };
    if (value.type === 'LineString') {
      part(value.coordinates as number[][]);
      partEnds.length = 0;
    } else if (value.type === 'MultiPolygon') {
      for (const polygon of value.coordinates as number[][][][]) {
        for (const ring of polygon) part(ring);
        polygonEnds.push(partEnds.length);
      }
    } else {
      for (const lineOrRing of value.coordinates as number[][][]) part(lineOrRing);
    }
    return encodeOverviewFeature({ type, x: xs, y: ys, partEnds, polygonEnds,
      scale: [1, 1], offset: [0, 0] }, projection, id);
  }
  return { id, type: 1, geometry: commands.finish() };
}

export function encodeMvtTile(features: readonly EncodedMvtFeature[]): ArrayBuffer {
  const layer = new ByteWriter();
  layer.writeVarintField(15, 2);
  layer.writeStringField(1, MVT_LAYER_NAME);
  const keys = new Map<string, number>();
  const values = new Map<string, number>();
  for (const feature of features) {
    const tags = new ByteWriter();
    for (const [key, value] of Object.entries(feature.properties ?? {})) {
      const text = formatPropertyValue(value);
      if (!keys.has(key)) keys.set(key, keys.size);
      if (!values.has(text)) values.set(text, values.size);
      tags.writeVarint(keys.get(key)!);
      tags.writeVarint(values.get(text)!);
    }
    layer.writeBytesField(2, encodeFeature(feature, tags.finish()));
  }
  for (const key of keys.keys()) layer.writeStringField(3, key);
  // Popup display strings are deduplicated across features within a tile.
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

function encodeOverviewFeature(
  overview: QuantizedOverviewGeometry,
  projection: TileProjection,
  id: number,
): EncodedMvtFeature | null {
  // Page-level pruning can leave many off-tile features. Latitude bounds are
  // monotonic in Mercator, even across the antimeridian; reject them before
  // allocating projected paths or evaluating trigonometry for every vertex.
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < overview.y.length; i++) {
    const y = Number(overview.y[i]);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (overview.y.length === 0) return null;
  const a = projection.y(overview.offset[1] + overview.scale[1] * minY);
  const b = projection.y(overview.offset[1] + overview.scale[1] * maxY);
  if (Math.max(a, b) < MVT_CLIP_BBOX[1] || Math.min(a, b) > MVT_CLIP_BBOX[3]) return null;

  const mvtType = overview.type === 1 || overview.type === 4
    ? 1
    : overview.type === 2 || overview.type === 5
      ? 2
      : 3;
  const commands = new ByteWriter();
  const cursor = { x: 0, y: 0 };

  if (mvtType === 1) {
    writeOverviewPoints(commands, overview, projection, cursor);
  } else if (overview.type === 2) {
    writeOverviewLine(commands, overview, projection, cursor, 0, overview.x.length);
  } else {
    let start = 0;
    for (let i = 0; i < overview.partEnds.length; i++) {
      const end = Number(overview.partEnds[i]);
      if (mvtType === 3) {
        writeOverviewPolygonRing(commands, overview, projection, cursor, start, end);
      } else {
        writeOverviewLine(commands, overview, projection, cursor, start, end);
      }
      start = end;
    }
  }

  return commands.length === 0
    ? null
    : { id, type: mvtType, geometry: commands.finish() };
}

function writeOverviewPoints(
  commands: ByteWriter,
  overview: QuantizedOverviewGeometry,
  projection: TileProjection,
  cursor: { x: number; y: number },
): void {
  const count = overview.x.length;
  if (count === 0) return;
  const coordinates: Position[] = [];
  for (let i = 0; i < count; i++) {
    const px = projectOverviewX(overview, projection, i);
    const py = projectOverviewY(overview, projection, i);
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

function writeOverviewLine(
  commands: ByteWriter,
  overview: QuantizedOverviewGeometry,
  projection: TileProjection,
  cursor: { x: number; y: number },
  start: number,
  end: number,
): void {
  const coordinates = projectOverviewPart(overview, projection, start, end, false);
  for (const part of clipLineString(coordinates, MVT_CLIP_BBOX)) {
    writePath(commands, cursor, part, false);
  }
}

function writeOverviewPolygonRing(
  commands: ByteWriter,
  overview: QuantizedOverviewGeometry,
  projection: TileProjection,
  cursor: { x: number; y: number },
  start: number,
  end: number,
): void {
  const coordinates = projectOverviewPart(overview, projection, start, end, true);
  const clipped = clipPolygonRing(coordinates, MVT_CLIP_BBOX);
  writePath(commands, cursor, clipped, true);
}

function projectOverviewPart(
  overview: QuantizedOverviewGeometry,
  projection: TileProjection,
  start: number,
  end: number,
  closed: boolean,
): Position[] {
  const repeatsFirst = closed
    && end - start > 1
    && Number(overview.x[start]) === Number(overview.x[end - 1])
    && Number(overview.y[start]) === Number(overview.y[end - 1]);
  const limit = end - (repeatsFirst ? 1 : 0);
  const coordinates: Position[] = [];
  let previousPartX: number | undefined;
  for (let index = start; index < limit; index++) {
    const px = projectOverviewX(overview, projection, index, previousPartX);
    coordinates.push([px, projectOverviewY(overview, projection, index)]);
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

function projectOverviewX(
  overview: QuantizedOverviewGeometry,
  projection: TileProjection,
  index: number,
  reference?: number,
): number {
  return projection.x(
    overview.offset[0] + overview.scale[0] * Number(overview.x[index]),
    reference,
  );
}

function projectOverviewY(
  overview: QuantizedOverviewGeometry,
  projection: TileProjection,
  index: number,
): number {
  return projection.y(overview.offset[1] + overview.scale[1] * Number(overview.y[index]));
}

function encodeFeature(value: EncodedMvtFeature, tags: Uint8Array): Uint8Array {
  const feature = new ByteWriter(value.geometry.byteLength + 32);
  feature.writeVarintField(1, value.id);
  if (tags.byteLength) feature.writeBytesField(2, tags);
  feature.writeVarintField(3, value.type);
  feature.writeBytesField(4, value.geometry);
  return feature.finish();
}

function validCoordinate(value: readonly number[]): boolean {
  return value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]);
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
