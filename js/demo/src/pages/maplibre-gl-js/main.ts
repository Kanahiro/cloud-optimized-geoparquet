import * as maplibregl from 'maplibre-gl';
import type { LngLatBoundsLike } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { cogpUrl, getCogpStats, inspectCogp, registerCogpProtocol, type CogpDatasetInfo } from '@cogp/maplibre';

import { datasetFromQuery, selectPreset, writeDatasetQuery } from '../../shared/dataset-query';
import { parseColumns } from '../../shared/columns';
import { datasetName, escapeHtml, formatBytes, formatDistance, formatPercent } from '../../shared/format';
import { latitudeResolution } from '../../shared/tiles';

// MapLibre v6 derives its worker URL from import.meta.url, which breaks once
// Vite bundles the library; hand it the Vite-built worker instead.
maplibregl.setWorkerUrl(maplibreWorkerUrl);
registerCogpProtocol(maplibregl);

const COGP_SOURCE_ID = 'cogp';
const COGP_LAYER_NAME = 'features';

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

function featureAt(e: maplibregl.MapMouseEvent): maplibregl.MapGeoJSONFeature | undefined {
  return map.queryRenderedFeatures(e.point, { layers: COGP_INTERACTIVE_LAYERS })[0];
}

/** Preview the attributes of the feature under the pointer, unless a popup is pinned. */
function previewPropertyPopup(e: maplibregl.MapMouseEvent): void {
  if (propertyPopupPinned) return;
  const feature = featureAt(e);
  if (!feature) {
    hidePropertyPopup();
    return;
  }
  const html = renderPropertiesHtml(feature.properties);
  if (propertyPopup) {
    propertyPopup.setLngLat(e.lngLat).setHTML(html);
    return;
  }
  propertyPopup = new maplibregl.Popup({ maxWidth: '320px', closeButton: false, closeOnClick: false })
    .setLngLat(e.lngLat)
    .setHTML(html)
    .addTo(map);
}

/** Pin the popup on click, so a long attribute list can be scrolled; clicking elsewhere closes it. */
function pinPropertyPopup(e: maplibregl.MapMouseEvent): void {
  hidePropertyPopup();
  const feature = featureAt(e);
  if (!feature) return;
  const popup = new maplibregl.Popup({ maxWidth: '320px', closeOnClick: false })
    .setLngLat(e.lngLat)
    .setHTML(renderPropertiesHtml(feature.properties))
    .addTo(map);
  popup.on('close', () => {
    if (propertyPopup !== popup) return;
    propertyPopup = null;
    propertyPopupPinned = false;
  });
  propertyPopup = popup;
  propertyPopupPinned = true;
}

function hidePropertyPopup(): void {
  const popup = propertyPopup;
  propertyPopup = null;
  propertyPopupPinned = false;
  popup?.remove();
}

function hidePreviewPropertyPopup(): void {
  if (!propertyPopupPinned) hidePropertyPopup();
}

map.on('mousemove', previewPropertyPopup);
map.on('click', pinPropertyPopup);
map.on('mouseout', hidePreviewPropertyPopup);
map.on('dragstart', hidePreviewPropertyPopup);

function renderPropertiesHtml(properties: Record<string, unknown> | null | undefined): string {
  if (!readAllColumnsInput.checked && appliedColumns.length === 0) {
    return '<div class="cogp-popup"><em>Enter column names to see this feature’s attributes.</em></div>';
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

map.on('load', () => {
  if (active) installCogpSource();
});
map.on('move', renderLevel);
map.on('idle', renderFeaturesInView);
map.on('idle', () => { void renderStats(); });

function installCogpSource(): void {
  if (!map.isStyleLoaded()) return;
  removeCogpLayersAndSource();
  if (!active) return;

  map.addSource(COGP_SOURCE_ID, {
    type: 'vector',
    tiles: [sourceUrl(active.url)],
    minzoom: 0,
    maxzoom: 24,
  });
  map.addLayer({
    id: 'cogp-fill',
    type: 'fill',
    source: COGP_SOURCE_ID,
    'source-layer': COGP_LAYER_NAME,
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
    'source-layer': COGP_LAYER_NAME,
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
    'source-layer': COGP_LAYER_NAME,
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

function sourceUrl(url: string): string {
  return cogpUrl({
    [COGP_LAYER_NAME]: readAllColumnsInput.checked
      ? { url }
      : { url, properties: Object.fromEntries(appliedColumns.map((column) => [column, column])) },
  });
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

async function renderStats(): Promise<void> {
  const ds = active;
  if (!ds) return;
  const { requests, bytes, tileMs } = await getCogpStats(ds.url);
  if (active !== ds) return;
  const share = ds.byteLength ? bytes / ds.byteLength : 0;
  statFetched.innerHTML = `${formatBytes(bytes)} in ${requests.toLocaleString()} requests`
    + (ds.byteLength ? ` <small>· ${formatPercent(share)} of ${formatBytes(ds.byteLength)}</small>` : '');
  if (tileMs.length) {
    const sorted = tileMs.sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    statTiles.innerHTML = `median ${at(0.5).toFixed(0)} ms · p90 ${at(0.9).toFixed(0)} ms`
      + ` <small>(${tileMs.length} tiles)</small>`;
  } else {
    statTiles.textContent = '–';
  }
}

const urlInput = document.getElementById('url') as HTMLInputElement;
const presetSelect = document.getElementById('preset') as HTMLSelectElement;
const loadBtn = document.getElementById('load') as HTMLButtonElement;
const flyBtn = document.getElementById('fly') as HTMLButtonElement;
const columnsInput = document.getElementById('columns') as HTMLInputElement;
const readAllColumnsInput = document.getElementById('read-all-columns') as HTMLInputElement;
const availableColumnsEl = document.getElementById('available-columns') as HTMLElement;
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
  summary: CogpDatasetInfo['geo'];
}

let active: ActiveDataset | null = null;
let latestUrl = '';
let datasetLoadController: AbortController | null = null;
let propertyPopup: maplibregl.Popup | null = null;
let propertyPopupPinned = false;
let appliedColumns: string[] = [];

columnsInput.addEventListener('change', () => {
  appliedColumns = parseColumns(columnsInput.value).filter((column) => column !== active?.summary.primary_column);
  refreshSourceColumns();
});

readAllColumnsInput.addEventListener('change', () => {
  columnsInput.disabled = readAllColumnsInput.checked;
  refreshSourceColumns();
});

function refreshSourceColumns(): void {
  hidePropertyPopup();
  const source = map.getSource(COGP_SOURCE_ID) as maplibregl.VectorTileSource | undefined;
  if (!source) return;
  if (active) source.setTiles([sourceUrl(active.url)]);
  void renderStats();
}

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

/** `keepView` leaves the map where it is instead of fitting it to the data. */
async function loadDataset(url: string, keepView = false): Promise<void> {
  if (!url) {
    setStatus('Enter a URL first.');
    return;
  }
  loadBtn.disabled = true;
  setStatus(`Opening ${datasetName(url)}…`);
  hidePropertyPopup();
  datasetLoadController?.abort();
  const controller = new AbortController();
  datasetLoadController = controller;
  latestUrl = url;
  try {
    const { geo, columnNames, numRowGroups, byteLength, dataBbox } = await inspectCogp(url, controller.signal);
    if (latestUrl !== url) return;
    active = {
      url,
      byteLength,
      dataBbox,
      summary: geo,
    };
    appliedColumns = parseColumns(columnsInput.value).filter((column) => column !== geo.primary_column);
    availableColumnsEl.textContent = `File columns: ${columnNames.join(', ')}`;
    availableColumnsEl.hidden = false;
    writeDatasetQuery(url);
    renderMetadata(geo);
    if (dataBbox && !keepView) {
      map.fitBounds(dataBbox, { padding: 40, maxZoom: 14, animate: false });
    }
    flyBtn.disabled = !dataBbox;
    installCogpSource();
    statsEl.hidden = false;
    renderLevel();
    void renderStats();
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
    availableColumnsEl.hidden = true;
    statsEl.hidden = true;
    flyBtn.disabled = true;
    removeCogpLayersAndSource();
  } finally {
    if (datasetLoadController === controller) datasetLoadController = null;
    if (latestUrl === url) loadBtn.disabled = false;
  }
}

function renderMetadata(summary: CogpDatasetInfo['geo']): void {
  metaEl.textContent = JSON.stringify(summary, null, 2);
}

// Reopen the dataset of a shared link, keeping its view when it has one.
const initialUrl = datasetFromQuery();
if (initialUrl) {
  urlInput.value = initialUrl;
  selectPreset(presetSelect, initialUrl);
  void loadDataset(initialUrl, Boolean(location.hash));
}
