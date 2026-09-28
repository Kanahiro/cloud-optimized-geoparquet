# @cogp/maplibre

Use [Cloud Optimized GeoParquet](https://github.com/Kanahiro/cloud-optimized-geoparquet) as a MapLibre GL JS vector source. The adapter reads COGP in a worker and produces vector tiles in the browser.

```sh
npm install @cogp/maplibre maplibre-gl
```

## Add a source

Register the protocol once, then use `cogpUrl()` to create the tile template. The key `buildings` becomes the MapLibre `source-layer` name.

```ts
import * as maplibregl from 'maplibre-gl';
import { cogpUrl, registerCogpProtocol } from '@cogp/maplibre';

registerCogpProtocol(maplibregl);

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      city: {
        type: 'vector',
        tiles: [cogpUrl({
          buildings: { url: 'https://example.com/buildings.cogp.parquet' },
        })],
      },
    },
    layers: [{
      id: 'buildings', type: 'fill', source: 'city',
      'source-layer': 'buildings',
      paint: { 'fill-color': '#666' },
    }],
  },
});
```

## Select properties or combine files

Each key passed to `cogpUrl()` creates one MVT layer. Options belong to that layer:

```ts
const tiles = cogpUrl({
  buildings: {
    url: 'https://example.com/buildings.cogp.parquet',
    properties: { height: 'details.height', secondFloor: 'floors[1]' },
    maxRowsPerTile: 10_000,
  },
  roads: { url: 'https://example.com/roads.cogp.parquet' },
});
```

- Omit `properties` to read all ordinary attributes; pass `{}` for geometry only. A mapping selects columns and renames their MVT properties.
- A struct path fetches only the selected field. An indexed list path reads the whole list before selecting an element.
- Omit `maxRowsPerTile` for no row limit. A limit keeps the first matching rows in source order.

MVT property values are display strings, including numbers.

The source files need CORS and HTTP range support. Geometry coordinates must be longitude/latitude for Web Mercator tiles. Your bundler must support module workers via `new Worker(new URL(..., import.meta.url))`.

For optional metadata and diagnostics, `inspectCogp(url, signal?)` and `getCogpStats(url)` use the same reader cache as the tiles. See the [MapLibre demo](https://kanahiro.github.io/cloud-optimized-geoparquet/pages/maplibre-gl-js/) for a complete application.

## Development

```sh
pnpm --filter @cogp/maplibre test
```
