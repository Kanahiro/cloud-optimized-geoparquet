import maplibregl, { type LngLatBoundsLike } from 'maplibre-gl';
import { CogpReader } from 'cogp';
import type { Feature, FeatureCollection, Geometry } from 'geojson';

const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] };

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
    layers: [
      { id: 'osm', type: 'raster', source: 'osm' },
    ],
  },
  center: [0, 20],
  zoom: 2,
});

map.addControl(new maplibregl.NavigationControl({}), 'top-right');

map.on('load', () => {
  map.addSource('cogp', { type: 'geojson', data: EMPTY_FC });
  map.addLayer({
    id: 'cogp-fill',
    type: 'fill',
    source: 'cogp',
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
    source: 'cogp',
    filter: ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'MultiLineString']],
    paint: {
      'line-color': '#1f3aa8',
      'line-width': 1.5,
    },
  });
  map.addLayer({
    id: 'cogp-point',
    type: 'circle',
    source: 'cogp',
    filter: ['any', ['==', ['geometry-type'], 'Point'], ['==', ['geometry-type'], 'MultiPoint']],
    paint: {
      'circle-radius': 3,
      'circle-color': '#4a6cf7',
      'circle-stroke-color': '#1f3aa8',
      'circle-stroke-width': 1,
    },
  });
});

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
  reader: CogpReader;
  // Monotonic ID — increments on each viewport request so stale reads that
  // resolve after the user has moved on are dropped.
  loadId: number;
  // bbox of all row group envelopes, computed lazily.
  dataBbox: LngLatBoundsLike | null;
}

let active: ActiveDataset | null = null;

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
  try {
    const reader = await CogpReader.open(url);
    const dataBbox = computeDataBbox(reader);
    active = {
      reader,
      loadId: 0,
      dataBbox,
    };
    renderMetadata(reader);
    if (dataBbox) {
      map.fitBounds(dataBbox, { padding: 40, maxZoom: 14, animate: false });
    }
    setStatus(
      `Opened. ${reader.numRowGroups} row groups across ${reader.lods.length} LoDs.`,
    );
    await refreshViewport();
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${(err as Error).message}`);
    active = null;
  } finally {
    loadBtn.disabled = false;
  }
}

function renderMetadata(reader: CogpReader): void {
  const summary = {
    primary_column: reader.primaryGeometryColumn,
    num_row_groups: reader.numRowGroups,
    lods: reader.lods.map((l, i) => ({
      i,
      gsd: l.gsd,
      row_group_end: l.row_group_end,
    })),
    crs: reader.geo.columns[reader.primaryGeometryColumn]?.crs ?? null,
  };
  metaEl.textContent = JSON.stringify(summary, null, 2);
}

function computeDataBbox(reader: CogpReader): LngLatBoundsLike | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < reader.numRowGroups; i++) {
    const env = reader.rowGroupEnvelope(i);
    if (!env) continue;
    if (env.minX < minX) minX = env.minX;
    if (env.minY < minY) minY = env.minY;
    if (env.maxX > maxX) maxX = env.maxX;
    if (env.maxY > maxY) maxY = env.maxY;
  }
  if (!isFinite(minX)) return null;
  return [
    [minX, minY],
    [maxX, maxY],
  ];
}

map.on('moveend', () => {
  void refreshViewport();
});

async function refreshViewport(): Promise<void> {
  if (!active) return;
  const ds = active;
  const bounds = map.getBounds();
  const bbox = {
    minX: bounds.getWest(),
    minY: bounds.getSouth(),
    maxX: bounds.getEast(),
    maxY: bounds.getNorth(),
  };
  const gsd = gsdForViewport();
  const gsdLabel = formatGsd(gsd);
  const maxLod = ds.reader.selectLod(gsd);
  const myLoadId = ++ds.loadId;
  setStatus(`Reading at ${gsdLabel}/px (lod ≤ ${maxLod}) …`);
  try {
    const rows = await ds.reader.readRows({ bbox, maxLod });
    if (myLoadId !== ds.loadId) return; // a newer viewport superseded us
    const fc = rowsToFeatureCollection(rows, ds.reader.primaryGeometryColumn);
    const src = map.getSource('cogp') as maplibregl.GeoJSONSource | undefined;
    src?.setData(fc);
    setStatus(`Rendered ${fc.features.length} features at ${gsdLabel}/px (lod ≤ ${maxLod}).`);
  } catch (err) {
    console.warn('read failed', err);
    setStatus(`Read error: ${(err as Error).message}`);
  }
}

// hyparquet decodes geometry to GeoJSON Geometry directly; we just wrap each
// row as a Feature. `bigint` values (int64 columns) aren't JSON-serializable
// so MapLibre would choke on them — coerce to Number (precision loss past
// 2^53 is acceptable for rendering). `Uint8Array` blobs are dropped.
function rowsToFeatureCollection(
  rows: ReadonlyArray<Record<string, unknown>>,
  geomColumn: string,
): FeatureCollection {
  const features: Feature[] = [];
  for (const row of rows) {
    const geometry = row[geomColumn] as Geometry | null | undefined;
    if (!geometry) continue;
    const properties: Record<string, unknown> = {};
    for (const k in row) {
      if (k === geomColumn) continue;
      const v = row[k];
      if (typeof v === 'bigint') properties[k] = Number(v);
      else if (v instanceof Uint8Array) continue;
      else properties[k] = v;
    }
    features.push({ type: 'Feature', geometry, properties });
  }
  return { type: 'FeatureCollection', features };
}

// Target ground-sample distance (meters per physical screen pixel) at the
// current viewport center. `map.project` gives CSS-pixel coordinates and
// `LngLat.distanceTo` gives metric distance, so dividing them yields the
// effective resolution at this zoom and latitude — Mercator scale
// distortion is handled by MapLibre. Divide by `devicePixelRatio` to step
// from CSS pixels to physical screen pixels.
function gsdForViewport(): number {
  const center = map.getCenter();
  const east = new maplibregl.LngLat(center.lng + 0.001, center.lat);
  const p0 = map.project(center);
  const p1 = map.project(east);
  const dxCssPx = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const dxM = center.distanceTo(east);
  return dxM / dxCssPx / (window.devicePixelRatio || 1);
}

function formatGsd(gsdMeters: number): string {
  if (gsdMeters >= 1000) return `${(gsdMeters / 1000).toFixed(1)} km`;
  if (gsdMeters >= 1) return `${gsdMeters.toFixed(1)} m`;
  return `${(gsdMeters * 100).toFixed(1)} cm`;
}
