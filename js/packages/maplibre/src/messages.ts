import type { CogpReader } from '@cogp/reader';
import type { CogpConfig } from './url.js';

export interface CogpDatasetInfo {
  geo: CogpReader['geo'];
  columnNames: string[];
  numRowGroups: number;
  byteLength: number;
  dataBbox: [[number, number], [number, number]] | null;
}

export interface CogpStats {
  requests: number;
  bytes: number;
  /** Recent tile read and encode times in milliseconds. */
  tileMs: number[];
}

export type WorkerRequest =
  | { id: number; type: 'inspect'; url: string }
  | { id: number; type: 'stats'; url: string }
  | { id: number; type: 'tile'; config: CogpConfig; z: number; x: number; y: number }
  | { id: number; type: 'cancel' };

export type WorkerResponse =
  | { id: number; ok: true; data?: ArrayBuffer; info?: CogpDatasetInfo; stats?: CogpStats }
  | { id: number; ok: false; name: string; error: string };
