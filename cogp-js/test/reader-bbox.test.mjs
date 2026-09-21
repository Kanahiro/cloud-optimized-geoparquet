import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { COGP_ROW_INDEX, CogpReader } from '../dist/index.js';

const bbox = [0.5, -1, 1.5, 1];
const intersects = (a, b) => a[0] < b[1] && b[0] < a[1];

async function fixture(name = 'indexed') {
  const bytes = await readFile(new URL(`fixtures/${name}.parquet`, import.meta.url));
  const calls = [];
  const file = {
    byteLength: bytes.length,
    slice(start, end = bytes.length) {
      calls.push([start, end]);
      return bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end);
    },
  };
  const metadata = await parquetMetadataAsync(file);
  const spans = root => metadata.row_groups.flatMap(group => group.columns
    .filter(c => c.meta_data.path_in_schema[0] === root)
    .map(c => {
      const m = c.meta_data;
      const start = Number(m.dictionary_page_offset ?? m.data_page_offset);
      return [start, start + Number(m.total_compressed_size)];
    }));
  const reader = await CogpReader.fromAsyncBuffer(file);
  calls.length = 0;
  return { bytes, calls, file, metadata, spans, reader };
}

function geometryRanges(calls, spans) {
  const ranges = calls.flatMap(a => spans.filter(b => intersects(a, b))
    .map(b => [Math.max(a[0], b[0]), Math.min(a[1], b[1])]))
    .sort((a, b) => a[0] - b[0]);
  const union = [];
  for (const range of ranges) {
    const previous = union.at(-1);
    if (previous && previous[1] >= range[0]) previous[1] = Math.max(previous[1], range[1]);
    else union.push(range);
  }
  return union;
}

test('bbox uses PageIndexes without reading covering values or expanding geometry reads', async () => {
  const f = await fixture();
  const rows = await f.reader.readRows({ bbox, columns: ['id', 'geometry', 'bbox'], includeRowIndex: true });
  // The first bbox page contains eight candidates, but only id=1 is an exact hit.
  // Geometry pages contain four rows: attribute/geometry page boundaries differ.
  assert.deepEqual(rows.map(r => r.id), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(rows.map(r => r[COGP_ROW_INDEX]), rows.map(r => r.id));
  for (const row of rows) {
    assert.deepEqual(row.geometry, { type: 'Point', coordinates: [row.id < 4 ? row.id : 100 + row.id, 0] });
    assert.equal(row.bbox, `attribute-${row.id}`);
    assert.equal('bounds' in row, false);
  }
  assert.ok(f.calls.length > 0);
  assert.ok(f.calls.every(a => f.spans('bounds').every(b => !intersects(a, b))));
  const geometry = geometryRanges(f.calls, f.spans('geometry'));
  f.calls.length = 0;
  // The previous value-filtering path selected these same geometry pages.
  const exact = await parquetReadObjects({
    file: f.file, metadata: f.metadata, columns: ['id', 'geometry', 'bbox', 'bounds'],
    usePageIndex: true,
    filter: { $and: [
      { 'bounds.xmin': { $lte: bbox[2] } }, { 'bounds.ymin': { $lte: bbox[3] } },
      { 'bounds.xmax': { $gte: bbox[0] } }, { 'bounds.ymax': { $gte: bbox[1] } },
    ] },
  });
  assert.deepEqual(exact.map(r => r.id), [1]);
  assert.deepEqual(geometryRanges(f.calls, f.spans('geometry')), geometry);
});

test('default projection omits metadata-defined covering, but explicit projection can read it', async () => {
  const f = await fixture();
  const rows = await f.reader.readRows({ bbox });
  assert.ok(rows.every(row => !('bounds' in row) && 'bbox' in row));
  assert.ok(f.calls.every(a => f.spans('bounds').every(b => !intersects(a, b))));
  f.calls.length = 0;
  const projected = await f.reader.readRows({ bbox, columns: ['id', 'bounds'] });
  assert.equal(projected[1].bounds.xmin, 1);
  assert.ok(f.calls.some(a => f.spans('bounds').some(b => intersects(a, b))));
  assert.ok((await f.reader.readRows()).every(row => 'bounds' in row));
});

for (const [name, count] of [['no-index', 16], ['no-statistics', 48]]) {
  test(`${name} conservatively returns candidates without fetching bbox values`, async () => {
    const f = await fixture(name);
    const rows = await f.reader.readRows({ bbox, columns: ['id', 'geometry'] });
    assert.equal(rows.length, count);
    assert.ok(rows.some(r => r.id === 1));
    assert.ok(f.calls.every(a => f.spans('bounds').every(b => !intersects(a, b))));
  });
}

test('without covering, the overview branch retains candidates without injecting geometry', async () => {
  const f = await fixture('no-covering');
  const rows = await f.reader.readRows({ bbox, columns: ['id'] });
  assert.deepEqual(rows.map(row => row.id), Array.from({ length: 48 }, (_, i) => i));
  assert.ok(rows.every(row => !('geometry' in row)));
  assert.ok(f.calls.every(a => f.spans('bounds').every(b => !intersects(a, b))));
});

test('row-group rejection avoids data I/O and output caps count returned candidates', async () => {
  const f = await fixture();
  assert.deepEqual(await f.reader.readRows({ bbox: [-20, -20, -10, -10] }), []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual((await f.reader.readRows({ bbox, maxRows: 2 })).map(r => r.id), [0, 1]);
});
