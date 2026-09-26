import { geoArrowLayout } from './geometry.js';
import type { SupportedOverviewsMetadata } from './meta.js';
import type { FileMetadataLike } from './bbox.js';

interface SchemaElementLike {
  name: string;
  num_children?: number;
  type?: string;
  repetition_type?: string;
  converted_type?: string;
  logical_type?: { type: string; bitWidth?: number; isSigned?: boolean };
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
export function projectOverviewMetadata<T extends OverviewFileMetadata>(metadata: T, lod: string, column: string): T {
  const { start, end, node, children } = overviewRange(metadata.schema, column);
  const selected = children.find(({ index }) => metadata.schema[index]!.name === lod);
  if (!selected) throw new Error(`overview LoD \`${lod}\` is missing from the Parquet schema`);

  const schema = [
    ...metadata.schema.slice(0, start),
    { ...node, num_children: 1 },
    ...metadata.schema.slice(selected.index, selected.index + selected.size),
    ...metadata.schema.slice(end),
  ];
  const row_groups = metadata.row_groups.map((rowGroup) => ({
    ...rowGroup,
    columns: rowGroup.columns.filter((chunk) => {
      const path = chunk.meta_data?.path_in_schema;
      return path?.[0] !== column || path[1] === lod;
    }),
  }));
  return { ...metadata, schema, row_groups } as T;
}

/**
 * Check the physical `quantized_geoarrow` schema of the declared overview
 * column: a required struct whose children map one-to-one to the declared
 * LoDs, each a nullable standard LIST nested to its geometry type's depth,
 * ending in a required struct of required signed int32 `x`, `y`.
 */
export function validateOverviewSchema(schema: readonly SchemaElementLike[], overviews: SupportedOverviewsMetadata): void {
  const column = overviews.column;
  const { node, children } = overviewRange(schema, column);
  if (node.repetition_type !== 'REQUIRED' || node.type !== undefined) {
    throw new Error(`overview column \`${column}\` must be a required struct`);
  }
  const names = children.map(({ index }) => schema[index]!.name);
  for (const name of names) {
    if (!(name in overviews.lods)) throw new Error(`\`${column}.${name}\` has no geo.lod.overviews.lods entry`);
  }
  for (const [lod, metadata] of Object.entries(overviews.lods)) {
    const child = children.find(({ index }) => schema[index]!.name === lod);
    if (!child) throw new Error(`geo.lod.overviews.lods.${lod} has no \`${column}.${lod}\` field`);
    const { depth } = geoArrowLayout(metadata.geometry_type);
    const invalid = () => new Error(
      `\`${column}.${lod}\` must be a nullable ${depth}-level list of non-null struct<x: int32, y: int32>`);
    let index = child.index;
    for (let level = 0; level < depth; level++) {
      const list = schema[index]!;
      const repeated = schema[index + 1];
      const element = schema[index + 2];
      if (list.repetition_type !== (level === 0 ? 'OPTIONAL' : 'REQUIRED')
        || list.num_children !== 1 || !isList(list)
        || repeated?.repetition_type !== 'REPEATED' || repeated.num_children !== 1
        || element?.repetition_type !== 'REQUIRED') throw invalid();
      index += 2;
    }
    const coordinate = schema[index]!;
    const [x, y] = [schema[index + 1], schema[index + 2]];
    if (coordinate.num_children !== 2 || coordinate.type !== undefined
      || x?.name !== 'x' || y?.name !== 'y' || !isInt32(x) || !isInt32(y)) throw invalid();
  }
}

function isList(element: SchemaElementLike): boolean {
  return element.converted_type === 'LIST' || element.logical_type?.type === 'LIST';
}

/** A required INT32 leaf without a non-integer or unsigned annotation. */
function isInt32(element: SchemaElementLike): boolean {
  const logical = element.logical_type;
  return element.type === 'INT32' && element.repetition_type === 'REQUIRED' && !element.num_children
    && (element.converted_type === undefined || element.converted_type === 'INT_32')
    && (logical === undefined || (logical.type === 'INTEGER' && logical.bitWidth === 32 && logical.isSigned === true));
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

function overviewRange(schema: readonly SchemaElementLike[], column: string) {
  const root = schema[0];
  if (!root) throw new Error('parquet schema is empty');
  let index = 1;
  for (let i = 0; i < (root.num_children ?? 0); i++) {
    const size = subtreeSize(schema, index);
    const node = schema[index]!;
    if (node.name === column) {
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
  throw new Error(`declared overview column \`${column}\` is missing`);
}
