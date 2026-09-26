import assert from 'node:assert/strict';
import test from 'node:test';

import { CogpReader } from '../dist/index.js';
import { readRecord, readRecords } from './helpers.mjs';

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

test('package exposes the reader and stable row identity as runtime APIs', async () => {
  const api = await import('../dist/index.js');
  assert.deepEqual(Object.keys(api).sort(), ['CogpReader', 'MVT_BUFFER', 'MVT_EXTENT', 'geometryColumnFromWkb', 'toGeoJSON', 'toMvt']);
});

test('HTTP readRow can read primary WKB with overview protection enabled', async () => {
  const {readFile} = await import('node:fs/promises');
  const bytes = await readFile(new URL('../../test-data/quantized-geoarrow-polygon.parquet', import.meta.url));
  const file = {byteLength:bytes.length,slice(a,b=bytes.length){return bytes.buffer.slice(bytes.byteOffset+a,bytes.byteOffset+b);}};
  const fetch = async (_url, init) => {
    if (init?.method === 'HEAD') return new Response(null,{headers:{'Content-Length':String(bytes.length)}});
    const [,a,b] = /bytes=(\d+)-(\d+)/.exec(new Headers(init.headers).get('Range'));
    return new Response(bytes.subarray(+a,+b+1),{status:206,headers:{'Content-Range':`bytes ${a}-${b}/${bytes.length}`}});
  };
  const http = await CogpReader.open('https://example.test/polygon.parquet',{fetch});
  const memory = await CogpReader.fromAsyncBuffer(file,'memory');
  assert.deepEqual(await readRecord(http, 0), await readRecord(memory, 0));
  assert.deepEqual(await readRecords(http, ), await readRecords(memory, ));
  const metadata = structuredClone(memory.metadata);
  const geo = JSON.parse(metadata.key_value_metadata.find(k => k.key === 'geo').value);
  geo.lod.overviews.encoding = 'future_v3';
  for (const lod of Object.values(geo.lod.overviews.lods)) {delete lod.scale; delete lod.offset; lod.geometry_type = {future:1};}
  metadata.key_value_metadata.find(k => k.key === 'geo').value = JSON.stringify(geo);
  const future = new CogpReader(file, metadata, 'future');
  const primary = (await readRecord(memory, 0)).geometry;
  assert.deepEqual((await readRecords(future, {maxLevel:0,columns:['geometry']}))[0].geometry, primary);
  assert.equal(future.hasOverviews, false);
  await assert.rejects(future.read({maxLevel:0,useOverview:true}), /unsupported overview encoding `future_v3`/);
});
