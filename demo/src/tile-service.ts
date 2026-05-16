import { CogpReader } from 'cogp';

import { emptyTile, encodeTileRows } from './tile-encoder';

const TILE_MAX_ROWS = 100000;
const TILE_MAX_BYTES = 20000000;

export interface CogpTileRequest {
  url: string;
  z: number;
  x: number;
  y: number;
}

export interface MetadataSummary {
  primary_column: string;
  num_row_groups: number;
  levels: Array<{
    i: number;
    gsd: number;
    row_group_end: number;
  }>;
  crs: unknown;
}

export interface OpenResult {
  summary: MetadataSummary;
  dataBbox: [[number, number], [number, number]] | null;
}

export interface TileResult {
  data: ArrayBuffer;
  status?: string;
}

interface ActiveDataset {
  url: string;
  reader: CogpReader;
  dataBbox: [[number, number], [number, number]] | null;
  tileCache: Map<string, Promise<TileResult>>;
  servedTiles: number;
}

let active: ActiveDataset | null = null;
let latestUrl = '';

export async function openDataset(url: string): Promise<OpenResult> {
  latestUrl = url;
  const reader = await CogpReader.open(url);
  if (latestUrl !== url) throw new Error('Dataset open was superseded');

  const dataBbox = computeDataBbox(reader);
  active = {
    url,
    reader,
    dataBbox,
    tileCache: new Map(),
    servedTiles: 0,
  };

  return {
    summary: metadataSummary(reader),
    dataBbox,
  };
}

export async function readTile(
  tile: CogpTileRequest,
  targetGsd: number,
): Promise<TileResult> {
  const ds = active;
  if (!ds || ds.url !== tile.url) return { data: emptyTile() };

  const key = `${tile.z}/${tile.x}/${tile.y}/${targetGsd}`;
  let promise = ds.tileCache.get(key);
  if (!promise) {
    promise = buildCogpTile(ds, tile, targetGsd).catch((err) => {
      ds.tileCache.delete(key);
      throw err;
    });
    ds.tileCache.set(key, promise);
  }
  return promise;
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

async function buildCogpTile(
  ds: ActiveDataset,
  tile: CogpTileRequest,
  targetGsd: number,
): Promise<TileResult> {
  const bbox = tileBbox(tile.z, tile.x, tile.y);
  const maxLevel = ds.reader.selectLevel(targetGsd);
  const geomColumn = ds.reader.primaryGeometryColumn;
  const rows = await ds.reader.readRows({
    bbox,
    maxLevel,
    maxRows: TILE_MAX_ROWS,
    maxBytes: TILE_MAX_BYTES,
    columns: [geomColumn],
  });

  const { data, featureCount } = encodeTileRows(rows, geomColumn, tile);
  ds.servedTiles += 1;
  return {
    data,
    status: `Served ${ds.servedTiles} vector tiles. Last: ${featureCount} features at ${formatGsd(targetGsd)}/px (level <= ${maxLevel}).`,
  };
}

function tileBbox(z: number, x: number, y: number) {
  return {
    minX: tileXToLng(x, z),
    minY: tileYToLat(y + 1, z),
    maxX: tileXToLng(x + 1, z),
    maxY: tileYToLat(y, z),
  };
}

function tileXToLng(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

function formatGsd(gsdMeters: number): string {
  if (gsdMeters >= 1000) return `${(gsdMeters / 1000).toFixed(1)} km`;
  if (gsdMeters >= 1) return `${gsdMeters.toFixed(1)} m`;
  return `${(gsdMeters * 100).toFixed(1)} cm`;
}
