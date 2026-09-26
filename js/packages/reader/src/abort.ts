import type { AsyncBufferLike } from './coalescing-buffer.js';

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** Bind the implicit AsyncBuffer reads made by hyparquet to one operation. */
export function bindAbortSignal(
  source: AsyncBufferLike,
  signal?: AbortSignal,
): AsyncBufferLike {
  if (!signal) return source;
  return {
    byteLength: source.byteLength,
    slice(start: number, end = source.byteLength): Promise<ArrayBuffer> {
      throwIfAborted(signal);
      return raceAbort(source.slice(start, end, signal), signal);
    },
  };
}

/** Reject one consumer promptly without losing the eventual source rejection. */
export function raceAbort<T>(value: T | Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      result => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
