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

test('merges adjacent and overlapping slices but preserves even one-byte gaps', async () => {
  const { source, calls } = sourceFixture();
  const file = coalescingAsyncBuffer(source);
  // Deliberately unsorted, with a contained slice and a chain of adjacent ranges.
  const ranges = [[31, 40], [20, 30], [12, 15], [5, 12], [10, 20], [41, 50]];
  const buffers = await Promise.all(ranges.map(([start, end]) => file.slice(start, end)));

  assert.deepEqual(calls, [[5, 30], [31, 40], [41, 50]]);
  buffers.forEach((buffer, i) => {
    const [start, end] = ranges[i];
    assert.deepEqual([...new Uint8Array(buffer)],
      Array.from({ length: end - start }, (_, offset) => start + offset));
  });
});

test('always merges overlapping slices', async () => {
  const { source, calls } = sourceFixture();
  const file = coalescingAsyncBuffer(source);

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
