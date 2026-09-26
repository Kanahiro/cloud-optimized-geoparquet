/**
 * @import {ColumnIndex, DataReader, OffsetIndex, PageLocation, ParquetParsers, SchemaElement} from '../src/types.js'
 */
import type { ColumnIndex, DataReader, OffsetIndex, ParquetParsers, SchemaElement } from '../src/types.js';
/**
 * @param {DataReader} reader
 * @param {SchemaElement} schema
 * @param {Partial<ParquetParsers> | undefined} parsers
 * @returns {ColumnIndex}
 */
export declare function readColumnIndex(reader: DataReader, schema: SchemaElement, parsers?: Partial<ParquetParsers> | undefined): ColumnIndex;
/**
 * @param {DataReader} reader
 * @returns {OffsetIndex}
 */
export declare function readOffsetIndex(reader: DataReader): OffsetIndex;
//# sourceMappingURL=indexes.d.ts.map