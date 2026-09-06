import type { AsyncBufferLike } from './coalescing-buffer.js';

export interface RangeCacheOptions {
  /** Maximum bytes retained by this reader. Defaults to 64 MiB. */
  maxBytes?: number;
}

interface CacheEntry {
  readonly bytes: number;
  readonly promise: Promise<ArrayBuffer>;
  settled: boolean;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Cache successful byte-range reads for the lifetime of one AsyncBuffer.
 *
 * Promise values are cached as well as completed values, so duplicate reads
 * share an in-flight request. Entries use LRU eviction once they settle; an
 * in-flight entry is never evicted because doing so could duplicate network
 * work at the point where the browser is already busiest.
 */
export function rangeCachedAsyncBuffer(
  source: AsyncBufferLike,
  options: RangeCacheOptions = {},
): AsyncBufferLike {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(`maxBytes must be a non-negative safe integer, got ${maxBytes}`);
  }

  const entries = new Map<string, CacheEntry>();
  let cachedBytes = 0;

  const evictSettledEntries = (): void => {
    if (cachedBytes <= maxBytes) return;
    for (const [key, entry] of entries) {
      if (!entry.settled) continue;
      entries.delete(key);
      cachedBytes -= entry.bytes;
      if (cachedBytes <= maxBytes) return;
    }
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

      const bytes = end - start;
      if (maxBytes === 0 || bytes > maxBytes) return Promise.resolve(source.slice(start, end));

      const key = `${start},${end}`;
      const cached = entries.get(key);
      if (cached) {
        // Map insertion order doubles as the LRU list.
        entries.delete(key);
        entries.set(key, cached);
        return cached.promise;
      }

      const entry: CacheEntry = {
        bytes,
        settled: false,
        promise: Promise.resolve(source.slice(start, end)),
      };
      entries.set(key, entry);
      cachedBytes += bytes;

      void entry.promise.then(
        buffer => {
          entry.settled = true;
          if (buffer.byteLength < bytes) {
            entries.delete(key);
            cachedBytes -= bytes;
            return;
          }
          evictSettledEntries();
        },
        () => {
          // Failed reads must be retryable.
          if (entries.get(key) === entry) {
            entries.delete(key);
            cachedBytes -= bytes;
          }
        },
      );
      return entry.promise;
    },
  };
}
