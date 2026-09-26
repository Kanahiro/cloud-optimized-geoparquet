import assert from 'node:assert/strict';
import test from 'node:test';

import { abortableAsyncBufferFromUrl } from '../dist/http-buffer.js';

test('propagates a slice AbortSignal to the Range fetch', async () => {
  let receivedSignal;
  const fetch = async (_input, init) => {
    receivedSignal = init.signal;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };
  const file = await abortableAsyncBufferFromUrl('https://example.test/data.parquet', {
    byteLength: 1024,
    fetch,
  });
  const controller = new AbortController();
  const read = file.slice(10, 20, controller.signal);

  assert.equal(receivedSignal, controller.signal);
  controller.abort();
  await assert.rejects(read, error => error.name === 'AbortError');
});

test('retries a transient network failure on a Range fetch', async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('Failed to fetch');
    return new Response(new Uint8Array(10), { status: 206 });
  };
  const file = await abortableAsyncBufferFromUrl('https://example.test/data.parquet', {
    byteLength: 1024,
    fetch,
  });
  const bytes = await file.slice(10, 20);
  assert.equal(bytes.byteLength, 10);
  assert.equal(calls, 2);
});

test('gives up after repeated overload responses', async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return new Response('busy', { status: 503 });
  };
  const file = await abortableAsyncBufferFromUrl('https://example.test/data.parquet', {
    byteLength: 1024,
    fetch,
  });
  await assert.rejects(file.slice(10, 20), /fetch failed 503/);
  assert.equal(calls, 3);
});

test('does not retry after the caller aborts', async () => {
  let calls = 0;
  const controller = new AbortController();
  const fetch = async () => {
    calls += 1;
    controller.abort();
    throw new TypeError('Failed to fetch');
  };
  const file = await abortableAsyncBufferFromUrl('https://example.test/data.parquet', {
    byteLength: 1024,
    fetch,
  });
  await assert.rejects(file.slice(10, 20, controller.signal), error => error.name === 'AbortError');
  assert.equal(calls, 1);
});
