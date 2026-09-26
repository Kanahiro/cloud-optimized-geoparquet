import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

// Decode with the versions MapLibre GL uses.
const require = createRequire(import.meta.url);
const { VectorTile } = require('@mapbox/vector-tile');
const Pbf = require('pbf');

import { clipLineString, clipPolygonRing, pointInBbox } from '../dist/clip.js';
import { encodeGeometryRow, encodeMvtTile } from '../dist/mvt.js';
import { GeometryBuilder } from '../dist/geometry.js';
import { appendFlat, columnFromGeoJSON, encodeWkb } from './helpers.mjs';

// Encode one GeoJSON geometry, or one flat overview row, through the columnar encoder.
const encodePrimaryFeature = (geometry, z, x, y, id) => encodeGeometryRow(columnFromGeoJSON([geometry]), 0, z, x, y, id);
const createOverviewMvtEncoder = (z, x, y) => (overview, id) => {
  const builder = new GeometryBuilder(false);
  appendFlat(builder, overview.type, overview.x, overview.y, overview.partEnds, overview.polygonEnds);
  return encodeGeometryRow(builder.finish(overview.scale, overview.offset), 0, z, x, y, id);
};

const bbox = [0, 0, 10, 10];

test('clips a polygon ring to the buffered tile rectangle', () => {
  assert.deepEqual(
    clipPolygonRing([[-5, 2], [5, 2], [5, 8], [-5, 8]], bbox),
    [[0, 2], [5, 2], [5, 8], [0, 8]],
  );
});

test('reduces a polygon containing the tile to the four clip corners', () => {
  const clipped = clipPolygonRing([[-100, -100], [100, -100], [100, 100], [-100, 100]], bbox);
  assert.equal(clipped.length, 4);
  assert.ok(clipped.every(([x, y]) => pointInBbox(x, y, bbox)));
});

test('splits a line that leaves and re-enters the tile', () => {
  assert.deepEqual(
    clipLineString([[2, 2], [12, 2], [12, 8], [2, 8]], bbox),
    [[[2, 2], [10, 2]], [[10, 8], [2, 8]]],
  );
});

test('drops rings that collapse after integer rounding', () => {
  assert.deepEqual(clipPolygonRing([[1, 1], [1.1, 1], [1, 1.1]], bbox), []);
});

test('encodes only the clipped boundary of a huge polygon', () => {
  const vertexCount = 50_000;
  const x = new Int32Array(vertexCount + 1);
  const y = new Int32Array(vertexCount + 1);
  for (let i = 0; i < vertexCount; i++) {
    const angle = (i / vertexCount) * Math.PI * 2;
    x[i] = Math.round(Math.cos(angle) * 10_000);
    y[i] = Math.round(Math.sin(angle) * 10_000);
  }
  x[vertexCount] = x[0];
  y[vertexCount] = y[0];
  const encode = createOverviewMvtEncoder(10, 512, 512);
  const feature = encode({
    type: 3,
    x,
    y,
    partEnds: new Int32Array([vertexCount + 1]),
    polygonEnds: new Int32Array([1]),
    scale: [0.001, 0.001],
    offset: [0, 0],
  }, 17);

  assert.ok(feature);
  assert.equal(feature.id, 17);
  assert.ok(
    feature.geometry.byteLength < 100,
    `expected clipped MVT geometry, got ${feature.geometry.byteLength} bytes`,
  );
});

test('drops point-family coordinates outside the buffered tile', () => {
  assert.equal(encodePrimaryFeature({ type: 'Point', coordinates: [120, 45] }, 10, 512, 512), null);
});

test('preserves the source-row identity when no properties are supplied', () => {
  const feature = encodePrimaryFeature(
    { type: 'Point', coordinates: [0, 0] },
    0,
    0,
    0,
    42,
  );
  assert.ok(feature);
  assert.equal(feature.id, 42);
  assert.ok(encodeMvtTile([feature]).byteLength > feature.geometry.byteLength);
});

test('primary lines and polygons render when the file has no overviews', () => {
  const geometries = [
    {type: 'LineString', coordinates: [[-10, 0], [10, 0]]},
    {type: 'MultiLineString', coordinates: [[[-10, 0], [10, 0]]]},
    {type: 'Polygon', coordinates: [[[-10, -10], [10, -10], [10, 10], [-10, -10]]]},
    {type: 'MultiPolygon', coordinates: [[[[-10, -10], [10, -10], [10, 10], [-10, -10]]]]},
  ];
  for (const geometry of geometries) {
    const feature = encodePrimaryFeature(geometry, 0, 0, 0, 7);
    assert.equal(feature.id, 7);
    assert.ok(feature.geometry.length > 0);
    assert.equal(feature.type, geometry.type.includes('Line') ? 2 : 3);
  }
});


test('popup attributes survive MVT decoding with existing display formatting', () => {
  const feature = encodePrimaryFeature({ type: 'Point', coordinates: [0, 0] }, 0, 0, 0, 42);
  feature.properties = {
    name: '東京都', count: 12, enabled: true, missing: null,
    large: 9007199254740993n, date: new Date('2026-01-01T00:00:00Z'),
    nested: new Map([['items', [1, 2n]]]), binary: new Uint8Array([1, 2]),
    html: '<script>alert(1)</script>',
  };
  const tile = new VectorTile(new Pbf(new Uint8Array(encodeMvtTile([feature, { ...feature, id: 43 }]))));
  const layer = tile.layers.cogp;
  assert.equal(layer.length, 2);
  assert.equal(layer.feature(0).id, 42);
  assert.deepEqual(layer.feature(0).properties, {
    name: '東京都', count: '12', enabled: 'true', missing: '',
    large: '9007199254740993', date: '2026-01-01T00:00:00.000Z',
    nested: '{"items":[1,"2"]}', binary: '<bytes:2>', html: '<script>alert(1)</script>',
  });
  assert.deepEqual(layer.feature(1).properties, layer.feature(0).properties);
  assert.deepEqual(layer.feature(0).loadGeometry(), layer.feature(1).loadGeometry());
  assert.equal(layer._keys.length, Object.keys(feature.properties).length);
  assert.equal(layer._values.length, Object.keys(feature.properties).length);
});

test('overview latitude rejection preserves rounded buffer edges and either scale sign', () => {
  const z = 10, tileY = 403;
  const latitude = py => Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileY + py / 4096) / 2 ** z))) * 180 / Math.PI;
  const encode = createOverviewMvtEncoder(z, 909, tileY);
  for (const py of [-65, -64.4, -64, 0, 4096, 4160, 4160.4, 4161]) {
    for (const scale of [1, -1]) {
      const lat = latitude(py);
      const expected = encodePrimaryFeature({ type: 'Point', coordinates: [139.75, lat] }, z, 909, tileY, 7);
      const actual = encode({ type: 1, x: [139.75], y: [lat / scale], partEnds: [], polygonEnds: [], scale: [1, scale], offset: [0, 0] }, 7);
      assert.deepEqual(actual, expected, `py=${py}, scale=${scale}`);
    }
  }
});

test('overview latitude rejection retains crossing paths and clamped polar points', () => {
  const encode = createOverviewMvtEncoder(10, 512, 512);
  assert.ok(encode({ type: 2, x: [0.1, 0.1], y: [-20, 20], partEnds: [], polygonEnds: [], scale: [1, 1], offset: [0, 0] }, 1));
  const world = createOverviewMvtEncoder(0, 0, 0);
  for (const latitude of [-90, 90]) {
    assert.deepEqual(world({ type: 1, x: [0], y: [latitude], partEnds: [], polygonEnds: [], scale: [1, 1], offset: [0, 0] }, 1),
      encodePrimaryFeature({ type: 'Point', coordinates: [0, latitude] }, 0, 0, 0, 1));
  }
  assert.equal(encode({ type: 2, x: [], y: [], partEnds: [], polygonEnds: [], scale: [1, 1], offset: [0, 0] }, 1), null);
});

test('MVT nesting preserves grown buffers, UTF-8 attributes and exact output bounds', () => {
  const geometry = encodePrimaryFeature({ type: 'LineString', coordinates: Array.from({ length: 1000 }, (_, i) => [-5 + i / 100, i % 2]) }, 0, 0, 0, 1);
  assert.ok(geometry);
  // Geometry is retained between encoding and assembly; keep its storage compact.
  assert.equal(geometry.geometry.byteLength, geometry.geometry.buffer.byteLength);
  const before = geometry.geometry.slice();
  const features = Array.from({ length: 300 }, (_, i) => ({
    ...geometry, id: i + 1, properties: { name: `東京-${i}`, text: 'abc'.repeat(i + 100) },
  }));
  const data = encodeMvtTile(features);
  const snapshot = new Uint8Array(data).slice();
  const tile = new VectorTile(new Pbf(new Uint8Array(data)));
  assert.equal(tile.layers.cogp.length, features.length);
  for (let i = 0; i < features.length; i++) {
    assert.deepEqual(tile.layers.cogp.feature(i).properties, features[i].properties);
    assert.equal(tile.layers.cogp.feature(i).id, i + 1);
  }
  encodeMvtTile([{ ...geometry, properties: { other: 'different output' } }]);
  assert.deepEqual(new Uint8Array(data), snapshot);
  assert.deepEqual(geometry.geometry, before);
});

test('direct Feature framing handles varint boundaries and safe-integer IDs', () => {
  const geometry = encodePrimaryFeature({ type: 'Point', coordinates: [0, 0] }, 0, 0, 0);
  const ids = [0, 127, 128, 16383, 16384, 2 ** 32, Number.MAX_SAFE_INTEGER];
  const features = ids.map((id, i) => ({
    ...geometry, id,
    properties: Object.fromEntries(Array.from({ length: i * 32 }, (_, k) => [`key${k}`, 'x'.repeat(k + 100)])),
  }));
  const tile = new VectorTile(new Pbf(new Uint8Array(encodeMvtTile(features))));
  assert.equal(tile.layers.cogp.length, ids.length);
  for (let i = 0; i < ids.length; i++) {
    const feature = tile.layers.cogp.feature(i);
    assert.equal(feature.id, ids[i]);
    assert.deepEqual(feature.properties, features[i].properties);
    assert.equal(feature.loadGeometry()[0][0].x, 2048);
  }
  for (const id of [-1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => encodeMvtTile([{ ...geometry, id }]), /invalid protobuf varint/);
  }
});

test('MVT normalizes exterior and hole winding after projection for every polygon', () => {
  const outer = [[-30,-30],[30,-30],[30,30],[-30,30],[-30,-30]];
  const hole = [[-10,-10],[10,-10],[10,10],[-10,10],[-10,-10]];
  const second = [[50,-20],[70,-20],[70,20],[50,20],[50,-20]];
  for (const reverse of [false,true]) {
    const rings = [outer,hole,second].map(r => reverse ? [...r].reverse() : r);
    const feature = encodePrimaryFeature({type:'MultiPolygon',coordinates:[[rings[0],rings[1]],[rings[2]]]},0,0,0);
    const tile = new VectorTile(new Pbf(new Uint8Array(encodeMvtTile([feature]))));
    const result = Object.values(tile.layers)[0].feature(0).loadGeometry();
    const areas = result.map(r => r.reduce((sum,p,i) => {const q=r[(i+1)%r.length];return sum+p.x*q.y-q.x*p.y;},0));
    assert.equal(areas.length,3);
    assert.ok(areas[0]>0 && areas[1]<0 && areas[2]>0, String(areas));
  }
});

test('toMvt encodes WKB and quantized overview columns identically from columns', async () => {
  const { geometryColumnFromWkb, toMvt } = await import('../dist/index.js');
  const { decodeGeometry } = await import('../dist/geometry.js');
  const line = { type: 'LineString', coordinates: [[0, 0], [10, 0]] };
  const wkb = geometryColumnFromWkb([encodeWkb(line), null]);
  const overview = columnFromGeoJSON([line, null], { int32: true, scale: [0.5, 0.5], offset: [0, 0] });
  assert.deepEqual(decodeGeometry(wkb, 0), decodeGeometry(overview, 0));
  const decode = data => new VectorTile(new Pbf(new Uint8Array(data)));
  const source = geometry => ({ geometry, rowIndex: [3, 4], columns: { name: ['a', 'b'] } });
  const a = decode(toMvt(source(wkb), { z: 0, x: 0, y: 0 }));
  const b = decode(toMvt(source(overview), { z: 0, x: 0, y: 0 }));
  // Null geometries are skipped.
  assert.equal(a.layers.cogp.length, 1);
  assert.deepEqual(a.layers.cogp.feature(0).loadGeometry(), b.layers.cogp.feature(0).loadGeometry());
  assert.deepEqual(a.layers.cogp.feature(0).properties, { name: 'a' });
  assert.equal(a.layers.cogp.feature(0).id, 3);
  // Off-tile rows are skipped; IDs and layer names are optional.
  assert.equal(decode(toMvt({ geometry: overview }, { z: 10, x: 0, y: 0, layer: 'roads' })).layers.roads, undefined);
  const named = decode(toMvt({ geometry: overview }, { z: 0, x: 0, y: 0, layer: 'roads' }));
  assert.equal(named.layers.roads.length, 1);
  assert.equal(named.layers.roads.feature(0).id, undefined);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => toMvt({ geometry: overview }, { z: 0, x: 0, y: 0, signal: controller.signal }), { name: 'AbortError' });
});
