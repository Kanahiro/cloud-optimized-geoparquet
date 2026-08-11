export const COGP_METADATA_KEY = 'cogp';
export const GEO_METADATA_KEY = 'geo';

export interface Level {
  row_group_end: number;
  gsd: number;
}

export interface GeometryOverview {
  column: string;
  /** Index into `CogpMeta.levels`; supplies the non-null boundary. */
  level: number;
  /** Maximum spatial simplification error in meters. */
  tolerance_meters: number;
}

export interface CogpGenerator {
  name: string;
  version: string;
}

export interface CogpMeta {
  version: string;
  levels: Level[];
  geometry_overviews?: GeometryOverview[];
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
  if (parsed.geometry_overviews !== undefined) {
    if (!Array.isArray(parsed.geometry_overviews)) {
      throw new Error('cogp metadata: `geometry_overviews` must be an array');
    }
    let previousLevel = -1;
    let previousTolerance = Infinity;
    const columns = new Set<string>();
    for (const [index, overview] of parsed.geometry_overviews.entries()) {
      if (typeof overview.column !== 'string' || overview.column.length === 0) {
        throw new Error(
          `cogp metadata: geometry_overviews[${index}].column must be a non-empty string`,
        );
      }
      if (columns.has(overview.column)) {
        throw new Error(`cogp metadata: duplicate geometry overview column \`${overview.column}\``);
      }
      columns.add(overview.column);
      if (!Number.isInteger(overview.level) || overview.level < 0 || overview.level >= parsed.levels.length) {
        throw new Error(`cogp metadata: geometry_overviews[${index}].level is out of range`);
      }
      if (overview.level <= previousLevel) {
        throw new Error('cogp metadata: geometry overview levels must be strictly increasing');
      }
      previousLevel = overview.level;
      if (!Number.isFinite(overview.tolerance_meters) || overview.tolerance_meters <= 0) {
        throw new Error(
          `cogp metadata: geometry_overviews[${index}].tolerance_meters must be positive and finite`,
        );
      }
      if (overview.tolerance_meters >= previousTolerance) {
        throw new Error(
          'cogp metadata: geometry overview tolerances must be strictly decreasing',
        );
      }
      previousTolerance = overview.tolerance_meters;
    }
    const finalOverview = parsed.geometry_overviews.at(-1);
    if (finalOverview && finalOverview.level !== parsed.levels.length - 1) {
      throw new Error('cogp metadata: final geometry overview must cover the final level');
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
  return { cogp, geo };
}
