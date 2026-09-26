import type { Color, Layer, PickingInfo } from '@deck.gl/core';
import {
  GeoArrowPathLayer,
  GeoArrowPolygonLayer,
  GeoArrowScatterplotLayer,
} from '@geoarrow/deck.gl-geoarrow';
import { tableFromIPC, type RecordBatch } from 'apache-arrow';

import type { ViewportBbox } from '../../shared/cogp-types';
import {
  openDataset as openCogpDataset,
  readBudget,
  type OpenResult,
} from '../../shared/dataset-service';
import { datasetFromQuery, selectPreset, writeDatasetQuery } from '../../shared/dataset-query';
import { attributeTooltip, createDeckMap, type Tooltip } from '../../shared/deck-map';
import { datasetName, escapeHtml, formatBytes, formatDistance } from '../../shared/format';
import { latitudeResolution } from '../../shared/tiles';

/** Where the map starts without a view in the URL: central Tokyo, covered by every sample. */
const START_BOUNDS: [[number, number], [number, number]] = [[139.68, 35.63], [139.82, 35.72]];
/** Row budgets on the slider, in 1-2-5 steps. */
const BUDGETS = [100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000];
/** Wait this long after the slider stops moving before reading. */
const BUDGET_DEBOUNCE_MS = 150;
/** `#max-level` values: no level limit (the default), or the level for the current zoom. */
const ALL_LEVELS = 'all';
const AUTO_LEVEL = 'auto';
const GEOMETRY_FIELD = 'geometry';
const LEVEL_FIELD = 'level';
/**
 * One blue ramp from dark (coarsest level) to light (finest level). Levels are
 * interpolated along it; the panel labels each level, so color never carries
 * identity alone.
 */
const LEVEL_RAMP = ['#0d366b', '#104281', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef'];

interface ActiveDataset {
  url: string;
  byteLength: number;
  summary: OpenResult['geo'];
  /** RGB per level, coarse first. */
  colors: [number, number, number][];
  revision: number;
}

let active: ActiveDataset | null = null;
let datasetRevision = 0;
let latestUrl = '';
let datasetLoadController: AbortController | null = null;
let readController: AbortController | null = null;
let budgetTimer: ReturnType<typeof setTimeout> | undefined;
/** Dataset, area and budget of the latest read, to skip a read that would repeat it. */
let requestedRead = '';

const mapEl = document.getElementById('map')!;
const aoiEl = document.getElementById('aoi')!;
const mapView = createDeckMap({
  parent: mapEl,
  getTooltip: renderTooltip,
  onViewSettled: () => void readArea(),
});

/**
 * The area of interest is the `#aoi` box, a fixed size on screen at the map
 * center, so zooming changes how much ground it covers.
 */
function aoi(): ViewportBbox {
  const canvas = mapEl.getBoundingClientRect();
  const box = aoiEl.getBoundingClientRect();
  const left = box.left - canvas.left;
  const top = box.top - canvas.top;
  const corners = [
    mapView.unproject([left, top]),
    mapView.unproject([left + box.width, top + box.height]),
  ];
  const [west, north] = corners[0]!;
  const [east, south] = corners[1]!;
  // An area crossing the antimeridian reads every longitude, as the other demos do.
  const wraps = west < -180 || east > 180;
  return {
    minX: wraps ? -180 : west,
    minY: Math.max(-90, south),
    maxX: wraps ? 180 : east,
    maxY: Math.min(90, north),
  };
}

function setDataLayer(layer: Layer | null): void {
  mapView.setLayers(layer ? [layer] : []);
}

function budget(): number {
  return BUDGETS[Number(budgetInput.value)] ?? BUDGETS[0]!;
}

/** The chosen level budget, or undefined to select the level for the zoom. */
function levelBudget(ds: ActiveDataset): number | undefined {
  if (maxLevelSelect.value === ALL_LEVELS) return ds.summary.lod.levels.length - 1;
  return maxLevelSelect.value === AUTO_LEVEL ? undefined : Number(maxLevelSelect.value);
}

/** Read the area with the current budget and replace the layer; the previous one stays until then. */
async function readArea(): Promise<void> {
  const ds = active;
  if (!ds) return;
  const bbox = aoi();
  const maxRows = budget();
  const maxLevel = levelBudget(ds);
  const { zoom, latitude } = mapView.viewState();
  const resolution = latitudeResolution(zoom, latitude);
  const key = JSON.stringify([ds.revision, bbox, maxLevel ?? resolution, maxRows]);
  // A resize or a settle without movement covers the same area; there is nothing new to read.
  if (key === requestedRead) return;
  requestedRead = key;
  readController?.abort();
  const controller = new AbortController();
  readController = controller;
  setStatus(`Reading up to ${maxRows.toLocaleString()} rows…`);
  try {
    const result = await readBudget(
      { url: ds.url, bbox, resolution, maxRows, ...(maxLevel === undefined ? {} : { maxLevel }) },
      controller.signal,
    );
    if (controller.signal.aborted || active !== ds) return;
    // toGeoArrow writes a single record batch.
    const batch = tableFromIPC(result.data).batches[0];
    setDataLayer(batch && batch.numRows ? geoArrowLayer(batch, ds) : null);

    const levels = ds.summary.lod.levels;
    let deepest = result.levelRows.length - 1;
    while (deepest >= 0 && !result.levelRows[deepest]) deepest--;
    const exhausted = result.rows >= maxRows;
    const allLevels = result.maxLevel === levels.length - 1;
    statFeatures.innerHTML = `${result.rows.toLocaleString()} features`
      + (exhausted
        ? ' <small>· row budget used up</small>'
        : allLevels
          ? ' <small>· every feature in the area</small>'
          : ` <small>· every feature up to level ${result.maxLevel + 1}</small>`);
    statLevel.innerHTML = maxLevelSelect.value === ALL_LEVELS
      ? `Unlimited <small>· all ${levels.length} levels</small>`
      : `${result.maxLevel + 1} of ${levels.length}`
        + (maxLevel === undefined ? ' <small>· selected for the zoom</small>' : '');
    statDeepest.innerHTML = deepest < 0
      ? '–'
      : `${deepest + 1}`
        + (exhausted && deepest < result.maxLevel ? ' <small>· row budget ran out first</small>' : '');
    autoOption.textContent = `Auto · level ${result.maxLevel + 1} for this zoom`;
    statFetched.innerHTML = `${formatBytes(result.network.bytes)} in ${result.network.requests.toLocaleString()} requests`
      + (result.network.requests ? '' : ' <small>· served from cache</small>');
    statTime.textContent = `${result.ms.toFixed(0)} ms read + encode`;
    renderLevels(result.levelRows, result.maxLevel, ds.colors);
    setStatus(datasetStatus(ds));
  } catch (err) {
    if (controller.signal.aborted || active !== ds) return;
    // Let the same area be tried again.
    requestedRead = '';
    console.error(err);
    setStatus(`Could not read the area: ${(err as Error).message}`, true);
  } finally {
    if (readController === controller) readController = null;
  }
}

/** One labeled bar per level, so the level of each color can be read without the map. */
function renderLevels(levelRows: number[], maxLevel: number, colors: [number, number, number][]): void {
  const max = Math.max(1, ...levelRows);
  levelList.innerHTML = levelRows
    .map((rows, level) => {
      const [r, g, b] = colors[level]!;
      // Levels past the level budget are never read, unlike levels the row budget ran out before.
      const excluded = level > maxLevel;
      return `<li class="${excluded ? 'empty excluded' : rows ? '' : 'empty'}">`
        + `<span class="name">Level ${level + 1}</span>`
        + `<span class="track"><span class="bar" style="width:${(rows / max) * 100}%;background:rgb(${r},${g},${b})"></span></span>`
        + `<span class="count">${excluded ? 'not read' : escapeHtml(rows.toLocaleString())}</span>`
        + '</li>';
    })
    .join('');
  levelsEl.hidden = false;
}

/**
 * Pick the GeoArrow layer for the batch's geometry type and color each row by
 * its level. The layer ID changes with the dataset so a new file never reuses a
 * layer of another class.
 */
function geoArrowLayer(batch: RecordBatch, ds: ActiveDataset): Layer {
  const extension = batch.schema.fields
    .find((field) => field.name === GEOMETRY_FIELD)
    ?.metadata.get('ARROW:extension:name');
  const levels = batch.getChild(LEVEL_FIELD)!.toArray() as Uint8Array;
  const fill = ({ index }: { index: number }): Color => [...ds.colors[levels[index]!]!, 150];
  const line = ({ index }: { index: number }): Color => [...ds.colors[levels[index]!]!, 255];
  const id = `cogp-${ds.revision}`;
  switch (extension) {
    case 'geoarrow.multipolygon':
      return new GeoArrowPolygonLayer({
        id,
        data: batch,
        filled: true,
        stroked: true,
        getFillColor: fill,
        getLineColor: line,
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
        getColor: line,
        widthUnits: 'pixels',
        getWidth: 2,
        pickable: true,
        autoHighlight: true,
      });
    case 'geoarrow.multipoint':
      return new GeoArrowScatterplotLayer({
        id,
        data: batch,
        getFillColor: line,
        getLineColor: [255, 255, 255, 255],
        stroked: true,
        radiusUnits: 'pixels',
        getRadius: 4,
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
  const { rowIndex, level } = row.toJSON() as { rowIndex?: bigint; level?: number };
  const entries: [string, unknown][] = [
    ['level', level === undefined ? '' : level + 1],
    ['row', rowIndex],
  ];
  return attributeTooltip(entries, true);
}

/** Colors for `count` levels, interpolated along the ramp from coarse to fine. */
function levelColors(count: number): [number, number, number][] {
  const stops = LEVEL_RAMP.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
  return Array.from({ length: count }, (_, level) => {
    const t = count > 1 ? (level / (count - 1)) * (stops.length - 1) : 0;
    const i = Math.min(Math.floor(t), stops.length - 2);
    const f = t - i;
    const [a, b] = [stops[i]!, stops[i + 1]!];
    return [0, 1, 2].map((c) => Math.round(a[c]! + (b[c]! - a[c]!) * f)) as [number, number, number];
  });
}

const presetSelect = document.getElementById('preset') as HTMLSelectElement;
const budgetInput = document.getElementById('budget') as HTMLInputElement;
const maxLevelSelect = document.getElementById('max-level') as HTMLSelectElement;
const allOption = maxLevelSelect.options[0]!;
const autoOption = maxLevelSelect.options[1]!;
const budgetValue = document.getElementById('budget-value') as HTMLOutputElement;
const flyBtn = document.getElementById('fly') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement;
const panel = document.getElementById('panel') as HTMLElement;
const panelToggle = document.getElementById('panel-toggle') as HTMLButtonElement;
const statsEl = document.getElementById('stats') as HTMLDListElement;
const statFeatures = document.getElementById('stat-features') as HTMLElement;
const statLevel = document.getElementById('stat-level') as HTMLElement;
const statDeepest = document.getElementById('stat-deepest') as HTMLElement;
const statFetched = document.getElementById('stat-fetched') as HTMLElement;
const statTime = document.getElementById('stat-time') as HTMLElement;
const levelsEl = document.getElementById('levels') as HTMLElement;
const levelList = document.getElementById('level-list') as HTMLOListElement;

function setStatus(msg: string, error = false): void {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', error);
}

function setPanelCollapsed(collapsed: boolean): void {
  panel.classList.toggle('collapsed', collapsed);
  panelToggle.setAttribute('aria-expanded', String(!collapsed));
  panelToggle.setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
}

function showBudget(): void {
  budgetValue.textContent = `${budget().toLocaleString()} rows`;
}

panelToggle.addEventListener('click', () => {
  setPanelCollapsed(!panel.classList.contains('collapsed'));
});

budgetInput.addEventListener('input', () => {
  showBudget();
  clearTimeout(budgetTimer);
  budgetTimer = setTimeout(() => void readArea(), BUDGET_DEBOUNCE_MS);
});

maxLevelSelect.addEventListener('change', () => void readArea());

presetSelect.addEventListener('change', () => void loadDataset(presetSelect.value));

/** One option per level of the dataset, after Unlimited and Auto; a fixed choice is kept when it still exists. */
function renderLevelOptions(levels: OpenResult['geo']['lod']['levels']): void {
  const previous = maxLevelSelect.value;
  allOption.textContent = `Unlimited · all ${levels.length} levels`;
  autoOption.textContent = 'Auto · level for the zoom';
  maxLevelSelect.replaceChildren(allOption, autoOption, ...levels.map((level, index) => {
    // Degrees per pixel, shown as approximate meters per pixel at the equator.
    const meters = formatDistance(level.resolution * 111_320);
    return new Option(`Level ${index + 1} · ≈ ${meters}/px`, String(index));
  }));
  const kept = previous === ALL_LEVELS || previous === AUTO_LEVEL || Number(previous) < levels.length;
  maxLevelSelect.value = kept ? previous : ALL_LEVELS;
}

flyBtn.addEventListener('click', () => mapView.fitBounds(START_BOUNDS, 1000));

async function loadDataset(url: string): Promise<void> {
  setStatus(`Opening ${datasetName(url)}…`);
  datasetLoadController?.abort();
  readController?.abort();
  const controller = new AbortController();
  datasetLoadController = controller;
  latestUrl = url;
  try {
    const { geo, byteLength } = await openCogpDataset(url, controller.signal);
    if (latestUrl !== url) return;
    active = {
      url,
      byteLength,
      summary: geo,
      colors: levelColors(geo.lod.levels.length),
      revision: ++datasetRevision,
    };
    writeDatasetQuery(url);
    setDataLayer(null);
    renderLevelOptions(geo.lod.levels);
    statsEl.hidden = false;
    levelsEl.hidden = true;
    for (const stat of [statFeatures, statLevel, statDeepest, statFetched, statTime]) stat.textContent = '–';
    await readArea();
  } catch (err) {
    if (latestUrl !== url) return;
    if (controller.signal.aborted) return;
    console.error(err);
    setStatus(`Could not open ${datasetName(url)}: ${(err as Error).message}`, true);
    active = null;
    statsEl.hidden = true;
    levelsEl.hidden = true;
    setDataLayer(null);
  } finally {
    if (datasetLoadController === controller) datasetLoadController = null;
  }
}

function datasetStatus(ds: ActiveDataset): string {
  return `${datasetName(ds.url)} · ${formatBytes(ds.byteLength)} · ${ds.summary.lod.levels.length} levels`;
}

showBudget();
// Keep a shared view from the URL; otherwise frame the area in central Tokyo.
if (!location.hash) mapView.fitBounds(START_BOUNDS);
setDataLayer(null);
// A shared link may name any COGP file, not only a preset.
const initialUrl = datasetFromQuery();
if (initialUrl) selectPreset(presetSelect, initialUrl, true);
void loadDataset(presetSelect.value);
