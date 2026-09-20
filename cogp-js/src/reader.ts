import { parquetMetadataAsync, parquetRead } from 'hyparquet';
import type { Compressors, ParquetQueryFilter } from 'hyparquet';
import { compressors as defaultCompressors } from 'hyparquet-compressors';

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
  type AsyncBufferLike,
  type ByteRange,
  coalescingAsyncBuffer,
} from './coalescing-buffer.js';
import { selectLevelByResolution } from './level.js';
import {
  type BboxCovering,
  type CogpMeta,
  extractGeoMeta,
  type GeoMeta,
  type LodMetadata,
} from './meta.js';
import {
  decodeQuantizedOverview,
  parseOverviewColumns,
  projectOverviewMetadata,
  rootColumnNames,
  type QuantizedOverviewGeometry,
  type OverviewFileMetadata,
} from './overview.js';
import { rangeCachedAsyncBuffer, type RangeCacheOptions } from './range-cache.js';
import { bindAbortSignal, throwIfAborted } from './abort.js';
import { abortableAsyncBufferFromUrl } from './http-buffer.js';

// Minimal structural view of the metadata object we need; this avoids tight
// coupling to a specific hyparquet major version's exported types.
interface FullFileMetadata extends OverviewFileMetadata {
  key_value_metadata?: ReadonlyArray<{ key: string; value?: string | null }> | null;
}

type NumberArray = ArrayLike<number> & { readonly length: number };

interface PageChunk {
  pathInSchema: string[];
  columnData: ArrayLike<unknown>;
  rowStart: number;
  rowEnd: number;
}

interface ColumnChunk {
  columnName: string;
  columnData: ArrayLike<unknown>;
  rowStart: number;
  rowEnd: number;
}

interface OverviewSelection {
  rowIndexes: number[];
  values: QuantizedOverviewGeometry[];
}

export type BboxInput = Bbox | readonly [number, number, number, number];

export interface OpenOptions {
  fetch?: typeof fetch;
  byteLength?: number;
  /** Additional HTTP options. Browser caching is always forced to `no-store`. */
  requestInit?: Omit<RequestInit, 'cache' | 'signal'>;
  /** Abort opening the URL and fetching its Parquet metadata. */
  signal?: AbortSignal;
  /** Coalesce nearby concurrent HTTP ranges; enabled by default. */
  rangeCoalescing?: boolean;
  /** In-memory byte-range cache for this reader; enabled by default. */
  rangeCache?: RangeCacheOptions | false;
  /** Override individual Parquet compression codecs. */
  compressors?: Compressors;
}

// Cap on cumulative `num_rows` packed into a single coalesced fetch. Columns
// are retained until the run's surviving rows are assembled, so peak in-flight
// memory still scales with this value.
const RUN_MAX_ROWS = 50_000;

/** Optional, non-enumerable source-row identity attached by `readRows`. */
export const COGP_ROW_INDEX = Symbol('cogp.rowIndex');

export interface ReadOptions {
  /** Inclusive level index; defaults to the finest level (all row groups). */
  maxLevel?: number;
  /** Filters primary geometry covering bboxes; the selected overview only controls rendering. */
  bbox?: BboxInput;
  /** Subset of columns to materialize. */
  columns?: string[];
  /**
   * Decode a quantized overview into a caller-owned representation.
   * The default materializes GeoJSON geometry. This hook is only used when the
   * file declares overviews; otherwise the reader returns primary WKB.
   */
  overviewDecoder?: (overview: QuantizedOverviewGeometry | null) => unknown;
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
  /** Abort pending Range requests and stop before decoding further runs. */
  signal?: AbortSignal;
  /** Attach the source's zero-based row index under `COGP_ROW_INDEX`. */
  includeRowIndex?: boolean;
}

export class CogpReader {
  static async open(url: string, opts: OpenOptions = {}): Promise<CogpReader> {
    // Browser HTTP caches handle many 206 responses poorly. Bypass them and
    // keep reuse deterministic in the per-reader range cache below.
    const source = await abortableAsyncBufferFromUrl(url, opts);
    const cached = opts.rangeCache === false
      ? source
      : rangeCachedAsyncBuffer(source, opts.rangeCache);
    // Fetch exactly the 8-byte trailer first, then exactly the declared
    // metadata. hyparquet's 512 KiB default tail prefetch can otherwise absorb
    // the final WKB page before its protected ranges are known.
    const metadata = (await parquetMetadataAsync(bindAbortSignal(cached, opts.signal) as never, {
      initialFetchSize: 8,
    })) as unknown as FullFileMetadata;
    const geo = extractGeoMeta(metadata.key_value_metadata, metadata.row_groups.length);
    const protectedRanges = geo.lod.overviews === undefined
      ? []
      : wkbColumnRanges(metadata, geo);
    const file = opts.rangeCoalescing === false
      ? cached
      : coalescingAsyncBuffer(cached, { protectedRanges });
    return new CogpReader(file, metadata, url, opts.compressors);
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
    opts: Pick<OpenOptions, 'compressors'> = {},
  ): Promise<CogpReader> {
    const metadata = (await parquetMetadataAsync(file as never, {
      initialFetchSize: 8,
    })) as unknown as FullFileMetadata;
    return new CogpReader(file, metadata, url, opts.compressors);
  }

  readonly geo: GeoMeta & { lod: CogpMeta };
  /** Row group → flat row index of its first row. */
  private readonly rowOffsets: number[];
  private readonly rowCount: number;
  /** Column indexes (within a row group's columns list) of covering bbox sub-columns. */
  private readonly bboxColIdx: BboxColumnIndexes | undefined;
  /** Path-in-schema of the covering bbox struct, e.g. `['bbox','xmin']`. */
  private readonly bboxPaths: BboxCovering | undefined;
  /** WKB columns excluded from overview-backed browser projections. */
  private readonly geomColumns: readonly string[];
  /** Whether rendering uses the overview column instead of primary WKB. */
  private readonly usesOverviews: boolean;
  /** Codec table is resolved once so every page read shares initialized decoders. */
  private readonly compressors: Compressors;
  /** Two adjacent zoom levels cover normal pan/zoom without retaining every projection. */
  private readonly overviewMetadataCache = new Map<string, FullFileMetadata>();

  private constructor(
    private readonly file: unknown,
    readonly metadata: FullFileMetadata,
    readonly url: string,
    compressors?: Compressors,
  ) {
    const geo = extractGeoMeta(metadata.key_value_metadata, metadata.row_groups.length);
    this.geo = geo;
    this.compressors = { ...defaultCompressors, ...compressors };
    this.usesOverviews = this.geo.lod.overviews !== undefined;
    const hasOverviewsColumn = rootColumnNames(metadata.schema).includes('overviews');
    if (this.usesOverviews && !hasOverviewsColumn) {
      throw new Error('cogp file is missing declared `overviews` column');
    }
    const finalBoundary = this.geo.lod.levels[this.geo.lod.levels.length - 1]!.row_group_end;
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
    this.rowCount = acc;

    // SPEC: COGP mandates a per-feature bbox covering on the primary
    // geometry column. Surface a clear error rather than silently falling
    // back to "no spatial filter" when the file is malformed.
    const primaryCol = this.geo.columns[this.geo.primary_column];
    const covering = primaryCol?.covering;
    this.bboxPaths = covering?.bbox;
    const firstRg = metadata.row_groups[0];
    this.bboxColIdx = firstRg && covering?.bbox ? findBboxColumnIndexes(firstRg, covering.bbox) : undefined;

    const geomCols: string[] = [];
    for (const [name, col] of Object.entries(this.geo.columns)) {
      if (col?.encoding === 'WKB') geomCols.push(name);
    }
    this.geomColumns = geomCols;
  }

  get levels() {
    return this.geo.lod.levels;
  }

  get numRowGroups(): number {
    return this.metadata.row_groups.length;
  }

  get columnNames(): readonly string[] {
    return rootColumnNames(this.metadata.schema);
  }

  get primaryGeometryColumn(): string {
    return this.geo.primary_column;
  }

  /**
   * Select a level index using a target rendering resolution in
   * primary geometry CRS units; the reader returns the last level whose `resolution >= targetResolution`. If
   * `targetResolution` is omitted (or coarser than the coarsest level), the finest /
   * coarsest level is returned respectively.
   */
  selectLevel(targetResolution?: number): number {
    if (targetResolution === undefined) return this.levels.length - 1;
    return selectLevelByResolution(this.levels, targetResolution);
  }

  /** Read selected top-level columns for one absolute source row. */
  async readRow(
    rowIndex: number,
    opts: Pick<ReadOptions, 'columns' | 'signal'> = {},
  ): Promise<Record<string, unknown>> {
    if (!Number.isSafeInteger(rowIndex) || rowIndex < 0 || rowIndex >= this.rowCount) {
      throw new Error(`rowIndex ${rowIndex} out of range [0, ${this.rowCount})`);
    }
    throwIfAborted(opts.signal);
    const columns = opts.columns ?? this.columnNames;
    const values = await this.readColumnValues(
      bindAbortSignal(this.file as AsyncBufferLike, opts.signal),
      this.metadata,
      rowIndex,
      rowIndex + 1,
      [...columns],
    );
    const row: Record<string, unknown> = {};
    for (const column of columns) {
      const value = values.get(column)?.[0];
      if (value === undefined) throw new Error(`column \`${column}\` is missing row ${rowIndex}`);
      row[column] = value;
    }
    throwIfAborted(opts.signal);
    return row;
  }

  /**
   * Read a contiguous level prefix, optionally bbox-pruned, as plain row
   * records. When the file declares overviews, geometry is decoded from the
   * selected integer overview. Otherwise primary WKB is read through
   * hyparquet's normal GeoParquet path.
   *
   * Row groups whose covering envelope misses the query are skipped entirely
   * (no I/O). Rows in the remaining groups are filtered exactly against each
   * row's per-feature bbox column.
   */
  async readRows(opts: ReadOptions = {}): Promise<Record<string, unknown>[]> {
    throwIfAborted(opts.signal);
    const maxLevel = opts.maxLevel ?? this.levels.length - 1;
    const level = this.levels[maxLevel];
    if (!level) throw new Error(`maxLevel ${maxLevel} out of range [0, ${this.levels.length})`);
    const lod = level.lod;
    const lodMetadata = this.usesOverviews
      ? this.geo.lod.overviews!.lods[lod!]!
      : undefined;
    const projectedMetadata = this.usesOverviews
      ? this.projectedMetadata(lod!)
      : this.metadata;
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
      || (this.usesOverviews && opts.columns.includes('overviews'));
    let columns = requested.filter(
      (column) => (!this.usesOverviews || !this.geomColumns.includes(column))
        && (!this.usesOverviews || column !== 'overviews'),
    );
    if (wantsGeometry && this.usesOverviews) columns.push('overviews');
    const injectedBboxColumns: string[] = [];
    if (bbox && this.bboxPaths) {
      for (const path of Object.values(this.bboxPaths)) {
        const top = path[0]!;
        if (!columns.includes(top)) {
          columns.push(top);
          injectedBboxColumns.push(top);
        }
      }
    }
    const out: Record<string, unknown>[] = [];
    const paths = bbox ? this.bboxPaths : null;
    // Returns true once a cap has been reached, signalling callers to stop
    // iterating the current row group (and the outer stream) immediately
    // rather than draining the rest of the batch.
    const acceptRow = (row: Record<string, unknown>): boolean => {
      if (wantsGeometry && lodMetadata) {
        const overview = row['overviews'] as QuantizedOverviewGeometry | null;
        row[this.primaryGeometryColumn] = opts.overviewDecoder
          ? opts.overviewDecoder(overview)
          : decodeQuantizedOverview(overview);
        delete row['overviews'];
      }
      for (const column of injectedBboxColumns) delete row[column];
      out.push(row);
      if (maxRows !== undefined && out.length >= maxRows) return true;
      return false;
    };
    let stopped = false;
    for await (const batch of this.streamRuns(
      rgs,
      columns,
      projectedMetadata,
      bbox,
      wantsGeometry ? lod : undefined,
      wantsGeometry ? lodMetadata : undefined,
      opts.signal,
      opts.includeRowIndex ?? false,
    )) {
      throwIfAborted(opts.signal);
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
    throwIfAborted(opts.signal);
    return out;
  }

  /** Bbox of a single row group as derived from covering column statistics. */
  rowGroupEnvelope(rgIndex: number): Bbox | null {
    const rg = this.metadata.row_groups[rgIndex];
    if (!rg || !this.bboxColIdx) return null;
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
      if (bbox && this.bboxColIdx && !rowGroupIntersects(rg, this.bboxColIdx, bbox)) continue;
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
    bbox?: Bbox,
    lod?: string,
    lodMetadata?: LodMetadata,
    signal?: AbortSignal,
    includeRowIndex = false,
  ): AsyncGenerator<Record<string, unknown>[]> {
    if (rgIndices.length === 0) return;

    const filter = bbox && this.bboxPaths ? bboxFilter(this.bboxPaths, bbox) : undefined;
    const file = bindAbortSignal(this.file as AsyncBufferLike, signal);
    for (const run of this.coalescedRuns(rgIndices)) {
      throwIfAborted(signal);
      const startRg = run[0]!;
      const endRg = run[run.length - 1]!;
      const rowStart = this.rowOffsets[startRg]!;
      const rowEnd = rowStart + this.sumRowsInRange(startRg, endRg);
      const readsOverview = lod !== undefined && lodMetadata !== undefined;
      const objectColumns = readsOverview
        ? columns?.filter((column) => column !== 'overviews')
        : columns;
      const columnsPromise = this.readColumnValues(
        file,
        metadata,
        rowStart,
        rowEnd,
        objectColumns ?? [],
        filter,
      );
      const overviewPromise = readsOverview
        ? this.readOverviewLeaves(
          file,
          metadata,
          rowStart,
          rowEnd,
          lod,
          lodMetadata,
          bbox,
        )
        : undefined;
      const [columnValues, overviewSelection] = await Promise.all([
        columnsPromise,
        overviewPromise,
      ]);
      const rowIndexes = overviewSelection?.rowIndexes
        ?? selectedRowIndexes(columnValues, rowEnd - rowStart, this.bboxPaths, bbox);
      const rows = new Array<Record<string, unknown>>(rowIndexes.length);
      for (let i = 0; i < rowIndexes.length; i++) {
        const localRow = rowIndexes[i]!;
        const row: Record<string, unknown> = {};
        for (const column of objectColumns ?? []) {
          const values = columnValues.get(column);
          if (!values || values[localRow] === undefined) {
            throw new Error(`column \`${column}\` is missing row ${rowStart + localRow}`);
          }
          row[column] = values[localRow];
        }
        if (overviewSelection) row['overviews'] = overviewSelection.values[i]!;
        if (includeRowIndex) {
          Object.defineProperty(row, COGP_ROW_INDEX, { value: rowStart + localRow });
        }
        rows[i] = row;
      }
      throwIfAborted(signal);
      yield rows;
    }
  }

  /** Read top-level columns without transposing the whole run into row objects. */
  private async readColumnValues(
    file: AsyncBufferLike,
    metadata: FullFileMetadata,
    rowStart: number,
    rowEnd: number,
    columns: string[],
    filter?: ParquetQueryFilter,
  ): Promise<Map<string, unknown[]>> {
    const values = new Map<string, unknown[]>();
    if (columns.length === 0 && !filter) return values;
    const rowCount = rowEnd - rowStart;
    await parquetRead({
      file: file as never,
      metadata: metadata as never,
      rowStart,
      rowEnd,
      columns,
      compressors: this.compressors,
      rowFormat: 'object',
      filter,
      usePageIndex: filter !== undefined,
      onChunk: ((chunk: ColumnChunk) => {
        let target = values.get(chunk.columnName);
        if (!target) {
          target = new Array(rowCount);
          values.set(chunk.columnName, target);
        }
        for (let i = 0; i < chunk.columnData.length; i++) {
          const localRow = chunk.rowStart + i - rowStart;
          if (localRow >= 0 && localRow < rowCount) target[localRow] = chunk.columnData[i];
        }
      }) as never,
    });
    return values;
  }

  /**
   * Decode the selected LoD's physical leaves without asking hyparquet to
   * assemble `list<struct<x,y>>`. The only per-row containers are the lists
   * themselves; no object is allocated per vertex.
   */
  private async readOverviewLeaves(
    file: AsyncBufferLike,
    metadata: FullFileMetadata,
    rowStart: number,
    rowEnd: number,
    lod: string,
    lodMetadata: LodMetadata,
    bbox?: Bbox,
  ): Promise<OverviewSelection> {
    const rowCount = rowEnd - rowStart;
    const geometryTypes: Array<number | undefined> = new Array(rowCount);
    const xs: Array<NumberArray | undefined> = new Array(rowCount);
    const ys: Array<NumberArray | undefined> = new Array(rowCount);
    const partEnds: Array<NumberArray | undefined> = new Array(rowCount);
    const polygonEnds: Array<NumberArray | undefined> = new Array(rowCount);
    const minXs: Array<number | undefined> = new Array(rowCount);
    const minYs: Array<number | undefined> = new Array(rowCount);
    const maxXs: Array<number | undefined> = new Array(rowCount);
    const maxYs: Array<number | undefined> = new Array(rowCount);

    const assign = <T>(target: Array<T | undefined>, chunk: PageChunk, map: (value: unknown) => T) => {
      for (let i = 0; i < chunk.columnData.length; i++) {
        const localRow = chunk.rowStart + i - rowStart;
        if (localRow >= 0 && localRow < rowCount) {
          target[localRow] = map(chunk.columnData[i]);
        }
      }
    };
    const onPage = (chunk: PageChunk) => {
      const path = chunk.pathInSchema;
      if (path[0] === 'overviews' && path[1] === 'geometry_type') {
        assign(geometryTypes, chunk, Number);
      } else if (path[0] === 'overviews' && path[1] === lod && path[2] === 'coordinates') {
        if (path[path.length - 1] === 'x') assign(xs, chunk, asNumberArray);
        if (path[path.length - 1] === 'y') assign(ys, chunk, asNumberArray);
      } else if (path[0] === 'overviews' && path[1] === lod && path[2] === 'part_ends') {
        assign(partEnds, chunk, asNumberArray);
      } else if (path[0] === 'overviews' && path[1] === lod && path[2] === 'polygon_ends') {
        assign(polygonEnds, chunk, asNumberArray);
      } else if (this.bboxPaths && samePath(path, this.bboxPaths.xmin)) {
        assign(minXs, chunk, Number);
      } else if (this.bboxPaths && samePath(path, this.bboxPaths.ymin)) {
        assign(minYs, chunk, Number);
      } else if (this.bboxPaths && samePath(path, this.bboxPaths.xmax)) {
        assign(maxXs, chunk, Number);
      } else if (this.bboxPaths && samePath(path, this.bboxPaths.ymax)) {
        assign(maxYs, chunk, Number);
      }
    };
    const filter = bbox && this.bboxPaths ? bboxFilter(this.bboxPaths, bbox) : undefined;
    await parquetRead({
      file: file as never,
      metadata: metadata as never,
      rowStart,
      rowEnd,
      columns: ['overviews'],
      compressors: this.compressors,
      rowFormat: 'object',
      filter,
      usePageIndex: filter !== undefined,
      onPage: onPage as never,
    });

    const rowIndexes: number[] = [];
    const values: QuantizedOverviewGeometry[] = [];
    for (let row = 0; row < rowCount; row++) {
      if (bbox && this.bboxPaths) {
        const values = [minXs[row], minYs[row], maxXs[row], maxYs[row]];
        if (values.some((value) => value === undefined)) continue;
        if (!bboxesIntersect(
          { minX: values[0]!, minY: values[1]!, maxX: values[2]!, maxY: values[3]! },
          bbox,
        )) continue;
      }
      const geometryType = geometryTypes[row];
      const rowXs = xs[row];
      const rowYs = ys[row];
      const rowPartEnds = partEnds[row];
      const rowPolygonEnds = polygonEnds[row];
      if (geometryType === undefined || !rowXs || !rowYs || !rowPartEnds || !rowPolygonEnds) {
        throw new Error(`selected overview LoD \`${lod}\` is null or incomplete at row ${rowStart + row}`);
      }
      rowIndexes.push(row);
      values.push(parseOverviewColumns(
        geometryType,
        rowXs,
        rowYs,
        rowPartEnds,
        rowPolygonEnds,
        lodMetadata,
      ));
    }
    return { rowIndexes, values };
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

  private projectedMetadata(lod: string): FullFileMetadata {
    const cached = this.overviewMetadataCache.get(lod);
    if (cached) {
      this.overviewMetadataCache.delete(lod);
      this.overviewMetadataCache.set(lod, cached);
      return cached;
    }
    const projected = projectOverviewMetadata(this.metadata, lod);
    this.overviewMetadataCache.set(lod, projected);
    if (this.overviewMetadataCache.size > 2) {
      const oldest = this.overviewMetadataCache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.overviewMetadataCache.delete(oldest);
    }
    return projected;
  }

}

function bboxFilter(paths: BboxCovering, bbox: Bbox): ParquetQueryFilter {
  return {
    $and: [
      { [paths.xmin.join('.')]: { $lte: bbox.maxX } },
      { [paths.ymin.join('.')]: { $lte: bbox.maxY } },
      { [paths.xmax.join('.')]: { $gte: bbox.minX } },
      { [paths.ymax.join('.')]: { $gte: bbox.minY } },
    ],
  };
}

function selectedRowIndexes(
  columns: Map<string, unknown[]>,
  rowCount: number,
  paths: BboxCovering | undefined,
  bbox?: Bbox,
): number[] {
  if (!bbox || !paths) return Array.from({ length: rowCount }, (_, row) => row);
  const selected: number[] = [];
  for (let row = 0; row < rowCount; row++) {
    const minX = readColumnNum(columns, row, paths.xmin);
    const minY = readColumnNum(columns, row, paths.ymin);
    const maxX = readColumnNum(columns, row, paths.xmax);
    const maxY = readColumnNum(columns, row, paths.ymax);
    if (minX === undefined || minY === undefined || maxX === undefined || maxY === undefined) {
      continue;
    }
    if (bboxesIntersect({ minX, minY, maxX, maxY }, bbox)) selected.push(row);
  }
  return selected;
}

function readColumnNum(
  columns: Map<string, unknown[]>,
  row: number,
  path: readonly string[],
): number | undefined {
  let value = columns.get(path[0]!)?.[row];
  for (let i = 1; value !== undefined && i < path.length; i++) {
    value = (value as Record<string, unknown>)[path[i]!];
  }
  return value === undefined ? undefined : Number(value);
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

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

// onPage keeps list nesting but does not assemble the surrounding struct. A
// nullable LoD can add singleton wrappers outside the actual leaf list, so
// remove only wrappers whose sole value is itself an array.
function asNumberArray(input: unknown): NumberArray {
  let value = input;
  while (
    Array.isArray(value)
    && value.length === 1
    && (Array.isArray(value[0]) || ArrayBuffer.isView(value[0] as ArrayBufferView))
  ) {
    value = value[0];
  }
  if (!Array.isArray(value) && !ArrayBuffer.isView(value as ArrayBufferView)) {
    throw new Error('overview physical leaf is not an array');
  }
  return value as NumberArray;
}

// Walk a path-in-schema like `['bbox','xmin']` against a hyparquet row object.
// The struct is mandated by COGP and read unconditionally when filtering, so
// every segment is guaranteed to resolve to a number.
function readNum(row: Record<string, unknown>, path: readonly string[]): number {
  let cur: unknown = row;
  for (const p of path) cur = (cur as Record<string, unknown>)[p];
  return cur as number;
}
