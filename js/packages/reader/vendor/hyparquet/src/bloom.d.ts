import type { BloomFilter, DataReader, ParquetQueryFilter, SchemaElement } from '../src/types.js';
/**
 * Insert a hash into a Split Block Bloom Filter.
 *
 * @param {Uint32Array} blocks bloom filter words (8 * numBlocks long)
 * @param {bigint} hash 64-bit xxhash of the parquet-plain-encoded value
 */
export declare function sbbfInsert(blocks: Uint32Array, hash: bigint): void;
/**
 * Test whether a hash might be present in a Split Block Bloom Filter.
 * False positives are possible; false negatives are not.
 *
 * @param {Uint32Array} blocks bloom filter words (8 * numBlocks long)
 * @param {bigint} hash 64-bit xxhash of the parquet-plain-encoded value
 * @returns {boolean}
 */
export declare function sbbfContains(blocks: Uint32Array, hash: bigint): boolean;
/**
 * Parse a Split Block Bloom Filter from a reader positioned at the BloomFilterHeader.
 * Returns undefined when the header advertises an unsupported algorithm, hash, or
 * compression — callers should treat that as "cannot use this bloom filter."
 *
 * @param {DataReader} reader
 * @returns {BloomFilter | undefined}
 */
export declare function readBloomFilter(reader: DataReader): BloomFilter | undefined;
/**
 * Hash a JS filter value as its parquet PLAIN-encoded bytes, suitable for a
 * bloom filter lookup. Returns undefined when the column's parser is lossy or
 * ambiguous (DATE, TIMESTAMP_*, DECIMAL, JSON, BSON, INT96, FLOAT16, UUID,
 * GEOMETRY, GEOGRAPHY, INTERVAL) or when the JS value type doesn't match the
 * column. Callers must treat undefined as "bloom filter cannot help."
 *
 * @param {any} value
 * @param {SchemaElement} element
 * @returns {bigint | undefined}
 */
export declare function hashParquetValue(value: any, element: SchemaElement): bigint | undefined;
/**
 * Top-level column names that appear in $eq or $in predicates within a filter.
 * These are the only columns where a bloom filter can prove a value's absence
 * and let us skip a row group; any other operator can't be helped by a bloom.
 *
 * @param {ParquetQueryFilter | undefined} filter
 * @returns {Set<string>}
 */
export declare function bloomEligibleColumns(filter: ParquetQueryFilter | undefined): Set<string>;
//# sourceMappingURL=bloom.d.ts.map