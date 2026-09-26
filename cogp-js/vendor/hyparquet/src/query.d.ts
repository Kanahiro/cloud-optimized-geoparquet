/**
 * @import {BaseParquetReadOptions, ParquetRow} from '../src/types.js'
 */
import type { BaseParquetReadOptions, ParquetRow } from '../src/types.js';
/**
 * Wraps parquetRead with orderBy support.
 * This is a parquet-aware query engine that can read a subset of rows and columns.
 * Accepts optional orderBy column name to sort the results.
 * Note that using orderBy may SIGNIFICANTLY increase the query time.
 *
 * @param {BaseParquetReadOptions & { orderBy?: string }} options
 * @returns {Promise<ParquetRow[]>} resolves when all requested rows and columns are parsed
 */
export declare function parquetQuery(options: BaseParquetReadOptions & {
    orderBy?: string;
}): Promise<ParquetRow[]>;
//# sourceMappingURL=query.d.ts.map