/**
 * @import {AsyncRowGroup, BaseParquetReadOptions, BloomFilter, DecodedArray, PageLocation, PageRanges, ParquetScan, ParquetScanOptions, QueryPlan, SchemaElement} from '../src/types.js'
 */
import type { AsyncRowGroup, BaseParquetReadOptions, BloomFilter, PageLocation, PageRanges, ParquetScan, ParquetScanOptions, QueryPlan, SchemaElement } from '../src/types.js';
export type PreparedParquetReadOptions = BaseParquetReadOptions & {
    bloomFiltersByGroup?: Record<string, BloomFilter>[];
    schemaElements?: Record<string, SchemaElement>;
    pageRangesByGroup?: (PageRanges | undefined)[];
    pageLocationsByGroup?: Record<string, PageLocation[]>[];
};
/**
 * Prepare a lazy column-oriented scan of a parquet file.
 *
 * The returned ranges are physical, zero-based row ranges in the file. A
 * `pruningFilter` may narrow them using row-group statistics, bloom filters,
 * and page indexes, but does not filter individual values returned by
 * `readColumn`. This makes the scan suitable for query engines that maintain
 * their own row selections while retaining parquet-level I/O pushdown.
 *
 * `columns`, when supplied, limits the columns available to `readColumn`.
 * Columns referenced by `pruningFilter` are included automatically.
 *
 * @param {ParquetScanOptions} options
 * @returns {Promise<ParquetScan>}
 */
export declare function parquetScan(options: ParquetScanOptions): Promise<ParquetScan>;
/**
 * Decode column views through the same page plan used by parquetRead.
 * Each planned row range yields one view per selected top-level column.
 *
 * @param {BaseParquetReadOptions} options
 * @param {QueryPlan} plan
 * @param {(result: {columnName: string, view: import('../src/types.js').ParquetColumnView}) => void} onColumnView
 * @returns {Promise<void>}
 */
export declare function readParquetColumnViews(options: BaseParquetReadOptions, plan: QueryPlan, onColumnView: (result: {
    columnName: string;
    view: import('../src/types.js').ParquetColumnView;
}) => void): Promise<void>;
/**
 * Load optional indexes and build the canonical physical read plan.
 * Shared by row-oriented reads and lazy scans so pruning behavior cannot
 * diverge between APIs.
 *
 * @param {BaseParquetReadOptions} options
 * @returns {Promise<{options: PreparedParquetReadOptions, plan: QueryPlan}>}
 */
export declare function prepareParquetRead(options: BaseParquetReadOptions): Promise<{
    options: PreparedParquetReadOptions;
    plan: QueryPlan;
}>;
/**
 * Read all planned row groups, prefetching their coalesced byte ranges.
 *
 * @param {BaseParquetReadOptions} options
 * @param {QueryPlan} plan
 * @returns {AsyncRowGroup[]}
 */
export declare function readParquetPlan(options: BaseParquetReadOptions, plan: QueryPlan): AsyncRowGroup[];
//# sourceMappingURL=scan.d.ts.map