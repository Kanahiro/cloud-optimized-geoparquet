import type { Layer, PickingInfo } from '@deck.gl/core';
import {
  GeoArrowPathLayer,
  GeoArrowPolygonLayer,
  GeoArrowScatterplotLayer,
} from '@geoarrow/deck.gl-geoarrow';
import { tableFromIPC, type RecordBatch } from 'apache-arrow';

import {
  openDataset as openCogpDataset,
  readArrow,
  type OpenResult,
} from '../../shared/dataset-service';
import { attributeTooltip, createDeckMap, FILL, LINE, type Tooltip } from '../../shared/deck-map';
import { datasetName, formatBytes, formatDistance, formatPercent } from '../../shared/format';
import { latitudeResolution } from '../../shared/tiles';

/** Upper bound on rows per view, so a coarse view of a large file stays responsive. */
const MAX_ROWS = 200_000;
const GEOMETRY_FIELD = 'geometry';

interface ActiveDataset {
  url: string;
  byteLength: number;
  dataBbox: [[number, number], [number, number]] | null;
  summary: OpenResult['geo'];
  revision: number;
}

let active: ActiveDataset | null = null;
let datasetRevision = 0;
let latestUrl = '';
let datasetLoadController: AbortController | null = null;
let viewController: AbortController | null = null;

const map = createDeckMap({
  parent: document.getElementById('map')!,
  getTooltip: renderTooltip,
  onViewSettled: () => void readView(),
});

/** Read the current view as GeoArrow and replace the layer; the previous one stays until then. */
async function readView(): Promise<void> {
  const ds = active;
  if (!ds) return;
  viewController?.abort();
  const controller = new AbortController();
  viewController = controller;
  const { zoom, latitude } = map.viewState();
  const resolution = latitudeResolution(zoom, latitude);
  setStatus('Reading view…');
  try {
    const result = await readArrow({
      url: ds.url,
      bbox: map.viewportBbox(),
      resolution,
      maxRows: MAX_ROWS,
      fetchProperties: fetchPropertiesInput.checked,
    }, controller.signal);
    if (controller.signal.aborted || active !== ds) return;
    const decodeStartedAt = performance.now();
    // toGeoArrow writes a single record batch.
    const batch = tableFromIPC(result.data).batches[0];
    map.setLayers(batch && batch.numRows ? [geoArrowLayer(batch, ds.revision)] : []);
    const decodeMs = performance.now() - decodeStartedAt;

    const levels = ds.summary.lod.levels;
    // Degrees per pixel, shown as approximate meters per pixel at the equator.
    const meters = (levels[result.level]?.resolution ?? 0) * 111_320;
    statLevel.innerHTML = `${result.level + 1} of ${levels.length} <small>· ≈ ${formatDistance(meters)}/px</small>`;
    statFeatures.innerHTML = `${result.rows.toLocaleString()} features`
      + (result.rows >= MAX_ROWS ? ` <small>· capped at ${MAX_ROWS.toLocaleString()}</small>` : '');
    statArrow.innerHTML = `${formatBytes(result.data.byteLength)} <small>· decoded in ${decodeMs.toFixed(0)} ms</small>`;
    const share = ds.byteLength ? result.network.bytes / ds.byteLength : 0;
    statFetched.innerHTML = `${formatBytes(result.network.bytes)} in ${result.network.requests.toLocaleString()} requests`
      + (ds.byteLength ? ` <small>· ${formatPercent(share)} of ${formatBytes(ds.byteLength)}</small>` : '');
    statTime.textContent = `${result.ms.toFixed(0)} ms read + encode`;
    setStatus(datasetStatus(ds));
  } catch (err) {
    if (controller.signal.aborted || active !== ds) return;
    console.error(err);
    setStatus(`Could not read this view: ${(err as Error).message}`, true);
  } finally {
    if (viewController === controller) viewController = null;
  }
}

/**
 * Pick the GeoArrow layer for the batch's geometry type. `toGeoArrow` always
 * writes multi types; the layer ID changes with the dataset so a new file never
 * reuses a layer of another class.
 */
function geoArrowLayer(batch: RecordBatch, revision: number): Layer {
  const extension = batch.schema.fields
    .find((field) => field.name === GEOMETRY_FIELD)
    ?.metadata.get('ARROW:extension:name');
  const id = `cogp-${revision}`;
  switch (extension) {
    case 'geoarrow.multipolygon':
      return new GeoArrowPolygonLayer({
        id,
        data: batch,
        filled: true,
        stroked: true,
        getFillColor: FILL,
        getLineColor: LINE,
        lineWidthUnits: 'pixels',
        getLineWidth: 1,
        pickable: true,
        autoHighlight: true,
        // Triangulate on the main thread instead of loading a worker from a CDN.
        earcutWorkerUrl: null,
      });
    case 'geoarrow.multilinestring':
      return new GeoArrowPathLayer({
        id,
        data: batch,
        getColor: LINE,
        widthUnits: 'pixels',
        getWidth: 1.5,
        pickable: true,
        autoHighlight: true,
      });
    case 'geoarrow.multipoint':
      return new GeoArrowScatterplotLayer({
        id,
        data: batch,
        getFillColor: FILL,
        getLineColor: LINE,
        stroked: true,
        radiusUnits: 'pixels',
        getRadius: 3,
        lineWidthUnits: 'pixels',
        getLineWidth: 1,
        pickable: true,
        autoHighlight: true,
      });
    default:
      throw new Error(`unexpected GeoArrow type ${extension ?? '(none)'}`);
  }
}

function renderTooltip(info: PickingInfo): Tooltip {
  const row = info.object as { toJSON(): Record<string, unknown> } | undefined;
  if (!row) return null;
  const entries = Object.entries(row.toJSON()).filter(([key]) => key !== GEOMETRY_FIELD);
  return attributeTooltip(entries, fetchPropertiesInput.checked);
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
const statArrow = document.getElementById('stat-arrow') as HTMLElement;
const statFetched = document.getElementById('stat-fetched') as HTMLElement;
const statTime = document.getElementById('stat-time') as HTMLElement;
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

fetchPropertiesInput.addEventListener('change', () => void readView());

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
  map.fitBounds(active.dataBbox, 1000);
});

async function loadDataset(url: string): Promise<void> {
  if (!url) {
    setStatus('Enter a URL first.');
    return;
  }
  loadBtn.disabled = true;
  setStatus(`Opening ${datasetName(url)}…`);
  datasetLoadController?.abort();
  viewController?.abort();
  const controller = new AbortController();
  datasetLoadController = controller;
  latestUrl = url;
  try {
    const { geo, byteLength, dataBbox } = await openCogpDataset(url, controller.signal);
    if (latestUrl !== url) return;
    active = { url, byteLength, dataBbox, summary: geo, revision: ++datasetRevision };
    map.setLayers([]);
    metaEl.textContent = JSON.stringify(geo, null, 2);
    flyBtn.disabled = !dataBbox;
    statsEl.hidden = false;
    for (const stat of [statLevel, statFeatures, statArrow, statFetched, statTime]) stat.textContent = '–';
    if (dataBbox) map.fitBounds(dataBbox);
    else void readView();
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
    map.setLayers([]);
  } finally {
    if (datasetLoadController === controller) datasetLoadController = null;
    if (latestUrl === url) loadBtn.disabled = false;
  }
}

function datasetStatus(ds: ActiveDataset): string {
  return `${datasetName(ds.url)} · ${formatBytes(ds.byteLength)} · ${ds.summary.lod.levels.length} levels`;
}
