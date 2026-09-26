import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parquetMetadataAsync, parquetReadObjects } from '../vendor/hyparquet/src/index.js';
import { CogpReader } from '../dist/index.js';
import { ROW, readRecords } from './helpers.mjs';

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

test('bbox selects exact covering hits and fetches fewer geometry pages than statistics alone', async () => {
  const f = await fixture();
  const rows = await readRecords(f.reader, { bbox, columns: ['id', 'geometry', 'bbox'] });
  // The first bbox page contains eight candidates, but only id=1 is an exact hit.
  assert.deepEqual(rows.map(r => r.id), [1]);
  assert.equal(rows[0][ROW], 1);
  assert.deepEqual(rows[0].geometry, { type: 'Point', coordinates: [1, 0] });
  assert.equal(rows[0].bbox, 'attribute-1');
  assert.equal('bounds' in rows[0], false);
  // Covering is read once to select rows; geometry pages follow that selection.
  assert.ok(f.calls.some(a => f.spans('bounds').some(b => intersects(a, b))));
  const refined = geometryRanges(f.calls, f.spans('geometry'));
  f.calls.length = 0;
  await parquetReadObjects({
    file: f.file, metadata: f.metadata, columns: ['id', 'geometry', 'bbox'],
    usePageIndex: true,
    filter: { $and: [
      { 'bounds.xmin': { $lte: bbox[2] } }, { 'bounds.ymin': { $lte: bbox[3] } },
      { 'bounds.xmax': { $gte: bbox[0] } }, { 'bounds.ymax': { $gte: bbox[1] } },
    ] },
  });
  const statistics = geometryRanges(f.calls, f.spans('geometry'));
  const size = ranges => ranges.reduce((n, [a, b]) => n + b - a, 0);
  assert.ok(size(refined) <= size(statistics));
});

test('default projection always omits covering, but explicit projection can read it', async () => {
  const f = await fixture();
  const rows = await readRecords(f.reader, { bbox });
  assert.ok(rows.every(row => !('bounds' in row) && 'bbox' in row));
  const projected = await readRecords(f.reader, { bbox, columns: ['id', 'bounds'] });
  assert.deepEqual(projected.map(row => [row.id, row.bounds.xmin]), [[1, 1]]);
  // Without a bbox the default still omits covering and returns the primary geometry.
  const all = await f.reader.read();
  assert.ok(!('bounds' in all.columns) && !('geometry' in all.columns) && 'bbox' in all.columns);
  assert.equal(all.geometry.length, all.length);
});

for (const name of ['no-index', 'no-statistics']) {
  test(`${name} still selects rows from covering values`, async () => {
    const f = await fixture(name);
    const rows = await readRecords(f.reader, { bbox, columns: ['id', 'geometry'] });
    assert.deepEqual(rows.map(r => r.id), [1]);
    assert.ok(f.calls.some(a => f.spans('bounds').some(b => intersects(a, b))));
  });
}

test('without covering, the overview branch retains candidates without injecting geometry', async () => {
  const f = await fixture('no-covering');
  const rows = await readRecords(f.reader, { bbox, columns: ['id'] });
  assert.deepEqual(rows.map(row => row.id), Array.from({ length: 48 }, (_, i) => i));
  assert.ok(rows.every(row => !('geometry' in row)));
  assert.ok(f.calls.every(a => f.spans('bounds').every(b => !intersects(a, b))));
});

test('row-group rejection avoids data I/O and output caps count returned candidates', async () => {
  const f = await fixture();
  assert.deepEqual(await readRecords(f.reader, { bbox: [-20, -20, -10, -10] }), []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual((await readRecords(f.reader, { bbox: [-200, -200, 200, 200], maxRows: 2 })).map(r => r.id), [0, 1]);
});

for (const name of ['indexed', 'no-index', 'no-statistics']) {
  test(`${name}: bbox refinement preserves identity and fetches geometry only for hits`, async () => {
    const f = await fixture(name);
    const rows = await readRecords(f.reader, { bbox, columns: ['id', 'geometry'] });
    assert.deepEqual(rows.map(r => r.id), [1]);
    assert.equal(rows[0][ROW], 1);
    assert.deepEqual(rows[0].geometry, { type: 'Point', coordinates: [1, 0] });
    assert.equal('bounds' in rows[0], false);
    const refined = geometryRanges(f.calls, f.spans('geometry')).reduce((n, [a,b]) => n+b-a, 0);
    const whole = f.spans('geometry').reduce((n, [a,b]) => n+b-a, 0);
    assert.ok(refined <= whole);
  });
}

test('bbox refinement with no hits skips all geometry data', async () => {
  const f = await fixture();
  const rows = await readRecords(f.reader, { bbox: [20,-1,21,1], columns: ['geometry'] });
  assert.deepEqual(rows, []);
  assert.deepEqual(geometryRanges(f.calls, f.spans('geometry')), []);
});

test('maxRows fetches only the pages holding the kept rows', async () => {
  const size = ranges => ranges.reduce((n, [a, b]) => n + b - a, 0);
  for (const options of [{}, { bbox: [-200, -200, 200, 200] }]) {
    const f = await fixture();
    const rangeCacheOff = await CogpReader.fromAsyncBuffer(f.file, 'indexed', { rangeCache: false });
    f.calls.length = 0;
    const all = await rangeCacheOff.read({ ...options, columns: ['geometry'] });
    const whole = size(geometryRanges(f.calls, f.spans('geometry')));
    f.calls.length = 0;
    const first = await rangeCacheOff.read({ ...options, columns: ['geometry'], maxRows: 1 });
    assert.deepEqual([...first.rowIndex], [all.rowIndex[0]]);
    assert.ok(size(geometryRanges(f.calls, f.spans('geometry'))) < whole, JSON.stringify(options));
  }
});
