---
title: Cloud Optimized GeoParquet Profile (COGP)
version: "0.1.0"
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
4. annotated with minimal metadata describing those level boundaries.

COGP is feature-level: it reorders features across row groups; it does not simplify, aggregate, or duplicate them.

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

COGP is a **feature-level progressive subset**, not a geometry-decimation scheme:

* each source feature is placed, in full, in exactly one row group;
* a feature's geometry is preserved verbatim — vertices, bends, and detail within a feature are never removed or simplified by this profile;
* features are assigned to the coarsest level at which they become independently renderable as whole features.

Unlike COG (TIFF) overviews or tile pyramids, COGP does not duplicate features across levels, and does not produce simplified geometries.

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

Because COGP is feature-level (see Section 3), `gsd` describes the threshold at which whole features become independently meaningful, not the threshold at which individual vertices within a feature are kept or removed. A feature placed in a coarse level retains its full geometry, including fine internal detail.

This may apply to deferring features such as:

* a pair of point features too close together to be visually distinguished;
* a short linear feature whose overall length is too small to form a visually meaningful shape;
* a small polygon feature that does not form a meaningful rendered shape;
* a polygon feature too small to form at least a minimal visible area at the target display scale.

This value is rendering-oriented. It does not guarantee positional accuracy, topological validity, or analytical precision.

## 5. Requirements

A COGP v0.1 file MUST satisfy the following requirements.

### 5.1 GeoParquet compatibility

The file MUST be a valid GeoParquet 1.1 file.

The file MUST declare bounding box covering metadata under the primary geometry column, at the GeoParquet metadata path:

```text
geo.columns[<primary_column>].covering.bbox
```

where `<primary_column>` is the value of the GeoParquet `primary_column` field.

Each of the bounding box columns (`xmin`, `ymin`, `xmax`, `ymax`) referenced by this covering MUST have Parquet row group min/max statistics present, so that readers can perform spatial pruning at row group granularity.

For COGP v0.1, geometries in the primary geometry column MUST NOT cross the antimeridian in a way that makes GeoParquet bbox covering unsuitable for spatial pruning. Producers SHOULD split such geometries or use another representation before writing a COGP file.

### 5.2 Physical ordering

The file MUST be ordered from coarse to fine rendering detail.

Earlier row groups MUST contain features that are independently meaningful at coarser render resolutions.

Later row groups MUST add features that are independently meaningful only at finer render resolutions.

Every source feature MUST appear in exactly one row group. Feature geometry and attributes MUST NOT be simplified or aggregated.

Level ordering is defined with respect to the primary geometry column. Non-primary geometry columns, if present, are not constrained by this profile.

Within each level, features SHOULD be spatially clustered so that row group bounding boxes are tight and spatial pruning by readers is effective.

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
  "version": "0.1.0",
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

## 7. Level selection (non-normative)

COGP metadata describes available levels, but it does not prescribe how a reader chooses one. A renderer can base the choice on zoom level, scale denominator, screen-space error, feature budget, byte budget, latency budget, or any other application-specific policy.

One common strategy is to estimate the ground distance represented by one display pixel and select the finest level that is still appropriate for that display resolution. Given a scale denominator and an assumed display pixel size in meters, such a target ground sample distance can be derived as:

```text
target_gsd = scale_denominator * display_pixel_size_m
```

Readers MAY use any other definition of `display_pixel_size_m` — device pixel, CSS pixel, or library-specific virtual pixel — provided it is consistent with how they interpret `scale_denominator`. COGP does not mandate a specific definition.

Because `levels` are ordered from coarse to fine and `gsd` values strictly decrease, a reader can select the last level in the `levels` array whose `gsd` is greater than or equal to `target_gsd`:

```text
gsd >= target_gsd
```

If no level satisfies this condition, the target display resolution is coarser than the coarsest level described by the file, and the reader can select the first level.

After selecting a target level, the reader reads row groups from `0` through that level's `row_group_end`, inclusive. Because each feature appears in exactly one level, rendering a finer level normally requires reading the preceding coarser levels as a prefix.

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
