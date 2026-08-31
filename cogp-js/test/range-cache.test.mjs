import assert from 'node:assert/strict';
import test from 'node:test';

import { coalescingAsyncBuffer } from '../dist/coalescing-buffer.js';
import { lruCachingAsyncBuffer } from '../dist/range-cache.js';

function sourceFixture(size = 64) {
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

test('reuses exact slices and evicts the least recently used bytes', async () => {
  const { source, calls } = sourceFixture();
  const file = lruCachingAsyncBuffer(source, { maxBytes: 8 });

  await file.slice(0, 4);
  await file.slice(4, 8);
  await file.slice(0, 4); // refresh the first entry
  await file.slice(8, 12); // evicts [4,8), not [0,4)
  await file.slice(4, 8);

  assert.deepEqual(calls, [[0, 4], [4, 8], [8, 12], [4, 8]]);
});

test('deduplicates identical in-flight slices', async () => {
  const { source, calls } = sourceFixture();
  const originalSlice = source.slice;
  source.slice = async (start, end) => {
    await Promise.resolve();
    return originalSlice(start, end);
  };
  const file = lruCachingAsyncBuffer(source, { maxBytes: 8 });

  const [a, b] = await Promise.all([file.slice(12, 16), file.slice(12, 16)]);

  assert.deepEqual(calls, [[12, 16]]);
  assert.strictEqual(a, b);
});

test('does not evict useful entries for a slice larger than the cache', async () => {
  const { source, calls } = sourceFixture();
  const file = lruCachingAsyncBuffer(source, { maxBytes: 4 });

  await file.slice(0, 4);
  await file.slice(4, 10);
  await file.slice(0, 4);
  await file.slice(4, 10);

  assert.deepEqual(calls, [[0, 4], [4, 10], [4, 10]]);
});

test('validates the cache byte budget and slice bounds', async () => {
  const { source } = sourceFixture();
  assert.throws(() => lruCachingAsyncBuffer(source, { maxBytes: -1 }), /non-negative/);
  const file = lruCachingAsyncBuffer(source);
  await assert.rejects(file.slice(-1, 2), /outside buffer/);
  await assert.rejects(file.slice(0, 65), /outside buffer/);
});

test('caches requested slices outside a coalesced source read', async () => {
  const { source, calls } = sourceFixture();
  const file = lruCachingAsyncBuffer(
    coalescingAsyncBuffer(source, { maxGapBytes: 8 }),
    { maxBytes: 64 },
  );

  await Promise.all([file.slice(10, 20), file.slice(25, 35)]);
  assert.deepEqual(calls, [[10, 35]]);

  await Promise.all([file.slice(10, 20), file.slice(25, 35)]);
  assert.deepEqual(calls, [[10, 35]]);
});
