import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeOverview, parseOverview, projectOverviewMetadata } from '../dist/overview.js';

test('decodes quantized multipolygon coordinates and topology', () => {
  const geometry = decodeOverview(
    {
      geometry_type: 6,
      l1: {
        x: [0, 2, 2, 0, 0],
        y: [0, 0, 2, 2, 0],
        part_ends: [5],
        polygon_ends: [1],
      },
    },
    { scale: [0.5, 0.5], offset: [10, 20] },
  );
  assert.deepEqual(geometry, {
    type: 'MultiPolygon',
    coordinates: [[[
      [10, 20],
      [11, 20],
      [11, 21],
      [10, 21],
      [10, 20],
    ]]],
  });
});

test('decodes typed overview arrays without changing topology', () => {
  const geometry = decodeOverview(
    {
      geometry_type: 5,
      l1: {
        x: new Int32Array([0, 2, 4]),
        y: new Int32Array([1, 3, 5]),
        part_ends: new Int32Array([2, 3]),
        polygon_ends: new Int32Array(0),
      },
    },
    { scale: [0.5, 2], offset: [10, 20] },
  );
  assert.deepEqual(geometry, {
    type: 'MultiLineString',
    coordinates: [
      [[10, 22], [11, 26]],
      [[12, 30]],
    ],
  });
});

test('exposes a zero-copy quantized overview view for custom renderers', () => {
  const x = new Int32Array([1, 2]);
  const y = new Int32Array([3, 4]);
  const partEnds = new Int32Array([2]);
  const polygonEnds = new Int32Array(0);
  const overview = parseOverview(
    {
      geometry_type: 5,
      l1: { x, y, part_ends: partEnds, polygon_ends: polygonEnds },
    },
    { scale: [0.5, 2], offset: [10, 20] },
  );
  assert.equal(overview.x, x);
  assert.equal(overview.y, y);
  assert.equal(overview.partEnds, partEnds);
  assert.equal(overview.polygonEnds, polygonEnds);
  assert.deepEqual(overview.scale, [0.5, 2]);
  assert.deepEqual(overview.offset, [10, 20]);
});

test('metadata projection removes sibling LoDs from range planning', () => {
  const metadata = {
    schema: [
      { name: 'schema', num_children: 3 },
      { name: 'geometry' },
      { name: 'overviews', num_children: 3 },
      { name: 'geometry_type' },
      { name: 'l0', num_children: 1 },
      { name: 'x' },
      { name: 'l1', num_children: 1 },
      { name: 'x' },
      { name: 'bbox' },
    ],
    row_groups: [{
      columns: [
        { meta_data: { path_in_schema: ['geometry'] } },
        { meta_data: { path_in_schema: ['overviews', 'geometry_type'] } },
        { meta_data: { path_in_schema: ['overviews', 'l0', 'x'] } },
        { meta_data: { path_in_schema: ['overviews', 'l1', 'x'] } },
        { meta_data: { path_in_schema: ['bbox'] } },
      ],
    }],
  };
  const projected = projectOverviewMetadata(metadata, 'l1');
  const paths = projected.row_groups[0].columns.map((column) => column.meta_data.path_in_schema);
  assert.deepEqual(paths, [
    ['geometry'],
    ['overviews', 'geometry_type'],
    ['overviews', 'l1', 'x'],
    ['bbox'],
  ]);
});
