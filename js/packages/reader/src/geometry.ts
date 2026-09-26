/** 0 = null; 1..6 = Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon. */
export type GeometryType = 0 | 1 | 2 | 3 | 4 | 5 | 6;

type NumberArray = ArrayLike<number>;

/**
 * Columnar geometry for all rows of a `read()` result, in the GeoArrow
 * MultiPolygon layout shared by every geometry type: row `i` owns polygons
 * `geometryOffsets[i]..geometryOffsets[i + 1]`, polygon `p` owns rings (or
 * lines) `polygonOffsets[p]..[p + 1]`, and ring `r` owns coordinates
 * `ringOffsets[r]..[r + 1]`. Point-family rows use one polygon and one ring.
 *
 * Coordinate `k` is `offset + scale * [x[k], y[k]]`. Overviews keep their
 * quantized int32 values; primary WKB uses float64 with scale 1 and offset 0.
 */
export interface GeometryColumn {
  readonly length: number;
  readonly types: Uint8Array;
  readonly x: Int32Array | Float64Array;
  readonly y: Int32Array | Float64Array;
  /** Unscaled Z values, present only when WKB had a Z dimension (NaN where absent). */
  readonly z?: Float64Array;
  readonly geometryOffsets: Uint32Array;
  readonly polygonOffsets: Uint32Array;
  readonly ringOffsets: Uint32Array;
  readonly scale: readonly [number, number];
  readonly offset: readonly [number, number];
}

const UNIT_SCALE = Object.freeze([1, 1] as const);
const ZERO_OFFSET = Object.freeze([0, 0] as const);

/** Appends rows into growable column buffers. Callers reserve before writing coordinates. */
export class GeometryBuilder {
  length = 0;
  polygons = 0;
  rings = 0;
  coords = 0;
  types = new Uint8Array(64);
  geometryOffsets = new Uint32Array(65);
  polygonOffsets = new Uint32Array(65);
  ringOffsets = new Uint32Array(65);
  x: Int32Array | Float64Array;
  y: Int32Array | Float64Array;
  z: Float64Array | undefined;

  constructor(int32: boolean) {
    this.x = int32 ? new Int32Array(256) : new Float64Array(256);
    this.y = int32 ? new Int32Array(256) : new Float64Array(256);
  }

  startRow(type: GeometryType): void {
    // Each buffer grows on its own length: offsets need one more slot than types.
    if (this.length >= this.types.length) this.types = grow(this.types, this.length + 1);
    if (this.length + 1 >= this.geometryOffsets.length) {
      this.geometryOffsets = grow(this.geometryOffsets, this.length + 2);
    }
    this.types[this.length] = type;
    this.geometryOffsets[this.length++] = this.polygons;
  }

  startPolygon(): void {
    if (this.polygons + 1 >= this.polygonOffsets.length) {
      this.polygonOffsets = grow(this.polygonOffsets, this.polygons + 2);
    }
    this.polygonOffsets[this.polygons++] = this.rings;
  }

  startRing(): void {
    if (this.rings + 1 >= this.ringOffsets.length) this.ringOffsets = grow(this.ringOffsets, this.rings + 2);
    this.ringOffsets[this.rings++] = this.coords;
  }

  /** Ensure room for `n` more coordinates; then write `x[coords]`, `y[coords]` directly. */
  reserve(n: number): void {
    const required = this.coords + n;
    if (required <= this.x.length) return;
    this.x = grow(this.x, required);
    this.y = grow(this.y, required);
    if (this.z) this.z = grow(this.z, required, NaN);
  }

  /** Lazily add Z; coordinates written before the first Z value read NaN. */
  ensureZ(): Float64Array {
    if (!this.z) this.z = new Float64Array(this.x.length).fill(NaN);
    return this.z;
  }

  finish(scale: readonly [number, number] = UNIT_SCALE, offset: readonly [number, number] = ZERO_OFFSET): GeometryColumn {
    this.geometryOffsets[this.length] = this.polygons;
    this.polygonOffsets[this.polygons] = this.rings;
    this.ringOffsets[this.rings] = this.coords;
    const column = {
      length: this.length,
      types: this.types.slice(0, this.length),
      x: this.x.slice(0, this.coords),
      y: this.y.slice(0, this.coords),
      geometryOffsets: this.geometryOffsets.slice(0, this.length + 1),
      polygonOffsets: this.polygonOffsets.slice(0, this.polygons + 1),
      ringOffsets: this.ringOffsets.slice(0, this.rings + 1),
      scale,
      offset,
    };
    return this.z ? { ...column, z: this.z.slice(0, this.coords) } : column;
  }
}

function grow<T extends Uint8Array | Uint32Array | Int32Array | Float64Array>(array: T, required: number, fill?: number): T {
  let capacity = array.length * 2;
  while (capacity < required) capacity *= 2;
  const grown = new (array.constructor as new (length: number) => T)(capacity);
  grown.set(array as never);
  if (fill !== undefined) grown.fill(fill, array.length);
  return grown;
}

/** Parse a column of ISO or EWKB values into a `GeometryColumn`. */
export function geometryColumnFromWkb(values: ArrayLike<Uint8Array | null | undefined>): GeometryColumn {
  const builder = new GeometryBuilder(false);
  for (let i = 0; i < values.length; i++) appendWkb(builder, values[i]);
  return builder.finish();
}

/** Columns to convert; pass `read()` results as `{ geometry, ids: rowIndex, properties: columns }`. */
/** Rows to convert; a `CogpBatch` can be passed as is. */
export interface FeatureSource {
  /** Required at runtime; optional only so a `CogpBatch` type-checks. */
  geometry?: GeometryColumn;
  /** Feature IDs by row. Omitted IDs are not written. */
  rowIndex?: ArrayLike<number>;
  /** Attribute columns by name, one value per row. */
  columns?: Readonly<Record<string, ArrayLike<unknown>>>;
}

/** The source geometry, or an error naming the likely cause. */
export function requireGeometry(source: FeatureSource): GeometryColumn {
  if (!source.geometry) throw new Error('source has no geometry; include the geometry column when reading');
  return source.geometry;
}

/**
 * Convert every row into a GeoJSON FeatureCollection. Null geometries become
 * features with `geometry: null`; property values are passed through as decoded.
 */
export function toGeoJSON(source: FeatureSource): { type: 'FeatureCollection'; features: unknown[] } {
  const geometry = requireGeometry(source);
  const ids = source.rowIndex;
  const columns = source.columns ? Object.entries(source.columns) : [];
  const features = new Array<unknown>(geometry.length);
  for (let i = 0; i < geometry.length; i++) {
    const values: Record<string, unknown> = {};
    for (const [name, column] of columns) values[name] = column[i];
    const id = ids?.[i];
    features[i] = id === undefined
      ? { type: 'Feature', geometry: decodeGeometry(geometry, i), properties: values }
      : { type: 'Feature', id, geometry: decodeGeometry(geometry, i), properties: values };
  }
  return { type: 'FeatureCollection', features };
}

/** Decode row `index` of a `GeometryColumn` into a GeoJSON geometry object. */
export function decodeGeometry(column: GeometryColumn, index: number): unknown {
  if (!Number.isInteger(index) || index < 0 || index >= column.length) {
    throw new Error(`geometry index ${index} out of range [0, ${column.length})`);
  }
  const type = column.types[index]!;
  if (type === 0) return null;
  const { x, y, z, geometryOffsets: go, polygonOffsets: po, ringOffsets: ro } = column;
  const [sx, sy] = column.scale;
  const [ox, oy] = column.offset;
  const coordinate = (k: number): number[] => z
    ? [ox + sx * x[k]!, oy + sy * y[k]!, z[k]!]
    : [ox + sx * x[k]!, oy + sy * y[k]!];
  const ring = (r: number): number[][] => {
    const out: number[][] = [];
    for (let k = ro[r]!; k < ro[r + 1]!; k++) out.push(coordinate(k));
    return out;
  };
  const polygon = (p: number): number[][][] => {
    const out: number[][][] = [];
    for (let r = po[p]!; r < po[p + 1]!; r++) out.push(ring(r));
    return out;
  };
  const p0 = go[index]!;
  const p1 = go[index + 1]!;
  // Point-family and single geometries own at most one polygon.
  const firstRing = p0 < p1 && po[p0]! < po[p0 + 1]! ? po[p0]! : undefined;
  switch (type) {
    case 1: return { type: 'Point', coordinates: firstRing !== undefined && ro[firstRing]! < ro[firstRing + 1]! ? coordinate(ro[firstRing]!) : [] };
    case 2: return { type: 'LineString', coordinates: firstRing !== undefined ? ring(firstRing) : [] };
    case 3: return { type: 'Polygon', coordinates: p0 < p1 ? polygon(p0) : [] };
    case 4: return { type: 'MultiPoint', coordinates: firstRing !== undefined ? ring(firstRing) : [] };
    case 5: return { type: 'MultiLineString', coordinates: p0 < p1 ? polygon(p0) : [] };
    case 6: {
      const out: number[][][][] = [];
      for (let p = p0; p < p1; p++) out.push(polygon(p));
      return { type: 'MultiPolygon', coordinates: out };
    }
    default: throw new Error(`unsupported geometry type ${type}`);
  }
}

const GEOARROW_TYPES: Record<string, GeometryType> = { LineString: 2, Polygon: 3, MultiLineString: 5, MultiPolygon: 6 };

/** Map a `quantized_geoarrow` geometry type to its builder type and coordinate list depth. */
export function geoArrowLayout(geometryType: string | undefined): { type: GeometryType; depth: number } {
  const type = GEOARROW_TYPES[geometryType ?? ''];
  if (!type) throw new Error('invalid quantized_geoarrow geometry_type');
  return { type, depth: type === 2 ? 1 : type === 6 ? 3 : 2 };
}

/**
 * One physical Parquet leaf before list assembly, as exposed by hyparquet
 * column views. Row `r` owns events `rowOffsets[r - rowStart]..[+1]`; empty
 * definition levels mean every event is defined.
 */
export interface LevelLeaf {
  readonly rowStart: number;
  readonly rowOffsets: ArrayLike<number>;
  readonly valueOffsets: ArrayLike<number>;
  readonly pages: readonly {
    readonly values: ArrayLike<unknown>;
    readonly definitionLevels: ArrayLike<number>;
    readonly repetitionLevels: ArrayLike<number>;
    readonly eventStart: number;
    readonly eventEnd: number;
    readonly valueStart: number;
  }[];
}

/**
 * Append one `quantized_geoarrow` row from the Dremel levels of its int32 x
 * and y leaves, without materializing nested lists. Repetition level
 * `r < depth` opens a ring, and `r < depth - 1` also opens a polygon.
 * An empty outermost list, which covers a null or empty primary geometry,
 * appends a row without parts.
 */
export function appendGeoArrowLeaves(builder: GeometryBuilder, type: GeometryType, depth: number,
  x: LevelLeaf, y: LevelLeaf, maxDefinitionLevel: number, row: number): void {
  const rx = row - x.rowStart, ry = row - y.rowStart;
  const xFirst = x.rowOffsets[rx]!, yFirst = y.rowOffsets[ry]!;
  const events = x.rowOffsets[rx + 1]! - xFirst;
  if (!events || events !== y.rowOffsets[ry + 1]! - yFirst) {
    throw new Error('quantized_geoarrow overview is null, empty or has mismatched XY topology');
  }
  if (events === 1 && definitionLevel(x, xFirst) === maxDefinitionLevel - depth
    && definitionLevel(y, yFirst) === maxDefinitionLevel - depth) {
    builder.startRow(type);
    return;
  }
  builder.startRow(type);
  if (depth === 1) builder.startPolygon();
  builder.reserve(x.valueOffsets[rx + 1]! - x.valueOffsets[rx]!);
  const bx = builder.x, by = builder.y;
  let xp = pageAt(x, xFirst), yp = pageAt(y, yFirst);
  let xPage = x.pages[xp]!, yPage = y.pages[yp]!;
  let xv = x.valueOffsets[rx]! - xPage.valueStart, yv = y.valueOffsets[ry]! - yPage.valueStart;
  for (let e = 0; e < events; e++) {
    // A row can continue on the next page; its values restart at index 0.
    if (xFirst + e >= xPage.eventEnd) { xPage = x.pages[++xp]!; xv = 0; }
    if (yFirst + e >= yPage.eventEnd) { yPage = y.pages[++yp]!; yv = 0; }
    const xi = xFirst + e - xPage.eventStart, yi = yFirst + e - yPage.eventStart;
    const xDefs = xPage.definitionLevels, yDefs = yPage.definitionLevels;
    if ((xDefs.length && xDefs[xi] !== maxDefinitionLevel) || (yDefs.length && yDefs[yi] !== maxDefinitionLevel)) {
      throw new Error('quantized_geoarrow overview is null, empty or has mismatched XY topology');
    }
    const rep = e === 0 ? 0 : xPage.repetitionLevels[xi]!;
    if (e !== 0 && rep !== yPage.repetitionLevels[yi]) {
      throw new Error('quantized_geoarrow overview has mismatched XY topology');
    }
    if (rep < depth) {
      if (rep < depth - 1) builder.startPolygon();
      builder.startRing();
    }
    bx[builder.coords] = xPage.values[xv++] as number;
    by[builder.coords++] = yPage.values[yv++] as number;
  }
}

/** Definition level of `event`; pages without levels are fully defined. */
function definitionLevel(leaf: LevelLeaf, event: number): number | undefined {
  const page = leaf.pages[pageAt(leaf, event)];
  if (!page) return undefined;
  return page.definitionLevels.length ? page.definitionLevels[event - page.eventStart] : undefined;
}

/** Index of the page holding `event`. */
function pageAt(leaf: LevelLeaf, event: number): number {
  let low = 0, high = leaf.pages.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (leaf.pages[middle]!.eventEnd <= event) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Append ISO or EWKB bytes. Z is kept, M is dropped, an empty Point has no
 * coordinates, and GeometryCollection is rejected. Null appends a null row.
 */
export function appendWkb(builder: GeometryBuilder, bytes: Uint8Array | null | undefined): void {
  if (!bytes) { builder.startRow(0); return; }
  // Called once per row: keep parser state in module scope.
  // Values decoded from one Parquet page share a buffer; reuse its view.
  if (view.buffer !== bytes.buffer) view = new DataView(bytes.buffer);
  offset = bytes.byteOffset;
  end = offset + bytes.byteLength;
  target = builder;
  const type = header();
  const little = headerLittle;
  const stride = headerStride;
  switch (type) {
    case 1: {
      builder.startRow(1);
      if (offset + stride > end) throw new RangeError('invalid WKB: truncated coordinate');
      if (!emptyPoint(little)) { builder.startPolygon(); builder.startRing(); position(little); }
      offset += stride;
      break;
    }
    case 2: builder.startRow(2); builder.startPolygon(); line(little, stride); break;
    case 3: builder.startRow(3); builder.startPolygon(); rings(little, stride); break;
    case 4: {
      builder.startRow(4); builder.startPolygon(); builder.startRing();
      for (let n = uint32(little); n > 0; n--) {
        expect(header(), 1);
        if (offset + headerStride > end) throw new RangeError('invalid WKB: truncated coordinate');
        if (!emptyPoint(headerLittle)) position(headerLittle);
        offset += headerStride;
      }
      break;
    }
    case 5: {
      builder.startRow(5); builder.startPolygon();
      for (let n = uint32(little); n > 0; n--) { expect(header(), 2); line(headerLittle, headerStride); }
      break;
    }
    case 6: {
      builder.startRow(6);
      for (let n = uint32(little); n > 0; n--) {
        expect(header(), 3);
        builder.startPolygon();
        rings(headerLittle, headerStride);
      }
      break;
    }
    default: throw new Error(`unsupported WKB geometry type ${type}`);
  }
  if (offset !== end) throw new Error('invalid WKB: trailing bytes');
}

let view: DataView = new DataView(new ArrayBuffer(0));
let offset = 0;
let end = 0;
let target: GeometryBuilder;
let headerLittle = true;
let headerStride = 16;
let headerZ = false;

function header(): number {
  if (offset + 5 > end) throw new RangeError('invalid WKB: truncated header');
  const little = view.getUint8(offset) === 1;
  let code = view.getUint32(offset + 1, little);
  offset += 5;
  let hasZ = (code & 0x8000_0000) !== 0;
  let hasM = (code & 0x4000_0000) !== 0;
  if (code & 0x2000_0000) offset += 4; // EWKB SRID
  code &= 0x0fff_ffff;
  const iso = Math.floor(code / 1000);
  hasZ ||= iso === 1 || iso === 3;
  hasM ||= iso === 2 || iso === 3;
  headerLittle = little;
  headerZ = hasZ;
  headerStride = 16 + (hasZ ? 8 : 0) + (hasM ? 8 : 0);
  return code % 1000;
}

function expect(type: number, expected: number): void {
  if (type !== expected) throw new Error(`invalid WKB: expected type ${expected}, got ${type}`);
}

function uint32(little: boolean): number {
  if (offset + 4 > end) throw new RangeError('invalid WKB: truncated count');
  const value = view.getUint32(offset, little);
  offset += 4;
  return value;
}

function emptyPoint(little: boolean): boolean {
  return Number.isNaN(view.getFloat64(offset, little)) && Number.isNaN(view.getFloat64(offset + 8, little));
}

/** Write one bounds-checked coordinate at `offset` without advancing it. */
function position(little: boolean): void {
  const b = target;
  b.reserve(1);
  if (headerZ) b.ensureZ()[b.coords] = view.getFloat64(offset + 16, little);
  b.x[b.coords] = view.getFloat64(offset, little);
  b.y[b.coords++] = view.getFloat64(offset + 8, little);
}

function line(little: boolean, stride: number): void {
  const n = uint32(little);
  // Validate the declared length before writing, then read coordinates directly.
  if (offset + n * stride > end) throw new RangeError('invalid WKB: coordinates exceed buffer');
  const b = target;
  b.startRing();
  b.reserve(n);
  const bx = b.x, by = b.y;
  const bz = headerZ ? b.ensureZ() : undefined;
  let k = b.coords;
  for (let i = 0; i < n; i++) {
    bx[k] = view.getFloat64(offset, little);
    by[k] = view.getFloat64(offset + 8, little);
    if (bz) bz[k] = view.getFloat64(offset + 16, little);
    k++;
    offset += stride;
  }
  b.coords = k;
}

function rings(little: boolean, stride: number): void {
  for (let n = uint32(little); n > 0; n--) line(little, stride);
}
