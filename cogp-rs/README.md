# cogp

Rust reference CLI for the [Cloud Optimized GeoParquet Profile (COGP)](https://github.com/Kanahiro/cloud-optimized-geoparquet).

`convert` reorders the features of a GeoParquet file across row groups using
point-grid density thinning, extent-based line/polygon visibility, and
Sort-Tile-Recursive (STR) bbox packing inside each level. `validate` checks the
structural rules in SPEC.md and any declared rendering extension in OVERVIEWS.md.

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
any renderer regardless of projection. The defaults simply pick Resolutions tuned
for a Web Mercator z0..=z16 tile pyramid (17 levels), since that's the most
common viewer target. Pass `--resolution` to optimize for a different renderer.
Supports GeoParquet 1.x with WKB point, line, or polygon geometries, including Multi variants.

## Rendering overviews

Release 2.0.0 adds the optional [quantized rendering extension](../OVERVIEWS.md).
The base layout remains `geo.lod`, without an independent version. Eligible
line/polygon tables receive separate int32 XY overviews; the primary geometry
and source attributes remain unchanged. Tables with null/empty geometries,
mixed families, or an existing `overviews` attribute use the base layout.

`--simplification-tolerance-factor` defaults to 1 and multiplies each CRS-unit
resolution. Line and polygon features are deferred until both their visibility
threshold and overview viability are met. Later levels can refine geometry
without adding rows. ZSTD 9, byte-stream split encoding of overview integers, and omission
of primary WKB statistics are internal writer choices.

## convert

```
cogp convert <INPUT> <OUTPUT> [OPTIONS]
```

Examples:

```
# Narrow the zoom range and bump the row group size for a small dataset.
cogp convert input.parquet output.cogp.parquet \
    --webmerc-minzoom 4 --webmerc-maxzoom 12 --row-group-size 20000

# Optimize for a renderer other than Web Mercator: pass Resolutions directly
# (primary geometry CRS units, coarse to fine). The defaults still produce a valid COGP file for
# any consumer — use this only when you want level Resolutions tuned to a specific
# pyramid.
cogp convert input.parquet output.cogp.parquet \
    --resolution 1000,500,100,50

# Point dataset already in a projected CRS; thin points more aggressively.
cogp convert points.parquet points.cogp.parquet \
    --point-thinning-factor 8
```

Level selection (mutually exclusive). These only choose the per-level Resolutions
used during conversion; the resulting COGP file is projection-agnostic and
readable by any renderer regardless of which path you pick.

- `--resolution 1000,500,100,50` — explicit rendering resolutions in **primary geometry CRS units**,
  strictly decreasing. Use this to tune levels for a specific renderer (any
  projection — not just non-Web-Mercator).
- `--webmerc-minzoom` / `--webmerc-maxzoom` (default `0` / `16`) — derive
  Resolutions from a Web Mercator tile pyramid:
  `resolution(z) = 40_075_016 / (webmerc_resolution · 2^z)` equatorial meters,
  converted to the primary CRS units (degrees use 111,320 m/degree). This is the default
  because Web Mercator is the most common viewer target, not because the
  output is restricted to it. Empty levels (no features assigned) are
  dropped automatically.
- `--webmerc-resolution` (default `1024`) — units per tile side used in the
  Web Mercator Resolution formula above. `1024` is ~4× the typical 256-pixel tile
  resolution, so features collapsing within a few subpixels are deferred to
  finer levels. Controls level granularity; ignored when `--resolution` is given.

Other options:

- `--row-group-size` (default `65536`) — max Parquet row group size in rows.
- `--page-row-count` (default `2048`) — maximum top-level rows per data page.
  Page Indexes and spatial page packing are always enabled. Row Groups never
  mix levels; the bbox leaves get ColumnIndexes and every leaf gets an OffsetIndex.

The writer always disables dictionary encoding for all columns, including nested
attributes, so selective reads do not need column-chunk-wide dictionaries. ZSTD
compression and `BYTE_STREAM_SPLIT` encoding of overview coordinates/topology remain enabled.
All attribute leaves, including nested attributes, use `PLAIN` encoding followed
by ZSTD compression. Physical-type-specific transforms can worsen the final
compressed size, so only generated overview coordinates/topology use explicit
`BYTE_STREAM_SPLIT` encoding. Logical types and attribute values are preserved.

The primary geometry column comes from `geo.primary_column`. Auto-derived
resolutions use its CRS horizontal units; absent CRS means CRS84. Null or
unrecognized units require explicit `--resolution` values in coordinate units.
No coordinate reprojection is performed.

All visibility factors default to **4**, a common four-resolution-unit scale.
This is a rendering heuristic: a point grid width and a geometry bbox diagonal
are different measures, so the same factor does not guarantee equal visual density.

- `--point-thinning-factor` (default `4`) — point-like features (WKB
  `Point` / `MultiPoint`) thin on a grid this many times coarser per axis
  than the level Resolution, yielding approximately `factor²` fewer points than a
  factor of `1`. Set to `1` for one winner per Resolution-sized cell. Grid thinning
  applies only to points: lines and
  polygons are assigned as soon as they meet their visibility threshold,
  because a bbox center cannot represent an extended geometry's footprint.
- `--line-visibility-factor` (default `4`) — coarsest level at which a
  LineString is considered independently meaningful: its bbox diagonal must
  reach `factor · Resolution` of that level. Lines are 1D so a diagonal equal to
  one Resolution is only a hairline. This is a hard cutoff: a line shorter than the
  threshold is excluded from that level and deferred to a finer one, so a
  coarse-zoom read never fetches sub-resolution lines. Set to `1` for the least
  restrictive supported threshold.
- `--polygon-visibility-factor` (default `4`) — coarsest level at which a
  Polygon is considered independently meaningful: its bbox diagonal must
  reach `factor · Resolution` of that level. A hard cutoff, like
  `--line-visibility-factor`: a polygon below the threshold is excluded from
  that level and deferred to a finer one. The default keeps coarse levels from
  being crowded by tiny polygons. Set to `1` for the least restrictive supported
  threshold.
- `--priority-column` — attribute column that decides which feature wins when several
  points contend for the same thinning cell. When set it is the primary criterion: the
  higher-ranked feature survives to coarser levels, so the more important one is
  kept (e.g. keep the higher-population city). Bbox size
  only breaks ties between equal-valued features — and then a deterministic
  row-index hash. It does not affect line or polygon level assignment. The column
  must be rank-able (numeric, boolean, or string); rows whose value is null always
  lose the tie.
- `--priority-column-order` (default `desc`) — direction for `--priority-column`: `desc` keeps
  the largest value, `asc` keeps the smallest. Ignored when `--priority-column` is
  unset.

The output file:

- preserves every original column and value, including null/empty geometries and duplicate rows;
- trusts and preserves an existing `covering.bbox`, regardless of column name;
- if no covering exists, appends one with a collision-free name (`bbox`, `bbox_`, ...);
- emits one or more row groups per level, written in coarse-to-fine order;
- writes `geo.lod` metadata listing the `row_group_end` and `resolution` of each level.

## Library use — reading COGP files

The crate also exposes a `Reader` for reading COGP files from Rust. The
Parquet footer (and the `geo` / `geo.lod` metadata it carries) is parsed
**once** at construction; selectors take `&self` and never consume the
reader, so a single `Reader` can sit in shared server state and fan out
across requests. Geometries stay in their on-disk WKB form in the
returned `RecordBatch`es — downstream users plug in
[`geozero`](https://crates.io/crates/geozero) (or any other WKB consumer)
to convert into GeoJSON / WKT / `geo-types` / FlatGeobuf / etc.

### Local files (sync)

```toml
[dependencies]
cogp = "2.0"
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

// Pre-filter row groups using bbox stats + a target Resolution/zoom — these
// only read the cached footer, no Parquet IO.
let by_bbox = reader.row_groups_intersecting_bbox([139.0, 35.0, 140.0, 36.0]);
let by_level = reader.row_groups_up_to_level(8);
let rgs: Vec<usize> = by_bbox.into_iter().filter(|i| by_level.contains(i)).collect();

// Per request: prune Row Groups, then lazily read bbox PageIndexes and skip
// non-intersecting Pages. Test each returned feature bbox for an exact filter.
let file = File::open("data.cogp.parquet")?;
let batches = reader.sync_batch_reader_with_bbox(
    file,
    &rgs,
    [139.0, 35.0, 140.0, 36.0],
)?;

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
cogp = { version = "2.0", features = ["object_store"] }
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
// the bytes for those row groups. Both bbox and Resolution/zoom are honored.
let rgs: Vec<usize> = {
    let by_bbox = reader.row_groups_intersecting_bbox([139.0, 35.0, 140.0, 36.0]);
    let by_resolution = reader.row_groups_up_to_resolution(500.0);
    by_bbox.into_iter().filter(|i| by_resolution.contains(i)).collect()
};
let per_request_reader = RangeCoalescingReader::try_new(
    ParquetObjectReader::new(store.clone(), path.clone()).with_file_size(head.size),
    RangeCoalescingOptions::default()
        .with_max_gap_bytes(16 * 1024)
        .with_max_extra_bytes(64 * 1024)
        .with_max_request_bytes(2 * 1024 * 1024),
)?;
let mut stream = reader
    .async_batch_stream_with_bbox(
        per_request_reader,
        &rgs,
        [139.0, 35.0, 140.0, 36.0],
    )
    .await?;

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
  using the defaults: a 32 KiB maximum gap, 128 KiB cumulative extra bytes,
  and a 2 MiB maximum merged request.
- `RangeCoalescingReader::try_new(reader, options)` — configure
  `max_gap_bytes`, `max_extra_bytes`, and `max_request_bytes`. All constraints
  must permit a merge; overlapping ranges always merge. This adapter bypasses
  `object_store`'s fixed one-megabyte `get_ranges` coalescing policy.

Selectors (`&self`, no IO — they only consult the cached footer):

- `levels()`, `cogp_meta()`, `geo_meta()`, `primary_column()`,
  `num_row_groups()`, `parquet_metadata()`.
- `row_groups_in_level(i)` — one level.
- `row_groups_up_to_level(i)` — every level up to and including `i`.
- `row_groups_up_to_resolution(min_resolution)` — the finest prefix whose resolution is `>= min_resolution`,
  clamped to the first level for coarser targets. Values use primary CRS units.
- `row_groups_intersecting_bbox([xmin, ymin, xmax, ymax])` — row groups whose
  covering-bbox envelope intersects the query, via Parquet column statistics.

Per-request reads (hand in a fresh sync / async reader; footer is reused):

- `sync_batch_reader(reader, &row_groups)` — `ParquetRecordBatchReader`.
- `sync_batch_reader_with_bbox(reader, &row_groups, bbox)` — lazily fetches
  bbox PageIndexes and applies a conservative Page-level `RowSelection`.
- `async_batch_stream(reader, &row_groups)` — `ParquetRecordBatchStream`
  (`feature = "async"`).
- `async_batch_stream_with_bbox(reader, &row_groups, bbox)` — asynchronous
  PageIndex pruning (`feature = "async"`).

The bbox methods fall back to complete candidate Row Groups when PageIndexes
are absent. Page pruning is conservative; callers must still perform exact
per-feature bbox intersection checks.

## validate

```
cogp validate <FILE>
```

Checks the layout metadata constraints:

- `geo` metadata and its primary column are present;
- covering paths, when declared, refer to actual columns (missing statistics produce warnings);
- `geo.lod` metadata is present with a non-empty `levels` array;
- `row_group_end` values are non-decreasing and end at `num_row_groups - 1`;
- `resolution` values are positive, finite, and strictly decreasing.

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
