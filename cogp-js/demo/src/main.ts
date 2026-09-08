import maplibregl, { type LngLatBoundsLike } from 'maplibre-gl';

import {
  openDataset as openCogpDataset,
  readTile,
  type MetadataSummary,
} from './dataset-service';
import { MVT_LAYER_NAME } from './cogp-types';

const COGP_SOURCE_ID = 'cogp';
const COGP_PROTOCOL = 'cogp';

interface TileAddress {
  revision: number;
  z: number;
  x: number;
  y: number;
}

interface TileStats {
  tiles: number;
  features: number;
  bytes: number;
  readMs: number;
  encodeMs: number;
}

let datasetRevision = 0;
let tileStats: TileStats = emptyTileStats();

maplibregl.addProtocol(COGP_PROTOCOL, async (params, abortController) => {
  const address = parseTileAddress(params.url);
  const ds = active;
  if (!ds || address.revision !== datasetRevision) {
    throw new Error('Stale COGP tile request');
  }

  const result = await readTile(
    ds.url,
    address.z,
    address.x,
    address.y,
    abortController.signal,
  );
  if (abortController.signal.aborted) {
    throw new DOMException('COGP tile request aborted', 'AbortError');
  }
  if (active?.url === ds.url && address.revision === datasetRevision) {
    tileStats.tiles += 1;
    tileStats.features += result.featureCount;
    tileStats.bytes += result.data.byteLength;
    tileStats.readMs += result.readMs;
    tileStats.encodeMs += result.encodeMs;
    reportTileStats(result.maxLevel);
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
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

const COGP_INTERACTIVE_LAYERS = ['cogp-fill', 'cogp-line', 'cogp-point'];

map.on('click', (e) => {
  const features = map.queryRenderedFeatures(e.point, { layers: COGP_INTERACTIVE_LAYERS });
  const feature = features[0];
  if (!feature) return;
  new maplibregl.Popup({ maxWidth: '360px' })
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
  const entries = properties ? Object.entries(properties) : [];
  if (entries.length === 0) {
    return '<div class="cogp-popup"><em>No properties</em></div>';
  }
  entries.sort(([a], [b]) => a.localeCompare(b));
  const rows = entries
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(formatValue(v))}</td></tr>`)
    .join('');
  return `<div class="cogp-popup"><table>${rows}</table></div>`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `<bytes:${value.byteLength}>`;
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return String(value);
  }
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

function installCogpSource(): void {
  if (!map.isStyleLoaded()) return;
  removeCogpLayersAndSource();
  datasetRevision += 1;
  tileStats = emptyTileStats();

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

function emptyTileStats(): TileStats {
  return { tiles: 0, features: 0, bytes: 0, readMs: 0, encodeMs: 0 };
}

function reportTileStats(maxLevel: number): void {
  setStatus(
    `Rendered ${tileStats.tiles} MVT tiles from ${tileStats.features.toLocaleString()} source features ` +
      `(${formatBytes(tileStats.bytes)} PBF, level <= ${maxLevel}). ` +
      `COGP reads: ${tileStats.readMs.toFixed(0)} ms total; MVT encoding: ${tileStats.encodeMs.toFixed(0)} ms total.`,
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

const urlInput = document.getElementById('url') as HTMLInputElement;
const presetSelect = document.getElementById('preset') as HTMLSelectElement;
const loadBtn = document.getElementById('load') as HTMLButtonElement;
const flyBtn = document.getElementById('fly') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const metaEl = document.getElementById('meta') as HTMLPreElement;

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

interface ActiveDataset {
  url: string;
  dataBbox: LngLatBoundsLike | null;
  summary: MetadataSummary;
}

let active: ActiveDataset | null = null;
let latestUrl = '';

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
  if (!active?.dataBbox) {
    setStatus('No data bbox available yet.');
    return;
  }
  map.fitBounds(active.dataBbox, { padding: 40, maxZoom: 14 });
});

async function loadDataset(url: string): Promise<void> {
  if (!url) {
    setStatus('Enter a URL first.');
    return;
  }
  loadBtn.disabled = true;
  setStatus(`Opening ${url} …`);
  latestUrl = url;
  try {
    const { summary, dataBbox } = await openCogpDataset(url);
    if (latestUrl !== url) return;
    active = {
      url,
      dataBbox,
      summary,
    };
    renderMetadata(summary);
    if (dataBbox) {
      map.fitBounds(dataBbox, { padding: 40, maxZoom: 14, animate: false });
    }
    installCogpSource();
    setStatus(
      `Opened. ${summary.num_row_groups} row groups across ${summary.levels.length} levels; requesting MVT tiles.`,
    );
  } catch (err) {
    if (latestUrl !== url) return;
    console.error(err);
    setStatus(`Error: ${(err as Error).message}`);
    active = null;
    datasetRevision += 1;
    removeCogpLayersAndSource();
  } finally {
    if (latestUrl === url) loadBtn.disabled = false;
  }
}

function renderMetadata(summary: MetadataSummary): void {
  metaEl.textContent = JSON.stringify(summary, null, 2);
}
