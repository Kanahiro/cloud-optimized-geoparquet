/**
 * @import {BloomFilter, ColumnPageStats, PageRanges, ParquetQueryFilter, RowGroup, SchemaElement} from '../src/types.js'
 */
import type { BloomFilter, ColumnPageStats, PageRanges, ParquetQueryFilter, RowGroup, SchemaElement } from '../src/types.js';
/**
 * Returns the physical leaf paths referenced by a filter.
 *
 * @param {ParquetQueryFilter} [filter]
 * @returns {string[]}
 */
export declare function pathsNeededForFilter(filter?: ParquetQueryFilter): string[];
/**
 * Returns an array of top-level column names needed to evaluate the filter.
 *
 * @param {ParquetQueryFilter} [filter]
 * @returns {string[]}
 */
export declare function columnsNeededForFilter(filter?: ParquetQueryFilter): string[];
/**
 * Match a record against a query filter
 *
 * @param {Record<string, any>} record
 * @param {ParquetQueryFilter} filter
 * @param {boolean} [strict]
 * @returns {boolean}
 */
export declare function matchFilter(record: Record<string, any>, filter: ParquetQueryFilter, strict?: boolean): boolean;
/**
 * Check if a row group can be skipped based on filter and column statistics,
 * optionally consulting per-column bloom filters for equality predicates that
 * statistics can't decide.
 *
 * @param {object} options
 * @param {RowGroup} options.rowGroup
 * @param {string[]} options.physicalColumns
 * @param {ParquetQueryFilter | undefined} options.filter
 * @param {boolean} [options.strict]
 * @param {Record<string, BloomFilter>} [options.bloomFilters] keyed by filter path
 * @param {Record<string, SchemaElement>} [options.schemaElements] keyed by physical leaf path
 * @returns {boolean} true if the row group can be skipped
 */
export declare function canSkipRowGroup({ rowGroup, physicalColumns, filter, strict, bloomFilters, schemaElements }: {
    rowGroup: RowGroup;
    physicalColumns: string[];
    filter: ParquetQueryFilter | undefined;
    strict?: boolean;
    bloomFilters?: Record<string, BloomFilter>;
    schemaElements?: Record<string, SchemaElement>;
}): boolean;
/**
 * Compute candidate row ranges within a row group that could match the filter,
 * based on per-page column index statistics.
 *
 * Returns sorted disjoint [start, end) row ranges relative to the group.
 * An empty array means the filter provably matches no rows in the group.
 * Returns undefined when the page statistics give no pruning information
 * (the caller must read the whole selection).
 *
 * @param {ParquetQueryFilter | undefined} filter
 * @param {Record<string, ColumnPageStats>} columnPages keyed by physical leaf path
 * @param {number} groupRows number of rows in the row group
 * @param {boolean} [strict]
 * @returns {PageRanges | undefined}
 */
export declare function filterPageRanges(filter: ParquetQueryFilter | undefined, columnPages: Record<string, ColumnPageStats>, groupRows: number, strict?: boolean): PageRanges | undefined;
/**
 * Intersect two sets of sorted disjoint ranges. Undefined means "everything".
 *
 * @param {PageRanges | undefined} a
 * @param {PageRanges | undefined} b
 * @returns {PageRanges | undefined}
 */
export declare function intersectRanges(a: PageRanges | undefined, b: PageRanges | undefined): PageRanges | undefined;
/**
 * Union two sets of sorted disjoint ranges.
 *
 * @param {PageRanges} a
 * @param {PageRanges} b
 * @returns {PageRanges}
 */
export declare function unionRanges(a: PageRanges, b: PageRanges): PageRanges;
//# sourceMappingURL=filter.d.ts.map