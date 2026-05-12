import type { BboxCovering } from './meta.js';

export interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function bboxesIntersect(a: Bbox, b: Bbox): boolean {
  return a.maxX >= b.minX && a.minX <= b.maxX && a.maxY >= b.minY && a.minY <= b.maxY;
}

// We define a minimal structural type for what we need from a Parquet file
// metadata, rather than depending on hyparquet's exported types directly.
// This keeps the bbox-pruning code testable in isolation and resilient to
// minor hyparquet shape changes.
export interface RowGroupStatistics {
  min_value?: unknown;
  max_value?: unknown;
  min?: unknown;
  max?: unknown;
}

export interface ColumnChunkMeta {
  path_in_schema: string[];
  statistics?: RowGroupStatistics | null;
}

export interface ColumnChunk {
  meta_data?: ColumnChunkMeta | null;
}

export interface RowGroupLike {
  columns: ColumnChunk[];
  num_rows?: number | bigint;
}

export interface FileMetadataLike {
  row_groups: RowGroupLike[];
}

function statsNumber(s: RowGroupStatistics | null | undefined, kind: 'min' | 'max'): number | null {
  if (!s) return null;
  const v = kind === 'min' ? (s.min_value ?? s.min) : (s.max_value ?? s.max);
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return null;
}

function pathsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface BboxColumnIndexes {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

// Locate the column index (within a row group's columns list) for each
// covering bbox sub-column. Column ordering in a row group matches the
// flattened leaf-column order of the schema, which is identical across
// row groups for a given file.
export function findBboxColumnIndexes(
  rowGroup: RowGroupLike,
  covering: BboxCovering,
): BboxColumnIndexes {
  const find = (target: readonly string[], label: string): number => {
    for (let i = 0; i < rowGroup.columns.length; i++) {
      const path = rowGroup.columns[i]?.meta_data?.path_in_schema;
      if (path && pathsEqual(path, target)) return i;
    }
    throw new Error(`covering bbox column \`${label}\` (${target.join('.')}) not found in row group`);
  };
  return {
    xmin: find(covering.xmin, 'xmin'),
    ymin: find(covering.ymin, 'ymin'),
    xmax: find(covering.xmax, 'xmax'),
    ymax: find(covering.ymax, 'ymax'),
  };
}

// Compute the spatial envelope of a row group from the min/max stats of the
// covering columns. Returns null if any required stat is missing — callers
// should treat that as "cannot prune" rather than "empty".
export function rowGroupBbox(rowGroup: RowGroupLike, idx: BboxColumnIndexes): Bbox | null {
  const minX = statsNumber(rowGroup.columns[idx.xmin]?.meta_data?.statistics, 'min');
  const minY = statsNumber(rowGroup.columns[idx.ymin]?.meta_data?.statistics, 'min');
  const maxX = statsNumber(rowGroup.columns[idx.xmax]?.meta_data?.statistics, 'max');
  const maxY = statsNumber(rowGroup.columns[idx.ymax]?.meta_data?.statistics, 'max');
  if (minX === null || minY === null || maxX === null || maxY === null) return null;
  return { minX, minY, maxX, maxY };
}

export function rowGroupIntersects(
  rowGroup: RowGroupLike,
  idx: BboxColumnIndexes,
  query: Bbox,
): boolean {
  const rgBbox = rowGroupBbox(rowGroup, idx);
  if (!rgBbox) return true; // no stats → cannot prune, fetch conservatively
  return bboxesIntersect(rgBbox, query);
}
