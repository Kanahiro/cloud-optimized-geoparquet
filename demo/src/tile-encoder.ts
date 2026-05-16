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

export function encodeTileRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  geomColumn: string,
  tile: { z: number; x: number; y: number },
): EncodeResult {
  const fc = rowsToFeatureCollection(rows, geomColumn);
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
): FeatureCollection {
  const features: Feature[] = [];
  for (const row of rows) {
    const geometry = row[geomColumn] as Geometry | null | undefined;
    if (!geometry) continue;
    features.push({ type: 'Feature', geometry, properties: {} });
  }
  return { type: 'FeatureCollection', features };
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
