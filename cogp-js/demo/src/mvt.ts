import type { QuantizedOverviewGeometry } from 'cogp';

import { MVT_LAYER_NAME } from './cogp-types';

export const MVT_EXTENT = 4096;
export const MVT_BUFFER = 64;

const MAX_MERCATOR_LATITUDE = 85.0511287798066;
const textEncoder = new TextEncoder();

/** A complete, property-free Vector Tile Feature protobuf message. */
export type EncodedMvtFeature = Uint8Array;

/**
 * Build a decoder for CogpReader.readRows. It consumes the selected overview's
 * typed arrays in place and writes MVT command integers directly: no WKB,
 * GeoJSON coordinate tree, geojson-vt index, or Point wrapper is allocated.
 *
 * Features are already bbox-filtered to the buffered tile by CogpReader.
 * Coordinates outside the extent are intentionally retained; MapLibre clips
 * buffered vector geometry at the tile boundary.
 */
export function createOverviewMvtEncoder(
  z: number,
  x: number,
  y: number,
): (overview: QuantizedOverviewGeometry | null) => EncodedMvtFeature | null {
  const projection = new TileProjection(z, x, y);
  return (overview) => overview ? encodeOverviewFeature(overview, projection) : null;
}

/** Point-family COGP files have no overview and therefore retain this fallback. */
export function encodePointFeature(
  geometry: unknown,
  z: number,
  x: number,
  y: number,
): EncodedMvtFeature | null {
  const value = geometry as {
    type?: string;
    coordinates?: readonly number[] | readonly (readonly number[])[];
  } | null;
  if (!value) return null;
  const projection = new TileProjection(z, x, y);
  const commands = new ByteWriter();
  let cursorX = 0;
  let cursorY = 0;

  if (value.type === 'Point') {
    const coordinate = value.coordinates as readonly number[];
    if (!validCoordinate(coordinate)) return null;
    commands.writeVarint(command(1, 1));
    const px = projection.x(coordinate[0]!);
    const py = projection.y(coordinate[1]!);
    commands.writeVarint(zigZag(px - cursorX));
    commands.writeVarint(zigZag(py - cursorY));
  } else if (value.type === 'MultiPoint') {
    const coordinates = value.coordinates as readonly (readonly number[])[];
    const valid = coordinates.filter(validCoordinate);
    if (valid.length === 0) return null;
    commands.writeVarint(command(1, valid.length));
    for (const coordinate of valid) {
      const px = projection.x(coordinate[0]!, cursorX);
      const py = projection.y(coordinate[1]!);
      commands.writeVarint(zigZag(px - cursorX));
      commands.writeVarint(zigZag(py - cursorY));
      cursorX = px;
      cursorY = py;
    }
  } else {
    return null;
  }
  return encodeFeature(1, commands.finish());
}

export function encodeMvtTile(features: readonly EncodedMvtFeature[]): ArrayBuffer {
  const layer = new ByteWriter();
  layer.writeVarintField(15, 2);
  layer.writeStringField(1, MVT_LAYER_NAME);
  for (const feature of features) layer.writeBytesField(2, feature);
  layer.writeVarintField(5, MVT_EXTENT);

  const tile = new ByteWriter(layer.length + 16);
  tile.writeBytesField(3, layer.finish());
  return tile.finish().buffer as ArrayBuffer;
}

function encodeOverviewFeature(
  overview: QuantizedOverviewGeometry,
  projection: TileProjection,
): EncodedMvtFeature | null {
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
    writeOverviewPart(commands, overview, projection, cursor, 0, overview.x.length, false);
  } else {
    let start = 0;
    for (let i = 0; i < overview.partEnds.length; i++) {
      const end = Number(overview.partEnds[i]);
      writeOverviewPart(commands, overview, projection, cursor, start, end, mvtType === 3);
      start = end;
    }
  }

  return commands.length === 0 ? null : encodeFeature(mvtType, commands.finish());
}

function writeOverviewPoints(
  commands: ByteWriter,
  overview: QuantizedOverviewGeometry,
  projection: TileProjection,
  cursor: { x: number; y: number },
): void {
  const count = overview.x.length;
  if (count === 0) return;
  commands.writeVarint(command(1, count));
  let previousPartX: number | undefined;
  for (let i = 0; i < count; i++) {
    const px = projectOverviewX(overview, projection, i, previousPartX);
    const py = projectOverviewY(overview, projection, i);
    commands.writeVarint(zigZag(px - cursor.x));
    commands.writeVarint(zigZag(py - cursor.y));
    cursor.x = px;
    cursor.y = py;
    previousPartX = px;
  }
}

function writeOverviewPart(
  commands: ByteWriter,
  overview: QuantizedOverviewGeometry,
  projection: TileProjection,
  cursor: { x: number; y: number },
  start: number,
  end: number,
  close: boolean,
): void {
  const repeatsFirst = close
    && end - start > 1
    && Number(overview.x[start]) === Number(overview.x[end - 1])
    && Number(overview.y[start]) === Number(overview.y[end - 1]);
  const count = end - start - (repeatsFirst ? 1 : 0);
  const minimum = close ? 3 : 2;
  if (count < minimum) return;

  commands.writeVarint(command(1, 1));
  let previousPartX: number | undefined;
  for (let i = 0; i < count; i++) {
    if (i === 1) commands.writeVarint(command(2, count - 1));
    const index = start + i;
    const px = projectOverviewX(overview, projection, index, previousPartX);
    const py = projectOverviewY(overview, projection, index);
    commands.writeVarint(zigZag(px - cursor.x));
    commands.writeVarint(zigZag(py - cursor.y));
    cursor.x = px;
    cursor.y = py;
    previousPartX = px;
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

function encodeFeature(type: 1 | 2 | 3, geometry: Uint8Array): Uint8Array {
  const feature = new ByteWriter(geometry.byteLength + 16);
  feature.writeVarintField(3, type);
  feature.writeBytesField(4, geometry);
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
