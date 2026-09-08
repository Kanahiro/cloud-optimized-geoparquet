# Administrative-polygon overview benchmark — 2026-09-07

## Decision

The earlier administrative-polygon PageIndex benchmark already measured the
quantized `overviews` payload, not primary WKB. `CogpReader.readRows()` rewrites
a requested primary geometry projection to the selected overview LoD before it
constructs the Parquet range plan.

Explicit WKB-versus-overview measurements confirm that lightweight overviews
change the Page-size trade-off, but do not make these polygons behave like POIs:

- use **Page 128** as the balanced administrative-polygon default;
- use **Page 64** for fine-zoom-heavy rendering, or when query transfer matters
  more than a 2.3% file-size increase relative to Page 128;
- retain **RowGroup 65,536** for fine-zoom-heavy workloads and the smallest
  footer; RowGroup 16,384 is effectively tied under an equal-weight average of
  the three tested resolutions;
- do not adopt the POI **32,768 / 512** profile for this dataset. Page 512 was
  fastest only at 1,000 m and paid 1.4–2.0x more overview query bytes than Page
  128 at the tested resolutions.

The important invariant remains nested Page-level spatial packing. The existing
`admin.page-index.cogp.parquet` reduces admitted rows, but its fragmented range
plan is slower than `admin.cogp.parquet` under 25 ms simulated RTT.

## What the reader actually projects

`admin.cogp.parquet` contains lossless primary `geom` WKB plus quantized
`overviews.l0` through `overviews.l16`. The tested target resolutions select:

| target resolution | selected LoD | prefix RowGroup end | compressed WKB in prefix | compressed selected overview in prefix | ratio |
|---:|---|---:|---:|---:|---:|
| 1,000 m | `l5` | 15 | 136.4 MB | 73.7 KB | 1,851x |
| 100 m | `l8` | 18 | 144.6 MB | 465.1 KB | 311x |
| 10 m | `l11` | 31 | 161.6 MB | 2.47 MB | 65.5x |

The selected overview metadata view contains only `geometry_type` and that LoD;
sibling LoDs and primary WKB are excluded from the Parquet projection. The
benchmark's overview mode still asks the public reader for `geom`, so it also
includes overview decoding into GeoJSON in the elapsed measurement.

## Page size: overview makes the optimum workload-dependent

RowGroups were fixed at 65,536 rows with nested Page STR packing. The mean gives
1,000 m, 100 m, and 10 m equal weight; each resolution contains the same eight
Japanese city viewports. `RTT25` applies 25 ms delay to each underlying range
read, while concurrent reads overlap and aggregate bandwidth is unthrottled.

| Page rows | file MB | overview mean KB / ms | overview 10 m KB / ms | overview 1,000 m KB / ms |
|---:|---:|---:|---:|---:|
| **64** | 270.1 | **409 / 121** | **879 / 143** | 102 / 109 |
| **128** | 264.0 | 692 / 135 | 1,552 / 195 | 107 / 94 |
| 256 | 262.5 | 1,050 / 156 | 2,380 / 251 | 129 / 88 |
| 512 | 261.3 | 1,344 / 172 | 3,106 / 299 | 146 / **85** |

Page 64 is the literal equal-weight query winner. Page 128 remains the balanced
default because it reduces file size by 2.3%, uses fewer ranges, and is 14.0%
faster at 1,000 m, while keeping fine-zoom transfer well below Page 256/512.
This is a policy trade-off rather than a single mathematical optimum.

## WKB control: overviews move the knee upward, but not to Page 512

The WKB control uses the same candidate RowGroups, bbox filter, PageIndex, and
viewports, but directly projects primary `geom` instead of the selected LoD.

| Page rows | WKB mean KB / ms | overview mean KB / ms | overview byte reduction |
|---:|---:|---:|---:|
| **64** | **38,029 / 572** | **409 / 121** | 98.9% |
| 128 | 55,403 / 813 | 692 / 135 | 98.8% |
| 256 | 80,410 / 1,183 | 1,050 / 156 | 98.7% |
| 512 | 105,162 / 1,568 | 1,344 / 172 | 98.7% |

With WKB, Page 64 wins at every tested resolution: false-positive Polygon rows
are extremely expensive. With overviews, that penalty collapses and larger Pages
become competitive at coarse zooms. Polygon bbox overlap still makes Page 512
too coarse for 10 m and 100 m queries, unlike the POI dataset.

## RowGroup size: 16,384 and 65,536 are effectively tied overall

Pages were fixed at 256 rows with nested packing.

| RowGroup rows | footer KB | overview mean KB / ms | overview 10 m KB / ms |
|---:|---:|---:|---:|
| 4,096 | 422.6 | 1,034 / 179 | 2,332 / 327 |
| **16,384** | 231.3 | 1,045 / **153.3** | 2,365 / 256 |
| **65,536** | **184.8** | 1,050 / **153.6** | 2,380 / **247** |

The 0.3 ms equal-weight difference between 16,384 and 65,536 is below a useful
resolution for this local benchmark. RowGroup 65,536 remains preferable when
fine zoom and footer size matter; 16,384 is a valid latency-conservative choice.
RowGroup 4,096 is dominated under this transport model.

## Existing files: PageIndex selectivity alone is insufficient

On the checked-in files, `admin.page-index.cogp.parquet` reduced selected rows by
77.9% at 10 m, but mean latency rose from 277 ms to 474 ms because query requests
rose from 44 to 138. Nested Page spatial locality and range continuity must be a
writer invariant; merely emitting PageIndexes is not enough.

## Validation

- Dataset: all 125,130 rows in `admin.cogp.parquet`; no sampling.
- Queries: eight cities × three resolutions = 24 cases per file and geometry
  mode.
- Correctness: overview and WKB returned identical row counts in every paired
  query for every Page and RowGroup candidate.
- Repeated evidence: overview-mode bytes and request counts exactly reproduce
  the raw results from the earlier Page sweep; elapsed values vary modestly as
  expected for local timing.
- Limitation: 25 ms RTT is simulated per underlying range read, with no bandwidth
  throttle, TLS setup, CDN behavior, or browser scheduling. The equal-weight
  resolution average is illustrative, not an observed production mix.

## Reproduction and files

Build `cogp-js` from `codex/quantized-overviews`, create the candidate files with
the patch and conversion commands in the earlier benchmark, then run:

```sh
RTT_MS=25 node benchmarks/2026-09-07-admin-overviews/geometry-mode-bench.mjs \
  admin-page64.parquet admin-page128.parquet \
  admin-page256.parquet admin-page512.parquet \
  > geometry-mode-rtt25.json
```

- `geometry-mode-bench.mjs`: paired overview/WKB query harness.
- `geometry-mode-rtt0.json` and `geometry-mode-rtt25.json`: Page sweep raw data.
- `row-group-geometry-mode-rtt25.json`: RowGroup sweep raw data.
- `existing-files-rtt0.json`, `existing-files-rtt25.json`, and
  `existing-files-selection.json`: checked-in-file controls.
- `page-summary.csv`, `row-group-summary.csv`, and `payload-summary.csv`:
  reviewed summary tables.
