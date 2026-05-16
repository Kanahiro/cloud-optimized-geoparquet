# cogp

Rust reference CLI for the [Cloud Optimized GeoParquet Profile (COGP)](../SPEC.md).

`convert` reorders the features of a GeoParquet file across row groups using
grid-based density thinning per level and Sort-Tile-Recursive (STR) bbox packing
inside each level. `validate` checks the structural rules in SPEC §5.

## Install

Pre-built binaries for Linux / macOS / Windows are attached to each
[GitHub release](https://github.com/Kanahiro/cloud-optimized-geoparquet/releases).

Or build from source:

```
cargo build --release -p cogp
# binary at cogp-rs/target/release/cogp
```

## Quickstart

```
cogp convert input.parquet output.cogp.parquet
cogp validate output.cogp.parquet
```

The defaults auto-derive 17 levels from Web Mercator z0..=z16 and work on any
GeoParquet 1.x file with a WKB geometry column.

## convert

```
cogp convert <INPUT> <OUTPUT> [OPTIONS]
```

Examples:

```
# Narrow the zoom range and bump the row group size for a small dataset.
cogp convert input.parquet output.cogp.parquet \
    --webmerc-minzoom 4 --webmerc-maxzoom 12 --row-group-size 20000

# Non-Web-Mercator renderer: pass GSDs directly (meters, coarse to fine).
cogp convert input.parquet output.cogp.parquet \
    --gsd 1000,500,100,50

# Point dataset already in a projected CRS; thin points more aggressively.
cogp convert points.parquet points.cogp.parquet \
    --input-units meters --point-thinning-factor 8
```

Level selection (mutually exclusive):

- `--gsd 1000,500,100,50` — explicit ground sample distances in **meters**,
  strictly decreasing. Use this for non-Web-Mercator renderers.
- `--webmerc-minzoom` / `--webmerc-maxzoom` (default `0` / `16`) — derive
  GSDs from a Web Mercator tile pyramid:
  `GSD(z) = 40_075_016 / (webmerc_resolution · 2^z)` m. Empty levels (no
  features assigned) are dropped automatically.
- `--webmerc-resolution` (default `1024`) — units per tile side used in the
  Web Mercator GSD formula above. `1024` keeps the thinning grid at ~4× the
  typical 256-pixel tile resolution, so features collapsing within a few
  subpixels are dropped. Controls thinning granularity only; ignored when
  `--gsd` is given.

Other options:

- `--row-group-size` (default `10000`) — max Parquet row group size in rows.
  Row group boundaries always align with level boundaries.
- `--row-group-max-bytes` — max estimated encoded Parquet row group size in
  bytes. This must be a numeric byte count, without suffixes. It is enforced
  using the Parquet writer's in-progress encoded-size estimate, checked at batch
  granularity, so an individual row group can exceed the target slightly.
- `--input-units` (default `auto`) — `auto` reads the GeoParquet `crs`
  PROJJSON (`ProjectedCRS` → meters, otherwise degrees; absent / null → degrees
  per OGC:CRS84). Override with `degrees` or `meters` explicitly.
  **For datasets spanning high latitudes or the antimeridian, reproject to a
  meter-based CRS before running `convert`.** The degree→meter conversion is
  rendering-grade, not geodesic.
- `--point-thinning-factor` (default `4`) — point-like features (zero-area
  bbox) thin on a grid this many times coarser per axis than polygons, since
  points occupy a single cell visually. Set to `1` to disable.
- `--geometry-column` — override the auto-detected primary geometry column.
  Input must be a WKB `Binary`/`LargeBinary` Arrow column.

The output file:

- preserves all original columns except the covering bbox: if the input has a
  GeoParquet 1.1 `covering.bbox` struct, its values are reused (not
  recomputed) and the original column is dropped; any column literally named
  `bbox` is also dropped;
- writes a canonical `bbox` struct column (`xmin/ymin/xmax/ymax: f64`) and
  points GeoParquet 1.1 `covering.bbox` at it;
- emits one or more row groups per level, written in coarse-to-fine order;
- writes `cogp` metadata listing the `row_group_end` and `gsd` of each level.

## validate

```
cogp validate <FILE>
```

Checks SPEC §5:

- `geo` metadata is present (GeoParquet 1.x) with a `covering.bbox`;
- each covering bbox column has Parquet row group min/max statistics;
- `cogp` metadata is present with a non-empty `levels` array;
- `row_group_end` values are strictly increasing and end at `num_row_groups - 1`;
- `gsd` values are positive and strictly decreasing.

Exits non-zero on failure.
