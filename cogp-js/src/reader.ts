import { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
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
import {
  coalescingAsyncBuffer,
  type RangeCoalescingOptions,
} from './coalescing-buffer.js';
import { selectLevelByGsd } from './level.js';
import { type BboxCovering, type CogpMeta, extractCogpDocument, type GeoMeta } from './meta.js';
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
  /** Coalesce nearby concurrent HTTP ranges; enabled by default. */
  rangeCoalescing?: RangeCoalescingOptions | false;
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
// `readRows` only for rows that survive the bbox filter, which cuts peak
// memory dramatically for small tile bboxes against dense files. The
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
  /** Spatial filter; row groups whose covering envelope misses this bbox are skipped. */
  bbox?: BboxInput;
  /** Subset of columns to materialize. */
  columns?: string[];
  /**
   * Output cap: stop streaming once this many rows have survived bbox
   * filtering. Applied to the post-filter row count, so when a `bbox` is
   * provided the value reflects rows actually returned to the caller, not
   * the pre-filter row-group size. The check fires per surviving row, so
   * the returned count never exceeds `maxRows`. Already-dispatched row
   * batch fetches already dispatched upstream still complete, but later batches
   * are skipped entirely.
   */
  maxRows?: number;
  /**
   * Output cap on cumulative WKB byte size of surviving rows' geometry
   * columns. Measured on the raw on-disk bytes before WKB → GeoJSON decode,
   * so a single huge polygon is caught even when row counts are tiny. The
   * check fires per surviving row and is strict: a row whose geometry bytes
   * would push the cumulative total over the cap is rejected (not decoded,
   * not returned) and streaming stops. This means a single polygon bigger
   * than the cap yields zero rows for that read — by design, since the
   * point of the cap is to prevent shipping that polygon downstream. Only
   * WKB geometry columns contribute; other heavy columns (long strings,
   * etc.) are not measured.
   */
  maxRowWkbBytes?: number;
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
      : coalescingAsyncBuffer(source, opts.rangeCoalescing);
    const file = opts.rangeCache === false
      ? coalesced
      : rangeCachedAsyncBuffer(coalesced, opts.rangeCache);
    return CogpReader.fromAsyncBuffer(file, url);
  }

  /**
   * Lower-level entry point. Accepts any hyparquet-compatible `AsyncBuffer`,
   * which is just `{ byteLength, slice(start, end) }`. Useful for testing,
   * for memory-resident buffers, or for custom transports (S3 SDK, IndexedDB,
   * Workers Fetch with auth headers, …).
   */
  static async fromAsyncBuffer(
    file: { byteLength: number; slice: (start: number, end?: number) => unknown },
    url: string,
  ): Promise<CogpReader> {
    const metadata = (await parquetMetadataAsync(file as never)) as unknown as FullFileMetadata;
    return new CogpReader(file, metadata, url);
  }

  readonly cogp: CogpMeta;
  readonly geo: GeoMeta;
  /** Row group → flat row index of its first row. */
  private readonly rowOffsets: number[];
  /** Column indexes (within a row group's columns list) of covering bbox sub-columns. */
  private readonly bboxColIdx: BboxColumnIndexes;
  /** Path-in-schema of the covering bbox struct, e.g. `['bbox','xmin']`. */
  private readonly bboxPaths: BboxCovering;
  /** Names of WKB-encoded geometry columns we decode lazily after filtering. */
  private readonly geomColumns: readonly string[];

  private constructor(
    private readonly file: unknown,
    readonly metadata: FullFileMetadata,
    readonly url: string,
  ) {
    const doc = extractCogpDocument(metadata.key_value_metadata);
    this.cogp = doc.cogp;
    this.geo = doc.geo;

    const offsets: number[] = [];
    let acc = 0;
    for (const rg of metadata.row_groups) {
      offsets.push(acc);
      acc += Number(rg.num_rows ?? 0);
    }
    this.rowOffsets = offsets;

    // SPEC: COGP mandates a per-feature bbox covering on the primary
    // geometry column. Surface a clear error rather than silently falling
    // back to "no spatial filter" when the file is malformed.
    const primaryCol = this.geo.columns[this.geo.primary_column];
    const covering = primaryCol?.covering;
    if (!covering?.bbox) {
      throw new Error(
        `not a COGP file: primary geometry column \`${this.geo.primary_column}\` is missing \`covering.bbox\``,
      );
    }
    this.bboxPaths = covering.bbox;
    const firstRg = metadata.row_groups[0];
    if (!firstRg) {
      throw new Error('cogp file has no row groups');
    }
    this.bboxColIdx = findBboxColumnIndexes(firstRg, covering.bbox);

    const geomCols: string[] = [];
    for (const [name, col] of Object.entries(this.geo.columns)) {
      if (col?.encoding === 'WKB') geomCols.push(name);
    }
    this.geomColumns = geomCols;
  }

  get levels() {
    return this.cogp.levels;
  }

  get numRowGroups(): number {
    return this.metadata.row_groups.length;
  }

  get primaryGeometryColumn(): string {
    return this.geo.primary_column;
  }

  /**
   * Select a level index per SPEC §7. Pass a target ground-sample distance in
   * meters; the reader returns the last level whose `gsd >= targetGsd`. If
   * `targetGsd` is omitted (or coarser than the coarsest level), the finest /
   * coarsest level is returned respectively.
   */
  selectLevel(targetGsd?: number): number {
    if (targetGsd === undefined) return this.levels.length - 1;
    return selectLevelByGsd(this.levels, targetGsd);
  }

  /**
   * Read a contiguous level prefix, optionally bbox-pruned, as plain row
   * records. The geometry column carries a GeoJSON Geometry object decoded
   * from the on-disk WKB; decoding happens lazily after bbox filtering so
   * rows that miss the query never pay for it.
   *
   * Row groups whose covering envelope misses the query are skipped entirely
   * (no I/O). Rows in the remaining groups are filtered exactly against each
   * row's per-feature bbox column.
   */
  async readRows(opts: ReadOptions = {}): Promise<Record<string, unknown>[]> {
    const maxLevel = opts.maxLevel ?? this.levels.length - 1;
    const bbox = normalizeBbox(opts.bbox);
    const rgs = this.candidateRowGroups(maxLevel, bbox);
    const maxRows = opts.maxRows;
    const maxRowWkbBytes = opts.maxRowWkbBytes;
    let wkbBytes = 0;
    // When filtering by bbox we need the per-row bbox struct on hand. If the
    // caller provided a custom column selection that excludes it, splice the
    // struct's top-level name in transparently — hyparquet reads the whole
    // struct when you name its root.
    let columns = opts.columns;
    if (bbox && columns) {
      const top = this.bboxPaths.xmin[0]!;
      if (!columns.includes(top)) columns = [...columns, top];
    }
    const out: Record<string, unknown>[] = [];
    const paths = bbox ? this.bboxPaths : null;
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
      if (maxRowWkbBytes !== undefined) {
        let rowWkbBytes = 0;
        for (const col of geomCols) {
          const v = row[col];
          if (v instanceof Uint8Array) rowWkbBytes += v.byteLength;
        }
        if (wkbBytes + rowWkbBytes > maxRowWkbBytes) return true;
        wkbBytes += rowWkbBytes;
      }
      for (const col of geomCols) {
        const v = row[col];
        if (v instanceof Uint8Array) row[col] = decodeWkb(v);
      }
      out.push(row);
      if (maxRows !== undefined && out.length >= maxRows) return true;
      return false;
    };
    let stopped = false;
    for await (const batch of this.streamBatches(rgs, columns, bbox)) {
      if (!paths) {
        for (const row of batch) {
          if (acceptRow(row)) {
            stopped = true;
            break;
          }
        }
      } else {
        for (const row of batch) {
          if (
            bboxesIntersect(
              {
                minX: readNum(row, paths.xmin),
                minY: readNum(row, paths.ymin),
                maxX: readNum(row, paths.xmax),
                maxY: readNum(row, paths.ymax),
              },
              bbox!,
            )
          ) {
            if (acceptRow(row)) {
              stopped = true;
              break;
            }
          }
        }
      }
      if (stopped) break;
    }
    return out;
  }

  /** Bbox of a single row group as derived from covering column statistics. */
  rowGroupEnvelope(rgIndex: number): Bbox | null {
    const rg = this.metadata.row_groups[rgIndex];
    if (!rg) return null;
    return rowGroupBbox(rg, this.bboxColIdx);
  }

  private candidateRowGroups(maxLevel: number, bbox?: Bbox): number[] {
    if (maxLevel < 0 || maxLevel >= this.levels.length) {
      throw new Error(`maxLevel ${maxLevel} out of range [0, ${this.levels.length})`);
    }
    const end = this.levels[maxLevel]!.row_group_end;
    const out: number[] = [];
    for (let i = 0; i <= end; i++) {
      const rg = this.metadata.row_groups[i]!;
      if (bbox && !rowGroupIntersects(rg, this.bboxColIdx, bbox)) continue;
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

    // Keep the four spatial predicates together: hyparquet uses this one
    // expression for PageIndex pruning and exact row filtering. PageIndexes
    // are fetched lazily only for bbox reads and only for candidate row groups.
    const filter = bbox ? bboxFilter(this.bboxPaths, bbox) : undefined;
    const indexWindows: number[][] = [];
    if (bbox) {
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
            this.readBatch(batch, columns, filter, pageIndexPlan),
          ),
        );
        for (const rows of wave) yield rows;
      }
    }
  }

  private async readBatch(
    batch: number[],
    columns: string[] | undefined,
    filter: Record<string, unknown> | undefined,
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
      filter,
      usePageIndex: false,
      compressors,
      parsers: LAZY_GEO_PARSERS,
    };
    if (pageIndexPlan) {
      readArgs['pageRangesByGroup'] = pageIndexPlan.pageRangesByGroup;
      readArgs['pageLocationsByGroup'] = pageIndexPlan.pageLocationsByGroup;
    }
    if (columns) readArgs['columns'] = columns;
    if (!filter) delete readArgs['filter'];
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
      filter: bboxFilter(this.bboxPaths, bbox),
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

// Walk a path-in-schema like `['bbox','xmin']` against a hyparquet row object.
// The struct is mandated by COGP and read unconditionally when filtering, so
// every segment is guaranteed to resolve to a number.
function readNum(row: Record<string, unknown>, path: readonly string[]): number {
  let cur: unknown = row;
  for (const p of path) cur = (cur as Record<string, unknown>)[p];
  return cur as number;
}
