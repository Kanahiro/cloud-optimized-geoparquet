import type { CogpReader } from 'cogp';
import type { FeatureCollection } from 'geojson';

export interface OpenResult {
  geo: CogpReader['geo'];
  numRowGroups: number;
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
