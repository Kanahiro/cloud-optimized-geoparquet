export const COGP_METADATA_KEY = 'cogp';
export const GEO_METADATA_KEY = 'geo';

export interface Level {
  row_group_end: number;
  resolution: number;
  lod?: string;
}

export interface LodMetadata {
  scale: [number, number];
  offset: [number, number];
}

export interface OverviewsMetadata {
  encoding: 'quantized_xy_v1';
  lods: Record<string, LodMetadata>;
}

export interface CogpGenerator {
  name: string;
  version: string;
}

export interface CogpMeta {
  version: string;
  levels: Level[];
  overviews?: OverviewsMetadata;
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

export function parseCogpMeta(json: string): CogpMeta {
  const parsed = JSON.parse(json) as CogpMeta;
  if (typeof parsed.version !== 'string') {
    throw new Error('cogp metadata: missing `version`');
  }
  if (!Array.isArray(parsed.levels) || parsed.levels.length === 0) {
    throw new Error('cogp metadata: `levels` must be a non-empty array');
  }
  if (parsed.overviews !== undefined) {
    if (parsed.overviews?.encoding !== 'quantized_xy_v1') {
      throw new Error('cogp metadata: unsupported `overviews.encoding`');
    }
    if (!parsed.overviews.lods || typeof parsed.overviews.lods !== 'object') {
      throw new Error('cogp metadata: missing `overviews.lods`');
    }
    const lodEntries = Object.entries(parsed.overviews.lods);
    if (lodEntries.length === 0) {
      throw new Error('cogp metadata: `overviews.lods` must be non-empty');
    }
    for (const [lod, metadata] of lodEntries) {
      if (!lod) throw new Error('cogp metadata: overview LoD names must be non-empty');
      if (!validPair(metadata?.scale, true)) {
        throw new Error(`cogp metadata: overviews.lods.${lod}.scale must contain two positive numbers`);
      }
      if (!validPair(metadata?.offset, false)) {
        throw new Error(`cogp metadata: overviews.lods.${lod}.offset must contain two finite numbers`);
      }
    }
  }
  let previousRowGroupEnd = -1;
  let previousResolution = Number.POSITIVE_INFINITY;
  for (const [index, level] of parsed.levels.entries()) {
    if (parsed.overviews !== undefined
      && (typeof level.lod !== 'string' || !parsed.overviews.lods[level.lod])) {
      throw new Error(`cogp metadata: levels[${index}].lod does not name an overview LoD`);
    }
    if (parsed.overviews === undefined && level.lod !== undefined) {
      throw new Error(`cogp metadata: levels[${index}].lod requires overviews`);
    }
    if (!Number.isSafeInteger(level.row_group_end) || level.row_group_end <= previousRowGroupEnd) {
      throw new Error(`cogp metadata: levels[${index}].row_group_end must strictly increase`);
    }
    if (!(Number.isFinite(level.resolution) && level.resolution > 0)) {
      throw new Error(`cogp metadata: levels[${index}].resolution must be positive`);
    }
    if (level.resolution >= previousResolution) {
      throw new Error(`cogp metadata: levels[${index}].resolution must strictly decrease`);
    }
    previousRowGroupEnd = level.row_group_end;
    previousResolution = level.resolution;
  }
  const major = Number.parseInt(parsed.version.split('.')[0] ?? '', 10);
  if (major !== 0) {
    throw new Error(
      `cogp metadata: unsupported major version \`${parsed.version}\` (this reader implements 0.x)`,
    );
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
  const family = geometryFamily(primary?.geometry_types ?? []);
  if (!family) {
    throw new Error('geo metadata: primary geometry must declare one supported family');
  }
  if (family === 'point') {
    if (cogp.overviews !== undefined || cogp.levels.some(level => level.lod !== undefined)) {
      throw new Error('cogp metadata: Point-family files must not declare overviews or level lods');
    }
  } else if (cogp.overviews === undefined) {
    throw new Error('cogp metadata: Line/Polygon files require overviews');
  }
  return { cogp, geo };
}
