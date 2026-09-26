import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {CogpReader} from '../dist/index.js';
import {PageIndexCache} from '../dist/page-index-cache.js';
import {prefetchPageIndexes} from '../vendor/hyparquet/src/plan.js';
import {setImmediate} from 'node:timers/promises';
import { readRecords, records } from './helpers.mjs';

async function indexed(options = {}) {
 const bytes = await readFile(new URL('fixtures/indexed.parquet', import.meta.url));
 const calls = [];
 const file = {byteLength:bytes.length, slice:(a,b=bytes.length,signal)=>{
  calls.push([a,b]);return options.slice ? options.slice(a,b,signal,bytes) : bytes.buffer.slice(bytes.byteOffset+a,bytes.byteOffset+b);
 }};
 const reader = await CogpReader.fromAsyncBuffer(file, 'fixture', {pageIndexCache:options.cache,rangeCache:false});
 calls.length=0;
 const ranges = reader.metadata.row_groups.flatMap(g=>g.columns.flatMap(c=>['column','offset'].filter(k=>c[k+'_index_length']).map(k=>[Number(c[k+'_index_offset']),Number(c[k+'_index_offset'])+c[k+'_index_length']])));
 const isIndex = ([a,b])=>ranges.some(([x,y])=>a<y&&x<b);
 const paths=Object.values(reader.geo.columns[reader.primaryGeometryColumn].covering.bbox).map(p=>p.join('.'));
 const filter=b=>({$and:[{[paths[0]]:{$lte:b[2]}},{[paths[1]]:{$lte:b[3]}},{[paths[2]]:{$gte:b[0]}},{[paths[3]]:{$gte:b[1]}}]});
 return {reader,file,calls,isIndex,paths,filter};
}

test('repeated and changed bboxes reuse parsed indexes but fetch/decode column data again',async()=>{
 const f=await indexed();const opts={bbox:[.5,-1,1.5,1],columns:['id','geometry']};
 const expected=await readRecords(f.reader, opts);assert.ok(f.calls.some(f.isIndex));
 const parsed=[...f.reader.pageIndexCache.cache.entries.values()].map(e=>e.value);
 for(const row of expected)row.id=-1;
 f.calls.length=0;const again=await readRecords(f.reader, opts);
 assert.deepEqual(again.map(r=>r.id),[1]);assert.ok(f.calls.length);assert.ok(f.calls.every(c=>!f.isIndex(c)));
 assert.deepEqual(new Set([...f.reader.pageIndexCache.cache.entries.values()].map(e=>e.value)),new Set(parsed));
 f.calls.length=0;await readRecords(f.reader, {...opts,bbox:[105,-1,110,1]});
 assert.ok(f.calls.every(c=>!f.isIndex(c)));
});

test('cached plans agree with upstream planning across predicates and projections',async()=>{
 const f=await indexed();
 for(const bbox of [[.5,-1,1.5,1],[105,-1,110,1],[-200,-200,200,200]])for(const columns of [['id'],['geometry'],['id','geometry','bbox']]){
  const filter=f.filter(bbox);const groups=f.reader.candidateRowGroups(f.reader.levels.length-1,{minX:bbox[0],minY:bbox[1],maxX:bbox[2],maxY:bbox[3]});
  const actual=await f.reader.pageIndexCache.plan(f.reader.metadata,groups,columns,f.paths,filter);
  const expected=await prefetchPageIndexes({file:f.file,metadata:f.reader.metadata,columns,filter});
  assert.deepEqual(actual,expected);
 }
});

test('pending indexes share parsing; cancelling one query leaves other consumers alive',async()=>{
 const f=await indexed();const pending=[];
 const cache=new PageIndexCache({...f.file,slice:(a,b,signal)=>new Promise((resolve,reject)=>{
  pending.push({signal,resolve:()=>resolve(f.file.slice(a,b))});signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
 })},f.reader.metadata);
 const args=[f.reader.metadata,[0],['id'],f.paths,f.filter([.5,-1,1.5,1])];
 const ca=new AbortController(),cb=new AbortController();
 const a=cache.plan(...args,ca.signal);const rejected=assert.rejects(a,{name:'AbortError'});
 const b=cache.plan(...args,cb.signal);await setImmediate();const count=pending.length;assert.ok(count);
 ca.abort();await rejected;assert.ok(pending.every(p=>!p.signal.aborted));pending.forEach(p=>p.resolve());
 const result=await b;assert.ok(result.pageRangesByGroup[0]);assert.equal(pending.length,count);
 await cache.plan(...args);assert.equal(pending.length,count);
});

test('last cancellation aborts sources, failed loads retry, and retention respects its budget',async()=>{
 const f=await indexed();const args=[f.reader.metadata,[0],['id'],f.paths,f.filter([.5,-1,1.5,1])];let fail=true;const signals=[];
 const cache=new PageIndexCache({...f.file,slice:(a,b,signal)=>{
  if(!fail)return f.file.slice(a,b);
  signals.push(signal);return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 }},f.reader.metadata);
 const c=new AbortController();const task=cache.plan(...args,c.signal);const rejected=assert.rejects(task,{name:'AbortError'});
 await setImmediate();c.abort();await rejected;assert.ok(signals.length&&signals.every(s=>s.aborted));
 fail=false;await cache.plan(...args);
 const sizes=[...cache.cache.entries.values()].map(e=>e.bytes);const maxBytes=Math.max(...sizes);
 const small=new PageIndexCache(f.file,f.reader.metadata,{maxBytes});await small.plan(...args);
 assert.ok(small.cache.bytes<=maxBytes);assert.ok(small.cache.entries.size<cache.cache.entries.size);
 f.calls.length=0;await small.plan(...args);assert.ok(f.calls.length,'evicted indexes must be fetched again');
 const off=new PageIndexCache(f.file,f.reader.metadata,false);await off.plan(...args);assert.equal(off.cache.entries.size,0);
 let attempts=0;const retry=new PageIndexCache({...f.file,slice:(a,b)=>{if(attempts++===0)throw Error('transient');return f.file.slice(a,b);}},f.reader.metadata);
 await assert.rejects(retry.plan(...args),/transient/);await retry.plan(...args);
 for(const maxBytes of [-1,NaN,1.5])assert.throws(()=>new PageIndexCache(f.file,f.reader.metadata,{maxBytes}));
});
test('reader cache preserves attributes, geometry, projection, LoD and caller ownership',async()=>{
 for(const name of ['attribute-encodings','quantized-geoarrow-multipolygon','quantized-geoarrow-linestring','shared']){
  const b=await readFile(new URL(`../../test-data/${name}.parquet`,import.meta.url));
  const file={byteLength:b.length,slice:(a,e=b.length)=>b.buffer.slice(b.byteOffset+a,b.byteOffset+e)};
  const plain=await CogpReader.fromAsyncBuffer(file,name,{pageIndexCache:false}),cached=await CogpReader.fromAsyncBuffer(file,name,{pageIndexCache:{}});
  for(const useOverview of [false,true])for(const maxLevel of [cached.levels.length-1,0]){
   const expected=await readRecords(plain, {maxLevel,useOverview});const actual=await cached.read({maxLevel,useOverview});assert.deepEqual(records(actual),expected,name);
   // Returned arrays are caller-owned: mutating them cannot reach cached bytes.
   for(const values of Object.values(actual.columns)){if(Array.isArray(values)||ArrayBuffer.isView(values))for(let i=0;i<values.length;i++)values[i]=typeof values[i]==='bigint'?0n:null}
   actual.geometry?.x.fill(123456);actual.geometry?.y.fill(123456);
   assert.deepEqual(await readRecords(cached, {maxLevel,useOverview}),expected,name);
  }
  for(const useOverview of [false,true]){
   const options={columns:['geometry'],useOverview};const expected=await readRecords(plain, options);const batch=await cached.read(options);
   assert.deepEqual(records(batch),expected,name);
   batch.geometry.x.fill(123456);batch.geometry.ringOffsets.fill(0);
   assert.deepEqual(await readRecords(cached, options),expected,name);
  }
 }
});
test('bbox candidates and row identities remain unchanged with mismatched pages and no indexes',async()=>{
 for(const name of ['indexed','no-index','no-statistics']){
  const b=await readFile(new URL(`fixtures/${name}.parquet`,import.meta.url));
  const file={byteLength:b.length,slice:(a,e=b.length)=>b.buffer.slice(b.byteOffset+a,b.byteOffset+e)};
  const plain=await CogpReader.fromAsyncBuffer(file,name,{pageIndexCache:false}),cached=await CogpReader.fromAsyncBuffer(file,name,{pageIndexCache:{}});
  for(const bbox of [[0.5,-1,1.5,1],[0,-2,110,2],[3,-1,5,1],[0.5,-1,1.5,1]]){
   const options={bbox,columns:['id','geometry']};
   assert.deepEqual(await readRecords(cached, options),await readRecords(plain, options),name);
  }
 }
});
