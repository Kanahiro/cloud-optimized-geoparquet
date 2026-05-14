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
import { LruCache } from './cache.js';
import { selectLodByGsd } from './lod.js';
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

const DEFAULT_CACHE_MAX_ROWS = 1_000_000;

export interface ReadOptions {
  /** Inclusive LoD index; defaults to the finest LoD (all row groups). */
  maxLod?: number;
  /** Spatial filter; row groups whose covering envelope misses this bbox are skipped. */
  bbox?: BboxInput;
  /** Subset of columns to materialize. */
  columns?: string[];
  /**
   * Fetch budget: cap on cumulative `num_rows` of selected row groups. Row
   * groups are picked in LoD/file order (post-bbox-prune); selection stops
   * once adding the next group would push the cumulative count over this
   * limit. A row group is never partially loaded, so the returned row count
   * may be less than `maxRows` (especially after per-row bbox filtering).
   */
  maxRows?: number;
  /**
   * Fetch budget: cap on cumulative `total_byte_size` (uncompressed) of
   * selected row groups, in bytes. Same selection semantics as `maxRows`.
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
  }

  get lods() {
    return this.cogp.lods;
  }

  get numRowGroups(): number {
    return this.metadata.row_groups.length;
  }

  get primaryGeometryColumn(): string {
    return this.geo.primary_column;
  }

  /**
   * Select an LoD index per SPEC §7. Pass a target ground-sample distance in
   * meters; the reader returns the last LoD whose `gsd >= targetGsd`. If
   * `targetGsd` is omitted (or coarser than the coarsest LoD), the finest /
   * coarsest LoD is returned respectively.
   */
  selectLod(targetGsd?: number): number {
    if (targetGsd === undefined) return this.lods.length - 1;
    return selectLodByGsd(this.lods, targetGsd);
  }

  /**
   * Read a contiguous LoD prefix, optionally bbox-pruned, as plain row
   * records. The geometry column carries a GeoJSON Geometry object (decoded
   * by hyparquet from the on-disk WKB).
   *
   * Bbox pruning runs at two levels: row groups whose covering envelope
   * misses the query are skipped entirely (no I/O), then surviving groups
   * are filtered row-by-row against each row's per-feature bbox column.
   */
  async readRows(opts: ReadOptions = {}): Promise<Record<string, unknown>[]> {
    const maxLod = opts.maxLod ?? this.lods.length - 1;
    const bbox = normalizeBbox(opts.bbox);
    const rgs = this.candidateRowGroups(maxLod, bbox, opts.maxRows, opts.maxBytes);
    // When filtering by bbox we need the per-row bbox struct on hand. If the
    // caller provided a custom column selection that excludes it, splice the
    // struct's top-level name in transparently — hyparquet reads the whole
    // struct when you name its root.
    let columns = opts.columns;
    if (bbox && columns) {
      const top = this.bboxPaths.xmin[0]!;
      if (!columns.includes(top)) columns = [...columns, top];
    }
    const rows = await this.readRowGroupsAsRows(rgs, columns);
    if (!bbox) return rows;
    return this.filterRowsByBbox(rows, bbox);
  }

  private filterRowsByBbox(
    rows: Record<string, unknown>[],
    query: Bbox,
  ): Record<string, unknown>[] {
    const paths = this.bboxPaths;
    return rows.filter((row) =>
      bboxesIntersect(
        {
          minX: readNum(row, paths.xmin),
          minY: readNum(row, paths.ymin),
          maxX: readNum(row, paths.xmax),
          maxY: readNum(row, paths.ymax),
        },
        query,
      ),
    );
  }

  /** Bbox of a single row group as derived from covering column statistics. */
  rowGroupEnvelope(rgIndex: number): Bbox | null {
    const rg = this.metadata.row_groups[rgIndex];
    if (!rg) return null;
    return rowGroupBbox(rg, this.bboxColIdx);
  }

  private candidateRowGroups(
    maxLod: number,
    bbox?: Bbox,
    maxRows?: number,
    maxBytes?: number,
  ): number[] {
    if (maxLod < 0 || maxLod >= this.lods.length) {
      throw new Error(`maxLod ${maxLod} out of range [0, ${this.lods.length})`);
    }
    const end = this.lods[maxLod]!.row_group_end;
    const out: number[] = [];
    let rowsAcc = 0;
    let bytesAcc = 0;
    for (let i = 0; i <= end; i++) {
      const rg = this.metadata.row_groups[i]!;
      if (bbox && !rowGroupIntersects(rg, this.bboxColIdx, bbox)) continue;
      const n = Number(rg.num_rows ?? 0);
      const b = Number(rg.total_byte_size ?? 0);
      if (maxRows !== undefined && rowsAcc + n > maxRows) break;
      if (maxBytes !== undefined && bytesAcc + b > maxBytes) break;
      out.push(i);
      rowsAcc += n;
      bytesAcc += b;
    }
    return out;
  }

  /** Drop all cached row-group data; subsequent reads will re-fetch. */
  clearCache(): void {
    this.rowGroupCache.clear();
  }

  private async readRowGroupsAsRows(
    rgIndices: number[],
    columns: string[] | undefined,
  ): Promise<Record<string, unknown>[]> {
    if (rgIndices.length === 0) return [];

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

    // Phase 2: build runs of consecutive missing indices so hyparquet can
    // pull their column chunks together, then dispatch each run as a single
    // fetch. Each row group's slice promise is registered in the cache
    // immediately so a second caller arriving while the run is mid-flight
    // reuses the same Promise (single-flight) instead of issuing a duplicate.
    const runs: Array<{ startRg: number; endRg: number }> = [];
    {
      let i = 0;
      while (i < missing.length) {
        let j = i;
        while (j + 1 < missing.length && missing[j + 1]! === missing[j]! + 1) j++;
        runs.push({ startRg: missing[i]!, endRg: missing[j]! });
        i = j + 1;
      }
    }

    for (const { startRg, endRg } of runs) {
      const rowStart = this.rowOffsets[startRg]!;
      const rowEnd = rowStart + this.sumRowsInRange(startRg, endRg);
      const readArgs: Record<string, unknown> = {
        file: this.file,
        metadata: this.metadata,
        rowStart,
        rowEnd,
        compressors,
      };
      if (columns) readArgs['columns'] = columns;
      const runPromise = parquetReadObjects(readArgs as never) as Promise<
        Record<string, unknown>[]
      >;
      let offset = 0;
      for (let r = startRg; r <= endRg; r++) {
        const start = offset;
        const n = Number(this.metadata.row_groups[r]?.num_rows ?? 0);
        offset += n;
        const end = offset;
        const slicePromise = runPromise.then((rows) => rows.slice(start, end));
        this.rowGroupCache.set(cacheKey(r), slicePromise, n);
        promises.set(r, slicePromise);
      }
    }

    // Phase 3: await each row group's promise in the requested order and
    // concatenate.
    const allRows: Record<string, unknown>[] = [];
    for (const rg of rgIndices) {
      const slice = await promises.get(rg)!;
      for (const r of slice) allRows.push(r);
    }
    return allRows;
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
