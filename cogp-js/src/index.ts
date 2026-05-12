export { CogpReader } from './reader.js';
export type {
  BboxInput,
  OpenOptions,
  ReadOptions,
} from './reader.js';

export {
  COGP_METADATA_KEY,
  GEO_METADATA_KEY,
  extractCogpDocument,
  parseCogpMeta,
  parseGeoMeta,
} from './meta.js';
export type {
  BboxCovering,
  CogpDocument,
  CogpGenerator,
  CogpMeta,
  Covering,
  GeoColumn,
  GeoMeta,
  Lod,
} from './meta.js';

export {
  rowGroupPrefixForLod,
  rowGroupRangeForLod,
  selectLodByGsd,
} from './lod.js';
export type { LodRange } from './lod.js';

export type { Bbox } from './bbox.js';

export { rowsToArrowTable } from './arrow.js';

export { rowsToFeatureCollection, wkbToGeometry } from './geojson.js';
export type {
  Feature,
  FeatureCollection,
  Geometry,
  GeometryCollection,
  LineString,
  MultiLineString,
  MultiPoint,
  MultiPolygon,
  Point,
  Polygon,
  Position,
} from './geojson.js';
