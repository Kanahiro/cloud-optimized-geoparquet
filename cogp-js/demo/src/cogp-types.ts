import type { FeatureCollection } from 'geojson';

export interface MetadataSummary {
  primary_column: string;
  num_row_groups: number;
  levels: Array<{
    i: number;
    resolution_meters: number;
    geometry_column: string;
    row_group_end: number;
  }>;
  crs: unknown;
}

export interface OpenResult {
  summary: MetadataSummary;
  dataBbox: [[number, number], [number, number]] | null;
}

export interface ViewportBbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ViewportResult {
  data: FeatureCollection;
  status: string;
}

export interface FeaturePropertiesResult {
  properties: Record<string, unknown>;
}

export type WorkerRequest =
  | { type: 'open'; url: string }
  | { type: 'readViewport'; url: string; bbox: ViewportBbox; targetResolutionMeters: number }
  | { type: 'readProperties'; url: string; rowIndex: number };

export interface WorkerEnvelope {
  id: number;
  payload: WorkerRequest;
}

export type WorkerResponse =
  | { id: number; ok: true; result: OpenResult | ViewportResult | FeaturePropertiesResult }
  | { id: number; ok: false; error: string };
