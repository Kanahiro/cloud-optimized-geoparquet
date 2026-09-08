# POI PageIndex layout benchmark — 2026-09-07

## Decision

POIs need a different physical layout from administrative polygons:

- **Nested Page-level STR remains required.** It reduced PageIndex-selected rows
  by 66–71% and reduced real query transfer by 23–41% versus RowGroup-only STR.
- **Use 512 rows per Page for POIs.** It was the joint minimum for mean query
  bytes and 25 ms-RTT latency. Pages below 512 pay too much index/header cost;
  Pages above 512 admit too many false-positive rows.
- **Use 32,768 rows per RowGroup as the normal POI profile.** It was the fastest
  tested RowGroup at every resolution and kept the smallest file size.
- **Offer 4,096 rows per RowGroup as a bandwidth-constrained profile.** Under a
  simple aggregate-bandwidth model it wins below roughly 40 Mbps because it
  prunes much more data at RowGroup granularity.
- **Do not use 65,536 rows as the POI default.** It was dominated by 32,768:
  larger transfer, larger file, and no latency advantage.

The full-data validation used the conservative 16,384-row candidate because it
was generated before the 32,768 midpoint was added. It still beat the existing
POI PageIndex file by 18–31% in latency and 10% in file size.

## Data and workload

- Source: `pois.cogp.parquet`, 30,052,264 unique world-wide OSM Point features.
- Controlled sweep: deterministic 10% sample selected with
  `hash(id) % 10 = 0`, yielding 3,004,499 unique Points while retaining the
  global spatial extent.
- Full validation: all 30,052,264 Points.
- Layout: 17 COGP levels, identical schema, ZSTD settings, bbox columns,
  PageIndex behavior, and point-thinning parameters.
- Queries: Tokyo, Osaka, Nagoya, Sapporo, Fukuoka, Sendai, Hiroshima, and Naha;
  512×512-pixel-equivalent viewports at 1,000 m, 100 m, and 10 m.
- Projection: `id` and `geometry`; the variable-length `tags` MAP was excluded
  from reads so its payload did not mask layout effects.
- Transport model: 25 ms delay per underlying range read; concurrent reads can
  overlap and aggregate bandwidth is not throttled.
- Each controlled read sweep was run twice. One first-run sample stalled for
  970 seconds; it is retained in `read-all-rtt25.json`, was not reproducible,
  and was replaced by the clean rerun for aggregate latency.

## Page size: 512 rows is the knee

RowGroup size was fixed at 65,536 rows. Values below are the three-resolution
mean; detailed per-resolution rows are in `page-tradeoff.csv`.

| Page rows | file MB | mean query KB | mean RTT25 ms |
|---:|---:|---:|---:|
| 64 | 537.3 | 3,604 | 396 |
| 128 | 420.8 | 2,937 | 363 |
| 256 | 360.9 | 2,643 | 340 |
| **512** | **330.3** | **2,551** | **332** |
| 1,024 | 314.4 | 2,620 | 338 |
| 2,048 | 306.2 | 2,861 | 347 |
| 4,096 | 301.9 | 3,364 | 370 |

Smaller Pages do improve PageIndex selectivity: at 10 m, selected rows rose from
1,856 at Page 64 to 7,552 at Page 512. However, POI rows are small enough that
the extra PageIndexes, OffsetIndexes, page headers, and fragmented reads cost
more than those false positives. Above 512, false positives dominate again.

## RowGroup size: 32,768 wins normal networks

Page size was fixed at 512 rows.

| RowGroup rows | file MB | footer KB | mean query KB | mean RTT25 ms |
|---:|---:|---:|---:|---:|
| 4,096 | 334.9 | 6,056 | 465 | 503 |
| 8,192 | 329.4 | 3,175 | 648 | 500 |
| 16,384 | 326.8 | 1,623 | 970 | 453 |
| **32,768** | **326.5** | **872** | 1,437 | **303** |
| 65,536 | 330.3 | 483 | 2,551 | 335 |

RowGroup 32,768 was faster than 65,536 because the larger candidate envelopes
at 65,536 forced substantially more PageIndex and data transfer without reducing
range count enough to compensate. The footer continues shrinking, but footer
size alone is not the optimization target.

To expose the bandwidth trade-off, `estimated_ms` adds the unavoidable serial
transfer time (`mean_query_KiB × 8.192 / Mbps`) to measured RTT25 latency, with
the three resolutions equally weighted:

| RowGroup rows | 20 Mbps | 50 Mbps | 100 Mbps | 200 Mbps |
|---:|---:|---:|---:|---:|
| **4,096** | **693 ms** | 579 ms | 541 ms | 522 ms |
| 8,192 | 765 ms | 606 ms | 553 ms | 527 ms |
| 16,384 | 849 ms | 611 ms | 531 ms | 492 ms |
| **32,768** | 892 ms | **539 ms** | **421 ms** | **362 ms** |
| 65,536 | 1,379 ms | 753 ms | 544 ms | 439 ms |

The 4,096 and 32,768 curves cross at about 40 Mbps under this simplified model.
Real HTTP concurrency and CDN behavior can move that threshold.

## Nested Page packing materially improves POIs

The control held RowGroups at 16,384 and Pages at 256:

| Resolution | selected rows reduction | query bytes reduction | requests reduction | latency reduction |
|---:|---:|---:|---:|---:|
| 1,000 m | 71.4% | 41.4% | 39.5% | 30.2% |
| 100 m | 67.4% | 30.2% | 34.9% | 17.6% |
| 10 m | 65.6% | 23.1% | 31.4% | 11.4% |

Unlike the administrative-polygon control, better selected-row locality also
translated directly into fewer bytes and lower latency for Points.

## Full 30M-row validation

The full candidate used RowGroup 16,384 / Page 512 / Nested STR and was compared
with `cogp-js/demo/pois.page-index.cogp.parquet`.

| Metric | existing | candidate | change |
|---|---:|---:|---:|
| File size | 3,315.5 MB | 2,973.1 MB | -10.3% |
| RowGroups | 3,012 | 1,843 | -38.8% |
| Footer | 25.7 MB | 15.7 MB | -38.8% |

| Resolution | latency change | query bytes change | request change |
|---:|---:|---:|---:|
| 1,000 m | -30.6% | -5.4% | -9.0% |
| 100 m | -25.1% | -3.0% | -6.5% |
| 10 m | -18.5% | +12.4% | -0.3% |

All 24 viewport queries returned identical row counts in both layouts. The 10 m
byte regression is a real caveat, but did not erase the latency improvement in
the tested 25 ms RTT environment.

## Reproduction notes

The experiment used the same temporary writer controls documented in the
administrative benchmark. Both the spatial packing boundary and the Parquet
writer boundary must be set:

```sh
target/release/cogp convert pois-10pct.parquet candidate.parquet \
  --row-group-size 32768 \
  --fixed-row-group-rows 32768 \
  --page-row-count 512 \
  --row-group-max-bytes 1073741824

RTT_MS=25 ID_COLUMN=id GEOMETRY_COLUMN=geometry \
  node benchmarks/2026-09-06-page-index-layout/read-bench.mjs \
  candidate.parquet
```

An early full candidate accidentally set only `--fixed-row-group-rows`; the
writer therefore retained its 10,000-row default and emitted 3,012 RowGroups.
That run is preserved as preliminary evidence but excluded from controlled
RowGroup conclusions.

## Limits

- The complete matrix uses a deterministic 10% sample; only the conservative
  16,384/512 candidate was validated on all 30M Points.
- The bandwidth sensitivity is a simple additive model, not an HTTP/2 or HTTP/3
  simulator.
- The workload is Japan-centric while the file is global.
- `tags` was intentionally not projected. Attribute-heavy popup or search
  workloads need a separate benchmark.
- Candidate files used a 1 GiB geometry byte cap to isolate row-count effects;
  production still needs a byte/index safety cap.

## Evidence files

- Summary: `page-tradeoff.csv`, `row-group-tradeoff.csv`, `locality.csv`,
  `bandwidth-sensitivity.csv`, and `full-validation.csv`.
- Raw reader runs: `read-*.json`.
- Raw PageIndex RowSelection counts: `page-selection-*.json`.
- Parquet file/footer metadata: `*-metadata.csv`.

Generated Parquet candidates are omitted because they occupy several gigabytes.
