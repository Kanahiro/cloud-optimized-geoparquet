import type { FeatureCollection } from 'geojson';

export interface MetadataSummary {
  primary_column: string;
  num_row_groups: number;
  levels: Array<{
    i: number;
    resolution: number;
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

export type WorkerRequest =
  | { type: 'open'; url: string }
  | { type: 'readViewport'; url: string; bbox: ViewportBbox; targetResolution: number };

export interface WorkerEnvelope {
  id: number;
  payload: WorkerRequest;
}

export type WorkerResponse =
  | { id: number; ok: true; result: OpenResult | ViewportResult }
  | { id: number; ok: false; error: string };
