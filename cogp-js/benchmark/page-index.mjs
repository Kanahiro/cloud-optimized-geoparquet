import { CogpReader } from '../dist/index.js';

const datasets = [
  {
    name: 'row-group-only',
    url: 'https://cogp-demo.spatialty.io/pois.cogp.parquet',
    byteLength: 2_246_695_298,
  },
  {
    name: 'row-group-page-index',
    url: 'https://cogp-demo.spatialty.io/v0.1.0/pois-100000.cogp.parquet',
    byteLength: 2_244_753_187,
  },
];

const workloads = {
  small: { bbox: [139.70, 35.65, 139.80, 35.75], targetGsd: 100 },
  medium: { bbox: [139.30, 35.30, 140.10, 36.00], targetGsd: 100 },
};

const workloadName = process.argv[2] ?? 'small';
const repeats = Number(process.argv[3] ?? 3);
const workload = workloads[workloadName];
if (!workload) throw new Error(`unknown workload ${workloadName}`);
if (!Number.isInteger(repeats) || repeats < 1) throw new Error(`invalid repeat count ${repeats}`);

const scenarios = datasets.flatMap(dataset =>
  [false, true].flatMap(usePageIndex =>
    [false, true].map(coalescing => ({ dataset, usePageIndex, coalescing })),
  ),
);

const samples = new Map(scenarios.map((scenario, i) => [i, []]));
for (let repeat = 0; repeat < repeats; repeat++) {
  // Rotate the order so a consistently early or late request cannot own one
  // scenario across every repeat.
  for (let offset = 0; offset < scenarios.length; offset++) {
    const scenarioIndex = (offset + repeat * 3) % scenarios.length;
    const scenario = scenarios[scenarioIndex];
    const sample = await run(scenario, workload);
    samples.get(scenarioIndex).push(sample);
    console.error(JSON.stringify({ repeat: repeat + 1, ...label(scenario), ...sample }));
  }
}

const results = scenarios.map((scenario, i) => {
  const values = samples.get(i);
  return {
    ...label(scenario),
    requests: median(values.map(value => value.requests)),
    bytes: median(values.map(value => value.bytes)),
    milliseconds: Math.round(median(values.map(value => value.milliseconds))),
    rows: median(values.map(value => value.rows)),
  };
});
console.log(JSON.stringify({ workload: workloadName, repeats, results }, null, 2));

async function run({ dataset, usePageIndex, coalescing }, { bbox, targetGsd }) {
  let requests = 0;
  let bytes = 0;
  const countedFetch = async (input, init = {}) => {
    const response = await fetch(input, { ...init, cache: 'no-store' });
    requests++;
    bytes += Number(response.headers.get('content-length') ?? 0);
    return response;
  };

  const start = performance.now();
  const reader = await CogpReader.open(dataset.url, {
    fetch: countedFetch,
    byteLength: dataset.byteLength,
    rangeCoalescing: coalescing ? undefined : false,
  });
  const rows = await reader.readRows({
    bbox,
    maxLevel: reader.selectLevel(targetGsd),
    usePageIndex,
  });
  return {
    requests,
    bytes,
    milliseconds: performance.now() - start,
    rows: rows.length,
  };
}

function label({ dataset, usePageIndex, coalescing }) {
  return { dataset: dataset.name, usePageIndex, coalescing };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
