/**
 * @import {DataReader} from '../src/types.js'
 */
import type { DataReader } from '../src/types.js';
/**
 * @param {DataReader} reader
 * @param {number} count number of values to read
 * @param {Int32Array | BigInt64Array} output
 */
export declare function deltaBinaryUnpack(reader: DataReader, count: number, output: Int32Array | BigInt64Array): void;
/**
 * @param {DataReader} reader
 * @param {number} count
 * @param {Uint8Array[]} output
 */
export declare function deltaLengthByteArray(reader: DataReader, count: number, output: Uint8Array[]): void;
/**
 * @param {DataReader} reader
 * @param {number} count
 * @param {Uint8Array[]} output
 */
export declare function deltaByteArray(reader: DataReader, count: number, output: Uint8Array[]): void;
//# sourceMappingURL=delta.d.ts.map