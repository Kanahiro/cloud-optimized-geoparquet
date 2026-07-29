import assert from 'node:assert/strict';
import test from 'node:test';

import { parquetMetadataAsync } from 'hyparquet';
import { parquetWriteBuffer } from 'hyparquet-writer';

import { CogpReader, parseCogpMeta, selectLevelByResolution } from '../dist/index.js';

test('COGP 1 metadata and resolution selection', () => {
  const metadata = parseCogpMeta(
    JSON.stringify({
      version: '1.0.0',
      lods_column: 'geometry_lods',
      levels: [
        { row_group_end: 0, resolution: 1000 },
        { row_group_end: 1, resolution: 100 },
      ],
    }),
  );
  assert.equal(metadata.lods_column, 'geometry_lods');
  assert.equal(selectLevelByResolution(metadata.levels, 500), 0);
  assert.equal(selectLevelByResolution(metadata.levels, 50), 1);
  assert.throws(
    () => parseCogpMeta('{"version":"0.1.0","levels":[{"row_group_end":0,"gsd":1}]}'),
    /unsupported major version/,
  );
});

test('readRows fetches and decodes only the selected geometry LOD leaf', async () => {
  const file = makeCogp();
  const footerBuffer = trackedBuffer(file);
  const reader = await CogpReader.fromAsyncBuffer(footerBuffer, 'memory://lods');
  footerBuffer.ranges.length = 0;

  const coarseRows = await reader.readRows({ maxLevel: 1, columns: ['id', 'geometry'] });
  assert.deepEqual(coarseRows, [
    { id: 1, geometry: { type: 'Point', coordinates: [0.2, 0.2] } },
    { id: 2, geometry: { type: 'Point', coordinates: [10.2, 10.2] } },
  ]);

  const metadata = await parquetMetadataAsync(file);
  const chunks = metadata.row_groups[0].columns;
  const selected = chunkRange(chunks, 'geometry_lods.level_2');
  const excluded = [
    chunkRange(chunks, 'geometry'),
    chunkRange(chunks, 'geometry_lods.level_0'),
  ];
  assert.ok(footerBuffer.ranges.some((range) => contains(range, selected)));
  for (const range of excluded) {
    assert.ok(
      footerBuffer.ranges.every((requested) => !overlaps(requested, range)),
      `unexpected range fetch overlapping ${range.start}-${range.end}`,
    );
  }

  const fineRows = await reader.readRows({ maxLevel: 2, columns: ['id', 'geometry'] });
  assert.deepEqual(fineRows, [
    { id: 1, geometry: { type: 'Point', coordinates: [0.2, 0.2] } },
    { id: 2, geometry: { type: 'Point', coordinates: [10.2, 10.2] } },
    { id: 3, geometry: { type: 'Point', coordinates: [20.2, 20.2] } },
  ]);
});

test('readRows falls back to primary geometry when no equal or finer LOD exists', async () => {
  const file = makeCogp({ storedLodLevels: [0] });
  const tracked = trackedBuffer(file);
  const reader = await CogpReader.fromAsyncBuffer(tracked, 'memory://primary-fallback');
  tracked.ranges.length = 0;

  assert.deepEqual(await reader.readRows({ maxLevel: 1, columns: ['id', 'geometry'] }), [
    { id: 1, geometry: { type: 'Point', coordinates: [0, 0] } },
    { id: 2, geometry: { type: 'Point', coordinates: [10, 10] } },
  ]);

  const metadata = await parquetMetadataAsync(file);
  const chunks = metadata.row_groups[0].columns;
  const primary = chunkRange(chunks, 'geometry');
  const coarserLod = chunkRange(chunks, 'geometry_lods.level_0');
  assert.ok(tracked.ranges.some((range) => contains(range, primary)));
  assert.ok(tracked.ranges.every((range) => !overlaps(range, coarserLod)));
});

test('geometry LOD is skipped when primary geometry is not projected', async () => {
  const file = makeCogp();
  const tracked = trackedBuffer(file);
  const reader = await CogpReader.fromAsyncBuffer(tracked, 'memory://attributes');
  tracked.ranges.length = 0;

  assert.deepEqual(await reader.readRows({ maxLevel: 0, columns: ['id'] }), [{ id: 1 }]);

  const metadata = await parquetMetadataAsync(file);
  for (const path of ['geometry', 'geometry_lods.level_0', 'geometry_lods.level_2']) {
    const range = chunkRange(metadata.row_groups[0].columns, path);
    assert.ok(tracked.ranges.every((requested) => !overlaps(requested, range)));
  }
});

test('maxRowWkbBytes applies to selected LOD bytes before decode', async () => {
  const reader = await CogpReader.fromAsyncBuffer(makeCogp(), 'memory://wkb-limit');
  assert.deepEqual(
    await reader.readRows({
      maxLevel: 0,
      columns: ['id', 'geometry'],
      maxRowWkbBytes: 20,
    }),
    [],
  );
});

function makeCogp({ storedLodLevels = [0, 2] } = {}) {
  const geo = {
    version: '1.1.0',
    primary_column: 'geometry',
    columns: {
      geometry: {
        encoding: 'WKB',
        geometry_types: ['Point'],
        covering: {
          bbox: {
            xmin: ['bbox', 'xmin'],
            ymin: ['bbox', 'ymin'],
            xmax: ['bbox', 'xmax'],
            ymax: ['bbox', 'ymax'],
          },
        },
      },
    },
  };
  const cogp = {
    version: '1.0.0',
    lods_column: 'geometry_lods',
    levels: [
      { row_group_end: 0, resolution: 1000 },
      { row_group_end: 1, resolution: 100 },
      { row_group_end: 2, resolution: 10 },
    ],
  };
  const lodChildren = storedLodLevels.map((level) => ({
    name: `level_${level}`,
    type: 'BYTE_ARRAY',
    repetition_type: 'OPTIONAL',
  }));
  return parquetWriteBuffer({
    schema: [
      { name: 'root', num_children: 4 },
      { name: 'id', type: 'INT32', repetition_type: 'REQUIRED' },
      {
        name: 'geometry',
        type: 'BYTE_ARRAY',
        repetition_type: 'REQUIRED',
        logical_type: { type: 'GEOMETRY' },
      },
      { name: 'bbox', num_children: 4, repetition_type: 'REQUIRED' },
      { name: 'xmin', type: 'DOUBLE', repetition_type: 'REQUIRED' },
      { name: 'ymin', type: 'DOUBLE', repetition_type: 'REQUIRED' },
      { name: 'xmax', type: 'DOUBLE', repetition_type: 'REQUIRED' },
      { name: 'ymax', type: 'DOUBLE', repetition_type: 'REQUIRED' },
      {
        name: 'geometry_lods',
        num_children: lodChildren.length,
        repetition_type: 'REQUIRED',
      },
      ...lodChildren,
    ],
    columnData: [
      { name: 'id', data: [1, 2, 3] },
      {
        name: 'geometry',
        data: [
          { type: 'Point', coordinates: [0, 0] },
          { type: 'Point', coordinates: [10, 10] },
          { type: 'Point', coordinates: [20, 20] },
        ],
      },
      {
        name: 'bbox',
        data: [
          { xmin: 0, ymin: 0, xmax: 0, ymax: 0 },
          { xmin: 10, ymin: 10, xmax: 10, ymax: 10 },
          { xmin: 20, ymin: 20, xmax: 20, ymax: 20 },
        ],
      },
      {
        name: 'geometry_lods',
        data: [
          lodValues(storedLodLevels, 0, 0),
          lodValues(storedLodLevels, 1, 10),
          lodValues(storedLodLevels, 2, 20),
        ],
      },
    ],
    rowGroupSize: 1,
    kvMetadata: [
      { key: 'geo', value: JSON.stringify(geo) },
      { key: 'cogp', value: JSON.stringify(cogp) },
    ],
  });
}

function lodValues(storedLevels, introducedAt, coordinate) {
  return Object.fromEntries(
    storedLevels.map((level) => [
      `level_${level}`,
      level < introducedAt
        ? null
        : pointWkb(coordinate + (level === 0 ? 1 : 0.2), coordinate + (level === 0 ? 1 : 0.2)),
    ]),
  );
}

function pointWkb(x, y) {
  const bytes = new Uint8Array(21);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 1);
  view.setUint32(1, 1, true);
  view.setFloat64(5, x, true);
  view.setFloat64(13, y, true);
  return bytes;
}

function trackedBuffer(buffer) {
  const ranges = [];
  return {
    byteLength: buffer.byteLength,
    ranges,
    slice(start, end = buffer.byteLength) {
      ranges.push({ start, end });
      return buffer.slice(start, end);
    },
  };
}

function chunkRange(chunks, path) {
  const chunk = chunks.find((item) => item.meta_data?.path_in_schema.join('.') === path);
  assert.ok(chunk, `missing chunk ${path}`);
  const meta = chunk.meta_data;
  const start = Number(meta.dictionary_page_offset ?? meta.data_page_offset);
  return { start, end: start + Number(meta.total_compressed_size) };
}

function contains(outer, inner) {
  return outer.start <= inner.start && outer.end >= inner.end;
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}
