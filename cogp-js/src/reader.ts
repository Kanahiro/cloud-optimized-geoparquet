import { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors as defaultCompressors } from 'hyparquet-compressors';
import { Table } from 'apache-arrow';

import {
  type Bbox,
  type BboxColumnIndexes,
  findBboxColumnIndexes,
  type FileMetadataLike,
  rowGroupIntersects,
  type RowGroupLike,
} from './bbox.js';
import { rowGroupPrefixForLod, selectLodByGsd } from './lod.js';
import { type CogpMeta, extractCogpDocument, type GeoMeta } from './meta.js';
import { rowsToArrowTable } from './arrow.js';
import { type FeatureCollection, rowsToFeatureCollection } from './geojson.js';

// Minimal structural view of the metadata object we need; this avoids tight
// coupling to a specific hyparquet major version's exported types.
interface FullFileMetadata extends FileMetadataLike {
  key_value_metadata?: ReadonlyArray<{ key: string; value?: string | null }> | null;
}

// By default hyparquet's geoparquet integration decodes WKB into GeoJSON
// objects. That would (a) defeat the point of returning an Arrow Table with a
// Binary geometry column, and (b) be a large wasted allocation for callers
// that re-encode downstream (MVT, WKB sinks, etc.). We pass through the raw
// bytes so the geometry column stays as Uint8Array, which our Arrow builder
// renders as a Binary vector matching the on-disk schema.
//
// hyparquet expects the `parsers` option to contain *every* parser function:
// when an `options.parsers` is passed it overwrites — not merges with — the
// internal defaults at column-read time. So we replicate the default parser
// set here and swap in pass-through implementations for geometry/geography.
const utf8Decoder = new TextDecoder();
const PASSTHROUGH_PARSERS = {
  timestampFromMilliseconds: (millis: bigint) => new Date(Number(millis)),
  timestampFromMicroseconds: (micros: bigint) => new Date(Number(micros / 1000n)),
  timestampFromNanoseconds: (nanos: bigint) => new Date(Number(nanos / 1000000n)),
  dateFromDays: (days: number) => new Date(days * 86400000),
  stringFromBytes: (bytes: Uint8Array | null | undefined) =>
    bytes ? utf8Decoder.decode(bytes) : bytes,
  geometryFromBytes: (b: Uint8Array) => b,
  geographyFromBytes: (b: Uint8Array) => b,
  uuidFromBytes: (bytes: Uint8Array | null | undefined) => {
    if (!bytes) return undefined;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return (
      hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
      hex.slice(16, 20) + '-' + hex.slice(20, 32)
    );
  },
};

export type BboxInput = Bbox | readonly [number, number, number, number];

export interface OpenOptions {
  fetch?: typeof fetch;
  byteLength?: number;
  /**
   * Override parquet value parsers. By default we keep geometry/geography
   * columns as raw `Uint8Array` (WKB) — overriding `geometryFromBytes` here
   * lets you decode to GeoJSON, Geo-Arrow, etc.
   */
  parsers?: Partial<typeof PASSTHROUGH_PARSERS>;
  /**
   * Custom decompressor map. By default we use `hyparquet-compressors` which
   * ships SNAPPY, GZIP, ZSTD, LZ4, BROTLI. Pass your own to swap in a
   * lighter-weight bundle or to add codecs.
   */
  compressors?: Record<string, (input: Uint8Array, outputLength: number) => Uint8Array>;
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
    const parsers = { ...PASSTHROUGH_PARSERS, ...(opts.parsers ?? {}) };
    const compressors = opts.compressors ?? defaultCompressors;
    const metadata = (await parquetMetadataAsync(file as never, { parsers } as never)) as unknown as FullFileMetadata;
    return new CogpReader(file, metadata, url, parsers, compressors);
  }

  readonly cogp: CogpMeta;
  readonly geo: GeoMeta;
  /** Row group → flat row index of its first row. */
  private readonly rowOffsets: number[];
  /** Column indexes (within a row group's columns list) of covering bbox sub-columns, if available. */
  private readonly bboxColIdx: BboxColumnIndexes | null;

  private constructor(
    private readonly file: unknown,
    readonly metadata: FullFileMetadata,
    readonly url: string,
    private readonly parsers: typeof PASSTHROUGH_PARSERS,
    private readonly compressors: Record<string, (input: Uint8Array, outputLength: number) => Uint8Array>,
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

    const primaryCol = this.geo.columns[this.geo.primary_column];
    const covering = primaryCol?.covering;
    const firstRg = metadata.row_groups[0];
    if (covering && firstRg) {
      try {
        this.bboxColIdx = findBboxColumnIndexes(firstRg, covering.bbox);
      } catch {
        this.bboxColIdx = null;
      }
    } else {
      this.bboxColIdx = null;
    }
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

  /** Read a contiguous LoD prefix, optionally bbox-pruned, as a single Arrow Table. */
  async readTable(opts: ReadOptions = {}): Promise<Table> {
    const rows = await this.readRows(opts);
    return rowsToArrowTable(rows);
  }

  /**
   * Read a contiguous LoD prefix, optionally bbox-pruned, as a GeoJSON
   * FeatureCollection. Faster than `readTable` for map rendering: the
   * geometry column is decoded straight from WKB and other columns flow into
   * `properties` without going through Arrow's type system.
   */
  async readAsGeoJSON(opts: ReadOptions = {}): Promise<FeatureCollection> {
    const rows = await this.readRows(opts);
    return rowsToFeatureCollection(rows, this.geo.primary_column);
  }

  /**
   * Yield an Arrow Table per surviving row group, in coarse-to-fine order.
   * Useful for progressive rendering: the first yield is the coarsest LoD.
   */
  async *stream(opts: ReadOptions = {}): AsyncGenerator<Table> {
    const maxLod = opts.maxLod ?? this.lods.length - 1;
    const bbox = normalizeBbox(opts.bbox);
    const rgs = this.candidateRowGroups(maxLod, bbox);
    for (const rg of rgs) {
      yield rowsToArrowTable(await this.readRowGroupsAsRows([rg], opts.columns));
    }
  }

  /** Bbox of a single row group as derived from covering column statistics. */
  rowGroupEnvelope(rgIndex: number): Bbox | null {
    if (!this.bboxColIdx) return null;
    const rg = this.metadata.row_groups[rgIndex];
    if (!rg) return null;
    return rowGroupEnvelopeFromIdx(rg, this.bboxColIdx);
  }

  private candidateRowGroups(maxLod: number, bbox?: Bbox): number[] {
    const range = rowGroupPrefixForLod(this.lods, maxLod);
    const out: number[] = [];
    for (let i = range.start; i <= range.end; i++) {
      const rg = this.metadata.row_groups[i]!;
      if (bbox && this.bboxColIdx) {
        if (!rowGroupIntersects(rg, this.bboxColIdx, bbox)) continue;
      }
      out.push(i);
    }
    return out;
  }

  /** Read rows for the given options as plain row records (no Arrow). */
  private async readRows(opts: ReadOptions): Promise<Record<string, unknown>[]> {
    const maxLod = opts.maxLod ?? this.lods.length - 1;
    const bbox = normalizeBbox(opts.bbox);
    const rgs = this.candidateRowGroups(maxLod, bbox);
    return this.readRowGroupsAsRows(rgs, opts.columns);
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
        parsers: this.parsers,
        compressors: this.compressors,
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

function rowGroupEnvelopeFromIdx(rg: RowGroupLike, idx: BboxColumnIndexes): Bbox | null {
  const stat = (i: number) => rg.columns[i]?.meta_data?.statistics ?? null;
  const num = (s: unknown, k: 'min' | 'max'): number | null => {
    if (!s || typeof s !== 'object') return null;
    const rec = s as Record<string, unknown>;
    const v = k === 'min' ? (rec['min_value'] ?? rec['min']) : (rec['max_value'] ?? rec['max']);
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return Number(v);
    return null;
  };
  const minX = num(stat(idx.xmin), 'min');
  const minY = num(stat(idx.ymin), 'min');
  const maxX = num(stat(idx.xmax), 'max');
  const maxY = num(stat(idx.ymax), 'max');
  if (minX === null || minY === null || maxX === null || maxY === null) return null;
  return { minX, minY, maxX, maxY };
}

function normalizeBbox(input?: BboxInput): Bbox | undefined {
  if (!input) return undefined;
  if (Array.isArray(input)) {
    return { minX: input[0]!, minY: input[1]!, maxX: input[2]!, maxY: input[3]! };
  }
  return input as Bbox;
}
