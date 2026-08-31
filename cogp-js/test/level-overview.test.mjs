import assert from 'node:assert/strict';
import test from 'node:test';

import { selectLevelByResolution } from '../dist/level.js';
import { geometryFamily, parseCogpMeta } from '../dist/meta.js';

const levels = [
  { row_group_end: 0, resolution_meters: 4000, geometry_column: 'geometry_ovr_0' },
  { row_group_end: 2, resolution_meters: 2000, geometry_column: 'geometry_ovr_1' },
  { row_group_end: 5, resolution_meters: 1000, geometry_column: 'geometry_ovr_2' },
  { row_group_end: 9, resolution_meters: 500, geometry_column: 'geometry_ovr_3' },
];

test('selects the finest level appropriate for the target resolution', () => {
  assert.equal(selectLevelByResolution(levels, 5000), 0);
  assert.equal(selectLevelByResolution(levels, 2500), 0);
  assert.equal(selectLevelByResolution(levels, 1500), 1);
  assert.equal(selectLevelByResolution(levels, 500), 3);
  assert.equal(selectLevelByResolution(levels, 25), 3);
});

test('validates self-contained level entries', () => {
  const parsed = parseCogpMeta(JSON.stringify({ version: '0.2.0', levels }));
  assert.equal(parsed.levels[2].geometry_column, 'geometry_ovr_2');

  assert.throws(() => parseCogpMeta(JSON.stringify({
    version: '0.2.0',
    levels: [levels[0], { ...levels[1], resolution_meters: 4000 }],
  })), /strictly decreasing/);

  assert.throws(() => parseCogpMeta(JSON.stringify({
    version: '0.2.0',
    levels: [{ ...levels[0], geometry_column: '' }],
  })), /non-empty string/);

  assert.throws(() => parseCogpMeta(JSON.stringify({
    version: '0.2.0',
    levels: [levels[1], levels[0]],
  })), /strictly increasing/);
});

test('accepts singular and multi variants but rejects mixed geometry families', () => {
  assert.equal(geometryFamily(['LineString', 'MultiLineString Z']), 'line');
  assert.equal(geometryFamily(['Polygon', 'MultiPolygon']), 'polygon');
  assert.equal(geometryFamily(['LineString', 'Polygon']), undefined);
  assert.equal(geometryFamily([]), undefined);
});
