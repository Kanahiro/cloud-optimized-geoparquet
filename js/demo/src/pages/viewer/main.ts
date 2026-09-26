import * as maplibregl from 'maplibre-gl';
import type { LngLatBoundsLike } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

import {
  openDataset as openCogpDataset,
  readTile,
  type OpenResult,
} from '../../shared/dataset-service';
import { MVT_LAYER_NAME, type NetworkStats } from '../../shared/cogp-types';
import { latitudeResolution } from '../../shared/tiles';

// MapLibre v6 derives its worker URL from import.meta.url, which breaks once
// Vite bundles the library; hand it the Vite-built worker instead.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

const COGP_SOURCE_ID = 'cogp';
const COGP_PROTOCOL = 'cogp';

interface TileAddress {
  revision: number;
  z: number;
  x: number;
  y: number;
}

interface Stats {
  network: NetworkStats;
  /** Recent tile read + encode wall times. */
  tileMs: number[];
}

const RECENT_TILES = 200;

let datasetRevision = 0;
let stats: Stats = emptyStats();

maplibregl.addProtocol(COGP_PROTOCOL, async (params, abortController) => {
  const address = parseTileAddress(params.url);
  const ds = active;
  if (!ds || address.revision !== datasetRevision) {
    // AbortError keeps MapLibre from marking the tile errored; a reload
    // waiting on this tile would otherwise never start.
    throw new DOMException('Stale COGP tile request', 'AbortError');
  }

  const result = await readTile(
    ds.url,
    address.z,
    address.x,
    address.y,
    fetchPropertiesInput.checked,
    abortController.signal,
  );
  if (abortController.signal.aborted) {
    throw new DOMException('COGP tile request aborted', 'AbortError');
  }
  if (active?.url === ds.url && address.revision === datasetRevision) {
    // Tiles finish out of order; the largest snapshot is the latest total.
    if (result.network.requests >= stats.network.requests) stats.network = result.network;
    stats.tileMs.push(result.ms);
    if (stats.tileMs.length > RECENT_TILES) stats.tileMs.shift();
    renderStats();
  }
  return { data: result.data };
});

const map = new maplibregl.Map({
  container: 'map',
  hash: true,
  style: {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '&copy; OpenStreetMap contributors',
        maxzoom: 19,
      },
    },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
  },
  center: [0, 20],
  zoom: 2,
});

map.addControl(new maplibregl.NavigationControl({}), 'top-right');
map.addControl(new maplibregl.GlobeControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

const COGP_INTERACTIVE_LAYERS = ['cogp-fill', 'cogp-line', 'cogp-point'];

map.on('click', (e) => {
  const features = map.queryRenderedFeatures(e.point, { layers: COGP_INTERACTIVE_LAYERS });
  const feature = features[0];
  if (!feature) return;
  propertyPopup?.remove();
  propertyPopup = new maplibregl.Popup({ maxWidth: '320px' })
    .setLngLat(e.lngLat)
    .setHTML(renderPropertiesHtml(feature.properties))
    .addTo(map);
});

for (const layerId of COGP_INTERACTIVE_LAYERS) {
  map.on('mouseenter', layerId, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', layerId, () => {
    map.getCanvas().style.cursor = '';
  });
}

function renderPropertiesHtml(properties: Record<string, unknown> | null | undefined): string {
  if (!fetchPropertiesInput.checked) {
    return '<div class="cogp-popup"><em>Turn on “Fetch attributes” to see this feature’s attributes.</em></div>';
  }
  const entries = properties ? Object.entries(properties) : [];
  if (entries.length === 0) {
    return '<div class="cogp-popup"><em>No properties</em></div>';
  }
  entries.sort(([a], [b]) => a.localeCompare(b));
  const rows = entries
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v ?? ''))}</td></tr>`)
    .join('');
  return `<div class="cogp-popup"><table>${rows}</table></div>`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

map.on('load', () => {
  if (active) installCogpSource();
});
map.on('move', renderLevel);
map.on('idle', renderFeaturesInView);

function installCogpSource(): void {
  if (!map.isStyleLoaded()) return;
  removeCogpLayersAndSource();
  datasetRevision += 1;
  stats = emptyStats();

  map.addSource(COGP_SOURCE_ID, {
    type: 'vector',
    tiles: [`${COGP_PROTOCOL}://tiles/${datasetRevision}/{z}/{x}/{y}.pbf`],
    minzoom: 0,
    maxzoom: 24,
  });
  map.addLayer({
    id: 'cogp-fill',
    type: 'fill',
    source: COGP_SOURCE_ID,
    'source-layer': MVT_LAYER_NAME,
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: {
      'fill-color': '#4a6cf7',
      'fill-opacity': 0.35,
      'fill-outline-color': '#1f3aa8',
    },
  });
  map.addLayer({
    id: 'cogp-line',
    type: 'line',
    source: COGP_SOURCE_ID,
    'source-layer': MVT_LAYER_NAME,
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: {
      'line-color': '#1f3aa8',
      'line-width': 1.5,
    },
  });
  map.addLayer({
    id: 'cogp-point',
    type: 'circle',
    source: COGP_SOURCE_ID,
    'source-layer': MVT_LAYER_NAME,
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': 3,
      'circle-color': '#4a6cf7',
      'circle-stroke-color': '#1f3aa8',
      'circle-stroke-width': 1,
    },
  });
}

function removeCogpLayersAndSource(): void {
  for (const layerId of ['cogp-point', 'cogp-line', 'cogp-fill']) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  if (map.getSource(COGP_SOURCE_ID)) map.removeSource(COGP_SOURCE_ID);
}

function parseTileAddress(url: string): TileAddress {
  const match = /^cogp:\/\/tiles\/(\d+)\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url);
  if (!match) throw new Error(`Invalid COGP tile URL: ${url}`);
  return {
    revision: Number(match[1]),
    z: Number(match[2]),
    x: Number(match[3]),
    y: Number(match[4]),
  };
}

function emptyStats(): Stats {
  return { network: { requests: 0, bytes: 0 }, tileMs: [] };
}

/** Level the worker selects for tiles at the map center. */
function renderLevel(): void {
  const levels = active?.summary.lod.levels;
  if (!levels?.length) return;
  // Vector sources use 512 px tiles, requested at the floor of the map zoom.
  const z = Math.max(0, Math.floor(map.getZoom()));
  const target = latitudeResolution(z, map.getCenter().lat);
  let index = 0;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i]!.resolution >= target) index = i;
    else break;
  }
  // Degrees per pixel, shown as approximate meters per pixel at the equator.
  const meters = levels[index]!.resolution * 111_320;
  statLevel.innerHTML = `${index + 1} of ${levels.length} <small>· ≈ ${formatDistance(meters)}/px</small>`;
}

function renderFeaturesInView(): void {
  if (!active || !map.getSource(COGP_SOURCE_ID)) return;
  // Features crossing tile edges appear once per tile; row indexes are unique.
  const ids = new Set<unknown>();
  let unnamed = 0;
  for (const feature of map.queryRenderedFeatures({ layers: COGP_INTERACTIVE_LAYERS })) {
    if (feature.id === undefined) unnamed += 1;
    else ids.add(feature.id);
  }
  statFeatures.textContent = `${(ids.size + unnamed).toLocaleString()} features`;
}

function renderStats(): void {
  const { network, tileMs } = stats;
  const share = active?.byteLength ? network.bytes / active.byteLength : 0;
  statFetched.innerHTML = `${formatBytes(network.bytes)} in ${network.requests.toLocaleString()} requests`
    + (active?.byteLength ? ` <small>· ${formatPercent(share)} of ${formatBytes(active.byteLength)}</small>` : '');
  if (tileMs.length) {
    const sorted = [...tileMs].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    statTiles.innerHTML = `median ${at(0.5).toFixed(0)} ms · p90 ${at(0.9).toFixed(0)} ms`
      + ` <small>(${tileMs.length} tiles)</small>`;
  } else {
    statTiles.textContent = '–';
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function formatPercent(ratio: number): string {
  const percent = ratio * 100;
  return `${percent < 0.1 ? percent.toFixed(3) : percent.toFixed(1)}%`;
}

function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(meters >= 10_000 ? 0 : 1)} km`;
  if (meters >= 1) return `${meters.toFixed(meters >= 10 ? 0 : 1)} m`;
  return `${(meters * 100).toFixed(0)} cm`;
}

const urlInput = document.getElementById('url') as HTMLInputElement;
const presetSelect = document.getElementById('preset') as HTMLSelectElement;
const loadBtn = document.getElementById('load') as HTMLButtonElement;
const flyBtn = document.getElementById('fly') as HTMLButtonElement;
const fetchPropertiesInput = document.getElementById('fetch-properties') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement;
const metaEl = document.getElementById('meta') as HTMLPreElement;
const panel = document.getElementById('panel') as HTMLElement;
const panelToggle = document.getElementById('panel-toggle') as HTMLButtonElement;
const statsEl = document.getElementById('stats') as HTMLDListElement;
const statLevel = document.getElementById('stat-level') as HTMLElement;
const statFeatures = document.getElementById('stat-features') as HTMLElement;
const statFetched = document.getElementById('stat-fetched') as HTMLElement;
const statTiles = document.getElementById('stat-tiles') as HTMLElement;
const smallScreen = window.matchMedia('(max-width: 640px)');

function setStatus(msg: string, error = false): void {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', error);
}

function setPanelCollapsed(collapsed: boolean): void {
  panel.classList.toggle('collapsed', collapsed);
  panelToggle.setAttribute('aria-expanded', String(!collapsed));
  panelToggle.setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
}

panelToggle.addEventListener('click', () => {
  setPanelCollapsed(!panel.classList.contains('collapsed'));
});

interface ActiveDataset {
  url: string;
  byteLength: number;
  dataBbox: LngLatBoundsLike | null;
  summary: OpenResult['geo'];
}

let active: ActiveDataset | null = null;
let latestUrl = '';
let datasetLoadController: AbortController | null = null;
let propertyPopup: maplibregl.Popup | null = null;

fetchPropertiesInput.addEventListener('change', () => {
  propertyPopup?.remove();
  propertyPopup = null;
  const source = map.getSource(COGP_SOURCE_ID) as maplibregl.VectorTileSource | undefined;
  if (!source) return;
  // A new URL revision prevents reuse of tiles containing the previous attributes.
  // Network totals keep accumulating: the reader and its caches are unchanged.
  datasetRevision += 1;
  stats.tileMs = [];
  renderStats();
  source.setTiles([`${COGP_PROTOCOL}://tiles/${datasetRevision}/{z}/{x}/{y}.pbf`]);
});

loadBtn.addEventListener('click', () => {
  void loadDataset(urlInput.value.trim());
});

presetSelect.addEventListener('change', () => {
  const url = presetSelect.value;
  if (!url) return;
  urlInput.value = url;
  void loadDataset(url);
});

flyBtn.addEventListener('click', () => {
  if (!active?.dataBbox) return;
  map.fitBounds(active.dataBbox, { padding: 40, maxZoom: 14 });
});

async function loadDataset(url: string): Promise<void> {
  if (!url) {
    setStatus('Enter a URL first.');
    return;
  }
  loadBtn.disabled = true;
  setStatus(`Opening ${datasetName(url)}…`);
  propertyPopup?.remove();
  propertyPopup = null;
  datasetLoadController?.abort();
  const controller = new AbortController();
  datasetLoadController = controller;
  latestUrl = url;
  try {
    const { geo, numRowGroups, byteLength, dataBbox } = await openCogpDataset(url, controller.signal);
    if (latestUrl !== url) return;
    active = {
      url,
      byteLength,
      dataBbox,
      summary: geo,
    };
    renderMetadata(geo);
    if (dataBbox) {
      map.fitBounds(dataBbox, { padding: 40, maxZoom: 14, animate: false });
    }
    flyBtn.disabled = !dataBbox;
    installCogpSource();
    statsEl.hidden = false;
    renderLevel();
    renderStats();
    statFeatures.textContent = '–';
    setStatus(`${datasetName(url)} · ${formatBytes(byteLength)} · ${numRowGroups} row groups · ${geo.lod.levels.length} levels`);
    // Give the map the screen on phones once there is something to look at.
    if (smallScreen.matches) setPanelCollapsed(true);
  } catch (err) {
    if (latestUrl !== url) return;
    if (controller.signal.aborted) return;
    console.error(err);
    setStatus(`Could not open ${datasetName(url)}: ${(err as Error).message}`, true);
    active = null;
    statsEl.hidden = true;
    flyBtn.disabled = true;
    datasetRevision += 1;
    removeCogpLayersAndSource();
  } finally {
    if (datasetLoadController === controller) datasetLoadController = null;
    if (latestUrl === url) loadBtn.disabled = false;
  }
}

function datasetName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || url);
  } catch {
    return url;
  }
}

function renderMetadata(summary: OpenResult['geo']): void {
  metaEl.textContent = JSON.stringify(summary, null, 2);
}
