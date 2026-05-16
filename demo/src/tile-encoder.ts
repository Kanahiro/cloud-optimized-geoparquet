import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import type { Feature, FeatureCollection, Geometry } from 'geojson';

const COGP_LAYER_NAME = 'cogp';
const MVT_EXTENT = 4096;
const TILE_BUFFER = 64;
const EMPTY_MVT_TILE = encodeMvt({ type: 'FeatureCollection', features: [] });

export interface EncodeResult {
  data: ArrayBuffer;
  featureCount: number;
}

export interface EncodeOptions {
  excludeColumns?: ReadonlyArray<string>;
}

export function encodeTileRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  geomColumn: string,
  tile: { z: number; x: number; y: number },
  options: EncodeOptions = {},
): EncodeResult {
  const exclude = new Set<string>([geomColumn, ...(options.excludeColumns ?? [])]);
  const fc = rowsToFeatureCollection(rows, geomColumn, exclude);
  return {
    data: encodeMvt(fc, tile),
    featureCount: fc.features.length,
  };
}

export function emptyTile(): ArrayBuffer {
  return cloneArrayBuffer(EMPTY_MVT_TILE);
}

function rowsToFeatureCollection(
  rows: ReadonlyArray<Record<string, unknown>>,
  geomColumn: string,
  excludeColumns: ReadonlySet<string>,
): FeatureCollection {
  const features: Feature[] = [];
  for (const row of rows) {
    const geometry = row[geomColumn] as Geometry | null | undefined;
    if (!geometry) continue;
    features.push({
      type: 'Feature',
      geometry,
      properties: buildProperties(row, excludeColumns),
    });
  }
  return { type: 'FeatureCollection', features };
}

function buildProperties(
  row: Record<string, unknown>,
  excludeColumns: ReadonlySet<string>,
): Record<string, string | number | boolean | null> {
  const props: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(row)) {
    if (excludeColumns.has(key)) continue;
    props[key] = coerceMvtValue(value);
  }
  return props;
}

function coerceMvtValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return value as string | number | boolean;
  }
  if (t === 'bigint') return (value as bigint).toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `<bytes:${value.byteLength}>`;
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return String(value);
  }
}

function encodeMvt(fc: FeatureCollection, tile?: { z: number; x: number; y: number }): ArrayBuffer {
  const index = geojsonvt(fc, {
    maxZoom: 24,
    indexMaxZoom: 0,
    extent: MVT_EXTENT,
    buffer: TILE_BUFFER,
  });
  const mvtTile = tile ? index.getTile(tile.z, tile.x, tile.y) : { features: [] };
  if (!mvtTile) return cloneArrayBuffer(EMPTY_MVT_TILE);
  return toArrayBuffer(
    vtpbf.fromGeojsonVt({ [COGP_LAYER_NAME]: mvtTile }, { version: 2, extent: MVT_EXTENT }),
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function cloneArrayBuffer(buffer: ArrayBuffer): ArrayBuffer {
  const out = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(out).set(new Uint8Array(buffer));
  return out;
}
