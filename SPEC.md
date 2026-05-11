---
title: Cloud Optimized GeoParquet Profile (COGP)
version: "0.1"
status: Draft
scope: A cloud-optimized progressive rendering profile for GeoParquet 1.1
---

# Cloud Optimized GeoParquet Profile (COGP)

## 1. Summary

Cloud Optimized GeoParquet Profile, abbreviated as COGP, is a GeoParquet profile for progressive map rendering and partial access over HTTP range requests or object storage.

A COGP file is:

1. a valid GeoParquet 1.1 file;
2. physically ordered from coarse to fine rendering detail;
3. organized so that each level of detail ends at a Parquet row group boundary;
4. annotated with minimal metadata describing those level-of-detail boundaries.

The profile does not define a new geometry encoding, a new CRS model, or a new tile scheme.

## 2. Motivation

GeoParquet is well suited for geospatial analytics and cloud storage, but ordinary GeoParquet files are not necessarily optimized for progressive visual access.

For map rendering, tile serving, and viewport-driven applications, a reader often wants to:

1. read a coarse overview first;
2. stop when enough detail has been loaded;
3. avoid reading fine-grained features that cannot be independently rendered at the current display scale.

COGP defines a conservative layout convention for this use case while keeping the file readable as ordinary GeoParquet.

## 3. Core Concept

The core idea is:

> Earlier row groups contain geometry that is meaningful at coarse display resolutions. Later row groups add geometry that is only meaningful at finer display resolutions.

Each feature appears in exactly one row group. Unlike COG (TIFF) overviews or tile pyramids, COGP does not duplicate features across levels of detail.

A reader can choose how many leading row groups to load based on its target rendering resolution.

For example:

* at a low zoom level, only the first few row groups may be needed;
* at a high zoom level, more row groups are read;
* for a small viewport, bbox covering and row group statistics can further prune unnecessary row groups.

## 4. Terminology

### 4.1 Level of Detail, LoD

A logical rendering detail level.

LoDs are represented by metadata and row group boundaries. This profile does not require a `lod`, `zoom`, or `zoomlevel` column in the data.

### 4.2 Ground sample distance (GSD)

`gsd` is the approximate ground distance below which geometric distinctions are not expected to be independently renderable at this LoD.

The term is borrowed from raster imagery, where GSD denotes the ground distance represented by one pixel. In COGP it is used by analogy for vector data: the threshold below which features at this LoD are not expected to be individually meaningful.

The value is always expressed in meters of ground distance at the geographic location of the features, independent of the CRS or units used by the underlying data. For example, a file in EPSG:4326 (degrees) still expresses this value in meters.

This includes, for example:

* two points being too close to appear as separate pixels;
* a line segment or bend being too small to visually matter;
* a polygon being too small to form a meaningful rendered shape;
* a polygon being too small to form at least a minimal visible area at the target display scale.

This value is rendering-oriented. It does not guarantee positional accuracy, topological validity, or analytical precision.

## 5. Requirements

A COGP v0.1 file MUST satisfy the following requirements.

### 5.1 GeoParquet compatibility

The file MUST be a valid GeoParquet 1.1 file.

The file MUST include GeoParquet `covering` metadata for a bounding box column associated with the geometry column identified by the GeoParquet `primary_column` metadata.

The referenced bounding box covering column MUST be present in the file.

The bounding box covering column MUST be written so that optimized readers can use Parquet row group statistics for spatial pruning.

### 5.2 Physical ordering

The file MUST be ordered from coarse to fine rendering detail.

Earlier row groups MUST contain features or geometry meaningful at coarser render resolutions.

Later row groups MUST add features or geometry meaningful only at finer render resolutions.

Within each LoD, features SHOULD be spatially clustered.

This profile does not require a specific clustering algorithm.

### 5.3 LoD boundaries

Each LoD MUST end at a Parquet row group boundary.

The file-level metadata MUST contain a non-empty ordered list of LoD entries.

Each LoD entry MUST contain:

* `row_group_end`
* `gsd`

`row_group_end` values MUST be strictly monotonically increasing.

The first LoD entry covers row groups from row group `0` through its `row_group_end`, inclusive.

The final `row_group_end` value MUST equal the last row group index in the file.

`gsd` values MUST be positive numbers.

`gsd` values MUST be strictly monotonically decreasing from coarse to fine LoDs.

## 6. Metadata

The file MUST include a Parquet file-level key-value metadata entry named:

```text
cogp
```

The value MUST be a UTF-8 JSON object.

### 6.1 Minimal example

```json
{
  "version": "0.1",
  "lods": [
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

### 6.2 Recommended example

```json
{
  "version": "0.1",
  "lods": [
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
  "spatial_clustering": {
    "method": "str-pack"
  },
  "generator": {
    "name": "yosegi",
    "version": "0.8.0"
  }
}
```

### 6.3 Field definitions

| Field                  | Required | Description                                                                                                       |
| ---------------------- | -------: | ----------------------------------------------------------------------------------------------------------------- |
| `version`              |      Yes | Profile metadata version.                                                                                         |
| `lods`                 |      Yes | Ordered LoD entries from coarse to fine.                                                                          |
| `lods[].row_group_end` |      Yes | Inclusive row group index ending this LoD.                                                                        |
| `lods[].gsd`           |      Yes | Approximate ground sample distance, in meters, below which geometry is not expected to be independently renderable. |
| `spatial_clustering`   |       No | Informational clustering method metadata.                                                                         |
| `generator`            |       No | Producer tool metadata.                                                                                           |

## 7. Reader Guidance (non-normative)

This section is informational. It does not impose conformance requirements on readers.

A reader that does not understand this profile MAY ignore the `cogp` metadata and read the file as ordinary GeoParquet. The file remains fully readable as GeoParquet 1.1 regardless of whether the reader interprets COGP semantics.

A COGP-aware reader typically:

1. parses `cogp` metadata from the Parquet file-level key-value metadata;
2. chooses an LoD based on a target ground sample distance;
3. reads row groups from `0` through the selected `row_group_end`;
4. combines this with bbox covering and row group statistics to further prune row groups within the chosen LoD.

### 7.1 LoD selection

A renderer can compute or estimate a target ground pixel size:

```text
target_gsd = scale_denominator * display_pixel_size_m
```

It can then choose the finest LoD whose `gsd` is still appropriate for that target. A simple rule is:

```text
gsd >= target_gsd
```

If no LoD satisfies the target, the reader can fall back to the coarsest LoD.

Different readers may use different selection strategies, including zoom level, scale denominator, screen-space error, feature budget, byte budget, or latency budget. COGP does not mandate a specific strategy.

## 8. Producer Behavior

A producer SHOULD:

1. derive coarse-to-fine LoDs;
2. for each feature, choose the coarsest LoD at which the feature is independently renderable and place it in that LoD;
3. spatially cluster features within each LoD;
4. write LoDs in coarse-to-fine order;
5. align LoD boundaries with Parquet row group boundaries;
6. write GeoParquet 1.1 metadata;
7. write `cogp` metadata.

Feature geometry and attributes MUST NOT be simplified or aggregated. Each source feature MUST appear at most once in the output.

## 9. Validation

A validator SHOULD check:

* the file is valid Parquet;
* the file is valid GeoParquet 1.1;
* `cogp` metadata exists;
* metadata is valid JSON;
* `version` is supported;
* `lods` is non-empty;
* `row_group_end` values are valid and strictly increasing;
* the final `row_group_end` equals the final row group index;
* `gsd` values are positive;
* `gsd` values strictly decrease from coarse to fine;
* GeoParquet covering metadata exists;
* the referenced bounding box covering column exists;
* row group statistics are available for the covering column.

A validator MAY also compute quality metrics such as:

* row group touch count for sample bbox queries;
* prefix rendering latency;
* spatial spread of coarse LoDs;
* spatial clustering quality within each LoD.

These quality metrics are not conformance requirements.

## 10. Non-goals

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

## 11. One-line Definition

COGP is valid GeoParquet 1.1 with bbox covering, ordered from coarse to fine rendering detail, where row-group-aligned LoD metadata tells a reader how many leading row groups to load for a target ground sample distance.
