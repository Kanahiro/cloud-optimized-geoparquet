export const MVT_LAYER_NAME = 'cogp';

export interface OpenResult {
  geo: import('cogp').CogpReader['geo'];
  numRowGroups: number;
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

export type WorkerRequest =
  | { type: 'open'; url: string }
  | { type: 'readTile'; url: string; z: number; x: number; y: number };

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
  | { id: number; ok: true; result: OpenResult | TileResult }
  | { id: number; ok: false; error: string };
