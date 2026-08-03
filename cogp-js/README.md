# cogp-js

TypeScript reader for the [Cloud Optimized GeoParquet Profile
(COGP)](https://github.com/Kanahiro/cloud-optimized-geoparquet). It reads COGP
metadata and fetches only the Parquet ranges needed for a requested geographic
area and ground sample distance. Bbox reads use covering-column statistics to
prune row groups, then apply an exact per-feature bbox filter to the surviving
rows.

Remote reads coalesce nearby concurrent byte ranges by default. This reduces
HTTP request count while bounding extra transfer to a
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
