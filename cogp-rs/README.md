# cogp

Rust reference CLI for the [Cloud Optimized GeoParquet Profile (COGP)](../SPEC.md).

The convert command uses grid-based density thinning per LoD and
Sort-Tile-Recursive (STR) bbox packing inside each LoD.

## Build

```
cargo build --release
```

## Usage

### Convert a GeoParquet 1.x file into a COGP file

```
# Auto-derive GSDs from Web Mercator zoom levels (default: z0..=z16)
cogp convert input.parquet output.cogp.parquet

# Specify a narrower zoom range
cogp convert input.parquet output.cogp.parquet --minzoom 4 --maxzoom 14

# Or pass explicit GSDs directly
cogp convert input.parquet output.cogp.parquet \
    --gsd 1000000,500000,100000,10000 \
    --row-group-size 10000
```

- `--gsd` — comma-separated GSD list, **meters**, strictly decreasing (coarsest first).
  Mutually exclusive with `--minzoom`/`--maxzoom`.
- `--minzoom` / `--maxzoom` — Web Mercator zoom range used when `--gsd` is omitted
  (defaults 0 and 16). The per-LoD GSD is the Web Mercator per-pixel resolution at
  the equator: `156543.03 m / 2^zoom`. Empty LoDs (no features assigned) are
  automatically dropped.
- `--row-group-size` — max Parquet row group size in rows (default 10000).
- `--input-units` — `auto` (default), `degrees`, or `meters`. `auto` reads the
  GeoParquet `crs` PROJJSON: `ProjectedCRS` → meters, otherwise degrees (absent /
  null `crs` defaults to OGC:CRS84 → degrees). Pass `degrees` or `meters`
  explicitly to override detection.
  **For datasets spanning high latitudes or the antimeridian, reproject to a
  meter-based CRS (UTM, equal-area, etc.) before running `convert`. The
  degree-to-meter conversion is rendering-grade, not geodesic.**
- `--geometry-column` — override the auto-detected primary geometry column.

The output file:

- preserves all original columns (overwriting any pre-existing `bbox` column);
- adds a `bbox` struct column with `xmin/ymin/xmax/ymax: f64`;
- emits one or more row groups per LoD; row group boundaries always align with
  LoD boundaries;
- writes valid GeoParquet 1.1 `geo` metadata that points `covering.bbox` at the
  `bbox` struct column;
- writes COGP `cogp` metadata listing the row-group-end and GSD for each LoD.

Input must use WKB geometry in a `Binary`/`LargeBinary` Arrow column.

### Validate a COGP file

```
cogp validate file.cogp.parquet
```

Checks the structural requirements in [SPEC §5](../SPEC.md):

- GeoParquet 1.x `geo` metadata is present, with a `covering.bbox`;
- each covering bbox column has Parquet row group min/max statistics;
- `cogp` metadata is present with a non-empty `lods` array;
- `row_group_end` values are valid, strictly monotonically increasing, and the
  final one equals `num_row_groups - 1`;
- `gsd` values are positive and strictly monotonically decreasing.

Exit code is non-zero on validation failure.
