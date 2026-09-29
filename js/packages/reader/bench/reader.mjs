import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: node bench/reader.mjs <reader dist/index.js>');
const { CogpReader } = await import(pathToFileURL(resolve(modulePath)).href);

// The committed fixtures keep this benchmark independent of network latency and
// producer changes. Each slice copies bytes, as an HTTP range response would.
const fixtures = Object.fromEntries(await Promise.all(
  ['indexed', 'refinement'].map(async name => {
    const url = name === 'indexed'
      ? new URL('../test/fixtures/indexed.parquet', import.meta.url)
      : new URL('../../../../test-data/refinement.parquet', import.meta.url);
    return [name, await readFile(url)];
  }),
));

function source(name, counters) {
  const bytes = fixtures[name];
  return {
    byteLength: bytes.length,
    slice(start, end = bytes.length) {
      counters.ranges++;
      counters.bytes += end - start;
      return bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end);
    },
  };
}

const cases = [
  {
    name: 'bbox-cold', fixture: 'indexed', fresh: true, iterations: 4_000,
    options: { bbox: [0.5, -1, 1.5, 1], columns: ['id', 'geometry'] },
  },
  {
    name: 'bbox-warm', fixture: 'indexed', fresh: false, iterations: 10_000,
    options: { bbox: [0.5, -1, 1.5, 1], columns: ['id', 'geometry'] },
  },
  {
    name: 'full-wkb', fixture: 'indexed', fresh: false, iterations: 10_000,
    options: { columns: ['id', 'geometry'] },
  },
  {
    name: 'overview', fixture: 'refinement', fresh: false, iterations: 1_000,
    options: { useOverview: true, maxLevel: 2, columns: ['id', 'geometry'] },
  },
];

const results = [];
for (const spec of cases) {
  const counters = { bytes: 0, ranges: 0 };
  const open = () => CogpReader.fromAsyncBuffer(source(spec.fixture, counters), `bench:${spec.fixture}`);
  const reader = spec.fresh ? null : await open();
  const operation = async () => {
    const batch = await (spec.fresh ? await open() : reader).read(spec.options);
    if (!batch.geometry || batch.geometry.length !== batch.length) {
      throw new Error(`${spec.name}: missing geometry`);
    }
    return [batch.length, Number(batch.columns.id[0] ?? 0), Number(batch.columns.id[batch.length - 1] ?? 0)];
  };
  for (let i = 0; i < 10; i++) await operation();
  counters.bytes = 0;
  counters.ranges = 0;
  let rows = 0;
  let checksum = 0;
  const start = performance.now();
  for (let i = 0; i < spec.iterations; i++) {
    const [length, firstId, lastId] = await operation();
    rows += length;
    checksum += firstId + lastId;
  }
  const ms = performance.now() - start;
  results.push({
    name: spec.name,
    msPerOp: ms / spec.iterations,
    rowsPerOp: rows / spec.iterations,
    checksum,
    bytesPerOp: counters.bytes / spec.iterations,
    rangesPerOp: counters.ranges / spec.iterations,
  });
}
console.log(JSON.stringify(results));
