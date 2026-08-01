# cogp-js

TypeScript reader for the [Cloud Optimized GeoParquet Profile
(COGP)](https://github.com/Kanahiro/cloud-optimized-geoparquet). It reads COGP
metadata and fetches only the Parquet ranges needed for a requested geographic
area and ground sample distance.

## Development

Run commands from the repository root so the shared lockfile is used:

```sh
npm ci
npm run typecheck --workspace cogp
npm run build --workspace cogp
```

Build the browser demo with:

```sh
npm run build --workspace cogp-demo
```

The public entry point exports `CogpReader`, metadata parsing helpers,
`selectLevelByGsd`, and their associated TypeScript types.
