# Cloud Optimized GeoParquet (COGP)

A GeoParquet extension for progressive map rendering and partial access over HTTP range requests or object storage.

Created by [Kanahiro Iguchi](https://github.com/Kanahiro).

## TL;DR

A COGP file is a valid [GeoParquet](https://geoparquet.org/) file whose row groups are arranged in coarse-to-fine detail levels. File-level `geo.lod` metadata records the cumulative row-group prefix available at each level. That metadata is optional in the [LoD extension](./SPEC.md), but required for a file to be treated as COGP.

The producer assigns each input row to one level, but readers select **whole row-group prefixes**, not individual features. Every input row appears once, and its primary geometry and source attributes are preserved. Optional rendering overviews can contain simplified geometries in a separate column.

A COGP-aware reader can select the row-group prefix and, when available, the geometry overview for its target rendering resolution. A reader that does not understand the profile can ignore `geo.lod` and read the complete file as ordinary GeoParquet, but cannot use the metadata to select a coarse level.

## Design influences

COGP is informed by several existing cloud-optimized and progressive rendering patterns:

- Cloud Optimized GeoTIFF: remaining a valid GeoTIFF while adding cloud-friendly layout and overview structure;
- Cloud Optimized Point Cloud: remaining a valid LAZ file while adding thinning and multi-resolution level concepts;
- tippecanoe: design choice to avoid rendering every feature literally at low zoom levels.

COGP applies these ideas at the GeoParquet row-group level. Its primary geometries remain unchanged; optional rendering overviews can provide simplified geometries without replacing them. Each input row belongs to one level.

## Why

GeoParquet is well suited for analytics and cloud storage, but ordinary GeoParquet files are not laid out for progressive visual access. For map rendering, tile serving, and viewport-driven applications, readers often want to fetch a coarse overview first and only descend into finer detail when the display scale requires it.

## Benefits

- **Progressive rendering for COGP-aware software.** A reader can use `geo.lod` to select a cumulative row-group prefix for its target resolution, then add later groups as finer detail is needed. Optional geometry overviews can reduce the cost of rendering large lines and polygons.
- **Ordinary GeoParquet compatibility.** Readers that ignore `geo.lod` can read every row and its unchanged primary geometry. A reader that happens to process row groups in order and render incrementally may display coarse features first, but that behavior depends on the reader and does not provide level selection.
- **Spatial pruning when supported.** The file can retain GeoParquet bounding-box statistics and page indexes for area-of-interest queries, including in readers unaware of COGP. Query efficiency depends on the data, packing, and reader; ordering by detail can be less effective than a global spatial sort for some full-resolution queries.

### Example: loading OvertureMaps buildings on QGIS 4.0

#### ordinary GeoParquet (spatially sorted)

https://github.com/user-attachments/assets/10d0390c-95ab-45e5-8503-6cbdbb015c93

#### COGP

https://github.com/user-attachments/assets/fd15605a-7d66-41a3-884d-c735e3467708

### Example: streaming from Cloudflare R2 to browser [demo page](https://kanahiro.github.io/cloud-optimized-geoparquet/)

https://github.com/user-attachments/assets/7daf178e-28b0-4440-845d-ee8f74fa5062

### Example: render administrative polygon with overviews

https://github.com/user-attachments/assets/0b3e666a-5663-4f10-97f6-887442242d14

## Sample data

- [pois.cogp.parquet](https://cogp-demo.spatialty.io/v2.0.0/pois.cogp.parquet) (OpenStreetMap)
- [segments.cogp.parquet](https://cogp-demo.spatialty.io/v2.0.0/segments.cogp.parquet) (OvertureMaps)
- [buildings.cogp.parquet](https://cogp-demo.spatialty.io/v2.0.0/buildings.cogp.parquet) (OvertureMaps)
- [admin.cogp.parquet](https://cogp-demo.spatialty.io/v2.0.0/admin.cogp.parquet) (administrative boundaries, https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2025.html)

## Specification

See [`SPEC.md`](./SPEC.md) for the LoD extension, including optional [quantized geometry overviews](./SPEC.md#geometry-representation).

## Implementations

This repository is the source of truth for the specification and its reference
implementations:

- [`cogp-rs`](./cogp-rs): Rust producer, validator, CLI, and reader library.
- [`cogp-js`](./cogp-js): TypeScript reader and browser demo.

The implementations remain independently publishable. The repository root owns
shared dependency locks, CI, releases, and development commands so changes to the
profile can be tested against both implementations together.

## Writer implementation

[`SPEC.md`](./SPEC.md) defines the format contract. The [`cogp-rs` writer](./cogp-rs)
orders features as follows; these are implementation choices, not format
requirements. See the [CLI reference](./cogp-rs/README.md#convert) for options
and defaults.

The writer outputs GeoParquet 1.1, the most widely supported version. Its
spatial pruning relies on the statistics of the 1.1 bbox covering columns,
including their Page Indexes.

1. **Assign each feature to the coarsest level where it is visible.** Each level
   has a rendering resolution. Lines and polygons enter once their bbox is large
   enough to see at that resolution. Points are thinned on a grid so each cell
   keeps one point per level. Everything else, including null and empty
   geometries, goes to the finest level; no rows are dropped.
2. **Write levels coarse to fine.** A Row Group never mixes levels, so each
   level ends on a Row Group boundary recorded in `geo.lod.levels`.
3. **Pack each level spatially.** Within a level, Sort-Tile-Recursive packing
   groups nearby features into the same Row Group and page, so bbox statistics
   and Page Indexes prune reads by area.

When the input is all lines or all polygons, the writer also adds
simplified, quantized overviews for each level. A feature is deferred until
its simplified geometry survives. Null and empty geometries get empty overview
values, so they do not prevent overviews. Primary geometries and attributes are
never changed.

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
- [x] Propose the level-of-detail layout as a GeoParquet extension.
- [x] Add geometry overviews for scale-dependent rendering while preserving the lossless primary geometry.

A proof-of-concept exploring this layout exists at [Kanahiro/yosegi](https://github.com/Kanahiro/yosegi).

## Presentation

- [2026-09-03 MapLibre Meetup in Hiroshima / What vector tiles don’t solve.](https://docs.google.com/presentation/d/13rUtH5Px_L9jTL6NnWHaAgGC1-F7JRhz6TkJ-foARbg/edit?usp=sharing)
- [2026-09-02 FOSS4G 2026 Hiroshima / A Proposal for Hierarchically Organized GeoParquet](https://drive.google.com/file/d/1EW6pTnrNkW3LUdzfBP6ArhYeYoPQUafy/view?usp=sharing)
- [2026-08-24 CNG Japan / Spatial sort for well-packed GeoParquet](https://drive.google.com/file/d/1ZkRvXv9Ryak_jiZZqL-QAxGl--TBw668/view?usp=sharing)

## License

The contents of [`SPEC.md`](./SPEC.md) are licensed under [Creative Commons
Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
See [`LICENSE-SPEC`](./LICENSE-SPEC) for details.

The source code in this repository is licensed under the [MIT License](./LICENSE).
