/// <reference lib="webworker" />
import { CogpReader } from '@cogp/reader';
import { renderTile } from './tile.js';
import type { WorkerRequest, WorkerResponse } from './messages.js';

const scope = self as DedicatedWorkerGlobalScope;
const readers = new Map<string, Promise<CogpReader>>();
const controllers = new Map<number, AbortController>();
const MAX_READERS = 8;

function getReader(url: string): Promise<CogpReader> {
  const existing = readers.get(url);
  if (existing) {
    readers.delete(url);
    readers.set(url, existing);
    return existing;
  }
  const pending = CogpReader.open(url);
  readers.set(url, pending);
  if (readers.size > MAX_READERS) readers.delete(readers.keys().next().value!);
  void pending.catch(() => {
    if (readers.get(url) === pending) readers.delete(url);
  });
  return pending;
}

scope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === 'cancel') {
    controllers.get(request.id)?.abort();
    return;
  }
  const controller = new AbortController();
  controllers.set(request.id, controller);
  void (async () => {
    try {
      const data = await renderTile(request.config, request.z, request.x, request.y, getReader, controller.signal);
      const response: WorkerResponse = { id: request.id, ok: true, data };
      scope.postMessage(response, [data]);
    } catch (error) {
      const cause = error as Error;
      const response: WorkerResponse = {
        id: request.id, ok: false, name: cause.name ?? 'Error', error: cause.message ?? String(error),
      };
      scope.postMessage(response);
    } finally {
      controllers.delete(request.id);
    }
  })();
});
