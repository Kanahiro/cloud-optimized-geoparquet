# Cloud Optimized GeoParquet Profile (COGP)

A GeoParquet profile for progressive map rendering and partial access over HTTP range requests or object storage.

## TL;DR

A COGP file is a valid [GeoParquet 1.1](https://geoparquet.org/) file whose row groups are physically ordered from coarse to fine rendering detail, with file-level metadata describing where each level ends.

COGP is **feature-level**: it reorders features across row groups; it does not simplify, aggregate, or duplicate them. Each source feature appears in exactly one row group, with its geometry preserved verbatim.

A COGP-aware reader can stream just the leading row groups needed for its target rendering resolution and stop. A reader that does not understand the profile can ignore the `geo.lod` metadata and read the file as ordinary GeoParquet 1.1.

## Design influences

COGP is informed by several existing cloud-optimized and progressive rendering patterns:

- Cloud Optimized GeoTIFF: remaining a valid GeoTIFF while adding cloud-friendly layout and overview structure;
- Cloud Optimized Point Cloud: remaining a valid LAZ file while adding thinning and multi-resolution level concepts;
- tippecanoe: design choice to avoid rendering every feature literally at low zoom levels.

COGP applies these ideas at the GeoParquet row group level. Unlike raster overviews or vector tile simplification pipelines, COGP keeps each feature geometry unchanged and places each source feature in exactly one level.

## Why

GeoParquet is well suited for analytics and cloud storage, but ordinary GeoParquet files are not laid out for progressive visual access. For map rendering, tile serving, and viewport-driven applications, readers often want to fetch a coarse overview first and only descend into finer detail when the display scale requires it.

COGP is a small, conservative layout convention that enables this without changing GeoParquet's data model.

## Benefits

- **Faster overview rendering, even for non-COGP-aware software.** Because coarse-detail features are physically placed at the front of the file, any GeoParquet 1.1 reader that streams row groups in order will see a usable overview almost immediately, without needing to understand the `geo.lod` metadata.
- **Efficient AoI-based spatial queries, even for non-COGP-aware software.** The layout preserves GeoParquet 1.1 semantics and row group statistics, so existing engines can still prune by bounding box and answer area-of-interest queries efficiently.
- **Minimal, resolution-targeted streaming for COGP-aware software.** A COGP-aware reader can consult the level metadata and fetch only the leading row groups required for its target geographic resolution, enabling fast progressive streaming with the smallest possible byte footprint.

### Example: loading OvertureMaps buildings on QGIS 4.0

#### ordinary GeoParquet (spatially sorted)

https://github.com/user-attachments/assets/10d0390c-95ab-45e5-8503-6cbdbb015c93

#### COGP

https://github.com/user-attachments/assets/fd15605a-7d66-41a3-884d-c735e3467708

### Example: streaming from Cloudflare R2 to browser [demo page](https://kanahiro.github.io/cloud-optimized-geoparquet/)

https://github.com/user-attachments/assets/7daf178e-28b0-4440-845d-ee8f74fa5062

## Sample data

- [pois.cogp.parquet](https://cogp-demo.spatialty.io/v1.0.0/pois.cogp.parquet) (OpenStreetMap)
- [segments.cogp.parquet](https://cogp-demo.spatialty.io/v1.0.0/segments.cogp.parquet) (OvertureMaps)
- [buildings.cogp.parquet](https://cogp-demo.spatialty.io/v1.0.0/buildings.cogp.parquet) (OvertureMaps)

## When COGP works well

COGP is particularly well suited to datasets of many small, well-distributed features — such as POIs or building footprints — where dropping later row groups still yields a meaningful overview.

Because COGP does not simplify geometries, datasets dominated by large, complex geometries (coastlines, rivers, road networks, administrative boundaries) have relatively larger per-feature payloads, so the Row Group size should be tuned to optimize progressive streaming. Other COGP benefits — GeoParquet 1.1 compatibility, fast overview rendering, and efficient AoI-based queries — still apply.

## Specification

See [`SPEC.md`](./SPEC.md) for the normative specification.

## Implementations

This repository is the source of truth for the specification and its reference
implementations:

- [`cogp-rs`](./cogp-rs): Rust producer, validator, CLI, and reader library.
- [`cogp-js`](./cogp-js): TypeScript reader and browser demo.

The implementations remain independently publishable. The repository root owns
shared dependency locks, CI, releases, and development commands so changes to the
profile can be tested against both implementations together.

## Writer implementation

[`SPEC.md`](./SPEC.md) defines the format contract. The following describes the
current [`cogp-rs` writer](./cogp-rs/src/convert.rs): these algorithms, defaults,
and tuning options are implementation choices, not additional format requirements.
See the [CLI reference](./cogp-rs/README.md#convert) for conversion options.

### Feature assignment to levels

The writer assigns each input row to one level before spatial sorting. Explicit
`--resolution` values use the primary geometry CRS units. By default, it derives
17 resolutions from Web Mercator zooms 0–16 using
`40,075,016.68557849 / (1024 × 2^zoom)` meters at the equator, then converts those
hints to CRS units. Geographic coordinates use an approximate 111,320 meters per
degree; this is an equatorial scale heuristic, without latitude correction.
Coordinates themselves are not reprojected or quantized.

- **Points / MultiPoints:** choose one remaining feature per bbox-center grid
  cell, with cell width `4 × resolution` by default. Points already assigned to
  coarser levels block their cells at the current resolution. Optional
  `--priority-column` ranks candidates, followed by bbox diagonal and a deterministic
  row-index hash as tie-breakers.
- **Lines / polygons:** assign each feature to the first level where its bbox
  diagonal reaches `4 × resolution` for both lines and polygons
  by default. Non-empty zero-extent geometries are eligible from the coarsest
  level. Lines and polygons do not compete for grid cells.
- **Remaining rows:** place all deferred rows, including null/empty geometries,
  in the finest level. No rows are discarded. Levels introducing no rows are
  omitted from the emitted metadata.

### Spatial sorting and Row Group construction

Within each level, the writer uses a recursive Sort-Tile-Recursive (STR) packing
variant. It finds the longer axis of the combined bbox, sorts feature bbox
centers along that axis, and splits at a multiple of the target Row Group row
count. Recursion stops when a partition fits in one Row Group. Sort directions
follow a snake traversal, with alternating starting corners between levels, to
keep consecutive groups spatially close. Geometry and attribute values are
preserved while row order changes.

`--row-group-size` defaults to **65,536 rows**. Each level is written in order,
and the writer flushes at every level boundary, so a Row Group never mixes
levels. The final group of a level may be smaller. The metadata records the
actual zero-based index of the last flushed Row Group for each level.

### Bbox covering, pages, and encoding

Existing `covering.bbox` metadata determines which columns the writer uses;
it trusts and preserves those paths and values. If covering is absent, it
computes bboxes from geometry and adds a collision-free column named `bbox`,
`bbox_`, etc. An existing column merely named `bbox` has no special meaning.

The writer always spatially packs page-sized intervals within each Row Group,
with `--page-row-count` defaulting to **2,048 rows**. It writes column-chunk
statistics, page statistics / ColumnIndexes for covering bbox leaves, and
OffsetIndexes for all leaves. Parquet byte limits may produce smaller pages;
indexes describe the actual output. Readers without Page Index support can
still read complete column chunks.

Compression is **ZSTD level 3**. Dictionary encoding is disabled for the primary
WKB geometry and covering bbox leaves. Other columns retain the Parquet writer's
default dictionary behavior.

All three visibility factors default to **4**, expressing a common four-resolution-
unit scale. Points use that scale as grid width; lines and polygons use it as a
bbox-diagonal threshold, so equal factors do not imply equal visual density.
Each factor remains independently configurable.

The published v1.0.0 samples were generated with 65,536-row groups, 2,048-row
pages, and point/line/polygon factors **4/4/4**. Their level metadata is stored
in `geo.lod.levels`.

## Development

Install JavaScript dependencies once from the repository root:

```sh
pnpm install --frozen-lockfile
```

Common checks also run from the root:

```sh
cargo test --workspace --all-features
pnpm typecheck
pnpm build
```

See each implementation's README for its public API and focused workflows.

## Roadmap

- [x] Producer implementation: a tool/library that converts existing GeoParquet 1.1 files into the COGP layout. 
- [x] Reader implementation: a client that interprets the `geo.lod` metadata and fetches only the leading row groups required for the target resolution via HTTP range requests.

A proof-of-concept exploring this layout exists at [Kanahiro/yosegi](https://github.com/Kanahiro/yosegi).

## Status and feedback

COGP v1.0.0 is the current specification. Feedback, issues, and discussion are welcome via GitHub Issues.

COGP v1.0.0 uses `geo.lod` with CRS-unit `resolution`.
Previously published v0.1.1 sample files use the retired `cogp` / `gsd` metadata
and must be reconverted before using the current readers. The extension has no
independent version field; package versions do not identify its wire format.

Readers require `geo.lod.levels`; the previous `geo.coarse_to_fine` key is not supported. The published `/v1.0.0/` samples have been regenerated with `geo.lod`.

## License

The contents of [`SPEC.md`](./SPEC.md) are licensed under [Creative Commons
Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
See [`LICENSE-SPEC`](./LICENSE-SPEC) for details.

The source code in this repository is licensed under the [MIT License](./LICENSE).
