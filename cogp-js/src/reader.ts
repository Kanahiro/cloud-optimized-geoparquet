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
import { lruCachingAsyncBuffer, type RangeCacheOptions } from './range-cache.js';
import { selectGeometryColumnByGsd, selectLevelByGsd } from './level.js';
import {
  type BboxCovering,
  type CogpMeta,
  extractCogpDocument,
  geometryFamily,
  type GeoMeta,
} from './meta.js';

// Minimal structural view of the metadata object we need; this avoids tight
// coupling to a specific hyparquet major version's exported types.
interface FullFileMetadata extends FileMetadataLike {
  key_value_metadata?: ReadonlyArray<{ key: string; value?: string | null }> | null;
  schema: ReadonlyArray<{ name: string; num_children?: number }>;
}

export type BboxInput = Bbox | readonly [number, number, number, number];

export interface OpenOptions {
  fetch?: typeof fetch;
  byteLength?: number;
  /** Coalesce nearby concurrent HTTP ranges; enabled by default. */
  rangeCoalescing?: RangeCoalescingOptions | false;
  /** Retain exact requested ranges in a bounded LRU; defaults to 128 MiB. */
  rangeCache?: RangeCacheOptions | false;
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
  /** Select a scale-specific geometry overview and, by default, its row prefix. */
  targetGsd?: number;
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
  /**
   * Add each source row's zero-based file index under this property name.
   * This is useful for lightweight viewport reads that fetch full attributes
   * later with `readRow`. The name must not collide with a physical column.
   */
  rowIndexColumn?: string;
}

export interface ReadRowOptions {
  /** Subset of physical columns to materialize. */
  columns?: string[];
}

export class CogpReader {
  static async open(url: string, opts: OpenOptions = {}): Promise<CogpReader> {
    const fetchOpts: Record<string, unknown> = { url };
    if (opts.fetch) fetchOpts['fetch'] = opts.fetch;
    if (opts.byteLength !== undefined) fetchOpts['byteLength'] = opts.byteLength;
    const source = await asyncBufferFromUrl(fetchOpts as { url: string });
    const coalesced = opts.rangeCoalescing === false
      ? source
      : coalescingAsyncBuffer(source, opts.rangeCoalescing);
    const file = opts.rangeCache === false
      ? coalesced
      : lruCachingAsyncBuffer(coalesced, opts.rangeCache);
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
  readonly columnNames: readonly string[];
  readonly numRows: number;
  /** Row group → flat row index of its first row. */
  private readonly rowOffsets: number[];
  /** Column indexes (within a row group's columns list) of covering bbox sub-columns. */
  private readonly bboxColIdx: BboxColumnIndexes;
  /** Path-in-schema of the covering bbox struct, e.g. `['bbox','xmin']`. */
  private readonly bboxPaths: BboxCovering;
  private readonly extendedGeometry: boolean;

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
    this.numRows = acc;
    this.columnNames = topLevelColumnNames(metadata.schema);

    // SPEC: COGP mandates a per-feature bbox covering on the primary
    // geometry column. Surface a clear error rather than silently falling
    // back to "no spatial filter" when the file is malformed.
    const primaryCol = this.geo.columns[this.geo.primary_column];
    const family = geometryFamily(primaryCol?.geometry_types ?? []);
    this.extendedGeometry = family === 'line' || family === 'polygon';
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
   * Physical WKB column precise enough for the target and complete for the
   * prefix. Extended-geometry streaming deliberately stays on the finest
   * complete overview when one exists. Files without overviews use the
   * lossless primary column.
   */
  selectGeometryColumn(targetGsd?: number, maxLevel?: number): string {
    if (targetGsd === undefined) return this.primaryGeometryColumn;
    const minimumLevel = maxLevel ?? this.selectLevel(targetGsd);
    return selectGeometryColumnByGsd(
      this.cogp.geometry_overviews ?? [],
      targetGsd,
      minimumLevel,
      this.primaryGeometryColumn,
      this.extendedGeometry,
    );
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
    const maxLevel = opts.maxLevel ?? this.selectLevel(opts.targetGsd);
    const bbox = normalizeBbox(opts.bbox);
    const rgs = this.candidateRowGroups(maxLevel, bbox);
    const maxRows = opts.maxRows;
    const maxRowWkbBytes = opts.maxRowWkbBytes;
    const rowIndexColumn = opts.rowIndexColumn;
    if (rowIndexColumn && this.columnNames.includes(rowIndexColumn)) {
      throw new Error(`rowIndexColumn \`${rowIndexColumn}\` collides with a physical column`);
    }
    let wkbBytes = 0;
    // When filtering by bbox we need the per-row bbox struct on hand. If the
    // caller provided a custom column selection that excludes it, splice the
    // struct's top-level name in transparently — hyparquet reads the whole
    // struct when you name its root.
    const selectedGeometry = this.selectGeometryColumn(opts.targetGsd, maxLevel);
    const overviewNames = new Set(
      (this.cogp.geometry_overviews ?? []).map((overview) => overview.column),
    );
    const primaryRequested = !opts.columns || opts.columns.includes(this.primaryGeometryColumn);
    let columns = opts.columns;
    if (columns && primaryRequested && selectedGeometry !== this.primaryGeometryColumn) {
      columns = columns.map((column) =>
        column === this.primaryGeometryColumn ? selectedGeometry : column
      );
    } else if (!columns && overviewNames.size > 0) {
      columns = topLevelColumnNames(this.metadata.schema).filter(
        (column) => column !== this.primaryGeometryColumn && !overviewNames.has(column),
      );
      columns.push(selectedGeometry);
    }
    if (bbox && columns) {
      const top = this.bboxPaths.xmin[0]!;
      if (!columns.includes(top)) columns = [...columns, top];
    }
    const out: Record<string, unknown>[] = [];
    const paths = bbox ? this.bboxPaths : null;
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
        const geometry = row[selectedGeometry];
        const rowWkbBytes = geometry instanceof Uint8Array ? geometry.byteLength : 0;
        if (wkbBytes + rowWkbBytes > maxRowWkbBytes) return true;
        wkbBytes += rowWkbBytes;
      }
      if (primaryRequested) {
        const geometry = row[selectedGeometry];
        if (geometry instanceof Uint8Array) {
          row[this.primaryGeometryColumn] = decodeWkb(geometry);
          if (selectedGeometry !== this.primaryGeometryColumn) delete row[selectedGeometry];
        } else if (selectedGeometry !== this.primaryGeometryColumn) {
          throw new Error(
            `geometry overview \`${selectedGeometry}\` is null inside its declared level boundary`,
          );
        }
      }
      out.push(row);
      if (maxRows !== undefined && out.length >= maxRows) return true;
      return false;
    };
    let stopped = false;
    for await (const batch of this.streamRuns(rgs, columns, rowIndexColumn)) {
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

  /**
   * Read one source row by its stable zero-based file index. Callers can keep
   * viewport reads narrow, then fetch expensive properties only for a feature
   * the user actually inspects.
   */
  async readRow(
    rowIndex: number,
    opts: ReadRowOptions = {},
  ): Promise<Record<string, unknown> | null> {
    if (!Number.isSafeInteger(rowIndex) || rowIndex < 0 || rowIndex >= this.numRows) {
      throw new Error(`rowIndex ${rowIndex} out of range [0, ${this.numRows})`);
    }
    const readArgs: Record<string, unknown> = {
      file: this.file,
      metadata: this.metadata,
      rowStart: rowIndex,
      rowEnd: rowIndex + 1,
      compressors,
      parsers: LAZY_GEO_PARSERS,
    };
    if (opts.columns) readArgs['columns'] = opts.columns;
    const rows = (await parquetReadObjects(readArgs as never)) as Record<string, unknown>[];
    return rows[0] ?? null;
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
   * adjacent column-chunk reads. The AsyncBuffer's bounded LRU retains exact
   * slices across calls before this method materializes decoded rows.
   */
  private async *streamRuns(
    rgIndices: number[],
    columns: string[] | undefined,
    rowIndexColumn: string | undefined,
  ): AsyncGenerator<Record<string, unknown>[]> {
    if (rgIndices.length === 0) return;

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
        compressors,
        parsers: LAZY_GEO_PARSERS,
      };
      if (columns) readArgs['columns'] = columns;
      const rows = (await parquetReadObjects(readArgs as never)) as Record<string, unknown>[];
      if (rowIndexColumn) {
        for (let index = 0; index < rows.length; index++) {
          rows[index]![rowIndexColumn] = rowStart + index;
        }
      }
      yield rows;
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

/** Top-level field names from Parquet's flattened depth-first schema list. */
function topLevelColumnNames(
  schema: ReadonlyArray<{ name: string; num_children?: number }>,
): string[] {
  const names: string[] = [];
  const skipSubtree = (index: number): number => {
    let next = index + 1;
    const children = schema[index]?.num_children ?? 0;
    for (let child = 0; child < children; child++) next = skipSubtree(next);
    return next;
  };
  const rootChildren = schema[0]?.num_children ?? Math.max(schema.length - 1, 0);
  let index = schema.length > 0 ? 1 : 0;
  for (let child = 0; child < rootChildren && index < schema.length; child++) {
    names.push(schema[index]!.name);
    index = skipSubtree(index);
  }
  return names;
}
