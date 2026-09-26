import {
  NO_VALIDITY,
  packBits,
  validityBitmap,
  writeIpcStream,
  type ArrowColumn,
  type ArrowType,
} from './arrow-ipc.js';
import { requireGeometry, type FeatureSource, type GeometryColumn } from './geometry.js';
import { formatPropertyValue } from './properties.js';

export interface GeoArrowOptions {
  /** Geometry field name. Default: `geometry`. */
  geometryColumn?: string;
  /** Field that receives `rowIndex` as int64, when the source has one. Default: `rowIndex`. */
  idColumn?: string;
  /** CRS written to the GeoArrow extension metadata, e.g. PROJJSON; omitted when undefined. */
  crs?: unknown;
}

const INT64_MAX = 2n ** 63n - 1n;
const INT32_MAX = 0x7fff_ffff;
const textEncoder = new TextEncoder();

/**
 * Encode every row as an Arrow IPC stream with one record batch, readable with
 * e.g. `tableFromIPC` from `apache-arrow`. Geometry is written as the GeoArrow
 * multi type of its family (`geoarrow.multipoint`, `multilinestring` or
 * `multipolygon`, the latter when every row is null) with interleaved float64
 * coordinates, dequantized and with Z when present. Single geometries become
 * one-part multi geometries, null geometries are null, and mixing families
 * throws. Attribute types follow their values: typed arrays keep their numeric
 * type, and plain arrays of numbers, bigints, booleans, strings, bytes or Dates
 * become float64, int64, bool, utf8, binary or UTC millisecond timestamps.
 * Other or mixed values are written as display strings.
 */
export function toGeoArrow(source: FeatureSource, options: GeoArrowOptions = {}): ArrayBuffer {
  const geometry = requireGeometry(source);
  const length = geometry.length;
  const columns: ArrowColumn[] = [];
  const names = new Set<string>();
  const add = (column: ArrowColumn, values: ArrayLike<unknown>): void => {
    if (names.has(column.name)) throw new Error(`duplicate GeoArrow field ${column.name}`);
    if (values.length !== length) {
      throw new Error(`column ${column.name} has ${values.length} values, expected ${length}`);
    }
    names.add(column.name);
    columns.push(column);
  };
  if (source.rowIndex) {
    const name = options.idColumn ?? 'rowIndex';
    add(int64Column(name, source.rowIndex), source.rowIndex);
  }
  for (const [name, values] of Object.entries(source.columns ?? {})) add(propertyColumn(name, values), values);
  const geometryField = geometryColumn(geometry, options.geometryColumn ?? 'geometry', options.crs);
  add(geometryField, geometry.types);
  return writeIpcStream(columns, length);
}

function geometryColumn(column: GeometryColumn, name: string, crs: unknown): ArrowColumn {
  let family: 'point' | 'linestring' | 'polygon' | undefined;
  for (let i = 0; i < column.length; i++) {
    const type = column.types[i]!;
    if (!type) continue;
    const next = type === 1 || type === 4 ? 'point' : type === 2 || type === 5 ? 'linestring' : 'polygon';
    if (family && family !== next) throw new Error(`cannot write mixed ${family} and ${next} geometries as GeoArrow`);
    family = next;
  }
  family ??= 'polygon';

  const { x, y, z, geometryOffsets: go, polygonOffsets: po, ringOffsets: ro } = column;
  const [sx, sy] = column.scale;
  const [ox, oy] = column.offset;
  const dimensions = z ? 3 : 2;
  const count = x.length;
  const coordinates = new Float64Array(count * dimensions);
  for (let k = 0, at = 0; k < count; k++) {
    coordinates[at++] = ox + sx * x[k]!;
    coordinates[at++] = oy + sy * y[k]!;
    if (z) coordinates[at++] = z[k]!;
  }
  const vertices = (childName: string): ArrowColumn => ({
    name: childName,
    nullable: false,
    type: { id: 'fixedSizeList', size: dimensions },
    length: count,
    nullCount: 0,
    buffers: [NO_VALIDITY],
    children: [{
      name: z ? 'xyz' : 'xy',
      nullable: false,
      type: { id: 'float', precision: 'double' },
      length: coordinates.length,
      nullCount: 0,
      buffers: [NO_VALIDITY, coordinates],
    }],
  });
  const list = (childName: string, offsets: Uint32Array, child: ArrowColumn): ArrowColumn => ({
    name: childName,
    nullable: false,
    type: { id: 'list' },
    length: offsets.length - 1,
    nullCount: 0,
    buffers: [NO_VALIDITY, int32Offsets(offsets)],
    children: [child],
  });
  // Every family shares the MultiPolygon layout; flatten the levels it lacks.
  const rowOffsets = (level: (row: number) => number): Uint32Array => {
    const offsets = new Uint32Array(column.length + 1);
    for (let i = 0; i <= column.length; i++) offsets[i] = level(go[i]!);
    return offsets;
  };
  const top = family === 'point'
    ? list('', rowOffsets(p => ro[po[p]!]!), vertices('points'))
    : family === 'linestring'
      ? list('', rowOffsets(p => po[p]!), list('linestrings', ro, vertices('vertices')))
      : list('', go, list('polygons', po, list('rings', ro, vertices('vertices'))));
  const { bitmap, nullCount } = validityBitmap(column.length, i => column.types[i] !== 0);
  return {
    ...top,
    name,
    nullable: true,
    nullCount,
    buffers: [bitmap, top.buffers[1]!],
    metadata: {
      'ARROW:extension:name': `geoarrow.multi${family}`,
      'ARROW:extension:metadata': JSON.stringify(crs === undefined ? {} : { crs }),
    },
  };
}

function int32Offsets(offsets: Uint32Array): Uint32Array {
  // Offsets are non-decreasing, so the last one bounds them all.
  if (offsets[offsets.length - 1]! > INT32_MAX) throw new Error('GeoArrow offsets exceed the int32 range');
  return offsets;
}

function int64Column(name: string, values: ArrayLike<number>): ArrowColumn {
  const data = new BigInt64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    if (!Number.isSafeInteger(value)) throw new Error(`${name} must hold safe integers`);
    data[i] = BigInt(value);
  }
  return { name, nullable: false, type: { id: 'int', bitWidth: 64, signed: true }, length: values.length, nullCount: 0, buffers: [NO_VALIDITY, data] };
}

type ValueKind = 'number' | 'bigint' | 'boolean' | 'string' | 'bytes' | 'date' | 'other';

function propertyColumn(name: string, values: ArrayLike<unknown>): ArrowColumn {
  const typed = typedArrayType(values);
  const length = values.length;
  if (typed) {
    return { name, nullable: true, type: typed, length, nullCount: 0, buffers: [NO_VALIDITY, values as unknown as ArrayBufferView] };
  }
  let kind: ValueKind | undefined;
  let negative = false;
  let exceedsInt64 = false;
  for (let i = 0; i < length; i++) {
    const value = values[i];
    if (value === null || value === undefined) continue;
    const next = valueKind(value);
    if (next === 'bigint') {
      negative ||= (value as bigint) < 0n;
      exceedsInt64 ||= (value as bigint) > INT64_MAX;
    }
    kind = kind === undefined || kind === next ? next : 'other';
  }
  // bigints outside both int64 and uint64 cannot share one integer type.
  if (kind === 'bigint' && negative && exceedsInt64) kind = 'other';
  const isValid = (i: number): boolean => {
    const value = values[i];
    if (value === null || value === undefined) return false;
    return kind !== 'date' || !Number.isNaN((value as Date).getTime());
  };
  const { bitmap, nullCount } = validityBitmap(length, isValid);
  const column = (type: ArrowType, ...buffers: ArrayBufferView[]): ArrowColumn => (
    { name, nullable: true, type, length, nullCount, buffers: [bitmap, ...buffers] }
  );
  switch (kind) {
    case 'number': {
      const data = new Float64Array(length);
      for (let i = 0; i < length; i++) if (isValid(i)) data[i] = values[i] as number;
      return column({ id: 'float', precision: 'double' }, data);
    }
    case 'bigint': {
      const data = exceedsInt64 ? new BigUint64Array(length) : new BigInt64Array(length);
      for (let i = 0; i < length; i++) if (isValid(i)) data[i] = values[i] as bigint;
      return column({ id: 'int', bitWidth: 64, signed: !exceedsInt64 }, data);
    }
    case 'boolean': {
      return column({ id: 'bool' }, packBits(length, i => values[i] === true));
    }
    case 'date': {
      const data = new BigInt64Array(length);
      for (let i = 0; i < length; i++) if (isValid(i)) data[i] = BigInt((values[i] as Date).getTime());
      return column({ id: 'timestamp', unit: 'millisecond', timezone: 'UTC' }, data);
    }
    case 'bytes':
      return column({ id: 'binary' }, ...variableWidth(length, i => isValid(i) ? values[i] as Uint8Array : undefined));
    default:
      return column({ id: 'utf8' }, ...variableWidth(length, i => isValid(i) ? textEncoder.encode(formatPropertyValue(values[i])) : undefined));
  }
}

function valueKind(value: unknown): ValueKind {
  switch (typeof value) {
    case 'number': return 'number';
    case 'bigint': return 'bigint';
    case 'boolean': return 'boolean';
    case 'string': return 'string';
  }
  if (value instanceof Uint8Array) return 'bytes';
  if (value instanceof Date) return 'date';
  return 'other';
}

/** Int32 offsets and concatenated bytes; `undefined` values are empty. */
function variableWidth(length: number, bytes: (index: number) => Uint8Array | undefined): [Int32Array, Uint8Array] {
  const offsets = new Int32Array(length + 1);
  const parts: (Uint8Array | undefined)[] = new Array(length);
  let total = 0;
  for (let i = 0; i < length; i++) {
    const part = bytes(i);
    parts[i] = part;
    total += part?.byteLength ?? 0;
    if (total > INT32_MAX) throw new Error('attribute data exceeds the int32 offset range');
    offsets[i + 1] = total;
  }
  const data = new Uint8Array(total);
  parts.forEach((part, i) => { if (part) data.set(part, offsets[i]!); });
  return [offsets, data];
}

function typedArrayType(values: ArrayLike<unknown>): ArrowType | undefined {
  if (values instanceof Float64Array) return { id: 'float', precision: 'double' };
  if (values instanceof Float32Array) return { id: 'float', precision: 'single' };
  if (values instanceof Int32Array) return { id: 'int', bitWidth: 32, signed: true };
  if (values instanceof Uint32Array) return { id: 'int', bitWidth: 32, signed: false };
  if (values instanceof Int16Array) return { id: 'int', bitWidth: 16, signed: true };
  if (values instanceof Uint16Array) return { id: 'int', bitWidth: 16, signed: false };
  if (values instanceof Int8Array) return { id: 'int', bitWidth: 8, signed: true };
  if (values instanceof Uint8Array || values instanceof Uint8ClampedArray) return { id: 'int', bitWidth: 8, signed: false };
  if (values instanceof BigInt64Array) return { id: 'int', bitWidth: 64, signed: true };
  if (values instanceof BigUint64Array) return { id: 'int', bitWidth: 64, signed: false };
  return undefined;
}
