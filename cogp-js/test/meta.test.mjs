import assert from 'node:assert/strict';
import test from 'node:test';
import { extractGeoMeta, parseLodMeta } from '../dist/meta.js';
import { selectLevelByResolution } from '../dist/level.js';
const levels = [
  { row_group_end: 0, resolution: 1 },
  { row_group_end: 0, resolution: 0.1 },
  { row_group_end: 2, resolution: 0.01 },
];
test('nested metadata accepts repeated boundaries, CRS resolutions, and unknown fields', () => {
  const geo = { version: '1.1.0', primary_column: 'geom', columns: { geom: { encoding: 'WKB' } }, lod: { levels, future: true } };
  const doc = extractGeoMeta([{ key: 'geo', value: JSON.stringify(geo) }], 3);
  assert.deepEqual(doc.lod.levels, levels);
  assert.equal(doc.lod.future, true);
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
  ]) assert.throws(() => parseLodMeta(JSON.stringify(value), 3));
  assert.throws(() => parseLodMeta('{"levels":[{"row_group_end":2,"resolution":1e999}]}', 3));
  assert.throws(() => parseLodMeta(JSON.stringify({ levels }), 0));
});
test('geo.lod is required and supplies the levels', () => {
  const geo = { version: '1.1.0', primary_column: 'geom', columns: {} };
  const extract = () => extractGeoMeta([{ key: 'geo', value: JSON.stringify(geo) }], 3);
  assert.throws(extract, /missing geo.lod metadata/);
  geo.lod = { levels: [] };
  assert.throws(extract, /levels must be a non-empty array/);
  // A missing primary entry in `geo.columns` is tolerated; it only disables bbox pruning.
  geo.lod = { levels };
  assert.deepEqual(extract().lod.levels, levels);
});

test('unknown overview encoding keeps common boundaries and opaque fields', () => {
  const overviews = {column:'future',encoding:'future_v3',lods:{all:{level_indices:[0,1,2],scale:{format:'future'},geometry_type:42}}};
  const parsed = parseLodMeta(JSON.stringify({levels,overviews}),3);
  assert.deepEqual(parsed.overviews, overviews);
  overviews.lods.all.level_indices = [0,1];
  assert.throws(() => parseLodMeta(JSON.stringify({levels,overviews}),3), /every level/);
});
