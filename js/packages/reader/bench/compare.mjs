import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [baseline, candidate] = process.argv.slice(2);
if (!baseline || !candidate) {
  throw new Error('usage: node bench/compare.mjs <baseline dist/index.js> <candidate dist/index.js>');
}
const benchmark = fileURLToPath(new URL('./reader.mjs', import.meta.url));
const samples = { baseline: [], candidate: [] };

// Alternate the order to reduce drift from shared-runner load or CPU scaling.
for (let round = 0; round < 5; round++) {
  for (const version of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const modulePath = resolve(version === 'baseline' ? baseline : candidate);
    const run = spawnSync(process.execPath, [benchmark, modulePath], { encoding: 'utf8', timeout: 120_000 });
    if (run.status !== 0 || run.error) {
      throw new Error(`${version} benchmark failed: ${run.error ?? run.stderr}`);
    }
    samples[version].push(JSON.parse(run.stdout));
  }
}

const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const threshold = 1.25;
let failed = false;
const summary = ['| Case | Base ms/op | Change ms/op | Time ratio | Base bytes/op | Change bytes/op | Base ranges/op | Change ranges/op | Result |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |'];
for (const name of samples.baseline[0].map(result => result.name)) {
  const before = samples.baseline.map(run => run.find(result => result.name === name));
  const after = samples.candidate.map(run => run.find(result => result.name === name));
  if ([...before, ...after].some(result => !result || !Number.isFinite(result.msPerOp))) {
    throw new Error(`${name}: missing or invalid measurement`);
  }
  for (let i = 0; i < before.length; i++) {
    if (before[i].rowsPerOp !== after[i].rowsPerOp || before[i].checksum !== after[i].checksum) {
      throw new Error(`${name}: result changed between baseline and candidate`);
    }
  }
  const baseMs = median(before.map(result => result.msPerOp));
  const nextMs = median(after.map(result => result.msPerOp));
  const baseBytes = median(before.map(result => result.bytesPerOp));
  const nextBytes = median(after.map(result => result.bytesPerOp));
  const baseRanges = median(before.map(result => result.rangesPerOp));
  const nextRanges = median(after.map(result => result.rangesPerOp));
  const ratio = nextMs / baseMs;
  const ioRatio = baseBytes ? nextBytes / baseBytes : nextBytes ? Infinity : 1;
  const rangeRatio = baseRanges ? nextRanges / baseRanges : nextRanges ? Infinity : 1;
  // A large and stable increase in range bytes is a regression even if it is
  // masked by the in-memory transport used for timing.
  const regression = ratio > threshold || ioRatio > 1.1 || rangeRatio > 1.1;
  failed ||= regression;
  console.log(`${regression ? 'REGRESSION' : 'OK'} ${name}: ${baseMs.toFixed(3)} -> ${nextMs.toFixed(3)} ms/op (${ratio.toFixed(2)}x), ${baseBytes.toFixed(0)} -> ${nextBytes.toFixed(0)} bytes/op, ${baseRanges.toFixed(0)} -> ${nextRanges.toFixed(0)} ranges/op`);
  summary.push(`| ${name} | ${baseMs.toFixed(3)} | ${nextMs.toFixed(3)} | ${ratio.toFixed(2)}x | ${baseBytes.toFixed(0)} | ${nextBytes.toFixed(0)} | ${baseRanges.toFixed(0)} | ${nextRanges.toFixed(0)} | ${regression ? 'REGRESSION' : 'OK'} |`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Reader benchmark\n\n${summary.join('\n')}\n\nFailure thresholds: time >1.25x, range bytes or count >1.10x.\n`);
}
if (failed) process.exitCode = 1;
