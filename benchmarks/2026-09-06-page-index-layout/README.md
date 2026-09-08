# PageIndex layout benchmark — 2026-09-06

## Decision

For `admin.parquet`, the next candidate layout is:

- spatially pack both RowGroups and the page-sized row intervals inside them;
- target **65,536 rows per RowGroup**;
- use **128 rows per Page** as the balanced default;
- retain **64 rows per Page** as an opt-in profile for fine-zoom-heavy browser workloads.

This is a polygon-data recommendation, not yet a universal default. Repeat the
matrix on point, line, and dense-building datasets before making it normative.

## What was held constant

- Input: 125,130 Japanese administrative polygons in `admin.parquet`.
- Layout: 17 COGP levels, identical schema, ZSTD settings, bbox columns, and
  PageIndex behavior.
- Queries: eight city centers (Tokyo, Osaka, Nagoya, Sapporo, Fukuoka, Sendai,
  Hiroshima, and Naha), using 512×512-pixel-equivalent viewports at 1,000 m,
  100 m, and 10 m target resolutions.
- Projection: `fid` and the selected overview geometry. Although the public
  reader request names primary `geom`, the quantized-overviews reader excludes
  WKB from the Parquet range plan, projects only the selected `overviews` LoD,
  and returns its decoded geometry as `geom`.
- Network model: 25 ms delay per underlying range read; concurrent reads can
  overlap and aggregate bandwidth is not throttled.
- RowGroup sweep: Page size fixed at 256 rows; geometry-byte cap set to 1 GiB
  to isolate literal RowGroup row count.
- Page sweep: RowGroup size fixed at 65,536 rows.

`selected_rows` is the conservative PageIndex admission count before exact bbox
filtering. `query_kb` includes PageIndex and projected data fetched after opening
the metadata.

## Results

### Spatial locality inside RowGroups

At 16,384 rows per RowGroup and 256 rows per Page:

| 10 m layout | selected rows | exact rows | amplification | query KB | RTT25 ms |
|---|---:|---:|---:|---:|---:|
| RowGroup-only STR | 3,990.4 | 7.4 | 541.1× | 2,297.6 | 246.6 |
| Nested Page STR | 2,905.4 | 7.4 | 394.0× | 2,422.0 | 247.3 |

Nested packing reduced selected rows by **27.2%**. The transfer and elapsed
metrics did not improve in this control, so PageIndex selectivity alone is not a
sufficient objective; geometry complexity, compression, and range continuity
also matter.

### RowGroup size

With nested packing and 256 rows per Page, the 10 m workload was:

| RowGroup rows | Parquet RowGroups | footer KB | query KB | requests | RTT25 ms |
|---:|---:|---:|---:|---:|---:|
| 4,096 | 43 | 422.6 | 2,387.7 | 138.4 | 330.4 |
| 16,384 | 22 | 231.3 | 2,422.0 | 134.0 | 247.3 |
| 65,536 | 17 | 184.8 | 2,437.3 | 134.4 | 238.9 |

Compared with 4,096 rows, 65,536 rows cut elapsed time by **27.7%** and footer
size by **56.3%**, with a **2.1%** increase in query bytes. Once PageIndex owns
fine-grained locality, shrinking RowGroups is counterproductive on this data.

### Page size

With 65,536 rows per RowGroup:

| Page rows | file MB | 10 m KB / ms | 100 m KB / ms | 1,000 m KB / ms |
|---:|---:|---:|---:|---:|
| 64 | 270.1 | 900.2 / 143.2 | 252.6 / 115.5 | 104.9 / 112.8 |
| 128 | 264.0 | 1,588.8 / 184.2 | 427.8 / 114.9 | 109.9 / 96.5 |
| 256 | 262.5 | 2,437.3 / 238.9 | 656.1 / 123.7 | 132.5 / 86.2 |
| 512 | 261.3 | 3,180.4 / 282.8 | 798.4 / 127.3 | 149.1 / 83.8 |

Relative to 256 rows, 128 rows cut 10 m transfer by **34.8%**, elapsed time by
**22.9%**, and selected rows by **50.0%**, while increasing file size by only
**0.6%**. Pages of 64 rows win the fine workload outright but increase file size
by 2.9%, issue more requests, and are 30.9% slower than 256-row Pages at 1,000 m.

## Reproduction

The experiment started from `codex/quantized-overviews` at `73af127` and applied
[`experiment.patch`](experiment.patch). It adds benchmark-only controls for a
literal RowGroup row limit, Page row count, and disabling nested Page packing.

Representative conversion:

```sh
cargo build --release
target/release/cogp convert admin.parquet candidate.parquet \
  --row-group-size 65536 \
  --fixed-row-group-rows 65536 \
  --page-row-count 128 \
  --row-group-max-bytes 1073741824
```

Use [`read-bench.mjs`](read-bench.mjs) after building `cogp-js`:

```sh
pnpm --filter cogp build
RTT_MS=25 node benchmarks/2026-09-06-page-index-layout/read-bench.mjs \
  candidate.parquet > read-results.json
```

[`page_selection_bench.rs`](page_selection_bench.rs) is the direct Rust
RowSelection counter used for the PageIndex quality measurements. Copy it to
`cogp-rs/src/bin/` on the experimental branch, then run:

```sh
cargo run --release --bin page_selection_bench -- candidate.parquet
```

## Files

- `page-tradeoff.csv`, `row-group-tradeoff.csv`, and `locality.csv`: reviewed
  summary tables used by the report.
- `page-read-results.json` and `read-results-rtt25.json`: raw JavaScript reader
  measurements.
- `page-selection.json` and `page-size-selection.json`: raw Rust PageIndex
  RowSelection measurements.

Generated candidate Parquet files are intentionally omitted because together
they exceed 1.5 GB.

## Limits

The latency model excludes bandwidth limits, TLS setup, CDN caches, browser
connection limits, and object-store billing. The byte-cap-off setting is an
experimental control rather than a production policy. Treat these findings as
strong evidence for the next implementation, then verify that implementation
against additional geometry families and real HTTP storage.
