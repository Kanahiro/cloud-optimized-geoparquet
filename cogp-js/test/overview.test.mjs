import assert from 'node:assert/strict';
import test from 'node:test';

import { geometryColumnFromWkb, toGeoJSON } from '../dist/index.js';
import { decodeGeometry, GeometryBuilder } from '../dist/geometry.js';
import { projectOverviewMetadata, validateOverviewSchema } from '../dist/overview.js';
import { wkbToGeojson } from '../vendor/hyparquet/src/wkb.js';
import { appendFlat, encodeWkb } from './helpers.mjs';

const flat = (type, x, y, partEnds, polygonEnds, scale, offset) => {
  const builder = new GeometryBuilder(true);
  appendFlat(builder, type, x, y, partEnds, polygonEnds);
  return builder.finish(scale, offset);
};

test('decodes quantized multipolygon coordinates and topology', () => {
  const column = flat(6, [0, 2, 2, 0, 0], [0, 0, 2, 2, 0], [5], [1], [0.5, 0.5], [10, 20]);
  assert.deepEqual(decodeGeometry(column, 0), {
    type: 'MultiPolygon',
    coordinates: [[[[10, 20], [11, 20], [11, 21], [10, 21], [10, 20]]]],
  });
});

test('decodes quantized parts without changing topology', () => {
  const column = flat(5, new Int32Array([0, 2, 4]), new Int32Array([1, 3, 5]), new Int32Array([2, 3]), new Int32Array(0), [0.5, 2], [10, 20]);
  assert.deepEqual(decodeGeometry(column, 0), {
    type: 'MultiLineString',
    coordinates: [[[10, 22], [11, 26]], [[12, 30]]],
  });
  assert.ok(column.x instanceof Int32Array);
  assert.deepEqual([...column.ringOffsets], [0, 2, 3]);
});

test('metadata projection removes sibling LoDs from range planning', () => {
  const metadata = {
    schema: [
      { name: 'schema', num_children: 3 },
      { name: 'geometry' },
      { name: 'overviews', num_children: 2 },
      { name: 'l0', num_children: 1 },
      { name: 'x' },
      { name: 'l1', num_children: 1 },
      { name: 'x' },
      { name: 'bbox' },
    ],
    row_groups: [{
      columns: [
        { meta_data: { path_in_schema: ['geometry'] } },
        { meta_data: { path_in_schema: ['overviews', 'l0', 'x'] } },
        { meta_data: { path_in_schema: ['overviews', 'l1', 'x'] } },
        { meta_data: { path_in_schema: ['bbox'] } },
      ],
    }],
  };
  const projected = projectOverviewMetadata(metadata, 'l1', 'overviews');
  const paths = projected.row_groups[0].columns.map((column) => column.meta_data.path_in_schema);
  assert.deepEqual(paths, [
    ['geometry'],
    ['overviews', 'l1', 'x'],
    ['bbox'],
  ]);
});

test('overview schema validation requires the quantized_geoarrow physical layout', () => {
  const overviews = geometryType => ({ column: 'render', encoding: 'quantized_geoarrow',
    lods: { l0: { level_indices: [0], geometry_type: geometryType, scale: [1, 1], offset: [0, 0] } } });
  const schema = (change = {}) => [
    { name: 'schema', num_children: 1 },
    { name: 'render', repetition_type: 'REQUIRED', num_children: 1, ...change.root },
    { name: 'l0', repetition_type: 'OPTIONAL', converted_type: 'LIST', num_children: 1, ...change.list },
    { name: 'list', repetition_type: 'REPEATED', num_children: 1 },
    { name: 'element', repetition_type: 'REQUIRED', num_children: 2 },
    { name: 'x', type: 'INT32', repetition_type: 'REQUIRED', ...change.x },
    { name: 'y', type: 'INT32', repetition_type: 'REQUIRED' },
  ];
  validateOverviewSchema(schema(), overviews('LineString'));
  validateOverviewSchema(schema({ list: { converted_type: undefined, logical_type: { type: 'LIST' } } }), overviews('LineString'));
  validateOverviewSchema(schema({ x: { logical_type: { type: 'INTEGER', bitWidth: 32, isSigned: true } } }), overviews('LineString'));
  for (const [change, geometryType, message] of [
    [{}, 'MultiLineString', /2-level list/],
    [{ root: { repetition_type: 'OPTIONAL' } }, 'LineString', /required struct/],
    [{ list: { repetition_type: 'REQUIRED' } }, 'LineString', /nullable/],
    [{ list: { converted_type: undefined } }, 'LineString', /list/],
    [{ x: { converted_type: 'UINT_32' } }, 'LineString', /int32/],
    [{ x: { logical_type: { type: 'DATE' } } }, 'LineString', /int32/],
    [{ x: { name: 'lon' } }, 'LineString', /x: int32/],
  ]) assert.throws(() => validateOverviewSchema(schema(change), overviews(geometryType)), message);
  const extra = overviews('LineString');
  extra.lods.l1 = { ...extra.lods.l0, level_indices: [1] };
  assert.throws(() => validateOverviewSchema(schema(), extra), /l1/);
  assert.throws(() => validateOverviewSchema(schema({ root: { name: 'other' } }), overviews('LineString')), /`render` is missing/);
});

test('geometryColumnFromWkb maps every supported WKB type onto the shared layout', () => {
  const ring = [[0, 0], [4, 0], [4, 4], [0, 0]];
  const geometries = [
    { type: 'Point', coordinates: [1, 2] },
    { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 0]] },
    { type: 'Polygon', coordinates: [ring, [[1, 1], [2, 1], [1, 2], [1, 1]]] },
    { type: 'MultiPoint', coordinates: [[0, 0], [5, 5]] },
    { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3], [4, 4]]] },
    { type: 'MultiPolygon', coordinates: [[ring], [ring, ring]] },
  ];
  for (const little of [true, false]) {
    const values = [...geometries.map(g => encodeWkb(g, little)), null];
    const column = geometryColumnFromWkb(values);
    assert.deepEqual([column.length, column.scale, column.offset, column.z], [7, [1, 1], [0, 0], undefined]);
    assert.ok(column.x instanceof Float64Array);
    geometries.forEach((g, i) => {
      assert.deepEqual(decodeGeometry(column, i), wkbToGeojson({ view: new DataView(values[i].buffer), offset: 0 }), g.type);
    });
    assert.equal(decodeGeometry(column, 6), null);
  }
  const z = { type: 'LineString', coordinates: [[0, 0, 7], [1, 1, 8]] };
  assert.deepEqual(decodeGeometry(geometryColumnFromWkb([encodeWkb(z, true, true)]), 0), z);
  // Coordinates without Z read NaN once another row adds it.
  const mixed = geometryColumnFromWkb([encodeWkb({ type: 'Point', coordinates: [1, 2] }), encodeWkb(z, true, true)]);
  assert.deepEqual([...mixed.z], [NaN, 7, 8]);
  assert.deepEqual(decodeGeometry(geometryColumnFromWkb([encodeWkb({ type: 'Point', coordinates: [NaN, NaN] })]), 0), { type: 'Point', coordinates: [] });
  // WKB values sharing one page buffer are parsed at their own offsets.
  const a = encodeWkb(geometries[1]), b = encodeWkb(geometries[2]);
  const page = new Uint8Array(a.length + b.length); page.set(a); page.set(b, a.length);
  const shared = geometryColumnFromWkb([page.subarray(0, a.length), page.subarray(a.length)]);
  assert.deepEqual([decodeGeometry(shared, 0), decodeGeometry(shared, 1)], [geometries[1], geometries[2]]);
  assert.throws(() => geometryColumnFromWkb([Uint8Array.of(1, 7, 0, 0, 0, 0, 0, 0, 0)]), /unsupported WKB geometry type 7/);
  assert.throws(() => geometryColumnFromWkb([Uint8Array.of(...encodeWkb(geometries[1]), 0)]), /trailing/);
  assert.throws(() => geometryColumnFromWkb([encodeWkb(geometries[1]).subarray(0, 20)]), RangeError);
  assert.throws(() => decodeGeometry(shared, 2), /out of range/);
});

test('toGeoJSON converts every row into one FeatureCollection', () => {
  const line = { type: 'LineString', coordinates: [[0, 0], [1, 1]] };
  const geometry = geometryColumnFromWkb([encodeWkb(line), null]);
  assert.deepEqual(toGeoJSON({ geometry, ids: [7, 8], properties: { name: ['a', null], n: new Int32Array([1, 2]) } }), {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', id: 7, geometry: line, properties: { name: 'a', n: 1 } },
      { type: 'Feature', id: 8, geometry: null, properties: { name: null, n: 2 } },
    ],
  });
  assert.deepEqual(toGeoJSON({ geometry }).features[0], { type: 'Feature', geometry: line, properties: {} });
});

test('GeometryBuilder keeps every row across buffer growth', () => {
  // Rows just past each power of two must keep their type rather than read as null.
  const points = Array.from({ length: 5000 }, (_, i) => encodeWkb({ type: 'Point', coordinates: [i, -i] }));
  const column = geometryColumnFromWkb(points);
  assert.equal(column.length, 5000);
  assert.equal(column.types.length, 5000);
  assert.ok(column.types.every(type => type === 1));
  assert.deepEqual(decodeGeometry(column, 4999), { type: 'Point', coordinates: [4999, -4999] });
  const flat = new GeometryBuilder(true);
  for (let i = 0; i < 1000; i++) appendFlat(flat, 2, [i, i + 1], [0, 0], [], []);
  assert.ok(flat.finish().types.every(type => type === 2));
});
