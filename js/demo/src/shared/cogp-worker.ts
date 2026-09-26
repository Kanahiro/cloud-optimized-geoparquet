/// <reference lib="webworker" />
import { CogpReader, toGeoArrow, toMvt } from '@cogp/reader';
import { Zstd } from '@hpcc-js/wasm-zstd';

import {
  MVT_LAYER_NAME,
  type ArrowResult,
  type BudgetRequest,
  type BudgetResult,
  type NetworkStats,
  type OpenResult,
  type TileResult,
  type ViewRequest,
  type WorkerMessage,
  type WorkerResponse,
} from './cogp-types';
import { tileBounds, tileResolution } from './tiles';



interface ActiveDataset {
  url: string;
  reader: CogpReader;
  dataBbox: [[number, number], [number, number]] | null;
  propertyColumns: string[];
}

let active: ActiveDataset | null = null;
// Counts what actually crosses the network; reader caches never reach fetch.
let network: NetworkStats = { requests: 0, bytes: 0 };

const countingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (new Headers(init?.headers).has('Range')) {
    network.requests += 1;
    network.bytes += Number(response.headers.get('Content-Length') ?? 0);
  }
  return response;
};
let latestUrl = '';
const zstdDecoder = Zstd.load();
const requestControllers = new Map<number, AbortController>();

async function openDataset(url: string, signal: AbortSignal): Promise<OpenResult> {
  latestUrl = url;
  const zstd = await zstdDecoder;
  signal.throwIfAborted();
  network = { requests: 0, bytes: 0 };
  const reader = await CogpReader.open(url, {
    fetch: countingFetch,
    compressors: { ZSTD: (input) => zstd.decompress(input) },
    signal,
  });
  signal.throwIfAborted();
  if (latestUrl !== url) throw new Error('Dataset open was superseded');

  const dataBbox = computeDataBbox(reader);
  active = {
    url,
    reader,
    dataBbox,
    propertyColumns: propertyColumnNames(reader),
  };

  return { geo: reader.geo, numRowGroups: reader.numRowGroups, byteLength: reader.byteLength, dataBbox };
}

async function readTile(
  url: string,
  z: number,
  x: number,
  y: number,
  fetchProperties: boolean,
  signal: AbortSignal,
): Promise<TileResult> {
  const ds = active;
  if (!ds || ds.url !== url) {
    throw new Error('Dataset is no longer active');
  }
  const targetResolution = tileResolution(z, y);
  const geomColumn = ds.reader.primaryGeometryColumn;
  const maxLevel = ds.reader.selectLevel(targetResolution);
  const propertyColumns = fetchProperties ? ds.propertyColumns : [];
  const startedAt = performance.now();
  const batch = await ds.reader.read({
    bbox: tileBounds(z, x, y),
    columns: [geomColumn, ...propertyColumns],
    maxLevel,
    // Quantized overviews go straight to toMvt without a GeoJSON tree.
    useOverview: true,
    signal,
  });
  signal.throwIfAborted();
  // Attribute lifetime follows MapLibre's tile cache; clicks need no I/O.
  const data = toMvt(batch, { z, x, y, layer: MVT_LAYER_NAME, signal });
  return { data, ms: performance.now() - startedAt, network: { ...network } };
}

/** Read the rows intersecting a view at the level selected for its resolution, as GeoArrow. */
async function readArrow(request: ViewRequest, signal: AbortSignal): Promise<ArrowResult> {
  const ds = active;
  if (!ds || ds.url !== request.url) {
    throw new Error('Dataset is no longer active');
  }
  const level = ds.reader.selectLevel(request.resolution);
  const geomColumn = ds.reader.primaryGeometryColumn;
  const startedAt = performance.now();
  const batch = await ds.reader.read({
    bbox: request.bbox,
    columns: [geomColumn, ...(request.fetchProperties ? ds.propertyColumns : [])],
    maxLevel: level,
    useOverview: true,
    maxRows: request.maxRows,
    signal,
  });
  signal.throwIfAborted();
  const data = toGeoArrow(batch, { crs: ds.reader.geo.columns[geomColumn]?.crs });
  return { data, rows: batch.length, level, ms: performance.now() - startedAt, network: { ...network } };
}

/**
 * Read levels up to `maxLevel` within the bbox, keeping the first `maxRows` rows
 * in source order. Coarse levels come first, so a small row budget stops at an
 * overview and a larger one fills in finer levels up to the level budget.
 */
async function readBudget(request: BudgetRequest, signal: AbortSignal): Promise<BudgetResult> {
  const ds = active;
  if (!ds || ds.url !== request.url) {
    throw new Error('Dataset is no longer active');
  }
  const { reader } = ds;
  const maxLevel = request.maxLevel ?? reader.selectLevel(request.resolution);
  const before = { ...network };
  const startedAt = performance.now();
  const batch = await reader.read({
    bbox: request.bbox,
    columns: [reader.primaryGeometryColumn],
    maxLevel,
    useOverview: true,
    maxRows: request.maxRows,
    signal,
  });
  signal.throwIfAborted();

  // Rows before the end of each level's row group prefix; row_group_end is inclusive.
  const rowGroupRows = reader.metadata.row_groups.map((rg) => Number(rg.num_rows ?? 0));
  const levelRowEnds = reader.levels.map((level) =>
    rowGroupRows.slice(0, level.row_group_end + 1).reduce((sum, rows) => sum + rows, 0));
  const level = new Uint8Array(batch.length);
  const levelRows = new Array<number>(levelRowEnds.length).fill(0);
  let current = 0;
  for (let i = 0; i < batch.length; i++) {
    // Rows are in source order, so the level never decreases.
    while (batch.rowIndex[i]! >= levelRowEnds[current]!) current++;
    level[i] = current;
    levelRows[current]! += 1;
  }
  const data = toGeoArrow(
    { geometry: batch.geometry!, rowIndex: batch.rowIndex, columns: { level } },
    { crs: reader.geo.columns[reader.primaryGeometryColumn]?.crs },
  );
  return {
    data,
    rows: batch.length,
    maxLevel,
    levelRows,
    ms: performance.now() - startedAt,
    network: { requests: network.requests - before.requests, bytes: network.bytes - before.bytes },
  };
}

function propertyColumnNames(reader: CogpReader): string[] {
  const excluded = new Set<string>(Object.keys(reader.geo.columns));
  if (reader.geo.lod.overviews) excluded.add(reader.geo.lod.overviews.column);
  for (const column of Object.values(reader.geo.columns)) {
    const covering = column.covering?.bbox;
    for (const path of covering
      ? [covering.xmin, covering.ymin, covering.xmax, covering.ymax]
      : []) {
      if (path[0]) excluded.add(path[0]);
    }
  }
  return reader.columnNames.filter((name) => !excluded.has(name) && !name.startsWith('__'));
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

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  if ('type' in e.data) {
    requestControllers.get(e.data.id)?.abort();
    return;
  }
  const { id, payload } = e.data;
  const controller = new AbortController();
  requestControllers.set(id, controller);
  try {
    if (payload.type === 'open') {
      const result: OpenResult = await openDataset(payload.url, controller.signal);
      const response: WorkerResponse = { id, ok: true, result };
      self.postMessage(response);
    } else if (payload.type === 'readTile') {
      const result: TileResult = await readTile(
        payload.url,
        payload.z,
        payload.x,
        payload.y,
        payload.fetchProperties,
        controller.signal,
      );
      const response: WorkerResponse = { id, ok: true, result };
      self.postMessage(response, { transfer: [result.data] });
    } else if (payload.type === 'readArrow') {
      const result: ArrowResult = await readArrow(payload, controller.signal);
      const response: WorkerResponse = { id, ok: true, result };
      self.postMessage(response, { transfer: [result.data] });
    } else if (payload.type === 'readBudget') {
      const result: BudgetResult = await readBudget(payload, controller.signal);
      const response: WorkerResponse = { id, ok: true, result };
      self.postMessage(response, { transfer: [result.data] });
    }
  } catch (err) {
    const response: WorkerResponse = { id, ok: false, error: (err as Error).message, name: (err as Error).name };
    self.postMessage(response);
  } finally {
    requestControllers.delete(id);
  }
};
