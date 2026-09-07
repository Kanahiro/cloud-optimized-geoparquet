# cogp-js

TypeScript reader for the [Cloud Optimized GeoParquet Profile
(COGP)](https://github.com/Kanahiro/cloud-optimized-geoparquet). It reads COGP
metadata and fetches only the Parquet ranges needed for a requested geographic
area and ground sample distance. Bbox reads use covering-column statistics to
prune row groups, then lazily fetch Parquet PageIndexes to prune pages inside
the surviving groups. Files without PageIndexes fall back safely to Row Group
reads. An exact per-feature bbox filter is applied to every surviving row.

Remote reads coalesce nearby concurrent byte ranges by default. This reduces
HTTP request count with three absolute bounds: a 32 KiB maximum gap, 128 KiB of
cumulative extra bytes per merged request, and a 2 MiB maximum merged request.
Absolute byte budgets behave consistently for both tiny PageIndex reads and
large data pages. PageIndexes are prefetched in bounded 16-RowGroup planning
windows. Page-pruned bbox decode batches run with concurrency 4 so adjacent
RowGroups do not serialize their HTTP requests; unfiltered reads remain serial
to bound memory. Tune or disable coalescing when opening:

```ts
await CogpReader.open(url, {
  rangeCoalescing: {
    maxGapBytes: 64 * 1024,
    maxExtraBytes: 256 * 1024,
    maxRequestBytes: 2 * 1024 * 1024,
  },
});
await CogpReader.open(url, { rangeCoalescing: false });
```

`CogpReader.open()` forces Fetch's cache mode to `no-store`, including footer
and byte-range requests. Other standard Fetch options can be supplied through
`requestInit`; the cache mode cannot be overridden.

Each reader keeps a containment-aware LRU of successful compressed ranges in
memory. The default limit is 64 MiB; duplicate in-flight reads share one
request, failed reads are retryable, and a cached larger range can satisfy a
smaller slice. Configure or disable it when opening:

```ts
await CogpReader.open(url, { rangeCache: { maxBytes: 32 * 1024 * 1024 } });
await CogpReader.open(url, { rangeCache: false });
```

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

The public entry point exports `CogpReader`, metadata parsing helpers,
`selectLevelByGsd`, and their associated TypeScript types.
