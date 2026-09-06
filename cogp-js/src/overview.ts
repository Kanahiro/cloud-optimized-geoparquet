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
  const root = value as Record<string, unknown> | undefined;
  if (!root) return null;
  const geometryType = Number(root['geometry_type']);
  const lodName = Object.keys(root).find((name) => name !== 'geometry_type');
  const lod = lodName ? root[lodName] as Record<string, unknown> | undefined : undefined;
  if (!lod) return null;
  const xs = asNumbers(lod['x']);
  const ys = asNumbers(lod['y']);
  if (xs.length !== ys.length) throw new Error('overview x/y lengths differ');
  const coordinates = xs.map((x, index) => [
    metadata.offset[0] + metadata.scale[0] * x,
    metadata.offset[1] + metadata.scale[1] * ys[index]!,
  ]);
  const partEnds = asNumbers(lod['part_ends']);
  const polygonEnds = asNumbers(lod['polygon_ends']);
  switch (geometryType) {
    case 1: return { type: 'Point', coordinates: coordinates[0] ?? [] };
    case 2: return { type: 'LineString', coordinates };
    case 3: return { type: 'Polygon', coordinates: splitAt(coordinates, partEnds) };
    case 4: return { type: 'MultiPoint', coordinates };
    case 5: return { type: 'MultiLineString', coordinates: splitAt(coordinates, partEnds) };
    case 6: {
      const rings = splitAt(coordinates, partEnds);
      return { type: 'MultiPolygon', coordinates: splitAt(rings, polygonEnds) };
    }
    default: throw new Error(`unsupported overview geometry type ${geometryType}`);
  }
}

function asNumbers(value: unknown): number[] {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value as ArrayBufferView)) {
    throw new Error('overview coordinate field is not an array');
  }
  return Array.from(value as ArrayLike<number>, Number);
}

function splitAt<T>(values: T[], ends: number[]): T[][] {
  const result: T[][] = [];
  let start = 0;
  for (const end of ends) {
    if (!Number.isInteger(end) || end < start || end > values.length) {
      throw new Error('invalid overview end offset');
    }
    result.push(values.slice(start, end));
    start = end;
  }
  if (start !== values.length) throw new Error('overview end offsets do not cover all values');
  return result;
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
