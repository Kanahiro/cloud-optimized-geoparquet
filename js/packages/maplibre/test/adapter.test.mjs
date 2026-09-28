import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { CogpReader } from '@cogp/reader';
import { cogpUrl, getCogpStats, inspectCogp, registerCogpProtocol } from '../dist/index.js';
import { parseTileUrl } from '../dist/url.js';
import { renderTile } from '../dist/tile.js';

const require = createRequire(import.meta.url);
const { VectorTile } = require('@mapbox/vector-tile');
const Pbf = require('pbf');

async function fixtureReader(name) {
  const bytes = await readFile(new URL(`../../../../test-data/${name}.parquet`, import.meta.url));
  return CogpReader.fromAsyncBuffer({
    byteLength: bytes.length,
    slice(start, end = bytes.length) {
      return bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end);
    },
  }, `fixture:${name}`);
}

test('cogpUrl keeps configuration in a versioned, serializable tile template', () => {
  const template = cogpUrl({
    roads: { url: 'https://example.com/roads.cogp.parquet?token=a%2Fb' },
    buildings: {
      url: 'https://example.com/buildings.cogp.parquet',
      properties: { height: 'struct.child.height', value: 'struct.array[1]' },
      maxRowsPerTile: 7,
    },
  });
  assert.match(template, /^cogp:\/\/tile\/v1\/[A-Za-z0-9_-]+\/\{z\}\/\{x\}\/\{y\}\.pbf$/);
  const config = parseTileUrl(template.replace('{z}/{x}/{y}', '2/1/3')).config;
  assert.deepEqual(config.layers.map(layer => layer.name), ['buildings', 'roads']);
  assert.equal(config.layers[1].url, 'https://example.com/roads.cogp.parquet?token=a%2Fb');
  assert.equal(config.layers[0].properties.value, 'struct.array[1]');
  assert.equal(parseTileUrl(cogpUrl({ parcels: { url: 'https://example.com/data.parquet' } }).replace('{z}/{x}/{y}', '0/0/0')).config.layers[0].name, 'parcels');
});

test('invalid source options and tile coordinates fail early', () => {
  assert.throws(() => cogpUrl({}), /at least one layer/);
  assert.throws(() => cogpUrl('https://example.com/data.parquet'), /name-to-layer object/);
  assert.throws(() => cogpUrl({ parcels: 'https://example.com/data.parquet' }), /object with a url/);
  assert.throws(() => cogpUrl({ parcels: { url: 'file:///tmp/data.parquet' } }), /HTTP\(S\)/);
  assert.throws(() => cogpUrl({ parcels: { url: 'https://' } }), /HTTP\(S\)/);
  assert.throws(() => cogpUrl({ parcels: { url: 'https://example.com/data.parquet', maxRowsPerTile: -1 } }), /maxRowsPerTile/);
  assert.throws(() => cogpUrl({ parcels: { url: 'https://example.com/data.parquet', properties: { x: '' } } }), /mapping/);
  const template = cogpUrl({ parcels: { url: 'https://example.com/data.parquet' } });
  assert.throws(() => parseTileUrl(template.replace('{z}/{x}/{y}', '1/2/0')), /coordinates/);
});

test('registration is explicit and idempotent for each MapLibre module', () => {
  const calls = [];
  const maplibre = { addProtocol: (...args) => calls.push(args) };
  registerCogpProtocol(maplibre);
  registerCogpProtocol(maplibre);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'cogp');
});

test('inspection, stats, and MVT requests share one worker', async () => {
  const OriginalWorker = globalThis.Worker;
  const messages = [];
  globalThis.Worker = class {
    listeners = new Map();
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    postMessage(request) {
      messages.push(request);
      if (request.type === 'cancel') return;
      queueMicrotask(() => this.listeners.get('message')({ data: {
        id: request.id,
        ok: true,
        ...(request.type === 'inspect'
          ? { info: { numRowGroups: 2, byteLength: 100, dataBbox: null, geo: {} } }
          : request.type === 'stats'
            ? { stats: { requests: 3, bytes: 75, tileMs: [4, 6] } }
            : { data: Uint8Array.of(1, 2, 3).buffer }),
      } }));
    }
    terminate() {}
  };
  try {
    let load;
    registerCogpProtocol({ addProtocol(_scheme, action) { load = action; } });
    const template = cogpUrl({ roads: { url: 'https://example.com/roads.parquet' } });
    const controller = new AbortController();
    assert.equal((await inspectCogp('https://example.com/roads.parquet', controller.signal)).numRowGroups, 2);
    const tile = await load({ type: 'arrayBuffer', url: template.replace('{z}/{x}/{y}', '0/0/0') }, controller);
    assert.deepEqual([...new Uint8Array(tile.data)], [1, 2, 3]);
    assert.equal((await getCogpStats('https://example.com/roads.parquet')).bytes, 75);
    assert.deepEqual(messages.map(message => message.type), ['inspect', 'tile', 'stats']);
  } finally {
    globalThis.Worker = OriginalWorker;
  }
});

test('multiple files become named MVT layers with projected properties', async () => {
  const [attributes, refinement] = await Promise.all([
    fixtureReader('attribute-encodings'), fixtureReader('refinement'),
  ]);
  const readers = new Map([
    ['https://example.com/attributes.parquet', attributes],
    ['https://example.com/refinement.parquet', refinement],
  ]);
  const config = parseTileUrl(cogpUrl({
    buildings: {
      url: 'https://example.com/attributes.parquet',
      properties: { label: 'nested.label', second: 'values[1]', id: 'id' },
      maxRowsPerTile: 5,
    },
    roads: { url: 'https://example.com/refinement.parquet', properties: {} },
  }).replace('{z}/{x}/{y}', '0/0/0')).config;
  const getReader = url => readers.get(url);
  const bytes = await renderTile(config, 0, 0, 0, getReader);
  const tile = new VectorTile(new Pbf(new Uint8Array(bytes)));
  assert.deepEqual(Object.keys(tile.layers).sort(), ['buildings', 'roads']);
  assert.ok(tile.layers.buildings.length > 0);
  assert.ok(tile.layers.buildings.length <= 5);
  const properties = tile.layers.buildings.feature(0).properties;
  assert.deepEqual(Object.keys(properties).sort(), ['id', 'label', 'second']);
  assert.equal(tile.layers.roads.length > 0, true);
  assert.deepEqual(tile.layers.roads.feature(0).properties, {});
});

test('omitted options read every attribute and leave row count unlimited', async () => {
  const reader = await fixtureReader('attribute-encodings');
  const config = parseTileUrl(cogpUrl({ parcels: { url: 'https://example.com/attributes.parquet' } }).replace('{z}/{x}/{y}', '0/0/0')).config;
  const bytes = await renderTile(config, 0, 0, 0, async () => reader);
  const tile = new VectorTile(new Pbf(new Uint8Array(bytes)));
  assert.ok(tile.layers.parcels.length > 5);
  assert.ok('name' in tile.layers.parcels.feature(0).properties);
  assert.ok('nested' in tile.layers.parcels.feature(0).properties);
});
