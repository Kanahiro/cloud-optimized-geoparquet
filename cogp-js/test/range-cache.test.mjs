import assert from 'node:assert/strict';
import test from 'node:test';

import { rangeCachedAsyncBuffer } from '../dist/range-cache.js';
import { coalescingAsyncBuffer } from '../dist/coalescing-buffer.js';

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

test('aborting one consumer preserves a shared in-flight read', async () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => i);
  let complete;
  let sourceAborted = false;
  const source = {
    byteLength: bytes.byteLength,
    slice(start, end, signal) {
      signal?.addEventListener('abort', () => { sourceAborted = true; }, { once: true });
      return new Promise(resolve => {
        complete = () => resolve(bytes.slice(start, end).buffer);
      });
    },
  };
  const file = rangeCachedAsyncBuffer(source);
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = file.slice(4, 12, firstController.signal);
  const second = file.slice(4, 12, secondController.signal);

  firstController.abort();
  await assert.rejects(first, error => error.name === 'AbortError');
  assert.equal(sourceAborted, false);
  complete();
  assert.deepEqual([...new Uint8Array(await second)], [4, 5, 6, 7, 8, 9, 10, 11]);
});

test('aborts an in-flight source read after its last consumer leaves', async () => {
  let sourceAborted = false;
  const source = {
    byteLength: 32,
    slice(_start, _end, signal) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          sourceAborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    },
  };
  const file = rangeCachedAsyncBuffer(source);
  const controller = new AbortController();
  const read = file.slice(4, 12, controller.signal);

  controller.abort();
  await assert.rejects(read, error => error.name === 'AbortError');
  assert.equal(sourceAborted, true);
});

test('fetches only holes and assembles cached ranges in byte order', async () => {
  const { source, calls, bytes } = sourceFixture();
  const file = rangeCachedAsyncBuffer(source);
  await file.slice(30, 40);
  await file.slice(10, 20);
  const result = await file.slice(5, 45);
  assert.deepEqual(calls, [[30, 40], [10, 20], [5, 10], [20, 30], [40, 45]]);
  assert.deepEqual(new Uint8Array(result), bytes.slice(5, 45));
  new Uint8Array(result).fill(255);
  assert.deepEqual(new Uint8Array(await file.slice(8, 42)), bytes.slice(8, 42));
  assert.equal(calls.length, 5);
});

test('reuses partial overlap and adjacent cached ranges without duplicate bytes', async () => {
  const { source, calls, bytes } = sourceFixture();
  const file = rangeCachedAsyncBuffer(source);
  await file.slice(0, 100);
  assert.deepEqual(new Uint8Array(await file.slice(50, 150)), bytes.slice(50, 150));
  assert.deepEqual(new Uint8Array(await file.slice(0, 150)), bytes.slice(0, 150));
  assert.deepEqual(calls, [[0, 100], [100, 150]]);
});

test('shares partial in-flight ranges when one overlapping consumer cancels', async () => {
  const { bytes } = sourceFixture();
  const pending = [];
  const file = rangeCachedAsyncBuffer({
    byteLength: bytes.length,
    slice(start, end, signal) {
      return new Promise((resolve, reject) => {
        const request = { start, end, aborted: false, complete: () => resolve(bytes.slice(start, end).buffer) };
        pending.push(request);
        signal.addEventListener('abort', () => { request.aborted = true; reject(signal.reason); });
      });
    },
  });
  const controller = new AbortController();
  const first = file.slice(10, 30);
  const second = file.slice(20, 40, controller.signal);
  const third = file.slice(25, 35);
  assert.deepEqual(pending.map(p => [p.start, p.end]), [[10, 30], [30, 40]]);
  controller.abort();
  await assert.rejects(second, error => error.name === 'AbortError');
  assert.ok(pending.every(p => !p.aborted));
  pending[1].complete();
  pending[0].complete();
  assert.deepEqual(new Uint8Array(await first), bytes.slice(10, 30));
  assert.deepEqual(new Uint8Array(await third), bytes.slice(25, 35));
});

test('reuses a snapshot even when gaps exceed the retention budget', async () => {
  const { source, calls, bytes } = sourceFixture();
  const file = rangeCachedAsyncBuffer(source, { maxBytes: 10 });
  await file.slice(10, 20);
  assert.deepEqual(new Uint8Array(await file.slice(0, 30)), bytes.slice(0, 30));
  assert.deepEqual(calls, [[10, 20], [0, 10], [20, 30]]);
  await file.slice(0, 10);
  assert.deepEqual(calls.at(-1), [0, 10]);
});

test('a failed gap cancels sibling gaps but preserves completed cached bytes', async () => {
  const { bytes } = sourceFixture();
  let fail;
  let siblingAborted = false;
  const calls = [];
  const file = rangeCachedAsyncBuffer({
    byteLength: bytes.length,
    slice(start, end, signal) {
      calls.push([start, end]);
      if (start === 10) return bytes.slice(start, end).buffer;
      return new Promise((resolve, reject) => {
        if (start === 0) fail = () => reject(new Error('network failure'));
        else signal.addEventListener('abort', () => { siblingAborted = true; reject(signal.reason); });
      });
    },
  });
  await file.slice(10, 20);
  const result = file.slice(0, 30);
  fail();
  await assert.rejects(result, /network failure/);
  assert.equal(siblingAborted, true);
  assert.deepEqual(new Uint8Array(await file.slice(10, 20)), bytes.slice(10, 20));
  assert.equal(calls.length, 3);
});

test('changed coalescing boundaries fetch only bytes beyond the cached union', async () => {
  const { source, calls, bytes } = sourceFixture();
  const file = coalescingAsyncBuffer(rangeCachedAsyncBuffer(source));
  await Promise.all([file.slice(0, 20), file.slice(40, 60)]);
  const results = await Promise.all([file.slice(30, 50), file.slice(70, 90)]);
  assert.deepEqual(calls, [[0, 60], [60, 90]]);
  assert.deepEqual(new Uint8Array(results[0]), bytes.slice(30, 50));
  assert.deepEqual(new Uint8Array(results[1]), bytes.slice(70, 90));
  assert.deepEqual(new Uint8Array(await file.slice(10, 80)), bytes.slice(10, 80));
  assert.equal(calls.length, 2);
});
