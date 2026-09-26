/**
 * @import {AsyncBuffer, Awaitable, DecodedArray} from '../src/types.js'
 */
import type { AsyncBuffer, DecodedArray } from '../src/types.js';
/**
 * Replace bigint, date, etc with legal JSON types.
 *
 * @param {any} obj object to convert
 * @returns {unknown} converted object
 */
export declare function toJson(obj: any): unknown;
/**
 * Concatenate two arrays fast.
 *
 * @param {any[]} aaa
 * @param {DecodedArray} bbb
 */
export declare function concat(aaa: any[], bbb: DecodedArray): void;
/**
 * Deep equality.
 *
 * @param {any} a
 * @param {any} b
 * @param {boolean} [strict]
 * @returns {boolean}
 */
export declare function equals(a: any, b: any, strict?: boolean): boolean;
/**
 * Get the byte length of a URL using a HEAD request.
 * If HEAD fails with 403 (e.g., with signed S3 URLs), falls back to a ranged GET request.
 * If HEAD succeeds but Content-Length is missing, falls back to GET with range.
 * If requestInit is provided, it will be passed to fetch.
 *
 * @param {string} url
 * @param {RequestInit} [requestInit] fetch options
 * @param {typeof globalThis.fetch} [customFetch] fetch function to use
 * @returns {Promise<number>}
 */
export declare function byteLengthFromUrl(url: string, requestInit?: RequestInit, customFetch?: typeof globalThis.fetch): Promise<number>;
/**
 * Construct an AsyncBuffer for a URL.
 * If byteLength is not provided, will make a HEAD request to get the file size.
 * If fetch is provided, it will be used instead of the global fetch.
 * If requestInit is provided, it will be passed to fetch.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {number} [options.byteLength]
 * @param {typeof globalThis.fetch} [options.fetch] fetch function to use
 * @param {RequestInit} [options.requestInit]
 * @returns {Promise<AsyncBuffer>}
 */
export declare function asyncBufferFromUrl({ url, byteLength, requestInit, fetch: customFetch }: {
    url: string;
    byteLength?: number;
    fetch?: typeof globalThis.fetch;
    requestInit?: RequestInit;
}): Promise<AsyncBuffer>;
/**
 * Returns a cached layer on top of an AsyncBuffer. For caching slices of a file
 * that are read multiple times, possibly over a network.
 *
 * @param {AsyncBuffer} file file-like object to cache
 * @param {{ minSize?: number }} [options]
 * @returns {AsyncBuffer} cached file-like object
 */
export declare function cachedAsyncBuffer({ byteLength, slice }: AsyncBuffer, { minSize }?: {
    minSize?: number;
}): AsyncBuffer;
/**
 * Flatten a list of lists into a single list.
 *
 * @param {DecodedArray[]} [chunks]
 * @returns {DecodedArray}
 */
export declare function flatten(chunks?: DecodedArray[]): DecodedArray;
//# sourceMappingURL=utils.d.ts.map