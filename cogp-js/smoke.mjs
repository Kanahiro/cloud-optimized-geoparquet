// End-to-end smoke test: load a local COGP file via CogpReader.fromAsyncBuffer
// and exercise the full public API.
import { readFile } from 'node:fs/promises';
import { CogpReader } from './dist/index.js';

const PATH = '/tmp/spp.cogp.parquet';
const bytes = await readFile(PATH);
const file = {
  byteLength: bytes.byteLength,
  slice: async (start, end) =>
    bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + (end ?? bytes.byteLength)),
};

const reader = await CogpReader.fromAsyncBuffer(file, 'file://' + PATH);
console.log('---- metadata ----');
console.log('lods:', reader.lods.length, '/ row groups:', reader.numRowGroups);
console.log('primary col:', reader.primaryGeometryColumn);
console.log('first lod:', reader.lods[0], '/ last lod:', reader.lods.at(-1));

console.log('\n---- LoD selection by target gsd ----');
for (const gsd of [100000, 5000, 500, 50]) {
  const idx = reader.selectLod(gsd);
  console.log(`  target ${gsd}m -> lod ${idx} (gsd ${reader.lods[idx].gsd.toFixed(2)}m)`);
}

console.log('\n---- coarsest LoD as rows ----');
const coarse = await reader.readRows({ maxLod: 0 });
console.log('rows:', coarse.length);
console.log('first row geometry type:', coarse[0]?.[reader.primaryGeometryColumn]?.type);

console.log('\n---- full file ----');
const full = await reader.readRows();
console.log('rows:', full.length);

console.log('\n---- bbox filter ----');
// Data is around lng/lat (142.4, 44.15) — central Hokkaido
const filtered = await reader.readRows({
  bbox: [142.35, 44.10, 142.65, 44.25],
});
console.log('within data bbox:', filtered.length);

const noHit = await reader.readRows({ bbox: [0, 0, 1, 1] });
console.log('outside bbox (should be 0):', noHit.length);

console.log('\n---- readRows (bbox around the data, target gsd=150m) ----');
const rows = await reader.readRows({
  bbox: [142.35, 44.10, 142.65, 44.25],
  maxLod: reader.selectLod(150),
});
console.log('rows:', rows.length);
console.log('first row geometry type:', rows[0]?.[reader.primaryGeometryColumn]?.type);

console.log('\nOK');

console.log('\n---- row group envelopes ----');
for (let i = 0; i < reader.numRowGroups; i++) {
  console.log(`  rg ${i}:`, reader.rowGroupEnvelope(i));
}
