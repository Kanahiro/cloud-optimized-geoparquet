import type { ColumnDecoder, DecodedArray, Encoding, ParquetParsers } from '../src/types.js';
/**
 * Default type parsers when no custom ones are given
 * @type ParquetParsers
 */
export declare const DEFAULT_PARSERS: ParquetParsers;
/**
 * Convert known types from primitive to rich, and dereference dictionary.
 *
 * @param {DecodedArray} data series of primitive types
 * @param {DecodedArray | undefined} dictionary
 * @param {Encoding} encoding
 * @param {ColumnDecoder} columnDecoder
 * @returns {DecodedArray} series of rich types
 */
export declare function convertWithDictionary(data: DecodedArray, dictionary: DecodedArray | undefined, encoding: Encoding, columnDecoder: ColumnDecoder): DecodedArray;
/**
 * Convert known types from primitive to rich.
 *
 * @param {DecodedArray} data series of primitive types
 * @param {ColumnDecoder} columnDecoder
 * @returns {DecodedArray} series of rich types
 */
export declare function convert(data: DecodedArray, columnDecoder: ColumnDecoder): DecodedArray;
/**
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export declare function parseDecimal(bytes: Uint8Array): number;
/**
 * @param {Uint8Array | undefined} bytes
 * @returns {number | undefined}
 */
export declare function parseFloat16(bytes: Uint8Array | undefined): number | undefined;
//# sourceMappingURL=convert.d.ts.map