import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { extractGeoMeta, parseCogpMeta } from '../dist/meta.js';
import { selectLevelByResolution } from '../dist/level.js';

function document(overrides = {}) {
  return JSON.stringify({
    levels: [
      { row_group_end: 0, resolution: 1000, lod: 'l0' },
      { row_group_end: 2, resolution: 100, lod: 'l1' },
    ],
    overviews: {
      encoding: 'quantized_xy_v1',
      lods: {
        l0: { scale: [1, 1], offset: [0, 0] },
        l1: { scale: [0.125, 0.125], offset: [0, 0] },
      },
    },
    ...overrides,
  });
}

test('requires an explicit valid LoD on every level', () => {
  const parsed = JSON.parse(document());
  delete parsed.levels[0].lod;
  parsed.default_lod = 'l0';
  assert.throws(() => parseCogpMeta(JSON.stringify(parsed)), /levels\[0\]\.lod/);

  parsed.levels[0].lod = 'missing';
  assert.throws(() => parseCogpMeta(JSON.stringify(parsed)), /does not name/);
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
  assert.equal(metadata.levels[selectLevelByResolution(metadata.levels, 50)].lod, 'l1');
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

  const strayLod = JSON.parse(cogp);
  strayLod.levels[0].lod = 'l0';
  assert.throws(() => parseCogpMeta(JSON.stringify(strayLod)), /requires overviews/);

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
    const level = metadata.levels[selectLevelByResolution(metadata.levels, resolution)];
    return [level.row_group_end, level.lod];
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
  orphan.overviews.lods.unused = { scale: [1, 1], offset: [0, 0] };
  assert.throws(() => parseCogpMeta(JSON.stringify(orphan)), /not referenced/);
  const reserved = structuredClone(specExample);
  reserved.overviews.lods.geometry_type = { scale: [1, 1], offset: [0, 0] };
  assert.throws(() => parseCogpMeta(JSON.stringify(reserved)), /invalid overview LoD name/);
});
