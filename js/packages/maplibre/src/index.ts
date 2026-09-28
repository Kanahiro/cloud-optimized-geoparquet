import type { AddProtocolAction } from 'maplibre-gl';
import { callWorker } from './worker-client.js';
import { COGP_PROTOCOL, parseTileUrl } from './url.js';

export { cogpUrl, COGP_SOURCE_LAYER } from './url.js';
export type { CogpLayerInput, CogpLayerOptions } from './url.js';

const registered = new WeakSet<object>();

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
