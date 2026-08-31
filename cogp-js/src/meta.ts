export const COGP_METADATA_KEY = 'cogp';
export const GEO_METADATA_KEY = 'geo';

export interface Level {
  row_group_end: number;
  resolution_meters: number;
  geometry_column: string;
}

export interface CogpGenerator {
  name: string;
  version: string;
}

export interface CogpMeta {
  version: string;
  levels: Level[];
  generator?: CogpGenerator;
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
  version: string;
  primary_column: string;
  columns: Record<string, GeoColumn>;
  [extra: string]: unknown;
}

export type GeometryFamily = 'point' | 'line' | 'polygon';

export function geometryFamily(types: readonly string[]): GeometryFamily | undefined {
  const one = (type: string): GeometryFamily | undefined => {
    const base = type.split(/\s+/, 1)[0];
    if (base === 'Point' || base === 'MultiPoint') return 'point';
    if (base === 'LineString' || base === 'MultiLineString') return 'line';
    if (base === 'Polygon' || base === 'MultiPolygon') return 'polygon';
    return undefined;
  };
  const family = types[0] ? one(types[0]) : undefined;
  return family && types.every((type) => one(type) === family) ? family : undefined;
}

export function parseCogpMeta(json: string): CogpMeta {
  const parsed = JSON.parse(json) as CogpMeta;
  if (typeof parsed.version !== 'string') {
    throw new Error('cogp metadata: missing `version`');
  }
  if (!Array.isArray(parsed.levels) || parsed.levels.length === 0) {
    throw new Error('cogp metadata: `levels` must be a non-empty array');
  }
  let previousResolution = Infinity;
  let previousRowGroupEnd = -1;
  for (const [index, level] of parsed.levels.entries()) {
    if (!Number.isInteger(level.row_group_end) || level.row_group_end < 0) {
      throw new Error(`cogp metadata: levels[${index}].row_group_end must be a non-negative integer`);
    }
    if (level.row_group_end <= previousRowGroupEnd) {
      throw new Error('cogp metadata: level row-group boundaries must be strictly increasing');
    }
    previousRowGroupEnd = level.row_group_end;
    if (!Number.isFinite(level.resolution_meters) || level.resolution_meters <= 0) {
      throw new Error(`cogp metadata: levels[${index}].resolution_meters must be positive and finite`);
    }
    if (level.resolution_meters >= previousResolution) {
      throw new Error('cogp metadata: level resolutions must be strictly decreasing');
    }
    previousResolution = level.resolution_meters;
    if (typeof level.geometry_column !== 'string' || level.geometry_column.length === 0) {
      throw new Error(`cogp metadata: levels[${index}].geometry_column must be a non-empty string`);
    }
  }
  const major = Number.parseInt(parsed.version.split('.')[0] ?? '', 10);
  if (major !== 0) {
    throw new Error(
      `cogp metadata: unsupported major version \`${parsed.version}\` (this reader implements 0.x)`,
    );
  }
  return parsed;
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

export interface CogpDocument {
  cogp: CogpMeta;
  geo: GeoMeta;
}

export function extractCogpDocument(
  kv: ReadonlyArray<{ key: string; value?: string | null }> | null | undefined,
): CogpDocument {
  let cogpJson: string | undefined;
  let geoJson: string | undefined;
  for (const entry of kv ?? []) {
    if (entry.key === COGP_METADATA_KEY && typeof entry.value === 'string') {
      cogpJson = entry.value;
    } else if (entry.key === GEO_METADATA_KEY && typeof entry.value === 'string') {
      geoJson = entry.value;
    }
  }
  if (!geoJson) {
    throw new Error('not a GeoParquet file: missing `geo` key/value metadata');
  }
  if (!cogpJson) {
    throw new Error('not a COGP file: missing `cogp` key/value metadata');
  }
  const cogp = parseCogpMeta(cogpJson);
  const geo = parseGeoMeta(geoJson);
  const primary = geo.columns[geo.primary_column];
  if (!primary || !geometryFamily(primary.geometry_types)) {
    throw new Error(
      'COGP primary geometry must declare exactly one Point, Line, or Polygon family',
    );
  }
  for (const [index, level] of cogp.levels.entries()) {
    const geometry = geo.columns[level.geometry_column];
    if (!geometry) {
      throw new Error(
        `COGP levels[${index}].geometry_column \`${level.geometry_column}\` is missing from geo.columns`,
      );
    }
    if (geometry.encoding !== 'WKB') {
      throw new Error(
        `COGP levels[${index}].geometry_column \`${level.geometry_column}\` must use WKB encoding`,
      );
    }
  }
  return { cogp, geo };
}
