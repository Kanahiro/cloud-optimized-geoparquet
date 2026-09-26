/**
 * @import {DataReader, ThriftObject, ThriftType} from '../src/types.js'
 */
import type { DataReader } from '../src/types.js';
/**
 * Parse TCompactProtocol
 *
 * @param {DataReader} reader
 * @returns {{ [key: `field_${number}`]: any }}
 */
export declare function deserializeTCompactProtocol(reader: DataReader): {
    [key: `field_${number}`]: any;
};
/**
 * Read varint aka Unsigned LEB128.
 *
 * @param {DataReader} reader
 * @returns {number}
 */
export declare function readVarInt(reader: DataReader): number;
/**
 * Read a zigzag number.
 * Zigzag folds positive and negative numbers into the positive number space.
 *
 * @param {DataReader} reader
 * @returns {number}
 */
export declare function readZigZag(reader: DataReader): number;
/**
 * Read a zigzag bigint.
 *
 * @param {DataReader} reader
 * @returns {bigint}
 */
export declare function readZigZagBigInt(reader: DataReader): bigint;
//# sourceMappingURL=thrift.d.ts.map