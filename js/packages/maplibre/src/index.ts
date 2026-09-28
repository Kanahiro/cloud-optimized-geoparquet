import type { AddProtocolAction } from 'maplibre-gl';
import type { CogpDatasetInfo, CogpStats } from './messages.js';
import { callWorker } from './worker-client.js';
import { COGP_PROTOCOL, parseTileUrl } from './url.js';

export { cogpUrl } from './url.js';
export type { CogpLayerInput, CogpLayerOptions } from './url.js';
export type { CogpDatasetInfo, CogpStats } from './messages.js';

const registered = new WeakSet<object>();

/** Inspect a COGP file through the reader shared with vector tile requests. */
export async function inspectCogp(url: string, signal?: AbortSignal): Promise<CogpDatasetInfo> {
  const response = await callWorker({ type: 'inspect', url }, signal);
  if (!response.info) throw new Error('COGP worker returned no dataset info');
  return response.info;
}

/** Read cumulative range-transfer counts and recent tile times for one COGP file. */
export async function getCogpStats(url: string): Promise<CogpStats> {
  const response = await callWorker({ type: 'stats', url });
  if (!response.stats) throw new Error('COGP worker returned no stats');
  return response.stats;
}

const loadCogp: AddProtocolAction = async (request, abortController) => {
  if (request.type === 'arrayBuffer') {
    const { config, z, x, y } = parseTileUrl(request.url);
    const response = await callWorker({ type: 'tile', config, z, x, y }, abortController.signal);
    if (!response.data) throw new Error('COGP worker returned no tile data');
    return { data: response.data };
  }
  throw new Error(`Unsupported COGP resource type: ${request.type ?? 'undefined'}`);
};

/** Register the `cogp` URL scheme once per MapLibre GL JS module instance. */
export function registerCogpProtocol(maplibre: Pick<typeof import('maplibre-gl'), 'addProtocol'>): void {
  if (registered.has(maplibre)) return;
  maplibre.addProtocol(COGP_PROTOCOL, loadCogp);
  registered.add(maplibre);
}
