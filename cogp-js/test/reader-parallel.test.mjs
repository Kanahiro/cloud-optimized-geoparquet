import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { COGP_ROW_INDEX, CogpReader } from '../dist/index.js';

async function gatedReader() {
  const bytes = await readFile(new URL('../../test-data/shared.parquet', import.meta.url));
  let armed = false;
  const pending = [];
  const reader = await CogpReader.fromAsyncBuffer({
    byteLength: bytes.length,
    slice(start, end = bytes.length, signal) {
      const value = bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end);
      if (!armed) return value;
      return new Promise((resolve, reject) => {
        pending.push({ start, signal, resolve: () => resolve(value), reject });
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  // Isolate scheduling from the run-size policy using two real Parquet groups.
  reader.coalescedRuns = groups => groups.map(group => [group]);
  armed = true;
  return { reader, pending };
}

const options = { columns: ['id'], includeRowIndex: true };

test('all runs start before earlier reads finish and retain source order', async () => {
  const { reader, pending } = await gatedReader();
  const result = reader.readRows(options);
  await setImmediate();
  assert.equal(pending.length, 2, 'both row groups must be in flight');
  pending[1].resolve();
  await setImmediate();
  pending[0].resolve();
  const rows = await result;
  assert.deepEqual(rows.map(row => row[COGP_ROW_INDEX]), [0, 1]);
  assert.equal(rows.length, 2);
});

test('caller cancellation aborts all pending runs', async () => {
  const { reader, pending } = await gatedReader();
  const controller = new AbortController();
  const result = reader.readRows({ ...options, signal: controller.signal });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await setImmediate();
  assert.equal(pending.length, 2);
  controller.abort();
  await rejected;
  assert.ok(pending.every(read => read.signal.aborted));
});

test('a later run failure cancels an earlier pending run without hanging', async () => {
  const { reader, pending } = await gatedReader();
  const result = reader.readRows(options);
  const rejected = assert.rejects(result, /later run failed/);
  await setImmediate();
  assert.equal(pending.length, 2);
  pending[1].reject(new Error('later run failed'));
  await rejected;
  assert.ok(pending.every(read => read.signal.aborted));
});

test('maxRows cancels other runs while retaining the source prefix', async () => {
  const { reader, pending } = await gatedReader();
  const result = reader.readRows({ ...options, maxRows: 1 });
  await setImmediate();
  assert.equal(pending.length, 2);
  pending[0].resolve();
  assert.deepEqual((await result).map(row => row[COGP_ROW_INDEX]), [0]);
  assert.ok(pending[1].signal.aborted);
});
