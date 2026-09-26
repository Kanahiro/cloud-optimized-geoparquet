import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { extractGeoMeta, lodForLevel, parseLodMeta } from '../dist/meta.js';
import { selectLevelByResolution } from '../dist/level.js';

function document(overrides = {}) {
  return JSON.stringify({
    levels: [
      { row_group_end: 0, resolution: 1000 },
      { row_group_end: 2, resolution: 100 },
    ],
    overviews: {
      encoding: 'quantized_geoarrow',
      column: 'overviews',
      lods: {
        l0: { level_indices: [0], geometry_type: 'LineString', scale: [1, 1], offset: [0, 0] },
        l1: { level_indices: [1], geometry_type: 'LineString', scale: [0.125, 0.125], offset: [0, 0] },
      },
    },
    ...overrides,
  });
}

test('requires a complete and unique assignment of levels to overviews', () => {
  for (const indices of [undefined, null, [], '0', [-1], [2], [0.5], [0, 0], [1]]) {
    const parsed = JSON.parse(document());
    parsed.overviews.lods.l0.level_indices = indices;
    assert.throws(() => parseLodMeta(JSON.stringify(parsed)), /level_indices|assigned/);
  }
  const missing = JSON.parse(document());
  delete missing.overviews.lods.l0;
  assert.throws(() => parseLodMeta(JSON.stringify(missing)), /every level/);
});

test('level structure is unchanged by optional overviews', () => {
  const withOverviews = parseLodMeta(document());
  const without = parseLodMeta(document({ overviews: undefined }));
  assert.deepEqual(withOverviews.levels, without.levels);
  assert.deepEqual(Object.keys(withOverviews.levels[0]), ['row_group_end', 'resolution']);
  assert.equal(lodForLevel(without, 0), undefined);
});

test('explicit assignments are independent of dictionary and index order', () => {
  const metadata = structuredClone(specExample);
  metadata.overviews.lods = Object.fromEntries(Object.entries(metadata.overviews.lods).reverse());
  metadata.overviews.lods.l1.level_indices.reverse();
  const parsed = parseLodMeta(JSON.stringify(metadata));
  assert.deepEqual(parsed.levels.map((_, i) => lodForLevel(parsed, i)), ['l0', 'l1', 'l1', 'l2']);
});

test('validates LoD transforms and ordered levels', () => {
  const invalidScale = JSON.parse(document());
  invalidScale.overviews.lods.l0.scale = [0, 1];
  assert.throws(() => parseLodMeta(JSON.stringify(invalidScale)), /scale/);

  const invalidOrder = JSON.parse(document());
  invalidOrder.levels[1].resolution = 2000;
  assert.throws(() => parseLodMeta(JSON.stringify(invalidOrder)), /strictly decrease/);
});

test('selects the level and required LoD for a target resolution', () => {
  const metadata = parseLodMeta(document());
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

const specExample = JSON.parse(readFileSync(new URL('../../../../cogp-rs/tests/fixtures/metadata-overviews.json', import.meta.url), 'utf8'));

test('rendering extension selects a new LoD on the same prefix and shares LoDs across prefixes', () => {
  const metadata = parseLodMeta(JSON.stringify(specExample));
  const selected = [1000, 500, 250, 100].map(resolution => {
    const index = selectLevelByResolution(metadata.levels, resolution);
    return [metadata.levels[index].row_group_end, lodForLevel(metadata, index)];
  });
  assert.deepEqual(selected, [[0, 'l0'], [0, 'l1'], [3, 'l1'], [3, 'l2']]);
});

test('layout has no independent version and ignores unrelated fields', () => {
  assert.equal(parseLodMeta(document({ future: true })).future, true);
});

test('rejects decreasing boundaries and orphan LoDs', () => {
  const decreasing = structuredClone(specExample);
  decreasing.levels[3].row_group_end = 2;
  assert.throws(() => parseLodMeta(JSON.stringify(decreasing)), /non-decreasing/);
  const orphan = structuredClone(specExample);
  orphan.overviews.lods.unused = { level_indices: [], geometry_type: 'MultiLineString', scale: [1, 1], offset: [0, 0] };
  assert.throws(() => parseLodMeta(JSON.stringify(orphan)), /level_indices/);
});

test('quantized_geoarrow requires an explicit column and supported per-LoD geometry types', () => {
  const metadata = structuredClone(specExample);
  metadata.overviews.column = 'render_geometry';
  for (const lod of Object.values(metadata.overviews.lods)) lod.geometry_type = 'MultiPolygon';
  assert.equal(parseLodMeta(JSON.stringify(metadata)).overviews.column, 'render_geometry');
  const missingColumn = structuredClone(metadata);
  delete missingColumn.overviews.column;
  assert.throws(() => parseLodMeta(JSON.stringify(missingColumn)), /column/);
  const emptyColumn = structuredClone(metadata);
  emptyColumn.overviews.column = '';
  assert.throws(() => parseLodMeta(JSON.stringify(emptyColumn)), /column/);
  const missingType = structuredClone(metadata);
  delete missingType.overviews.lods.l0.geometry_type;
  assert.throws(() => parseLodMeta(JSON.stringify(missingType)), /geometry_type/);
  metadata.overviews.lods.l0.geometry_type = 'Point';
  assert.throws(() => parseLodMeta(JSON.stringify(metadata)), /geometry_type/);
});

test('column is required and must be a nonempty string', () => {
  for (const column of [undefined, null, '', 12]) {
    const metadata = structuredClone(specExample);
    metadata.overviews.column = column;
    assert.throws(() => parseLodMeta(JSON.stringify(metadata)), /overviews.column/);
  }
});

test('overviews may be omitted but not null', () => {
  assert.throws(() => parseLodMeta(document({ overviews: null })), /overviews/);
});
