import assert from 'node:assert/strict';
import test from 'node:test';

import { selectGeometryColumnByGsd } from '../dist/level.js';
import { geometryFamily, parseCogpMeta } from '../dist/meta.js';

const levels = [
  { row_group_end: 0, gsd: 4000 },
  { row_group_end: 2, gsd: 2000 },
  { row_group_end: 5, gsd: 1000 },
  { row_group_end: 9, gsd: 500 },
];
const overviews = [
  { column: 'geometry_ovr_0', level: 0, tolerance_meters: 3000 },
  { column: 'geometry_ovr_1', level: 2, tolerance_meters: 1000 },
  { column: 'geometry_ovr_2', level: 3, tolerance_meters: 50 },
];

test('selects one sufficiently fine column that covers the row prefix', () => {
  assert.equal(
    selectGeometryColumnByGsd(overviews, 5000, 0, 'geometry'),
    'geometry_ovr_0',
  );
  assert.equal(
    selectGeometryColumnByGsd(overviews, 1500, 1, 'geometry'),
    'geometry_ovr_1',
  );
  assert.equal(
    selectGeometryColumnByGsd(overviews, 750, 2, 'geometry'),
    'geometry_ovr_2',
  );
  assert.equal(
    selectGeometryColumnByGsd(overviews, 25, 3, 'geometry'),
    'geometry',
  );
  assert.equal(
    selectGeometryColumnByGsd(overviews, 25, 3, 'geometry', true),
    'geometry_ovr_2',
  );
  assert.throws(
    () => selectGeometryColumnByGsd(overviews.slice(0, 2), 25, 3, 'geometry', true),
    /requires a geometry overview complete through level 3/,
  );
});

test('uses raw WKB for extended geometry when no overview exists', () => {
  assert.equal(
    selectGeometryColumnByGsd([], 25, 3, 'geometry', true),
    'geometry',
  );
});

test('validates overview names and strictly increasing level links', () => {
  const parsed = parseCogpMeta(JSON.stringify({
    version: '0.2.0',
    levels,
    geometry_overviews: overviews,
  }));
  assert.equal(parsed.geometry_overviews.length, 3);

  assert.throws(() => parseCogpMeta(JSON.stringify({
    version: '0.2.0',
    levels,
    geometry_overviews: [overviews[1], overviews[0]],
  })), /strictly increasing/);

  assert.throws(() => parseCogpMeta(JSON.stringify({
    version: '0.2.0',
    levels,
    geometry_overviews: [
      overviews[0],
      { ...overviews[1], tolerance_meters: 3000 },
    ],
  })), /strictly decreasing/);

  assert.throws(() => parseCogpMeta(JSON.stringify({
    version: '0.2.0',
    levels,
    geometry_overviews: overviews.slice(0, 2),
  })), /must cover the final level/);
});

test('accepts singular and multi variants but rejects mixed geometry families', () => {
  assert.equal(geometryFamily(['LineString', 'MultiLineString Z']), 'line');
  assert.equal(geometryFamily(['Polygon', 'MultiPolygon']), 'polygon');
  assert.equal(geometryFamily(['LineString', 'Polygon']), undefined);
  assert.equal(geometryFamily([]), undefined);
});
