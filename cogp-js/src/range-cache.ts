import type { AsyncBufferLike } from './coalescing-buffer.js';
import { abortReason, raceAbort } from './abort.js';

export interface RangeCacheOptions {
  /** Maximum compressed bytes retained by one reader. Defaults to 64 MiB. */
  maxBytes?: number;
}

interface CacheEntry {
  start: number;
  end: number;
  bytes: number;
  settled: boolean;
  consumers: number;
  controller: AbortController;
  promise: Promise<ArrayBuffer>;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Cache successful byte ranges for the lifetime of one AsyncBuffer.
 *
 * Disjoint entries cover both completed and in-flight reads. A slice combines
 * their overlapping portions and fetches only gaps. Promise values are inserted
 * immediately so concurrent reads share already requested bytes. Settled entries follow LRU order;
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

  const fetchWithoutCaching = (
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> => {
    try {
      return raceAbort(source.slice(start, end, signal), signal);
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const subscribe = (
    entry: CacheEntry,
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> => {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    entry.consumers++;
    return new Promise<ArrayBuffer>((resolve, reject) => {
      let done = false;
      const release = (): void => {
        entry.consumers--;
        if (entry.consumers === 0 && !entry.settled) {
          // An in-flight entry without consumers must not poison a later lookup.
          remove(entry);
          entry.controller.abort();
        }
      };
      const finish = (callback: () => void): void => {
        if (done) return;
        done = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        release();
        callback();
      };
      const onAbort = (): void => finish(() => reject(abortReason(signal!)));
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        buffer => finish(() => resolve(buffer.slice(start - entry.start, end - entry.start))),
        error => finish(() => reject(error)),
      );
    });
  };

  const fetchGap = (start: number, end: number, signal: AbortSignal): Promise<ArrayBuffer> => {
    const bytes = end - start;
    if (maxBytes === 0 || bytes > maxBytes) return fetchWithoutCaching(start, end, signal);

    let fetched: Promise<ArrayBuffer>;
    const controller = new AbortController();
    try {
      fetched = Promise.resolve(source.slice(start, end, controller.signal));
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
      evict();
      return buffer.byteLength === bytes ? buffer : buffer.slice(0, bytes);
    }).catch(error => {
      remove(entry);
      throw error;
    });
    entry = { start, end, bytes, settled: false, consumers: 0, controller, promise };
    entries.add(entry);
    cachedBytes += bytes;
    evict();

    return subscribe(entry, start, end, signal);
  };

  return {
    byteLength: source.byteLength,
    slice(start: number, end = source.byteLength, signal?: AbortSignal): Promise<ArrayBuffer> {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        return Promise.reject(new Error(`slice bounds must be safe integers, got [${start}, ${end})`));
      }
      if (start < 0 || end < start || end > source.byteLength) {
        return Promise.reject(
          new Error(`slice [${start}, ${end}) is outside buffer length ${source.byteLength}`),
        );
      }
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      if (start === end) return Promise.resolve(new ArrayBuffer(0));

      // Snapshot before fetching: inserting gaps can evict settled entries, but
      // this request must still reuse all bytes that were present at its start.
      const overlaps = [...entries]
        .filter(entry => entry.start < end && start < entry.end)
        .sort((a, b) => a.start - b.start);
      for (const entry of overlaps) touch(entry);

      const controller = new AbortController();
      const onAbort = (): void => controller.abort(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      const parts: Promise<ArrayBuffer>[] = [];
      let cursor = start;
      for (const entry of overlaps) {
        if (cursor < entry.start) parts.push(fetchGap(cursor, entry.start, controller.signal));
        const partEnd = Math.min(end, entry.end);
        parts.push(subscribe(entry, Math.max(cursor, entry.start), partEnd, controller.signal));
        cursor = partEnd;
      }
      if (cursor < end) parts.push(fetchGap(cursor, end, controller.signal));

      return Promise.all(parts).then(buffers => {
        // subscribe copies cached bytes; callers never receive mutable cache storage.
        if (buffers.length === 1) return buffers[0]!;
        const result = new Uint8Array(end - start);
        let offset = 0;
        for (const buffer of buffers) {
          result.set(new Uint8Array(buffer), offset);
          offset += buffer.byteLength;
        }
        return result.buffer;
      }).finally(() => {
        signal?.removeEventListener('abort', onAbort);
        // On failure, release other pending gaps without cancelling their peers.
        controller.abort();
      });
    },
  };
}
