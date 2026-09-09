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
  const { source, calls } = sourceFixture(40_000);
  const file = coalescingAsyncBuffer(source);
  const distantStart = 39_000;

  const [a, b, c] = await Promise.all([
    file.slice(10, 20),
    file.slice(25, 35),
    file.slice(distantStart, distantStart + 10),
  ]);

  assert.deepEqual(calls, [[10, 35], [distantStart, distantStart + 10]]);
  assert.deepEqual([...new Uint8Array(a)], [...Array(10)].map((_, i) => i + 10));
  assert.deepEqual([...new Uint8Array(b)], [...Array(10)].map((_, i) => i + 25));
  assert.deepEqual([...new Uint8Array(c)], [...Array(10)].map((_, i) => (i + distantStart) & 0xff));
});

test('limits cumulative overfetch to 32 KiB', async () => {
  const { source, calls } = sourceFixture(40_000);
  const file = coalescingAsyncBuffer(source);
  const secondStart = 10 + 16 * 1024;
  const thirdStart = secondStart + 10 + 16 * 1024;

  await Promise.all([
    file.slice(0, 10),
    file.slice(secondStart, secondStart + 10),
    file.slice(thirdStart, thirdStart + 10),
    file.slice(thirdStart + 11, thirdStart + 21),
  ]);

  // The first three ranges contain exactly 32 KiB of gaps. One more byte of
  // overfetch starts a new request.
  assert.deepEqual(calls, [[0, thirdStart + 10], [thirdStart + 11, thirdStart + 21]]);
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

test('passes through an exact run without copying its buffer', async () => {
  const sourceBuffer = new ArrayBuffer(10);
  const file = coalescingAsyncBuffer({
    byteLength: 10,
    slice() {
      return sourceBuffer;
    },
  });

  assert.equal(await file.slice(0, 10), sourceBuffer);
});

test('never requests or merges across protected ranges', async () => {
  const { source, calls } = sourceFixture();
  const file = coalescingAsyncBuffer(source, {
    protectedRanges: [{ start: 20, end: 30 }],
  });

  await Promise.all([file.slice(10, 20), file.slice(30, 40)]);
  assert.deepEqual(calls, [[10, 20], [30, 40]]);
  await assert.rejects(file.slice(19, 21), /protected range/);
  assert.deepEqual(calls, [[10, 20], [30, 40]]);
});

test('keeps a coalesced fetch alive until every slice is aborted', async () => {
  const bytes = Uint8Array.from({ length: 64 }, (_, i) => i);
  let complete;
  let sourceAborted = false;
  const source = {
    byteLength: bytes.byteLength,
    slice(start, end, signal) {
      signal.addEventListener('abort', () => { sourceAborted = true; }, { once: true });
      return new Promise(resolve => {
        complete = () => resolve(bytes.slice(start, end).buffer);
      });
    },
  };
  const file = coalescingAsyncBuffer(source);
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = file.slice(10, 20, firstController.signal);
  const second = file.slice(25, 35, secondController.signal);
  await Promise.resolve(); // Allow the coalesced source request to start.

  firstController.abort();
  await assert.rejects(first, error => error.name === 'AbortError');
  assert.equal(sourceAborted, false);
  complete();
  assert.deepEqual([...new Uint8Array(await second)], [...Array(10)].map((_, i) => i + 25));
});

test('aborts a coalesced fetch when every slice is aborted', async () => {
  let sourceAborted = false;
  const source = {
    byteLength: 64,
    slice(_start, _end, signal) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          sourceAborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    },
  };
  const file = coalescingAsyncBuffer(source);
  const controller = new AbortController();
  const read = file.slice(10, 20, controller.signal);
  await Promise.resolve();

  controller.abort();
  await assert.rejects(read, error => error.name === 'AbortError');
  assert.equal(sourceAborted, true);
});
