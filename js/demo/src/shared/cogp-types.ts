export const MVT_LAYER_NAME = 'cogp';

export interface OpenResult {
  geo: import('@cogp/reader').CogpReader['geo'];
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

/** One viewport read encoded by `toGeoArrow`. */
export interface ArrowResult {
  /** Arrow IPC stream with one record batch. */
  data: ArrayBuffer;
  rows: number;
  /** Zero-based LoD level that was read. */
  level: number;
  /** Wall time to read and encode. */
  ms: number;
  network: NetworkStats;
}

/** A viewport read request; the worker selects the level for `resolution`. */
export interface ViewRequest {
  url: string;
  bbox: ViewportBbox;
  /** Target resolution in primary geometry CRS units per pixel. */
  resolution: number;
  maxRows: number;
  fetchProperties: boolean;
}

export type WorkerRequest =
  | { type: 'open'; url: string }
  | { type: 'readTile'; url: string; z: number; x: number; y: number; fetchProperties: boolean }
  | ({ type: 'readArrow' } & ViewRequest);

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
  | { id: number; ok: true; result: OpenResult | TileResult | ArrowResult }
  | { id: number; ok: false; error: string; name: string };
