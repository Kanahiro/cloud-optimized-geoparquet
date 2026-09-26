import { throwIfAborted } from './abort.js';
import { SharedLru } from './shared-lru.js';
import type { AsyncBufferLike } from './coalescing-buffer.js';

export interface RangeCacheOptions {
  /** Retained compressed data budget, excluding in-flight reads and returned copies. Default: 32 MiB. */
  maxBytes?: number;
}
interface Range { start: number; end: number; buffer: ArrayBuffer }

/** Reader-local LRU of immutable byte ranges. Keep this outside the coalescer
 * so stable page requests are cached even when neighboring requests are merged.
 * Every caller gets its own copy; decoders cannot modify retained bytes.
 */
export function cachedRangeBuffer(source: AsyncBufferLike, options: RangeCacheOptions | false = {}): AsyncBufferLike {
  if (options === false) return source;
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('range cache maxBytes must be a non-negative safe integer');
  if (maxBytes === 0) return source;
  const cache = new SharedLru<Range>(maxBytes, 4096);
  return {
    byteLength: source.byteLength,
    async slice(start, end = source.byteLength, signal) {
      throwIfAborted(signal);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.byteLength) {
        throw new Error('invalid cached byte range');
      }
      if (start === end) return new ArrayBuffer(0);
      const key = `${start}:${end}`;
      let cached = cache.get(key);
      if (!cached) {
        for (const [candidateKey, { value }] of cache.entries) {
          if (value.start <= start && end <= value.end) {
            cached = cache.get(candidateKey);
            break;
          }
        }
      }
      if (cached) return cached.buffer.slice(start - cached.start, end - cached.start);
      const range = await cache.load(key, async controllerSignal => {
        const buffer = await source.slice(start, end, controllerSignal);
        if (buffer.byteLength !== end - start) throw new Error('short cached range read');
        return { value: { start, end, buffer }, bytes: buffer.byteLength };
      }, signal);
      return range.buffer.slice(0);
    },
  };
}
