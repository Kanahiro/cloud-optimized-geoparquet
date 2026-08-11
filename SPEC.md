---
title: Cloud Optimized GeoParquet Profile (COGP)
version: "0.2.0"
status: Draft
scope: A cloud-optimized progressive rendering profile for GeoParquet 1.1
license: CC BY 4.0
---

# Cloud Optimized GeoParquet Profile (COGP)

## 1. Summary

Cloud Optimized GeoParquet Profile, abbreviated as COGP, is a GeoParquet profile for progressive map rendering and partial access over HTTP range requests or object storage.

A COGP file is:

1. a valid GeoParquet 1.1 file;
2. physically ordered from coarse to fine rendering detail;
3. organized so that each level ends at a Parquet row group boundary;
4. annotated with minimal metadata describing those level boundaries.

COGP keeps a lossless primary geometry while allowing sparse, scale-specific WKB columns for rendering. Feature rows are reordered but never duplicated.

## 2. Motivation

GeoParquet is well suited for geospatial analytics and cloud storage, but ordinary GeoParquet files are not necessarily optimized for progressive visual access.

For map rendering, tile serving, and viewport-driven applications, a reader often wants to:

1. read a coarse overview first;
2. stop when enough detail has been loaded;
3. avoid reading fine-grained features that cannot be independently rendered at the current display scale.

COGP defines a conservative layout convention for this use case while keeping the file readable as ordinary GeoParquet.

## 3. Core Concept

The core idea is:

> Earlier row groups contain features that are independently meaningful at coarse display resolutions. Later row groups add features that are only independently meaningful at finer display resolutions.

COGP's row layout is a **feature-level progressive subset**:

* each source feature is placed, in full, in exactly one row group;
* a feature's primary geometry is preserved verbatim;
* features are assigned to the coarsest level at which they become independently renderable as whole features.

Unlike a tile pyramid, COGP does not duplicate rows across levels. Optional geometry overview columns contain simplified rendering copies and are sparse outside the row prefix where they apply.

A reader can choose how many leading row groups to load based on its target rendering resolution.

For example:

* at a low zoom level, only the first few row groups may be needed;
* at a high zoom level, more row groups are read;
* for a small viewport, bbox covering and row group statistics can further prune unnecessary row groups.

## 4. Terminology

### 4.1 Level

A logical rendering detail level.

Levels are represented by metadata and row group boundaries. This profile does not require a `level`, `zoom`, or `zoomlevel` column in the data.

### 4.2 Ground sample distance (GSD)

`gsd` is the approximate smallest ground distance represented as an independently meaningful unit at this level.

The term is borrowed from raster imagery, where GSD denotes the ground distance represented by one pixel. In COGP it is used by analogy for vector data: the threshold below which features are not represented as independently meaningful at this level.

The value is always expressed in meters of ground distance at the geographic location of the features, independent of the CRS or units used by the underlying data. For example, a file in EPSG:4326 (degrees) still expresses this value in meters.

For example, a level with `gsd` equal to `1000` represents independently meaningful units at approximately 1000 meters or larger, while finer units are deferred to later levels.

For feature levels, `gsd` describes the threshold at which whole features
become independently meaningful. Geometry precision is described separately by
each overview's `tolerance_meters`; linking an overview to a level defines only
which feature prefix that column covers.

This may apply to deferring features such as:

* a pair of point features too close together to be visually distinguished;
* a short linear feature whose overall length is too small to form a visually meaningful shape;
* a small polygon feature that does not form a meaningful rendered shape;
* a polygon feature too small to form at least a minimal visible area at the target display scale.

This value is rendering-oriented. It does not guarantee positional accuracy, topological validity, or analytical precision.

## 5. Requirements

A COGP v0.2 file MUST satisfy the following requirements.

### 5.1 GeoParquet compatibility

The file MUST be a valid GeoParquet 1.1 file.

The file MUST declare bounding box covering metadata under the primary geometry column, at the GeoParquet metadata path:

```text
geo.columns[<primary_column>].covering.bbox
```

where `<primary_column>` is the value of the GeoParquet `primary_column` field.

The primary geometry column's GeoParquet `geometry_types` array MUST be
non-empty and MUST describe exactly one topological family: Point/MultiPoint,
LineString/MultiLineString, or Polygon/MultiPolygon. Singular and Multi variants
of the same family MAY coexist; geometry families MUST NOT be mixed in one COGP
file. GeometryCollection is not supported by this profile.

Each of the bounding box columns (`xmin`, `ymin`, `xmax`, `ymax`) referenced by this covering MUST have Parquet row group min/max statistics present, so that readers can perform spatial pruning at row group granularity.

For COGP v0.2, geometries in the primary geometry column MUST NOT cross the antimeridian in a way that makes GeoParquet bbox covering unsuitable for spatial pruning. Producers SHOULD split such geometries or use another representation before writing a COGP file.

### 5.2 Physical ordering

The file MUST be ordered from coarse to fine rendering detail.

Earlier row groups MUST contain features that are independently meaningful at coarser render resolutions.

Later row groups MUST add features that are independently meaningful only at finer render resolutions.

Every source feature MUST appear in exactly one row group. Its primary geometry and attributes MUST NOT be simplified or aggregated. Geometry overview columns MAY contain simplified copies.

Level ordering is defined with respect to the primary geometry column.

Within each level, features SHOULD be spatially clustered so that row group bounding boxes are tight and spatial pruning by readers is effective.

For LineString and Polygon features, producers SHOULD derive the first visible
level from simplification at the level's rendering tolerance. A LineString
SHOULD be deferred while its simplified length does not exceed that tolerance;
a Polygon SHOULD be deferred while simplification cannot retain a valid
exterior ring. Such features SHOULD NOT be thinned by assigning their bbox
centers to density-grid cells; the simplified geometry is the more direct
signal.

Producers SHOULD spatially sort or pack features within each level before forming row groups. Suitable approaches include, but are not limited to, ordering features by a spatial filling curve such as a Hilbert curve, ordering features by Quadkey or another quadtree-derived key, or using a packed spatial index layout such as STR packing.

### 5.3 Level boundaries

Each level MUST end at a Parquet row group boundary.

The file-level metadata MUST contain a non-empty ordered list of level entries.

Each level entry MUST contain:

* `row_group_end`
* `gsd`

`row_group_end` MUST be a JSON integer satisfying `0 <= row_group_end < num_row_groups`, where `num_row_groups` is the number of Parquet row groups in the file. Row group indices are zero-based.

`row_group_end` values MUST be strictly monotonically increasing across the `levels` array.

The first level entry covers row groups from row group `0` through its `row_group_end`, inclusive.

The row groups belonging to the second and later levels are the row groups after the previous level entry's `row_group_end` through the current level entry's `row_group_end`, inclusive.

The final `row_group_end` value MUST equal `num_row_groups - 1`, so that the levels collectively cover every row group in the file.

`gsd` MUST be a positive JSON number.

`gsd` values MUST be strictly monotonically decreasing from coarse to fine levels.

### 5.4 Progressive access layout

Producers SHOULD choose row group sizes so that each level prefix can be fetched and rendered with bounded latency over HTTP range requests or object storage.

Producers SHOULD avoid placing so many bytes or features in an early row group that the first level is no longer useful as a coarse overview.

When geometry overviews are present, producers SHOULD size row groups using the
geometry column chunks that rendering readers actually project rather than the
lossless primary WKB column. A producer MAY use the largest usable overview WKB
payload as a conservative pre-compression estimate.

This profile does not mandate a specific compressed byte size, feature count, or row group sizing algorithm.

Producers SHOULD derive hierarchy depth from rendering payload rather than a
fixed number of levels or overview columns. One deterministic approach is to
evaluate a candidate GSD ladder whose linear resolution halves at every step,
measure each candidate's simplified WKB prefix, and retain the finest candidate
whose payload is no more than four times the previously retained payload. If
the immediately following candidate already exceeds that bound, it is retained
so progress is guaranteed. Empty candidates are omitted, while the coarsest and
finest occupied candidates are retained. The factor of four corresponds to the
area growth produced by halving linear resolution, as in a raster overview
pyramid.

For this calculation, the simplified WKB prefix at candidate `i` is the sum of
the WKB sizes, simplified independently at candidate `i`'s tolerance, of every
feature introduced at or before candidate `i`. Producers SHOULD use the prefix
maximum of this sequence so that hierarchy selection is monotonic even when a
particular simplification result is anomalously smaller at a finer tolerance.

### 5.5 Geometry overview columns

Each geometry overview MUST link to one entry in `levels`. Its physical WKB
column MUST be non-null from row group `0` through the linked level's
`row_group_end`, inclusive, and MUST be null in every later row group.
Each entry MUST declare `tolerance_meters` as a positive finite number giving
the maximum spatial simplification tolerance in meters. This value is
independent of the linked level: `level` describes completeness, while
`tolerance_meters` describes geometric precision.

Within one overview column, producers MUST apply one scale-derived spatial
tolerance consistently to all non-point geometries. Producers MUST derive each
overview directly from the lossless primary geometry or from an equivalent
progressive hierarchy; simplification error MUST NOT accumulate by repeatedly
simplifying the previous overview. Point geometries remain unchanged.

Geometry overview entries MUST be ordered by strictly increasing level index
and strictly decreasing `tolerance_meters`.
When `geometry_overviews` is non-empty, its final entry MUST link to the final
entry in `levels`. This makes the finest overview non-null across the complete
feature ladder, allowing rendering readers to avoid projecting the lossless
primary geometry.
Their columns MUST be nullable WKB geometry columns declared in GeoParquet
metadata. The primary geometry MUST remain unchanged and non-null wherever the
source geometry is non-null.

## 6. Metadata

The file MUST include a Parquet file-level key-value metadata entry named:

```text
cogp
```

The value MUST be a UTF-8 JSON object.

### 6.1 Versioning and forward compatibility

The `version` field is a string of the form `MAJOR.MINOR.PATCH` and identifies the COGP profile version. It follows semantic versioning:

* a minor version increment (for example `0.1.0` to `0.2.0`, or `1.0.0` to `1.1.0`) MAY add new optional fields, but MUST NOT change the meaning or requirements of existing fields;
* a major version increment (for example `0.x.y` to `1.0.0`, or `1.x.y` to `2.0.0`) MAY introduce breaking changes.

Readers MUST ignore unrecognized fields in `cogp` metadata so that files written against a newer minor version of the profile remain readable.

Readers MUST NOT interpret `cogp` metadata with an unsupported major version as conforming to this version of the profile.

### 6.2 Minimal example

```json
{
  "version": "0.2.0",
  "levels": [
    {
      "row_group_end": 0,
      "gsd": 1000
    },
    {
      "row_group_end": 3,
      "gsd": 500
    },
    {
      "row_group_end": 12,
      "gsd": 100
    }
  ],
  "geometry_overviews": [
    { "column": "geometry_ovr_0", "level": 0, "tolerance_meters": 250 },
    { "column": "geometry_ovr_1", "level": 1, "tolerance_meters": 100 },
    { "column": "geometry_ovr_2", "level": 2, "tolerance_meters": 25 }
  ]
}
```

### 6.3 Field definitions

| Field                  | Required | Description                                                                                                       |
| ---------------------- | -------: | ----------------------------------------------------------------------------------------------------------------- |
| `version`              |      Yes | Profile metadata version.                                                                                         |
| `levels`                 |      Yes | Ordered level entries from coarse to fine.                                                                        |
| `levels[].row_group_end` |      Yes | Inclusive row group index ending this level.                                                                      |
| `levels[].gsd`           |      Yes | Approximate smallest independently meaningful ground distance represented by this level, in meters.                |
| `geometry_overviews` | No | Sparse rendering WKB columns ordered from coarse to fine. |
| `geometry_overviews[].column` | No | Physical nullable WKB column declared in GeoParquet metadata. |
| `geometry_overviews[].level` | No | Zero-based index into `levels`, defining the non-null boundary. |
| `geometry_overviews[].tolerance_meters` | No | Positive spatial simplification tolerance in meters. |

## 7. Reader guidance (non-normative)

COGP metadata describes available levels but does not prescribe how a reader uses them. This section sketches typical patterns.

### 7.1 Level selection

A renderer can base the choice of level on zoom level, map scale, screen-space error, or any application-specific budget for bytes, features, or latency.

One common strategy is to derive a target ground sample distance from the current display scale and select the finest level whose `gsd` is still coarser than or equal to that target. Because `levels` are ordered from coarse to fine and `gsd` values strictly decrease, this is the last level satisfying:

```text
gsd >= target_gsd
```

If no level satisfies this condition, the target resolution is coarser than the coarsest level in the file, and the reader can select the first level.

### 7.2 Reading the selected prefix

The prefix of row groups from `0` through the selected level's `row_group_end` is the minimal set of features needed to produce a meaningful render at the target display scale. Features that would not be visually meaningful at that scale are deferred to later levels and are not fetched. The prefix is the data appropriate for the chosen scale, not a preview to be replaced.

Two reading styles are both valid:

* **Bounded read.** Fetch exactly the selected prefix and stop. Total transfer volume is bounded by the selected scale, which suits bandwidth-sensitive clients such as WebGIS applications.
* **Progressive render.** Render features incrementally as row groups arrive, drawing coarser row groups first. This suits interactive viewers that want first paint as early as possible.

Implementations typically fetch the Parquet footer to obtain `cogp` metadata and per-row-group statistics, then issue HTTP range requests for the row groups in `0..row_group_end` — in parallel or in order, with rendering either streamed or deferred to completion.

For viewport-driven applications, two complementary spatial filters can apply within the selected prefix:

* **Row group pruning.** Using per-row-group min/max statistics of the bbox covering columns (Section 5.1), row groups whose bbox does not intersect the viewport can be skipped, avoiding the range request entirely.
* **Per-feature bbox filter.** Within a fetched row group, the bbox covering columns can be evaluated as a predicate to skip individual features. This is the standard GeoParquet bbox covering filter and remains fully effective in COGP files.

If the view changes — for example, the user zooms in — the reader fetches only the additional row groups it needs. Because COGP does not duplicate features across levels, previously-read row groups remain valid.

### 7.3 Geometry overview selection

Feature selection and geometry selection are related but independent. A reader
first selects the row prefix as described in Section 7.1. It then selects the
first geometry overview, in metadata order, that satisfies both:

```text
overview.level >= selected_feature_level
overview.tolerance_meters <= target_gsd
```

The first condition guarantees that the chosen column is non-null throughout
the selected row prefix. The second guarantees that its simplification scale is
no coarser than the requested display scale. If no overview satisfies both
conditions, a lossless reader selects the primary geometry. A bounded rendering
reader may instead select the finest overview that covers the prefix, accepting
its declared simplification tolerance rather than fetching raw WKB. In
particular, LineString and Polygon streaming readers can use this rule to keep
the lossless primary column entirely out of their `target_gsd` read path. A
reader needs to project only the selected physical geometry column and exposes
it logically under the primary geometry column name.

## 8. Validation

A validator verifies that the file meets all requirements stated in Section 5.

The semantic correctness of coarse-to-fine ordering — whether the features placed in earlier row groups are genuinely meaningful at coarser display resolutions — is not fully machine-verifiable. Validators can only check structural and metadata conformance. Achieving meaningful level semantics is a producer responsibility.

A validator MAY also compute non-conformance quality metrics such as row group touch count for sample bbox queries, prefix rendering latency, spatial spread of coarse levels, or spatial clustering quality within each level.

## 9. Non-goals

This profile does not define:

* a new geometry encoding;
* a new CRS model;
* a new tile matrix set;
* a mandatory simplification algorithm;
* a mandatory thinning algorithm;
* a mandatory spatial clustering algorithm;
* analytical accuracy guarantees;
* topology preservation guarantees;
* standalone prefix-Parquet semantics;
* SQL query semantics.

## License

This specification is licensed under [Creative Commons Attribution 4.0
International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
See [`LICENSE-SPEC`](./LICENSE-SPEC) for the full license text.
