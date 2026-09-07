import assert from 'node:assert/strict';
import test from 'node:test';

import { CogpReader } from '../dist/index.js';

test('open disables the browser cache for HEAD and range requests', async () => {
  const receivedInits = [];
  const invalidEmptyParquet = Uint8Array.of(0, 0, 0, 0, 80, 65, 82, 49);
  const fetch = async (_input, init) => {
    receivedInits.push(init);
    if (init?.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: { 'Content-Length': String(invalidEmptyParquet.byteLength) },
      });
    }
    return new Response(invalidEmptyParquet, { status: 206 });
  };

  await assert.rejects(CogpReader.open('https://example.test/data.parquet', {
    fetch,
    // Runtime callers cannot override the cache mode even from plain JS.
    requestInit: {
      cache: 'force-cache',
      credentials: 'include',
      headers: { 'X-Test': 'preserved' },
    },
  }));

  assert.equal(receivedInits.length, 2);
  assert.ok(receivedInits.every(init => init.cache === 'no-store'));
  assert.ok(receivedInits.every(init => init.credentials === 'include'));
  assert.equal(receivedInits[0].method, 'HEAD');
  const headers = new Headers(receivedInits[1].headers);
  assert.equal(headers.get('X-Test'), 'preserved');
  assert.equal(headers.get('Range'), 'bytes=0-7');
});
