# COGP JavaScript reader

Release 2.0.0 reads `geo.lod` and the optional [quantized rendering extension](../OVERVIEWS.md).
Legacy `cogp` and `coarse_to_fine` metadata are not used. Rendering resolutions
are in the primary geometry CRS units, including degrees for geographic data.

```ts
import { CogpReader, COGP_ROW_INDEX } from 'cogp';

const reader = await CogpReader.open(url);
const level = reader.selectLevel(0.01); // degrees for CRS84
const rows = await reader.readRows({
  maxLevel: level,
  bbox: [139, 35, 140, 36],
  columns: ['geometry'],
  includeRowIndex: true,
});
console.log(reader.geo); // includes lod.levels and optional rendering metadata
const properties = await reader.readRow(rows[0][COGP_ROW_INDEX], { columns: ['id'] });
```

`readRows` selects primary covering bboxes within a cumulative row-group prefix.
When overviews are declared, the requested geometry is decoded from the selected
LoD; primary WKB is excluded from rendering reads. Missing declared overview
values are errors. Without overviews, the reader uses the primary geometry.
Missing bbox statistics retain candidate groups; missing covering disables bbox
pruning. Coarse reads are partial feature selections, not complete analytical results.

`overviewDecoder` can consume `QuantizedOverviewGeometry` directly. The default
produces GeoJSON. `maxRows` caps rows after filtering; `signal` cancels requests.
`includeRowIndex` attaches a non-enumerable source-row identity for lazy property
reads. `fromAsyncBuffer` supports custom transports. HTTP requests use no-store,
with bounded in-memory caching and coalescing that avoids primary WKB ranges.

## Development

```sh
pnpm --filter cogp build
pnpm --filter cogp test
pnpm --filter cogp-demo build
pnpm --filter cogp-demo test
pnpm --filter cogp-demo dev
```

The demo targets geographic longitude/latitude data, maps its screen resolution
to degrees, renders MVT tiles, and fetches clicked feature properties lazily.
The metadata panel displays the file's GeoParquet metadata directly.
