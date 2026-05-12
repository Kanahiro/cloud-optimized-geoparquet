// Minimal WKB → GeoJSON decoder + row→feature builder.
//
// Supports ISO WKB (the variant GeoParquet 1.1 mandates) for the standard
// geometry types. Z/M coordinates are read and dropped so the output is
// always 2D, which is sufficient for map rendering.

export type Position = [number, number];

export type Point = { type: 'Point'; coordinates: Position };
export type LineString = { type: 'LineString'; coordinates: Position[] };
export type Polygon = { type: 'Polygon'; coordinates: Position[][] };
export type MultiPoint = { type: 'MultiPoint'; coordinates: Position[] };
export type MultiLineString = { type: 'MultiLineString'; coordinates: Position[][] };
export type MultiPolygon = { type: 'MultiPolygon'; coordinates: Position[][][] };
export type GeometryCollection = {
  type: 'GeometryCollection';
  geometries: Geometry[];
};
export type Geometry =
  | Point
  | LineString
  | Polygon
  | MultiPoint
  | MultiLineString
  | MultiPolygon
  | GeometryCollection;

export interface Feature {
  type: 'Feature';
  geometry: Geometry | null;
  properties: Record<string, unknown>;
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
}

class Cursor {
  offset = 0;
  little = true;
  constructor(readonly view: DataView) {}

  u8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.offset, this.little);
    this.offset += 4;
    return v;
  }
  f64(): number {
    const v = this.view.getFloat64(this.offset, this.little);
    this.offset += 8;
    return v;
  }
}

function readPoint(c: Cursor, dims: number): Position {
  const x = c.f64();
  const y = c.f64();
  for (let i = 2; i < dims; i++) c.f64();
  return [x, y];
}

function readLineString(c: Cursor, dims: number): Position[] {
  const n = c.u32();
  const out: Position[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = readPoint(c, dims);
  return out;
}

function readPolygon(c: Cursor, dims: number): Position[][] {
  const n = c.u32();
  const out: Position[][] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = readLineString(c, dims);
  return out;
}

function readGeometry(c: Cursor): Geometry | null {
  c.little = c.u8() === 1;
  const raw = c.u32();
  // ISO WKB packs Z/M into the high digit. Modulo 1000 yields the base type.
  const base = raw % 1000;
  const hi = Math.floor(raw / 1000);
  const hasZ = hi === 1 || hi === 3;
  const hasM = hi === 2 || hi === 3;
  const dims = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);

  switch (base) {
    case 1:
      return { type: 'Point', coordinates: readPoint(c, dims) };
    case 2:
      return { type: 'LineString', coordinates: readLineString(c, dims) };
    case 3:
      return { type: 'Polygon', coordinates: readPolygon(c, dims) };
    case 4: {
      const n = c.u32();
      const coords: Position[] = new Array(n);
      for (let i = 0; i < n; i++) {
        const sub = readGeometry(c);
        if (!sub || sub.type !== 'Point') return null;
        coords[i] = sub.coordinates;
      }
      return { type: 'MultiPoint', coordinates: coords };
    }
    case 5: {
      const n = c.u32();
      const coords: Position[][] = new Array(n);
      for (let i = 0; i < n; i++) {
        const sub = readGeometry(c);
        if (!sub || sub.type !== 'LineString') return null;
        coords[i] = sub.coordinates;
      }
      return { type: 'MultiLineString', coordinates: coords };
    }
    case 6: {
      const n = c.u32();
      const coords: Position[][][] = new Array(n);
      for (let i = 0; i < n; i++) {
        const sub = readGeometry(c);
        if (!sub || sub.type !== 'Polygon') return null;
        coords[i] = sub.coordinates;
      }
      return { type: 'MultiPolygon', coordinates: coords };
    }
    case 7: {
      const n = c.u32();
      const geoms: Geometry[] = [];
      for (let i = 0; i < n; i++) {
        const sub = readGeometry(c);
        if (sub && sub.type !== 'GeometryCollection') geoms.push(sub);
      }
      return { type: 'GeometryCollection', geometries: geoms };
    }
    default:
      return null;
  }
}

export function wkbToGeometry(bytes: Uint8Array): Geometry | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return readGeometry(new Cursor(view));
}

// Strip property values GeoJSON consumers can't handle. `bigint` is coerced to
// Number (precision loss past 2^53 is acceptable for visualization); binary
// blobs are dropped rather than serialized.
function sanitizeProperty(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Uint8Array) return undefined;
  return v;
}

export function rowsToFeatureCollection(
  rows: ReadonlyArray<Record<string, unknown>>,
  geomColumn: string,
): FeatureCollection {
  const features: Feature[] = [];
  for (const row of rows) {
    const wkb = row[geomColumn];
    if (!(wkb instanceof Uint8Array)) continue;
    const geometry = wkbToGeometry(wkb);
    if (!geometry) continue;
    const properties: Record<string, unknown> = {};
    for (const k in row) {
      if (k === geomColumn) continue;
      const sanitized = sanitizeProperty(row[k]);
      if (sanitized !== undefined) properties[k] = sanitized;
    }
    features.push({ type: 'Feature', geometry, properties });
  }
  return { type: 'FeatureCollection', features };
}
