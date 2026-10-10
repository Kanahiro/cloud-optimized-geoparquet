import { CogpReader, type Bbox } from '@cogp/reader';
import { readColumnIndex, readOffsetIndex } from '../../../../packages/reader/vendor/hyparquet/src/index.js';
import { getSchemaPath } from '../../../../packages/reader/vendor/hyparquet/src/schema.js';
import type { ColumnChunk, FileMetaData, PageLocation } from '../../../../packages/reader/vendor/hyparquet/src/types.js';
import { findBboxColumnIndexes, rowGroupBbox } from '../../../../packages/reader/src/bbox.js';
import type { ByteSpan, ColumnLayout, Layout, PageLayout, QueryResult, Request, Response, RowGroupLayout } from './model';

const context: DedicatedWorkerGlobalScope = self as never;
let reader: CogpReader | undefined;
let layout: Layout | undefined;
let sourceUrl = '';
let trace: ByteSpan[] | undefined;
let queryController: AbortController | undefined;
let runningQuery: Promise<QueryResult> | undefined;
const pageCache = new Map<number, Promise<PageLayout[]>>();

// Capture the actual HTTP ranges used by the reader. Index inspection is kept
// outside this trace so the query figure does not include UI bookkeeping.
const tracingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const range = new Headers(init?.headers).get('Range');
  if (trace && response.ok && range) {
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (match) trace.push(response.status === 200
      ? { start: 0, end: layout?.byteLength ?? Number(match[2]) + 1 }
      : { start: Number(match[1]), end: Number(match[2]) + 1 });
  }
  return response;
};

function span(chunk: ColumnChunk): ByteSpan | null {
  const meta = chunk.meta_data;
  if (!meta) return null;
  const start = Number(meta.dictionary_page_offset ?? meta.data_page_offset);
  const end = start + Number(meta.total_compressed_size);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) ? { start, end } : null;
}

function indexSpan(offset: bigint | undefined, length: number | undefined): ByteSpan | undefined {
  if (offset === undefined || !length) return undefined;
  const start = Number(offset);
  return Number.isSafeInteger(start) ? { start, end: start + length } : undefined;
}

function intersects(a: ByteSpan, b: ByteSpan): boolean {
  return a.start < b.end && b.start < a.end;
}

function unionBbox(a: Bbox | null, b: Bbox | null): Bbox | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
  };
}

function buildLayout(url: string, file: CogpReader): Layout {
  const metadata = file.metadata as unknown as FileMetaData;
  const covering = file.geo.columns[file.primaryGeometryColumn]?.covering?.bbox;
  const excluded = new Set(Object.keys(file.geo.columns));
  if (file.geo.lod.overviews) excluded.add(file.geo.lod.overviews.column);
  for (const path of Object.values(covering ?? {})) excluded.add(path[0]!);
  const bboxIndexes = covering && metadata.row_groups[0]
    ? findBboxColumnIndexes(metadata.row_groups[0], covering) : undefined;
  let level = 0;
  const groups: RowGroupLayout[] = metadata.row_groups.map((rg, id) => {
    while (file.levels[level] && id > file.levels[level]!.row_group_end) level++;
    const columns: ColumnLayout[] = rg.columns.flatMap((chunk) => {
      const bytes = span(chunk);
      if (!bytes) return [];
      return [{ ...bytes, name: chunk.meta_data!.path_in_schema.join('.'),
        ...(indexSpan(chunk.column_index_offset, chunk.column_index_length)
          ? { columnIndex: indexSpan(chunk.column_index_offset, chunk.column_index_length)! } : {}),
        ...(indexSpan(chunk.offset_index_offset, chunk.offset_index_length)
          ? { offsetIndex: indexSpan(chunk.offset_index_offset, chunk.offset_index_length)! } : {}) }];
    });
    return {
      id, level, rows: Number(rg.num_rows), columns,
      start: Math.min(...columns.map(c => c.start)),
      end: Math.max(...columns.map(c => c.end)),
      bbox: bboxIndexes ? rowGroupBbox(rg, bboxIndexes) : null,
    };
  });
  const dataBbox = groups.reduce<Bbox | null>((bbox, group) => unionBbox(bbox, group.bbox), null);
  // The final 8 bytes contain footer length and PAR1; metadata is fetched
  // by the reader but its length is not retained, so read it once below.
  return { url, byteLength: file.byteLength, footer: { start: file.byteLength - 8, end: file.byteLength },
    geometryColumn: file.primaryGeometryColumn,
    overviewColumn: file.hasOverviews ? file.geo.lod.overviews!.column : null,
    bboxColumns: covering ? Object.values(covering).map(path => path.join('.')) : [],
    attributes: file.columnNames.filter(name => !excluded.has(name)),
    levels: file.levels.map(level => ({ rowGroupEnd: level.row_group_end, resolution: level.resolution })),
    groups, dataBbox };
}

async function rangeBytes(start: number, end: number): Promise<ArrayBuffer> {
  const response = await fetch(sourceUrl, {
    headers: { Range: `bytes=${start}-${end - 1}` }, cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Index HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  return response.status === 200 ? buffer.slice(start, end) : buffer;
}

async function offsetLocations(chunk: ColumnChunk): Promise<PageLocation[] | null> {
  if (chunk.offset_index_offset === undefined || !chunk.offset_index_length) return null;
  const start = Number(chunk.offset_index_offset);
  const buffer = await rangeBytes(start, start + chunk.offset_index_length);
  return readOffsetIndex({ view: new DataView(buffer), offset: 0 }).page_locations;
}

interface IndexedCoveringPage { rowStart: number; rowEnd: number; min: number; max: number }

async function coveringPages(chunk: ColumnChunk, rows: number): Promise<IndexedCoveringPage[] | null> {
  if (chunk.column_index_offset === undefined || !chunk.column_index_length) return null;
  const locations = await offsetLocations(chunk);
  if (!locations) return null;
  const start = Number(chunk.column_index_offset);
  const buffer = await rangeBytes(start, start + chunk.column_index_length);
  const element = getSchemaPath((reader!.metadata as unknown as FileMetaData).schema,
    chunk.meta_data!.path_in_schema).at(-1)!.element;
  const index = readColumnIndex({ view: new DataView(buffer), offset: 0 }, element);
  return locations.map((loc, id) => ({
    rowStart: Number(loc.first_row_index),
    rowEnd: id + 1 < locations.length ? Number(locations[id + 1]!.first_row_index) : rows,
    min: index.null_pages[id] ? NaN : Number(index.min_values[id]),
    max: index.null_pages[id] ? NaN : Number(index.max_values[id]),
  }));
}

async function loadPages(groupId: number): Promise<PageLayout[]> {
  if (!reader || !layout) throw new Error('Open a dataset first');
  const group = layout.groups[groupId];
  if (!group) throw new Error(`Unknown row group ${groupId}`);
  const rg = (reader.metadata as unknown as FileMetaData).row_groups[groupId]!;
  const geometry = rg.columns.find(c => c.meta_data?.path_in_schema[0] === reader!.primaryGeometryColumn);
  if (!geometry) return [];
  const covering = reader.geo.columns[reader.primaryGeometryColumn]?.covering?.bbox;
  const names = covering ? [covering.xmin, covering.ymin, covering.xmax, covering.ymax] : [];
  const chunks = names.map(path => rg.columns.find(c => c.meta_data?.path_in_schema.join('.') === path.join('.')));
  const [locations, ...stats] = await Promise.all([
    offsetLocations(geometry),
    ...chunks.map(chunk => chunk ? coveringPages(chunk, group.rows) : Promise.resolve(null)),
  ]);
  const physical = locations?.length ? locations.map((loc, id) => ({
    id, rowStart: Number(loc.first_row_index),
    rowEnd: id + 1 < locations.length ? Number(locations[id + 1]!.first_row_index) : group.rows,
    start: Number(loc.offset), end: Number(loc.offset) + loc.compressed_page_size,
  })) : [{ id: 0, rowStart: 0, rowEnd: group.rows, ...span(geometry)! }];
  return physical.map(page => {
    const extrema = stats.map((column, i) => {
      if (!column) return NaN;
      const values = column.filter(p => p.rowStart < page.rowEnd && page.rowStart < p.rowEnd)
        .map(p => i < 2 ? p.min : p.max);
      return values.length ? (i < 2 ? Math.min(...values) : Math.max(...values)) : NaN;
    });
    const bbox = extrema.length === 4 && extrema.every(Number.isFinite)
      ? { minX: extrema[0]!, minY: extrema[1]!, maxX: extrema[2]!, maxY: extrema[3]! } : null;
    return { ...page, bbox };
  });
}

function pagesFor(groupId: number): Promise<PageLayout[]> {
  let promise = pageCache.get(groupId);
  if (!promise) {
    promise = loadPages(groupId).catch(error => { pageCache.delete(groupId); throw error; });
    pageCache.set(groupId, promise);
  }
  return promise;
}

async function open(url: string): Promise<Layout> {
  queryController?.abort();
  reader = undefined;
  layout = undefined;
  pageCache.clear();
  sourceUrl = url;
  const file = await CogpReader.open(url, { fetch: tracingFetch, rangeCache: false, pageIndexCache: false });
  const next = buildLayout(url, file);
  const trailer = await rangeBytes(file.byteLength - 8, file.byteLength);
  const footerLength = new DataView(trailer).getUint32(0, true);
  next.footer.start = file.byteLength - footerLength - 8;
  reader = file;
  layout = next;
  return next;
}

async function query(bbox: Bbox, maxLevel: number, useOverview: boolean, attributes: string[]): Promise<QueryResult> {
  if (!reader || !layout) throw new Error('Open a dataset first');
  queryController?.abort();
  const controller = new AbortController();
  queryController = controller;
  const file = reader;
  const current = layout;
  const selectedAttributes = [...new Set(attributes)];
  if (selectedAttributes.some(name => !current.attributes.includes(name))) throw new Error('Unknown attribute column');
  const readsOverview = useOverview && file.hasOverviews;
  const geometryColumn = readsOverview ? current.overviewColumn! : current.geometryColumn;
  const covering = file.geo.columns[file.primaryGeometryColumn]?.covering?.bbox;
  const bboxColumns = new Set(covering ? Object.values(covering).map(path => path.join('.')) : []);
  const started = performance.now();
  const requests: ByteSpan[] = [];
  trace = requests;
  let batch;
  try {
    batch = await file.read({ bbox, maxLevel, useOverview,
      columns: [file.primaryGeometryColumn, ...selectedAttributes], signal: controller.signal });
  } finally {
    trace = undefined;
  }
  const readMs = performance.now() - started;
  // Index and footer ranges do not count as data pages. Inspect only column
  // chunks that the real read touched, keeping small queries cheap.
  const candidates = current.groups.filter(g => g.columns.some(c => requests.some(r => intersects(c, r))));
  const pagesByGroup: Record<number, number[]> = {};
  const columnPagesByGroup: QueryResult['columnPagesByGroup'] = {};
  let geometryPageCount = 0;
  let geometryPageBytes = 0;
  let dataPageBytes = 0;
  let dataPageCount = 0;
  let bboxPageBytes = 0;
  let bboxPageCount = 0;
  let attributePageBytes = 0;
  let attributePageCount = 0;
  for (const group of candidates) {
    const rg = (file.metadata as unknown as FileMetaData).row_groups[group.id]!;
    const touched = group.columns.filter(column => requests.some(r => intersects(column, r)));
    const columnReads = await Promise.all(touched.map(async column => {
      const chunk = rg.columns.find(c => c.meta_data?.path_in_schema.join('.') === column.name)!;
      const locations = await offsetLocations(chunk);
      const physical = locations?.length ? locations.map((loc, id) => ({
        id, start: Number(loc.offset), end: Number(loc.offset) + loc.compressed_page_size,
      })) : [{ id: 0, start: column.start, end: column.end }];
      const hit = physical.filter(page => requests.some(request => intersects(page, request)));
      const hitBytes = hit.reduce((sum, page) => sum + page.end - page.start, 0);
      dataPageCount += hit.length;
      dataPageBytes += hitBytes;
      if (bboxColumns.has(column.name)) {
        bboxPageCount += hit.length;
        bboxPageBytes += hitBytes;
      }
      if (selectedAttributes.some(name => column.name === name || column.name.startsWith(`${name}.`))) {
        attributePageCount += hit.length;
        attributePageBytes += hitBytes;
      }
      if (column.name === geometryColumn || column.name.startsWith(`${geometryColumn}.`)) {
        geometryPageCount += hit.length;
        geometryPageBytes += hitBytes;
      }
      return { column: column.name, pageIds: hit.map(page => page.id), bytes: hitBytes };
    }));
    columnPagesByGroup[group.id] = columnReads.filter(read => read.pageIds.length);
    if (!readsOverview && touched.some(column => column.name === file.primaryGeometryColumn)) {
      const pages = await pagesFor(group.id);
      const hit = pages.filter(page => requests.some(request => intersects(page, request)));
      if (hit.length) {
        pagesByGroup[group.id] = hit.map(page => page.id);
      }
    }
  }
  if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  const rowGroupBytes = candidates.reduce((sum, group) => sum
    + group.columns.reduce((n, column) => n + column.end - column.start, 0), 0);
  return { bbox, maxLevel, useOverview: readsOverview, attributes: selectedAttributes,
    rows: batch.length, ms: readMs, requests: requests.length,
    fetchedBytes: requests.reduce((sum, request) => sum + request.end - request.start, 0),
    groupIds: candidates.map(group => group.id), rowGroupBytes, dataPageBytes, dataPageCount,
    bboxPageBytes, bboxPageCount, attributePageBytes, attributePageCount,
    columnPagesByGroup, pagesByGroup, geometryPageCount, geometryPageBytes };
}

context.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  if (request.type === 'cancel') { queryController?.abort(); return; }
  try {
    const result = request.type === 'open' ? await open(request.url)
      : request.type === 'pages' ? await pagesFor(request.groupId)
        : await (async () => {
          queryController?.abort();
          const previous = runningQuery;
          const current = (async () => {
            await previous?.catch(() => undefined);
            return query(request.bbox, request.maxLevel, request.useOverview, request.attributes);
          })();
          runningQuery = current;
          return current;
        })();
    context.postMessage({ id: request.id, ok: true, result } satisfies Response);
  } catch (error) {
    context.postMessage({ id: request.id, ok: false, error: (error as Error).message } satisfies Response);
  }
};
