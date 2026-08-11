/// <reference lib="webworker" />
import { CogpReader } from 'cogp';
import type { Feature, Geometry } from 'geojson';

import type {
  FeaturePropertiesResult,
  MetadataSummary,
  OpenResult,
  ViewportBbox,
  ViewportResult,
  WorkerEnvelope,
  WorkerResponse,
} from './cogp-types';

const VIEWPORT_MAX_ROWS = 50_000;
const VIEWPORT_MAX_ROW_WKB_BYTES = 20_000_000;
const VIEWPORT_ROW_INDEX = '__cogp_row_index';

interface ActiveDataset {
  url: string;
  reader: CogpReader;
  dataBbox: [[number, number], [number, number]] | null;
  bboxStructTop: string | null;
  detailColumns: string[];
  transfers: TransferStats;
  servedViewports: number;
}

interface TransferStats {
  bytes: number;
  requests: number;
}

let active: ActiveDataset | null = null;
let latestUrl = '';

async function openDataset(url: string): Promise<OpenResult> {
  latestUrl = url;
  const transfers: TransferStats = { bytes: 0, requests: 0 };
  const reader = await CogpReader.open(url, { fetch: trackingFetch(transfers) });
  if (latestUrl !== url) throw new Error('Dataset open was superseded');

  const dataBbox = computeDataBbox(reader);
  active = {
    url,
    reader,
    dataBbox,
    bboxStructTop: bboxStructTopColumn(reader),
    detailColumns: detailColumnNames(reader),
    transfers,
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
  const selectedGeometry = ds.reader.selectGeometryColumn(targetGsd, maxLevel);
  const bytesBefore = ds.transfers.bytes;
  const requestsBefore = ds.transfers.requests;
  const rows = await ds.reader.readRows({
    bbox,
    maxLevel,
    targetGsd,
    columns: [geomColumn],
    maxRows: VIEWPORT_MAX_ROWS,
    maxRowWkbBytes: VIEWPORT_MAX_ROW_WKB_BYTES,
    rowIndexColumn: VIEWPORT_ROW_INDEX,
  });

  const features: Feature[] = [];
  const skip = new Set<string>([geomColumn, VIEWPORT_ROW_INDEX]);
  if (ds.bboxStructTop) skip.add(ds.bboxStructTop);
  for (const row of rows) {
    const geometry = row[geomColumn] as Geometry | null | undefined;
    if (!geometry) continue;
    const rowIndex = row[VIEWPORT_ROW_INDEX];
    if (typeof rowIndex !== 'number') continue;
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (skip.has(key)) continue;
      properties[key] = coerceForGeoJson(value);
    }
    features.push({ type: 'Feature', id: rowIndex, geometry, properties });
  }
  ds.servedViewports += 1;
  const transferredBytes = ds.transfers.bytes - bytesBefore;
  const transferRequests = ds.transfers.requests - requestsBefore;
  return {
    data: { type: 'FeatureCollection', features },
    status: `Loaded ${features.length} features at ${formatGsd(targetGsd)}/px (level <= ${maxLevel}, geometry: ${selectedGeometry}, transfer: ${formatBytes(transferredBytes)} / ${transferRequests} requests, total: ${formatBytes(ds.transfers.bytes)}). Updates: ${ds.servedViewports}.`,
  };
}

async function readProperties(url: string, rowIndex: number): Promise<FeaturePropertiesResult> {
  const ds = active;
  if (!ds || ds.url !== url || ds.detailColumns.length === 0) {
    return { properties: {} };
  }
  const row = await ds.reader.readRow(rowIndex, { columns: ds.detailColumns });
  if (!row) return { properties: {} };
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    properties[key] = coerceForGeoJson(value);
  }
  return { properties };
}

function trackingFetch(stats: TransferStats): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
    if (method.toUpperCase() !== 'HEAD') {
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength >= 0) stats.bytes += contentLength;
      stats.requests += 1;
    }
    return response;
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

function detailColumnNames(reader: CogpReader): string[] {
  const geometryColumns = new Set(Object.keys(reader.geo.columns));
  const bboxColumn = bboxStructTopColumn(reader);
  return reader.columnNames.filter(
    (column) =>
      !geometryColumns.has(column) &&
      column !== bboxColumn &&
      column !== 'bbox' &&
      !column.endsWith('_bbox'),
  );
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

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

self.onmessage = async (e: MessageEvent<WorkerEnvelope>) => {
  const { id, payload } = e.data;
  try {
    let result: OpenResult | ViewportResult | FeaturePropertiesResult;
    if (payload.type === 'open') {
      result = await openDataset(payload.url);
    } else if (payload.type === 'readViewport') {
      result = await readViewport(payload.url, payload.bbox, payload.targetGsd);
    } else {
      result = await readProperties(payload.url, payload.rowIndex);
    }
    const response: WorkerResponse = { id, ok: true, result };
    self.postMessage(response);
  } catch (err) {
    const response: WorkerResponse = { id, ok: false, error: (err as Error).message };
    self.postMessage(response);
  }
};
