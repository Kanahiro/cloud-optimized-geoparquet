import { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

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
  type ByteRange,
  coalescingAsyncBuffer,
  type RangeCoalescingOptions,
} from './coalescing-buffer.js';
import { selectLevelByResolution } from './level.js';
import { type BboxCovering, type CogpMeta, extractCogpDocument, type GeoMeta } from './meta.js';
import {
  decodeOverview,
  projectOverviewMetadata,
  rootColumnNames,
  type OverviewFileMetadata,
} from './overview.js';
import { rangeCachedAsyncBuffer, type RangeCacheOptions } from './range-cache.js';

// Minimal structural view of the metadata object we need; this avoids tight
// coupling to a specific hyparquet major version's exported types.
interface FullFileMetadata extends OverviewFileMetadata {
  key_value_metadata?: ReadonlyArray<{ key: string; value?: string | null }> | null;
}

export type BboxInput = Bbox | readonly [number, number, number, number];

export interface OpenOptions {
  fetch?: typeof fetch;
  byteLength?: number;
  /** Coalesce nearby concurrent HTTP ranges; enabled by default. */
  rangeCoalescing?: RangeCoalescingOptions | false;
  /** In-memory byte-range cache for this reader; enabled by default. */
  rangeCache?: RangeCacheOptions | false;
}

// Cap on cumulative `num_rows` packed into a single coalesced fetch. A run
// is read by one `parquetReadObjects` call that materializes every row in
// the run as one array, so peak in-flight memory scales with this value.
const RUN_MAX_ROWS = 50_000;

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
   * group fetches (runs coalesced upstream) still complete, but later runs
   * are skipped entirely.
   */
  maxRows?: number;
}

export class CogpReader {
  static async open(url: string, opts: OpenOptions = {}): Promise<CogpReader> {
    // Browser HTTP caches handle many 206 responses poorly. Bypass them and
    // keep reuse deterministic in the per-reader range cache below.
    const fetchOpts: Record<string, unknown> = { url, requestInit: { cache: 'no-store' } };
    if (opts.fetch) fetchOpts['fetch'] = opts.fetch;
    if (opts.byteLength !== undefined) fetchOpts['byteLength'] = opts.byteLength;
    const source = await asyncBufferFromUrl(fetchOpts as { url: string });
    const cached = opts.rangeCache === false
      ? source
      : rangeCachedAsyncBuffer(source, opts.rangeCache);
    // Fetch exactly the 8-byte trailer first, then exactly the declared
    // metadata. hyparquet's 512 KiB default tail prefetch can otherwise absorb
    // the final WKB page before its protected ranges are known.
    const metadata = (await parquetMetadataAsync(cached as never, {
      initialFetchSize: 8,
    })) as unknown as FullFileMetadata;
    const doc = extractCogpDocument(metadata.key_value_metadata);
    const configuredRanges = opts.rangeCoalescing === false
      ? []
      : opts.rangeCoalescing?.protectedRanges ?? [];
    const protectedRanges = [...configuredRanges, ...wkbColumnRanges(metadata, doc.geo)];
    const file = opts.rangeCoalescing === false
      ? cached
      : coalescingAsyncBuffer(cached, { ...opts.rangeCoalescing, protectedRanges });
    return new CogpReader(file, metadata, url);
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
    const metadata = (await parquetMetadataAsync(file as never, {
      initialFetchSize: 8,
    })) as unknown as FullFileMetadata;
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
  /** WKB columns are excluded from every browser projection and protected range plan. */
  private readonly geomColumns: readonly string[];

  private constructor(
    private readonly file: unknown,
    readonly metadata: FullFileMetadata,
    readonly url: string,
  ) {
    const doc = extractCogpDocument(metadata.key_value_metadata);
    this.cogp = doc.cogp;
    this.geo = doc.geo;
    const finalBoundary = this.cogp.levels[this.cogp.levels.length - 1]!.row_group_end;
    if (finalBoundary !== metadata.row_groups.length - 1) {
      throw new Error(
        `cogp final row_group_end ${finalBoundary} does not cover ${metadata.row_groups.length} row groups`,
      );
    }

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
   * meters; the reader returns the last level whose `resolution >= targetResolution`. If
   * `targetResolution` is omitted (or coarser than the coarsest level), the finest /
   * coarsest level is returned respectively.
   */
  selectLevel(targetResolution?: number): number {
    if (targetResolution === undefined) return this.levels.length - 1;
    return selectLevelByResolution(this.levels, targetResolution);
  }

  /**
   * Read a contiguous level prefix, optionally bbox-pruned, as plain row
   * records. The geometry column carries a GeoJSON Geometry object decoded
   * from the selected integer overview; decoding happens lazily after bbox
   * filtering so rows that miss the query never pay for it.
   *
   * Row groups whose covering envelope misses the query are skipped entirely
   * (no I/O). Rows in the remaining groups are filtered exactly against each
   * row's per-feature bbox column.
   */
  async readRows(opts: ReadOptions = {}): Promise<Record<string, unknown>[]> {
    const maxLevel = opts.maxLevel ?? this.levels.length - 1;
    const level = this.levels[maxLevel];
    if (!level) throw new Error(`maxLevel ${maxLevel} out of range [0, ${this.levels.length})`);
    const lodMetadata = this.cogp.overviews.lods[level.lod]!;
    const projectedMetadata = projectOverviewMetadata(this.metadata, level.lod);
    const bbox = normalizeBbox(opts.bbox);
    const rgs = this.candidateRowGroups(maxLevel, bbox);
    const maxRows = opts.maxRows;
    // When filtering by bbox we need the per-row bbox struct on hand. If the
    // caller provided a custom column selection that excludes it, splice the
    // struct's top-level name in transparently — hyparquet reads the whole
    // struct when you name its root.
    const requested = opts.columns ?? rootColumnNames(this.metadata.schema);
    const wantsGeometry = opts.columns === undefined
      || opts.columns.includes(this.primaryGeometryColumn)
      || opts.columns.includes('overviews');
    let columns = requested.filter(
      (column) => !this.geomColumns.includes(column) && column !== 'overviews',
    );
    if (wantsGeometry) columns.push('overviews');
    if (bbox && columns) {
      const top = this.bboxPaths.xmin[0]!;
      if (!columns.includes(top)) columns = [...columns, top];
    }
    const out: Record<string, unknown>[] = [];
    const paths = bbox ? this.bboxPaths : null;
    // Returns true once a cap has been reached, signalling callers to stop
    // iterating the current row group (and the outer stream) immediately
    // rather than draining the rest of the batch.
    const acceptRow = (row: Record<string, unknown>): boolean => {
      if (wantsGeometry) {
        row[this.primaryGeometryColumn] = decodeOverview(row['overviews'], lodMetadata);
        delete row['overviews'];
      }
      out.push(row);
      if (maxRows !== undefined && out.length >= maxRows) return true;
      return false;
    };
    let stopped = false;
    for await (const batch of this.streamRuns(rgs, columns, projectedMetadata)) {
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
   * Materialize consecutive row-group runs in order. Each run is capped at
   * `RUN_MAX_ROWS`, bounding peak memory while allowing hyparquet to combine
   * adjacent column-chunk reads. Byte-range reuse is handled by the reader's
   * bounded cache instead of retaining decoded row objects in the JS heap.
   */
  private async *streamRuns(
    rgIndices: number[],
    columns: string[] | undefined,
    metadata: FullFileMetadata,
  ): AsyncGenerator<Record<string, unknown>[]> {
    if (rgIndices.length === 0) return;

    for (const run of this.coalescedRuns(rgIndices)) {
      const startRg = run[0]!;
      const endRg = run[run.length - 1]!;
      const rowStart = this.rowOffsets[startRg]!;
      const rowEnd = rowStart + this.sumRowsInRange(startRg, endRg);
      const readArgs: Record<string, unknown> = {
        file: this.file,
        metadata,
        rowStart,
        rowEnd,
        compressors,
      };
      if (columns) readArgs['columns'] = columns;
      yield (await parquetReadObjects(readArgs as never)) as Record<string, unknown>[];
    }
  }

  private coalescedRuns(indices: number[]): Array<number[]> {
    const runs: Array<number[]> = [];
    let i = 0;
    while (i < indices.length) {
      const run: number[] = [indices[i]!];
      let acc = Number(this.metadata.row_groups[indices[i]!]?.num_rows ?? 0);
      let j = i + 1;
      while (j < indices.length && indices[j]! === indices[j - 1]! + 1 && acc < RUN_MAX_ROWS) {
        run.push(indices[j]!);
        acc += Number(this.metadata.row_groups[indices[j]!]?.num_rows ?? 0);
        j++;
      }
      runs.push(run);
      i = j;
    }
    return runs;
  }

  private sumRowsInRange(start: number, end: number): number {
    let n = 0;
    for (let i = start; i <= end; i++) {
      n += Number(this.metadata.row_groups[i]?.num_rows ?? 0);
    }
    return n;
  }

}

/**
 * Locate physical WKB chunks once, from the footer, and turn them into hard
 * transport barriers. Projection keeps them out of the Parquet plan; these
 * barriers additionally prevent request coalescing from transferring them as
 * an unrequested gap between useful chunks.
 */
function wkbColumnRanges(metadata: FullFileMetadata, geo: GeoMeta): ByteRange[] {
  const wkbColumns = new Set(
    Object.entries(geo.columns)
      .filter(([, column]) => column?.encoding === 'WKB')
      .map(([name]) => name),
  );
  const ranges: ByteRange[] = [];
  for (const rowGroup of metadata.row_groups) {
    for (const column of rowGroup.columns) {
      const meta = column.meta_data as (typeof column.meta_data & {
        data_page_offset?: bigint;
        dictionary_page_offset?: bigint;
        total_compressed_size?: bigint;
      });
      if (!meta || !wkbColumns.has(meta.path_in_schema?.[0] ?? '')) continue;
      const offset = meta.dictionary_page_offset ?? meta.data_page_offset;
      const size = meta.total_compressed_size;
      if (offset === undefined || size === undefined) {
        throw new Error('WKB column chunk is missing physical offset metadata');
      }
      const start = Number(offset);
      const end = Number(offset + size);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        throw new Error('WKB column chunk offset exceeds the browser safe-integer range');
      }
      ranges.push({ start, end });
    }
  }
  return ranges;
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
