# @cogp/reader

Read [Cloud Optimized GeoParquet](https://github.com/Kanahiro/cloud-optimized-geoparquet) in a browser using HTTP range requests. Files need `geo.lod` metadata from the [COGP specification](https://github.com/Kanahiro/cloud-optimized-geoparquet/blob/main/SPEC.md).

```sh
npm install @cogp/reader
```

## Read a viewport

```ts
import { CogpReader, toGeoJSON } from '@cogp/reader';

const reader = await CogpReader.open('https://example.com/data.cogp.parquet');
const batch = await reader.read({
  bbox: [139.4, 35.4, 139.6, 35.6],
  maxLevel: reader.selectLevel(0.001), // CRS units per screen pixel
  columns: [reader.primaryGeometryColumn, 'name'],
  useOverview: true,
});

console.log(batch.length, batch.columns.name);
const features = toGeoJSON(batch);
```

`read()` returns a columnar batch. `batch.rowIndex` identifies each source row; `batch.columns` contains the requested attributes, and `batch.geometry` contains the selected geometry. `toGeoJSON()` creates a FeatureCollection when row objects are useful.

## Common options

| Option | Behavior |
| --- | --- |
| `bbox` | Keep rows whose bounding boxes intersect `[west, south, east, north]`. This is a bounding-box filter, not an exact geometry test. |
| `maxLevel` | Include levels through this index. Omit it to read all levels. |
| `columns` | Read only the named columns. Omit it to read the primary geometry and all ordinary attributes. |
| `useOverview` | Use a supported rendering overview. Falls back to primary geometry when the file has no overview; rejects an unsupported overview encoding. |
| `maxRows` | Keep the first matching rows in source order. A limit can omit later spatial matches. |
| `signal` | Cancel a read with an `AbortSignal`. |

Nested fields use paths such as `building.details.height`. The reader fetches only that struct field. A map key such as `tags.name` is selected after reading the map's key and value columns. A list path such as `building.floors[1]` selects one element **after reading the whole list**. Results use the requested path as their key in `batch.columns`.

For a single row's attributes, call `reader.readRow(batch.rowIndex[0], { columns: ['id'] })`.

## Other output formats

```ts
import { toGeoArrow, toMvt } from '@cogp/reader';

const mvt = toMvt(batch, { z: 12, x: 3635, y: 1615 });
const arrow = toGeoArrow(batch, { crs: 'OGC:CRS84' });
```

`toMvt()` encodes a Mapbox Vector Tile and expects longitude/latitude geometry. Use a tile-sized `bbox` when reading for a tile. `toGeoArrow()` writes an Arrow IPC stream; its geometry must contain one geometry family (points, lines, or polygons).

The browser host must allow CORS and HTTP range requests.

A reader caches parsed page indexes (64 MiB) and compressed ranges (32 MiB) by default. To change either budget, pass `pageIndexCache` or `rangeCache` to `CogpReader.open()`. Create a new reader if the file changes at the same URL.

See the [browser demo](https://kanahiro.github.io/cloud-optimized-geoparquet/) for MapLibre GL JS and deck.gl usage, or use [@cogp/maplibre](https://www.npmjs.com/package/@cogp/maplibre) to connect COGP directly to a MapLibre vector source.

## Development

```sh
pnpm --filter @cogp/reader test
```
