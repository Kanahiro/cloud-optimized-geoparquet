import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { cachedRangeBuffer } from '../dist/range-cache.js';
import { CogpReader } from '../dist/index.js';
import { readFile } from 'node:fs/promises';
import { readRecords } from './helpers.mjs';

function fixture(maxBytes = 8) {
  const calls = [];
  const source = { byteLength: 32, slice(a, b) {
    calls.push([a,b]); return Uint8Array.from({length:b-a}, (_,i)=>a+i).buffer;
  }};
  return { calls, source, cache: cachedRangeBuffer(source, {maxBytes}) };
}
test('exact and contained hits return isolated copies and obey LRU budget', async () => {
  const {cache,calls}=fixture();
  new Uint8Array(await cache.slice(0,4)).fill(99);
  assert.deepEqual([...new Uint8Array(await cache.slice(1,3))],[1,2]);
  await cache.slice(4,8); await cache.slice(0,4); await cache.slice(8,12);
  await cache.slice(0,4); assert.equal(calls.length,3);
  await cache.slice(4,8); assert.equal(calls.length,4);
  await cache.slice(0,16); await cache.slice(0,16); assert.equal(calls.length,6);
});
test('disabled cache and invalid options/ranges', async () => {
  const {source,cache}=fixture();
  assert.equal(cachedRangeBuffer(source,false),source);
  assert.equal(cachedRangeBuffer(source,{maxBytes:0}),source);
  for(const maxBytes of [-1,NaN,Infinity,1.5]) assert.throws(()=>cachedRangeBuffer(source,{maxBytes}));
  for(const range of [[-1,2],[2,1],[0,33],[.5,2]]) await assert.rejects(cache.slice(...range));
  assert.equal((await cache.slice(2,2)).byteLength,0);
});
test('shared reads survive one cancellation, abort after all leave, and retry',async()=>{
  const pending=[];
  const cache=cachedRangeBuffer({byteLength:8,slice(a,b,signal){
    return new Promise((resolve,reject)=>{
      pending.push({signal,resolve});
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    });
  }});
  const a=new AbortController(),b=new AbortController();
  const first=cache.slice(0,4,a.signal), second=cache.slice(0,4,b.signal);
  const rejected=assert.rejects(first,{name:'AbortError'});
  await setImmediate(); a.abort(); await rejected;
  assert.equal(pending.length,1); assert.equal(pending[0].signal.aborted,false);
  pending[0].resolve(new ArrayBuffer(4));await second;
  await cache.slice(0,4);assert.equal(pending.length,1);
  const c=new AbortController();const third=cache.slice(4,8,c.signal);
  const aborted=assert.rejects(third,{name:'AbortError'});
  await setImmediate();c.abort();await aborted;
  assert.equal(pending[1].signal.aborted,true);
  const retry=cache.slice(4,8);await setImmediate();
  pending[2].resolve(new ArrayBuffer(4));await retry;
});
test('failed and short reads are not retained',async()=>{
  let calls=0;
  const cache=cachedRangeBuffer({byteLength:4,slice(){
    calls++;if(calls===1)throw new Error('transport');return new ArrayBuffer(calls===2?2:4);
  }});
  await assert.rejects(cache.slice(0,4),/transport/);
  await assert.rejects(cache.slice(0,4),/short/);
  await cache.slice(0,4);await cache.slice(0,4);assert.equal(calls,3);
});
test('reader reuses ranges without retaining decoded caller mutations',async()=>{
  const bytes=await readFile(new URL('fixtures/indexed.parquet',import.meta.url));
  let calls=0;
  const reader=await CogpReader.fromAsyncBuffer({byteLength:bytes.length,slice(a,b=bytes.length){
    calls++;return bytes.buffer.slice(bytes.byteOffset+a,bytes.byteOffset+b);
  }}, 'fixture:indexed');
  const options={columns:['id','geometry']};
  const expected=await readRecords(reader, options);assert.ok(expected.length);
  const actual=await reader.read(options);actual.columns.id[0]=-1;actual.geometry.x.fill(-1);
  calls=0;assert.deepEqual(await readRecords(reader, options),expected);assert.equal(calls,0);
});
test('a transport ignoring abort cannot populate the cache or displace a retry',async()=>{
  const pending=[];
  const cache=cachedRangeBuffer({byteLength:4,slice(){return new Promise(resolve=>pending.push(resolve));}});
  const controller=new AbortController();
  const first=cache.slice(0,4,controller.signal);const rejected=assert.rejects(first,{name:'AbortError'});
  await setImmediate();controller.abort();await rejected;
  const retry=cache.slice(0,4);await setImmediate();assert.equal(pending.length,2);
  pending[0](new Uint8Array([1,1,1,1]).buffer);await setImmediate();
  const shared=cache.slice(0,4);await setImmediate();assert.equal(pending.length,2);
  pending[1](new Uint8Array([2,2,2,2]).buffer);
  assert.deepEqual([...new Uint8Array(await retry)],[2,2,2,2]);await shared;
  assert.deepEqual([...new Uint8Array(await cache.slice(0,4))],[2,2,2,2]);
});
