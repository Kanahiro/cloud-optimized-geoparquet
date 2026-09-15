# cogp-js

TypeScript reader for the [Cloud Optimized GeoParquet Profile
(COGP)](https://github.com/Kanahiro/cloud-optimized-geoparquet). It reads COGP
metadata for draft 0.2 (including patch versions) and fetches only the Parquet ranges needed for a requested geographic
area and ground resolution. Bbox reads use covering-column statistics to prune
row groups and, when present, PageIndex metadata to prune pages inside surviving
row groups. They then apply an exact per-feature bbox filter to the surviving
rows; files without page indexes fall back safely to row-group pruning.
When a file declares `overviews`, rendering geometry is decoded from its
selected integer XY child and the browser projection excludes WKB. Spatial
filtering always uses primary geometry bboxes, so changing LoD
on the same prefix does not change the selected feature IDs. Consecutive
levels may share a row-group boundary, and several levels may reference one
LoD. A zoom that changes LoD fetches its columns for existing rows as needed;
unchanged byte ranges can be reused from cache. Unknown drafts are rejected.
Files without overviews use hyparquet's primary-WKB decoding. Point files must
use this path; Line and Polygon files may use it.

Remote reads bypass the browser HTTP cache and use a per-reader, in-memory
range cache instead. The cache shares duplicate in-flight reads, retains up to
64 MiB with LRU eviction, and is discarded with the `CogpReader`. Concurrent
nearby ranges are also coalesced, reducing request count while bounding extra
transfer with a single, internal 32 KiB cumulative overfetch budget. Every WKB
column chunk in an overview-backed file is installed as a hard range barrier:
selected overview requests cannot read it directly or absorb it as coalescing
overfetch. Point files leave primary WKB readable. Coalescing can be disabled,
and the range-cache capacity can be tuned when opening:

```ts
await CogpReader.open(url, {
  rangeCache: { maxBytes: 128 * 1024 * 1024 },
});
await CogpReader.open(url, { rangeCoalescing: false });
await CogpReader.open(url, { rangeCache: false });
```

Applications may replace individual Parquet codecs without forking the
reader. The demo uses this hook to initialize a WebAssembly Zstd decoder once
inside its worker:

```ts
const zstd = await Zstd.load();
const reader = await CogpReader.open(url, {
  compressors: { ZSTD: (input) => zstd.decompress(input) },
});
```

Both opening and row reads accept an `AbortSignal`. Cancellation propagates
through coalesced reads and the shared range cache to the underlying HTTP
request; aborting one consumer does not cancel a range still used by another:

```ts
const controller = new AbortController();
const rows = reader.readRows({ bbox, signal: controller.signal });
controller.abort();
await rows; // rejects with AbortError
```

Page pruning trades additional, small range requests for lower transferred
bytes. Range coalescing uses a fixed policy so applications do not need to
tune transport details for each dataset.

## Development

Run commands from the repository root so the shared lockfile is used:

```sh
pnpm install --frozen-lockfile
pnpm --filter cogp typecheck
pnpm --filter cogp build
```

Build the browser demo with:

```sh
pnpm --filter cogp-demo build
```

The public entry point exports `CogpReader`, overview decoding and metadata
helpers, `selectLevelByResolution`, and their associated TypeScript types.
`selectLevelByGsd` remains as a deprecated compatibility alias.
