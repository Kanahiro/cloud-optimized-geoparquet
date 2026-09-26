/**
 * @import {AsyncRowGroup, BaseParquetReadOptions, DecodedArray, ParquetReadOptions, ParquetRow} from '../src/types.js'
 */
import type { AsyncRowGroup, BaseParquetReadOptions, DecodedArray, ParquetReadOptions, ParquetRow } from '../src/types.js';
/**
 * Symbol for the absolute, zero-based physical position of an object row.
 * @type {typeof import('../src/types.js').rowIndex}
 */
export declare const rowIndex: typeof import('../src/types.js').rowIndex;
/**
 * Read parquet data rows from a file-like object.
 * Reads the minimal number of row groups and columns to satisfy the request.
 *
 * Returns a void promise when complete.
 * Errors are thrown on the returned promise.
 * Data is returned in callbacks onComplete, onChunk, onPage, NOT the return promise.
 * See parquetReadObjects for a more convenient API.
 *
 * @param {ParquetReadOptions} options read options
 * @returns {Promise<void>} resolves when all requested rows and columns are parsed, all errors are thrown here
 */
export declare function parquetRead(options: ParquetReadOptions): Promise<void>;
/**
 * @param {ParquetReadOptions} options read options
 * @returns {AsyncRowGroup[]}
 */
export declare function parquetReadAsync(options: ParquetReadOptions): AsyncRowGroup[];
/**
 * Reads a single column from a parquet file.
 *
 * @param {BaseParquetReadOptions} options
 * @returns {Promise<DecodedArray>}
 */
export declare function parquetReadColumn(options: BaseParquetReadOptions): Promise<DecodedArray>;
/**
 * This is a helper function to read parquet row data as a promise.
 * It is a wrapper around the more configurable parquetRead function.
 *
 * @param {Omit<ParquetReadOptions, 'onComplete'>} options
 * @returns {Promise<ParquetRow[]>} resolves when all requested rows and columns are parsed
 */
export declare function parquetReadObjects(options: Omit<ParquetReadOptions, 'onComplete'>): Promise<ParquetRow[]>;
//# sourceMappingURL=read.d.ts.map