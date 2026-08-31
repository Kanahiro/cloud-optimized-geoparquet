import type { AsyncBufferLike } from './coalescing-buffer.js';

export const DEFAULT_RANGE_CACHE_MAX_BYTES = 128 * 1024 * 1024;

export interface RangeCacheOptions {
  /** Maximum retained response bytes. Zero keeps only in-flight deduplication. */
  maxBytes?: number;
}

interface CacheEntry {
  buffer: ArrayBuffer;
  bytes: number;
}

/**
 * Retain exact AsyncBuffer slices in least-recently-used order.
 *
 * Parquet readers repeatedly request the same physical column chunks when a
 * viewport moves slightly. Caching at this boundary makes that reuse
 * deterministic without retaining decoded rows or depending on HTTP `206`
 * cache behavior. The caller treats returned ArrayBuffers as immutable.
 */
export function lruCachingAsyncBuffer(
  source: AsyncBufferLike,
  options: RangeCacheOptions = {},
): AsyncBufferLike {
  const maxBytes = options.maxBytes ?? DEFAULT_RANGE_CACHE_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(`range cache maxBytes must be a non-negative safe integer, got ${maxBytes}`);
  }

  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<ArrayBuffer>>();
  let retainedBytes = 0;

  const remember = (key: string, buffer: ArrayBuffer): void => {
    const bytes = buffer.byteLength;
    if (bytes > maxBytes) return;

    const previous = cache.get(key);
    if (previous) {
      retainedBytes -= previous.bytes;
      cache.delete(key);
    }
    while (retainedBytes + bytes > maxBytes) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = cache.get(oldestKey)!;
      cache.delete(oldestKey);
      retainedBytes -= oldest.bytes;
    }
    cache.set(key, { buffer, bytes });
    retainedBytes += bytes;
  };

  return {
    byteLength: source.byteLength,
    slice(start: number, end = source.byteLength): Promise<ArrayBuffer> {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        return Promise.reject(new Error(`slice bounds must be safe integers, got [${start}, ${end})`));
      }
      if (start < 0 || end < start || end > source.byteLength) {
        return Promise.reject(
          new Error(`slice [${start}, ${end}) is outside buffer length ${source.byteLength}`),
        );
      }
      if (start === end) return Promise.resolve(new ArrayBuffer(0));

      const key = `${start}:${end}`;
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return Promise.resolve(hit.buffer);
      }

      const pending = inFlight.get(key);
      if (pending) return pending;

      let request: Promise<ArrayBuffer>;
      try {
        request = Promise.resolve(source.slice(start, end));
      } catch (error) {
        return Promise.reject(error);
      }
      request = request.then(
        (buffer) => {
          inFlight.delete(key);
          remember(key, buffer);
          return buffer;
        },
        (error: unknown) => {
          inFlight.delete(key);
          throw error;
        },
      );
      inFlight.set(key, request);
      return request;
    },
  };
}
