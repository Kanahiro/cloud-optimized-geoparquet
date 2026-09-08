# cogp-js

TypeScript reader for the [Cloud Optimized GeoParquet Profile
(COGP)](https://github.com/Kanahiro/cloud-optimized-geoparquet). It reads COGP
metadata and fetches only the Parquet ranges needed for a requested geographic
area and ground resolution. Bbox reads use covering-column statistics to prune
row groups and, when present, PageIndex metadata to prune pages inside surviving
row groups. They then apply an exact per-feature bbox filter to the surviving
rows; files without page indexes fall back safely to row-group pruning.
For Line and Polygon files, rendering geometry is decoded from the selected
integer XY child of the `overviews` struct and the browser projection excludes
WKB. Point files have no overviews and use hyparquet's primary-WKB decoding.

Remote reads bypass the browser HTTP cache and use a per-reader, in-memory
range cache instead. The cache shares duplicate in-flight reads, retains up to
64 MiB with LRU eviction, and is discarded with the `CogpReader`. Concurrent
nearby ranges are also coalesced, reducing request count while bounding extra
transfer to a 128 KiB gap and 1.25× the uniquely requested bytes. Every WKB
column chunk in an overview-backed file is installed as a hard range barrier:
selected overview requests cannot read it directly or absorb it as coalescing
overfetch. Point files leave primary WKB readable. Tune or disable either
behavior when opening:

```ts
await CogpReader.open(url, {
  rangeCoalescing: {
    maxGapBytes: 64 * 1024,
    maxOverfetchRatio: 1.25,
  },
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

Page pruning trades additional, small range requests for lower transferred
bytes. `rangeCoalescing` controls that tradeoff; increasing
`maxOverfetchRatio` generally reduces request count by accepting more bytes.

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
