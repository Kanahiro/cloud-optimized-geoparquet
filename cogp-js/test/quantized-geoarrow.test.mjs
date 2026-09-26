import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CogpReader } from '../dist/index.js';
import { appendGeoArrowLeaves, GeometryBuilder } from '../dist/geometry.js';
import { readRecords } from './helpers.mjs';

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
  // Overview geometry is returned quantized; records() compares its GeoJSON form.
  const read = options => readRecords(reader, {useOverview:true,...options});
  return {reader,requests,read};
}
for (const [type, shape] of Object.entries(shapes)) {
  test(`${type}: nested topology, transforms, shared LoD and ordinary overviews attribute`, async () => {
    const {reader,requests,read} = await open(`quantized-geoarrow-${type.toLowerCase()}`);
    const columns = ['id','geometry','overviews'];
    const coarse = await read({columns,maxLevel:0});
    assert.deepEqual(coarse, [{id:0, overviews:'ordinary attribute',geometry:{type,coordinates:transform(shape,2)}}]);
    // Only the selected LoD is fetched, and the primary WKB remains untouched.
    for (const group of reader.metadata.row_groups) for (const {meta_data:c} of group.columns) {
      if (c.path_in_schema[0] !== 'geometry' && c.path_in_schema[1] !== 'fine') continue;
      const start = Number(c.dictionary_page_offset ?? c.data_page_offset);
      const end = start + Number(c.total_compressed_size);
      assert.ok(requests.every(([a,b]) => b<=start || a>=end), `unexpected read: ${c.path_in_schema}`);
    }
    const fine = await read({columns,maxLevel:2});
    assert.deepEqual(fine.map(r=>r.geometry), [0,100,200].map(shift=>({type,coordinates:transform(shape,1,shift)})));
    assert.deepEqual(await read({columns,maxLevel:1}),fine.slice(0,1));
    assert.deepEqual(await read({columns,maxLevel:0}),coarse);
    assert.deepEqual((await read({columns,maxLevel:2,bbox:[99,-1,109,5]})).map(r=>r.id),[1]);
    // Without useOverview the same shape carries lossless primary WKB coordinates.
    const raw = await reader.read({columns,maxLevel:2});
    assert.ok(raw.geometry.x instanceof Float64Array && raw.geometry.scale[0] === 1);
    const rawRows = await readRecords(reader, {columns,maxLevel:2});
    assert.deepEqual(rawRows.map(r => r.geometry.type), fine.map(r => r.geometry.type));
    assert.deepEqual(rawRows.map(r => r.overviews), fine.map(r => r.overviews));
  });
}
test('a producer-defined overview column name reads like the default name', async () => {
  const a = await open('refinement'), b = await open('renamed-overview');
  for (let maxLevel=0;maxLevel<3;maxLevel++) {
    const options={maxLevel,columns:['id','geometry']};
    assert.deepEqual(await b.read(options), await a.read(options));
  }
});
// Build a column-view leaf for one row from per-page [values, definitionLevels, repetitionLevels].
function leaf(pages) {
  let event = 0, value = 0;
  const indexed = pages.map(([values, definitionLevels, repetitionLevels]) => {
    const page = { values: Int32Array.from(values), definitionLevels, repetitionLevels,
      eventStart: event, eventEnd: event + repetitionLevels.length, valueStart: value };
    event = page.eventEnd; value += values.length;
    return page;
  });
  return { rowStart: 0, rowOffsets: [0, event], valueOffsets: [0, value], pages: indexed };
}
test('nested decoder walks repetition levels across pages', () => {
  // MultiPolygon [[[1,2],[3]],[[4]]]; the row continues on a page without definition levels.
  const x = leaf([[[1, 2], [5, 5], [0, 3]], [[3, 4], [], [2, 1]]]);
  const y = leaf([[[10], [5], [0]], [[20, 30, 40], [], [3, 2, 1]]]);
  const builder = new GeometryBuilder(true);
  appendGeoArrowLeaves(builder, 6, 3, x, y, 5, 0);
  const g = builder.finish();
  assert.deepEqual([...g.x], [1, 2, 3, 4]);
  assert.deepEqual([...g.y], [10, 20, 30, 40]);
  assert.deepEqual([...g.geometryOffsets], [0, 2]);
  assert.deepEqual([...g.polygonOffsets], [0, 2, 3]);
  assert.deepEqual([...g.ringOffsets], [0, 2, 3, 4]);
});
test('nested decoder appends an empty outermost list as a row without parts', () => {
  const empty = leaf([[[], [2], [0]]]);
  const builder = new GeometryBuilder(true);
  appendGeoArrowLeaves(builder, 6, 3, empty, empty, 5, 0);
  const g = builder.finish();
  assert.deepEqual([...g.types], [6]);
  assert.deepEqual([...g.geometryOffsets], [0, 0]);
  // An empty nested list is still invalid.
  const emptyPolygon = leaf([[[], [3], [0]]]);
  assert.throws(() => appendGeoArrowLeaves(new GeometryBuilder(true), 6, 3, emptyPolygon, emptyPolygon, 5, 0), /quantized_geoarrow/);
});
test('nested decoder rejects null, empty and mismatched XY leaves', () => {
  const line = leaf([[[1, 2], [], [0, 1]]]);
  for (const [x, y] of [
    [leaf([[[], [0], [0]]]), line], // null row
    [leaf([[[], [1], [0]]]), line], // empty list with a y vertex
    [leaf([[[1], [], [0]]]), line], // fewer y vertices
    [line, leaf([[[1, 2], [], [0, 0]]])], // y starts a second row
  ]) {
    assert.throws(() => appendGeoArrowLeaves(new GeometryBuilder(true), 2, 1, x, y, 2, 0), /quantized_geoarrow/);
  }
});
