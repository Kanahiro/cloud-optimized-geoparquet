import assert from 'node:assert/strict';
import test from 'node:test';

import { coalescingAsyncBuffer } from '../dist/coalescing-buffer.js';

function sourceFixture(size = 256) {
  const bytes = Uint8Array.from({ length: size }, (_, i) => i & 0xff);
  const calls = [];
  return {
    calls,
    source: {
      byteLength: size,
      slice(start, end = size) {
        calls.push([start, end]);
        return bytes.slice(start, end).buffer;
      },
    },
  };
}

test('coalesces nearby concurrent slices and returns exact bytes', async () => {
  const { source, calls } = sourceFixture();
  const file = coalescingAsyncBuffer(source, { maxGapBytes: 8 });

  const [a, b, c] = await Promise.all([
    file.slice(10, 20),
    file.slice(25, 35),
    file.slice(100, 110),
  ]);

  assert.deepEqual(calls, [[10, 35], [100, 110]]);
  assert.deepEqual([...new Uint8Array(a)], [...Array(10)].map((_, i) => i + 10));
  assert.deepEqual([...new Uint8Array(b)], [...Array(10)].map((_, i) => i + 25));
  assert.deepEqual([...new Uint8Array(c)], [...Array(10)].map((_, i) => i + 100));
});

test('does not merge across the gap budget', async () => {
  const { source, calls } = sourceFixture();
  const file = coalescingAsyncBuffer(source, { maxGapBytes: 8 });

  await Promise.all([file.slice(0, 10), file.slice(19, 29), file.slice(40, 45)]);

  assert.deepEqual(calls, [[0, 10], [19, 29], [40, 45]]);
});

test('limits cumulative extra transfer with maxOverfetchRatio', async () => {
  const { source, calls } = sourceFixture();
  const file = coalescingAsyncBuffer(source, {
    maxGapBytes: 100,
    maxOverfetchRatio: 1.25,
  });

  await Promise.all([file.slice(0, 10), file.slice(15, 25), file.slice(31, 41)]);

  // [0,10) + [15,25) is exactly 25 / 20 = 1.25 and may merge. Adding
  // [31,41) would make the run 41 / 30 > 1.25, so it starts a new request.
  assert.deepEqual(calls, [[0, 25], [31, 41]]);
});

test('always merges overlapping slices', async () => {
  const { source, calls } = sourceFixture();
  const file = coalescingAsyncBuffer(source, { maxGapBytes: 0 });

  const [a, b] = await Promise.all([file.slice(10, 30), file.slice(20, 40)]);

  assert.deepEqual(calls, [[10, 40]]);
  assert.equal(a.byteLength, 20);
  assert.equal(b.byteLength, 20);
});

test('supports an omitted end and rejects invalid bounds', async () => {
  const { source, calls } = sourceFixture(32);
  const file = coalescingAsyncBuffer(source);

  const tail = await file.slice(28);
  assert.deepEqual(calls, [[28, 32]]);
  assert.deepEqual([...new Uint8Array(tail)], [28, 29, 30, 31]);
  await assert.rejects(file.slice(-1, 2), /outside buffer/);
  await assert.rejects(file.slice(0, 33), /outside buffer/);
});
