import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CogpReader } from '../dist/index.js';
import { decodeQuantizedOverview, parseGeoArrowLeaves } from '../dist/overview.js';

const ring = [[0,0],[4,0],[4,4],[0,4],[0,0]];
const hole = [[1,1],[1,2],[2,2],[2,1],[1,1]];
const shapes = {
  LineString: [[0,0],[4,2],[8,0]],
  MultiLineString: [[[0,0],[4,2]],[[5,1],[8,0]]],
  Polygon: [ring,hole],
  MultiPolygon: [[ring,hole],[[[6,0],[8,0],[8,2],[6,2],[6,0]]]],
};
const transform = (v, scale, shift = 0) => typeof v[0] === 'number'
  ? [(v[0] + shift) * scale + 10, v[1] * scale + 20]
  : v.map(child => transform(child, scale, shift));
async function open(name) {
  const data = await readFile(new URL(`../../test-data/${name}.parquet`, import.meta.url));
  const requests = [];
  const reader = await CogpReader.fromAsyncBuffer({ byteLength: data.length, slice(a,b=data.length) {
    requests.push([a,b]);
    return data.buffer.slice(data.byteOffset+a,data.byteOffset+b);
  }}, name);
  requests.length = 0;
  return {reader,requests};
}
for (const [type, shape] of Object.entries(shapes)) {
  test(`${type}: nested topology, transforms, shared LoD and ordinary overviews attribute`, async () => {
    const {reader,requests} = await open(`quantized-geoarrow-${type.toLowerCase()}`);
    const columns = ['id','geometry','overviews'];
    const coarse = await reader.readRows({columns,maxLevel:0});
    assert.deepEqual(coarse, [{id:0, overviews:'ordinary attribute',geometry:{type,coordinates:transform(shape,2)}}]);
    // Only the selected LoD is fetched, and the primary WKB remains untouched.
    for (const group of reader.metadata.row_groups) for (const {meta_data:c} of group.columns) {
      if (c.path_in_schema[0] !== 'geometry' && c.path_in_schema[1] !== 'fine') continue;
      const start = Number(c.dictionary_page_offset ?? c.data_page_offset);
      const end = start + Number(c.total_compressed_size);
      assert.ok(requests.every(([a,b]) => b<=start || a>=end), `unexpected read: ${c.path_in_schema}`);
    }
    const fine = await reader.readRows({columns,maxLevel:2});
    assert.deepEqual(fine.map(r=>r.geometry), [0,100,200].map(shift=>({type,coordinates:transform(shape,1,shift)})));
    assert.deepEqual(await reader.readRows({columns,maxLevel:1}),fine.slice(0,1));
    assert.deepEqual(await reader.readRows({columns,maxLevel:0}),coarse);
    assert.deepEqual(await reader.readRows({columns,maxLevel:2,overviewDecoder:decodeQuantizedOverview}),fine);
    assert.deepEqual((await reader.readRows({columns,maxLevel:2,bbox:[99,-1,109,5]})).map(r=>r.id),[1]);
  });
}
test('flat encoding reads an explicitly named overview column', async () => {
  const a = (await open('refinement')).reader, b = (await open('renamed-overview')).reader;
  for (let maxLevel=0;maxLevel<3;maxLevel++) {
    const options={maxLevel,columns:['id','geometry']};
    assert.deepEqual(await b.readRows(options), await a.readRows(options));
  }
});
test('nested decoder rejects missing, mismatched and non-int32 coordinates', () => {
  const meta={geometry_type:'LineString',scale:[1,1],offset:[0,0]};
  for(const [x,y] of [[null,null], [[],[]], [[1,2],[1]], [[1.5],[0]], [[2147483648],[0]]]) {
    assert.throws(()=>parseGeoArrowLeaves(x,y,meta), /quantized_geoarrow/);
  }
});
