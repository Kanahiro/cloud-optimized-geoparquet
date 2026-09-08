import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const here = new URL('.', import.meta.url);
const readJson = async name => JSON.parse(await readFile(new URL(name, here), 'utf8'));
const resolutions = [1000, 100, 10];

function parseLayout(file) {
  const match = file.match(/rg(\d+)-p512-dict(\d+)k/);
  if (!match) throw new Error(`cannot parse layout from ${file}`);
  return { rowGroupRows: Number(match[1]), dictionaryLimitKiB: Number(match[2]) };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function csv(rows) {
  const header = Object.keys(rows[0]);
  const quote = value => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [header.join(','), ...rows.map(row => header.map(key => quote(row[key])).join(','))].join('\n') + '\n';
}

function pct(value, baseline) {
  return (value / baseline - 1) * 100;
}

function estimateMs(observedRttMs, bytes, mbps) {
  return observedRttMs + bytes * 8 / (mbps * 1000);
}

function mergeFiles(...documents) {
  return Object.assign({}, ...documents.map(document => document.files));
}

const rtt0 = mergeFiles(
  await readJson('read-rtt0.json'),
  await readJson('read-rtt0-low.json'),
);
const rtt25 = mergeFiles(
  await readJson('read-rtt25.json'),
  await readJson('read-rtt25-low.json'),
);

const controlled = Object.entries(rtt0).map(([file, local]) => {
  const layout = parseLayout(file);
  const network = rtt25[file];
  if (!network) throw new Error(`missing RTT25 result for ${file}`);
  return {
    file,
    ...layout,
    fileSizeBytes: local.sizeBytes,
    meanQueryBytes: mean(resolutions.map(r => local.byResolution[r].queryBytes.mean)),
    meanQueryRequests: mean(resolutions.map(r => local.byResolution[r].queryRequests.mean)),
    meanLocalMs: mean(resolutions.map(r => local.byResolution[r].queryMilliseconds.mean)),
    meanRtt25Ms: mean(resolutions.map(r => network.byResolution[r].queryMilliseconds.mean)),
  };
}).sort((a, b) => a.rowGroupRows - b.rowGroupRows || a.dictionaryLimitKiB - b.dictionaryLimitKiB);

for (const row of controlled) {
  const baseline = controlled.find(candidate =>
    candidate.rowGroupRows === row.rowGroupRows && candidate.dictionaryLimitKiB === 1024);
  row.fileSizeVs1MiBPct = pct(row.fileSizeBytes, baseline.fileSizeBytes);
  row.queryBytesVs1MiBPct = pct(row.meanQueryBytes, baseline.meanQueryBytes);
  row.requestsVs1MiBPct = pct(row.meanQueryRequests, baseline.meanQueryRequests);
  row.rtt25Vs1MiBPct = pct(row.meanRtt25Ms, baseline.meanRtt25Ms);
  row.estimated50MbpsMs = estimateMs(row.meanRtt25Ms, row.meanQueryBytes, 50);
  row.estimated100MbpsMs = estimateMs(row.meanRtt25Ms, row.meanQueryBytes, 100);
  row.estimated200MbpsMs = estimateMs(row.meanRtt25Ms, row.meanQueryBytes, 200);
}

const controlledByResolution = [];
for (const row of controlled) {
  const local = rtt0[row.file];
  const network = rtt25[row.file];
  for (const resolution of resolutions) {
    controlledByResolution.push({
      rowGroupRows: row.rowGroupRows,
      dictionaryLimitKiB: row.dictionaryLimitKiB,
      resolutionMeters: resolution,
      meanRows: local.byResolution[resolution].rows.mean,
      meanCandidateRowGroups: local.byResolution[resolution].candidateRowGroups.mean,
      meanQueryBytes: local.byResolution[resolution].queryBytes.mean,
      meanQueryRequests: local.byResolution[resolution].queryRequests.mean,
      meanLocalMs: local.byResolution[resolution].queryMilliseconds.mean,
      meanRtt25Ms: network.byResolution[resolution].queryMilliseconds.mean,
    });
  }
}

const fullLocal = await readJson('read-full-rtt0.json');
const fullNetwork = await readJson('read-full-rtt25.json');
const fullEntries = Object.entries(fullLocal.files);
const baselineFull = fullEntries.find(([file]) => file.includes('main.cogp.parquet'));
const candidateFull = fullEntries.find(([file]) => file.includes('dict32k'));
if (!baselineFull || !candidateFull) throw new Error('full comparison files not found');

const fullSummary = [];
for (const resolution of resolutions) {
  const baselineLocal = baselineFull[1].byResolution[resolution];
  const candidateLocal = candidateFull[1].byResolution[resolution];
  const baselineRtt = fullNetwork.files[baselineFull[0]].byResolution[resolution];
  const candidateRtt = fullNetwork.files[candidateFull[0]].byResolution[resolution];
  fullSummary.push({
    resolutionMeters: resolution,
    meanRows: baselineLocal.rows.mean,
    meanCandidateRowGroups: baselineLocal.candidateRowGroups.mean,
    baselineQueryBytes: baselineLocal.queryBytes.mean,
    candidateQueryBytes: candidateLocal.queryBytes.mean,
    queryBytesChangePct: pct(candidateLocal.queryBytes.mean, baselineLocal.queryBytes.mean),
    baselineRequests: baselineLocal.queryRequests.mean,
    candidateRequests: candidateLocal.queryRequests.mean,
    requestsChangePct: pct(candidateLocal.queryRequests.mean, baselineLocal.queryRequests.mean),
    baselineLocalMs: baselineLocal.queryMilliseconds.mean,
    candidateLocalMs: candidateLocal.queryMilliseconds.mean,
    localMsChangePct: pct(candidateLocal.queryMilliseconds.mean, baselineLocal.queryMilliseconds.mean),
    baselineRtt25Ms: baselineRtt.queryMilliseconds.mean,
    candidateRtt25Ms: candidateRtt.queryMilliseconds.mean,
    rtt25ChangePct: pct(candidateRtt.queryMilliseconds.mean, baselineRtt.queryMilliseconds.mean),
    baselineEstimated100MbpsMs: estimateMs(baselineRtt.queryMilliseconds.mean, baselineLocal.queryBytes.mean, 100),
    candidateEstimated100MbpsMs: estimateMs(candidateRtt.queryMilliseconds.mean, candidateLocal.queryBytes.mean, 100),
  });
}

function sampleKey(sample) {
  return `${sample.center}/${sample.resolution}/${sample.repeat ?? 0}`;
}

const checks = [];
for (const groupRows of [32768, 65536]) {
  const sameGroup = controlled.filter(row => row.rowGroupRows === groupRows);
  const reference = rtt0[sameGroup[0].file].samples;
  const referenceRows = new Map(reference.map(sample => [sampleKey(sample), sample.rows]));
  for (const row of sameGroup.slice(1)) {
    const mismatches = rtt0[row.file].samples.filter(sample =>
      referenceRows.get(sampleKey(sample)) !== sample.rows ||
      reference.find(candidate => sampleKey(candidate) === sampleKey(sample))?.idFingerprint !== sample.idFingerprint);
    checks.push({ check: `row counts and id fingerprints match within RG ${groupRows}`, file: path.basename(row.file), mismatches: mismatches.length });
  }
}

const fullReference = baselineFull[1].samples;
const fullCandidate = candidateFull[1].samples;
const fullMismatches = fullReference.filter((sample, index) =>
  sampleKey(sample) !== sampleKey(fullCandidate[index]) ||
  sample.rows !== fullCandidate[index].rows ||
  sample.idFingerprint !== fullCandidate[index].idFingerprint ||
  sample.candidateRowGroups !== fullCandidate[index].candidateRowGroups);
checks.push({ check: 'full row counts, id fingerprints, and candidate RowGroups match', file: path.basename(candidateFull[0]), mismatches: fullMismatches.length });

await writeFile(new URL('controlled-summary.csv', here), csv(controlled.map(({ file: _file, ...row }) => row)));
await writeFile(new URL('controlled-by-resolution.csv', here), csv(controlledByResolution));
await writeFile(new URL('full-summary.csv', here), csv(fullSummary));
await writeFile(new URL('validation.json', here), JSON.stringify({ checks }, null, 2) + '\n');

console.log(JSON.stringify({
  controlledRows: controlled.length,
  fullRows: fullSummary.length,
  failedChecks: checks.filter(check => check.mismatches !== 0).length,
}, null, 2));
