# cogp-js

TypeScript reader for the [Cloud Optimized GeoParquet Profile
(COGP)](https://github.com/Kanahiro/cloud-optimized-geoparquet). It reads COGP
metadata and fetches only the Parquet ranges needed for a requested geographic
area and rendering resolution in primary geometry CRS units. Bbox reads use covering-column statistics to
prune row groups, then lazily fetch Parquet PageIndexes to prune pages inside
the surviving groups. Files without PageIndexes fall back safely to Row Group
reads. Bbox predicates are used only for statistics-based pruning: returned rows
are candidates and may lie outside the requested bbox. Callers apply geometry
filtering or clipping when exact spatial results are needed. Covering data
columns are not fetched implicitly for bbox queries; explicit `columns`
projections can still request them.

Remote reads coalesce nearby concurrent byte ranges by default. This reduces
HTTP request count with three absolute bounds: a 32 KiB maximum gap, 128 KiB of
cumulative extra bytes per merged request, and a 2 MiB maximum merged request.
Unrequested covering data chunks also act as barriers to gap merging, so
coalescing does not reintroduce bbox pages skipped by projection.
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

The public entry point exports `CogpReader` and its associated configuration and
metadata types. Metadata parsing, level-selection helpers, and cache construction
remain internal. Read levels through `reader.geo.lod.levels`.
Files must provide `geo.lod.levels`; there is no fallback to `geo.coarse_to_fine`.
`CogpReader.fromAsyncBuffer(file)` accepts a custom byte source without a URL.

```ts
const reader = await CogpReader.open(url);
const rows = await reader.readRows({
  maxLevel: reader.selectLevel(targetResolution), // primary geometry CRS units
  bbox: [xmin, ymin, xmax, ymax],
  columns: [reader.primaryGeometryColumn],
  maxRows: 10_000,
  maxGeometryBytes: 8 * 1024 * 1024,
});
```

`maxGeometryBytes` limits cumulative raw WKB bytes across returned geometry
columns, not bytes per row or HTTP transfer size. Both caps count returned
candidates, including spatial false positives; a finite cap can omit later
candidates that intersect the bbox. A row exceeding the remaining
budget stops the read before decoding that row. Both output caps are optional.

Readers validate all level boundaries against the footer before selecting a prefix.
Missing or invalid extension metadata is rejected; legacy `cogp` metadata must be
regenerated with the current converter. Bbox covering and PageIndexes are optional.
Without covering or usable statistics, bbox queries conservatively retain
candidates. With a bbox and no explicit projection, covering top-level columns
are omitted; other attributes (even one named `bbox`) remain available. Reads
without a bbox retain the default all-column projection.
The demo expects longitude/latitude coordinates and passes degrees per pixel.
Display prefixes are partial selections, not complete analytical query results.
