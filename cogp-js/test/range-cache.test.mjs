import assert from 'node:assert/strict';
import test from 'node:test';

import { rangeCachedAsyncBuffer } from '../dist/range-cache.js';

function sourceFixture(size = 256) {
  const bytes = Uint8Array.from({ length: size }, (_, i) => i & 0xff);
  const calls = [];
  return {
    calls,
    source: {
      byteLength: size,
      async slice(start, end = size) {
        calls.push([start, end]);
        return bytes.slice(start, end).buffer;
      },
    },
  };
}

test('reuses completed and in-flight ranges', async () => {
  const { source, calls } = sourceFixture();
  const file = rangeCachedAsyncBuffer(source);

  const [a, b] = await Promise.all([file.slice(10, 20), file.slice(10, 20)]);
  const c = await file.slice(10, 20);

  assert.deepEqual(calls, [[10, 20]]);
  assert.deepEqual([...new Uint8Array(a)], [...new Uint8Array(b)]);
  assert.deepEqual([...new Uint8Array(a)], [...new Uint8Array(c)]);
});

test('evicts least recently used settled ranges at the byte limit', async () => {
  const { source, calls } = sourceFixture();
  const file = rangeCachedAsyncBuffer(source, { maxBytes: 20 });

  await file.slice(0, 10);
  await file.slice(10, 20);
  await file.slice(0, 10); // make the first range most recently used
  await file.slice(20, 30); // evicts [10,20)
  await file.slice(10, 20);

  assert.deepEqual(calls, [[0, 10], [10, 20], [20, 30], [10, 20]]);
});

test('does not retain failed reads', async () => {
  let calls = 0;
  const file = rangeCachedAsyncBuffer({
    byteLength: 10,
    slice() {
      calls++;
      if (calls === 1) return Promise.reject(new Error('temporary failure'));
      return Promise.resolve(new ArrayBuffer(10));
    },
  });

  await assert.rejects(file.slice(0, 10), /temporary failure/);
  await file.slice(0, 10);
  assert.equal(calls, 2);
});

test('can be disabled with a zero-byte budget and validates bounds', async () => {
  const { source, calls } = sourceFixture(32);
  const file = rangeCachedAsyncBuffer(source, { maxBytes: 0 });

  await file.slice(0, 10);
  await file.slice(0, 10);
  assert.deepEqual(calls, [[0, 10], [0, 10]]);
  await assert.rejects(file.slice(-1, 2), /outside buffer/);
  assert.throws(() => rangeCachedAsyncBuffer(source, { maxBytes: -1 }), /maxBytes/);
});
