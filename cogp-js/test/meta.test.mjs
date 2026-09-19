import assert from 'node:assert/strict';
import test from 'node:test';
import { extractGeoMeta, parseCogpMeta } from '../dist/meta.js';
import { selectLevelByResolution } from '../dist/level.js';
const levels = [
  { row_group_end: 0, resolution: 1 },
  { row_group_end: 0, resolution: 0.1 },
  { row_group_end: 2, resolution: 0.01 },
];
test('nested metadata accepts repeated boundaries, CRS resolutions, and unknown fields', () => {
  const geo = { version: '1.1.0', primary_column: 'geom', columns: { geom: { encoding: 'WKB' } }, coarse_to_fine: { levels, future: true } };
  const doc = extractGeoMeta([{ key: 'geo', value: JSON.stringify(geo) }], 3);
  assert.deepEqual(doc.coarse_to_fine.levels, levels);
  assert.equal(doc.coarse_to_fine.future, true);
  assert.equal(selectLevelByResolution(levels, 2), 0);
  assert.equal(selectLevelByResolution(levels, 0.1), 1);
  assert.equal(selectLevelByResolution(levels, 0.001), 2);
});
test('invalid metadata cannot exclude rows', () => {
  for (const value of [null, {}, { levels: [] },
    { levels: [{ row_group_end: -1, resolution: 1 }] },
    { levels: [{ row_group_end: 0.5, resolution: 1 }] },
    { levels: [{ row_group_end: 3, resolution: 1 }] },
    { levels: [{ row_group_end: 1, resolution: 1 }] },
    { levels: [{ row_group_end: 2, resolution: 0 }] },
    { levels: [{ row_group_end: 2, resolution: '1' }] },
    { levels: [{ row_group_end: 2, resolution: 1 }, { row_group_end: 1, resolution: 0.1 }] },
    { levels: [{ row_group_end: 0, resolution: 1 }, { row_group_end: 2, resolution: 1 }] },
  ]) assert.throws(() => parseCogpMeta(JSON.stringify(value), 3));
  assert.throws(() => parseCogpMeta('{"levels":[{"row_group_end":2,"resolution":1e999}]}', 3));
  assert.throws(() => parseCogpMeta(JSON.stringify({ levels }), 0));
});
test('legacy metadata is not interpreted as the extension', () => {
  assert.throws(() => extractGeoMeta([
    { key: 'geo', value: '{"primary_column":"geom","columns":{}}' },
    { key: 'cogp', value: JSON.stringify({ version: '0.1.1', levels }) },
  ], 3), /coarse_to_fine/);
});
