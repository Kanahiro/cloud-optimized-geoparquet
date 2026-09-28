# @cogp/maplibre

MapLibre GL JS vector source adapter for Cloud Optimized GeoParquet (COGP).

```sh
npm install @cogp/maplibre @cogp/reader maplibre-gl
```

Register the protocol once, then pass the tile URL template returned by `cogpUrl`
to a MapLibre vector source. `cogpUrl` includes the layer configuration in the URL,
so the source can be recreated without carrying a protocol instance.

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
          buildings: {
            url: 'https://example.com/buildings.cogp.parquet',
            properties: {
              height: 'properties.dimensions.height',
              secondFloor: 'properties.floors[1]',
            },
            maxRowsPerTile: 10_000,
          },
          roads: { url: 'https://example.com/roads.cogp.parquet' },
        })],
        minzoom: 0,
        maxzoom: 24,
      },
    },
    layers: [
      { id: 'buildings', type: 'fill', source: 'city', 'source-layer': 'buildings', paint: { 'fill-color': '#666' } },
      { id: 'roads', type: 'line', source: 'city', 'source-layer': 'roads', paint: { 'line-color': '#333' } },
    ],
  },
});
```

Each named entry produces one MVT `source-layer`. For a single file, use a
single named entry, for example
`cogpUrl({ parcels: { url: 'https://example.com/data.cogp.parquet' } })`, and set
`source-layer` to `parcels`.

For map controls or diagnostics, `inspectCogp(url, signal?)` returns the file's
metadata, row-group count, byte length, and bounds. `getCogpStats(url)` returns
cumulative Range request counts and bytes plus recent tile read and encode
times. Both use the same worker and reader cache as tile requests.

Options are optional. With no `properties` mapping, all ordinary attributes
are read. An empty mapping `{}` reads geometry only. A mapping renames and
selects attributes; dotted struct fields fetch only their selected Parquet
leaves. Indexed list paths read the whole list and then select an element;
out-of-range indexes yield an empty MVT property value. With no
`maxRowsPerTile`, rows are unlimited. A limit keeps the first matching rows in
COGP source order, which can omit later spatial matches.

The adapter chooses a COGP LoD from tile zoom and latitude, uses its supported
geometry overview when available, and encodes a buffered MVT tile. MVT
properties are display strings, including numbers, booleans and nested values.
Source files must be reachable by the browser with CORS and HTTP range requests.
The adapter assumes longitude/latitude geometry coordinates (CRS84) for Web
Mercator tiles. It runs COGP reading and MVT encoding in a dedicated module
worker; your bundler must support `new Worker(new URL(..., import.meta.url))`.

## Development

```sh
pnpm --filter @cogp/maplibre test
```
