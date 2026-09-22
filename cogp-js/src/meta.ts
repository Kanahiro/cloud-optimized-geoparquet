export const GEO_METADATA_KEY = 'geo';

export interface Level {
  row_group_end: number;
  resolution: number;
  lod?: string;
}

export interface LodMetadata {
  geometry_type?: 'LineString' | 'MultiLineString' | 'Polygon' | 'MultiPolygon';
  scale: [number, number];
  offset: [number, number];
}

export interface OverviewsMetadata {
  encoding: 'quantized_xy_v1' | 'quantized_geoarrow';
  column: string;
  lods: Record<string, LodMetadata>;
}

export interface CogpMeta {
  levels: Level[];
  overviews?: OverviewsMetadata;
  [extra: string]: unknown;
}

export interface BboxCovering {
  xmin: string[];
  ymin: string[];
  xmax: string[];
  ymax: string[];
}

export interface Covering {
  bbox: BboxCovering;
}

export interface GeoColumn {
  encoding: string;
  geometry_types: string[];
  covering?: Covering;
  bbox?: number[];
  crs?: unknown;
  [extra: string]: unknown;
}

export interface GeoMeta {
  lod?: CogpMeta;
  version: string;
  primary_column: string;
  columns: Record<string, GeoColumn>;
  [extra: string]: unknown;
}

export function parseCogpMeta(json: string, numRowGroups?: number): CogpMeta {
  const parsed = JSON.parse(json) as CogpMeta;
  if (!parsed || typeof parsed !== 'object') throw new Error('geo.lod must be an object');
  if (!Array.isArray(parsed.levels) || parsed.levels.length === 0) {
    throw new Error('geo.lod: levels must be a non-empty array');
  }
  if (parsed.overviews !== undefined) {
    if (!['quantized_xy_v1', 'quantized_geoarrow'].includes(parsed.overviews?.encoding)) {
      throw new Error('geo.lod: unsupported `overviews.encoding`');
    }
    const column = parsed.overviews.column;
    if (typeof column !== 'string' || !column) {
      throw new Error('geo.lod: missing or invalid `overviews.column`');
    }
    if (!parsed.overviews.lods || typeof parsed.overviews.lods !== 'object') {
      throw new Error('geo.lod: missing `overviews.lods`');
    }
    const lodEntries = Object.entries(parsed.overviews.lods);
    if (lodEntries.length === 0) {
      throw new Error('geo.lod: `overviews.lods` must be non-empty');
    }
    for (const [lod, metadata] of lodEntries) {
      if (!lod || (parsed.overviews.encoding === 'quantized_xy_v1' && lod === 'geometry_type')) throw new Error('geo.lod: invalid overview LoD name');
      if (parsed.overviews.encoding === 'quantized_geoarrow'
        && !['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'].includes(metadata?.geometry_type ?? '')) {
        throw new Error(`geo.lod: invalid geometry_type for overview ${lod}`);
      }
      if (!validPair(metadata?.scale, true)) {
        throw new Error(`geo.lod: overviews.lods.${lod}.scale must contain two positive numbers`);
      }
      if (!validPair(metadata?.offset, false)) {
        throw new Error(`geo.lod: overviews.lods.${lod}.offset must contain two finite numbers`);
      }
    }
  }
  const referenced = new Set<string>();
  let previousRowGroupEnd = -1;
  let previousResolution = Number.POSITIVE_INFINITY;
  for (const [index, level] of parsed.levels.entries()) {
    if (!level || typeof level !== 'object') throw new Error(`geo.lod: levels[${index}] must be an object`);
    if (parsed.overviews !== undefined
      && (typeof level.lod !== 'string' || !Object.prototype.hasOwnProperty.call(parsed.overviews.lods, level.lod))) {
      throw new Error(`geo.lod: levels[${index}].lod does not name an overview LoD`);
    }
    if (parsed.overviews === undefined && level.lod !== undefined) {
      throw new Error(`geo.lod: levels[${index}].lod requires overviews`);
    }
    if (!Number.isSafeInteger(level.row_group_end) || level.row_group_end < 0
      || level.row_group_end < previousRowGroupEnd) {
      throw new Error(`geo.lod: levels[${index}].row_group_end must be non-decreasing`);
    }
    if (level.lod !== undefined) {
      referenced.add(level.lod);
    }
    if (!(Number.isFinite(level.resolution) && level.resolution > 0)) {
      throw new Error(`geo.lod: levels[${index}].resolution must be positive`);
    }
    if (level.resolution >= previousResolution) {
      throw new Error(`geo.lod: levels[${index}].resolution must strictly decrease`);
    }
    previousRowGroupEnd = level.row_group_end;
    previousResolution = level.resolution;
  }
  if (parsed.overviews) {
    for (const lod of Object.keys(parsed.overviews.lods)) {
      if (!referenced.has(lod)) throw new Error(`geo.lod: overview LoD \`${lod}\` is not referenced by a level`);
    }
  }
  if (numRowGroups !== undefined && (!Number.isSafeInteger(numRowGroups) || numRowGroups <= 0 || previousRowGroupEnd !== numRowGroups - 1)) {
    throw new Error('geo.lod: final boundary must cover all row groups; empty files must omit the extension');
  }
  return parsed;
}

function validPair(value: unknown, positive: boolean): value is [number, number] {
  return Array.isArray(value)
    && value.length === 2
    && value.every((item) => Number.isFinite(item) && (!positive || item > 0));
}

export function parseGeoMeta(json: string): GeoMeta {
  const parsed = JSON.parse(json) as GeoMeta;
  if (typeof parsed.primary_column !== 'string') {
    throw new Error('geo metadata: missing `primary_column`');
  }
  if (!parsed.columns || typeof parsed.columns !== 'object') {
    throw new Error('geo metadata: missing `columns`');
  }
  return parsed;
}

export type GeometryFamily = 'point' | 'line' | 'polygon';

export function geometryFamily(geometryTypes: readonly string[]): GeometryFamily | undefined {
  const family = (geometryType: string): GeometryFamily | undefined => {
    switch (geometryType.split(/\s+/, 1)[0]) {
      case 'Point':
      case 'MultiPoint': return 'point';
      case 'LineString':
      case 'MultiLineString': return 'line';
      case 'Polygon':
      case 'MultiPolygon': return 'polygon';
      default: return undefined;
    }
  };
  const first = geometryTypes[0] ? family(geometryTypes[0]) : undefined;
  return first && geometryTypes.every(type => family(type) === first) ? first : undefined;
}

export function extractGeoMeta(
  kv: ReadonlyArray<{ key: string; value?: string | null }> | null | undefined,
  numRowGroups: number,
): GeoMeta & { lod: CogpMeta } {
  const geoJson = kv?.find(entry => entry.key === GEO_METADATA_KEY)?.value;
  if (!geoJson) throw new Error('not a GeoParquet file: missing `geo` key/value metadata');
  const geo = parseGeoMeta(geoJson);
  if (!geo.lod) throw new Error('missing geo.lod metadata');
  const lod = parseCogpMeta(JSON.stringify(geo.lod), numRowGroups);
  const family = geometryFamily(geo.columns[geo.primary_column]?.geometry_types ?? []);
  if (lod.overviews && family !== 'line' && family !== 'polygon') {
    throw new Error('overviews require a Line or Polygon family; points must not declare overviews');
  }
  if (lod.overviews) {
    if (lod.overviews.column === geo.primary_column) throw new Error('overview column must differ from primary geometry');
    for (const value of Object.values(lod.overviews.lods)) {
      if (value.geometry_type && geometryFamily([value.geometry_type]) !== family) {
        throw new Error('overview geometry_type must match primary geometry family');
      }
    }
  }
  return { ...geo, lod };
}
