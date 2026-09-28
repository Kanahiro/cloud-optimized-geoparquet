/// <reference lib="webworker" />
import { CogpReader } from '@cogp/reader';
import { Zstd } from '@hpcc-js/wasm-zstd';
import { renderTile } from './tile.js';
import type { CogpDatasetInfo, CogpStats, WorkerRequest, WorkerResponse } from './messages.js';

const scope = self as DedicatedWorkerGlobalScope;
const readers = new Map<string, Promise<CogpReader>>();
const stats = new Map<string, CogpStats>();
const controllers = new Map<number, AbortController>();
const MAX_READERS = 8;
const RECENT_TILES = 200;
const zstdDecoder = Zstd.load();

function getReader(url: string): Promise<CogpReader> {
  const existing = readers.get(url);
  if (existing) {
    readers.delete(url);
    readers.set(url, existing);
    return existing;
  }
  const counters: CogpStats = { requests: 0, bytes: 0, tileMs: [] };
  const pending = zstdDecoder.then(zstd => CogpReader.open(url, {
    compressors: { ZSTD: input => zstd.decompress(input) },
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (new Headers(init?.headers).has('Range')) {
        counters.requests++;
        counters.bytes += Number(response.headers.get('Content-Length') ?? 0);
      }
      return response;
    },
  }));
  readers.set(url, pending);
  stats.set(url, counters);
  if (readers.size > MAX_READERS) {
    const oldest = readers.keys().next().value!;
    readers.delete(oldest);
    stats.delete(oldest);
  }
  void pending.catch(() => {
    if (readers.get(url) === pending) {
      readers.delete(url);
      stats.delete(url);
    }
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
      if (request.type === 'stats') {
        const counters = stats.get(request.url);
        const response: WorkerResponse = {
          id: request.id, ok: true,
          stats: counters ? { ...counters, tileMs: [...counters.tileMs] } : { requests: 0, bytes: 0, tileMs: [] },
        };
        scope.postMessage(response);
      } else if (request.type === 'inspect') {
        const reader = await getReader(request.url);
        controller.signal.throwIfAborted();
        const info = inspectReader(reader);
        const response: WorkerResponse = { id: request.id, ok: true, info };
        scope.postMessage(response);
      } else {
        const startedAt = performance.now();
        const data = await renderTile(request.config, request.z, request.x, request.y, getReader, controller.signal);
        for (const url of new Set(request.config.layers.map(layer => layer.url))) {
          const times = stats.get(url)?.tileMs;
          if (times) {
            times.push(performance.now() - startedAt);
            if (times.length > RECENT_TILES) times.shift();
          }
        }
        const response: WorkerResponse = { id: request.id, ok: true, data };
        scope.postMessage(response, [data]);
      }
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

function inspectReader(reader: CogpReader): CogpDatasetInfo {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < reader.numRowGroups; i++) {
    const bbox = reader.rowGroupEnvelope(i);
    if (!bbox) continue;
    minX = Math.min(minX, bbox.minX);
    minY = Math.min(minY, bbox.minY);
    maxX = Math.max(maxX, bbox.maxX);
    maxY = Math.max(maxY, bbox.maxY);
  }
  const dataBbox: [[number, number], [number, number]] | null = Number.isFinite(minX)
    ? [[minX, minY], [maxX, maxY]] : null;
  return { geo: reader.geo, numRowGroups: reader.numRowGroups, byteLength: reader.byteLength, dataBbox };
}
