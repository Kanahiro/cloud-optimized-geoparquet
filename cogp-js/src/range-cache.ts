import type { AsyncBufferLike } from './coalescing-buffer.js';

export interface RangeCacheOptions {
  /** Maximum compressed bytes retained by one reader. Defaults to 64 MiB. */
  maxBytes?: number;
}

interface CacheEntry {
  start: number;
  end: number;
  bytes: number;
  settled: boolean;
  promise: Promise<ArrayBuffer>;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Cache successful byte ranges for the lifetime of one AsyncBuffer.
 *
 * Entries are containment-aware: a cached range can satisfy any smaller
 * slice inside it. Promise values are inserted immediately so duplicate
 * in-flight reads share the same request. Settled entries follow LRU order;
 * in-flight entries may temporarily exceed the budget but are never evicted.
 */
export function rangeCachedAsyncBuffer(
  source: AsyncBufferLike,
  options: RangeCacheOptions = {},
): AsyncBufferLike {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(`maxBytes must be a non-negative safe integer, got ${maxBytes}`);
  }

  // Set insertion order is the LRU list: hits are removed and re-added.
  const entries = new Set<CacheEntry>();
  let cachedBytes = 0;

  const remove = (entry: CacheEntry): void => {
    if (!entries.delete(entry)) return;
    cachedBytes -= entry.bytes;
  };

  const touch = (entry: CacheEntry): void => {
    entries.delete(entry);
    entries.add(entry);
  };

  const evict = (): void => {
    if (cachedBytes <= maxBytes) return;
    for (const entry of entries.values()) {
      if (!entry.settled) continue;
      remove(entry);
      if (cachedBytes <= maxBytes) return;
    }
  };

  const findContainer = (start: number, end: number): CacheEntry | undefined => {
    let best: CacheEntry | undefined;
    for (const entry of entries.values()) {
      if (entry.start > start || end > entry.end) continue;
      if (!best || entry.bytes < best.bytes) best = entry;
    }
    if (best) touch(best);
    return best;
  };

  const fetchWithoutCaching = (start: number, end: number): Promise<ArrayBuffer> => {
    try {
      return Promise.resolve(source.slice(start, end));
    } catch (error) {
      return Promise.reject(error);
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

      const container = findContainer(start, end);
      if (container) {
        return container.promise.then(buffer =>
          buffer.slice(start - container.start, end - container.start),
        );
      }

      const bytes = end - start;
      if (maxBytes === 0 || bytes > maxBytes) return fetchWithoutCaching(start, end);

      let fetched: Promise<ArrayBuffer>;
      try {
        fetched = Promise.resolve(source.slice(start, end));
      } catch (error) {
        return Promise.reject(error);
      }

      let entry!: CacheEntry;
      const promise = fetched.then(buffer => {
        if (buffer.byteLength < bytes) {
          throw new Error(
            `source returned ${buffer.byteLength} bytes for [${start}, ${end}), expected ${bytes}`,
          );
        }
        entry.settled = true;
        // A newly completed superset makes older contained entries redundant.
        for (const other of entries.values()) {
          if (
            other !== entry &&
            other.settled &&
            start <= other.start &&
            other.end <= end
          ) {
            remove(other);
          }
        }
        evict();
        return buffer.byteLength === bytes ? buffer : buffer.slice(0, bytes);
      }).catch(error => {
        remove(entry);
        throw error;
      });
      entry = { start, end, bytes, settled: false, promise };
      entries.add(entry);
      cachedBytes += bytes;
      evict();

      // Never expose the cached ArrayBuffer itself to mutable callers.
      return promise.then(buffer => buffer.slice(0));
    },
  };
}
