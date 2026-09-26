# COGP JavaScript reader

Implements spec `spec-v2.0.0`. Reads `geo.lod`, which a file must declare to be opened, and the optional
[quantized rendering geometries](https://github.com/Kanahiro/cloud-optimized-geoparquet/blob/spec-v2.0.0/SPEC.md#geometry-representation). Rendering
resolutions are in the primary geometry CRS units, including degrees for geographic data.

```ts
import { CogpReader, toGeoJSON, toMvt } from 'cogp';

const reader = await CogpReader.open(url);
const level = reader.selectLevel(0.01); // degrees for CRS84
const batch = await reader.read({
  maxLevel: level,
  bbox: [139, 35, 140, 36],
  columns: ['geometry', 'name'],
  useOverview: true, // quantized overview if declared, otherwise primary WKB
});
console.log(reader.geo); // includes lod.levels and optional rendering metadata
batch.length; batch.rowIndex; batch.columns.name; // aligned per-row arrays
const geojson = toGeoJSON(batch); // FeatureCollection of every row
const tile = toMvt(batch, { z: 10, x: 909, y: 403 });
const detail = await reader.readRow(batch.rowIndex[0]!, { columns: ['id'] }); // a one-row batch
```

`read()` returns a columnar `CogpBatch` and creates no per-row objects: `rowIndex`
holds each result row's source row, `columns` holds the requested attributes as
decoded by hyparquet (typed arrays where the Parquet type allows), and `geometry`
holds every row's geometry in one `GeometryColumn`. That column uses the GeoArrow
MultiPolygon layout for all geometry types: `geometryOffsets`, `polygonOffsets`
and `ringOffsets` (each with a leading 0) index flat `x`/`y` arrays, `types` holds
the per-row type (0 for null), and coordinates are `offset + scale * [x, y]`.
With `useOverview: true` and a supported overview, `x`/`y` are the selected level's
quantized `Int32Array`s; otherwise primary WKB is parsed into `Float64Array`s with
scale `[1, 1]` and offset `[0, 0]` (Z is kept as `z`, M is dropped,
GeometryCollection is rejected). `geometryColumnFromWkb` exposes the same parsing
for other WKB, and other WKB columns are returned as bytes. Convert explicitly
with `toGeoJSON(batch)`, which returns a FeatureCollection of every row with
`rowIndex` as feature IDs (null geometries stay as `geometry: null`, property
values as decoded), or encode a tile with `toMvt(batch, { z, x, y, layer, signal })`.
Both accept any `{ geometry, rowIndex?, columns? }`, so other IDs or a
`geometryColumnFromWkb` result can be passed as well. `toMvt` reads
the columns in place, assumes longitude/latitude input, projects to Web Mercator,
clips to a 64-unit buffer around a 4096 extent (`MVT_BUFFER`, `MVT_EXTENT`),
skips null or off-tile rows and writes properties as display strings.

With `bbox`, `read` prunes row groups and pages within a cumulative prefix by
primary covering statistics, then reads the (small) covering values of the
remaining pages and keeps only rows whose covering intersects the bbox.
Geometry and attribute pages are fetched for those rows alone: on tile-sized
bboxes this cut transfer 2.5–3.5x at z14 and above compared with statistics
alone, and removed over 99% of returned false positives, at the cost of one
dependent covering read. This is bbox intersection, not exact geometry
intersection; rows with missing or invalid bounds are kept. Missing bbox
statistics retain candidate groups, and missing covering disables bbox pruning.
The default projection is every attribute plus the primary geometry; other
geometry columns, the overview column and covering are only read when named.
With `useOverview: true` and `quantized_geoarrow` overviews, the requested geometry
comes from the selected LoD in the column named by `geo.lod.overviews.column`, and
primary WKB is excluded from the read. The overview column's physical schema is
validated when the reader opens. Missing declared overview values are errors.
Files that declare another encoding still open and keep level selection, but
`hasOverviews` is `false` and `read({ useOverview: true })` throws; read them
without `useOverview` to get primary WKB. Without overviews, `useOverview` falls
back to primary WKB. `readRow` always reads the requested source columns,
including primary WKB.
Coarse reads are partial feature selections, not complete analytical results.

Readers never build rows or decode geometry implicitly, and covering refinement
always applies to bbox reads. Every run is planned concurrently (Page Indexes and covering values), which gives
each run's selected rows before any geometry or attribute I/O. `maxRows` then keeps
the first rows in source order, coarse levels first, so a finite cap can omit later
matches and is not a spatially uniform sample; only the pages holding the kept rows
are fetched, and all needed runs are fetched concurrently. Results are in source
order; peak memory grows with the selected data. `signal` cancels requests.

`rowIndex` identifies source rows for lazy property reads. `fromAsyncBuffer` supports custom transports. HTTP requests use no-store,
with bounded in-memory caching. Concurrent ranges are merged only when they
overlap or touch; gaps are never fetched just to combine requests. Overview reads reject any
request intersecting primary WKB chunks, so WKB cannot be fetched by accident.

## Development

```sh
pnpm --filter cogp build
pnpm --filter cogp test
pnpm --filter cogp-demo build
pnpm --filter cogp-demo dev
```

The demo targets geographic longitude/latitude data, maps its screen resolution
to degrees, renders MVT tiles with popup attributes, and displays clicked feature properties
without additional requests. Attribute reads share the tile bbox/Page Index
pruning and Page Index cache. Prefetching attributes can increase initial tile
transfer compared with geometry-only rendering; files without page indexes may
require full column chunks. Popup values are stored as display strings in MVT.
The metadata panel displays the file's GeoParquet metadata directly.

**Fetch attributes** is off by default, so tiles carry geometry only. Turning it
on adds attribute columns to tile reads and shows them in a popup on click;
switching reloads the map tiles while preserving the current view. The reader and
its caches are retained; reload the dataset with **Load** for a fresh reader.

The statistics panel shows the level selected at the map center (with its nominal
resolution), the number of distinct features rendered in the view, the bytes and
Range requests sent to the COGP file since it was opened (and their share of the
file), and the median and 90th-percentile time to read and encode recent tiles.
On narrow screens the panel collapses once a dataset loads.

Each reader uses a **64 MiB parsed Page Index cache by default**. Configure it with
`CogpReader.open(url, { pageIndexCache: { maxBytes: 64 * 1024 * 1024 } })`, or disable
retention with `{ pageIndexCache: false }`. The same options apply to `fromAsyncBuffer`.
ColumnIndex and OffsetIndex results are shared across tiles, projections and LoDs.
Concurrent requests share index fetching and parsing; cancelling one query does not
cancel an index still needed by another. Failed loads are retried on the next request.
A least-recently-used policy limits estimated retained parsed-index memory, not peak heap.

Decoded geometry and attribute rows are not retained. Each query decodes the data pages
it needs; the demo's completed MVT tiles retain their own geometry and attributes.

A separate **32 MiB compressed byte-range cache** reuses exact or contained ranges
across queries. Configure `rangeCache: { maxBytes: 32 * 1024 * 1024 }`, or disable
it with `rangeCache: false` (also supported by `fromAsyncBuffer`). This LRU budget
bounds retained bytes, excluding pending reads and decoder copies; it is additional
to the parsed-index budget. Concurrent identical reads share a fetch, with independent
cancellation. Failed or cancelled fetches are not retained. Data must remain immutable
for the reader's lifetime; create a new reader after changing a file.
Concurrent adjacent/overlapping Range requests can still be coalesced.

Hyparquet is bundled under [vendor/hyparquet](vendor/hyparquet/README.md), with
its license and upstream commit recorded. The package requires no Git dependency
or install-time compilation. This snapshot supplies the page planning interfaces
and INT32 decoding optimization used by the reader; upgrade the source and types
together and run the reader and package smoke tests.
