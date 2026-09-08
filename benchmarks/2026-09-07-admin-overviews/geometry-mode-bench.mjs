import { open, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { parquetReadObjects } from '../../cogp-js/node_modules/hyparquet/src/index.js';
import { compressors } from '../../cogp-js/node_modules/hyparquet-compressors/src/index.js';
import { CogpReader, rangeCachedAsyncBuffer } from '../../cogp-js/dist/index.js';
import { coalescingAsyncBuffer } from '../../cogp-js/dist/coalescing-buffer.js';

const files = process.argv.slice(2);
if (!files.length) throw new Error('pass parquet files');

const simulatedRttMs = Number(process.env.RTT_MS ?? 0);
const centers = [
  ['tokyo', 139.75, 35.68], ['osaka', 135.50, 34.70],
  ['nagoya', 136.90, 35.18], ['sapporo', 141.35, 43.06],
  ['fukuoka', 130.40, 33.59], ['sendai', 140.87, 38.27],
  ['hiroshima', 132.46, 34.39], ['naha', 127.68, 26.21],
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
    queryBytes: metric('queryBytes'),
    queryRequests: metric('queryRequests'),
    queryMilliseconds: metric('queryMilliseconds'),
  };
}

function bboxFor(center, resolution) {
  const [, x, y] = center;
  const widthMeters = resolution * 512;
  const heightMeters = resolution * 512;
  const halfWidth = widthMeters / (2 * 111_320 * Math.cos(y * Math.PI / 180));
  const halfHeight = heightMeters / (2 * 110_540);
  return {
    minX: x - halfWidth,
    minY: y - halfHeight,
    maxX: x + halfWidth,
    maxY: y + halfHeight,
  };
}

function bboxFilter(paths, bbox) {
  return {
    $and: [
      { [paths.xmin.join('.')]: { $lte: bbox.maxX } },
      { [paths.ymin.join('.')]: { $lte: bbox.maxY } },
      { [paths.xmax.join('.')]: { $gte: bbox.minX } },
      { [paths.ymax.join('.')]: { $gte: bbox.minY } },
    ],
  };
}

async function readPrimaryWkb(reader, maxLevel, bbox) {
  const rowGroups = reader.candidateRowGroups(maxLevel, bbox);
  const rows = [];
  for (const run of reader.decodeBatches(rowGroups)) {
    const startRg = run[0];
    const endRg = run[run.length - 1];
    const rowStart = reader.rowOffsets[startRg];
    const rowEnd = rowStart + reader.sumRowsInRange(startRg, endRg);
    rows.push(...await parquetReadObjects({
      file: reader.file,
      metadata: reader.metadata,
      rowStart,
      rowEnd,
      columns: ['fid', reader.primaryGeometryColumn, reader.bboxPaths.xmin[0]],
      filter: bboxFilter(reader.bboxPaths, bbox),
      usePageIndex: true,
      compressors,
    }));
  }
  return rows;
}

async function runOne(path, center, resolution, mode) {
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
    const file = rangeCachedAsyncBuffer(coalescingAsyncBuffer(source), {
      maxBytes: 64 * 1024 * 1024,
    });
    const reader = await CogpReader.fromAsyncBuffer(file, path);
    const openBytes = io.bytes;
    const openRequests = io.requests;
    const level = reader.selectLevel(resolution);
    const bbox = bboxFor(center, resolution);
    const start = performance.now();
    const rows = mode === 'overview'
      ? await reader.readRows({ bbox, maxLevel: level, columns: ['fid', 'geom'] })
      : await readPrimaryWkb(reader, level, bbox);
    const queryMilliseconds = performance.now() - start;
    return {
      center: center[0],
      resolution,
      level,
      lod: reader.levels[level].lod,
      mode,
      rows: rows.length,
      openBytes,
      openRequests,
      queryBytes: io.bytes - openBytes,
      queryRequests: io.requests - openRequests,
      queryMilliseconds,
    };
  } finally {
    await handle.close();
  }
}

const result = { generatedAt: new Date().toISOString(), simulatedRttMs, files: {} };
for (const path of files) {
  const modes = {};
  for (const mode of ['overview', 'wkb']) {
    const samples = [];
    for (const resolution of resolutions) {
      for (const center of centers) {
        samples.push(await runOne(path, center, resolution, mode));
      }
    }
    modes[mode] = {
      byResolution: Object.fromEntries(resolutions.map(resolution => [
        resolution,
        summarize(samples.filter(sample => sample.resolution === resolution)),
      ])),
      samples,
    };
  }
  result.files[path] = { sizeBytes: (await stat(path)).size, modes };
  process.stderr.write(`[bench] ${path}\n`);
}

console.log(JSON.stringify(result, null, 2));
