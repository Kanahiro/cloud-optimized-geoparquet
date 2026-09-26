import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { CogpReader } from '../dist/index.js';
import { ROW, readRecords } from './helpers.mjs';

async function gatedReader(pageIndexCache = false) {
  const bytes = await readFile(new URL('../../../../test-data/shared.parquet', import.meta.url));
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
  }, 'fixture:shared', { pageIndexCache, rangeCache: false });
  // Isolate scheduling from the run-size policy using two real Parquet groups.
  reader.coalescedRuns = groups => groups.map(group => [group]);
  armed = true;
  return { reader, pending };
}

const options = { columns: ['id'] };

for (const pageIndexCache of [false, {}]) {
const mode = pageIndexCache ? 'page index cache' : 'uncached';

test(`${mode}: all runs start before earlier reads finish and retain source order`, async () => {
  const { reader, pending } = await gatedReader(pageIndexCache);
  const result = readRecords(reader, options);
  await setImmediate();
  assert.equal(pending.length, 2, 'both row groups must be in flight');
  pending[1].resolve();
  await setImmediate();
  pending[0].resolve();
  const rows = await result;
  assert.deepEqual(rows.map(row => row[ROW]), [0, 1]);
  assert.equal(rows.length, 2);
});

test(`${mode}: caller cancellation aborts all pending runs`, async () => {
  const { reader, pending } = await gatedReader(pageIndexCache);
  const controller = new AbortController();
  const result = readRecords(reader, { ...options, signal: controller.signal });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await setImmediate();
  assert.equal(pending.length, 2);
  controller.abort();
  await rejected;
  assert.ok(pending.every(read => read.signal.aborted));
});

test(`${mode}: a later run failure cancels an earlier pending run without hanging`, async () => {
  const { reader, pending } = await gatedReader(pageIndexCache);
  const result = readRecords(reader, options);
  const rejected = assert.rejects(result, /later run failed/);
  await setImmediate();
  assert.equal(pending.length, 2);
  pending[1].reject(new Error('later run failed'));
  await rejected;
  assert.ok(pending.every(read => read.signal.aborted));
});

test(`${mode}: maxRows never dispatches later runs and retains the source prefix`, async () => {
  const { reader, pending } = await gatedReader(pageIndexCache);
  const result = readRecords(reader, { ...options, maxRows: 1 });
  await setImmediate();
  assert.equal(pending.length, 1);
  pending[0].resolve();
  assert.deepEqual((await result).map(row => row[ROW]), [0]);
  assert.equal(pending.length, 1);
});

}

test('zero maxRows performs no reads and invalid limits are rejected', async () => {
  const {reader,pending} = await gatedReader();
  assert.deepEqual(await readRecords(reader, {maxRows:0}), []);
  for (const maxRows of [-1,1.5,NaN,Infinity]) await assert.rejects(readRecords(reader, {maxRows}), /maxRows/);
  assert.equal(pending.length,0);
});

for (const pageIndexCache of [false, {}]) {
  test(`uncapped queries dispatch more than four runs without waiting (${!!pageIndexCache})`, async () => {
    const { reader, pending } = await gatedReader(pageIndexCache);
    const indices = [0, 1, 0, 1, 0, 1, 0];
    reader.coalescedRuns = () => indices.map(index => [index]);
    const result = readRecords(reader, options);
    await setImmediate();
    assert.equal(pending.length, indices.length, 'all seven runs must start before any completes');
    for (const read of [...pending].reverse()) read.resolve();
    assert.deepEqual((await result).map(row => row[ROW]), indices);
  });

  test(`failure beyond the fourth run cancels earlier pending reads (${!!pageIndexCache})`, async () => {
    const { reader, pending } = await gatedReader(pageIndexCache);
    reader.coalescedRuns = () => Array.from({ length: 7 }, () => [0]);
    const result = readRecords(reader, options);
    const rejected = assert.rejects(result, /seventh run failed/);
    await setImmediate();
    assert.equal(pending.length, 7);
    pending[6].reject(new Error('seventh run failed'));
    await rejected;
    assert.ok(pending.every(read => read.signal.aborted));
  });

  test(`capped queries fetch every needed run concurrently (${!!pageIndexCache})`, async () => {
    const { reader, pending } = await gatedReader(pageIndexCache);
    const result = readRecords(reader, { ...options, maxRows: 2 });
    await setImmediate();
    assert.equal(pending.length, 2, 'both needed runs must be in flight together');
    pending[1].resolve();
    pending[0].resolve();
    assert.deepEqual((await result).map(row => row[ROW]), [0, 1]);
  });
}
