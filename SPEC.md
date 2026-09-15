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

COGP keeps a lossless primary geometry. Line and Polygon families also store
sparse, scale-specific integer rendering geometries in an `overviews` struct;
Point families render directly from their compact primary WKB. Feature rows
are reordered but never duplicated.

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

Unlike a tile pyramid, COGP does not duplicate rows across levels. For Line and
Polygon families, the `overviews` struct contains simplified rendering copies
and is sparse outside the row prefixes where each LoD applies.

A reader can choose how many leading row groups to load based on its target rendering resolution.

For example:

* at a low zoom level, only the first few row groups may be needed;
* at a high zoom level, more row groups are read;
* for a small viewport, bbox covering and row group statistics can further prune unnecessary row groups.

## 4. Terminology

### 4.1 Level

A logical rendering detail level.

Each level selects a prefix of feature rows and, for Line and Polygon
families, an overview LoD. A finer level may refine the geometry representation
without adding feature rows.

Levels are represented by metadata and row group boundaries. This profile does not require a `level`, `zoom`, or `zoomlevel` column in the data.

### 4.2 Ground resolution

`resolution` is the nominal ground resolution for which a level's
feature prefix and geometry representation are intended to be rendered.

The value is always expressed in meters of ground distance at the geographic location of the features, independent of the CRS or units used by the underlying data. For example, a file in EPSG:4326 (degrees) still expresses this value in meters.

For example, a level with `resolution` equal to `1000` contains the
feature prefix and geometry representation intended for rendering at an
approximately 1000-meter ground resolution. Finer detail is deferred to later
levels.

This may apply to deferring features such as:

* a pair of point features too close together to be visually distinguished;
* a short linear feature whose overall length is too small to form a visually meaningful shape;
* a small polygon feature that does not form a meaningful rendered shape;
* a polygon feature too small to form at least a minimal visible area at the target display scale.

This value is rendering-oriented. It is not a measured geometric error or an
accuracy guarantee, and it does not guarantee positional accuracy, topological
validity, or analytical precision.

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

Producers SHOULD also write a Parquet ColumnIndex and OffsetIndex for each of
these four bbox leaves. Columns intended for viewport rendering, including the
primary WKB for Point families and the `overviews` leaves for Line and Polygon
families, SHOULD have an OffsetIndex. This lets a reader translate a
bbox predicate into row ranges within an intersecting row group and request
only the corresponding pages from projected columns. Missing page indexes do
not make a file non-conforming; readers MUST fall back conservatively to row
group pruning.

The primary WKB column MUST NOT have Parquet column statistics. Binary min/max
statistics are not useful for spatial pruning and may copy WKB values into the
footer that every reader must fetch.

For COGP v0.2, geometries in the primary geometry column MUST NOT cross the antimeridian in a way that makes GeoParquet bbox covering unsuitable for spatial pruning. Producers SHOULD split such geometries or use another representation before writing a COGP file.

### 5.2 Physical ordering

The file MUST be ordered from coarse to fine rendering detail.

Earlier row groups MUST contain features that are independently meaningful at coarser render resolutions.

Later row groups MUST add features that are independently meaningful only at finer render resolutions.

Every source feature MUST appear in exactly one row group. Its primary geometry
and attributes MUST NOT be simplified or aggregated. For Line and Polygon
families, the rendering geometries inside `overviews` are simplified copies and
MUST NOT be used for analysis.

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
* `resolution`

For Line and Polygon families, each level entry MUST also contain `lod`. For
Point families, `lod` MUST be absent.

`row_group_end` MUST be a JSON integer satisfying `0 <= row_group_end < num_row_groups`, where `num_row_groups` is the number of Parquet row groups in the file. Row group indices are zero-based.

`row_group_end` values MUST be monotonically non-decreasing across the `levels`
array. Consecutive levels MAY select the same row group prefix while selecting
different LoDs.

The first level entry covers row groups from row group `0` through its `row_group_end`, inclusive.

The row groups belonging to the second and later levels are the row groups after the previous level entry's `row_group_end` through the current level entry's `row_group_end`, inclusive.

When consecutive boundaries are equal, the later level adds no row groups.
Its selected prefix still includes every row group from `0` through that
boundary. Levels MUST NOT select an empty prefix.

The final `row_group_end` value MUST equal `num_row_groups - 1`, so that the levels collectively cover every row group in the file.

`resolution` MUST be a positive finite JSON number.

`resolution` values MUST be strictly monotonically decreasing from coarse to fine levels.

For Line and Polygon families, `lod` MUST be a non-empty name present in
`overviews.lods` and MUST name a direct child of the physical `overviews`
struct. There is no implicit default LoD. Point families render their primary
WKB and do not declare an LoD.

### 5.4 Progressive access layout

Producers SHOULD choose row group sizes so that each level prefix can be fetched and rendered with bounded latency over HTTP range requests or object storage.

Producers SHOULD avoid placing so many bytes or features in an early row group that the first level is no longer useful as a coarse overview.

For Line and Polygon families, producers SHOULD size row groups using the
`overviews` leaf column chunks that rendering readers actually project rather
than the lossless primary WKB column. A producer MAY use the largest usable
overview payload as a conservative pre-compression estimate. For Point
families, producers SHOULD use the primary WKB payload.

When writing page indexes, producers SHOULD bound data pages by row count and
align page boundaries across bbox and rendering columns. A row group containing
only one large bbox page cannot be pruned within that row group, while very
small pages increase index size and range-request count. The precise page size
is producer-specific.

This profile does not mandate a specific compressed byte size, feature count, or row group sizing algorithm.

Producers SHOULD preserve each requested candidate ground resolution that
introduces at least one feature. For Line and Polygon families, producers
SHOULD also preserve subsequent requested candidates that refine existing
features, even when no new features are assigned to them. These candidates
select the existing row group prefix with an appropriate LoD. Candidates
before the first feature appears MAY be omitted. For Point families,
candidates that introduce no features MAY be omitted.

### 5.5 Overview encoding

Point-family files MUST NOT contain a top-level `overviews` column or
`cogp.overviews` metadata. Point and MultiPoint coordinates cannot be
simplified usefully, so rendering readers project the primary WKB column.

Line- and Polygon-family files MUST contain exactly one top-level column named
`overviews`, with this logical structure:

```text
overviews: required struct<
  geometry_type: required int8,
  <lod>: nullable struct<
    coordinates: required list<required struct<
      x: required int32,
      y: required int32
    >>,
    part_ends: required list<required int32>,
    polygon_ends: required list<required int32>
  >,
  ...
>
```

Every key in `cogp.overviews.lods` MUST name exactly one `<lod>` child, and
every `<lod>` child MUST have corresponding metadata. Every LoD MUST be
referenced by at least one level. LoD names MUST NOT be `geometry_type`.
`geometry_type` uses the
base OGC WKB type codes: `2` LineString, `3` Polygon, `5` MultiLineString, and
`6` MultiPolygon. GeometryCollection is not permitted. A row's `geometry_type`
MUST describe every non-null LoD in
that row. In particular, a producer whose polygon repair can split a Polygon
at some resolutions MUST encode all of that row's polygon LoDs as MultiPolygon;
an unsplit Polygon is represented as a one-member MultiPolygon in those LoDs.

`coordinates` is the flattened coordinate sequence. Its separated `x` and `y`
leaves share the list's single offset buffer, so coordinate pairing and equal
axis lengths are structural properties of the schema. A coordinate is decoded
using the LoD metadata:

```text
x_decoded = offset[0] + scale[0] * x_integer
y_decoded = offset[1] + scale[1] * y_integer
```

For LineString, both end arrays are empty. For Polygon,
`part_ends` contains the exclusive end of each ring. For MultiLineString it
contains the exclusive end of each line. For MultiPolygon, `part_ends`
contains the exclusive end of each ring and `polygon_ends` contains the
exclusive end, in ring count, of each polygon. Empty and null primary
geometries are outside this version of the profile.

For each LoD, its effective boundary is the maximum `row_group_end` among all
levels referencing it. The LoD MUST be non-null for every row from row group
`0` through that effective boundary, inclusive, and MUST be null in every
later row group. Multiple levels MAY reference the same LoD. This makes each
selected prefix independently renderable without a per-row fallback. In
particular, a rendering reader MUST NOT fall back to the primary WKB column
when an overview value is absent.

For each LoD, producers MUST choose one positive scale per axis and apply it to
all rows. The quantization scale and simplification tolerance SHOULD be derived
from the finest `resolution` of any level referencing that LoD. Producers MUST
derive every LoD directly from the lossless primary geometry or from an
equivalent progressive hierarchy; error MUST NOT accumulate by repeatedly
simplifying the previous LoD. The primary geometry remains unchanged.

Only XY is represented in `overviews`. Z and M ordinates, when present in the
primary geometry, are intentionally omitted.

Decoded overview coordinates use the primary geometry's CRS, XY axis order,
and coordinate units. Spatial selection MUST evaluate the primary geometry's
covering bbox, independent of the selected LoD. Overviews represent the
selected features for rendering; their bounds MUST NOT replace or expand the
primary bbox predicate.

## 6. Metadata

The file MUST include a Parquet file-level key-value metadata entry named:

```text
cogp
```

The value MUST be a UTF-8 JSON object.

### 6.1 Versioning and forward compatibility

The `version` field is a string of the form `MAJOR.MINOR.PATCH` and identifies
the COGP profile version.

* Before `1.0.0`, minor versions are development drafts and MAY introduce
  breaking changes. Readers MUST explicitly support a draft's major/minor
  version before interpreting its metadata as conforming.
* From `1.0.0`, minor versions MAY add optional fields but MUST NOT change the
  meaning or requirements of existing fields. Major versions MAY introduce
  breaking changes.
* Patch versions MUST NOT introduce breaking changes.

Readers MUST ignore unrecognized fields in supported `cogp` metadata versions.

Readers MUST NOT interpret `cogp` metadata with an unsupported major version as conforming to this version of the profile.

Version `0.2.0` allows equal consecutive row group boundaries and shared LoDs
with an effective boundary. Support for `0.2` does not imply support for every
`0.x` draft.

### 6.2 Minimal example

Line/Polygon example, using a primary CRS whose coordinate units are meters.
The transform values are illustrative:

```json
{
  "version": "0.2.0",
  "levels": [
    {
      "row_group_end": 0,
      "resolution": 1000,
      "lod": "l0"
    },
    {
      "row_group_end": 0,
      "resolution": 500,
      "lod": "l1"
    },
    {
      "row_group_end": 3,
      "resolution": 250,
      "lod": "l1"
    },
    {
      "row_group_end": 3,
      "resolution": 100,
      "lod": "l2"
    }
  ],
  "overviews": {
    "encoding": "quantized_xy_v1",
    "lods": {
      "l0": { "scale": [256, 256], "offset": [0, 0] },
      "l1": { "scale": [64, 64], "offset": [0, 0] },
      "l2": { "scale": [32, 32], "offset": [0, 0] }
    }
  }
}
```

This example has four row groups. At resolution 500, the feature prefix is
unchanged and the reader switches to `l1`. At resolution 250, row groups 1–3
are added using the same `l1`. At resolution 100, the reader switches the same
prefix to `l2`. The effective boundaries of `l0`, `l1`, and `l2` are 0, 3,
and 3, respectively.

Point-family example:

```json
{
  "version": "0.2.0",
  "levels": [
    { "row_group_end": 0, "resolution": 1000 },
    { "row_group_end": 3, "resolution": 100 }
  ]
}
```

### 6.3 Field definitions

| Field | Required | Description |
| --- | ---: | --- |
| `version` | Yes | Profile metadata version. |
| `levels` | Yes | Ordered level entries from coarse to fine. |
| `levels[].row_group_end` | Yes | Inclusive end of the selected row group prefix; non-decreasing across levels. |
| `levels[].resolution` | Yes | Nominal ground resolution for which the level is intended, in meters. |
| `levels[].lod` | Line/Polygon only | Required child name in both the physical `overviews` struct and `overviews.lods`; may be shared by levels; absent for Point families. |
| `overviews` | Line/Polygon only | Metadata for the fixed physical `overviews` column; absent for Point families. |
| `overviews.encoding` | Line/Polygon only | Must be `quantized_xy_v1` for this version. |
| `overviews.lods` | Line/Polygon only | Non-empty object keyed by LoD child name. |
| `overviews.lods.<lod>.scale` | Line/Polygon only | Two positive finite numbers used to decode integer X and Y. |
| `overviews.lods.<lod>.offset` | Line/Polygon only | Two finite numbers used to decode integer X and Y. |

## 7. Reader guidance (non-normative)

COGP metadata describes available levels but does not prescribe how a reader uses them. This section sketches typical patterns.

### 7.1 Level selection

A renderer can base the choice of level on zoom level, map scale, screen-space error, or any application-specific budget for bytes, features, or latency.

One common strategy is to derive a target ground resolution from the current
display scale and select the finest level whose `resolution` is still
coarser than or equal to that target. Because `levels` are ordered from coarse
to fine and `resolution` values strictly decrease, this is the last
level satisfying:

```text
resolution >= target_resolution
```

If no level satisfies this condition, the target resolution is coarser than the coarsest level in the file, and the reader can select the first level.

### 7.2 Reading the selected prefix

The prefix of row groups from `0` through the selected level's `row_group_end` is the minimal set of features needed to produce a meaningful render at the target display scale. Features that would not be visually meaningful at that scale are deferred to later levels and are not fetched. The prefix is the data appropriate for the chosen scale, not a preview to be replaced.

Two reading styles are both valid:

* **Bounded read.** Fetch exactly the selected prefix and stop. Total transfer volume is bounded by the selected scale, which suits bandwidth-sensitive clients such as WebGIS applications.
* **Progressive render.** Render features incrementally as row groups arrive, drawing coarser row groups first. This suits interactive viewers that want first paint as early as possible.

Implementations typically fetch the Parquet footer to obtain `cogp` metadata and per-row-group statistics, then issue HTTP range requests for the row groups in `0..row_group_end` — in parallel or in order, with rendering either streamed or deferred to completion.

For viewport-driven applications, three complementary spatial filters can apply within the selected prefix:

* **Row group pruning.** Using per-row-group min/max statistics of the bbox covering columns (Section 5.1), row groups whose bbox does not intersect the viewport can be skipped, avoiding the range request entirely.
* **Page pruning.** When bbox ColumnIndexes and projected-column OffsetIndexes
  are available, evaluate the same four covering predicates against page
  min/max values and fetch only projected data pages overlapping the resulting
  conservative row ranges. This is especially useful at fine display
  resolutions, where a small viewport may intersect a spatially broader row
  group but only a few of its ordered pages.
* **Per-feature bbox filter.** Within a fetched row group, the bbox covering columns can be evaluated as a predicate to skip individual features. This is the standard GeoParquet bbox covering filter and remains fully effective in COGP files.

Page statistics are conservative: a retained page can still contain features
outside the viewport. Readers MUST still apply the per-feature bbox predicate
to produce exact bbox query results. All three filters evaluate the primary
geometry's covering bbox. A selected feature is rendered using the selected
LoD, even if simplification or quantization changes its bounds. Conversely, an
overview entering the viewport does not select a feature whose primary bbox
misses it. Bbox intersection does not guarantee that the primary geometry
itself intersects the viewport; exact geometry intersection is a separate
operation.

When zooming in, a reader fetches any newly selected row groups. For Line and
Polygon families, a change of LoD also requires fetching that LoD's columns
for previously selected rows, unless they are already cached. Attributes and
other unchanged columns can be reused. A level with the same row group
boundary may therefore require new geometry data. Point-family rendering has
no LoD switch.

### 7.3 Overview selection

After selecting a level for Line or Polygon data, a rendering reader projects
only `overviews.geometry_type` and the four leaves under the level's required
`lod`. Sibling LoDs and the primary WKB geometry column are not needed. A
browser renderer SHOULD ensure that range coalescing does not overfetch primary
WKB column chunks between requested overview chunks.

The selected LoD is guaranteed to be non-null throughout the selected row
prefix, so no fallback or per-row precision comparison is needed. A reader may
expose the decoded overview logically under the primary geometry column name.

An analytical reader that requires lossless geometry explicitly projects the
GeoParquet primary geometry column and does not use `overviews`.

For Point-family data, a rendering reader projects the primary WKB geometry
column. There is no overview selection or `lod` fallback.

## 8. Validation

A validator verifies that the file meets all requirements stated in Section 5.

The semantic correctness of coarse-to-fine ordering — whether the features placed in earlier row groups are genuinely meaningful at coarser display resolutions — is not fully machine-verifiable. Validators can only check structural and metadata conformance. Achieving meaningful level semantics is a producer responsibility.

A validator MAY also compute non-conformance quality metrics such as row group touch count for sample bbox queries, prefix rendering latency, spatial spread of coarse levels, or spatial clustering quality within each level.

## 9. Non-goals

This profile does not define:

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
