import { parquetMetadataAsync, parquetRead } from 'hyparquet';
import { prefetchPageIndexes } from 'hyparquet/src/plan.js';
import type { Compressors, ParquetQueryFilter } from 'hyparquet';
import { compressors as defaultCompressors } from 'hyparquet-compressors';

import {
  type Bbox,
  type BboxColumnIndexes,
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
  parseGeoArrowLeaves,
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

type PageIndexPlan = Awaited<ReturnType<typeof prefetchPageIndexes>>;

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
  /** Coalesce overlapping or adjacent concurrent HTTP ranges; enabled by default. */
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
  /** Prune groups and pages using primary covering statistics; returns spatial candidates. */
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
   * Cap returned candidates, including spatial false positives. A finite cap
   * can omit later matches. Already-dispatched fetches complete, but later
   * runs are skipped.
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
  private readonly overviewColumn: string | undefined;
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
    this.overviewColumn = geo.lod.overviews?.column;
    const hasOverviewsColumn = this.overviewColumn !== undefined && rootColumnNames(metadata.schema).includes(this.overviewColumn);
    if (this.usesOverviews && !hasOverviewsColumn) {
      throw new Error(`cogp file is missing declared overview column: ${this.overviewColumn}`);
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
      const columnValues = values.get(column);
      if (!columnValues || !(0 in columnValues)) throw new Error(`column \`${column}\` is missing row ${rowIndex}`);
      row[column] = columnValues[0];
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
   * (no I/O). Page statistics narrow the remaining candidates without reading
   * covering values. Callers clip or filter candidates for exact spatial results.
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
    // Default bbox reads omit covering attributes; explicit projections remain valid.
    const coveringColumns = new Set(Object.values(this.bboxPaths ?? {}).map(path => path[0]));
    const requested = opts.columns ?? rootColumnNames(this.metadata.schema)
      .filter(column => !bbox || !coveringColumns.has(column));
    const wantsGeometry = opts.columns === undefined
      || opts.columns.includes(this.primaryGeometryColumn)
      || (this.usesOverviews && opts.columns.includes(this.overviewColumn!));
    let columns = requested.filter(
      (column) => (!this.usesOverviews || !this.geomColumns.includes(column))
        && (!this.usesOverviews || column !== this.overviewColumn),
    );
    if (wantsGeometry && this.usesOverviews) columns.push(this.overviewColumn!);
    const out: Record<string, unknown>[] = [];
    // Returns true once a cap has been reached, signalling callers to stop
    // iterating the current row group (and the outer stream) immediately
    // rather than draining the rest of the batch.
    const acceptRow = (row: Record<string, unknown>): boolean => {
      if (wantsGeometry && lodMetadata) {
        const overview = row[this.overviewColumn!] as QuantizedOverviewGeometry | null;
        row[this.primaryGeometryColumn] = opts.overviewDecoder
          ? opts.overviewDecoder(overview)
          : decodeQuantizedOverview(overview);
        delete row[this.overviewColumn!];
      }
      out.push(row);
      if (maxRows !== undefined && out.length >= maxRows) return true;
      return false;
    };
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
      for (const row of batch) {
        if (acceptRow(row)) return out;
      }
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
    throwIfAborted(signal);
    const callerSignal = signal;
    const controller = new AbortController();
    const abort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener('abort', abort, { once: true });
    signal = controller.signal;
    const file = bindAbortSignal(this.file as AsyncBufferLike, signal);
    // Start every run immediately; only consumption follows source order.
    // Settled outcomes handle early failures even while an earlier run is pending.
    const batches = this.coalescedRuns(rgIndices).map(async (run) => {
      throwIfAborted(signal);
      const startRg = run[0]!;
      const endRg = run[run.length - 1]!;
      const rowStart = this.rowOffsets[startRg]!;
      const rowEnd = rowStart + this.sumRowsInRange(startRg, endRg);
      const pagePlan = filter ? await prefetchPageIndexes({
        file: file as never,
        metadata: metadata as never,
        rowStart,
        rowEnd,
        columns,
        filter,
      }) : undefined;
      const rowIndexes: number[] = [];
      for (const group of run) {
        const offset = this.rowOffsets[group]! - rowStart;
        const ranges = pagePlan?.pageRangesByGroup[group]
          ?? [[0, Number(metadata.row_groups[group]!.num_rows)]];
        for (const [start, end] of ranges) {
          for (let row = start; row < end; row++) rowIndexes.push(offset + row);
        }
      }
      const readsOverview = lod !== undefined && lodMetadata !== undefined;
      const objectColumns = readsOverview
        ? columns?.filter((column) => column !== this.overviewColumn)
        : columns;
      const columnsPromise = this.readColumnValues(
        file,
        metadata,
        rowStart,
        rowEnd,
        objectColumns ?? [],
        pagePlan,
      );
      const overviewPromise = readsOverview
        ? this.readOverviewLeaves(
          file,
          metadata,
          rowStart,
          rowEnd,
          lod,
          lodMetadata,
          rowIndexes,
          pagePlan,
        )
        : undefined;
      const [columnValues, overviewSelection] = await Promise.all([
        columnsPromise,
        overviewPromise,
      ]);
      const rows = new Array<Record<string, unknown>>(rowIndexes.length);
      for (let i = 0; i < rowIndexes.length; i++) {
        const localRow = rowIndexes[i]!;
        const row: Record<string, unknown> = {};
        for (const column of objectColumns ?? []) {
          const values = columnValues.get(column);
          if (!values || !(localRow in values)) {
            throw new Error(`column \`${column}\` is missing row ${rowStart + localRow}`);
          }
          row[column] = values[localRow];
        }
        if (overviewSelection) row[this.overviewColumn!] = overviewSelection.values[i]!;
        if (includeRowIndex) {
          Object.defineProperty(row, COGP_ROW_INDEX, { value: rowStart + localRow });
        }
        rows[i] = row;
      }
      throwIfAborted(signal);
      return rows;
    }).map(promise => promise.then(
      rows => ({ rows }),
      error => {
        controller.abort(error);
        return { error };
      },
    ));
    try {
      for (const batch of batches) {
        const result = await batch;
        if ('error' in result) throw result.error;
        throwIfAborted(signal);
        yield result.rows;
      }
    } finally {
      // A row limit, consumer failure, or cancellation also stops pending runs.
      controller.abort();
      callerSignal?.removeEventListener('abort', abort);
    }
  }

  /** Read top-level columns without transposing the whole run into row objects. */
  private async readColumnValues(
    file: AsyncBufferLike,
    metadata: FullFileMetadata,
    rowStart: number,
    rowEnd: number,
    columns: string[],
    pagePlan?: PageIndexPlan,
  ): Promise<Map<string, unknown[]>> {
    const values = new Map<string, unknown[]>();
    if (columns.length === 0) return values;
    const rowCount = rowEnd - rowStart;
    await parquetRead({
      file: file as never,
      metadata: metadata as never,
      rowStart,
      rowEnd,
      columns,
      compressors: this.compressors,
      rowFormat: 'object',
      // Only annotated strings are text; unannotated binary attributes stay bytes.
      utf8: false,
      // The predicate belongs to planning only; passing it here reads bbox values.
      ...pagePlan,
      usePageIndex: false,
      useOffsetIndex: true,
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
    rowIndexes: number[],
    pagePlan?: PageIndexPlan,
  ): Promise<OverviewSelection> {
    const rowCount = rowEnd - rowStart;
    const geometryTypes: Array<number | undefined> = new Array(rowCount);
    const xs: Array<NumberArray | undefined> = new Array(rowCount);
    const ys: Array<NumberArray | undefined> = new Array(rowCount);
    const partEnds: Array<NumberArray | undefined> = new Array(rowCount);
    const polygonEnds: Array<NumberArray | undefined> = new Array(rowCount);

    const assign = <T>(target: Array<T | undefined>, chunk: PageChunk, map: (value: unknown) => T) => {
      for (let i = 0; i < chunk.columnData.length; i++) {
        const localRow = chunk.rowStart + i - rowStart;
        if (localRow >= 0 && localRow < rowCount) {
          target[localRow] = map(chunk.columnData[i]);
        }
      }
    };
    const nested = this.geo.lod.overviews!.encoding === 'quantized_geoarrow';
    const nestedXs: unknown[] = new Array(rowCount);
    const nestedYs: unknown[] = new Array(rowCount);
    const onPage = (chunk: PageChunk) => {
      const path = chunk.pathInSchema;
      if (nested && path[0] === this.overviewColumn && path[1] === lod) {
        if (path.at(-1) === 'x') assign(nestedXs, chunk, value => value);
        if (path.at(-1) === 'y') assign(nestedYs, chunk, value => value);
      } else if (path[0] === this.overviewColumn && path[1] === 'geometry_type') {
        assign(geometryTypes, chunk, Number);
      } else if (path[0] === this.overviewColumn && path[1] === lod && path[2] === 'coordinates') {
        if (path[path.length - 1] === 'x') assign(xs, chunk, asNumberArray);
        if (path[path.length - 1] === 'y') assign(ys, chunk, asNumberArray);
      } else if (path[0] === this.overviewColumn && path[1] === lod && path[2] === 'part_ends') {
        assign(partEnds, chunk, asNumberArray);
      } else if (path[0] === this.overviewColumn && path[1] === lod && path[2] === 'polygon_ends') {
        assign(polygonEnds, chunk, asNumberArray);
      }
    };
    await parquetRead({
      file: file as never,
      metadata: metadata as never,
      rowStart,
      rowEnd,
      columns: [this.overviewColumn!],
      compressors: this.compressors,
      rowFormat: 'object',
      // The predicate belongs to planning only; passing it here reads bbox values.
      ...pagePlan,
      usePageIndex: false,
      useOffsetIndex: true,
      onPage: onPage as never,
    });

    const values: QuantizedOverviewGeometry[] = [];
    for (const row of rowIndexes) {
      if (nested) {
        values.push(parseGeoArrowLeaves(nestedXs[row], nestedYs[row], lodMetadata));
        continue;
      }
      const geometryType = geometryTypes[row];
      const rowXs = xs[row];
      const rowYs = ys[row];
      const rowPartEnds = partEnds[row];
      const rowPolygonEnds = polygonEnds[row];
      if (geometryType === undefined || !rowXs || !rowYs || !rowPartEnds || !rowPolygonEnds) {
        throw new Error(`selected overview LoD \`${lod}\` is null or incomplete at row ${rowStart + row}`);
      }
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
    const projected = projectOverviewMetadata(this.metadata, lod, this.overviewColumn!, this.geo.lod.overviews!.encoding);
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

/**
 * Locate physical WKB chunks once, from the footer, and turn them into hard
 * transport barriers. Projection keeps them out of the Parquet plan; these
 * barriers also reject accidental direct reads of primary WKB.
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
