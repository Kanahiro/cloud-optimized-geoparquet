/** MapLibre's default vector tile size; one tile covers this many CSS pixels. */
const VECTOR_TILE_SIZE = 512;

/** Approximate degrees per tile pixel at the map center. */
export function latitudeResolution(z: number, latitude: number): number {
  return (360 * Math.cos((latitude * Math.PI) / 180)) / (VECTOR_TILE_SIZE * 2 ** z);
}
