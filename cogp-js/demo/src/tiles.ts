import { MVT_BUFFER, MVT_EXTENT } from 'cogp';

import type { ViewportBbox } from './cogp-types';

/** MapLibre's default vector tile size; one tile covers this many CSS pixels. */
export const VECTOR_TILE_SIZE = 512;

/** Tile bounds in degrees, padded by the MVT clip buffer. */
export function tileBounds(z: number, x: number, y: number): ViewportBbox {
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

/** Degrees per pixel at a tile's center latitude; metadata uses the same units. */
export function tileResolution(z: number, y: number): number {
  return latitudeResolution(z, tileYToLatitude(y + 0.5, 2 ** z));
}

export function latitudeResolution(z: number, latitude: number): number {
  return (360 * Math.cos((latitude * Math.PI) / 180)) / (VECTOR_TILE_SIZE * 2 ** z);
}
