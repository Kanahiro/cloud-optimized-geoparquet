import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { lodForLevel } from '../dist/meta.js';
import { CogpReader } from '../dist/index.js';
import { decodeGeometry } from '../dist/geometry.js';
import { readRecord, readRecords } from './helpers.mjs';

async function openFixture(name) {
  const bytes = await readFile(new URL(`../../test-data/${name}.parquet`, import.meta.url));
  const requests = [];
  const file = {
    byteLength: bytes.length,
    slice(start, end = bytes.length) {
      requests.push([start, end]);
      return bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end);
    },
  };
  const reader = await CogpReader.fromAsyncBuffer(file, `fixture:${name}`);
  requests.length = 0;
  return { reader, requests };
}

for (const name of ['refinement', 'shared', 'distinct-boundaries', 'renamed-overview']) {
  test(`${name}: primary bbox selects features independently of the overview`, async () => {
    const { reader, requests } = await openFixture(name);
    const columns = ['id', 'geometry'];
    const primaryOnly = [10, 0.3, 20, 0.5];
    const overviewOnly = [10, -0.1, 20, 0.1];
    const coarse = await readRecords(reader, { useOverview: true, maxLevel: 0, columns, bbox: primaryOnly });
    assert.deepEqual(coarse.map(row => row.id), [0]);
    // The producer writes Multi types, so a LineString overview is a one-part MultiLineString.
    assert.deepEqual(coarse[0].geometry, { type: 'MultiLineString', coordinates: [[[0, 0], [104, 0]]] });
    assert.deepEqual(await readRecords(reader, { useOverview: true, maxLevel: 0, columns, bbox: overviewOnly }), []);
    for (let maxLevel = 0; maxLevel < reader.levels.length; maxLevel++) {
      const rows = await readRecords(reader, { useOverview: true, columns, bbox: primaryOnly, maxLevel });
      assert.deepEqual(rows.map(row => row.id), [0]);
      const all = await readRecords(reader, { useOverview: true, columns, maxLevel });
      assert.deepEqual(all.map(row => row.id), reader.levels[maxLevel].row_group_end === 0 ? [0] : [0, 1]);
    }
    // Reading only ID plus the rendering geometry never fetches primary WKB.
    for (const group of reader.metadata.row_groups) {
      const column = group.columns.find(column => column.meta_data.path_in_schema[0] === 'geometry').meta_data;
      const start = Number(column.dictionary_page_offset ?? column.data_page_offset);
      const end = start + Number(column.total_compressed_size);
      assert.ok(requests.every(([a, b]) => b <= start || a >= end), 'unexpected WKB data read');
    }
  });
}

test('useOverview selects the overview or lossless WKB through the same readRows call', async () => {
  const { reader, requests } = await openFixture('refinement');
  assert.equal(reader.hasOverviews, true);
  const columns = ['id', 'geometry'];
  const overview = await reader.read({ useOverview: true, maxLevel: 0, columns });
  assert.ok(overview.geometry.x instanceof Int32Array);
  assert.notDeepEqual(overview.geometry.scale, [1, 1]);
  requests.length = 0;
  const raw = await reader.read({ maxLevel: 0, columns });
  assert.deepEqual([...raw.columns.id], [...overview.columns.id]);
  assert.deepEqual([...raw.rowIndex], [...overview.rowIndex]);
  // One geometry type for both sources: only coordinate storage and transform differ.
  assert.deepEqual(Object.keys(raw.geometry).sort(), Object.keys(overview.geometry).sort());
  assert.ok(raw.geometry.x instanceof Float64Array);
  assert.deepEqual([raw.geometry.scale, raw.geometry.offset], [[1, 1], [0, 0]]);
  assert.deepEqual(decodeGeometry(raw.geometry, 0), decodeGeometry((await reader.readRow(0, { columns: ['geometry'] })).geometry, 0));
  assert.equal(decodeGeometry(raw.geometry, 0).type, 'LineString');
  assert.equal(decodeGeometry(overview.geometry, 0).type, 'MultiLineString');
  // Raw reads fetch primary WKB and skip every overview leaf.
  const column = name => reader.metadata.row_groups[0].columns
    .map(c => c.meta_data).filter(c => c.path_in_schema[0] === name)
    .map(c => { const start = Number(c.dictionary_page_offset ?? c.data_page_offset); return [start, start + Number(c.total_compressed_size)]; });
  const touches = ranges => requests.some(([a, b]) => ranges.some(([s, e]) => a < e && s < b));
  assert.ok(touches(column('geometry')));
  assert.ok(!touches(column(reader.geo.lod.overviews.column)));
});

test('useOverview falls back to primary WKB without declared overviews', async () => {
  const { reader } = await openFixture('base-covering');
  assert.equal(reader.hasOverviews, false);
  const columns = ['id', 'geometry'];
  assert.deepEqual(await readRecords(reader, { useOverview: true, columns }), await readRecords(reader, { columns }));
});

test('same-prefix LoD switches update geometry and can switch back', async () => {
  const { reader } = await openFixture('refinement');
  const columns = ['id', 'geometry'];
  assert.deepEqual(reader.levels.map(level => level.row_group_end), [0, 1, 1]);
  const medium = await readRecords(reader, { useOverview: true, maxLevel: 1, columns });
  const fine = await readRecords(reader, { useOverview: true, maxLevel: 2, columns });
  assert.deepEqual(medium.map(row => row.id), fine.map(row => row.id));
  assert.notDeepEqual(medium[0].geometry, fine[0].geometry);
  assert.deepEqual(await readRecords(reader, { useOverview: true, maxLevel: 1, columns }), medium);
});

test('shared LoD remains readable beyond its first referenced prefix', async () => {
  const { reader } = await openFixture('shared');
  const columns = ['id', 'geometry'];
  assert.deepEqual(reader.levels.map((level, index) => [level.row_group_end, lodForLevel(reader.geo.lod, index)]),
    [[0, 'l0'], [0, 'l1'], [1, 'l1'], [1, 'l2']]);
  const first = await readRecords(reader, { useOverview: true, maxLevel: 1, columns });
  const extended = await readRecords(reader, { useOverview: true, maxLevel: 2, columns });
  assert.equal(first.length, 1);
  assert.equal(extended.length, 2);
  assert.deepEqual(first[0], extended[0]);
});

test('read returns aligned columns with source row indexes', async () => {
  const { reader } = await openFixture('refinement');
  const batch = await reader.read({ columns: ['id', 'geometry'], maxLevel: 2 });
  assert.equal(batch.length, 2);
  assert.deepEqual([...batch.rowIndex], [0, 1]);
  assert.deepEqual(Object.keys(batch.columns), ['id']);
  assert.equal(batch.columns.id.length, 2);
  assert.equal(batch.geometry.length, 2);
  assert.equal(batch.geometry.geometryOffsets.length, 3);
});

test('readRow projects one source row without requiring geometry', async () => {
  const { reader } = await openFixture('refinement');
  assert.ok(reader.columnNames.includes('id'));
  assert.deepEqual(await readRecord(reader, 1, { columns: ['id'] }), { id: 1 });
  await assert.rejects(() => readRecord(reader, -1), /rowIndex/);
  await assert.rejects(() => readRecord(reader, 2), /rowIndex/);
});

test('separate covering roots select rows without statistics and keep missing bounds', async () => {
  const { reader } = await openFixture('base-covering');
  assert.equal(reader.rowGroupEnvelope(0), null);
  const rows = await readRecords(reader, { columns: ['id', 'overviews'], bbox: [-1, -1, 1, 1] });
  assert.deepEqual(rows, [{ id: 0, overviews: 'ordinary' }, { id: 2, overviews: 'null geometry' }]);
});

test('base layout without covering conservatively retains candidates', async () => {
  const { reader } = await openFixture('base-no-covering');
  const rows = await readRecords(reader, { columns: ['id', 'overviews'], bbox: [-1, -1, 1, 1] });
  assert.deepEqual(rows, [{ id: 0, overviews: 'ordinary' }, { id: 1, overviews: 'attribute' }, { id: 2, overviews: 'null geometry' }]);
});

test('base layout preserves null primary geometries in unfiltered reads', async () => {
  const { reader } = await openFixture('base-covering');
  const rows = await readRecords(reader, { columns: ['id', 'geometry'] });
  assert.equal(rows.length, 3);
  assert.equal(rows[2].id, 2);
  assert.equal(rows[2].geometry, null);
});

test('explicit undefined attribute values are distinct from unread row slots', async () => {
  const { reader } = await openFixture('base-no-covering');
  // Hyparquet can emit undefined for empty nested attributes. A hole instead
  // means the requested row was never delivered by the decoder.
  reader.readColumnChunks = async () => new Map([['overviews', [{ rowStart: 0, columnData: [undefined, 'value', null] }]]]);
  assert.deepEqual(await readRecord(reader, 0, { columns: ['overviews'] }), { overviews: undefined });
  assert.deepEqual(await readRecords(reader, { columns: ['overviews'] }), [
    { overviews: undefined }, { overviews: 'value' }, { overviews: null },
  ]);
  // Use a fresh reader so previously decoded values cannot mask missing rows.
  const { reader: missingReader } = await openFixture('base-no-covering');
  missingReader.readColumnChunks = async () => new Map([['overviews', []]]);
  await assert.rejects(readRecord(missingReader, 0, { columns: ['overviews'] }), /missing row/);
  await assert.rejects(readRecords(missingReader, { columns: ['overviews'] }), /missing row/);
});

test('plain attribute encoding preserves scalars, binary and nested values', async () => {
  const { reader } = await openFixture('attribute-encodings');
  const columns = ['id', 'name', 'long', 'float', 'flag', 'binary', 'fixed', 'nested', 'values'];
  const rows = await readRecords(reader, { columns });
  assert.equal(rows.length, 40);
  assert.equal(new Set(rows.map(row => row.id)).size, 40);
  for (const row of rows) {
    const id = row.id, nullable = id % 3 === 0;
    assert.equal(row.name, `feature-${id}`);
    assert.equal(row.long, id % 3 === 0 ? -(1n << 63n) : id % 3 === 1 ? (1n << 63n) - 1n : null);
    assert.equal(row.float, nullable ? null : id * 0.5);
    assert.equal(row.flag, nullable ? null : id % 2 === 0);
    assert.deepEqual(row.binary, nullable ? null : Uint8Array.of(0, id, 255));
    assert.deepEqual(row.fixed, new Uint8Array(16).fill(id));
    assert.deepEqual(row.nested, { score: nullable ? null : id * 0.25, label: nullable ? null : `名前-${id}` });
    assert.deepEqual(row.values ?? null, nullable ? null : [id + 0.5, null, -0]);
  }
  const first = await readRecord(reader, 0, { columns });
  assert.deepEqual(first, rows[0]);
});
