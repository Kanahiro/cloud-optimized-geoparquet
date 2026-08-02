# cogp-js

TypeScript reader for the [Cloud Optimized GeoParquet Profile
(COGP)](https://github.com/Kanahiro/cloud-optimized-geoparquet). It reads COGP
metadata and fetches only the Parquet ranges needed for a requested geographic
area and ground sample distance. Bbox reads always use covering-column
statistics at row-group granularity and can optionally use Page Index pruning,
then apply an exact per-feature bbox filter to the surviving rows. Page Index
use is disabled by default because its extra range requests are not always a
latency win; opt in per read with `usePageIndex: true`.

Remote reads coalesce nearby concurrent byte ranges by default. This reduces
HTTP request count after page-index pruning while bounding extra transfer to a
128 KiB gap and total fetched bytes to 1.25× the uniquely requested bytes. Tune
or disable it when opening:

```ts
await CogpReader.open(url, {
  rangeCoalescing: {
    maxGapBytes: 64 * 1024,
    maxOverfetchRatio: 1.25,
  },
});
await CogpReader.open(url, { rangeCoalescing: false });
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
