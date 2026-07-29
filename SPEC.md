---
title: Cloud Optimized GeoParquet Profile (COGP)
version: "1.0.0"
status: Draft
scope: A cloud-optimized progressive rendering profile for GeoParquet 1.1
---

# Cloud Optimized GeoParquet Profile (COGP)

## 1. Summary

Cloud Optimized GeoParquet Profile, abbreviated as COGP, is a GeoParquet profile for progressive map rendering and partial access over HTTP range requests or object storage.

A COGP file is:

1. a valid GeoParquet 1.1 file;
2. physically ordered from coarse to fine rendering detail;
3. organized so that each level ends at a Parquet row group boundary;
4. annotated with metadata binding row group boundaries to their ground resolutions;
5. optionally equipped with a struct sidecar containing rendering geometry fields for a
   subset of levels.

COGP always provides feature-level progression and can additionally provide geometry-level
progression. It does not aggregate or duplicate source features. The primary geometry
remains authoritative and unchanged. When present, the sidecar contains scale-appropriate
simplified representations for rendering.

## 2. Motivation

GeoParquet is well suited for geospatial analytics and cloud storage, but ordinary GeoParquet files are not necessarily optimized for progressive visual access.

For map rendering, tile serving, and viewport-driven applications, a reader often wants to:

1. read a coarse overview first;
2. stop when enough detail has been loaded;
3. avoid reading fine-grained features that cannot be independently rendered at the current display scale;
4. avoid transferring and decoding primary geometries whose full precision is not visible at that scale.

COGP defines a conservative layout convention for this use case while keeping the file readable as ordinary GeoParquet.

## 3. Core Concept

The core idea is:

> Earlier row groups contain features that are independently meaningful at coarse display resolutions. Later row groups add features that are only independently meaningful at finer display resolutions.

COGP has one required and one optional progressive dimension:

* each source feature is placed, in full, in exactly one row group;
* features are assigned to the coarsest level at which they become independently renderable as whole features;
* the primary geometry is preserved verbatim as the authoritative geometry;
* an optional sidecar struct stores scale-appropriate WKB representations for selected
  levels.

Unlike a tile pyramid, COGP does not duplicate source features across levels. Unlike the
primary geometry, the sidecar geometries are intended for rendering rather than
full-precision analysis.

A reader always chooses how many leading row groups to load. If the sidecar is present,
it also chooses a single child field to project based on its target rendering resolution.
Because each struct child is a separate Parquet leaf column, a remote reader can avoid
fetching the primary geometry and the sidecar fields for other scales.

For example:

* at a low zoom level, only the first few row groups may be needed;
* at a high zoom level, more row groups are read;
* for a small viewport, bbox covering and row group statistics can further prune unnecessary row groups.

## 4. Terminology

### 4.1 Level

A logical rendering detail level.

Levels are represented by metadata and row group boundaries. This profile does not require a `level`, `zoom`, or `zoomlevel` column in the data.

### 4.2 Ground resolution

`resolution` is the nominal ground resolution of a level, expressed in meters. If the
level were represented as a regular grid, this value would be the approximate ground
distance covered by one cell; at a corresponding display scale, it is analogous to the
ground distance covered by one pixel.

For vector data, `resolution` is the approximate smallest ground interval at which
features or geometric detail are represented as independently meaningful at this level.

The value is always expressed in meters of ground distance at the geographic location of the features, independent of the CRS or units used by the underlying data. For example, a file in EPSG:4326 (degrees) still expresses this value in meters.

For example, a level with `resolution` equal to `1000` is suitable for a representation
whose nominal cell or pixel size is approximately 1000 meters. Features and geometric
details substantially smaller than 1000 meters need not be represented independently.

This may apply to deferring features such as:

* a pair of point features too close together to be visually distinguished;
* a short linear feature whose overall length is too small to form a visually meaningful shape;
* a small polygon feature that does not form a meaningful rendered shape;
* a polygon feature too small to form at least a minimal visible area at the target display scale.

It also guides removal of vertices, bends, holes, and other geometric detail that is not
meaningful at the target scale. Producers MAY derive algorithm-specific simplification
tolerances from `resolution`; this profile does not prescribe that derivation.

`resolution` does not require coordinates to be snapped to a grid and is not an upper
bound on coordinate displacement, Hausdorff distance, or any other geometric error
metric. It does not guarantee positional accuracy, topological validity, or analytical
precision.

## 5. Requirements

A COGP v1.0 file MUST satisfy the following requirements.

### 5.1 GeoParquet compatibility

The file MUST be a valid GeoParquet 1.1 file.

The `geometry_types` array in the GeoParquet metadata for the primary geometry column
MUST contain exactly one geometry type. Every non-null value in the primary geometry
column MUST have that declared type. A file that mixes geometry types, including related
types such as `Polygon` and `MultiPolygon`, does not conform to this profile.

The file MUST declare bounding box covering metadata under the primary geometry column, at the GeoParquet metadata path:

```text
geo.columns[<primary_column>].covering.bbox
```

where `<primary_column>` is the value of the GeoParquet `primary_column` field.

Each of the bounding box columns (`xmin`, `ymin`, `xmax`, `ymax`) referenced by this covering MUST have Parquet row group min/max statistics present, so that readers can perform spatial pruning at row group granularity.

For COGP v1.0, geometries in the primary geometry column MUST NOT cross the antimeridian in a way that makes GeoParquet bbox covering unsuitable for spatial pruning. Producers SHOULD split such geometries or use another representation before writing a COGP file.

### 5.2 Physical ordering

The file MUST be ordered from coarse to fine rendering detail.

Earlier row groups MUST contain features that are independently meaningful at coarser render resolutions.

Later row groups MUST add features that are independently meaningful only at finer render resolutions.

Every source feature MUST appear in exactly one row group. The primary geometry and
attributes MUST NOT be simplified or aggregated. If present, sidecar geometries MUST
conform to Section 5.4.

Level ordering is defined with respect to the primary geometry column. Non-primary
GeoParquet geometry columns, if present, are not constrained by this profile. The COGP
sidecar is governed separately by Section 5.4 and is not a GeoParquet geometry column.

Within each level, features SHOULD be spatially clustered so that row group bounding boxes are tight and spatial pruning by readers is effective.

Producers SHOULD spatially sort or pack features within each level before forming row groups. Suitable approaches include, but are not limited to, ordering features by a spatial filling curve such as a Hilbert curve, ordering features by Quadkey or another quadtree-derived key, or using a packed spatial index layout such as STR packing.

### 5.3 Level boundaries

Each level MUST end at a Parquet row group boundary.

The file-level metadata MUST contain a non-empty ordered list of level entries.

Each level entry MUST contain:

* `row_group_end`
* `resolution`

`row_group_end` MUST be a JSON integer satisfying `0 <= row_group_end < num_row_groups`, where `num_row_groups` is the number of Parquet row groups in the file. Row group indices are zero-based.

`row_group_end` values MUST be strictly monotonically increasing across the `levels` array.

The first level entry covers row groups from row group `0` through its `row_group_end`, inclusive.

The row groups belonging to the second and later levels are the row groups after the previous level entry's `row_group_end` through the current level entry's `row_group_end`, inclusive.

The final `row_group_end` value MUST equal `num_row_groups - 1`, so that the levels collectively cover every row group in the file.

`resolution` MUST be a positive JSON number.

`resolution` values MUST be strictly monotonically decreasing from coarse to fine levels.

### 5.4 Rendering geometry sidecar

`lods_column` is OPTIONAL. Its absence indicates that the file has no COGP rendering
geometry sidecar. A producer SHOULD include the sidecar when scale-specific geometries
are expected to materially reduce transfer, decoding, or rendering cost. A producer
SHOULD omit it when they do not provide a material benefit, as is typically the case for
Point geometries.

If present, `lods_column` MUST be a non-empty string naming a root Parquet field. That
field MUST be a required, non-repeated struct, MUST NOT be the GeoParquet primary geometry
column, and MUST have at least one direct child.

Each child of that struct MUST be an optional Parquet `BYTE_ARRAY` containing WKB and
MUST correspond to exactly one entry in `levels`. A child corresponding to `levels[i]`
MUST be named `level_<i>`, where `i` is the zero-based decimal index of that entry in the
`levels` array, without leading zeros. A child MAY be omitted for any level. Child names
MUST follow this convention regardless of their physical order in the struct; the order
of struct children has no semantic meaning.

For the metadata example in Section 6.3, the corresponding Parquet schema fragment is:

```text
required group geometry_lods {
  optional binary level_0;
  optional binary level_2;
}
```

The sidecar struct and its children MUST NOT be listed as geometry columns in
`geo.columns`. GeoParquet 1.1 requires geometry columns to be at the root of the schema;
the sidecar is therefore a COGP-defined rendering representation rather than an
additional GeoParquet geometry column.

For each sidecar field `level_<j>` and a row first introduced in level `i`:

* if `j < i`, the field MUST be null;
* if `j >= i`, the field MUST contain a geometry, unless the primary geometry is null;
* if the primary geometry is null, every sidecar field MUST be null.

Each non-null sidecar geometry MUST:

* be derived from that row's primary geometry;
* use the same CRS, coordinate axis order, dimensionality, and the single geometry type
  declared for the primary geometry column;
* represent features and geometric details meaningful at its level's `resolution`, while
  details substantially smaller than that `resolution` MAY be omitted;
* lie within the bounding box of the primary geometry, so that pruning with the primary
  geometry's GeoParquet bbox covering remains safe.

A sidecar value MAY equal the primary geometry when no detail can be removed while
meeting these requirements. This profile does not prescribe a simplification algorithm
or require topology preservation.

### 5.5 Progressive access layout

Producers SHOULD choose row group sizes so that each level prefix can be fetched and rendered with bounded latency over HTTP range requests or object storage.

Producers SHOULD avoid placing so many bytes or features in an early row group that the first level is no longer useful as a coarse overview.

This profile does not mandate a specific compressed byte size, feature count, or row group sizing algorithm.

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
  "version": "1.0.0",
  "levels": [
    {
      "row_group_end": 0,
      "resolution": 1000
    },
    {
      "row_group_end": 3,
      "resolution": 500
    },
    {
      "row_group_end": 12,
      "resolution": 100
    }
  ]
}
```

### 6.3 Example with rendering geometry sidecar

```json
{
  "version": "1.0.0",
  "lods_column": "geometry_lods",
  "levels": [
    {
      "row_group_end": 0,
      "resolution": 1000
    },
    {
      "row_group_end": 3,
      "resolution": 500
    },
    {
      "row_group_end": 12,
      "resolution": 100
    }
  ]
}
```

### 6.4 Field definitions

| Field                    | Required | Description                                                                                 |
| ------------------------ | -------: | ------------------------------------------------------------------------------------------- |
| `version`                |      Yes | Profile metadata version.                                                                   |
| `lods_column`            |       No | Root struct containing rendering geometry fields for one or more levels.                    |
| `levels`                 |      Yes | Ordered level entries from coarse to fine.                                                  |
| `levels[].row_group_end` |      Yes | Inclusive row group index ending this level.                                                |
| `levels[].resolution`    |      Yes | Nominal ground resolution governing both feature inclusion and geometry detail, in meters. |

## 7. Reader guidance (non-normative)

COGP metadata describes available levels but does not prescribe how a reader uses them. This section sketches typical patterns.

### 7.1 Level selection

A renderer can base the choice of level on zoom level, map scale, screen-space error, or any application-specific budget for bytes, features, or latency.

One common strategy is to derive a target ground resolution from the current display
scale and select the finest level whose `resolution` is still coarser than or equal to
that target. Because `levels` are ordered from coarse to fine and `resolution` values
strictly decrease, this is the last level satisfying:

```text
resolution >= target_resolution
```

If no level satisfies this condition, the target resolution is coarser than the coarsest level in the file, and the reader can select the first level.

### 7.2 Reading the selected prefix

The prefix of row groups from `0` through the selected level's `row_group_end` is the
minimal set of features needed to produce a meaningful render at the target display
scale. The reader projects the selected level's
`lods_column.level_<i>` leaf instead of the primary geometry when `lods_column` is
present and that field exists, where `i` is the selected level's zero-based index. If
that field is absent, the reader selects the available `level_<j>` with the smallest
index `j` such that `j > i`; this is the nearest available finer representation. If no
such field exists, or if `lods_column` is absent, the reader projects the primary
geometry. A reader MUST NOT fall back to a coarser sidecar field because it may omit
detail meaningful at the selected resolution.

For example, the sidecar in Sections 5.4 and 6.3 contains `level_0` and `level_2`. A
reader selecting level 1 uses `geometry_lods.level_2`. Features that would not be
meaningful at the selected scale are not fetched; with a sidecar, unneeded geometric
detail may also remain unfetched.

Two reading styles are both valid:

* **Bounded read.** Fetch exactly the selected prefix and stop. Total transfer volume is bounded by the selected scale, which suits bandwidth-sensitive clients such as WebGIS applications.
* **Progressive render.** Render features incrementally as row groups arrive, drawing coarser row groups first. This suits interactive viewers that want first paint as early as possible.

Implementations typically fetch the Parquet footer to obtain `cogp` metadata, column
chunk locations, and per-row-group statistics. They then issue HTTP range requests only
for the selected geometry representation and other requested attributes in row groups
`0..row_group_end` — in parallel or in order, with rendering either streamed or deferred
to completion. When a suitable sidecar field is available, its resolved leaf is that
representation; otherwise, the primary geometry is. Selecting the sidecar's parent struct
without leaf projection may cause a Parquet implementation to fetch every child and
defeats the sidecar's purpose.

For viewport-driven applications, two complementary spatial filters apply within the selected prefix:

* **Row group pruning.** Using per-row-group min/max statistics of the bbox covering columns (Section 5.1), row groups whose bbox does not intersect the viewport can be skipped, avoiding the range request entirely.
* **Per-feature bbox filter.** Within a fetched row group, the bbox covering columns can be evaluated as a predicate to skip individual features. This is the standard GeoParquet bbox covering filter and remains fully effective in COGP files.

If the view changes — for example, the user zooms in — the reader fetches additional row
groups. When a suitable sidecar field is available, it also fetches that field for rows
that must be redrawn. Attribute data and feature identity from previously read rows
remain valid, but their coarse rendering geometry is replaced by the newly selected
finer representation.

## 8. Validation

A validator verifies that the file meets all requirements stated in Section 5.

The semantic correctness of coarse-to-fine ordering and, when a sidecar is present,
simplification — whether features and geometric detail are genuinely meaningful at their
declared resolutions — is not fully machine-verifiable. Validators can check structural and
metadata conformance, the single-geometry-type constraint, and, for a sidecar, nullability
rules, WKB validity, and bounding containment. Achieving meaningful level semantics is a
producer responsibility.

A validator MAY also compute non-conformance quality metrics such as row group touch count for sample bbox queries, prefix rendering latency, spatial spread of coarse levels, or spatial clustering quality within each level.

## 9. Non-goals

This profile does not define:

* a replacement for the authoritative GeoParquet geometry;
* a new CRS model;
* a new tile matrix set;
* a mandatory simplification algorithm;
* a mandatory thinning algorithm;
* a mandatory spatial clustering algorithm;
* analytical accuracy guarantees;
* topology preservation guarantees;
* standalone prefix-Parquet semantics;
* SQL query semantics.
