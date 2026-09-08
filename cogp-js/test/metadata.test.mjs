import assert from 'node:assert/strict';
import test from 'node:test';

import { extractCogpDocument, parseCogpMeta, selectLevelByResolution } from '../dist/index.js';

function document(overrides = {}) {
  return JSON.stringify({
    version: '0.2.0',
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
    version: '0.2.0',
    levels: [{ row_group_end: 0, resolution: 1000 }],
  });
  const geo = JSON.stringify({
    version: '1.1.0',
    primary_column: 'geometry',
    columns: { geometry: { encoding: 'WKB', geometry_types: ['Point', 'MultiPoint'] } },
  });
  const parsed = extractCogpDocument([
    { key: 'cogp', value: cogp },
    { key: 'geo', value: geo },
  ]);
  assert.equal(parsed.cogp.overviews, undefined);
  assert.equal(parsed.cogp.levels[0].lod, undefined);

  const strayLod = JSON.parse(cogp);
  strayLod.levels[0].lod = 'l0';
  assert.throws(() => parseCogpMeta(JSON.stringify(strayLod)), /requires overviews/);

  assert.throws(() => extractCogpDocument([
    { key: 'cogp', value: document() },
    { key: 'geo', value: geo },
  ]), /must not declare overviews/);
});
