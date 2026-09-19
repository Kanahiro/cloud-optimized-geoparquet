export const GEO_METADATA_KEY = 'geo';

export interface Level {
  row_group_end: number;
  resolution: number;
}

export interface CogpMeta {
  levels: Level[];
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

export function parseCogpMeta(json: string, numRowGroups: number): CogpMeta {
  const parsed = JSON.parse(json) as CogpMeta;
  const fail = (detail: string): never => { throw new Error(`geo.lod: ${detail}`); };
  if (!parsed || !Array.isArray(parsed.levels) || parsed.levels.length === 0) {
    fail('levels must be a non-empty array');
  }
  if (!Number.isSafeInteger(numRowGroups) || numRowGroups <= 0) fail('empty files must omit the extension');
  parsed.levels.forEach((level, i) => {
    if (!level || !Number.isSafeInteger(level.row_group_end) || level.row_group_end < 0 || level.row_group_end >= numRowGroups) {
      fail(`levels[${i}].row_group_end out of range or not an integer`);
    }
    if (!Number.isFinite(level.resolution) || level.resolution <= 0) fail(`levels[${i}].resolution must be positive and finite`);
    if (i > 0) {
      if (level.row_group_end < parsed.levels[i - 1]!.row_group_end) fail('boundaries must be non-decreasing');
      if (level.resolution >= parsed.levels[i - 1]!.resolution) fail('resolutions must strictly decrease');
    }
  });
  if (parsed.levels[parsed.levels.length - 1]!.row_group_end !== numRowGroups - 1) fail('final boundary must cover all row groups');
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

export function extractGeoMeta(
  kv: ReadonlyArray<{ key: string; value?: string | null }> | null | undefined,
  numRowGroups: number,
): GeoMeta & { lod: CogpMeta } {
  const geoJson = kv?.find(entry => entry.key === GEO_METADATA_KEY)?.value;
  if (!geoJson) throw new Error('not a GeoParquet file: missing `geo` key/value metadata');
  const geo = parseGeoMeta(geoJson);
  if (!geo.lod) throw new Error('missing geo.lod metadata');
  const lod = parseCogpMeta(JSON.stringify(geo.lod), numRowGroups);
  return { ...geo, lod };
}
