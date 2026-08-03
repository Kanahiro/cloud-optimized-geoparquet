import maplibregl, { type LngLatBoundsLike } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';

import {
  openDataset as openCogpDataset,
  readViewport,
  type MetadataSummary,
} from './dataset-service';

const COGP_SOURCE_ID = 'cogp';
const VIEWPORT_REFRESH_INTERVAL_MS = 150;

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

map.on('move', () => {
  if (active) {
    viewportToken += 1;
    requestViewportRefresh();
  }
});

function installCogpSource(): void {
  if (!map.isStyleLoaded()) return;
  removeCogpLayersAndSource();

  map.addSource(COGP_SOURCE_ID, {
    type: 'geojson',
    data: emptyFC(),
  });
  map.addLayer({
    id: 'cogp-fill',
    type: 'fill',
    source: COGP_SOURCE_ID,
    filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
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
    filter: ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'MultiLineString']],
    paint: {
      'line-color': '#1f3aa8',
      'line-width': 1.5,
    },
  });
  map.addLayer({
    id: 'cogp-point',
    type: 'circle',
    source: COGP_SOURCE_ID,
    filter: ['any', ['==', ['geometry-type'], 'Point'], ['==', ['geometry-type'], 'MultiPoint']],
    paint: {
      'circle-radius': 3,
      'circle-color': '#4a6cf7',
      'circle-stroke-color': '#1f3aa8',
      'circle-stroke-width': 1,
    },
  });

  viewportToken += 1;
  requestViewportRefresh(true);
}

function removeCogpLayersAndSource(): void {
  for (const layerId of ['cogp-point', 'cogp-line', 'cogp-fill']) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  if (map.getSource(COGP_SOURCE_ID)) map.removeSource(COGP_SOURCE_ID);
}

function emptyFC(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

let viewportToken = 0;
let viewportRefreshTimer: number | null = null;
let viewportRefreshInFlight = false;
let viewportRefreshRequested = false;
let lastViewportRefreshStartedAt = -Infinity;

function requestViewportRefresh(immediate = false): void {
  viewportRefreshRequested = true;
  if (viewportRefreshInFlight) return;

  if (viewportRefreshTimer !== null) {
    if (!immediate) return;
    clearTimeout(viewportRefreshTimer);
  }

  const elapsed = performance.now() - lastViewportRefreshStartedAt;
  const delay = immediate ? 0 : Math.max(0, VIEWPORT_REFRESH_INTERVAL_MS - elapsed);
  viewportRefreshTimer = window.setTimeout(() => {
    viewportRefreshTimer = null;
    void runViewportRefresh();
  }, delay);
}

async function runViewportRefresh(): Promise<void> {
  if (!viewportRefreshRequested || viewportRefreshInFlight) return;
  viewportRefreshRequested = false;
  viewportRefreshInFlight = true;
  lastViewportRefreshStartedAt = performance.now();
  try {
    await refreshViewport();
  } finally {
    viewportRefreshInFlight = false;
    if (viewportRefreshRequested) requestViewportRefresh();
  }
}

async function refreshViewport(): Promise<void> {
  const ds = active;
  if (!ds) return;
  const source = map.getSource(COGP_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (!source) return;
  const myToken = viewportToken;
  const b = map.getBounds();
  const bbox = {
    minX: b.getWest(),
    minY: b.getSouth(),
    maxX: b.getEast(),
    maxY: b.getNorth(),
  };
  try {
    const { data, status } = await readViewport(ds.url, bbox, metersPerCssPixel());
    if (myToken !== viewportToken || active?.url !== ds.url) return;
    source.setData(data);
    if (status) setStatus(status);
  } catch (err) {
    if (myToken !== viewportToken) return;
    console.error(err);
    setStatus(`Viewport read failed: ${(err as Error).message}`);
  }
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
      `Opened. ${summary.num_row_groups} row groups across ${summary.levels.length} levels.`,
    );
  } catch (err) {
    if (latestUrl !== url) return;
    console.error(err);
    setStatus(`Error: ${(err as Error).message}`);
    active = null;
    removeCogpLayersAndSource();
  } finally {
    if (latestUrl === url) loadBtn.disabled = false;
  }
}

function renderMetadata(summary: MetadataSummary): void {
  metaEl.textContent = JSON.stringify(summary, null, 2);
}

function metersPerCssPixel(): number {
  const sampleWidth = 100;
  const y = map.getContainer().clientHeight / 2;
  const left = map.unproject([0, y]);
  const right = map.unproject([sampleWidth, y]);
  return left.distanceTo(right) / sampleWidth;
}
