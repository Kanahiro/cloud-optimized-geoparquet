export const MVT_LAYER_NAME = 'cogp';

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

export interface TileResult {
  data: ArrayBuffer;
  featureCount: number;
  readMs: number;
  encodeMs: number;
  maxLevel: number;
}

export type FeatureProperties = Record<string, unknown>;

export type WorkerRequest =
  | { type: 'open'; url: string }
  | { type: 'readTile'; url: string; z: number; x: number; y: number }
  | { type: 'readProperties'; url: string; rowIndex: number };

export interface WorkerEnvelope {
  id: number;
  payload: WorkerRequest;
}

export interface WorkerCancel {
  type: 'cancel';
  id: number;
}

export type WorkerMessage = WorkerEnvelope | WorkerCancel;

export type WorkerResponse =
  | { id: number; ok: true; result: OpenResult | TileResult | FeatureProperties }
  | { id: number; ok: false; error: string };
