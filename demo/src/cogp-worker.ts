/// <reference lib="webworker" />
import { CogpReader } from 'cogp';
import type { Feature, Geometry } from 'geojson';

import type {
  MetadataSummary,
  OpenResult,
  ViewportBbox,
  ViewportResult,
  WorkerEnvelope,
  WorkerResponse,
} from './cogp-types';

const VIEWPORT_MAX_ROWS = 100_000;
const VIEWPORT_MAX_ROW_WKB_BYTES = 20_000_000;

interface ActiveDataset {
  url: string;
  reader: CogpReader;
  dataBbox: [[number, number], [number, number]] | null;
  bboxStructTop: string | null;
  servedViewports: number;
}

let active: ActiveDataset | null = null;
let latestUrl = '';

async function openDataset(url: string): Promise<OpenResult> {
  latestUrl = url;
  const reader = await CogpReader.open(url);
  if (latestUrl !== url) throw new Error('Dataset open was superseded');

  const dataBbox = computeDataBbox(reader);
  active = {
    url,
    reader,
    dataBbox,
    bboxStructTop: bboxStructTopColumn(reader),
    servedViewports: 0,
  };

  return { summary: metadataSummary(reader), dataBbox };
}

async function readViewport(
  url: string,
  bbox: ViewportBbox,
  targetGsd: number,
): Promise<ViewportResult> {
  const ds = active;
  if (!ds || ds.url !== url) {
    return { data: { type: 'FeatureCollection', features: [] }, status: '' };
  }
  const geomColumn = ds.reader.primaryGeometryColumn;
  const maxLevel = ds.reader.selectLevel(targetGsd);
  const rows = await ds.reader.readRows({
    bbox,
    maxLevel,
    maxRows: VIEWPORT_MAX_ROWS,
    maxRowWkbBytes: VIEWPORT_MAX_ROW_WKB_BYTES,
  });

  const features: Feature[] = [];
  const skip = new Set<string>([geomColumn]);
  if (ds.bboxStructTop) skip.add(ds.bboxStructTop);
  for (const row of rows) {
    const geometry = row[geomColumn] as Geometry | null | undefined;
    if (!geometry) continue;
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (skip.has(key)) continue;
      properties[key] = coerceForGeoJson(value);
    }
    features.push({ type: 'Feature', geometry, properties });
  }
  ds.servedViewports += 1;
  return {
    data: { type: 'FeatureCollection', features },
    status: `Loaded ${features.length} features at ${formatGsd(targetGsd)}/px (level <= ${maxLevel}). Updates: ${ds.servedViewports}.`,
  };
}

function metadataSummary(reader: CogpReader): MetadataSummary {
  return {
    primary_column: reader.primaryGeometryColumn,
    num_row_groups: reader.numRowGroups,
    levels: reader.levels.map((l, i) => ({
      i,
      gsd: l.gsd,
      row_group_end: l.row_group_end,
    })),
    crs: reader.geo.columns[reader.primaryGeometryColumn]?.crs ?? null,
  };
}

function bboxStructTopColumn(reader: CogpReader): string | null {
  const path = reader.geo.columns[reader.primaryGeometryColumn]?.covering?.bbox?.xmin;
  return path?.[0] ?? null;
}

function computeDataBbox(reader: CogpReader): [[number, number], [number, number]] | null {
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

// MapLibre serializes GeoJSON properties through JSON.stringify when shipping
// data to its worker, which can't handle bigint or Uint8Array. Coerce both
// here so the GeoJSON source accepts the FeatureCollection.
function coerceForGeoJson(value: unknown): unknown {
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  if (value instanceof Uint8Array) return `<bytes:${value.byteLength}>`;
  return value;
}

function formatGsd(gsdMeters: number): string {
  if (gsdMeters >= 1000) return `${(gsdMeters / 1000).toFixed(1)} km`;
  if (gsdMeters >= 1) return `${gsdMeters.toFixed(1)} m`;
  return `${(gsdMeters * 100).toFixed(1)} cm`;
}

self.onmessage = async (e: MessageEvent<WorkerEnvelope>) => {
  const { id, payload } = e.data;
  try {
    let result: OpenResult | ViewportResult;
    if (payload.type === 'open') {
      result = await openDataset(payload.url);
    } else {
      result = await readViewport(payload.url, payload.bbox, payload.targetGsd);
    }
    const response: WorkerResponse = { id, ok: true, result };
    self.postMessage(response);
  } catch (err) {
    const response: WorkerResponse = { id, ok: false, error: (err as Error).message };
    self.postMessage(response);
  }
};
