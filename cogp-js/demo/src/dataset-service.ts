import type {
  FeatureProperties,
  OpenResult,
  TileResult,
  WorkerEnvelope,
  WorkerResponse,
} from './cogp-types';

export type { FeatureProperties, MetadataSummary, OpenResult, TileResult } from './cogp-types';

const worker = new Worker(new URL('./cogp-worker.ts', import.meta.url), { type: 'module' });

let nextId = 0;
const pending = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  }
>();

worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
  const msg = e.data;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  p.cleanup();
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new Error(msg.error));
});

function call<T>(payload: WorkerEnvelope['payload'], signal?: AbortSignal): Promise<T> {
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('COGP request aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      if (!pending.delete(id)) return;
      worker.postMessage({ type: 'cancel', id });
      reject(new DOMException('COGP request aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
      cleanup: () => signal?.removeEventListener('abort', onAbort),
    });
    const envelope: WorkerEnvelope = { id, payload };
    worker.postMessage(envelope);
  });
}

export function openDataset(url: string, signal?: AbortSignal): Promise<OpenResult> {
  return call<OpenResult>({ type: 'open', url }, signal);
}

export function readTile(
  url: string,
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<TileResult> {
  return call<TileResult>({ type: 'readTile', url, z, x, y }, signal);
}

export function readProperties(
  url: string,
  rowIndex: number,
  signal?: AbortSignal,
): Promise<FeatureProperties> {
  return call<FeatureProperties>({ type: 'readProperties', url, rowIndex }, signal);
}
