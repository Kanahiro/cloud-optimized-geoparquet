import { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { DEFAULT_PARSERS } from 'hyparquet/src/convert.js';
import { prefetchPageIndexes } from 'hyparquet/src/plan.js';
import { wkbToGeojson } from 'hyparquet/src/wkb.js';

import {
  type Bbox,
  type BboxColumnIndexes,
  bboxesIntersect,
  findBboxColumnIndexes,
  type FileMetadataLike,
  rowGroupBbox,
  rowGroupIntersects,
} from './bbox.js';
import { coalescingAsyncBuffer } from './coalescing-buffer.js';
import { selectLevelByResolution } from './level.js';
import { type BboxCovering, type CogpMeta, extractGeoMeta, type GeoMeta } from './meta.js';
import { rangeCachedAsyncBuffer, type RangeCacheOptions } from './range-cache.js';

// Minimal structural view of the metadata object we need; this avoids tight
// coupling to a specific hyparquet major version's exported types.
interface FullFileMetadata extends FileMetadataLike {
  key_value_metadata?: ReadonlyArray<{ key: string; value?: string | null }> | null;
}

type PageIndexPlan = Awaited<ReturnType<typeof prefetchPageIndexes>>;

export type BboxInput = Bbox | readonly [number, number, number, number];

export interface OpenOptions {
  fetch?: typeof fetch;
  byteLength?: number;
  /** Additional HTTP options. Browser caching is always forced to `no-store`. */
  requestInit?: Omit<RequestInit, 'cache'>;
  /** Coalesce overlapping or adjacent concurrent HTTP ranges; enabled by default. */
  rangeCoalescing?: boolean;
  /** In-memory compressed range cache; enabled with a 64 MiB limit by default. */
  rangeCache?: RangeCacheOptions | false;
}

// Cap on cumulative `num_rows` packed into a single decode batch. A batch
// is read by one `parquetReadObjects` call that materializes every row in
// the batch as one array, so peak in-flight memory scales with this value.
const DECODE_BATCH_MAX_ROWS = 50_000;

// PageIndex planning is I/O-bound and much lighter than decoding. Looking
// ahead across several RowGroups removes per-group round trips while keeping
// speculative index reads bounded when maxRows stops a broad query early.
const PAGE_INDEX_WINDOW_MAX_GROUPS = 16;

// Bbox reads have already been narrowed to selected pages, so a small amount
// of decode concurrency is safe and lets ranges from adjacent RowGroups share
// an HTTP batch. Full-file reads remain serial to avoid multiplying memory use.
const BBOX_DECODE_CONCURRENCY = 4;

// Custom parsers handed to hyparquet so it returns raw WKB bytes for
// GEOMETRY/GEOGRAPHY columns instead of eagerly building nested-array
// GeoJSON Geometry objects for every row. We decode WKB ourselves in
// `readRows` after page pruning and the geometry-byte budget check, avoiding
// decoded objects for rows beyond the output budget. The
// other (timestamp/date/string/uuid) parsers fall through to hyparquet's
// defaults — supplying `parsers` replaces the whole table, so we must
// re-export the rest.
const LAZY_GEO_PARSERS = {
  ...DEFAULT_PARSERS,
  geometryFromBytes: (bytes: Uint8Array | undefined) => bytes,
  geographyFromBytes: (bytes: Uint8Array | undefined) => bytes,
};

function decodeWkb(bytes: Uint8Array): unknown {
  return wkbToGeojson({
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    offset: 0,
  });
}

export interface ReadOptions {
  /** Inclusive level index; defaults to the finest level (all row groups). */
  maxLevel?: number;
  /**
   * Prune Row Groups and pages using covering statistics. Returns candidates,
   * not exact spatial matches; no per-row bbox data is read for filtering.
   */
  bbox?: BboxInput;
  /** Subset of columns to materialize. */
  columns?: string[];
  /**
   * Output cap on returned candidate rows, including possible spatial false
   * positives. A finite cap can omit later candidates inside the bbox. The
   * returned count never exceeds `maxRows`. Already-dispatched batches still
   * complete, but later batches are skipped.
   */
  maxRows?: number;
  /**
   * Output cap on cumulative WKB byte size of candidate rows' geometry
   * columns. Measured on the raw on-disk bytes before WKB → GeoJSON decode,
   * so a single huge polygon is caught even when row counts are tiny. The
   * check fires per candidate row and is strict: a row whose geometry bytes
   * would push the cumulative total over the cap is rejected (not decoded,
   * not returned) and streaming stops. This means a single polygon bigger
   * than the cap yields zero rows for that read — by design, since the
   * point of the cap is to prevent shipping that polygon downstream. Only
   * WKB geometry columns contribute; other heavy columns (long strings,
   * etc.) are not measured.
   */
  maxGeometryBytes?: number;
}

export class CogpReader {
  static async open(url: string, opts: OpenOptions = {}): Promise<CogpReader> {
    const fetchOpts: Record<string, unknown> = { url };
    if (opts.fetch) fetchOpts['fetch'] = opts.fetch;
    if (opts.byteLength !== undefined) fetchOpts['byteLength'] = opts.byteLength;
    fetchOpts['requestInit'] = { ...opts.requestInit, cache: 'no-store' } satisfies RequestInit;
    const source = await asyncBufferFromUrl(fetchOpts as { url: string });
    const coalesced = opts.rangeCoalescing === false
      ? source
      : coalescingAsyncBuffer(source);
    const file = opts.rangeCache === false
      ? coalesced
      : rangeCachedAsyncBuffer(coalesced, opts.rangeCache);
    return CogpReader.fromAsyncBuffer(file);
  }

  /**
   * Lower-level entry point. Accepts any hyparquet-compatible `AsyncBuffer`,
   * which is just `{ byteLength, slice(start, end) }`. Useful for testing,
   * for memory-resident buffers, or for custom transports (S3 SDK, IndexedDB,
   * Workers Fetch with auth headers, …).
   */
  static async fromAsyncBuffer(
    file: { byteLength: number; slice: (start: number, end?: number) => unknown },
  ): Promise<CogpReader> {
    const metadata = (await parquetMetadataAsync(file as never)) as unknown as FullFileMetadata;
    return new CogpReader(file, metadata);
  }

  readonly geo: GeoMeta & { lod: CogpMeta };
  /** Row group → flat row index of its first row. */
  private readonly rowOffsets: number[];
  /** Column indexes (within a row group's columns list) of covering bbox sub-columns. */
  private readonly bboxColIdx: BboxColumnIndexes | undefined;
  /** Path-in-schema of the covering bbox struct, e.g. `['bbox','xmin']`. */
  private readonly bboxPaths: BboxCovering | undefined;
  /** Names of WKB-encoded geometry columns we decode lazily after filtering. */
  private readonly geomColumns: readonly string[];

  private constructor(
    private readonly file: unknown,
    private readonly metadata: FullFileMetadata,
  ) {
    this.geo = extractGeoMeta(metadata.key_value_metadata, metadata.row_groups.length);

    const offsets: number[] = [];
    let acc = 0;
    for (const rg of metadata.row_groups) {
      offsets.push(acc);
      acc += Number(rg.num_rows ?? 0);
    }
    this.rowOffsets = offsets;

    const covering = this.geo.columns[this.geo.primary_column]?.covering;
    this.bboxPaths = covering?.bbox;
    const firstRg = metadata.row_groups[0];
    this.bboxColIdx = firstRg && covering ? findBboxColumnIndexes(firstRg, covering.bbox) : undefined;

    const geomCols: string[] = [];
    for (const [name, col] of Object.entries(this.geo.columns)) {
      if (col?.encoding === 'WKB') geomCols.push(name);
    }
    this.geomColumns = geomCols;
  }

  get numRowGroups(): number {
    return this.metadata.row_groups.length;
  }

  get primaryGeometryColumn(): string {
    return this.geo.primary_column;
  }

  /**
   * Select a level index per the specification. Pass a target rendering resolution in
   * primary geometry CRS units; the reader returns the last level whose `resolution >= targetResolution`. If
   * `targetResolution` is omitted (or coarser than the coarsest level), the finest /
   * coarsest level is returned respectively.
   */
  selectLevel(targetResolution?: number): number {
    if (targetResolution === undefined) return this.geo.lod.levels.length - 1;
    return selectLevelByResolution(this.geo.lod.levels, targetResolution);
  }

  /**
   * Read a contiguous level prefix, optionally bbox-pruned, as plain row
   * records. The geometry column carries a GeoJSON Geometry object decoded
   * from the on-disk WKB; decoding happens lazily after page pruning so
   * only candidates selected by the page plan are decoded.
   *
   * Row groups whose covering envelope misses the query are skipped entirely
   * (no I/O). PageIndexes further narrow the candidate rows where available.
   * Candidates may lie outside the bbox; callers clip or filter geometries as
   * needed. Missing statistics conservatively retain candidates. Without a
   * covering, the existing primary-geometry envelope filter applies.
   */
  async readRows(opts: ReadOptions = {}): Promise<Record<string, unknown>[]> {
    const maxLevel = opts.maxLevel ?? this.geo.lod.levels.length - 1;
    const bbox = normalizeBbox(opts.bbox);
    const rgs = this.candidateRowGroups(maxLevel, bbox);
    const maxRows = opts.maxRows;
    const maxGeometryBytes = opts.maxGeometryBytes;
    let wkbBytes = 0;
    // Covering values are for pruning, not implicit output attributes. Explicit
    // projections can still request them like any other column.
    let columns = opts.columns;
    if (bbox && !this.bboxPaths && columns && !columns.includes(this.primaryGeometryColumn)) {
      columns = [...columns, this.primaryGeometryColumn];
    }
    if (bbox && !columns) {
      const coveringColumns = new Set(Object.values(this.bboxPaths ?? {}).map(path => path[0]));
      columns = parquetSchema(this.metadata as never).children
        .map(child => child.element.name).filter(name => !coveringColumns.has(name));
    }
    const out: Record<string, unknown>[] = [];
    const geomCols = this.geomColumns;
    // Returns true once a cap has been reached, signalling callers to stop
    // iterating the current row group (and the outer stream) immediately
    // rather than draining the rest of the batch. The geometry-byte check
    // runs BEFORE WKB → GeoJSON decode so a single huge polygon doesn't
    // sneak past the cap (decoded GeoJSON can be many MB even when the
    // caller asked for a small output budget — that's what crashes the
    // downstream renderer).
    //
    const acceptRow = (row: Record<string, unknown>): boolean => {
      if (maxGeometryBytes !== undefined) {
        let rowWkbBytes = 0;
        for (const col of geomCols) {
          const v = row[col];
          if (v instanceof Uint8Array) rowWkbBytes += v.byteLength;
        }
        if (wkbBytes + rowWkbBytes > maxGeometryBytes) return true;
        wkbBytes += rowWkbBytes;
      }
      for (const col of geomCols) {
        const v = row[col];
        if (v instanceof Uint8Array) row[col] = decodeWkb(v);
      }
      if (bbox && !this.bboxPaths && !geometryIntersects(row[this.primaryGeometryColumn], bbox)) return false;
      out.push(row);
      if (maxRows !== undefined && out.length >= maxRows) return true;
      return false;
    };
    for await (const batch of this.streamBatches(rgs, columns, this.bboxPaths ? bbox : undefined)) {
      for (const row of batch) {
        if (acceptRow(row)) return out;
      }
    }
    return out;
  }

  /** Bbox of a single row group as derived from covering column statistics. */
  rowGroupEnvelope(rgIndex: number): Bbox | null {
    const rg = this.metadata.row_groups[rgIndex];
    if (!rg || !this.bboxColIdx) return null;
    return rowGroupBbox(rg, this.bboxColIdx);
  }

  private candidateRowGroups(maxLevel: number, bbox?: Bbox): number[] {
    if (maxLevel < 0 || maxLevel >= this.geo.lod.levels.length) {
      throw new Error(`maxLevel ${maxLevel} out of range [0, ${this.geo.lod.levels.length})`);
    }
    const end = this.geo.lod.levels[maxLevel]!.row_group_end;
    const out: number[] = [];
    for (let i = 0; i <= end; i++) {
      const rg = this.metadata.row_groups[i]!;
      if (bbox && this.bboxColIdx && !rowGroupIntersects(rg, this.bboxColIdx, bbox)) continue;
      out.push(i);
    }
    return out;
  }

  /**
   * Plan PageIndexes in bounded I/O windows, then materialize consecutive
   * RowGroups in separately bounded decode batches. Keeping those boundaries
   * independent avoids turning the memory limit into an HTTP round-trip limit.
   */
  private async *streamBatches(
    rgIndices: number[],
    columns: string[] | undefined,
    bbox?: Bbox,
  ): AsyncGenerator<Record<string, unknown>[]> {
    if (rgIndices.length === 0) return;

    // Planning always uses the spatial predicate. Passing it to the value
    // reader would also materialize its bbox columns, so statistics-only reads
    // execute the precomputed page plan without a row filter.
    const indexWindows: number[][] = [];
    if (bbox && this.bboxPaths) {
      for (let i = 0; i < rgIndices.length; i += PAGE_INDEX_WINDOW_MAX_GROUPS) {
        indexWindows.push(rgIndices.slice(i, i + PAGE_INDEX_WINDOW_MAX_GROUPS));
      }
    } else {
      indexWindows.push(rgIndices);
    }

    for (const window of indexWindows) {
      const pageIndexPlan = bbox
        ? await this.prefetchPageIndexPlan(window, columns, bbox)
        : undefined;
      const batches = this.decodeBatches(window);
      const concurrency = bbox ? BBOX_DECODE_CONCURRENCY : 1;
      for (let i = 0; i < batches.length; i += concurrency) {
        // Await a complete wave so every rejection is observed. This also
        // prevents a fast batch from continuously running ahead of a slow one.
        const wave = await Promise.all(
          batches.slice(i, i + concurrency).map(batch =>
            this.readBatch(batch, columns, pageIndexPlan),
          ),
        );
        for (const rows of wave) yield rows;
      }
    }
  }

  private async readBatch(
    batch: number[],
    columns: string[] | undefined,
    pageIndexPlan: PageIndexPlan | undefined,
  ): Promise<Record<string, unknown>[]> {
    const startRg = batch[0]!;
    const endRg = batch[batch.length - 1]!;
    const rowStart = this.rowOffsets[startRg]!;
    const rowEnd = rowStart + this.sumRowsInRange(startRg, endRg);
    const readArgs: Record<string, unknown> = {
      file: this.file,
      metadata: this.metadata,
      rowStart,
      rowEnd,
      usePageIndex: false,
      compressors,
      parsers: LAZY_GEO_PARSERS,
    };
    if (pageIndexPlan) {
      readArgs['pageRangesByGroup'] = pageIndexPlan.pageRangesByGroup;
      readArgs['pageLocationsByGroup'] = pageIndexPlan.pageLocationsByGroup;
    }
    if (columns) readArgs['columns'] = columns;
    return parquetReadObjects(readArgs as never) as Promise<Record<string, unknown>[]>;
  }

  private decodeBatches(indices: number[]): Array<number[]> {
    const batches: Array<number[]> = [];
    let i = 0;
    while (i < indices.length) {
      const batch: number[] = [indices[i]!];
      let acc = Number(this.metadata.row_groups[indices[i]!]?.num_rows ?? 0);
      let j = i + 1;
      while (
        j < indices.length &&
        indices[j]! === indices[j - 1]! + 1 &&
        acc < DECODE_BATCH_MAX_ROWS
      ) {
        batch.push(indices[j]!);
        acc += Number(this.metadata.row_groups[indices[j]!]?.num_rows ?? 0);
        j++;
      }
      batches.push(batch);
      i = j;
    }
    return batches;
  }

  private sumRowsInRange(start: number, end: number): number {
    let n = 0;
    for (let i = start; i <= end; i++) {
      n += Number(this.metadata.row_groups[i]?.num_rows ?? 0);
    }
    return n;
  }

  private async prefetchPageIndexPlan(
    rgIndices: number[],
    columns: string[] | undefined,
    bbox: Bbox,
  ): Promise<PageIndexPlan> {
    const firstRg = rgIndices[0]!;
    const lastRg = rgIndices[rgIndices.length - 1]!;
    const rowStart = this.rowOffsets[firstRg]!;
    const rowEnd = this.rowOffsets[lastRg]! +
      Number(this.metadata.row_groups[lastRg]?.num_rows ?? 0);
    return prefetchPageIndexes({
      file: this.file,
      metadata: this.metadata,
      filter: bboxFilter(this.bboxPaths!, bbox),
      rowStart,
      rowEnd,
      columns,
      parsers: LAZY_GEO_PARSERS,
    } as never);
  }

}

function bboxFilter(paths: BboxCovering, bbox: Bbox): Record<string, unknown> {
  return {
    $and: [
      { [paths.xmin.join('.')]: { $lte: bbox.maxX } },
      { [paths.ymin.join('.')]: { $lte: bbox.maxY } },
      { [paths.xmax.join('.')]: { $gte: bbox.minX } },
      { [paths.ymax.join('.')]: { $gte: bbox.minY } },
    ],
  };
}

function normalizeBbox(input?: BboxInput): Bbox | undefined {
  if (!input) return undefined;
  if (Array.isArray(input)) {
    return { minX: input[0]!, minY: input[1]!, maxX: input[2]!, maxY: input[3]! };
  }
  return input as Bbox;
}

// Without a covering, decode the primary geometry and evaluate its envelope.
function geometryIntersects(value: unknown, query: Bbox): boolean {
  if (!value || typeof value !== 'object') return false;
  const geometry = value as { coordinates?: unknown; geometries?: unknown[] };
  if (geometry.geometries) return geometry.geometries.some(g => geometryIntersects(g, query));
  const envelope = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      envelope.minX = Math.min(envelope.minX, coords[0]);
      envelope.maxX = Math.max(envelope.maxX, coords[0]);
      envelope.minY = Math.min(envelope.minY, coords[1]);
      envelope.maxY = Math.max(envelope.maxY, coords[1]);
    } else coords.forEach(visit);
  };
  visit(geometry.coordinates);
  return bboxesIntersect(envelope, query);
}
