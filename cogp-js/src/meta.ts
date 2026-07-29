export const COGP_METADATA_KEY = 'cogp';
export const GEO_METADATA_KEY = 'geo';

export interface Level {
  row_group_end: number;
  resolution: number;
}

export interface CogpGenerator {
  name: string;
  version: string;
}

export interface CogpMeta {
  version: string;
  /** Root struct containing WKB rendering geometries for selected levels. */
  lods_column?: string;
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

export function parseCogpMeta(json: string): CogpMeta {
  const parsed = JSON.parse(json) as CogpMeta;
  if (typeof parsed.version !== 'string') {
    throw new Error('cogp metadata: missing `version`');
  }
  if (!Array.isArray(parsed.levels) || parsed.levels.length === 0) {
    throw new Error('cogp metadata: `levels` must be a non-empty array');
  }
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(parsed.version);
  if (!version || Number(version[1]) !== 0) {
    throw new Error(
      `cogp metadata: unsupported version \`${parsed.version}\` (expected MAJOR.MINOR.PATCH with major 0)`,
    );
  }
  if (
    parsed.lods_column !== undefined &&
    (typeof parsed.lods_column !== 'string' || parsed.lods_column.length === 0)
  ) {
    throw new Error('cogp metadata: `lods_column` must be a non-empty string');
  }
  for (const [i, level] of parsed.levels.entries()) {
    if (!Number.isInteger(level?.row_group_end) || level.row_group_end < 0) {
      throw new Error(`cogp metadata: levels[${i}].row_group_end must be a non-negative integer`);
    }
    if (typeof level.resolution !== 'number' || !(level.resolution > 0)) {
      throw new Error(`cogp metadata: levels[${i}].resolution must be a positive number`);
    }
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
  return { cogp: parseCogpMeta(cogpJson), geo: parseGeoMeta(geoJson) };
}
