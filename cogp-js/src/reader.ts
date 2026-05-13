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
}

export interface ReadOptions {
  /** Inclusive LoD index; defaults to the finest LoD (all row groups). */
  maxLod?: number;
  /** Spatial filter; row groups whose covering envelope misses this bbox are skipped. */
  bbox?: BboxInput;
  /** Subset of columns to materialize. */
  columns?: string[];
}

export class CogpReader {
  static async open(url: string, opts: OpenOptions = {}): Promise<CogpReader> {
    const fetchOpts: Record<string, unknown> = { url };
    if (opts.fetch) fetchOpts['fetch'] = opts.fetch;
    if (opts.byteLength !== undefined) fetchOpts['byteLength'] = opts.byteLength;
    const file = await asyncBufferFromUrl(fetchOpts as { url: string });
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
    const rgs = this.candidateRowGroups(maxLod, bbox);
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

  private candidateRowGroups(maxLod: number, bbox?: Bbox): number[] {
    if (maxLod < 0 || maxLod >= this.lods.length) {
      throw new Error(`maxLod ${maxLod} out of range [0, ${this.lods.length})`);
    }
    const end = this.lods[maxLod]!.row_group_end;
    const out: number[] = [];
    for (let i = 0; i <= end; i++) {
      const rg = this.metadata.row_groups[i]!;
      if (bbox && !rowGroupIntersects(rg, this.bboxColIdx, bbox)) continue;
      out.push(i);
    }
    return out;
  }

  private async readRowGroupsAsRows(
    rgIndices: number[],
    columns: string[] | undefined,
  ): Promise<Record<string, unknown>[]> {
    if (rgIndices.length === 0) return [];

    const allRows: Record<string, unknown>[] = [];
    // Coalesce runs of consecutive row group indices into single reads so
    // hyparquet can fetch their column chunks together.
    let i = 0;
    while (i < rgIndices.length) {
      let j = i;
      while (j + 1 < rgIndices.length && rgIndices[j + 1]! === rgIndices[j]! + 1) j++;
      const startRg = rgIndices[i]!;
      const endRg = rgIndices[j]!;
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
      const rows = (await parquetReadObjects(readArgs as never)) as Record<string, unknown>[];
      for (const r of rows) allRows.push(r);
      i = j + 1;
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
