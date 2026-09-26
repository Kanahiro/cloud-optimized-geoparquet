import type { ColumnIndex, FileMetaData, OffsetIndex, ParquetQueryFilter, SchemaElement, SchemaTree } from '../vendor/hyparquet/src/index.js';
import { parquetSchema } from '../vendor/hyparquet/src/metadata.js';
import { readColumnIndex, readOffsetIndex } from '../vendor/hyparquet/src/indexes.js';
import { filterPageRanges } from '../vendor/hyparquet/src/filter.js';
import type { prefetchPageIndexes } from '../vendor/hyparquet/src/plan.js';
import { throwIfAborted } from './abort.js';
import { SharedLru } from './shared-lru.js';
import type { AsyncBufferLike } from './coalescing-buffer.js';

export interface PageIndexCacheOptions {
  /** Estimated retained parsed-index bytes per reader. Defaults to 64 MiB. */
  maxBytes?: number;
}

export type PageIndexPlan = Awaited<ReturnType<typeof prefetchPageIndexes>>;
type Index = ColumnIndex | OffsetIndex;

/** Retain physical indexes, never query-dependent row selections or decoded data.
 * Offsets identify indexes across projections and LoDs within this one reader. */
export class PageIndexCache {
  private readonly cache: SharedLru<Index>;
  private readonly elements = new Map<string, SchemaElement>();

  constructor(private readonly file: AsyncBufferLike, metadata: FileMetaData, options: PageIndexCacheOptions | false = {}) {
    const maxBytes = options === false ? 0 : options.maxBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('page index maxBytes must be a non-negative safe integer');
    this.cache = new SharedLru(maxBytes);
    const visit = (node: SchemaTree): void => {
      if (node.children.length) node.children.forEach(visit);
      else this.elements.set(node.path.join('.'), node.element);
    };
    visit(parquetSchema(metadata));
  }

  async plan(metadata: FileMetaData, groups: number[], columns: string[] | undefined,
    filterPaths: string[], filter: ParquetQueryFilter, signal?: AbortSignal): Promise<PageIndexPlan> {
    throwIfAborted(signal);
    const pageRangesByGroup: PageIndexPlan['pageRangesByGroup'] = metadata.row_groups.map(() => undefined);
    const pageLocationsByGroup: PageIndexPlan['pageLocationsByGroup'] = metadata.row_groups.map(() => ({}));
    await Promise.all(groups.map(async group => {
      const rg = metadata.row_groups[group]!;
      const columnPages: Parameters<typeof filterPageRanges>[1] = {};
      const filterChunks = rg.columns.filter(c => {
        const path = c.meta_data?.path_in_schema.join('.');
        return path && filterPaths.includes(path) && this.elements.has(path)
          && c.column_index_offset && c.column_index_length && c.offset_index_offset && c.offset_index_length;
      });
      // Without bbox indexes leave the group's full candidate range intact.
      if (!filterChunks.length) return;
      const selected = rg.columns.filter(c => filterChunks.includes(c)
        || (c.meta_data && (!columns || columns.includes(c.meta_data.path_in_schema[0]!))));
      await Promise.all(selected.map(async chunk => {
        if (!chunk.offset_index_offset || !chunk.offset_index_length) return;
        const path = chunk.meta_data!.path_in_schema.join('.');
        const element = this.elements.get(path)!;
        const [offset, column] = await Promise.all([
          this.read('offset', Number(chunk.offset_index_offset), chunk.offset_index_length, undefined, signal) as Promise<OffsetIndex>,
          filterChunks.includes(chunk)
            ? this.read('column', Number(chunk.column_index_offset), chunk.column_index_length!, element, signal) as Promise<ColumnIndex>
            : undefined,
        ]);
        pageLocationsByGroup[group]![path] = offset.page_locations;
        if (column) columnPages[path] = {
          minValues: column.min_values, maxValues: column.max_values,
          nullPages: column.null_pages, nullCounts: column.null_counts,
          pageStarts: offset.page_locations.map(p => Number(p.first_row_index)), element,
        };
      }));
      // Re-evaluate for every bbox, even when all indexes were cache hits.
      pageRangesByGroup[group] = filterPageRanges(filter, columnPages, Number(rg.num_rows));
    }));
    throwIfAborted(signal);
    return { pageRangesByGroup, pageLocationsByGroup };
  }

  private read(kind: 'column' | 'offset', start: number, length: number,
    element: SchemaElement | undefined, signal?: AbortSignal): Promise<Index> {
    throwIfAborted(signal);
    const key = `${kind}:${start}:${length}`;
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    return this.cache.load(key, async controllerSignal => {
      const buffer = await this.file.slice(start, start + length, controllerSignal);
      throwIfAborted(controllerSignal);
      const reader = { view: new DataView(buffer), offset: 0 };
      const value = kind === 'column' ? readColumnIndex(reader, element!) : readOffsetIndex(reader);
      return { value, bytes: estimatedBytes(value) + 128 + key.length * 2 };
    }, signal);
  }
}

/** Budget parsed objects rather than compressed/wire bytes. This is an estimate
 * of retained memory; active query plans and transient buffers are not bounded. */
function estimatedBytes(value: unknown): number {
  if (typeof value === 'string') return 32 + value.length * 2;
  if (value === null || typeof value !== 'object') return 16;
  if (ArrayBuffer.isView(value)) return 64 + value.byteLength;
  if (value instanceof ArrayBuffer) return 64 + value.byteLength;
  if (Array.isArray(value)) return 64 + value.length * 8 + value.reduce((n, v) => n + estimatedBytes(v), 0);
  return 64 + Object.entries(value).reduce((n, [k, v]) => n + 32 + k.length * 2 + estimatedBytes(v), 0);
}
