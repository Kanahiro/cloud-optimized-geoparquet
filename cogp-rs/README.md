# cogp

Rust reference CLI for the [Cloud Optimized GeoParquet Profile (COGP)](../SPEC.md).

`convert` builds both dimensions of COGP progression: point density is thinned
across row-group levels, while line and polygon geometries are simplified and
stored in rendering sidecar fields. Sort-Tile-Recursive
(STR) bbox packing is used inside each level. `validate` checks the structural
rules in SPEC §5.

## Install

Pre-built binaries for Linux / macOS / Windows are attached to each
[GitHub release](https://github.com/Kanahiro/cloud-optimized-geoparquet/releases).

Or build from source:

```
cd cogp-rs
cargo build --release -p cogp
# binary at target/release/cogp
```

## Quickstart

```
cogp convert input.parquet output.cogp.parquet
cogp validate output.cogp.parquet
```

The output COGP file itself is projection-agnostic — it can be consumed by
any renderer regardless of projection. The defaults simply pick resolutions tuned
for a Web Mercator z0..=z16 tile pyramid (17 levels), since that's the most
common viewer target. Pass `--resolution` to optimize for a different renderer.
Works on any GeoParquet 1.x file with a WKB geometry column.

## convert

```
cogp convert <INPUT> <OUTPUT> [OPTIONS]
```

Examples:

```
# Narrow the zoom range and bump the row group size for a small dataset.
cogp convert input.parquet output.cogp.parquet \
    --webmerc-minzoom 4 --webmerc-maxzoom 12 --row-group-size 20000

# Optimize for a renderer other than Web Mercator: pass resolutions directly
# (meters, coarse to fine). The defaults still produce a valid COGP file for
# any consumer — use this only when you want level resolutions tuned to a specific
# pyramid.
cogp convert input.parquet output.cogp.parquet \
    --resolution 1000,500,100,50

# Point dataset already in a projected CRS; thin points more aggressively.
cogp convert points.parquet points.cogp.parquet \
    --input-units meters --point-thinning-factor 32
```

Level selection (mutually exclusive). These only choose the per-level resolutions
used during conversion; the resulting COGP file is projection-agnostic and
readable by any renderer regardless of which path you pick.

- `--resolution 1000,500,100,50` — explicit ground resolutions in **meters**,
  strictly decreasing. Use this to tune levels for a specific renderer (any
  projection — not just non-Web-Mercator).
- `--webmerc-minzoom` / `--webmerc-maxzoom` (default `0` / `16`) — derive
  resolutions from a Web Mercator tile pyramid:
  `resolution(z) = 40_075_016 / (webmerc_resolution · 2^z)` m. This is the default
  because Web Mercator is the most common viewer target, not because the
  output is restricted to it. Empty levels (no features assigned) are
  dropped automatically.
- `--webmerc-resolution` (default `4096`) — units per tile side used in the
  Web Mercator resolution formula above. `4096` matches the conventional MVT
  extent and provides 16 coordinate units per pixel on a 256-pixel tile.
  Controls thinning granularity only; ignored when
  `--resolution` is given.

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
- `--point-thinning-factor` (default `16`) — point-like features (WKB
  `Point` / `MultiPoint`) thin on a grid this many times coarser per axis
  than the level resolution. Points occupy a single cell visually, so equal grid
  density looks too dense compared to lines/polygons. With the default MVT
  extent, `16` gives an effective pitch of approximately one display pixel.
  Set to `1` to disable.
- Line and polygon features are not density-thinned. Their WKB coordinates are
  Douglas–Peucker simplified with a tolerance derived from the level resolution
  (`resolution` for meter coordinates, `resolution / 111,320` for degree coordinates).
  Junctions and shared-arc endpoints are detected from vertex adjacency and
  retained, following Tippecanoe's shared-node approach. Identical shared arcs
  are therefore simplified consistently without quantizing coordinates. Level
  eligibility is tested without those topology anchors, so a shared node cannot
  keep a sub-resolution feature in a coarse level. A feature is deferred until
  unconstrained simplification can still construct its geometry;
  Point and MultiPoint always use the primary WKB and do not get rendering
  sidecar values. Point-only files omit `geometry_lods` entirely.
- `--sort-key` — attribute column that decides which point feature wins when several
  contend for the same thinning cell. When set it is the primary criterion: the
  higher-ranked feature survives to coarser levels, so the more important one is
  kept (e.g. keep the higher-population city, the higher road class). Bbox size
  only breaks ties between equal-valued features — and then a deterministic
  row-index hash. The column must be rank-able (numeric, boolean, or string);
  rows whose value is null always lose the tie.
- `--sort-order` (default `desc`) — direction for `--sort-key`: `desc` keeps
  the largest value, `asc` keeps the smallest. Ignored when `--sort-key` is
  unset.
- `--geometry-column` — override the auto-detected primary geometry column.
  Input must be a WKB `Binary`/`LargeBinary` Arrow column.
- `--lod-interval N` — write a rendering LOD for every Nth surviving level
  (default `2`). Missing levels use the nearest finer stored LOD, then the
  primary WKB. The finest level is not duplicated in the sidecar.

The output file:

- preserves all original columns except the covering bbox: if the input has a
  GeoParquet 1.1 `covering.bbox` struct, its values are reused (not
  recomputed) and the original column is dropped; any column literally named
  `bbox` is also dropped;
- writes a canonical `bbox` struct column (`xmin/ymin/xmax/ymax: f64`) and
  points GeoParquet 1.1 `covering.bbox` at it;
- emits one or more row groups per level, written in coarse-to-fine order;
- for files containing Line/Polygon geometry, writes a required
  `geometry_lods` struct containing nullable WKB children for the levels
  selected by `--lod-interval`;
- omits the sidecar for Point/MultiPoint-only files, whose readers use the
  primary geometry WKB;
- writes `cogp` v0.1 metadata listing `row_group_end`, `resolution`, and
  `lods_column` when a sidecar is present.

`lods_column` is optional for every geometry type. This converter emits it when
Line/Polygon geometry can benefit from simplification and at least two feature
levels survive. Readers and the validator accept files without it and use the
primary WKB instead. Sidecars may omit any level: readers use the exact child,
the nearest finer child, or the primary WKB in that order.

## Library use — reading COGP files

The crate also exposes a `Reader` for reading COGP files from Rust. The
Parquet footer (and the `geo` / `cogp` metadata it carries) is parsed
**once** at construction; selectors take `&self` and never consume the
reader, so a single `Reader` can sit in shared server state and fan out
across requests. Geometries stay in their on-disk WKB form in the
returned `RecordBatch`es — downstream users plug in
[`geozero`](https://crates.io/crates/geozero) (or any other WKB consumer)
to convert into GeoJSON / WKT / `geo-types` / FlatGeobuf / etc.

### Local files (sync)

```toml
[dependencies]
cogp = "0.1"
geozero = { version = "0.14", features = ["with-wkb"] }
arrow-array = "56"
```

```rust
use std::fs::File;
use arrow_array::{Array, BinaryArray, LargeBinaryArray};
use cogp::reader::Reader;
use geozero::wkb::Wkb;
use geozero::ToJson;

// Footer is parsed here and cached. Hold this in app state and reuse it.
let reader = Reader::open("data.cogp.parquet")?;
let primary = reader.primary_column().to_string();

// Pre-filter row groups using bbox stats + a target resolution/zoom — these
// only read the cached footer, no Parquet IO.
let by_bbox = reader.row_groups_intersecting_bbox([139.0, 35.0, 140.0, 36.0]);
let by_level = reader.row_groups_up_to_level(8);
let rgs: Vec<usize> = by_bbox.into_iter().filter(|i| by_level.contains(i)).collect();

// Per request: open a fresh File and let the cached metadata drive the read.
let file = File::open("data.cogp.parquet")?;
let batches = reader.sync_batch_reader(file, &rgs)?;

for batch in batches {
    let batch = batch?;
    let geom = batch.column_by_name(&primary).unwrap();
    if let Some(arr) = geom.as_any().downcast_ref::<BinaryArray>() {
        for i in 0..arr.len() {
            println!("{}", Wkb(arr.value(i).to_vec()).to_json()?);
        }
    } else if let Some(arr) = geom.as_any().downcast_ref::<LargeBinaryArray>() {
        for i in 0..arr.len() {
            println!("{}", Wkb(arr.value(i).to_vec()).to_json()?);
        }
    }
}
# Ok::<(), anyhow::Error>(())
```

### Remote files (async, S3 / GCS / HTTP)

Enable the `object_store` feature to pull only the row groups the request
actually needs over HTTP range requests:

```toml
[dependencies]
cogp = { version = "0.1", features = ["object_store"] }
object_store = "0.11"
geozero = { version = "0.14", features = ["with-wkb"] }
tokio = { version = "1", features = ["full"] }
futures = "0.3"
```

```rust,no_run
# async fn run() -> anyhow::Result<()> {
use std::sync::Arc;
use cogp::reader::{Reader, ParquetObjectReader};
use futures::StreamExt;
use object_store::{aws::AmazonS3Builder, path::Path as ObjPath, ObjectStore};

let store: Arc<dyn ObjectStore> =
    Arc::new(AmazonS3Builder::from_env().with_bucket_name("my-bucket").build()?);
let path = ObjPath::from("layers/admin.cogp.parquet");
let head = store.head(&path).await?;

// One range request for the footer, then cache it for the lifetime of the
// server. Footer is never re-fetched, even across thousands of requests.
let mut footer_reader = ParquetObjectReader::new(store.clone(), head.clone());
let reader = Reader::try_new_async(&mut footer_reader).await?;
let primary = reader.primary_column().to_string();

// Per request: filter row groups (footer-only, no IO), then stream just
// the bytes for those row groups. Both bbox and resolution/zoom are honored.
let rgs: Vec<usize> = {
    let by_bbox = reader.row_groups_intersecting_bbox([139.0, 35.0, 140.0, 36.0]);
    let by_resolution = reader.row_groups_up_to_resolution(500.0);
    by_bbox.into_iter().filter(|i| by_resolution.contains(i)).collect()
};
let per_request_reader = ParquetObjectReader::new(store.clone(), head.clone());
let mut stream = reader.async_batch_stream(per_request_reader, &rgs)?;

while let Some(batch) = stream.next().await {
    let _batch = batch?;
    // ... feed WKB column to geozero exactly as in the sync example.
    let _ = &primary;
}
# Ok(()) }
```

### Reader API at a glance

Construction (parses the footer once, then caches it):

- `Reader::open(path)` — local file.
- `Reader::try_new(reader)` — any `parquet::file::reader::ChunkReader`.
- `Reader::try_new_async(reader)` — any
  `parquet::arrow::async_reader::AsyncFileReader` (`feature = "async"`).
- `Reader::from_arrow_metadata(meta)` — bring your own cached
  `ArrowReaderMetadata`.

Selectors (`&self`, no IO — they only consult the cached footer):

- `levels()`, `cogp_meta()`, `geo_meta()`, `primary_column()`,
  `num_row_groups()`, `parquet_metadata()`.
- `row_groups_in_level(i)` — one level.
- `row_groups_up_to_level(i)` — every level up to and including `i`.
- `row_groups_up_to_resolution(min_resolution)` — every level whose resolution
  is `>= min_resolution`.
- `row_groups_intersecting_bbox([xmin, ymin, xmax, ymax])` — row groups whose
  covering-bbox envelope intersects the query, via Parquet column statistics.
- `rendering_geometry_column(i)` — exact LOD child, nearest finer stored child,
  or the primary geometry column.

Per-request reads (hand in a fresh sync / async reader; footer is reused):

- `sync_batch_reader(reader, &row_groups)` — `ParquetRecordBatchReader`.
- `async_batch_stream(reader, &row_groups)` — `ParquetRecordBatchStream`
  (`feature = "async"`).

## validate

```
cogp validate <FILE>
```

Checks SPEC §5:

- `geo` metadata is present (GeoParquet 1.x) with a `covering.bbox`;
- each covering bbox column has Parquet row group min/max statistics;
- `cogp` metadata is present with a non-empty `levels` array;
- `row_group_end` values are strictly increasing and end at `num_row_groups - 1`;
- `resolution` values are positive and strictly decreasing.

Exits non-zero on failure.

## Benchmarks

`tools/bench_cogp.py` compares two `cogp` binaries on the same input
GeoParquet file. It measures conversion time, output size, row-group bbox
area/aspect ratio, bbox-query hit row groups, compressed bytes selected, and
row-group index continuity.

Install the Python analysis dependency:

```
python3 -m pip install -r tools/requirements-bench.txt
```

Example comparing a `main` worktree binary with the current branch:

```
tools/bench_cogp.py \
  --input /Users/kanahiro/Downloads/foss4ghkd/building.parquet \
  --baseline-bin /tmp/cogp-rs-main-bench/target/release/cogp \
  --candidate-bin target/release/cogp \
  --baseline-label main \
  --candidate-label current \
  --json-out /tmp/cogp-bench/building.json \
  --markdown-out /tmp/cogp-bench/building.md
```

Use `--reuse-outputs` with `--baseline-output` / `--candidate-output` to
reanalyze existing converted files without rerunning `convert`.
