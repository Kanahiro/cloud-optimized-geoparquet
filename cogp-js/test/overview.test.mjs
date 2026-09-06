import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeOverview, projectOverviewMetadata } from '../dist/overview.js';

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
