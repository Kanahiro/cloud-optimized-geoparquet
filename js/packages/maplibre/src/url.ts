export const COGP_PROTOCOL = 'cogp';

export interface CogpLayerOptions {
  /** MVT property name to Parquet column or nested field path. Omit to read every attribute; use {} for geometry only. */
  properties?: Record<string, string>;
  /** Maximum rows returned for each tile of this layer. Omit for no row limit. */
  maxRowsPerTile?: number;
}

export type CogpLayerInput = string | ({ url: string } & CogpLayerOptions);

export interface CogpLayer extends CogpLayerOptions {
  name: string;
  url: string;
}

export interface CogpConfig {
  layers: CogpLayer[];
}

const TILE = /^cogp:\/\/tile\/v1\/([A-Za-z0-9_-]+)\/(\d+)\/(\d+)\/(\d+)\.pbf$/;

/** Create a serializable MapLibre vector tile URL template from named COGP layers. */
export function cogpUrl(input: Record<string, CogpLayerInput>): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('COGP source requires a name-to-layer object');
  }
  const layers: CogpLayer[] = Object.entries(input).map(([name, entry]) => normalizeLayer(name,
    typeof entry === 'string' ? { url: entry } : entry));
  if (layers.length === 0) throw new Error('COGP source requires at least one layer');
  layers.sort((a, b) => a.name.localeCompare(b.name));
  return `cogp://tile/v1/${encode({ layers })}/{z}/{x}/{y}.pbf`;
}

export function parseTileUrl(url: string): { config: CogpConfig; z: number; x: number; y: number } {
  const match = TILE.exec(url);
  if (!match) throw new Error(`Invalid COGP tile URL: ${url}`);
  const [z, x, y] = match.slice(2).map(Number);
  if (![z, x, y].every(Number.isSafeInteger) || z! > 24 || x! >= 2 ** z! || y! >= 2 ** z!) {
    throw new Error(`Invalid COGP tile coordinates: ${url}`);
  }
  return { config: decodeConfig(match[1]!), z: z!, x: x!, y: y! };
}

function normalizeLayer(name: string, entry: { url: string } & CogpLayerOptions): CogpLayer {
  if (!name) throw new Error('COGP layer name must not be empty');
  let parsed: URL | undefined;
  try { parsed = new URL(entry?.url); } catch { /* Invalid URLs are reported below. */ }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`COGP layer ${name} requires an absolute HTTP(S) URL`);
  }
  const layer: CogpLayer = { name, url: entry.url };
  if (entry.properties !== undefined) {
    if (!entry.properties || Array.isArray(entry.properties) || typeof entry.properties !== 'object') {
      throw new Error(`COGP layer ${name} properties must be a name-to-path object`);
    }
    const properties: Record<string, string> = {};
    for (const [output, path] of Object.entries(entry.properties).sort(([a], [b]) => a.localeCompare(b))) {
      if (!output || typeof path !== 'string' || !path) {
        throw new Error(`COGP layer ${name} has an invalid property mapping`);
      }
      Object.defineProperty(properties, output, { value: path, enumerable: true, configurable: true });
    }
    layer.properties = properties;
  }
  if (entry.maxRowsPerTile !== undefined) {
    if (!Number.isSafeInteger(entry.maxRowsPerTile) || entry.maxRowsPerTile < 0) {
      throw new Error(`COGP layer ${name} maxRowsPerTile must be a non-negative safe integer`);
    }
    layer.maxRowsPerTile = entry.maxRowsPerTile;
  }
  return layer;
}

function decodeConfig(token: string): CogpConfig {
  let raw: unknown;
  try {
    const base64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    raw = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
  } catch {
    throw new Error('Invalid COGP URL configuration');
  }
  if (!raw || typeof raw !== 'object' || !('layers' in raw) || !Array.isArray(raw.layers)
    || raw.layers.length === 0) throw new Error('Invalid COGP URL configuration');
  const layers = raw.layers.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('name' in entry) || typeof entry.name !== 'string') {
      throw new Error('Invalid COGP URL layer');
    }
    return normalizeLayer(entry.name, entry as unknown as { url: string } & CogpLayerOptions);
  });
  if (new Set(layers.map(layer => layer.name)).size !== layers.length) {
    throw new Error('Duplicate COGP layer name');
  }
  return { layers };
}

function encode(config: CogpConfig): string {
  const bytes = new TextEncoder().encode(JSON.stringify(config));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
