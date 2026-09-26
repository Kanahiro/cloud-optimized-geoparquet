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
