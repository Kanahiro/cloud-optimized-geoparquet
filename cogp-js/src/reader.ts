import { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { DEFAULT_PARSERS } from 'hyparquet/src/convert.js';
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
import { LruCache } from './cache.js';
import { selectLevelByGsd } from './level.js';
import { type BboxCovering, type CogpMeta, extractCogpDocument, type GeoMeta } from './meta.js';

// Minimal structural view of the metadata object we need; this avoids tight
// coupling to a specific hyparquet major version's exported types.
interface FullFileMetadata extends FileMetadataLike {
  key_value_metadata?: ReadonlyArray<{ key: string; value?: string | null }> | null;
}

export type BboxInput = Bbox | readonly [number, number, number, number];

export interface OpenOptions {
  fetch?: typeof fetch;
  byteLength?: number;
  /**
   * Maximum total rows held in the per-row-group cache. When a read would
   * push the cache past this, the least-recently-used row groups are
   * evicted. Defaults to 1,000,000.
   */
  cacheMaxRows?: number;
}

const DEFAULT_CACHE_MAX_ROWS = 500_000;

// Cap on cumulative `num_rows` packed into a single coalesced fetch. A run
// is read by one `parquetReadObjects` call that materializes every row in
// the run as one array, so peak in-flight memory scales with this value.
const RUN_MAX_ROWS = 50_000;

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
   * the pre-filter row-group size. Row groups are consumed in level/file
   * order; the row group whose rows push the count past the cap is still
   * fully filtered, so the returned count may exceed `maxRows` by less than
   * one row group's worth of survivors.
   */
  maxRows?: number;
  /**
   * Fetch budget: cap on cumulative `total_byte_size` (uncompressed) of
   * selected row groups, in bytes. Row groups are picked in level/file
   * order (post-bbox-prune); selection stops once adding the next group
   * would push the cumulative byte count over this limit. A row group is
   * never partially loaded.
   */
  maxBytes?: number;
}

export class CogpReader {
  static async open(url: string, opts: OpenOptions = {}): Promise<CogpReader> {
    const fetchOpts: Record<string, unknown> = { url };
    if (opts.fetch) fetchOpts['fetch'] = opts.fetch;
    if (opts.byteLength !== undefined) fetchOpts['byteLength'] = opts.byteLength;
    const file = await asyncBufferFromUrl(fetchOpts as { url: string });
    return CogpReader.fromAsyncBuffer(file, url, opts);
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
    opts: OpenOptions = {},
  ): Promise<CogpReader> {
    const metadata = (await parquetMetadataAsync(file as never)) as unknown as FullFileMetadata;
    return new CogpReader(file, metadata, url, opts.cacheMaxRows ?? DEFAULT_CACHE_MAX_ROWS);
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
  /**
   * Row-group → in-flight or resolved row records, keyed by
   * `${rgIndex}|${columnsKey}`. Storing a Promise (not the resolved value)
   * gives single-flight: concurrent reads of the same row group share one
   * underlying fetch.
   */
  private readonly rowGroupCache: LruCache<Promise<Record<string, unknown>[]>>;

  private constructor(
    private readonly file: unknown,
    readonly metadata: FullFileMetadata,
    readonly url: string,
    cacheMaxRows: number,
  ) {
    this.rowGroupCache = new LruCache(cacheMaxRows);
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
   * Bbox pruning runs at two levels: row groups whose covering envelope
   * misses the query are skipped entirely (no I/O), then surviving groups
   * are filtered row-by-row against each row's per-feature bbox column.
   */
  async readRows(opts: ReadOptions = {}): Promise<Record<string, unknown>[]> {
    const maxLevel = opts.maxLevel ?? this.levels.length - 1;
    const bbox = normalizeBbox(opts.bbox);
    const rgs = this.candidateRowGroups(maxLevel, bbox, opts.maxBytes);
    const maxRows = opts.maxRows;
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
    const decodeGeoms = (row: Record<string, unknown>) => {
      for (const col of geomCols) {
        const v = row[col];
        if (v instanceof Uint8Array) row[col] = decodeWkb(v);
      }
    };
    for await (const batch of this.streamRowGroups(rgs, columns)) {
      if (!paths) {
        for (const row of batch) {
          decodeGeoms(row);
          out.push(row);
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
            decodeGeoms(row);
            out.push(row);
          }
        }
      }
      if (maxRows !== undefined && out.length >= maxRows) break;
    }
    return out;
  }

  /** Bbox of a single row group as derived from covering column statistics. */
  rowGroupEnvelope(rgIndex: number): Bbox | null {
    const rg = this.metadata.row_groups[rgIndex];
    if (!rg) return null;
    return rowGroupBbox(rg, this.bboxColIdx);
  }

  private candidateRowGroups(maxLevel: number, bbox?: Bbox, maxBytes?: number): number[] {
    if (maxLevel < 0 || maxLevel >= this.levels.length) {
      throw new Error(`maxLevel ${maxLevel} out of range [0, ${this.levels.length})`);
    }
    const end = this.levels[maxLevel]!.row_group_end;
    const out: number[] = [];
    let bytesAcc = 0;
    for (let i = 0; i <= end; i++) {
      const rg = this.metadata.row_groups[i]!;
      if (bbox && !rowGroupIntersects(rg, this.bboxColIdx, bbox)) continue;
      const b = Number(rg.total_byte_size ?? 0);
      if (maxBytes !== undefined && bytesAcc + b > maxBytes) break;
      out.push(i);
      bytesAcc += b;
    }
    return out;
  }

  /** Drop all cached row-group data; subsequent reads will re-fetch. */
  clearCache(): void {
    this.rowGroupCache.clear();
  }

  /**
   * Materialize the requested row groups and yield one row group's rows per
   * iteration, in the order given. Callers that filter per-row (e.g. bbox)
   * can keep only the survivors and let each batch be GC'd, so peak memory
   * is bounded by `(largest pending fetch) + (accumulated survivors)` rather
   * than the sum of every selected row group's full row count.
   */
  private async *streamRowGroups(
    rgIndices: number[],
    columns: string[] | undefined,
  ): AsyncGenerator<Record<string, unknown>[]> {
    if (rgIndices.length === 0) return;

    // Different `columns` selections produce structurally different rows, so
    // they get distinct cache entries. `*` marks "no projection".
    const columnsKey = columns ? columns.slice().sort().join(',') : '*';
    const cacheKey = (rg: number) => `${rg}|${columnsKey}`;

    // Phase 1: pick up in-flight or resolved promises from the cache, and
    // identify what still needs to be fetched.
    const promises = new Map<number, Promise<Record<string, unknown>[]>>();
    const missing: number[] = [];
    for (const rg of rgIndices) {
      const p = this.rowGroupCache.get(cacheKey(rg));
      if (p) promises.set(rg, p);
      else missing.push(rg);
    }

    // Phase 2: group consecutive missing indices into runs so hyparquet can
    // pull their column chunks together. A run is also capped by cumulative
    // num_rows: a single `parquetReadObjects` call materializes the entire
    // run's rows in one array, so an unbounded run is the worst case for
    // peak memory. The first row group in a run is always included even if
    // it alone exceeds the cap (we can't fetch partial row groups).
    const runs: Array<number[]> = [];
    {
      let i = 0;
      while (i < missing.length) {
        const run: number[] = [missing[i]!];
        let acc = Number(this.metadata.row_groups[missing[i]!]?.num_rows ?? 0);
        let j = i + 1;
        while (
          j < missing.length &&
          missing[j]! === missing[j - 1]! + 1 &&
          acc < RUN_MAX_ROWS
        ) {
          run.push(missing[j]!);
          acc += Number(this.metadata.row_groups[missing[j]!]?.num_rows ?? 0);
          j++;
        }
        runs.push(run);
        i = j;
      }
    }
    const rgToRun = new Map<number, number[]>();
    for (const run of runs) for (const rg of run) rgToRun.set(rg, run);
    const dispatched = new WeakSet<number[]>();

    // Each row group's slice promise is registered in the cache the moment
    // its run is dispatched, so a second caller arriving while the run is
    // mid-flight reuses the same Promise (single-flight) instead of issuing
    // a duplicate.
    const dispatchRun = (run: number[]) => {
      if (dispatched.has(run)) return;
      dispatched.add(run);
      const startRg = run[0]!;
      const endRg = run[run.length - 1]!;
      const rowStart = this.rowOffsets[startRg]!;
      const rowEnd = rowStart + this.sumRowsInRange(startRg, endRg);
      const readArgs: Record<string, unknown> = {
        file: this.file,
        metadata: this.metadata,
        rowStart,
        rowEnd,
        compressors,
        parsers: LAZY_GEO_PARSERS,
      };
      if (columns) readArgs['columns'] = columns;
      const runPromise = parquetReadObjects(readArgs as never) as Promise<
        Record<string, unknown>[]
      >;
      let offset = 0;
      for (const r of run) {
        const start = offset;
        const n = Number(this.metadata.row_groups[r]?.num_rows ?? 0);
        offset += n;
        const end = offset;
        const slicePromise = runPromise.then((rows) => rows.slice(start, end));
        this.rowGroupCache.set(cacheKey(r), slicePromise, n);
        promises.set(r, slicePromise);
      }
    };

    // Phase 3: dispatch each run only when iteration first reaches one of
    // its row groups, then yield the row group's slice. If the caller breaks
    // early (e.g. post-filter `maxRows` reached), later runs are never
    // fetched.
    for (const rg of rgIndices) {
      let p = promises.get(rg);
      if (!p) {
        const run = rgToRun.get(rg);
        if (run) {
          dispatchRun(run);
          p = promises.get(rg);
        }
      }
      yield await p!;
    }
  }

  private sumRowsInRange(start: number, end: number): number {
    let n = 0;
    for (let i = start; i <= end; i++) {
      n += Number(this.metadata.row_groups[i]?.num_rows ?? 0);
    }
    return n;
  }

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
