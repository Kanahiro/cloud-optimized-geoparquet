import type { FileMetadataLike } from './bbox.js';

interface SchemaElementLike {
  name: string;
  num_children?: number;
  logical_type?: unknown;
  [key: string]: unknown;
}

export interface LodMetadataLike extends FileMetadataLike {
  schema: SchemaElementLike[];
}

export function rootColumnNames(schema: readonly SchemaElementLike[]): string[] {
  const root = schema[0];
  if (!root) throw new Error('parquet schema is empty');
  const names: string[] = [];
  let index = 1;
  for (let i = 0; i < (root.num_children ?? 0); i++) {
    const child = schema[index];
    if (!child) throw new Error('parquet schema is truncated');
    names.push(child.name);
    index += schemaSubtreeSize(schema, index);
  }
  return names;
}

export function validateLodsSchema(
  metadata: LodMetadataLike,
  rootColumn: string,
  levelCount: number,
): number[] {
  const { children } = lodsSchemaRange(metadata.schema, rootColumn);
  if (children.length === 0) {
    throw new Error(`cogp metadata: lods column \`${rootColumn}\` has no children`);
  }
  const levels = children.map(({ index, size }) => {
    const name = metadata.schema[index]!.name;
    const level = lodLevelIndex(name);
    if (level === undefined || level >= levelCount) {
      throw new Error(
        `cogp metadata: lods child \`${name}\` must canonically name an existing level`,
      );
    }
    if (size !== 1) {
      throw new Error(`cogp metadata: lods child \`${name}\` must be a leaf`);
    }
    return level;
  });
  levels.sort((a, b) => a - b);
  for (const rg of metadata.row_groups) {
    for (const level of levels) {
      const expected = `${rootColumn}.level_${level}`;
      const found = rg.columns.some(
        (column) => column.meta_data?.path_in_schema?.join('.') === expected,
      );
      if (!found) throw new Error(`cogp metadata: parquet leaf \`${expected}\` is missing`);
    }
  }
  return levels;
}

/**
 * Hyparquet currently projects root fields. Give it a metadata view in which
 * the LOD struct contains only the selected leaf; this preserves its normal
 * nested assembly while ensuring the range plan never includes sibling LODs.
 * The synthetic GEOMETRY logical type routes the COGP-defined WKB through the
 * reader's lazy geometry parser without changing the file's schema.
 */
export function projectLodMetadata<T extends LodMetadataLike>(
  metadata: T,
  rootColumn: string,
  leafColumn: string,
): T {
  const { start, end, children } = lodsSchemaRange(metadata.schema, rootColumn);
  const selected = children.find(({ index }) => metadata.schema[index]!.name === leafColumn);
  if (!selected || selected.size !== 1) {
    throw new Error(`cogp metadata: lods leaf \`${rootColumn}.${leafColumn}\` is missing or nested`);
  }
  const lodRoot = metadata.schema[start]!;
  const leaf = metadata.schema[selected.index]!;
  const schema = [
    ...metadata.schema.slice(0, start),
    { ...lodRoot, num_children: 1 },
    { ...leaf, logical_type: { type: 'GEOMETRY' } },
    ...metadata.schema.slice(end),
  ];
  const selectedPath = `${rootColumn}.${leafColumn}`;
  const row_groups = metadata.row_groups.map((rg) => ({
    ...rg,
    columns: rg.columns.filter((column) => {
      const path = column.meta_data?.path_in_schema;
      return path?.[0] !== rootColumn || path.join('.') === selectedPath;
    }),
  }));
  return { ...metadata, schema, row_groups } as T;
}

function schemaSubtreeSize(schema: readonly SchemaElementLike[], index: number): number {
  const element = schema[index];
  if (!element) throw new Error('parquet schema is truncated');
  let size = 1;
  let childIndex = index + 1;
  for (let i = 0; i < (element.num_children ?? 0); i++) {
    const childSize = schemaSubtreeSize(schema, childIndex);
    size += childSize;
    childIndex += childSize;
  }
  return size;
}

function lodsSchemaRange(
  schema: readonly SchemaElementLike[],
  rootColumn: string,
): { start: number; end: number; children: Array<{ index: number; size: number }> } {
  const root = schema[0];
  if (!root) throw new Error('parquet schema is empty');
  let index = 1;
  for (let i = 0; i < (root.num_children ?? 0); i++) {
    const size = schemaSubtreeSize(schema, index);
    const element = schema[index]!;
    if (element.name === rootColumn) {
      const children: Array<{ index: number; size: number }> = [];
      let childIndex = index + 1;
      for (let j = 0; j < (element.num_children ?? 0); j++) {
        const childSize = schemaSubtreeSize(schema, childIndex);
        children.push({ index: childIndex, size: childSize });
        childIndex += childSize;
      }
      return { start: index, end: index + size, children };
    }
    index += size;
  }
  throw new Error(`cogp metadata: lods column \`${rootColumn}\` not found in parquet schema`);
}

function lodLevelIndex(name: string): number | undefined {
  const match = /^level_(0|[1-9]\d*)$/.exec(name);
  if (!match) return undefined;
  const level = Number(match[1]);
  return Number.isSafeInteger(level) ? level : undefined;
}
