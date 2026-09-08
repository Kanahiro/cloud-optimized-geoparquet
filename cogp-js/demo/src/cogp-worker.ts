/// <reference lib="webworker" />
import {
  CogpReader,
  type QuantizedOverviewGeometry,
  type ReadOptions,
} from 'cogp';
import { Zstd } from '@hpcc-js/wasm-zstd';

import type {
  MetadataSummary,
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
  encodePointFeature,
  MVT_BUFFER,
  MVT_EXTENT,
} from './mvt';

const TILE_MAX_ROWS = 50_000;
const VECTOR_TILE_SIZE = 512;
const EARTH_CIRCUMFERENCE_METERS = 40_075_016.686;

interface ActiveDataset {
  url: string;
  reader: CogpReader;
  dataBbox: [[number, number], [number, number]] | null;
}

let active: ActiveDataset | null = null;
let latestUrl = '';
const zstdDecoder = Zstd.load();
const runningRequests = new Set<number>();
const cancelledRequests = new Set<number>();

async function openDataset(url: string): Promise<OpenResult> {
  latestUrl = url;
  const zstd = await zstdDecoder;
  const reader = await CogpReader.open(url, {
    compressors: { ZSTD: (input) => zstd.decompress(input) },
  });
  if (latestUrl !== url) throw new Error('Dataset open was superseded');

  const dataBbox = computeDataBbox(reader);
  active = {
    url,
    reader,
    dataBbox,
  };

  return { summary: metadataSummary(reader), dataBbox };
}

async function readTile(
  url: string,
  z: number,
  x: number,
  y: number,
  isCancelled: () => boolean,
): Promise<TileResult> {
  const ds = active;
  if (!ds || ds.url !== url) {
    throw new Error('Dataset is no longer active');
  }
  const targetResolution = tileResolution(z, y);
  const geomColumn = ds.reader.primaryGeometryColumn;
  const maxLevel = ds.reader.selectLevel(targetResolution);
  const usesOverviews = ds.reader.cogp.overviews !== undefined;
  const readOptions: ReadOptions = {
    bbox: tileBounds(z, x, y),
    columns: [geomColumn],
    maxLevel,
    maxRows: TILE_MAX_ROWS,
  };
  if (usesOverviews) {
    // Keep the selected overview as its zero-copy typed-array view. The MVT
    // encoder below consumes it without constructing GeoJSON geometry.
    readOptions.overviewDecoder = (overview) => overview;
  }
  const readStartedAt = performance.now();
  const rows = await ds.reader.readRows(readOptions);
  const readMs = performance.now() - readStartedAt;
  if (isCancelled()) throw new DOMException('COGP tile request aborted', 'AbortError');

  const encodeStartedAt = performance.now();
  const overviewEncoder = createOverviewMvtEncoder(z, x, y);
  let featureCount = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const feature = usesOverviews
      ? overviewEncoder(row[geomColumn] as QuantizedOverviewGeometry | null)
      : encodePointFeature(row[geomColumn], z, x, y);
    if (!feature) continue;
    // Reuse the rows array so a dense tile does not need a second 10k-entry
    // container solely for its already-encoded protobuf feature messages.
    rows[featureCount++] = feature as unknown as Record<string, unknown>;
  }
  rows.length = featureCount;
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
  return (
    (EARTH_CIRCUMFERENCE_METERS * Math.cos((latitude * Math.PI) / 180)) /
    (VECTOR_TILE_SIZE * tiles)
  );
}

function metadataSummary(reader: CogpReader): MetadataSummary {
  return {
    primary_column: reader.primaryGeometryColumn,
    num_row_groups: reader.numRowGroups,
    levels: reader.levels.map((l, i) => ({
      i,
      resolution: l.resolution,
      row_group_end: l.row_group_end,
    })),
    crs: reader.geo.columns[reader.primaryGeometryColumn]?.crs ?? null,
  };
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
    if (runningRequests.has(e.data.id)) cancelledRequests.add(e.data.id);
    return;
  }
  const { id, payload } = e.data;
  runningRequests.add(id);
  try {
    if (payload.type === 'open') {
      const result: OpenResult = await openDataset(payload.url);
      const response: WorkerResponse = { id, ok: true, result };
      self.postMessage(response);
    } else {
      const result: TileResult = await readTile(
        payload.url,
        payload.z,
        payload.x,
        payload.y,
        () => cancelledRequests.has(id),
      );
      const response: WorkerResponse = { id, ok: true, result };
      self.postMessage(response, { transfer: [result.data] });
    }
  } catch (err) {
    const response: WorkerResponse = { id, ok: false, error: (err as Error).message };
    self.postMessage(response);
  } finally {
    runningRequests.delete(id);
    cancelledRequests.delete(id);
  }
};
