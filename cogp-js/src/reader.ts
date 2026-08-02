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
import {
  coalescingAsyncBuffer,
  type RangeCoalescingOptions,
} from './coalescing-buffer.js';
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
  /** Coalesce nearby concurrent HTTP ranges; enabled by default. */
  rangeCoalescing?: RangeCoalescingOptions | false;
}

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
   * the pre-filter row-group size. The check fires per surviving row, so
   * the returned count never exceeds `maxRows`. Already-dispatched row
   * group fetches (runs coalesced upstream) still complete, but later runs
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
  /** Use Parquet page indexes for bbox pushdown; defaults to false. */
  usePageIndex?: boolean;
}

export class CogpReader {
  static async open(url: string, opts: OpenOptions = {}): Promise<CogpReader> {
    const fetchOpts: Record<string, unknown> = { url };
    if (opts.fetch) fetchOpts['fetch'] = opts.fetch;
    if (opts.byteLength !== undefined) fetchOpts['byteLength'] = opts.byteLength;
    const source = await asyncBufferFromUrl(fetchOpts as { url: string });
    const file = opts.rangeCoalescing === false
      ? source
      : coalescingAsyncBuffer(source, opts.rangeCoalescing);
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
   * Bbox pruning runs at two levels: row groups whose covering envelope
   * misses the query are skipped entirely (no I/O). When `usePageIndex` is
   * enabled, Parquet page indexes additionally prune page ranges inside
   * surviving groups. The remaining rows are filtered exactly against each
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
    for await (const batch of this.streamRuns(rgs, columns, bbox, opts.usePageIndex ?? false)) {
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
   * adjacent column-chunk reads. Byte-range reuse is delegated to the HTTP
   * cache instead of retaining decoded row objects in the JS heap.
   */
  private async *streamRuns(
    rgIndices: number[],
    columns: string[] | undefined,
    bbox?: Bbox,
    usePageIndex = false,
  ): AsyncGenerator<Record<string, unknown>[]> {
    if (rgIndices.length === 0) return;

    const filter = bbox ? bboxFilter(this.bboxPaths, bbox) : undefined;
    for (const run of this.coalescedRuns(rgIndices)) {
      const startRg = run[0]!;
      const endRg = run[run.length - 1]!;
      const rowStart = this.rowOffsets[startRg]!;
      const rowEnd = rowStart + this.sumRowsInRange(startRg, endRg);
      const readArgs: Record<string, unknown> = {
        file: this.file,
        metadata: this.metadata,
        rowStart,
        rowEnd,
        filter,
        // Page-index pushdown is opt-in in hyparquet. It is a no-op without
        // a filter and falls back safely when indexes are unavailable.
        usePageIndex,
        compressors,
        parsers: LAZY_GEO_PARSERS,
      };
      if (columns) readArgs['columns'] = columns;
      if (!filter) delete readArgs['filter'];
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
