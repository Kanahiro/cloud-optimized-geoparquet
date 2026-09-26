export const GEO_METADATA_KEY = 'geo';

export interface Level {
  row_group_end: number;
  resolution: number;
}

/** Fields every overview LoD declares, independent of its encoding. */
export interface OverviewLodBase {
  level_indices: number[];
  [field: string]: unknown;
}

/** A `quantized_geoarrow` LoD. */
export interface OverviewLod extends OverviewLodBase {
  geometry_type: 'LineString' | 'MultiLineString' | 'Polygon' | 'MultiPolygon';
  scale: [number, number];
  offset: [number, number];
}

export interface OverviewsMetadata {
  encoding: string;
  column: string;
  lods: Record<string, OverviewLodBase>;
}

export interface SupportedOverviewsMetadata extends OverviewsMetadata {
  encoding: 'quantized_geoarrow';
  lods: Record<string, OverviewLod>;
}

/** Identify encodings this reader can decode; parseLodMeta validates their fields. */
export function supportedOverviews(value: OverviewsMetadata | undefined): SupportedOverviewsMetadata | undefined {
  return value?.encoding === 'quantized_geoarrow' ? value as SupportedOverviewsMetadata : undefined;
}

/** The `geo.lod` object: feature-selection levels plus optional overviews. */
export interface LodMeta {
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
  lod?: LodMeta;
  version: string;
  primary_column: string;
  columns: Record<string, GeoColumn>;
  [extra: string]: unknown;
}

export function parseLodMeta(json: string, numRowGroups?: number): LodMeta {
  const parsed = JSON.parse(json) as LodMeta;
  if (!parsed || typeof parsed !== 'object') throw new Error('geo.lod must be an object');
  if (!Array.isArray(parsed.levels) || parsed.levels.length === 0) {
    throw new Error('geo.lod: levels must be a non-empty array');
  }
  if (parsed.overviews !== undefined) {
    if (typeof parsed.overviews?.encoding !== 'string' || !parsed.overviews.encoding) {
      throw new Error('geo.lod: missing or invalid `overviews.encoding`');
    }
    const column = parsed.overviews.column;
    if (typeof column !== 'string' || !column) {
      throw new Error('geo.lod: missing or invalid `overviews.column`');
    }
    if (!parsed.overviews.lods || typeof parsed.overviews.lods !== 'object' || Array.isArray(parsed.overviews.lods)) {
      throw new Error('geo.lod: missing `overviews.lods`');
    }
    const lodEntries = Object.entries(parsed.overviews.lods);
    if (lodEntries.length === 0) {
      throw new Error('geo.lod: `overviews.lods` must be non-empty');
    }
    const assigned = new Set<number>();
    for (const [lod, metadata] of lodEntries) {
      if (!lod) throw new Error('geo.lod: invalid overview LoD name');
      const geometryType = metadata?.geometry_type;
      if (parsed.overviews.encoding === 'quantized_geoarrow'
        && (typeof geometryType !== 'string'
          || !['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'].includes(geometryType))) {
        throw new Error(`geo.lod: invalid geometry_type for overview ${lod}`);
      }
      if (!Array.isArray(metadata?.level_indices) || metadata.level_indices.length === 0) {
        throw new Error(`geo.lod: overview ${lod} level_indices must be a non-empty array`);
      }
      for (const index of metadata.level_indices) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= parsed.levels.length) {
          throw new Error(`geo.lod: overview ${lod} level_indices index out of range`);
        }
        if (assigned.has(index)) throw new Error(`geo.lod: level ${index} is assigned more than once`);
        assigned.add(index);
      }
      if (supportedOverviews(parsed.overviews) && !validPair(metadata?.scale, true)) {
        throw new Error(`geo.lod: overviews.lods.${lod}.scale must contain two positive numbers`);
      }
      if (supportedOverviews(parsed.overviews) && !validPair(metadata?.offset, false)) {
        throw new Error(`geo.lod: overviews.lods.${lod}.offset must contain two finite numbers`);
      }
    }
    if (assigned.size !== parsed.levels.length) {
      throw new Error('geo.lod: every level must be assigned to an overview');
    }
  }
  let previousRowGroupEnd = -1;
  let previousResolution = Number.POSITIVE_INFINITY;
  for (const [index, level] of parsed.levels.entries()) {
    if (!level || typeof level !== 'object') throw new Error(`geo.lod: levels[${index}] must be an object`);
    if (!Number.isSafeInteger(level.row_group_end) || level.row_group_end < 0
      || level.row_group_end < previousRowGroupEnd) {
      throw new Error(`geo.lod: levels[${index}].row_group_end must be non-decreasing`);
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
  if (numRowGroups !== undefined && (!Number.isSafeInteger(numRowGroups) || numRowGroups <= 0 || previousRowGroupEnd !== numRowGroups - 1)) {
    throw new Error('geo.lod: final boundary must cover all row groups; empty files must omit the extension');
  }
  return parsed;
}

/** Metadata must be validated before resolving a level's rendering geometry. */
export function lodForLevel(metadata: LodMeta, index: number): string | undefined {
  return Object.entries(metadata.overviews?.lods ?? {})
    .find(([, lod]) => lod.level_indices.includes(index))?.[0];
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
): GeoMeta & { lod: LodMeta } {
  const geoJson = kv?.find(entry => entry.key === GEO_METADATA_KEY)?.value;
  if (!geoJson) throw new Error('not a GeoParquet file: missing `geo` key/value metadata');
  const geo = parseGeoMeta(geoJson);
  if (!geo.lod) throw new Error('missing geo.lod metadata');
  const lod = parseLodMeta(JSON.stringify(geo.lod), numRowGroups);
  const family = geometryFamily(geo.columns[geo.primary_column]?.geometry_types ?? []);
  if (supportedOverviews(lod.overviews) && family !== 'line' && family !== 'polygon') {
    throw new Error('overviews require a Line or Polygon family; points must not declare overviews');
  }
  if (lod.overviews) {
    if (lod.overviews.column === geo.primary_column) throw new Error('overview column must differ from primary geometry');
    for (const value of Object.values(supportedOverviews(lod.overviews)?.lods ?? {})) {
      if (geometryFamily([value.geometry_type]) !== family) {
        throw new Error('overview geometry_type must match primary geometry family');
      }
    }
  }
  return { ...geo, lod };
}
