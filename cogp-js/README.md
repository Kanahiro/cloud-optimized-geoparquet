# cogp-js

TypeScript reader for the [Cloud Optimized GeoParquet Profile
(COGP)](https://github.com/Kanahiro/cloud-optimized-geoparquet). It reads COGP
metadata and fetches only the Parquet ranges needed for a requested geographic
area and ground sample distance. Bbox reads use covering-column statistics to
prune row groups, then apply an exact per-feature bbox filter to the surviving
rows.

Remote reads coalesce nearby concurrent byte ranges by default. Coalescing
bounds extra transfer to a 128 KiB gap and 1.25× the uniquely requested bytes.
Exact requested slices are retained in a 128 MiB least-recently-used cache, so
slightly overlapping viewport reads do not depend on HTTP `206 Partial
Content` cache behavior. Tune or disable either layer when opening:

```ts
await CogpReader.open(url, {
  rangeCoalescing: {
    maxGapBytes: 64 * 1024,
    maxOverfetchRatio: 1.25,
  },
  rangeCache: { maxBytes: 64 * 1024 * 1024 },
});
await CogpReader.open(url, { rangeCoalescing: false });
await CogpReader.open(url, { rangeCache: false });
```

Explicit HTTP caching is still useful across page loads and reader instances.
Use stable, versioned object URLs before assigning a long `max-age` or
`immutable`; an unversioned URL that is overwritten can otherwise serve stale
Parquet metadata and ranges.

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
`selectLevelByGsd`, `selectGeometryColumnByGsd`, and their associated
TypeScript types. `readRows({ targetGsd })` projects a single sufficiently
precise WKB column and returns its decoded value under the primary column name.
For Polygon-only data, this streaming path never projects the lossless primary
WKB column when overviews exist: requests finer than the available overviews
stay on the finest complete overview. A file with no overviews falls back to
the primary raw WKB column. Omit `targetGsd` when lossless primary geometry is
required regardless of available overviews.

For interactive maps, keep viewport projections narrow and fetch full
properties only for selected features. `rowIndexColumn` adds a stable source
row index to the lightweight result; `readRow` then reads chosen columns for
that one row:

```ts
const rows = await reader.readRows({
  bbox,
  targetGsd,
  columns: [reader.primaryGeometryColumn],
  rowIndexColumn: '__row',
});
const properties = await reader.readRow(rows[0].__row as number, {
  columns: ['name', 'class'],
});
```
