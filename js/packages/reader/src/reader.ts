import { cachedRangeBuffer, type RangeCacheOptions } from './range-cache.js';
import { PageIndexCache, type PageIndexCacheOptions, type PageIndexPlan } from './page-index-cache.js';
import { parquetMetadataAsync, parquetRead } from '../vendor/hyparquet/src/index.js';
import type { Compressors, ParquetColumnLeaf, ParquetColumnView, ParquetQueryFilter } from '../vendor/hyparquet/src/index.js';
import { getMaxDefinitionLevel } from '../vendor/hyparquet/src/schema.js';
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
  protectedAsyncBuffer,
} from './coalescing-buffer.js';
import {
  appendGeoArrowLeaves,
  appendWkb,
  geoArrowLayout,
  GeometryBuilder,
  type GeometryColumn,
  type LevelLeaf,
} from './geometry.js';
import { selectLevelByResolution } from './level.js';
import {
  type BboxCovering,
  extractGeoMeta,
  lodForLevel,
  supportedOverviews,
  type SupportedOverviewsMetadata,
  type GeoMeta,
  type LodMeta,
  type OverviewLod,
} from './meta.js';
import {
  projectOverviewMetadata,
  rootColumnNames,
  validateOverviewSchema,
  type OverviewFileMetadata,
} from './overview.js';
import { bindAbortSignal, throwIfAborted } from './abort.js';
import { abortableAsyncBufferFromUrl } from './http-buffer.js';

// Minimal structural view of the metadata object we need; this avoids tight
// coupling to a specific hyparquet major version's exported types.
interface FullFileMetadata extends OverviewFileMetadata {
  key_value_metadata?: ReadonlyArray<{ key: string; value?: string | null }> | null;
}

// Keep WKB as bytes; `read()` parses the primary column into its GeometryColumn.
const GEOMETRY_PARSERS = {
  geometryFromBytes: (bytes: Uint8Array) => bytes,
  geographyFromBytes: (bytes: Uint8Array) => bytes,
};

interface ColumnChunk {
  columnName: string;
  columnData: ArrayLike<unknown>;
  rowStart: number;
  rowEnd: number;
}

type Chunk = Pick<ColumnChunk, 'columnData' | 'rowStart'>;

/** One run's selected local rows, known before geometry or attribute I/O. */
interface RunPlan {
  groups: number[];
  rowStart: number;
  rowEnd: number;
  rows: number[];
  pagePlan?: PageIndexPlan;
}

/** One decoded run: selected local rows plus undecoded-by-row column chunks. */
interface RunData {
  rowStart: number;
  rows: number[];
  chunks: Map<string, Chunk[]>;
  /** Appends overview geometry for `rows[0..count)` in order. */
  appendOverview?: (builder: GeometryBuilder, count: number) => void;
}

/**
 * Columnar result of `read()`. Every array has one entry per selected row, in
 * source order; no per-row object is created.
 */
export interface CogpBatch {
  readonly length: number;
  /** Zero-based source row of each result row. */
  readonly rowIndex: Float64Array;
  /** Requested non-geometry columns; typed arrays where hyparquet decodes them. */
  readonly columns: Readonly<Record<string, ArrayLike<unknown>>>;
  /** Primary geometry, or the selected overview with `useOverview`; absent when not requested. */
  readonly geometry?: GeometryColumn;
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
  /** Reader-local parsed Page Index cache; enabled by default with a 64 MiB budget. */
  pageIndexCache?: PageIndexCacheOptions | false;
  /** Reader-local compressed range cache; 32 MiB by default. Set false to disable. */
  rangeCache?: RangeCacheOptions | false;
  /** Override individual Parquet compression codecs. */
  compressors?: Compressors;
}

// Cap on cumulative `num_rows` packed into a single coalesced fetch. Columns
// are retained until the run's surviving rows are assembled, so peak in-flight
// memory still scales with this value.
const RUN_MAX_ROWS = 50_000;

export interface ReadOptions {
  /** Inclusive level index; defaults to the finest level (all row groups). */
  maxLevel?: number;
  /**
   * Return rows whose primary bbox covering intersects this bbox. Row groups
   * and pages are pruned by statistics, then covering values select the rows
   * before geometry and attributes are fetched. Rows with missing or invalid
   * covering values are kept; without covering, all candidates are returned.
   */
  bbox?: BboxInput;
  /**
   * Columns to read. The default is every attribute plus the primary geometry;
   * other geometry columns, the overview column and bbox covering are only
   * read when named. Naming the primary or overview column fills `geometry`.
   */
  columns?: string[];
  /**
   * Read the selected level's quantized overview instead of primary WKB.
   * Falls back to WKB when the file declares no overviews, and throws when it
   * declares an encoding this reader cannot decode (see `hasOverviews`).
   * Geometry is returned in `CogpBatch.geometry` either way.
   */
  useOverview?: boolean;
  /**
   * Return at most this many rows, in source order (coarse levels first). A
   * finite cap can omit later matches. Runs are planned concurrently, and only
   * the pages holding the first `maxRows` selected rows are fetched.
   */
  maxRows?: number;
  /** Abort pending Range requests and stop before decoding further runs. */
  signal?: AbortSignal;
}

export class CogpReader {
  static async open(url: string, opts: OpenOptions = {}): Promise<CogpReader> {
    // Browser HTTP caches handle many 206 responses poorly. Bypass them and
    // keep reuse in the reader-local caches.
    const source = await abortableAsyncBufferFromUrl(url, opts);
    // Fetch exactly the 8-byte trailer first, then exactly the declared
    // metadata. hyparquet's 512 KiB default tail prefetch can otherwise absorb
    // the final WKB page even when only overviews are rendered.
    const metadata = (await parquetMetadataAsync(bindAbortSignal(source, opts.signal) as never, {
      initialFetchSize: 8,
    })) as unknown as FullFileMetadata;
    const file = opts.rangeCoalescing === false ? source : coalescingAsyncBuffer(source);
    return new CogpReader(file, metadata, url, opts.compressors, opts.pageIndexCache, opts.rangeCache);
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
    opts: Pick<OpenOptions, 'compressors' | 'pageIndexCache' | 'rangeCache'> = {},
  ): Promise<CogpReader> {
    const metadata = (await parquetMetadataAsync(file as never, {
      initialFetchSize: 8,
    })) as unknown as FullFileMetadata;
    return new CogpReader(file, metadata, url, opts.compressors, opts.pageIndexCache, opts.rangeCache);
  }

  readonly geo: GeoMeta & { lod: LodMeta };
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
  private readonly overviews: SupportedOverviewsMetadata | undefined;
  private readonly overviewColumn: string | undefined;
  /** Codec table is resolved once so every page read shares initialized decoders. */
  private readonly compressors: Compressors;
  private readonly pageIndexCache: PageIndexCache;
  /** Two adjacent zoom levels cover normal pan/zoom without retaining every projection. */
  private readonly overviewMetadataCache = new Map<string, FullFileMetadata>();

  private readonly file: AsyncBufferLike;
  /** Rejects primary WKB ranges so overview reads cannot fetch them by accident. */
  private readonly overviewFile: AsyncBufferLike;

  private constructor(
    file: unknown,
    readonly metadata: FullFileMetadata,
    readonly url: string,
    compressors?: Compressors,
    pageIndexCache?: PageIndexCacheOptions | false,
    rangeCache?: RangeCacheOptions | false,
  ) {
    this.pageIndexCache = new PageIndexCache(file as AsyncBufferLike, metadata as never, pageIndexCache);
    this.file = cachedRangeBuffer(file as AsyncBufferLike, rangeCache);
    const geo = extractGeoMeta(metadata.key_value_metadata, metadata.row_groups.length);
    this.geo = geo;
    this.compressors = { ...defaultCompressors, ...compressors };
    this.overviews = supportedOverviews(geo.lod.overviews);
    this.usesOverviews = this.overviews !== undefined;
    this.overviewColumn = geo.lod.overviews?.column;
    const hasOverviewsColumn = this.overviewColumn !== undefined && rootColumnNames(metadata.schema).includes(this.overviewColumn);
    if (geo.lod.overviews && !hasOverviewsColumn) {
      throw new Error(`file is missing declared overview column \`${this.overviewColumn}\``);
    }
    if (this.overviews) validateOverviewSchema(metadata.schema, this.overviews);

    const offsets: number[] = [];
    let acc = 0;
    for (const rg of metadata.row_groups) {
      offsets.push(acc);
      acc += Number(rg.num_rows ?? 0);
    }
    this.rowOffsets = offsets;
    this.rowCount = acc;
    if (acc === 0) throw new Error('empty files must omit geo.lod');

    // A bbox covering is optional. Without it, or without a primary entry in
    // `geo.columns`, bbox reads return every candidate row.
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
    this.overviewFile = this.usesOverviews
      ? protectedAsyncBuffer(this.file, wkbColumnRanges(metadata, geo))
      : this.file;
  }

  /** Whether the file declares overviews in an encoding this reader can decode. */
  get hasOverviews(): boolean {
    return this.usesOverviews;
  }

  get levels() {
    return this.geo.lod.levels;
  }

  /** Size of the source file in bytes. */
  get byteLength(): number {
    return this.file.byteLength;
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

  /** Read selected top-level columns for one absolute source row as a one-row batch. */
  async readRow(
    rowIndex: number,
    opts: Pick<ReadOptions, 'columns' | 'signal'> = {},
  ): Promise<CogpBatch> {
    if (!Number.isSafeInteger(rowIndex) || rowIndex < 0 || rowIndex >= this.rowCount) {
      throw new Error(`rowIndex ${rowIndex} out of range [0, ${this.rowCount})`);
    }
    throwIfAborted(opts.signal);
    const columns = [...(opts.columns ?? [...this.defaultColumns(), this.primaryGeometryColumn])];
    const chunks = await this.readColumnChunks(
      bindAbortSignal(this.file, opts.signal), this.metadata, rowIndex, rowIndex + 1, columns);
    throwIfAborted(opts.signal);
    const run: RunData = { rowStart: rowIndex, rows: [0], chunks };
    const attributes = columns.filter(column => column !== this.primaryGeometryColumn);
    const builder = columns.includes(this.primaryGeometryColumn) ? new GeometryBuilder(false) : undefined;
    return this.batch([run], attributes, builder, false, undefined);
  }

  /**
   * Read a contiguous level prefix, optionally bbox-pruned, as a columnar
   * `CogpBatch`. Geometry is parsed primary WKB, or with `useOverview` the
   * selected quantized overview; convert it with `toGeoJSON` or `toMvt`.
   *
   * Row groups whose covering envelope misses the query are skipped entirely
   * (no I/O). Page statistics narrow the remaining candidates without reading
   * covering values. Callers clip or filter candidates for exact spatial results.
   */
  async read(opts: ReadOptions = {}): Promise<CogpBatch> {
    throwIfAborted(opts.signal);
    const maxLevel = opts.maxLevel ?? this.levels.length - 1;
    const level = this.levels[maxLevel];
    if (!level) throw new Error(`maxLevel ${maxLevel} out of range [0, ${this.levels.length})`);
    if (opts.useOverview && this.geo.lod.overviews && !this.usesOverviews) {
      throw new Error(`unsupported overview encoding \`${this.geo.lod.overviews.encoding}\`; read without useOverview`);
    }
    const useOverview = (opts.useOverview ?? false) && this.usesOverviews;
    const lod = lodForLevel(this.geo.lod, maxLevel);
    const lodMetadata = useOverview
      ? this.overviews!.lods[lod!]!
      : undefined;
    const projectedMetadata = useOverview
      ? this.projectedMetadata(lod!)
      : this.metadata;
    const bbox = normalizeBbox(opts.bbox);
    const rgs = this.candidateRowGroups(maxLevel, bbox);
    const maxRows = opts.maxRows;
    if (maxRows !== undefined && (!Number.isSafeInteger(maxRows) || maxRows < 0)) {
      throw new Error('maxRows must be a non-negative safe integer');
    }
    const requested = opts.columns ?? this.defaultColumns();
    // Primary and supported overview columns both request "the geometry".
    const wantsGeometry = opts.columns === undefined
      || opts.columns.includes(this.primaryGeometryColumn)
      || (this.usesOverviews && opts.columns.includes(this.overviewColumn!));
    const attributes = requested.filter(
      (column) => column !== this.primaryGeometryColumn
        && (!this.usesOverviews || column !== this.overviewColumn)
        && (!useOverview || !this.geomColumns.includes(column)),
    );
    const columns = wantsGeometry
      ? [...attributes, useOverview ? this.overviewColumn! : this.primaryGeometryColumn]
      : attributes;
    const builder = wantsGeometry ? new GeometryBuilder(useOverview) : undefined;
    const runs = maxRows === 0 ? [] : await this.readRuns(
      useOverview ? this.overviewFile : this.file,
      rgs,
      columns,
      projectedMetadata,
      maxRows,
      bbox,
      wantsGeometry ? lod : undefined,
      wantsGeometry ? lodMetadata : undefined,
      opts.signal,
    );
    throwIfAborted(opts.signal);
    return this.batch(runs, attributes, builder, useOverview, undefined, lodMetadata);
  }

  /** Gather the selected rows of every run into contiguous output columns. */
  private batch(runs: RunData[], attributes: string[], builder: GeometryBuilder | undefined,
    useOverview: boolean, maxRows: number | undefined, lodMetadata?: OverviewLod): CogpBatch {
    const counts = runs.map(run => run.rows.length);
    let length = 0;
    for (let i = 0; i < counts.length; i++) {
      if (maxRows !== undefined) counts[i] = Math.min(counts[i]!, maxRows - length);
      length += counts[i]!;
    }
    const rowIndex = new Float64Array(length);
    let at = 0;
    runs.forEach((run, i) => {
      for (let k = 0; k < counts[i]!; k++) rowIndex[at++] = run.rowStart + run.rows[k]!;
    });
    const columns: Record<string, ArrayLike<unknown>> = {};
    for (const column of attributes) {
      const Typed = typedConstructor(runs.flatMap(run => run.chunks.get(column) ?? []));
      const out = Typed ? new Typed(length) : new Array<unknown>(length);
      let offset = 0;
      runs.forEach((run, i) => {
        forEachSelected(run, column, counts[i]!, (value, k) => { out[offset + k] = value; });
        offset += counts[i]!;
      });
      columns[column] = out;
    }
    let geometry: GeometryColumn | undefined;
    if (builder) {
      runs.forEach((run, i) => {
        if (useOverview) run.appendOverview!(builder, counts[i]!);
        else forEachSelected(run, this.primaryGeometryColumn, counts[i]!, value => appendWkb(builder, value as Uint8Array | null));
      });
      geometry = useOverview ? builder.finish(lodMetadata!.scale, lodMetadata!.offset) : builder.finish();
    }
    return geometry ? { length, rowIndex, columns, geometry } : { length, rowIndex, columns };
  }

  /**
   * Default attribute projection: every root column except geometry columns,
   * the overview column and bbox covering roots. They remain readable by name.
   */
  private defaultColumns(): string[] {
    const excluded = new Set<string>(Object.keys(this.geo.columns));
    if (this.overviewColumn !== undefined) excluded.add(this.overviewColumn);
    for (const path of Object.values(this.bboxPaths ?? {})) excluded.add(path[0]!);
    return this.columnNames.filter(column => !excluded.has(column));
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
   * Read consecutive row-group runs in three concurrent phases. Planning reads
   * Page Indexes and bbox covering values for every run, which yields each
   * run's exact selected rows before any geometry or attribute I/O. The source
   * order prefix covering `maxRows` is then chosen, its last run truncated to
   * the rows needed, and every chosen run's data is fetched concurrently.
   * Runs target `RUN_MAX_ROWS`, not a total memory limit. Parsed Page Indexes
   * and compressed ranges may be reused; column data is decoded for each query.
   */
  private async readRuns(
    source: AsyncBufferLike,
    rgIndices: number[],
    columns: string[],
    metadata: FullFileMetadata,
    maxRows: number | undefined,
    bbox?: Bbox,
    lod?: string,
    lodMetadata?: OverviewLod,
    signal?: AbortSignal,
  ): Promise<RunData[]> {
    if (rgIndices.length === 0) return [];
    throwIfAborted(signal);
    const callerSignal = signal;
    const controller = new AbortController();
    const abort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener('abort', abort, { once: true });
    signal = controller.signal;
    const file = bindAbortSignal(source, signal);
    // One failure cancels every sibling request instead of waiting for them.
    const all = <T>(tasks: Promise<T>[]): Promise<T[]> => Promise.all(tasks.map(task => task.catch((error: unknown) => {
      controller.abort(error);
      throw error;
    })));
    try {
      const plans = await all(this.coalescedRuns(rgIndices)
        .map(groups => this.planRun(file, metadata, groups, columns, bbox, signal)));
      throwIfAborted(signal);
      const selected: RunPlan[] = [];
      let remaining = maxRows ?? Infinity;
      for (const plan of plans) {
        if (remaining <= 0) break;
        const truncated = this.truncatePlan(plan, remaining);
        if (truncated.rows.length === 0) continue;
        selected.push(truncated);
        remaining -= truncated.rows.length;
      }
      const readsOverview = lod !== undefined && lodMetadata !== undefined;
      const chunkColumns = readsOverview ? columns.filter(column => column !== this.overviewColumn) : columns;
      return await all(selected.map(async (plan): Promise<RunData> => {
        const [chunks, appendOverview] = await Promise.all([
          this.readColumnChunks(file, metadata, plan.rowStart, plan.rowEnd, chunkColumns, plan.pagePlan),
          readsOverview ? this.readGeoArrowLeaves(file, metadata, plan.rowStart, plan.rowEnd, lod,
            lodMetadata, plan.rows, plan.pagePlan) : undefined,
        ]);
        throwIfAborted(signal);
        const data: RunData = { rowStart: plan.rowStart, rows: plan.rows, chunks };
        if (appendOverview) data.appendOverview = appendOverview;
        return data;
      }));
    } finally {
      controller.abort();
      callerSignal?.removeEventListener('abort', abort);
    }
  }

  /** Select one run's rows from Page Index statistics, then from covering values. */
  private async planRun(file: AsyncBufferLike, metadata: FullFileMetadata, groups: number[],
    columns: string[], bbox: Bbox | undefined, signal: AbortSignal): Promise<RunPlan> {
    throwIfAborted(signal);
    const rowStart = this.rowOffsets[groups[0]!]!;
    const rowEnd = rowStart + this.sumRowsInRange(groups[0]!, groups[groups.length - 1]!);
    let pagePlan: PageIndexPlan | undefined;
    if (bbox && this.bboxPaths) {
      pagePlan = await this.pageIndexCache.plan(
        metadata as never, groups, columns, Object.values(this.bboxPaths).map(path => path.join('.')),
        bboxFilter(this.bboxPaths, bbox), signal,
      );
      // Page statistics alone leave most candidates outside small bboxes.
      await this.refineBboxPlan(file, metadata, groups, rowStart, rowEnd, bbox, this.bboxPaths, pagePlan);
    }
    const rows: number[] = [];
    for (const group of groups) {
      const offset = this.rowOffsets[group]! - rowStart;
      const ranges = pagePlan?.pageRangesByGroup[group] ?? [[0, Number(metadata.row_groups[group]!.num_rows)]];
      for (const [start, end] of ranges) {
        for (let row = start; row < end; row++) rows.push(offset + row);
      }
    }
    const plan: RunPlan = { groups, rowStart, rowEnd, rows };
    if (pagePlan) plan.pagePlan = pagePlan;
    return plan;
  }

  /** Keep a run's first `count` selected rows and stop its reads after the last one. */
  private truncatePlan(plan: RunPlan, count: number): RunPlan {
    if (count >= plan.rows.length) return plan;
    const rows = plan.rows.slice(0, count);
    const rowEnd = plan.rowStart + rows[rows.length - 1]! + 1;
    const groups = plan.groups.filter(group => this.rowOffsets[group]! < rowEnd);
    const truncated: RunPlan = { groups, rowStart: plan.rowStart, rowEnd, rows };
    if (plan.pagePlan) {
      // Rebuild page ranges from the kept rows so later pages are not fetched.
      const pageRangesByGroup = plan.pagePlan.pageRangesByGroup.map(() => [] as [number, number][]);
      let g = 0;
      for (const local of rows) {
        const absolute = plan.rowStart + local;
        // Rows are sorted, so the owning group only moves forward.
        while (g + 1 < groups.length && this.rowOffsets[groups[g + 1]!]! <= absolute) g++;
        const group = groups[g]!;
        const row = absolute - this.rowOffsets[group]!;
        const ranges = pageRangesByGroup[group]!;
        const previous = ranges[ranges.length - 1];
        if (previous?.[1] === row) previous[1]++;
        else ranges.push([row, row + 1]);
      }
      truncated.pagePlan = { ...plan.pagePlan, pageRangesByGroup };
    }
    return truncated;
  }

  private async refineBboxPlan(
    file: AsyncBufferLike, metadata: FullFileMetadata, run: number[],
    rowStart: number, rowEnd: number, bbox: Bbox, paths: BboxCovering, pagePlan: PageIndexPlan,
  ): Promise<void> {
    // Statistics describe whole pages. A small viewport can intersect a
    // page envelope without intersecting any of its features.
    const roots = [...new Set(Object.values(paths).map(path => path[0]!))];
    const bounds = denseColumns(await this.readColumnChunks(file, metadata, rowStart, rowEnd, roots, pagePlan),
      rowStart, rowEnd - rowStart);
    const value = (path: string[], row: number): unknown => {
      let result: unknown = bounds.get(path[0]!)?.[row];
      for (const key of path.slice(1)) result = (result as Record<string, unknown> | null)?.[key];
      return result;
    };
    for (const group of run) {
      const offset = this.rowOffsets[group]! - rowStart;
      const candidates = pagePlan.pageRangesByGroup[group]
        ?? [[0, Number(metadata.row_groups[group]!.num_rows)]];
      const ranges: [number, number][] = [];
      for (const [start, end] of candidates) for (let row = start; row < end; row++) {
        const b = paths;
        const coords = [b.xmin, b.ymin, b.xmax, b.ymax].map(path => value(path, offset + row));
        // Missing/invalid bounds cannot safely exclude a feature.
        if (coords.every(v => typeof v === 'number' && Number.isFinite(v))) {
          const [minX, minY, maxX, maxY] = coords as number[];
          if (minX! > bbox.maxX || minY! > bbox.maxY || maxX! < bbox.minX || maxY! < bbox.minY) continue;
        }
        const previous = ranges[ranges.length - 1];
        if (previous?.[1] === row) previous[1]++;
        else ranges.push([row, row + 1]);
      }
      pagePlan.pageRangesByGroup[group] = ranges;
    }
  }

  /** Collect decoded column chunks without transposing them into rows. */
  private async readColumnChunks(
    file: AsyncBufferLike,
    metadata: FullFileMetadata,
    rowStart: number,
    rowEnd: number,
    columns: string[],
    pagePlan?: PageIndexPlan,
  ): Promise<Map<string, Chunk[]>> {
    const chunks = new Map<string, Chunk[]>();
    if (columns.length === 0) return chunks;
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
      parsers: GEOMETRY_PARSERS,
      // The predicate belongs to planning only; passing it here reads bbox values.
      ...pagePlan,
      usePageIndex: false,
      useOffsetIndex: true,
      onChunk: ((chunk: ColumnChunk) => {
        let list = chunks.get(chunk.columnName);
        if (!list) chunks.set(chunk.columnName, list = []);
        list.push({ columnData: chunk.columnData, rowStart: chunk.rowStart });
      }) as never,
    });
    for (const list of chunks.values()) list.sort((a, b) => a.rowStart - b.rowStart);
    return chunks;
  }

  /**
   * Keep `quantized_geoarrow` x and y leaves as hyparquet column views and
   * walk their repetition levels at append time. No per-row, per-part or
   * per-ring JavaScript list is created.
   */
  private async readGeoArrowLeaves(
    file: AsyncBufferLike,
    metadata: FullFileMetadata,
    rowStart: number,
    rowEnd: number,
    lod: string,
    lodMetadata: OverviewLod,
    rowIndexes: number[],
    pagePlan?: PageIndexPlan,
  ): Promise<(builder: GeometryBuilder, count: number) => void> {
    const { type, depth } = geoArrowLayout(lodMetadata.geometry_type);
    const views: Array<{ rowStart: number; rowEnd: number; x: LevelLeaf; y: LevelLeaf; maxDefinitionLevel: number }> = [];
    const onColumnView = ({ view }: { view: ParquetColumnView }) => {
      let x: ParquetColumnLeaf | undefined;
      let y: ParquetColumnLeaf | undefined;
      for (const leaf of view.leaves) {
        if (leaf.pathInSchema[1] !== lod) continue;
        if (leaf.pathInSchema.at(-1) === 'x') x = leaf;
        else if (leaf.pathInSchema.at(-1) === 'y') y = leaf;
      }
      // The physical schema was validated when the reader was opened.
      if (!x || !y) throw new Error(`selected overview LoD \`${lod}\` has no x/y leaves`);
      const maxDefinitionLevel = getMaxDefinitionLevel(x.schemaPath);
      if (maxDefinitionLevel !== getMaxDefinitionLevel(y.schemaPath)) {
        throw new Error('quantized_geoarrow overview has mismatched XY topology');
      }
      views.push({ rowStart: view.rowStart, rowEnd: view.rowEnd, x, y, maxDefinitionLevel });
    };
    await parquetRead({
      file: file as never,
      metadata: metadata as never,
      rowStart,
      rowEnd,
      columns: [this.overviewColumn!],
      compressors: this.compressors,
      // The predicate belongs to planning only; passing it here reads bbox values.
      ...pagePlan,
      usePageIndex: false,
      useOffsetIndex: true,
      onColumnView,
    });
    views.sort((a, b) => a.rowStart - b.rowStart);

    return (builder, count) => {
      // Selected rows are sorted, so the owning view only moves forward.
      let v = 0;
      for (let k = 0; k < count; k++) {
        const row = rowStart + rowIndexes[k]!;
        while (v < views.length && views[v]!.rowEnd <= row) v++;
        const view = views[v];
        if (!view || view.rowStart > row) {
          throw new Error(`selected overview LoD \`${lod}\` is missing row ${row}`);
        }
        appendGeoArrowLeaves(builder, type, depth, view.x, view.y, view.maxDefinitionLevel, row);
      }
    };
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
    const projected = projectOverviewMetadata(this.metadata, lod, this.overviewColumn!);
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

type TypedArrayConstructor = new (length: number) => { [index: number]: unknown; length: number };

/** The shared typed-array constructor of every chunk, or undefined for plain arrays. */
function typedConstructor(chunks: Chunk[]): TypedArrayConstructor | undefined {
  let constructor: TypedArrayConstructor | undefined;
  for (const { columnData } of chunks) {
    if (!ArrayBuffer.isView(columnData) || columnData instanceof DataView) return undefined;
    const current = columnData.constructor as TypedArrayConstructor;
    if (constructor && constructor !== current) return undefined;
    constructor = current;
  }
  return constructor;
}

/** Visit `rows[0..count)` of one column in order, walking its sorted chunks once. */
function forEachSelected(run: RunData, column: string, count: number,
  visit: (value: unknown, index: number) => void): void {
  const chunks = run.chunks.get(column) ?? [];
  let c = 0;
  for (let k = 0; k < count; k++) {
    const row = run.rowStart + run.rows[k]!;
    while (c < chunks.length && chunks[c]!.rowStart + chunks[c]!.columnData.length <= row) c++;
    const chunk = chunks[c];
    if (!chunk || chunk.rowStart > row) throw new Error(`column \`${column}\` is missing row ${row}`);
    visit(chunk.columnData[row - chunk.rowStart], k);
  }
}

/** Dense per-run arrays for filtering helpers that index rows directly. */
function denseColumns(chunks: Map<string, Chunk[]>, rowStart: number, rowCount: number): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  for (const [column, list] of chunks) {
    const target = new Array<unknown>(rowCount);
    for (const chunk of list) {
      for (let i = 0; i < chunk.columnData.length; i++) {
        const localRow = chunk.rowStart + i - rowStart;
        if (localRow >= 0 && localRow < rowCount) target[localRow] = chunk.columnData[i];
      }
    }
    out.set(column, target);
  }
  return out;
}
