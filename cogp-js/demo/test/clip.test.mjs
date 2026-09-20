import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

// Decode with the same dependencies used by the demo renderer.
const rendererRequire = createRequire(import.meta.resolve('maplibre-gl'));
const { VectorTile } = rendererRequire('@mapbox/vector-tile');
const Pbf = rendererRequire('pbf');

import { clipLineString, clipPolygonRing, pointInBbox } from '../dist/clip-test/clip.js';
import {
  createOverviewMvtEncoder,
  encodeMvtTile,
  encodePrimaryFeature,
} from '../dist/clip-test/mvt.js';

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
