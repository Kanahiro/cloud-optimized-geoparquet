# Cloud Optimized GeoParquet Profile (COGP) v0.1 Draft

Status: Draft
Version: 0.1
Scope: A cloud-optimized progressive rendering profile for GeoParquet 1.1

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

A reader can choose a row group prefix based on its target rendering resolution.

For example:

* at a low zoom level, only the first few row groups may be needed;
* at a high zoom level, more row groups are read;
* for a small viewport, bbox covering and row group statistics can further prune unnecessary row groups.

## 4. Terminology

### 4.1 Level of Detail, LoD

A logical rendering detail level.

LoDs are represented by metadata and row group boundaries. This profile does not require a `lod`, `zoom`, or `zoomlevel` column in the data.

### 4.2 Render resolution

`nominal_render_resolution_m` is the approximate ground distance below which geometric distinctions are not expected to be independently renderable at this LoD.

This includes, for example:

* two points being too close to appear as separate pixels;
* a line segment or bend being too small to visually matter;
* a polygon being too small to form a meaningful rendered shape;
* a polygon being too small to form at least a minimal visible area at the target display scale.

This value is rendering-oriented. It does not guarantee positional accuracy, topological validity, or analytical precision.

### 4.3 Row group prefix

A row group prefix is the contiguous set of row groups from row group `0` through a selected `row_group_end`.

A reader can load a prefix to obtain a progressively refined representation.

## 5. Requirements

A COGP v0.1 file MUST satisfy the following requirements.

### 5.1 GeoParquet compatibility

The file MUST be a valid GeoParquet 1.1 file.

The file MUST include GeoParquet `covering` metadata for a bounding box column associated with the primary geometry column.

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
* `nominal_render_resolution_m`

`row_group_end` values MUST be monotonically increasing.

The final `row_group_end` value MUST equal the last row group index in the file.

`nominal_render_resolution_m` values MUST be positive numbers.

`nominal_render_resolution_m` values SHOULD be monotonically decreasing from coarse to fine LoDs.

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
  "profile": "progressive-rendering",
  "lods": [
    {
      "row_group_end": 0,
      "nominal_render_resolution_m": 1000
    },
    {
      "row_group_end": 3,
      "nominal_render_resolution_m": 500
    },
    {
      "row_group_end": 12,
      "nominal_render_resolution_m": 100
    }
  ]
}
```

### 6.2 Recommended example

```json
{
  "version": "0.1",
  "profile": "progressive-rendering",
  "lods": [
    {
      "row_group_end": 0,
      "nominal_render_resolution_m": 1000,
      "feature_count": 12000
    },
    {
      "row_group_end": 3,
      "nominal_render_resolution_m": 500,
      "feature_count": 48000
    },
    {
      "row_group_end": 12,
      "nominal_render_resolution_m": 100,
      "feature_count": 210000
    }
  ],
  "ordering": "coarse-to-fine",
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

| Field                                | Required | Description                                                                                      |
| ------------------------------------ | -------: | ------------------------------------------------------------------------------------------------ |
| `version`                            |      Yes | Profile metadata version.                                                                        |
| `profile`                            |      Yes | Profile identifier. For v0.1, `progressive-rendering`.                                           |
| `lods`                               |      Yes | Ordered LoD entries from coarse to fine.                                                         |
| `lods[].row_group_end`               |      Yes | Inclusive row group index ending this LoD prefix.                                                |
| `lods[].nominal_render_resolution_m` |      Yes | Approximate ground distance below which geometry is not expected to be independently renderable. |
| `lods[].feature_count`               |       No | Cumulative feature count through this LoD prefix.                                                |
| `ordering`                           |       No | Informational ordering description.                                                              |
| `spatial_clustering`                 |       No | Informational clustering method metadata.                                                        |
| `generator`                          |       No | Producer tool metadata.                                                                          |

## 7. Reader Behavior

A reader that does not understand this profile MAY ignore the metadata and read the file as ordinary GeoParquet.

An optimized reader SHOULD:

1. read the Parquet footer;
2. parse GeoParquet metadata;
3. parse `cogp` metadata;
4. choose an LoD based on target render resolution;
5. read row groups from `0` through the selected `row_group_end`;
6. apply bbox filtering and row group pruning where possible;
7. decode only required columns.

### 7.1 LoD selection

A renderer can compute or estimate a target ground pixel size:

```text
target_render_resolution_m = scale_denominator * display_pixel_size_m
```

Then it can choose the finest LoD whose render resolution is still appropriate for that target.

A simple rule is:

```text
nominal_render_resolution_m >= target_render_resolution_m
```

If no LoD satisfies the target, the reader SHOULD choose the coarsest LoD.

Different readers MAY use different selection strategies, including zoom level, scale denominator, screen-space error, feature budget, byte budget, or latency budget.

## 8. Producer Behavior

A producer SHOULD:

1. derive coarse-to-fine LoDs;
2. remove, simplify, aggregate, or defer geometry that is not independently renderable at each LoD;
3. spatially cluster features within each LoD;
4. write LoDs in coarse-to-fine order;
5. align LoD boundaries with Parquet row group boundaries;
6. write GeoParquet 1.1 metadata;
7. write `cogp` metadata.

The producer MAY use any thinning, simplification, aggregation, or clustering method.

The method SHOULD be documented in optional metadata when useful.

## 9. Byte Ranges

LoD boundaries are defined by row group indices, not byte offsets.

A future version MAY define byte offset hints or a stricter byte-range access model.

In v0.1, readers SHOULD use the Parquet footer to determine which row groups and column chunks to read.

A byte prefix such as `bytes=0-N` MUST NOT be assumed to be a valid standalone Parquet file.

## 10. Validation

A validator SHOULD check:

* the file is valid Parquet;
* the file is valid GeoParquet 1.1;
* `cogp` metadata exists;
* metadata is valid JSON;
* `version` is supported;
* `profile` is `progressive-rendering`;
* `lods` is non-empty;
* `row_group_end` values are valid and increasing;
* the final `row_group_end` equals the final row group index;
* `nominal_render_resolution_m` values are positive;
* `nominal_render_resolution_m` values decrease from coarse to fine;
* GeoParquet covering metadata exists;
* the referenced bounding box covering column exists;
* row group statistics are available for the covering column;
* optional `feature_count` values match the row counts, if present.

A validator MAY also compute quality metrics such as:

* row group touch count for sample bbox queries;
* prefix rendering latency;
* spatial spread of coarse LoDs;
* spatial clustering quality within each LoD.

These quality metrics are not conformance requirements.

## 11. Non-goals

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

## 12. Open Questions

For v0.2 or later:

1. Should `nominal_render_resolution_m` be renamed?
2. Should `feature_count` be required?
3. Should byte offset hints be standardized?
4. Should there be separate conformance classes for core metadata, spatial pruning, and progressive rendering quality?
5. Should the profile recommend row group size ranges?
6. Should the profile define standard quality metrics for progressive rendering?
7. Should this remain an external profile or become a GeoParquet extension proposal?

## 13. One-line Definition

COGP is valid GeoParquet 1.1 with bbox covering, ordered from coarse to fine rendering detail, with row-group-aligned LoD metadata describing the render resolution at which each prefix is useful.
