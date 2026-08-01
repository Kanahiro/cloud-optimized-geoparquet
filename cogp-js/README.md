# cogp-js

TypeScript reader for the [Cloud Optimized GeoParquet Profile
(COGP)](https://github.com/Kanahiro/cloud-optimized-geoparquet). It reads COGP
metadata and fetches only the Parquet ranges needed for a requested geographic
area and ground sample distance. Bbox reads use covering-column statistics at
row-group and page-index granularity, then apply an exact per-feature bbox
filter to the surviving rows.

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
