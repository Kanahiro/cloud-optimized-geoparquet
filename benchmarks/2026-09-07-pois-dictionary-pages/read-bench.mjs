import { open, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

import { CogpReader, rangeCachedAsyncBuffer } from '../../cogp-js/dist/index.js';
import { coalescingAsyncBuffer } from '../../cogp-js/dist/coalescing-buffer.js';

const files = process.argv.slice(2);
if (!files.length) throw new Error('pass parquet files');

const simulatedRttMs = Number(process.env.RTT_MS ?? 0);
const idColumn = process.env.ID_COLUMN ?? 'id';
const geometryColumn = process.env.GEOMETRY_COLUMN ?? 'geometry';
const columns = process.env.PROJECTION?.split(',').filter(Boolean) ?? [idColumn, geometryColumn];
const repeats = Number(process.env.REPEATS ?? 1);

const centers = [
  ['tokyo', 139.75, 35.68],
  ['osaka', 135.50, 34.70],
  ['nagoya', 136.90, 35.18],
  ['sapporo', 141.35, 43.06],
  ['fukuoka', 130.40, 33.59],
  ['sendai', 140.87, 38.27],
  ['hiroshima', 132.46, 34.39],
  ['naha', 127.68, 26.21],
];
const resolutions = [1000, 100, 10];

function percentile(values, p) {
  const xs = [...values].sort((a, b) => a - b);
  return xs[Math.floor((xs.length - 1) * p)];
}

function summarize(samples) {
  const metric = key => ({
    mean: samples.reduce((sum, value) => sum + value[key], 0) / samples.length,
    p50: percentile(samples.map(value => value[key]), 0.5),
    p95: percentile(samples.map(value => value[key]), 0.95),
  });
  return {
    samples: samples.length,
    rows: metric('rows'),
    candidateRowGroups: metric('candidateRowGroups'),
    queryBytes: metric('queryBytes'),
    queryRequests: metric('queryRequests'),
    queryMilliseconds: metric('queryMilliseconds'),
    totalBytes: metric('totalBytes'),
    totalRequests: metric('totalRequests'),
  };
}

function intersects(a, b) {
  return !(
    a.maxX < b.minX || b.maxX < a.minX ||
    a.maxY < b.minY || b.maxY < a.minY
  );
}

async function runOne(path, center, resolution, repeat) {
  const info = await stat(path);
  const handle = await open(path, 'r');
  const io = { requests: 0, bytes: 0 };
  const source = {
    byteLength: info.size,
    async slice(start, end = info.size) {
      const length = end - start;
      if (simulatedRttMs > 0) {
        await new Promise(resolve => setTimeout(resolve, simulatedRttMs));
      }
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      if (bytesRead !== length) throw new Error(`short read ${bytesRead}/${length}`);
      io.requests++;
      io.bytes += length;
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + length);
    },
  };

  try {
    // Match CogpReader.open(): HTTP reads are coalesced, then successful exact
    // caller ranges are retained in a per-reader in-memory LRU.
    const file = rangeCachedAsyncBuffer(coalescingAsyncBuffer(source));
    const reader = await CogpReader.fromAsyncBuffer(file, path);
    const openBytes = io.bytes;
    const openRequests = io.requests;
    const level = reader.selectLevel(resolution);
    const [name, x, y] = center;
    const widthMeters = resolution * 512;
    const heightMeters = resolution * 512;
    const halfWidth = widthMeters / (2 * 111_320 * Math.cos(y * Math.PI / 180));
    const halfHeight = heightMeters / (2 * 110_540);
    const bbox = {
      minX: x - halfWidth,
      minY: y - halfHeight,
      maxX: x + halfWidth,
      maxY: y + halfHeight,
    };
    const boundary = reader.levels[level].row_group_end;
    let candidateRowGroups = 0;
    for (let rg = 0; rg <= boundary; rg++) {
      const envelope = reader.rowGroupEnvelope(rg);
      if (!envelope || intersects(envelope, bbox)) candidateRowGroups++;
    }

    const start = performance.now();
    const rows = await reader.readRows({
      bbox,
      maxLevel: level,
      columns,
    });
    const queryMilliseconds = performance.now() - start;
    const idFingerprint = columns.includes(idColumn)
      ? createHash('sha256')
        .update(rows.map(row => String(row[idColumn])).sort().join('\n'))
        .digest('hex')
      : undefined;
    return {
      center: name,
      resolution,
      repeat,
      level,
      rows: rows.length,
      idFingerprint,
      candidateRowGroups,
      openBytes,
      openRequests,
      queryBytes: io.bytes - openBytes,
      queryRequests: io.requests - openRequests,
      queryMilliseconds,
      totalBytes: io.bytes,
      totalRequests: io.requests,
    };
  } finally {
    await handle.close();
  }
}

const result = {
  generatedAt: new Date().toISOString(),
  simulatedRttMs,
  repeats,
  columns,
  files: {},
};
for (const path of files) {
  const samples = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const resolution of resolutions) {
      for (const center of centers) {
        samples.push(await runOne(path, center, resolution, repeat));
      }
    }
  }
  const byResolution = Object.fromEntries(resolutions.map(resolution => {
    const subset = samples.filter(sample => sample.resolution === resolution);
    return [resolution, summarize(subset)];
  }));
  const first = samples[0];
  result.files[path] = {
    sizeBytes: (await stat(path)).size,
    openBytes: first.openBytes,
    openRequests: first.openRequests,
    byResolution,
    samples,
  };
  process.stderr.write(`[bench] ${path}\n`);
}
console.log(JSON.stringify(result, null, 2));
