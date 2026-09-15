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

for (const name of ['refinement', 'shared', 'legacy']) {
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
