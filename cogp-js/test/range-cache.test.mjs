import assert from 'node:assert/strict';
import test from 'node:test';

import { rangeCachedAsyncBuffer } from '../dist/range-cache.js';

function sourceFixture(size = 256) {
  const bytes = Uint8Array.from({ length: size }, (_, i) => i & 0xff);
  const calls = [];
  return {
    calls,
    bytes,
    source: {
      byteLength: size,
      slice(start, end = size) {
        calls.push([start, end]);
        return bytes.slice(start, end).buffer;
      },
    },
  };
}

test('serves contained slices from one cached range', async () => {
  const { source, calls } = sourceFixture();
  const file = rangeCachedAsyncBuffer(source, { maxBytes: 64 });

  const outer = await file.slice(10, 30);
  new Uint8Array(outer)[0] = 255;
  const inner = await file.slice(12, 16);

  assert.deepEqual(calls, [[10, 30]]);
  assert.deepEqual([...new Uint8Array(inner)], [12, 13, 14, 15]);
});

test('shares an in-flight containing request', async () => {
  const { bytes } = sourceFixture();
  const calls = [];
  let complete;
  const source = {
    byteLength: bytes.byteLength,
    slice(start, end) {
      calls.push([start, end]);
      return new Promise(resolve => {
        complete = () => resolve(bytes.slice(start, end).buffer);
      });
    },
  };
  const file = rangeCachedAsyncBuffer(source);

  const outer = file.slice(10, 30);
  const inner = file.slice(12, 16);
  assert.deepEqual(calls, [[10, 30]]);
  complete();

  assert.equal((await outer).byteLength, 20);
  assert.deepEqual([...new Uint8Array(await inner)], [12, 13, 14, 15]);
});

test('evicts the least recently used settled range', async () => {
  const { source, calls } = sourceFixture();
  const file = rangeCachedAsyncBuffer(source, { maxBytes: 20 });

  await file.slice(0, 10);
  await file.slice(10, 20);
  await file.slice(0, 5); // Touch the first entry.
  await file.slice(20, 30); // Evict [10, 20).
  await file.slice(10, 20);

  assert.deepEqual(calls, [[0, 10], [10, 20], [20, 30], [10, 20]]);
});

test('does not retain failed or oversized reads', async () => {
  const { bytes } = sourceFixture();
  let calls = 0;
  const source = {
    byteLength: bytes.byteLength,
    slice(start, end) {
      calls++;
      if (calls === 1) return Promise.reject(new Error('temporary failure'));
      return bytes.slice(start, end).buffer;
    },
  };
  const file = rangeCachedAsyncBuffer(source, { maxBytes: 8 });

  await assert.rejects(file.slice(0, 4), /temporary failure/);
  await file.slice(0, 4);
  await file.slice(20, 30);
  await file.slice(20, 30);

  assert.equal(calls, 4);
});

test('validates the cache budget and slice bounds', async () => {
  const { source } = sourceFixture();
  assert.throws(() => rangeCachedAsyncBuffer(source, { maxBytes: -1 }), /maxBytes/);
  const file = rangeCachedAsyncBuffer(source);
  await assert.rejects(file.slice(-1, 2), /outside buffer/);
  await assert.rejects(file.slice(0, 257), /outside buffer/);
});
