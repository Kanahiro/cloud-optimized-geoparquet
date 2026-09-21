import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { COGP_ROW_INDEX, CogpReader } from '../dist/index.js';

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

for (const name of ['refinement', 'refinement-delta', 'shared', 'legacy']) {
  test(`${name}: primary bbox selects features independently of the overview`, async () => {
    const { reader, requests } = await openFixture(name);
    const columns = ['id', 'geometry'];
    const primaryOnly = [10, 0.3, 20, 0.5];
    const overviewOnly = [10, -0.1, 20, 0.1];
    const coarse = await reader.readRows({ maxLevel: 0, columns, bbox: primaryOnly });
    assert.deepEqual(coarse.map(row => row.id), [0]);
    assert.deepEqual(coarse[0].geometry.coordinates, [[0, 0], [104, 0]]);
    assert.deepEqual(await reader.readRows({ maxLevel: 0, columns, bbox: overviewOnly }), []);
    for (let maxLevel = 0; maxLevel < reader.levels.length; maxLevel++) {
      const rows = await reader.readRows({ columns, bbox: primaryOnly, maxLevel });
      assert.deepEqual(rows.map(row => row.id), [0]);
      const all = await reader.readRows({ columns, maxLevel });
      assert.deepEqual(all.map(row => row.id), reader.levels[maxLevel].row_group_end === 0 ? [0] : [0, 1]);
    }
    const covering = new Set(Object.values(reader.geo.columns.geometry.covering.bbox).map(path => path.join('.')));
    for (const group of reader.metadata.row_groups) {
      for (const { meta_data: column } of group.columns) {
        if (!covering.has(column.path_in_schema.join('.'))) continue;
        const start = Number(column.dictionary_page_offset ?? column.data_page_offset);
        const end = start + Number(column.total_compressed_size);
        assert.ok(requests.every(([a, b]) => b <= start || a >= end), 'unexpected covering data read');
      }
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

test('same-prefix LoD switches update geometry and can switch back', async () => {
  const { reader } = await openFixture('refinement');
  const columns = ['id', 'geometry'];
  assert.deepEqual(reader.levels.map(level => level.row_group_end), [0, 1, 1]);
  const medium = await reader.readRows({ maxLevel: 1, columns });
  const fine = await reader.readRows({ maxLevel: 2, columns });
  assert.deepEqual(medium.map(row => row.id), fine.map(row => row.id));
  assert.notDeepEqual(medium[0].geometry, fine[0].geometry);
  assert.deepEqual(await reader.readRows({ maxLevel: 1, columns }), medium);
});

test('shared LoD remains readable beyond its first referenced prefix', async () => {
  const { reader } = await openFixture('shared');
  const columns = ['id', 'geometry'];
  assert.deepEqual(reader.levels.map(level => [level.row_group_end, level.lod]),
    [[0, 'l0'], [0, 'l1'], [1, 'l1'], [1, 'l2']]);
  const first = await reader.readRows({ maxLevel: 1, columns });
  const extended = await reader.readRows({ maxLevel: 2, columns });
  assert.equal(first.length, 1);
  assert.equal(extended.length, 2);
  assert.deepEqual(first[0], extended[0]);
});

test('readRows can attach a stable, non-enumerable source row index', async () => {
  const { reader } = await openFixture('refinement');
  const rows = await reader.readRows({
    columns: ['id', 'geometry'],
    includeRowIndex: true,
    maxLevel: 2,
  });
  assert.deepEqual(rows.map(row => row[COGP_ROW_INDEX]), [0, 1]);
  assert.deepEqual(Object.keys(rows[0]), ['id', 'geometry']);
  assert.deepEqual({ ...rows[0] }, { id: 0, geometry: rows[0].geometry });
});

test('readRow projects one source row without requiring geometry', async () => {
  const { reader } = await openFixture('refinement');
  assert.ok(reader.columnNames.includes('id'));
  assert.deepEqual(await reader.readRow(1, { columns: ['id'] }), { id: 1 });
  await assert.rejects(() => reader.readRow(-1), /rowIndex/);
  await assert.rejects(() => reader.readRow(2), /rowIndex/);
});

test('base layout with separate covering roots retains candidates without statistics', async () => {
  const { reader } = await openFixture('base-covering');
  assert.equal(reader.rowGroupEnvelope(0), null);
  const rows = await reader.readRows({ columns: ['id', 'overviews'], bbox: [-1, -1, 1, 1] });
  assert.deepEqual(rows, [{ id: 0, overviews: 'ordinary' }, { id: 1, overviews: 'attribute' }, { id: 2, overviews: 'null geometry' }]);
});

test('base layout without covering conservatively retains candidates', async () => {
  const { reader } = await openFixture('base-no-covering');
  const rows = await reader.readRows({ columns: ['id', 'overviews'], bbox: [-1, -1, 1, 1] });
  assert.deepEqual(rows, [{ id: 0, overviews: 'ordinary' }, { id: 1, overviews: 'attribute' }, { id: 2, overviews: 'null geometry' }]);
});

test('base layout preserves null primary geometries in unfiltered reads', async () => {
  const { reader } = await openFixture('base-covering');
  const rows = await reader.readRows({ columns: ['id', 'geometry'] });
  assert.equal(rows.length, 3);
  assert.equal(rows[2].id, 2);
  assert.equal(rows[2].geometry, null);
});

test('explicit undefined attribute values are distinct from unread row slots', async () => {
  const { reader } = await openFixture('base-no-covering');
  // Hyparquet can emit undefined for empty nested attributes. A hole instead
  // means the requested row was never delivered by the decoder.
  reader.readColumnValues = async () => new Map([['overviews', [undefined, 'value', null]]]);
  assert.deepEqual(await reader.readRow(0, { columns: ['overviews'] }), { overviews: undefined });
  assert.deepEqual(await reader.readRows({ columns: ['overviews'] }), [
    { overviews: undefined }, { overviews: 'value' }, { overviews: null },
  ]);
  reader.readColumnValues = async () => new Map([['overviews', new Array(3)]]);
  await assert.rejects(reader.readRow(0, { columns: ['overviews'] }), /missing row/);
  await assert.rejects(reader.readRows({ columns: ['overviews'] }), /missing row/);
});

test('plain attribute encoding preserves scalars, binary and nested values', async () => {
  const { reader } = await openFixture('attribute-encodings');
  const columns = ['id', 'name', 'long', 'float', 'flag', 'binary', 'fixed', 'nested', 'values'];
  const rows = await reader.readRows({ columns });
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
  const first = await reader.readRow(0, { columns });
  assert.deepEqual(first, rows[0]);
});
