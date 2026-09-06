# cogp

Rust reference producer, validator, CLI, and reader for the [Cloud Optimized
GeoParquet Profile (COGP)](https://github.com/Kanahiro/cloud-optimized-geoparquet).

`convert` assigns each feature to one coarse-to-fine level, spatially packs the
rows, preserves the primary WKB, and writes a required `overviews` struct. Each
overview LoD is simplified at its target resolution and stores quantized XY as
integer lists. `validate` checks the structural rules in SPEC §5.

## Install

Pre-built binaries for Linux, macOS, and Windows are attached to each GitHub
release, or build from source:

```sh
cargo build --release -p cogp
```

## Quickstart

```sh
cogp convert input.parquet output.cogp.parquet
cogp validate output.cogp.parquet
```

The input must be GeoParquet 1.x with a WKB `Binary` or `LargeBinary` primary
geometry column. A file may contain Point/MultiPoint, LineString/MultiLineString,
or Polygon/MultiPolygon, but not mixed geometry families or GeometryCollection.

## `convert`

```text
cogp convert <INPUT> <OUTPUT> [OPTIONS]
```

Examples:

```sh
# Explicit ground resolutions in meters, coarse to fine.
cogp convert input.parquet output.cogp.parquet \
  --resolution 1000,500,100,50

# Web Mercator-derived defaults over a narrower zoom range.
cogp convert input.parquet output.cogp.parquet \
  --webmerc-minzoom 4 --webmerc-maxzoom 12 \
  --row-group-size 20000

# Use half of each level resolution as the simplification tolerance.
cogp convert input.parquet output.cogp.parquet \
  --simplification-tolerance-factor 0.5
```

Level selection options:

- `--resolution` — explicit positive ground resolutions in meters, strictly
  decreasing from coarse to fine.
- `--webmerc-minzoom` / `--webmerc-maxzoom` — derive resolutions from a Web
  Mercator pyramid when `--resolution` is omitted; defaults to `0` / `16`.
- `--webmerc-resolution` — base units per tile side in that derivation;
  defaults to `1024` and is ignored with explicit `--resolution`.

Other important options:

- `--simplification-tolerance-factor` — simplification tolerance as a multiple
  of each level resolution; default `1`.
- `--row-group-size` — target number of point-equivalent resolution-grid cells
  per Parquet row group; default `10000`. A point consumes one cell. For each
  line or polygon level, the row limit is derived by dividing this budget by
  the mean bbox occupancy on that level's resolution grid. The value is
  therefore also the row limit for point data.
- `--row-group-max-bytes` — approximate maximum uncompressed bytes of the
  largest usable overview representation in a row group; default 4 MiB.
- `--input-units auto|degrees|meters` — coordinate-unit handling. `auto`
  inspects GeoParquet CRS metadata. Reproject high-latitude or
  antimeridian-spanning data to a meter-based CRS for predictable tolerances.
- `--point-thinning-factor` — point grid spacing relative to resolution;
  default `4`.
- `--sort-key` / `--sort-order` — choose the winning point when several occupy
  one thinning cell.
- `--geometry-column` — override primary geometry auto-detection.

The producer:

- preserves original attributes and lossless primary geometry;
- writes a canonical `bbox` struct and GeoParquet `covering.bbox` metadata;
- emits row groups in coarse-to-fine order with level-aligned boundaries;
- creates one sparse LoD child (`l0`, `l1`, …) per retained level under the
  fixed `overviews` column;
- simplifies each LoD directly from primary WKB, then encodes XY as `int32`
  lists using LoD-wide `scale` and `offset` metadata;
- writes overview integer leaves with Parquet `DELTA_BINARY_PACKED` encoding
  and no dictionary, while retaining ZSTD compression;
- writes `cogp.levels[].resolution` and the required `lod` for every level.

## Library use — reading COGP files

`Reader` parses and caches the Parquet footer once. Selectors take `&self` and
perform no further I/O, so a reader can be shared across requests.

```rust
use cogp::reader::Reader;

let reader = Reader::open("data.cogp.parquet")?;
let level_prefix = reader.row_groups_up_to_resolution(500.0);
let lod = reader.lod_for_resolution(500.0);
let spatial = reader.row_groups_intersecting_bbox([139.0, 35.0, 140.0, 36.0]);
let selected: Vec<usize> = spatial
    .into_iter()
    .filter(|index| level_prefix.contains(index))
    .collect();

let batches = reader.sync_batch_reader(std::fs::File::open("data.cogp.parquet")?, &selected)?;
for batch in batches {
    let batch = batch?;
    // Project/decode `overviews.geometry_type` and `overviews.{lod}` for
    // rendering, or explicitly project primary WKB for lossless analysis.
    let _ = (&batch, lod);
}
# Ok::<(), anyhow::Error>(())
```

With the `object_store` feature, `Reader::try_new_async` and
`Reader::async_batch_stream` support remote range reads. The optional
`RangeCoalescingReader` reduces request count while bounding gap overfetch.
Applications that must never transfer primary WKB should project only the
selected overview leaves and must not coalesce ranges across WKB chunks.

Reader selectors include:

- `row_groups_in_level(index)`
- `row_groups_up_to_level(index)`
- `row_groups_up_to_resolution(target_resolution)`
- `lod_for_resolution(target_resolution)`
- `row_groups_intersecting_bbox([xmin, ymin, xmax, ymax])`

## `validate`

```sh
cogp validate <FILE>
```

Validation covers GeoParquet bbox metadata and statistics, level ordering and
coverage, required per-level `resolution` and `lod`, `quantized_xy_v1`
metadata, finite scale/offset values, and the physical `overviews` leaf schema.
Semantic rendering quality remains a producer responsibility.

## Benchmarks

`tools/bench_cogp.py` compares two `cogp` binaries on one input. It reports
conversion time, size, row-group bbox quality, selected compressed bytes, and
row-group continuity. See `tools/requirements-bench.txt` for its Python
dependency.
