import type { WorkerRequest, WorkerResponse } from './messages.js';

type Request = Extract<WorkerRequest, { type: 'prepare' | 'tile' }>;
type RequestInput = Request extends infer T ? T extends Request ? Omit<T, 'id'> : never : never;

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, {
  resolve: (response: WorkerResponse & { ok: true }) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort: () => void;
}>();

function rejectPending(error: Error): void {
  for (const [id, request] of pending) {
    pending.delete(id);
    request.signal?.removeEventListener('abort', request.onAbort);
    request.reject(error);
  }
  worker?.terminate();
  worker = undefined;
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    request.signal?.removeEventListener('abort', request.onAbort);
    if (response.ok) request.resolve(response);
    else {
      const error = new Error(response.error);
      error.name = response.name;
      request.reject(error);
    }
  });
  worker.addEventListener('error', event => rejectPending(new Error(`COGP worker failed: ${event.message}`)));
  worker.addEventListener('messageerror', () => rejectPending(new Error('COGP worker message could not be decoded')));
  return worker;
}

export function callWorker(request: RequestInput, signal?: AbortSignal): Promise<WorkerResponse & { ok: true }> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      if (!pending.delete(id)) return;
      signal?.removeEventListener('abort', onAbort);
      worker?.postMessage({ id, type: 'cancel' } satisfies WorkerRequest);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    pending.set(id, { resolve, reject, signal, onAbort });
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      getWorker().postMessage({ ...request, id });
    } catch (error) {
      pending.delete(id);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    }
  });
}
