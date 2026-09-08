import type { LodMetadata } from './meta.js';
import type { FileMetadataLike } from './bbox.js';

interface SchemaElementLike {
  name: string;
  num_children?: number;
  [key: string]: unknown;
}

export interface OverviewFileMetadata extends FileMetadataLike {
  schema: SchemaElementLike[];
  [key: string]: unknown;
}

export type OverviewGeometryType = 1 | 2 | 3 | 4 | 5 | 6;

type NumberArray = ArrayLike<number> & { readonly length: number };

/**
 * A zero-copy view over one quantized overview geometry. Custom renderers can
 * consume this directly instead of first materializing nested GeoJSON arrays.
 */
export interface QuantizedOverviewGeometry {
  readonly type: OverviewGeometryType;
  readonly x: NumberArray;
  readonly y: NumberArray;
  readonly partEnds: NumberArray;
  readonly polygonEnds: NumberArray;
  readonly scale: readonly [number, number];
  readonly offset: readonly [number, number];
}

export function rootColumnNames(schema: readonly SchemaElementLike[]): string[] {
  const root = schema[0];
  if (!root) throw new Error('parquet schema is empty');
  const names: string[] = [];
  let index = 1;
  for (let i = 0; i < (root.num_children ?? 0); i++) {
    const element = schema[index];
    if (!element) throw new Error('parquet schema is truncated');
    names.push(element.name);
    index += subtreeSize(schema, index);
  }
  return names;
}

/**
 * Remove every unselected LoD from the metadata view handed to hyparquet.
 * This keeps sibling leaves out of its range plan; the reader independently
 * excludes primary WKB from the requested root-column list. The file itself
 * and its public schema are unchanged.
 */
export function projectOverviewMetadata<T extends OverviewFileMetadata>(metadata: T, lod: string): T {
  const { start, end, node, children } = overviewRange(metadata.schema);
  const geometryType = children.find(({ index }) => metadata.schema[index]!.name === 'geometry_type');
  const selected = children.find(({ index }) => metadata.schema[index]!.name === lod);
  if (!geometryType || geometryType.size !== 1) {
    throw new Error('overviews.geometry_type is missing or nested');
  }
  if (!selected) throw new Error(`overview LoD \`${lod}\` is missing from the Parquet schema`);

  const schema = [
    ...metadata.schema.slice(0, start),
    { ...node, num_children: 2 },
    ...metadata.schema.slice(geometryType.index, geometryType.index + geometryType.size),
    ...metadata.schema.slice(selected.index, selected.index + selected.size),
    ...metadata.schema.slice(end),
  ];
  const row_groups = metadata.row_groups.map((rowGroup) => ({
    ...rowGroup,
    columns: rowGroup.columns.filter((column) => {
      const path = column.meta_data?.path_in_schema;
      return path?.[0] !== 'overviews' || path[1] === 'geometry_type' || path[1] === lod;
    }),
  }));
  return { ...metadata, schema, row_groups } as T;
}

export function decodeOverview(value: unknown, metadata: LodMetadata): unknown {
  return decodeQuantizedOverview(parseOverview(value, metadata));
}

export function parseOverview(
  value: unknown,
  metadata: LodMetadata,
): QuantizedOverviewGeometry | null {
  const root = value as Record<string, unknown> | undefined;
  if (!root) return null;
  const geometryType = Number(root['geometry_type']) as OverviewGeometryType;
  if (!isOverviewGeometryType(geometryType)) {
    throw new Error(`unsupported overview geometry type ${geometryType}`);
  }
  const lodName = Object.keys(root).find((name) => name !== 'geometry_type');
  const lod = lodName ? root[lodName] as Record<string, unknown> | undefined : undefined;
  if (!lod) return null;
  const xs = asNumberArray(lod['x']);
  const ys = asNumberArray(lod['y']);
  if (xs.length !== ys.length) throw new Error('overview x/y lengths differ');
  const partEnds = asNumberArray(lod['part_ends']);
  const polygonEnds = asNumberArray(lod['polygon_ends']);
  if (geometryType === 3 || geometryType === 5 || geometryType === 6) {
    validateEnds(partEnds, xs.length, 'overview part');
  }
  if (geometryType === 6) {
    validateEnds(polygonEnds, partEnds.length, 'overview polygon');
  }
  return {
    type: geometryType,
    x: xs,
    y: ys,
    partEnds,
    polygonEnds,
    scale: metadata.scale,
    offset: metadata.offset,
  };
}

export function decodeQuantizedOverview(value: QuantizedOverviewGeometry | null): unknown {
  if (!value) return null;
  const decode = coordinateDecoder(value);
  switch (value.type) {
    case 1: return { type: 'Point', coordinates: value.x.length ? decode(0) : [] };
    case 2: return { type: 'LineString', coordinates: decodeRange(decode, 0, value.x.length) };
    case 3: return { type: 'Polygon', coordinates: decodeParts(decode, value.x.length, value.partEnds) };
    case 4: return { type: 'MultiPoint', coordinates: decodeRange(decode, 0, value.x.length) };
    case 5: return { type: 'MultiLineString', coordinates: decodeParts(decode, value.x.length, value.partEnds) };
    case 6: {
      const rings = decodeParts(decode, value.x.length, value.partEnds);
      return { type: 'MultiPolygon', coordinates: splitParts(rings, value.polygonEnds) };
    }
  }
}

function asNumberArray(value: unknown): NumberArray {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value as ArrayBufferView)) {
    throw new Error('overview coordinate field is not an array');
  }
  // Hyparquet commonly returns typed arrays. Keep their backing store instead
  // of cloning it with Array.from; decoding only needs indexed read access.
  return value as NumberArray;
}

function coordinateDecoder(
  value: QuantizedOverviewGeometry,
): (index: number) => [number, number] {
  const [scaleX, scaleY] = value.scale;
  const [offsetX, offsetY] = value.offset;
  return (index) => [
    offsetX + scaleX * Number(value.x[index]),
    offsetY + scaleY * Number(value.y[index]),
  ];
}

function decodeRange(
  decode: (index: number) => [number, number],
  start: number,
  end: number,
): [number, number][] {
  const result = new Array<[number, number]>(end - start);
  for (let i = start; i < end; i++) result[i - start] = decode(i);
  return result;
}

function decodeParts(
  decode: (index: number) => [number, number],
  valueCount: number,
  ends: NumberArray,
): [number, number][][] {
  const result = new Array<[number, number][]>(ends.length);
  let start = 0;
  for (let i = 0; i < ends.length; i++) {
    const end = Number(ends[i]);
    validateEnd(end, start, valueCount, 'overview part');
    result[i] = decodeRange(decode, start, end);
    start = end;
  }
  if (start !== valueCount) throw new Error('overview part end offsets do not cover all values');
  return result;
}

function splitParts<T>(values: T[], ends: NumberArray): T[][] {
  const result: T[][] = [];
  let start = 0;
  for (let i = 0; i < ends.length; i++) {
    const end = Number(ends[i]);
    validateEnd(end, start, values.length, 'overview polygon');
    result.push(values.slice(start, end));
    start = end;
  }
  if (start !== values.length) throw new Error('overview polygon end offsets do not cover all values');
  return result;
}

function validateEnd(end: number, start: number, length: number, label: string): void {
  if (!Number.isInteger(end) || end < start || end > length) {
    throw new Error(`invalid ${label} end offset`);
  }
}

function validateEnds(ends: NumberArray, length: number, label: string): void {
  let start = 0;
  for (let i = 0; i < ends.length; i++) {
    const end = Number(ends[i]);
    validateEnd(end, start, length, label);
    start = end;
  }
  if (start !== length) throw new Error(`${label} end offsets do not cover all values`);
}

function isOverviewGeometryType(value: number): value is OverviewGeometryType {
  return Number.isInteger(value) && value >= 1 && value <= 6;
}

function subtreeSize(schema: readonly SchemaElementLike[], index: number): number {
  const element = schema[index];
  if (!element) throw new Error('parquet schema is truncated');
  let size = 1;
  let child = index + 1;
  for (let i = 0; i < (element.num_children ?? 0); i++) {
    const childSize = subtreeSize(schema, child);
    size += childSize;
    child += childSize;
  }
  return size;
}

function overviewRange(schema: readonly SchemaElementLike[]) {
  const root = schema[0];
  if (!root) throw new Error('parquet schema is empty');
  let index = 1;
  for (let i = 0; i < (root.num_children ?? 0); i++) {
    const size = subtreeSize(schema, index);
    const node = schema[index]!;
    if (node.name === 'overviews') {
      const children: Array<{ index: number; size: number }> = [];
      let child = index + 1;
      for (let j = 0; j < (node.num_children ?? 0); j++) {
        const childSize = subtreeSize(schema, child);
        children.push({ index: child, size: childSize });
        child += childSize;
      }
      return { start: index, end: index + size, node, children };
    }
    index += size;
  }
  throw new Error('required `overviews` column is missing');
}
