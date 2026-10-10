import type { Bbox } from '@cogp/reader';

export interface ByteSpan { start: number; end: number }
export interface ColumnLayout extends ByteSpan {
  name: string;
  columnIndex?: ByteSpan;
  offsetIndex?: ByteSpan;
}
export interface RowGroupLayout extends ByteSpan {
  id: number;
  level: number;
  rows: number;
  columns: ColumnLayout[];
  bbox: Bbox | null;
}
export interface PageLayout extends ByteSpan {
  id: number;
  rowStart: number;
  rowEnd: number;
  bbox: Bbox | null;
}
export interface Layout {
  url: string;
  byteLength: number;
  footer: ByteSpan;
  geometryColumn: string;
  overviewColumn: string | null;
  bboxColumns: string[];
  attributes: string[];
  levels: { rowGroupEnd: number; resolution: number }[];
  groups: RowGroupLayout[];
  dataBbox: Bbox | null;
}
export interface QueryResult {
  bbox: Bbox;
  maxLevel: number;
  useOverview: boolean;
  attributes: string[];
  rows: number;
  ms: number;
  requests: number;
  fetchedBytes: number;
  groupIds: number[];
  rowGroupBytes: number;
  dataPageBytes: number;
  dataPageCount: number;
  bboxPageBytes: number;
  bboxPageCount: number;
  attributePageBytes: number;
  attributePageCount: number;
  columnPagesByGroup: Record<number, { column: string; pageIds: number[]; bytes: number }[]>;
  pagesByGroup: Record<number, number[]>;
  geometryPageCount: number;
  geometryPageBytes: number;
}
export type Request =
  | { id: number; type: 'open'; url: string }
  | { id: number; type: 'pages'; groupId: number }
  | { id: number; type: 'query'; bbox: Bbox; maxLevel: number; useOverview: boolean; attributes: string[] }
  | { id: number; type: 'cancel' };
export type Response =
  | { id: number; ok: true; result: Layout | PageLayout[] | QueryResult }
  | { id: number; ok: false; error: string };
