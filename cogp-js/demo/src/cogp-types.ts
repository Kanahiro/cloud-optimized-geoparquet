export const MVT_LAYER_NAME = 'cogp';

export interface OpenResult {
  geo: import('cogp').CogpReader['geo'];
  numRowGroups: number;
  byteLength: number;
  dataBbox: [[number, number], [number, number]] | null;
}

export interface ViewportBbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bytes and Range requests sent to the COGP file since it was opened. */
export interface NetworkStats {
  requests: number;
  bytes: number;
}

export interface TileResult {
  data: ArrayBuffer;
  /** Wall time to read and encode this tile. */
  ms: number;
  network: NetworkStats;
}

export type WorkerRequest =
  | { type: 'open'; url: string }
  | { type: 'readTile'; url: string; z: number; x: number; y: number; fetchProperties: boolean };

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
  | { id: number; ok: false; error: string; name: string };
