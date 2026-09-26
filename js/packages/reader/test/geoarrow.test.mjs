import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { tableFromIPC } from 'apache-arrow';

import { CogpReader, geometryColumnFromWkb, toGeoArrow, toGeoJSON } from '../dist/index.js';
import { columnFromGeoJSON, encodeWkb } from './helpers.mjs';

// Nested Arrow values back to coordinate arrays.
const coords = value => {
  if (value === null) return null;
  const items = [...value];
  return typeof items[0] === 'number' ? items : items.map(coords);
};
const extension = field => ({
  name: field.metadata.get('ARROW:extension:name'),
  metadata: JSON.parse(field.metadata.get('ARROW:extension:metadata')),
});

test('writes polygons as dequantized geoarrow.multipolygon with rowIndex and attributes', () => {
  const geometry = columnFromGeoJSON([
    { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] },
    null,
    { type: 'MultiPolygon', coordinates: [
      [[[10, 10], [12, 10], [12, 12], [10, 10]]],
      [[[20, 20], [22, 20], [22, 22], [20, 20]], [[20.5, 20.5], [21, 20.5], [21, 21], [20.5, 20.5]]],
    ] },
  ], { int32: true, scale: [0.5, 0.5], offset: [0, 0] });
  const table = tableFromIPC(toGeoArrow({
    geometry,
    rowIndex: Float64Array.of(7, 8, 9),
    columns: { name: ['a', null, 'c'], height: Int32Array.of(1, 2, 3) },
  }, { crs: 'OGC:CRS84' }));

  assert.deepEqual(table.schema.fields.map(f => f.name), ['rowIndex', 'name', 'height', 'geometry']);
  assert.deepEqual(extension(table.schema.fields[3]), { name: 'geoarrow.multipolygon', metadata: { crs: 'OGC:CRS84' } });
  assert.equal(table.numRows, 3);
  assert.deepEqual([...table.getChild('rowIndex')], [7n, 8n, 9n]);
  assert.deepEqual([...table.getChild('name')], ['a', null, 'c']);
  assert.deepEqual([...table.getChild('height')], [1, 2, 3]);
  const g = table.getChild('geometry');
  assert.equal(g.nullCount, 1);
  assert.deepEqual(coords(g.get(0)), [[[[0, 0], [2, 0], [2, 2], [0, 0]]]]);
  assert.equal(g.get(1), null);
  assert.deepEqual(coords(g.get(2))[1][1], [[20.5, 20.5], [21, 20.5], [21, 21], [20.5, 20.5]]);
});

test('promotes lines and points to their multi types', () => {
  const lines = tableFromIPC(toGeoArrow({ geometry: columnFromGeoJSON([
    { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
    { type: 'MultiLineString', coordinates: [[[2, 2], [3, 3]], [[4, 4], [5, 5], [6, 6]]] },
  ]) }));
  assert.equal(extension(lines.schema.fields[0]).name, 'geoarrow.multilinestring');
  assert.deepEqual([...lines.getChild('geometry')].map(coords), [
    [[[0, 0], [1, 1]]],
    [[[2, 2], [3, 3]], [[4, 4], [5, 5], [6, 6]]],
  ]);

  const points = tableFromIPC(toGeoArrow({ geometry: columnFromGeoJSON([
    null,
    { type: 'Point', coordinates: [1, 2] },
    { type: 'MultiPoint', coordinates: [[3, 4], [5, 6]] },
  ]) }, { geometryColumn: 'geom' }));
  assert.deepEqual(extension(points.schema.fields[0]), { name: 'geoarrow.multipoint', metadata: {} });
  assert.deepEqual([...points.getChild('geom')].map(coords), [null, [[1, 2]], [[3, 4], [5, 6]]]);
});

test('keeps Z as xyz coordinates', () => {
  const geometry = geometryColumnFromWkb([encodeWkb({ type: 'LineString', coordinates: [[1, 2, 3], [4, 5, 6]] }, true, true)]);
  const table = tableFromIPC(toGeoArrow({ geometry }));
  const field = table.schema.fields[0];
  assert.equal(field.type.children[0].type.children[0].type.listSize, 3);
  // A FixedSizeList child holds every dimension; Arrow C++ rejects a shorter one.
  assert.equal(table.getChild('geometry').data[0].children[0].children[0].children[0].length, 6);
  assert.deepEqual(coords(table.getChild('geometry').get(0)), [[[1, 2, 3], [4, 5, 6]]]);
});

test('infers attribute types from plain values', () => {
  const geometry = columnFromGeoJSON([{ type: 'Point', coordinates: [0, 0] }, null, { type: 'Point', coordinates: [1, 1] }]);
  const date = new Date('2024-01-02T03:04:05.678Z');
  const table = tableFromIPC(toGeoArrow({
    geometry,
    columns: {
      number: [1.5, undefined, 3],
      bigint: [1n, 2n, null],
      bool: [true, false, null],
      bytes: [Uint8Array.of(1, 2), null, Uint8Array.of()],
      date: [date, null, new Date(NaN)],
      mixed: [1, 'two', { three: 3 }],
      empty: [null, null, null],
      float32: Float32Array.of(0.5, 1, 2),
    },
  }));
  const type = name => String(table.schema.fields.find(f => f.name === name).type);
  assert.equal(type('number'), 'Float64');
  assert.equal(type('bigint'), 'Int64');
  assert.equal(type('bool'), 'Bool');
  assert.equal(type('bytes'), 'Binary');
  assert.match(type('date'), /Timestamp<MILLISECOND, UTC>/);
  assert.equal(type('mixed'), 'Utf8');
  assert.equal(type('float32'), 'Float32');
  assert.deepEqual([...table.getChild('number')], [1.5, null, 3]);
  assert.deepEqual([...table.getChild('bigint')], [1n, 2n, null]);
  assert.deepEqual([...table.getChild('bool')], [true, false, null]);
  assert.deepEqual([...table.getChild('bytes')].map(v => v && [...v]), [[1, 2], null, []]);
  assert.deepEqual([...table.getChild('date')], [date.getTime(), null, null]);
  assert.deepEqual([...table.getChild('mixed')], ['1', 'two', '{"three":3}']);
  assert.deepEqual([...table.getChild('empty')], [null, null, null]);
  assert.deepEqual([...table.getChild('float32')], [0.5, 1, 2]);
});

test('rejects mixed families, duplicate names and misaligned columns', () => {
  const mixed = columnFromGeoJSON([{ type: 'Point', coordinates: [0, 0] }, { type: 'LineString', coordinates: [[0, 0], [1, 1]] }]);
  assert.throws(() => toGeoArrow({ geometry: mixed }), /mixed point and linestring/);
  const geometry = columnFromGeoJSON([{ type: 'Point', coordinates: [0, 0] }]);
  assert.throws(() => toGeoArrow({ geometry, columns: { geometry: [1] } }), /duplicate GeoArrow field geometry/);
  assert.throws(() => toGeoArrow({ geometry, columns: { a: [1, 2] } }), /has 2 values, expected 1/);
  assert.throws(() => toGeoArrow({}), /no geometry/);
});

test('writes an all-null geometry column as geoarrow.multipolygon', () => {
  const table = tableFromIPC(toGeoArrow({ geometry: columnFromGeoJSON([null, null]) }));
  assert.equal(extension(table.schema.fields[0]).name, 'geoarrow.multipolygon');
  assert.deepEqual([...table.getChild('geometry')], [null, null]);
});

test('matches toGeoJSON for overview and primary reads of fixtures', async () => {
  for (const name of ['quantized-geoarrow-polygon', 'quantized-geoarrow-multilinestring', 'attribute-encodings']) {
    const data = await readFile(new URL(`../../../../test-data/${name}.parquet`, import.meta.url));
    const reader = await CogpReader.fromAsyncBuffer({ byteLength: data.length, slice: (a, b = data.length) => data.buffer.slice(data.byteOffset + a, data.byteOffset + b) }, name);
    for (const useOverview of reader.hasOverviews ? [true, false] : [false]) {
      const batch = await reader.read({ useOverview });
      const table = tableFromIPC(toGeoArrow(batch));
      const features = toGeoJSON(batch).features;
      assert.equal(table.numRows, features.length);
      const geometry = table.getChild('geometry');
      features.forEach((feature, i) => {
        const multi = !feature.geometry ? null : feature.geometry.type.startsWith('Multi')
          ? feature.geometry.coordinates : [feature.geometry.coordinates];
        assert.deepEqual(coords(geometry.get(i)), multi, `${name} row ${i}`);
        assert.equal(Number(table.getChild('rowIndex').get(i)), feature.id);
      });
    }
  }
});
