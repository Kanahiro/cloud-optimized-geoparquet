import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Bbox } from '@cogp/reader';
import { datasetFromQuery, selectPreset, writeDatasetQuery } from '../../shared/dataset-query';
import { datasetName, formatBytes } from '../../shared/format';
import type { Layout, PageLayout, QueryResult, Request, Response } from './model';

maplibregl.setWorkerUrl(maplibreWorkerUrl);
const hadInitialView = Boolean(location.hash);
const SAMPLE_ORIGIN = 'https://cogp-demo.spatialty.io';

function browserUrl(url: string): string {
  const parsed = new URL(url);
  return import.meta.env.DEV && parsed.origin === SAMPLE_ORIGIN
    ? new URL(`/cogp-sample${parsed.pathname}${parsed.search}`, location.origin).href
    : url;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const preset = $<HTMLSelectElement>('preset');
const urlInput = $<HTMLInputElement>('url');
const loadButton = $<HTMLButtonElement>('load');
const drawButton = $<HTMLButtonElement>('draw');
const maxLevelSelect = $<HTMLSelectElement>('max-level');
const useOverviewInput = $<HTMLInputElement>('use-overview');
const attributePicker = $<HTMLDetailsElement>('attribute-picker');
const attributeSummary = $<HTMLElement>('attribute-summary');
const attributeList = $<HTMLDivElement>('attribute-list');
const status = $<HTMLParagraphElement>('status');
const groupInput = $<HTMLInputElement>('group-id');
const overview = $<HTMLCanvasElement>('overview');
const levelSummary = $<HTMLDivElement>('level-summary');
const columnLayout = $<HTMLDivElement>('column-layout');
const showGroups = $<HTMLInputElement>('show-groups');
const showPages = $<HTMLInputElement>('show-pages');
const queryStats = $<HTMLDivElement>('query-stats');
const readBreakdown = $<HTMLDivElement>('read-breakdown');
const readList = $<HTMLDivElement>('read-list');
const readEmpty = $<HTMLParagraphElement>('read-empty');
const pageList = $<HTMLDivElement>('page-list');

const map = new maplibregl.Map({
  container: 'map', hash: true,
  style: { version: 8, sources: { osm: { type: 'raster',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256,
    attribution: '&copy; OpenStreetMap contributors' } },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }] },
  center: [139.75, 35.68], zoom: 10,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');

let worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let nextId = 0;
const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
let layout: Layout | null = null;
let pages: PageLayout[] = [];
let selectedGroup = 0;
let selectedPage = -1;
let query: QueryResult | null = null;
let drawn: Bbox | null = null;
let drawing = false;
let dragStart: [number, number] | null = null;
let loadRevision = 0;
let selectionRevision = 0;
let queryRevision = 0;

function attachWorker(): void {
  worker.onmessage = (event: MessageEvent<Response>) => {
    const response = event.data;
    const callback = pending.get(response.id);
    if (!callback) return;
    pending.delete(response.id);
    if (response.ok) callback.resolve(response.result as never);
    else callback.reject(new Error(response.error));
  };
}
attachWorker();

function call<T>(message: Omit<Extract<Request, { type: 'open' }>, 'id'>
  | Omit<Extract<Request, { type: 'pages' }>, 'id'>
  | Omit<Extract<Request, { type: 'query' }>, 'id'>): Promise<T> {
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: never) => void, reject });
    worker.postMessage({ ...message, id });
  });
}

function resetWorker(): void {
  worker.terminate();
  for (const p of pending.values()) p.reject(new Error('Dataset changed'));
  pending.clear();
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  attachWorker();
}

function setStatus(message: string, error = false): void {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function selectedAttributes(): string[] {
  return [...attributeList.querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value);
}

function updateAttributeSummary(): void {
  const names = selectedAttributes();
  attributeSummary.textContent = names.length === 0 ? 'Attributes · None'
    : names.length <= 2 ? `Attributes · ${names.join(', ')}` : `Attributes · ${names.length} selected`;
}

function renderAttributes(names: string[]): void {
  attributeList.replaceChildren(...names.map(name => {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox'; input.value = name; input.setAttribute('aria-label', name);
    label.append(input, document.createTextNode(name));
    return label;
  }));
  updateAttributeSummary();
}

function rectangle(bbox: Bbox, properties: Record<string, string | number> = {}): GeoJSON.Feature {
  const { minX, minY, maxX, maxY } = bbox;
  return { type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [[
    [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY],
  ]] } };
}

function source(id: string): maplibregl.GeoJSONSource | undefined {
  return map.getSource(id) as maplibregl.GeoJSONSource | undefined;
}

function setFeatures(id: string, features: GeoJSON.Feature[]): void {
  source(id)?.setData({ type: 'FeatureCollection', features });
}

map.on('load', () => {
  for (const name of ['groups', 'pages', 'selection', 'query']) {
    map.addSource(name, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }
  map.addLayer({ id: 'groups-fill', type: 'fill', source: 'groups', paint: { 'fill-color': '#2877ac', 'fill-opacity': .06 } });
  map.addLayer({ id: 'groups-line', type: 'line', source: 'groups', paint: { 'line-color': '#2877ac', 'line-width': 1, 'line-opacity': .5 } });
  map.addLayer({ id: 'pages-fill', type: 'fill', source: 'pages', paint: {
    'fill-color': ['case', ['get', 'read'], '#ec8925', '#4596c8'], 'fill-opacity': .12,
  } });
  map.addLayer({ id: 'pages-line', type: 'line', source: 'pages', paint: {
    'line-color': ['case', ['get', 'read'], '#dd7811', '#2475a3'], 'line-width': 1,
  } });
  map.addLayer({ id: 'selection-line', type: 'line', source: 'selection', paint: { 'line-color': '#17496d', 'line-width': 3 } });
  map.addLayer({ id: 'query-fill', type: 'fill', source: 'query', paint: { 'fill-color': '#f2a744', 'fill-opacity': .16 } });
  map.addLayer({ id: 'query-line', type: 'line', source: 'query', paint: { 'line-color': '#cf7016', 'line-width': 2 } });
  renderMap();
});

function renderMap(): void {
  if (!map.isStyleLoaded()) return;
  setFeatures('groups', showGroups.checked && layout
    ? layout.groups.flatMap(g => g.bbox ? [rectangle(g.bbox, { id: g.id })] : []) : []);
  setFeatures('pages', showPages.checked ? pages.flatMap(p => p.bbox
    ? [rectangle(p.bbox, { id: p.id, read: query?.pagesByGroup[selectedGroup]?.includes(p.id) ? 1 : 0 })] : []) : []);
  const group = layout?.groups[selectedGroup];
  setFeatures('selection', group?.bbox ? [rectangle(group.bbox)] : []);
  setFeatures('query', drawn ? [rectangle(drawn)] : []);
}

function bboxFromPoints(a: [number, number], b: [number, number]): Bbox {
  return { minX: Math.max(-180, Math.min(a[0], b[0])), minY: Math.max(-90, Math.min(a[1], b[1])),
    maxX: Math.min(180, Math.max(a[0], b[0])), maxY: Math.min(90, Math.max(a[1], b[1])) };
}

drawButton.addEventListener('click', () => {
  drawing = !drawing;
  dragStart = null;
  drawButton.classList.toggle('active', drawing);
  drawButton.textContent = drawing ? 'Cancel drawing' : 'Draw rectangle';
  map.getCanvas().style.cursor = drawing ? 'crosshair' : '';
  if (drawing) map.dragPan.disable(); else map.dragPan.enable();
});
map.on('mousedown', (event) => {
  if (!drawing) return;
  event.preventDefault();
  dragStart = [event.lngLat.lng, event.lngLat.lat];
});
map.on('mousemove', (event) => {
  if (!drawing || !dragStart) return;
  drawn = bboxFromPoints(dragStart, [event.lngLat.lng, event.lngLat.lat]);
  renderMap();
});
map.on('mouseup', (event) => {
  if (!drawing || !dragStart) return;
  drawn = bboxFromPoints(dragStart, [event.lngLat.lng, event.lngLat.lat]);
  dragStart = null;
  drawing = false;
  drawButton.classList.remove('active');
  drawButton.textContent = 'Draw rectangle';
  map.getCanvas().style.cursor = '';
  map.dragPan.enable();
  renderMap();
  if (drawn.maxX > drawn.minX && drawn.maxY > drawn.minY) void readRectangle(drawn);
});

async function readRectangle(bbox: Bbox): Promise<void> {
  if (!layout) return;
  const maxLevel = Number(maxLevelSelect.value);
  const useOverview = useOverviewInput.checked;
  const attributes = selectedAttributes();
  const revision = ++queryRevision;
  query = null;
  queryStats.hidden = true;
  readBreakdown.hidden = true;
  readList.hidden = true;
  readEmpty.hidden = false;
  renderMap();
  setStatus(`Reading ${useOverview ? 'overview' : 'primary'} geometry through level ${maxLevel + 1}…`);
  try {
    const result = await call<QueryResult>({ type: 'query', bbox, maxLevel, useOverview, attributes });
    if (revision !== queryRevision || layout?.url !== browserUrl(urlInput.value.trim())) return;
    query = result;
    queryStats.hidden = false;
    readEmpty.hidden = true;
    queryStats.innerHTML = [
      ['Fetched', formatBytes(result.fetchedBytes)],
      ['HTTP requests', result.requests.toLocaleString()],
      ['Rows', result.rows.toLocaleString()],
      ['Elapsed', `${result.ms.toFixed(0)} ms`],
      ['Geometry pages', `${result.geometryPageCount.toLocaleString()} · ${formatBytes(result.geometryPageBytes)}`],
      ['BBOX pages', `${result.bboxPageCount.toLocaleString()} · ${formatBytes(result.bboxPageBytes)}`],
      ['Attribute pages', `${result.attributePageCount.toLocaleString()} · ${formatBytes(result.attributePageBytes)}`],
      ['All data pages', `${result.dataPageCount.toLocaleString()} · ${formatBytes(result.dataPageBytes)}`],
      ['Row groups', result.groupIds.length.toLocaleString()],
      ['Level', `${result.maxLevel + 1} of ${layout.levels.length}`],
      ['Geometry', result.useOverview ? 'Overview' : 'Primary WKB'],
      ['Attributes', result.attributes.length.toLocaleString()],
      ['Full RG data', formatBytes(result.rowGroupBytes)],
    ].map(([label, value]) => `<div><strong>${value}</strong><small>${label}</small></div>`).join('');
    const otherBytes = Math.max(0, result.dataPageBytes - result.bboxPageBytes
      - result.geometryPageBytes - result.attributePageBytes);
    const total = result.dataPageBytes || 1;
    for (const [kind, bytes] of [['bbox', result.bboxPageBytes], ['geometry', result.geometryPageBytes],
      ['attributes', result.attributePageBytes], ['other', otherBytes]] as const) {
      const segment = readBreakdown.querySelector<HTMLElement>(`.breakdown-bar .${kind}`)!;
      segment.style.width = `${bytes / total * 100}%`;
      segment.title = `${kind}: ${formatBytes(bytes)}`;
    }
    readBreakdown.hidden = false;
    readList.hidden = false;
    readList.textContent = result.groupIds.length
      ? result.groupIds.map(id => `RG ${id}\n${result.columnPagesByGroup[id]!
        .map(read => `  ${read.column} · ${read.pageIds.length} pages · ${formatBytes(read.bytes)} · P${read.pageIds.join(',')}`).join('\n')}`).join('\n')
      : 'No data pages fetched.';
    setStatus(`Level ${result.maxLevel + 1} · ${result.useOverview ? 'overview' : 'primary WKB'} · ${result.attributes.length} attributes: read ${result.rows.toLocaleString()} rows in ${result.groupIds.length} row groups.`);
    renderMap(); renderPhysicalLayout(); renderPages();
  } catch (error) {
    if (revision === queryRevision && (error as Error).message !== 'Dataset changed')
      setStatus(`Read failed: ${(error as Error).message}`, true);
  }
}

async function load(url: string): Promise<void> {
  if (!url) return;
  const revision = ++loadRevision;
  ++queryRevision;
  resetWorker();
  layout = null; pages = []; query = null; drawn = null;
  attributePicker.open = false;
  renderAttributes([]);
  groupInput.disabled = true; drawButton.disabled = true; maxLevelSelect.disabled = true; useOverviewInput.disabled = true;
  maxLevelSelect.replaceChildren();
  queryStats.hidden = true;
  readBreakdown.hidden = true;
  readList.hidden = true;
  readEmpty.hidden = false;
  setStatus(`Opening ${datasetName(url)}…`);
  renderMap(); renderPhysicalLayout(); renderPages();
  try {
    const result = await call<Layout>({ type: 'open', url: browserUrl(url) });
    if (revision !== loadRevision) return;
    layout = result;
    renderAttributes(result.attributes);
    urlInput.value = url;
    writeDatasetQuery(url);
    selectPreset(preset, url);
    groupInput.max = String(result.groups.length - 1);
    maxLevelSelect.replaceChildren(...result.levels.map((level, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      const rows = result.groups.slice(0, level.rowGroupEnd + 1)
        .reduce((sum, group) => sum + group.rows, 0);
      option.textContent = `Level ${index + 1} of ${result.levels.length} · RG 0–${level.rowGroupEnd} · ${rows.toLocaleString()} rows`;
      return option;
    }));
    maxLevelSelect.value = '0';
    useOverviewInput.checked = result.overviewColumn !== null;
    useOverviewInput.disabled = result.overviewColumn === null;
    groupInput.disabled = false; drawButton.disabled = false; maxLevelSelect.disabled = false;
    $('group-total').textContent = `/ ${result.groups.length - 1}`;
    $('file-size').textContent = formatBytes(result.byteLength);
    $('file-end').textContent = formatBytes(result.byteLength);
    setStatus(`${datasetName(url)} · ${result.groups.length.toLocaleString()} row groups · ${formatBytes(result.byteLength)}`);
    if (result.dataBbox && !hadInitialView) {
      const b = result.dataBbox;
      map.fitBounds([[b.minX, b.minY], [b.maxX, b.maxY]], { padding: 65, maxZoom: 13 });
    }
    renderMap(); renderPhysicalLayout();
    void selectGroup(0);
  } catch (error) {
    if (revision === loadRevision) setStatus(`Could not open dataset: ${(error as Error).message}. The URL must permit browser CORS and byte Range requests.`, true);
  }
}

async function selectGroup(id: number): Promise<void> {
  if (!layout || !Number.isSafeInteger(id) || id < 0 || id >= layout.groups.length) return;
  selectedGroup = id; selectedPage = -1; pages = [];
  groupInput.value = String(id);
  const group = layout.groups[id]!;
  const indexBytes = group.columns.reduce((sum, column) => sum
    + (column.columnIndex ? column.columnIndex.end - column.columnIndex.start : 0)
    + (column.offsetIndex ? column.offsetIndex.end - column.offsetIndex.start : 0), 0);
  $('group-details').textContent = `Level ${group.level + 1} · ${group.rows.toLocaleString()} rows · ${formatBytes(group.end - group.start)} data span · ${formatBytes(indexBytes)} indexes`;
  renderMap(); renderPhysicalLayout(); renderPages();
  const revision = ++selectionRevision;
  try {
    const result = await call<PageLayout[]>({ type: 'pages', groupId: id });
    if (revision !== selectionRevision) return;
    pages = result;
    renderMap(); renderPhysicalLayout(); renderPages();
  } catch (error) {
    if (revision === selectionRevision) $('page-list').textContent = `Page indexes unavailable: ${(error as Error).message}`;
  }
}

function renderPages(): void {
  if (!layout) { pageList.textContent = 'Open a dataset.'; $('page-count').textContent = ''; return; }
  $('page-count').textContent = `${pages.length.toLocaleString()} pages`;
  pageList.replaceChildren(...pages.map(page => {
    const button = document.createElement('button');
    button.className = 'page-item' + (page.id === selectedPage ? ' selected' : '')
      + (query?.pagesByGroup[selectedGroup]?.includes(page.id) ? ' read' : '');
    button.innerHTML = `<span>Page ${page.id} <small>rows ${page.rowStart.toLocaleString()}–${page.rowEnd.toLocaleString()}</small></span><small>${formatBytes(page.end - page.start)}</small>`;
    button.addEventListener('click', () => {
      selectedPage = page.id;
      renderPages(); renderPhysicalLayout();
      if (page.bbox) map.fitBounds([[page.bbox.minX, page.bbox.minY], [page.bbox.maxX, page.bbox.maxY]], { padding: 90, maxZoom: 15 });
    });
    return button;
  }));
}

function context(canvas: HTMLCanvasElement, height: number): CanvasRenderingContext2D {
  const width = canvas.clientWidth;
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.font = '11px ui-monospace, monospace';
  return ctx;
}

function renderPhysicalLayout(): void {
  const o = context(overview, 112);
  const ow = overview.clientWidth;
  o.fillStyle = '#f3f7f9'; o.fillRect(0, 0, ow, 112);
  if (!layout) { levelSummary.replaceChildren(); columnLayout.replaceChildren(); return; }
  const full = layout.byteLength;
  o.fillStyle = '#60778a';
  o.fillText('ROW GROUP DATA', 9, 19);
  o.fillText('PAGE INDEXES', 9, 106);
  for (const group of layout.groups) {
    const x = group.start / full * ow, w = Math.max(1, (group.end - group.start) / full * ow);
    o.fillStyle = query?.groupIds.includes(group.id) ? '#e58c25' : group.level % 2 ? '#66a4ca' : '#2877ac';
    o.fillRect(x, 30, w, 50);
    o.fillStyle = '#7862a8';
    for (const column of group.columns) {
      for (const index of [column.columnIndex, column.offsetIndex]) {
        if (index) o.fillRect(index.start / full * ow, 84, Math.max(1, (index.end - index.start) / full * ow), 9);
      }
    }
  }
  o.fillStyle = '#173d58';
  o.fillRect(layout.footer.start / full * ow, 30, Math.max(2, (full - layout.footer.start) / full * ow), 63);
  const selected = layout.groups[selectedGroup];
  if (!selected) return;
  o.strokeStyle = '#102d42'; o.lineWidth = 2;
  o.strokeRect(selected.start / full * ow, 25, Math.max(3, (selected.end - selected.start) / full * ow), 58);

  levelSummary.replaceChildren(...layout.levels.map((level, index) => {
    const first = index ? layout!.levels[index - 1]!.rowGroupEnd + 1 : 0;
    const groups = layout!.groups.slice(first, level.rowGroupEnd + 1);
    const bytes = groups.reduce((sum, group) => sum + group.columns.reduce((n, column) => n + column.end - column.start, 0), 0);
    const rows = groups.reduce((sum, group) => sum + group.rows, 0);
    const button = document.createElement('button');
    button.className = `level-chip${selected.level === index ? ' selected' : ''}`;
    button.textContent = `L${index + 1} · ${formatBytes(bytes)}`;
    button.title = `RG ${first}–${level.rowGroupEnd} · ${rows.toLocaleString()} rows · resolution ${level.resolution}`;
    button.addEventListener('click', () => void selectGroup(first));
    return button;
  }));

  const span = selected.end - selected.start || 1;
  const readColumns = new Set(query?.columnPagesByGroup[selectedGroup]?.map(read => read.column) ?? []);
  const scrollTop = columnLayout.scrollTop;
  columnLayout.replaceChildren(...selected.columns.map(column => {
    const row = document.createElement('div');
    const geometry = column.name === layout!.geometryColumn || column.name.startsWith(`${layout!.geometryColumn}.`)
      || !!layout!.overviewColumn && (column.name === layout!.overviewColumn || column.name.startsWith(`${layout!.overviewColumn}.`));
    const bbox = layout!.bboxColumns.includes(column.name);
    row.className = `column-row${geometry ? ' geometry' : ''}${bbox ? ' bbox' : ''}${readColumns.has(column.name) ? ' read' : ''}`;
    const name = document.createElement('span');
    name.className = 'column-name'; name.textContent = column.name;
    const track = document.createElement('span');
    track.className = 'column-track';
    const bar = document.createElement('span');
    bar.className = 'column-bar';
    bar.style.left = `${(column.start - selected.start) / span * 100}%`;
    bar.style.width = `${(column.end - column.start) / span * 100}%`;
    track.append(bar);
    if (column.name === layout!.geometryColumn) for (const page of pages) {
      const tick = document.createElement('span');
      tick.className = `column-tick${page.id === selectedPage ? ' selected' : ''}`;
      tick.style.left = `${(page.start - selected.start) / span * 100}%`;
      tick.title = `Page ${page.id} · ${formatBytes(page.end - page.start)}`;
      track.append(tick);
    }
    const size = document.createElement('span');
    size.className = 'size'; size.textContent = formatBytes(column.end - column.start);
    row.append(name, track, size);
    row.title = `${column.name}\n${formatBytes(column.start)}–${formatBytes(column.end)} in file`;
    row.addEventListener('mouseenter', () => {
      $('layout-hover').textContent = `${column.name} · offset ${column.start.toLocaleString()}–${column.end.toLocaleString()} · ${formatBytes(column.end - column.start)}`;
    });
    return row;
  }));
  columnLayout.scrollTop = scrollTop;
}

overview.addEventListener('click', event => {
  if (!layout) return;
  const x = (event.offsetX / overview.clientWidth) * layout.byteLength;
  const group = layout.groups.find(g => g.start <= x && x < g.end);
  if (group) void selectGroup(group.id);
});
overview.addEventListener('mousemove', event => {
  if (!layout) return;
  const offset = event.offsetX / overview.clientWidth * layout.byteLength;
  const group = layout.groups.find(g => g.start <= offset && offset < g.end);
  $('layout-hover').textContent = group
    ? `RG ${group.id} · level ${group.level + 1} · offset ${group.start.toLocaleString()}–${group.end.toLocaleString()} · ${formatBytes(group.end - group.start)}`
    : `File offset ${offset.toLocaleString()}`;
});
groupInput.addEventListener('change', () => void selectGroup(Number(groupInput.value)));
showGroups.addEventListener('change', renderMap);
showPages.addEventListener('change', renderMap);
maxLevelSelect.addEventListener('change', () => { if (drawn) void readRectangle(drawn); });
useOverviewInput.addEventListener('change', () => { if (drawn) void readRectangle(drawn); });
attributeList.addEventListener('change', updateAttributeSummary);
$<HTMLButtonElement>('attribute-all').addEventListener('click', () => {
  attributeList.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.checked = true; });
  updateAttributeSummary();
});
$<HTMLButtonElement>('attribute-none').addEventListener('click', () => {
  attributeList.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.checked = false; });
  updateAttributeSummary();
});
$<HTMLButtonElement>('attribute-apply').addEventListener('click', () => {
  attributePicker.open = false;
  if (drawn) void readRectangle(drawn);
});
loadButton.addEventListener('click', () => void load(urlInput.value.trim()));
urlInput.addEventListener('keydown', event => { if (event.key === 'Enter') void load(urlInput.value.trim()); });
preset.addEventListener('change', () => { if (preset.value) void load(preset.value); });
new ResizeObserver(() => renderPhysicalLayout()).observe(overview);
new ResizeObserver(() => map.resize()).observe($<HTMLDivElement>('map'));

const initial = datasetFromQuery() ?? preset.value;
urlInput.value = initial;
void load(initial);
