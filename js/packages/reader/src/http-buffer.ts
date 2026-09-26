import { byteLengthFromUrl } from '../vendor/hyparquet/src/index.js';

import { abortReason, throwIfAborted } from './abort.js';
import type { AsyncBufferLike } from './coalescing-buffer.js';

export interface HttpBufferOptions {
  fetch?: typeof fetch;
  byteLength?: number;
  requestInit?: Omit<RequestInit, 'cache' | 'signal'>;
  signal?: AbortSignal;
}

/** HTTP AsyncBuffer whose individual Range requests remain abortable. */
export async function abortableAsyncBufferFromUrl(
  url: string,
  options: HttpBufferOptions,
): Promise<AsyncBufferLike> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const requestInit: RequestInit = { ...options.requestInit, cache: 'no-store' };
  throwIfAborted(options.signal);
  const byteLength = options.byteLength ?? await byteLengthFromUrl(
    url,
    { ...requestInit, signal: options.signal },
    fetchFn,
  );
  throwIfAborted(options.signal);

  // Retain a completed full response for origins that ignore Range. Never
  // share an in-flight full response because it belongs to one caller's signal.
  let wholeBuffer: ArrayBuffer | undefined;
  return {
    byteLength,
    async slice(start: number, end = byteLength, signal?: AbortSignal): Promise<ArrayBuffer> {
      throwIfAborted(signal);
      if (wholeBuffer) return wholeBuffer.slice(start, end);

      const headers = new Headers(requestInit.headers);
      headers.set('Range', `bytes=${start}-${end - 1}`);
      const response = await fetchWithRetry(fetchFn, url, { ...requestInit, headers, signal }, signal);
      if (!response.ok || !response.body) throw new Error(`fetch failed ${response.status}`);
      if (response.status !== 200 && response.status !== 206) {
        throw new Error(`fetch received unexpected status code ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      if (response.status === 200) {
        wholeBuffer = bytes;
        return bytes.slice(start, end);
      }
      return bytes;
    },
  };
}

const RETRY_DELAYS_MS = [200, 800];
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

/** Retry transient network errors and overload responses. A tile renderer
 * never re-requests a failed tile, so one dropped Range request would
 * otherwise leave a permanent hole. */
async function fetchWithRetry(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined;
    try {
      response = await fetchFn(url, init);
    } catch (error) {
      throwIfAborted(signal);
      // fetch rejects with TypeError for network and CORS failures.
      if (!(error instanceof TypeError) || attempt >= RETRY_DELAYS_MS.length) throw error;
    }
    if (response && (!RETRY_STATUSES.has(response.status) || attempt >= RETRY_DELAYS_MS.length)) {
      return response;
    }
    await delay(RETRY_DELAYS_MS[attempt]!, signal);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
