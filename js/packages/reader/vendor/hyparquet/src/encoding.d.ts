/**
 * @import {DataReader, DecodedArray, ParquetType} from '../src/types.js'
 */
import type { DataReader, DecodedArray, ParquetType } from '../src/types.js';
/**
 * Read values from a run-length encoded/bit-packed hybrid encoding.
 *
 * If length is zero, then read int32 length at the start.
 *
 * @param {DataReader} reader
 * @param {number} width - bitwidth
 * @param {DecodedArray} output
 * @param {number} [length] - length of the encoded data
 */
export declare function readRleBitPackedHybrid(reader: DataReader, width: number, output: DecodedArray, length?: number): void;
/**
 * @param {DataReader} reader
 * @param {number} count
 * @param {ParquetType} type
 * @param {number | undefined} typeLength
 * @returns {DecodedArray}
 */
export declare function byteStreamSplit(reader: DataReader, count: number, type: ParquetType, typeLength: number | undefined): DecodedArray;
//# sourceMappingURL=encoding.d.ts.map