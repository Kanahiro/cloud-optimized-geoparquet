/// <reference lib="webworker" />
import {
  COGP_ROW_INDEX,
  CogpReader,
  type QuantizedOverviewGeometry,
  type ReadOptions,
} from 'cogp';
import { Zstd } from '@hpcc-js/wasm-zstd';

import type {
  FeatureProperties,
  OpenResult,
  TileResult,
  ViewportBbox,
  WorkerMessage,
  WorkerResponse,
} from './cogp-types';
import {
  createOverviewMvtEncoder,
  type EncodedMvtFeature,
  encodeMvtTile,
  encodePrimaryFeature,
  MVT_BUFFER,
  MVT_EXTENT,
} from './mvt';

const VECTOR_TILE_SIZE = 512;


interface ActiveDataset {
  url: string;
  reader: CogpReader;
  dataBbox: [[number, number], [number, number]] | null;
  propertyColumns: string[];
}

let active: ActiveDataset | null = null;
let latestUrl = '';
const zstdDecoder = Zstd.load();
const requestControllers = new Map<number, AbortController>();

async function openDataset(url: string, signal: AbortSignal): Promise<OpenResult> {
  latestUrl = url;
  const zstd = await zstdDecoder;
  signal.throwIfAborted();
  const reader = await CogpReader.open(url, {
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

  return { geo: reader.geo, numRowGroups: reader.numRowGroups, dataBbox };
}

async function readTile(
  url: string,
  z: number,
  x: number,
  y: number,
  signal: AbortSignal,
): Promise<TileResult> {
  const ds = active;
  if (!ds || ds.url !== url) {
    throw new Error('Dataset is no longer active');
  }
  const targetResolution = tileResolution(z, y);
  const geomColumn = ds.reader.primaryGeometryColumn;
  const maxLevel = ds.reader.selectLevel(targetResolution);
  const usesOverviews = ds.reader.geo.lod.overviews !== undefined;
  const readOptions: ReadOptions = {
    bbox: tileBounds(z, x, y),
    columns: [geomColumn],
    includeRowIndex: true,
    maxLevel,
    signal,
  };
  if (usesOverviews) {
    // Keep the selected overview in its quantized form. The MVT encoder below
    // consumes it without constructing a GeoJSON geometry tree.
    readOptions.overviewDecoder = (overview) => overview;
  }
  const readStartedAt = performance.now();
  const rows = await ds.reader.readRows(readOptions);
  const readMs = performance.now() - readStartedAt;
  signal.throwIfAborted();

  const encodeStartedAt = performance.now();
  const overviewEncoder = createOverviewMvtEncoder(z, x, y);
  let featureCount = 0;
  for (let i = 0; i < rows.length; i++) {
    if ((i & 1023) === 0) signal.throwIfAborted();
    const row = rows[i]!;
    const rowIndex = (row as Record<PropertyKey, unknown>)[COGP_ROW_INDEX];
    if (!Number.isSafeInteger(rowIndex)) throw new Error('COGP row is missing its source index');
    const feature = usesOverviews
      ? overviewEncoder(row[geomColumn] as QuantizedOverviewGeometry | null, rowIndex as number)
      : encodePrimaryFeature(row[geomColumn], z, x, y, rowIndex as number);
    if (!feature) continue;
    // Reuse the rows array so a dense tile does not need a second 10k-entry
    // container solely for its already-encoded protobuf feature messages.
    rows[featureCount++] = feature as unknown as Record<string, unknown>;
  }
  rows.length = featureCount;
  signal.throwIfAborted();
  const data = encodeMvtTile(rows as unknown as EncodedMvtFeature[]);
  const encodeMs = performance.now() - encodeStartedAt;
  return {
    data,
    featureCount,
    readMs,
    encodeMs,
    maxLevel,
  };
}

async function readProperties(
  url: string,
  rowIndex: number,
  signal: AbortSignal,
): Promise<FeatureProperties> {
  const ds = active;
  if (!ds || ds.url !== url) throw new Error('Dataset is no longer active');
  return ds.reader.readRow(rowIndex, { columns: ds.propertyColumns, signal });
}

function propertyColumnNames(reader: CogpReader): string[] {
  const excluded = new Set<string>(['overviews', ...Object.keys(reader.geo.columns)]);
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

function tileBounds(z: number, x: number, y: number): ViewportBbox {
  const tiles = 2 ** z;
  const normalizedX = ((x % tiles) + tiles) % tiles;
  const padding = MVT_BUFFER / MVT_EXTENT;
  return {
    minX: ((normalizedX - padding) / tiles) * 360 - 180,
    minY: tileYToLatitude(y + 1 + padding, tiles),
    maxX: ((normalizedX + 1 + padding) / tiles) * 360 - 180,
    maxY: tileYToLatitude(y - padding, tiles),
  };
}

function tileYToLatitude(y: number, tiles: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / tiles))) * 180) / Math.PI;
}

function tileResolution(z: number, y: number): number {
  const tiles = 2 ** z;
  const latitude = tileYToLatitude(y + 0.5, tiles);
  // Both metadata and targets use geographic CRS units (degrees).
  return (360 * Math.cos((latitude * Math.PI) / 180)) / (VECTOR_TILE_SIZE * tiles);
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
        controller.signal,
      );
      const response: WorkerResponse = { id, ok: true, result };
      self.postMessage(response, { transfer: [result.data] });
    } else {
      const result = await readProperties(payload.url, payload.rowIndex, controller.signal);
      const response: WorkerResponse = { id, ok: true, result };
      self.postMessage(response);
    }
  } catch (err) {
    const response: WorkerResponse = { id, ok: false, error: (err as Error).message };
    self.postMessage(response);
  } finally {
    requestControllers.delete(id);
  }
};
