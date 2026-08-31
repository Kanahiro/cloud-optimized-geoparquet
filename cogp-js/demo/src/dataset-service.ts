import type {
  FeaturePropertiesResult,
  OpenResult,
  ViewportBbox,
  ViewportResult,
  WorkerEnvelope,
  WorkerResponse,
} from './cogp-types';

export type {
  FeaturePropertiesResult,
  MetadataSummary,
  OpenResult,
  ViewportResult,
} from './cogp-types';

const worker = new Worker(new URL('./cogp-worker.ts', import.meta.url), { type: 'module' });

let nextId = 0;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
  const msg = e.data;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new Error(msg.error));
});

function call<T>(payload: WorkerEnvelope['payload']): Promise<T> {
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    const envelope: WorkerEnvelope = { id, payload };
    worker.postMessage(envelope);
  });
}

export function openDataset(url: string): Promise<OpenResult> {
  return call<OpenResult>({ type: 'open', url });
}

export function readViewport(
  url: string,
  bbox: ViewportBbox,
  targetResolutionMeters: number,
): Promise<ViewportResult> {
  return call<ViewportResult>({ type: 'readViewport', url, bbox, targetResolutionMeters });
}

export function readFeatureProperties(
  url: string,
  rowIndex: number,
): Promise<FeaturePropertiesResult> {
  return call<FeaturePropertiesResult>({ type: 'readProperties', url, rowIndex });
}
