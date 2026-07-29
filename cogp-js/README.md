# cogp-js

TypeScript reader for the [Cloud Optimized GeoParquet Profile](../SPEC.md).

It reads COGP metadata and Parquet row-group statistics, selects the row-group prefix for
a target ground resolution, and resolves an exact or nearest-finer rendering LOD when one
is available.

[Open the browser demo](https://kanahiro.github.io/cloud-optimized-geoparquet/).

## Development

```sh
npm ci
npm test
```

Build the browser demo:

```sh
cd demo
npm ci
npm run build
```

Generated `dist/` directories, `node_modules/`, and local Parquet files are not tracked.
