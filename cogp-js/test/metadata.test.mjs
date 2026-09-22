import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { extractGeoMeta, lodForLevel, parseCogpMeta } from '../dist/meta.js';
import { selectLevelByResolution } from '../dist/level.js';

function document(overrides = {}) {
  return JSON.stringify({
    levels: [
      { row_group_end: 0, resolution: 1000 },
      { row_group_end: 2, resolution: 100 },
    ],
    overviews: {
      encoding: 'quantized_xy_v1',
      column: 'overviews',
      lods: {
        l0: { level_indices: [0], scale: [1, 1], offset: [0, 0] },
        l1: { level_indices: [1], scale: [0.125, 0.125], offset: [0, 0] },
      },
    },
    ...overrides,
  });
}

test('requires a complete and unique assignment of levels to overviews', () => {
  for (const indices of [undefined, null, [], '0', [-1], [2], [0.5], [0, 0], [1]]) {
    const parsed = JSON.parse(document());
    parsed.overviews.lods.l0.level_indices = indices;
    assert.throws(() => parseCogpMeta(JSON.stringify(parsed)), /level_indices|assigned/);
  }
  const missing = JSON.parse(document());
  delete missing.overviews.lods.l0;
  assert.throws(() => parseCogpMeta(JSON.stringify(missing)), /every level/);
});

test('level structure is unchanged by optional overviews', () => {
  const withOverviews = parseCogpMeta(document());
  const without = parseCogpMeta(document({ overviews: undefined }));
  assert.deepEqual(withOverviews.levels, without.levels);
  assert.deepEqual(Object.keys(withOverviews.levels[0]), ['row_group_end', 'resolution']);
  assert.equal(lodForLevel(without, 0), undefined);
});

test('explicit assignments are independent of dictionary and index order', () => {
  const metadata = structuredClone(specExample);
  metadata.overviews.lods = Object.fromEntries(Object.entries(metadata.overviews.lods).reverse());
  metadata.overviews.lods.l1.level_indices.reverse();
  const parsed = parseCogpMeta(JSON.stringify(metadata));
  assert.deepEqual(parsed.levels.map((_, i) => lodForLevel(parsed, i)), ['l0', 'l1', 'l1', 'l2']);
});

test('validates LoD transforms and ordered levels', () => {
  const invalidScale = JSON.parse(document());
  invalidScale.overviews.lods.l0.scale = [0, 1];
  assert.throws(() => parseCogpMeta(JSON.stringify(invalidScale)), /scale/);

  const invalidOrder = JSON.parse(document());
  invalidOrder.levels[1].resolution = 2000;
  assert.throws(() => parseCogpMeta(JSON.stringify(invalidOrder)), /strictly decrease/);
});

test('selects the level and required LoD for a target resolution', () => {
  const metadata = parseCogpMeta(document());
  assert.equal(selectLevelByResolution(metadata.levels, 500), 0);
  assert.equal(selectLevelByResolution(metadata.levels, 50), 1);
  assert.equal(lodForLevel(metadata, selectLevelByResolution(metadata.levels, 50)), 'l1');
});

test('Point-family metadata omits overviews and level LoDs', () => {
  const cogp = JSON.stringify({
    levels: [{ row_group_end: 0, resolution: 1000 }],
  });
  const geo = JSON.stringify({
    version: '1.1.0',
    primary_column: 'geometry',
    columns: { geometry: { encoding: 'WKB', geometry_types: ['Point', 'MultiPoint'] } },
  });
  const parsed = extractGeoMeta([
    { key: 'geo', value: JSON.stringify({...JSON.parse(geo), lod: JSON.parse(cogp)}) },
  ], 1);
  assert.equal(parsed.lod.overviews, undefined);
  assert.equal(parsed.lod.levels[0].lod, undefined);

  assert.throws(() => extractGeoMeta([
    { key: 'geo', value: JSON.stringify({...JSON.parse(geo), lod: JSON.parse(document())}) },
  ], 3), /must not declare overviews/);
});

test('Line and Polygon metadata may omit overviews and level LoDs', () => {
  const cogp = JSON.stringify({
    levels: [{ row_group_end: 0, resolution: 1000 }],
  });
  for (const geometryType of ['LineString', 'Polygon']) {
    const geo = JSON.stringify({
      version: '1.1.0',
      primary_column: 'geometry',
      columns: { geometry: { encoding: 'WKB', geometry_types: [geometryType] } },
    });
    const parsed = extractGeoMeta([
        { key: 'geo', value: JSON.stringify({...JSON.parse(geo), lod: JSON.parse(cogp)}) },
    ], 1);
    assert.equal(parsed.lod.overviews, undefined);
    assert.equal(parsed.lod.levels[0].lod, undefined);
  }
});

const specExample = JSON.parse(readFileSync(new URL('../../cogp-rs/tests/fixtures/metadata-overviews.json', import.meta.url), 'utf8'));

test('rendering extension selects a new LoD on the same prefix and shares LoDs across prefixes', () => {
  const metadata = parseCogpMeta(JSON.stringify(specExample));
  const selected = [1000, 500, 250, 100].map(resolution => {
    const index = selectLevelByResolution(metadata.levels, resolution);
    return [metadata.levels[index].row_group_end, lodForLevel(metadata, index)];
  });
  assert.deepEqual(selected, [[0, 'l0'], [0, 'l1'], [3, 'l1'], [3, 'l2']]);
});

test('layout has no independent version and ignores unrelated fields', () => {
  assert.equal(parseCogpMeta(document({ future: true })).future, true);
});

test('rejects decreasing boundaries, orphan LoDs, and reserved LoD names', () => {
  const decreasing = structuredClone(specExample);
  decreasing.levels[3].row_group_end = 2;
  assert.throws(() => parseCogpMeta(JSON.stringify(decreasing)), /non-decreasing/);
  const orphan = structuredClone(specExample);
  orphan.overviews.lods.unused = { level_indices: [], scale: [1, 1], offset: [0, 0] };
  assert.throws(() => parseCogpMeta(JSON.stringify(orphan)), /level_indices/);
  const reserved = structuredClone(specExample);
  reserved.overviews.lods.geometry_type = { scale: [1, 1], offset: [0, 0] };
  assert.throws(() => parseCogpMeta(JSON.stringify(reserved)), /invalid overview LoD name/);
});

test('quantized_geoarrow requires an explicit column and supported per-LoD geometry types', () => {
  const metadata = structuredClone(specExample);
  metadata.overviews.encoding = 'quantized_geoarrow';
  metadata.overviews.column = 'render_geometry';
  for (const lod of Object.values(metadata.overviews.lods)) lod.geometry_type = 'MultiPolygon';
  assert.equal(parseCogpMeta(JSON.stringify(metadata)).overviews.column, 'render_geometry');
  const missingColumn = structuredClone(metadata);
  delete missingColumn.overviews.column;
  assert.throws(() => parseCogpMeta(JSON.stringify(missingColumn)), /column/);
  const emptyColumn = structuredClone(metadata);
  emptyColumn.overviews.column = '';
  assert.throws(() => parseCogpMeta(JSON.stringify(emptyColumn)), /column/);
  const missingType = structuredClone(metadata);
  delete missingType.overviews.lods.l0.geometry_type;
  assert.throws(() => parseCogpMeta(JSON.stringify(missingType)), /geometry_type/);
  metadata.overviews.lods.l0.geometry_type = 'Point';
  assert.throws(() => parseCogpMeta(JSON.stringify(metadata)), /geometry_type/);
});

for (const encoding of ['quantized_xy_v1', 'quantized_geoarrow']) {
  test(`${encoding}: column is required and must be a nonempty string`, () => {
    for (const column of [undefined, null, '', 12]) {
      const metadata = structuredClone(specExample);
      metadata.overviews.encoding = encoding;
      metadata.overviews.column = column;
      assert.throws(() => parseCogpMeta(JSON.stringify(metadata)), /overviews.column/);
    }
  });
}
