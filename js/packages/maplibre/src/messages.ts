import type { CogpConfig } from './url.js';

export type WorkerRequest =
  | { id: number; type: 'prepare'; config: CogpConfig }
  | { id: number; type: 'tile'; config: CogpConfig; z: number; x: number; y: number }
  | { id: number; type: 'cancel' };

export type WorkerResponse =
  | { id: number; ok: true; data?: ArrayBuffer }
  | { id: number; ok: false; name: string; error: string };
