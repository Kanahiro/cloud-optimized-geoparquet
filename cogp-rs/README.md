# cogp

Rust reference CLI for the [Cloud Optimized GeoParquet Profile (COGP)](https://github.com/Kanahiro/cloud-optimized-geoparquet).

`convert` reorders the features of a GeoParquet file across row groups using
point-grid density thinning, extent-based line/polygon visibility, and
Sort-Tile-Recursive (STR) bbox packing inside each level. `validate` checks the
structural rules in SPEC §5.

## Install

Pre-built binaries for Linux / macOS / Windows are attached to each
[GitHub release](https://github.com/Kanahiro/cloud-optimized-geoparquet/releases).

Or build from source:

```
cargo build --release -p cogp
# binary at target/release/cogp
```

## Quickstart

```
cogp convert input.parquet output.cogp.parquet
cogp validate output.cogp.parquet
```

The output COGP file itself is projection-agnostic — it can be consumed by
any renderer regardless of projection. The defaults simply pick GSDs tuned
for a Web Mercator z0..=z16 tile pyramid (17 levels), since that's the most
common viewer target. Pass `--gsd` to optimize for a different renderer.
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

# Optimize for a renderer other than Web Mercator: pass GSDs directly
# (meters, coarse to fine). The defaults still produce a valid COGP file for
# any consumer — use this only when you want level GSDs tuned to a specific
# pyramid.
cogp convert input.parquet output.cogp.parquet \
    --gsd 1000,500,100,50

# Point dataset already in a projected CRS; thin points more aggressively.
cogp convert points.parquet points.cogp.parquet \
    --input-units meters --point-thinning-factor 8
```

Level selection (mutually exclusive). These only choose the per-level GSDs
used during conversion; the resulting COGP file is projection-agnostic and
readable by any renderer regardless of which path you pick.

- `--gsd 1000,500,100,50` — explicit ground sample distances in **meters**,
  strictly decreasing. Use this to tune levels for a specific renderer (any
  projection — not just non-Web-Mercator).
- `--webmerc-minzoom` / `--webmerc-maxzoom` (default `0` / `16`) — derive
  GSDs from a Web Mercator tile pyramid:
  `GSD(z) = 40_075_016 / (webmerc_resolution · 2^z)` m. This is the default
  because Web Mercator is the most common viewer target, not because the
  output is restricted to it. Empty levels (no features assigned) are
  dropped automatically.
- `--webmerc-resolution` (default `1024`) — units per tile side used in the
  Web Mercator GSD formula above. `1024` is ~4× the typical 256-pixel tile
  resolution, so features collapsing within a few subpixels are deferred to
  finer levels. Controls level granularity; ignored when `--gsd` is given.

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
- `--point-thinning-factor` (default `4`) — point-like features (WKB
  `Point` / `MultiPoint`) thin on a grid this many times coarser per axis
  than the level GSD, yielding approximately `factor²` fewer points than a
  factor of `1`. Set to `1` for one winner per GSD-sized cell. Grid thinning
  applies only to points: lines and
  polygons are assigned as soon as they meet their visibility threshold,
  because a bbox center cannot represent an extended geometry's footprint.
- `--line-visibility-factor` (default `2`) — coarsest level at which a
  LineString is considered independently meaningful: its bbox diagonal must
  reach `factor · GSD` of that level. Lines are 1D so a diagonal equal to
  one GSD is only a hairline. This is a hard cutoff: a line shorter than the
  threshold is excluded from that level and deferred to a finer one, so a
  coarse-zoom read never fetches sub-resolution lines. Set to `1` for the least
  restrictive supported threshold.
- `--polygon-visibility-factor` (default `4`) — coarsest level at which a
  Polygon is considered independently meaningful: its bbox diagonal must
  reach `factor · GSD` of that level. A hard cutoff, like
  `--line-visibility-factor`: a polygon below the threshold is excluded from
  that level and deferred to a finer one. The default keeps coarse levels from
  being crowded by tiny polygons. Set to `1` for the least restrictive supported
  threshold.
- `--sort-key` — attribute column that decides which feature wins when several
  points contend for the same thinning cell. When set it is the primary criterion: the
  higher-ranked feature survives to coarser levels, so the more important one is
  kept (e.g. keep the higher-population city). Bbox size
  only breaks ties between equal-valued features — and then a deterministic
  row-index hash. It does not affect line or polygon level assignment. The column
  must be rank-able (numeric, boolean, or string); rows whose value is null always
  lose the tie.
- `--sort-order` (default `desc`) — direction for `--sort-key`: `desc` keeps
  the largest value, `asc` keeps the smallest. Ignored when `--sort-key` is
  unset.
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

// The footer is parsed here and cached. Hold this in app state.
let reader = Reader::open("data.cogp.parquet")?;
let primary = reader.primary_column().to_string();

// Pre-filter row groups using bbox stats + a target GSD/zoom — these
// only read the cached footer, no Parquet IO.
let by_bbox = reader.row_groups_intersecting_bbox([139.0, 35.0, 140.0, 36.0]);
let by_level = reader.row_groups_up_to_level(8);
let rgs: Vec<usize> = by_bbox.into_iter().filter(|i| by_level.contains(i)).collect();

// Per request: discard row groups whose bbox misses the query.
// Test each returned feature bbox for an exact filter.
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
use cogp::reader::{
    ParquetObjectReader, RangeCoalescingOptions, RangeCoalescingReader, Reader,
};
use futures::StreamExt;
use object_store::{aws::AmazonS3Builder, path::Path as ObjPath, ObjectStore};

let store: Arc<dyn ObjectStore> =
    Arc::new(AmazonS3Builder::from_env().with_bucket_name("my-bucket").build()?);
let path = ObjPath::from("layers/admin.cogp.parquet");
let head = store.head(&path).await?;

// Load and cache the footer for the lifetime of the server.
let mut footer_reader = ParquetObjectReader::new(store.clone(), path.clone())
    .with_file_size(head.size);
let reader = Reader::try_new_async(&mut footer_reader).await?;
let primary = reader.primary_column().to_string();

// Per request: filter row groups (footer-only, no IO), then stream just
// the bytes for those row groups. Both bbox and GSD/zoom are honored.
let rgs: Vec<usize> = {
    let by_bbox = reader.row_groups_intersecting_bbox([139.0, 35.0, 140.0, 36.0]);
    let by_gsd = reader.row_groups_up_to_gsd(500.0);
    by_bbox.into_iter().filter(|i| by_gsd.contains(i)).collect()
};
let per_request_reader = RangeCoalescingReader::try_new(
    ParquetObjectReader::new(store.clone(), path.clone()).with_file_size(head.size),
    RangeCoalescingOptions::default()
        .with_max_gap_bytes(128 * 1024)
        .with_max_overfetch_ratio(1.25),
)?;
let mut stream = reader.async_batch_stream(per_request_reader, &rgs)?;

while let Some(batch) = stream.next().await {
    let _batch = batch?;
    // ... feed WKB column to geozero exactly as in the sync example.
    let _ = &primary;
}
# Ok(()) }
```

### Reader API at a glance

Construction (parses and caches the footer):

- `Reader::open(path)` — local file.
- `Reader::try_new(reader)` — any `parquet::file::reader::ChunkReader`.
- `Reader::try_new_async(reader)` — any
  `parquet::arrow::async_reader::AsyncFileReader` (`feature = "async"`).
- `Reader::from_arrow_metadata(meta)` — bring your own cached
  `ArrowReaderMetadata`.

Remote range coalescing (`feature = "async"):

- `RangeCoalescingReader::new(reader)` — wrap a cloneable `AsyncFileReader`
  using the defaults: a 128 KiB maximum gap and 1.25 maximum overfetch ratio.
- `RangeCoalescingReader::try_new(reader, options)` — configure
  `max_gap_bytes` and `max_overfetch_ratio`. Both constraints must permit a
  merge; overlapping ranges always merge. This adapter bypasses
  `object_store`'s fixed one-megabyte `get_ranges` coalescing policy.

Selectors (`&self`, no IO — they only consult the cached footer):

- `levels()`, `cogp_meta()`, `geo_meta()`, `primary_column()`,
  `num_row_groups()`, `parquet_metadata()`.
- `row_groups_in_level(i)` — one level.
- `row_groups_up_to_level(i)` — every level up to and including `i`.
- `row_groups_up_to_gsd(min_gsd)` — every level whose GSD is `>= min_gsd`.
- `row_groups_intersecting_bbox([xmin, ymin, xmax, ymax])` — row groups whose
  covering-bbox envelope intersects the query, via Parquet column statistics.

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
- `gsd` values are positive and strictly decreasing.

Exits non-zero on failure.

## Benchmarks

`cogp-rs/tools/bench_cogp.py` compares two `cogp` binaries on the same input
GeoParquet file. It measures conversion time, output size, row-group bbox
area/aspect ratio, bbox-query hit row groups, compressed bytes selected, and
row-group index continuity.

Install the Python analysis dependency:

```
python3 -m pip install -r cogp-rs/tools/requirements-bench.txt
```

Example comparing a `main` worktree binary with the current branch:

```
cogp-rs/tools/bench_cogp.py \
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
