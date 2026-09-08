# POI dictionary-page benchmark — 2026-09-07

## Decision

The 1 MiB Parquet dictionary default is the cause of the large `id` transfer
seen with 64k RowGroups. A sparse PageIndex read still needs the dictionary for
each selected column chunk, so a high-cardinality dictionary can dominate the
selected data pages.

- **32 KiB is the practical dictionary-page knee.** On the full 30,052,264-row
  POI file at RowGroup 65,536 / Page 512, it reduced `id + geometry` transfer by
  62–70% and increased file size by 1.7%.
- **16 KiB is the bandwidth-first profile, not the default.** It minimized
  bytes on the controlled sample but increased file size by 5.6% at 64k
  RowGroups, versus 2.8% at 32 KiB.
- **32k RowGroups remain the POI-optimized profile.** At the same 32 KiB cap,
  they produced a 1.6% smaller sample file and 6–13% less query transfer than
  64k RowGroups. Keeping 64k as the general default is still reasonable.
- **Run a `tags`-inclusive smoke before changing the default.** The cap is
  global. Low-cardinality columns are unaffected, but medium-cardinality nested
  tag dictionaries can fall back earlier and account for most file growth.

The converter now exposes `--dictionary-page-size-limit`; omission preserves
the current Parquet 1 MiB behavior. The benchmark does not change the schema.

## Full-data result

Both files contain 30,052,264 rows, 468 RowGroups, 512-row Pages, and the same
schema. All 24 queries returned the same `id` fingerprints and candidate
RowGroup counts.

| Metric | 1 MiB baseline | 32 KiB cap | change |
|---|---:|---:|---:|
| File bytes | 2,306,896,690 | 2,346,565,901 | +1.7% |
| RowGroups | 468 | 468 | 0% |

| resolution | baseline MiB | 32 KiB MiB | bytes change | requests change | local time change | 100 Mbps estimate change |
|---:|---:|---:|---:|---:|---:|---:|
| 1,000 m | 1.878 | 0.708 | -62.3% | +6.1% | -23.7% | -23.9% |
| 100 m | 2.884 | 0.943 | -67.3% | +17.5% | -15.9% | -23.7% |
| 10 m | 3.706 | 1.110 | -70.0% | +22.9% | -9.9% | -23.8% |

The raw 25 ms-RTT wall time stayed flat because ranges issued together overlap.
The 100 Mbps estimate adds serial payload time to that observed wall time and
therefore exposes the user-visible benefit of transferring fewer bytes.

## Controlled 10% sweep

The deterministic sample uses `hash(id) % 10 = 0`: 3,004,499 unique worldwide
Points. Values below are means over eight cities and three resolutions.
File deltas and query-byte deltas use the 1 MiB candidate at the same RowGroup
size as baseline.

| RowGroup | dictionary KiB | file MB | file delta | mean query MiB | query-byte delta | RTT25 ms | estimated 100 Mbps ms |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 32k | 16 | 258.47 | +6.3% | 0.627 | -60.9% | 279.6 | 332.2 |
| 32k | **32** | **250.50** | **+3.1%** | **0.717** | **-55.2%** | **280.5** | **340.7** |
| 32k | 64 | 250.62 | +3.1% | 0.893 | -44.3% | 281.0 | 355.9 |
| 32k | 128 | 251.02 | +3.3% | 1.169 | -27.1% | 280.7 | 378.7 |
| 32k | 256 | 251.66 | +3.5% | 1.603 | +0.0% | 281.1 | 415.5 |
| 32k | 1,024 | 243.04 | baseline | 1.603 | baseline | 282.5 | 417.0 |
| 64k | 16 | 261.59 | +5.6% | 0.708 | -73.9% | 300.4 | 359.8 |
| 64k | **32** | **254.62** | **+2.8%** | **0.796** | **-70.6%** | **302.0** | **368.7** |
| 64k | 64 | 250.02 | +1.0% | 0.967 | -64.3% | 302.5 | 383.6 |
| 64k | 128 | 250.27 | +1.1% | 1.256 | -53.6% | 303.9 | 409.3 |
| 64k | 256 | 250.72 | +1.2% | 1.854 | -31.5% | 307.6 | 463.2 |
| 64k | 1,024 | 247.65 | baseline | 2.707 | baseline | 314.5 | 541.6 |

The actual `id` dictionary per RowGroup averaged about 20 KiB at the 32 KiB
setting. At RowGroup 32k, the natural full `id` dictionary was about 145 KiB,
so 256 KiB and 1 MiB transferred the same `id` payload. Their file sizes still
differ because the global cap also changes other dictionary-encoded columns.

## Workload and model

- Input projection: `id,geometry`; `bbox` is added internally for exact spatial
  filtering.
- Viewports: 512×512-pixel-equivalent bboxes around Tokyo, Osaka, Nagoya,
  Sapporo, Fukuoka, Sendai, Hiroshima, and Naha.
- Resolutions: 1,000 m, 100 m, and 10 m.
- Writer: ZSTD level 3, 17 COGP levels, nested Page STR, 512 rows/Page, 1 GiB
  RowGroup byte cap to isolate row-count effects.
- Reader: current `cogp-js`, PageIndex enabled, nearby concurrent ranges
  coalesced, with a cold per-reader 64 MiB in-memory range cache. Each sample
  constructs a new reader, so results do not include cross-query cache hits.
- RTT model: 25 ms delay per underlying range read; concurrent reads overlap.
- Bandwidth model: `RTT25 wall time + query bytes × 8 / Mbps`.

## Reproduction

Create the controlled sample:

```sh
duckdb -c "COPY (
  SELECT id, tags, geometry
  FROM read_parquet('pois.cogp.parquet')
  WHERE hash(id) % 10 = 0
) TO '/tmp/cogp-pois-dictionary-bench/pois10.parquet'
  (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 65536);"
```

Generate a candidate:

```sh
target/release/cogp convert \
  /tmp/cogp-pois-dictionary-bench/pois10.parquet \
  /tmp/cogp-pois-dictionary-bench/pois10-rg65536-p512-dict32k.parquet \
  --row-group-size 65536 \
  --page-row-count 512 \
  --dictionary-page-size-limit 32768 \
  --row-group-max-bytes 1073741824
```

Run the reader benchmark and summaries:

```sh
PROJECTION=id,geometry RTT_MS=25 REPEATS=2 \
  node benchmarks/2026-09-07-pois-dictionary-pages/read-bench.mjs \
  /tmp/cogp-pois-dictionary-bench/pois10-rg65536-p512-dict32k.parquet

node benchmarks/2026-09-07-pois-dictionary-pages/summarize.mjs
python3 benchmarks/2026-09-07-pois-dictionary-pages/execute_notebook.py \
  benchmarks/2026-09-07-pois-dictionary-pages/analysis.ipynb
```

Candidate Parquet files remain under `/tmp/cogp-pois-dictionary-bench` and are
not checked into the repository.

## Evidence

- Analysis notebook: `analysis.ipynb`
- Derived tables: `controlled-summary.csv`, `controlled-by-resolution.csv`,
  `full-summary.csv`, `file-metadata.csv`
- Query correctness checks: `validation.json`
- Raw reads: `read-rtt0*.json`, `read-rtt25*.json`
- Scripts: `read-bench.mjs`, `summarize.mjs`, `execute_notebook.py`

## Limits

- Only the 64k/512/32KiB candidate was validated on all 30M rows.
- The city sample is Japan-centric even though the source is worldwide.
- `tags` was excluded from reads; its transfer behavior is the next required
  test before choosing an automatic global cap.
- The RTT/bandwidth calculation is a controlled transport model, not a browser,
  CDN, HTTP/2, or HTTP/3 end-to-end measurement.
