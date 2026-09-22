# [Proposal] Level of Detail (LoD) extension

This document proposes an optional GeoParquet Level of Detail (LoD) extension for progressive feature access and scale-dependent geometry rendering.

## Motivation

Spatial ordering and bounding box statistics help readers find features within a viewport. They do not tell a reader how much of that viewport's data is useful at a given display scale. A world view may intersect almost every row group even though only a small subset of features can be distinguished on screen.

This proposal adds a second selection dimension: rendering resolution. Features useful at coarse resolutions are stored in earlier row groups; later row groups add finer detail. Metadata associates each rendering resolution with a cumulative row group prefix and, when provided, a simplified geometry representation. Readers can fetch a coarse view first, then add features or refine their geometries as needed.

## Scope

The extension describes the physical layout of one GeoParquet file with respect to its primary geometry column. It preserves the table's features, primary geometries, and source attributes, while permitting their order to change. Optional overviews provide scale-appropriate rendering geometries in a column identified by metadata. Each input row occurs exactly once in the output, including when the input itself contains duplicate-valued rows.

The primary geometry retains its GeoParquet encoding. The extension does not define a tile matrix, spatial index, or query language. It does not require a per-row level column, sidecar index, or duplicated rows for each resolution.

The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" in this document are to be interpreted as described in [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

## Physical layout

A file using this extension MUST conform to the [GeoParquet specification](geoparquet.md).

Features MUST be assigned to ordered detail levels, from coarse to fine. A level represents the features selected for display at a nominal rendering resolution. Earlier levels should provide a useful view of the dataset; later levels may add features that the producer has deferred at coarser resolutions.

Each input row MUST be stored exactly once. Applying this layout MUST NOT simplify, aggregate, or otherwise change its primary geometry or source attribute values. Derived rendering geometries are stored in the column referenced by `geo.lod.overviews.column`. The extension reserves no data column name.

Rows introduced by each level MUST occupy consecutive whole Parquet row groups. A row group MUST NOT straddle a level boundary. Row groups MUST occur in coarse-to-fine order in the Parquet footer. Readers use the footer's column chunk offsets for access.

A level selects **all row groups from zero through its boundary**, inclusive. Later levels may add rows to that prefix; they do not replace the earlier rows. The last level includes the entire table.

For example, a file with eight row groups could have this layout:

```text
Row group:          0 | 1  2 | 3  4  5  6  7
New features:   coarse | medium | fine

Coarse selection: [0]
Medium selection: [0, 1, 2]
Fine selection:   [0, 1, 2, 3, 4, 5, 6, 7]
```

Within each level's newly introduced rows, producers SHOULD spatially cluster features to improve spatial pruning. The clustering method is not prescribed: Hilbert ordering, quadtree ordering, and STR packing are possible choices. A global spatial sort that interleaves detail levels would invalidate the declared layout.

### Geometry representation

A producer that provides rendering overviews MUST declare `geo.lod.overviews`.
Its `column` field MUST reference an existing top-level column distinct from the
primary geometry column. The column name is producer-defined; a column named
`overviews` has no special meaning unless referenced by this metadata. Adding
overviews MUST NOT overwrite a source attribute.

The `encoding` field identifies the rules for interpreting that column and its
per-LoD metadata. This specification does not require a single overview encoding.
An encoding definition MUST specify its physical schema, how each named LoD maps
to a row's rendering geometry, and any decoding parameters, coordinate dimensions,
and geometry-type constraints. Encoding identifiers MUST have stable meanings;
incompatible changes require a distinct identifier. Encoding-specific fields
MUST NOT change the level-selection or non-null coverage rules defined here.

Every LoD declared in `overviews.lods` MUST identify a representation in the
referenced column and MUST be referenced by at least one level. Representations
remain aligned with the source table: each row's overview represents that row's
primary geometry. Files MAY omit overviews, in which case rendering readers use
the lossless primary geometry.

The `quantized_xy_v1` identifier is defined in
[Quantized XY encoding](encodings/quantized-xy-v1.md). Its physical schema and
coordinate transforms are specific to that encoding, not requirements for
other encodings. Every additional encoding identifier MUST resolve to an
unambiguous definition of the rules above; naming a serialization format alone
is insufficient.

## Metadata

The extension adds an OPTIONAL `lod` (level of detail) object to the GeoParquet file metadata stored under the `geo` key. When present, this object MUST satisfy the field requirements below. Its levels apply to the primary geometry column identified by `geo.primary_column`.

| Field | Type | Description |
| --- | --- | --- |
| `levels` | array of objects | **REQUIRED.** Non-empty list of levels, ordered from coarse to fine. |
| `levels[].row_group_end` | integer | **REQUIRED.** Zero-based, inclusive end of the selected row group prefix. |
| `levels[].resolution` | number | **REQUIRED.** Positive, finite nominal rendering resolution in the primary geometry column's CRS units. |
| `levels[].lod` | string | **REQUIRED** when `overviews` is declared; otherwise MUST be absent. Names the rendering geometry used for this level. |
| `overviews` | object | **OPTIONAL.** Declares rendering geometries. |
| `overviews.column` | string | **REQUIRED** within `overviews`. Name of the top-level column containing the rendering geometries. |
| `overviews.encoding` | string | **REQUIRED** within `overviews`. Identifier of the overview encoding. |
| `overviews.lods` | object | **REQUIRED** within `overviews`. Non-empty mapping from LoD names to encoding-specific metadata objects. |

Example of the `geo.lod` object for the eight-row-group file above, using
[`quantized_xy_v1`](encodings/quantized-xy-v1.md) for the rendering geometries.
The `scale` and `offset` fields belong to that encoding; the level-selection
contract does not depend on them:

```json
{
  "levels": [
    { "row_group_end": 0, "resolution": 1000, "lod": "l0" },
    { "row_group_end": 2, "resolution": 100, "lod": "l1" },
    { "row_group_end": 7, "resolution": 10, "lod": "l2" }
  ],
  "overviews": {
    "column": "render_geometry",
    "encoding": "quantized_xy_v1",
    "lods": {
      "l0": { "scale": [512, 512], "offset": [0, 0] },
      "l1": { "scale": [64, 64], "offset": [0, 0] },
      "l2": { "scale": [8, 8], "offset": [0, 0] }
    }
  }
}
```

When `overviews` is declared, each level MUST name a LoD in `overviews.lods`. Consecutive levels may select the same row-group prefix with different LoDs, refining geometry without adding features. A LoD may serve multiple prefixes. Files without overviews omit both `overviews` and every level's `lod`.

### Boundaries

For a file containing `N` row groups:

* Each `row_group_end` MUST satisfy `0 <= row_group_end < N`.
* Boundaries MUST be non-decreasing.
* The final boundary MUST equal `N - 1`.
* Empty files MUST omit this extension. A non-empty file MAY declare a single level covering all its row groups.

Boundaries refer to this file's footer, not to row numbers, byte offsets, or row groups in another file. Partitioned datasets apply the extension independently to each file; this draft does not define a dataset-wide level index.

For each LoD, its effective boundary is the maximum `row_group_end` among all
levels referencing it. The representation of that LoD MUST be non-null for every row from row group
`0` through that effective boundary, inclusive, and MUST be null in every
later row group. Multiple levels MAY reference the same LoD. This makes each
selected prefix independently renderable without a per-row fallback.

### Resolution

`resolution` is the nominal rendering resolution for which a level's feature prefix and, when declared, its selected overview are intended to be rendered.

`resolution` MUST be expressed in the horizontal coordinate units of the primary geometry column's CRS. For example, a CRS using meters expresses resolution in meters, while a geographic CRS using degrees expresses it in degrees. Values MUST strictly decrease from coarse to fine.

Resolution is a display hint. It is not a bound on geometric error, positional accuracy, feature spacing, or analytical precision. The extension does not prescribe a projection, a zoom-to-resolution formula, or a pixel size. A renderer decides how its current display scale maps to a target resolution.

The target resolution is interpreted in the same CRS units as `resolution`. If the CRS is unknown, `resolution` uses the primary geometry's coordinate units without assigning them a physical unit.

### Metadata handling

Readers that do not support this extension can ignore `lod` and read the file as ordinary GeoParquet. Extension-aware readers MUST validate the required fields and boundary constraints before using the levels to exclude row groups. If the metadata is invalid, readers MUST NOT use it for prefix selection and SHOULD report the problem. They MAY fall back to ordinary GeoParquet access.

Readers that do not implement overviews, or do not support the declared encoding, read the lossless primary geometry. An unsupported encoding is not invalid LoD metadata: readers MAY still use valid level boundaries for feature selection. Readers MUST NOT decode an unsupported encoding as though it were a supported one.

Readers MUST ignore unrecognized fields within `lod`. This proposal does not introduce an independent extension version field.

## Reader behavior

A typical rendering reader:

1. Reads the Parquet footer and validates the extension metadata against the row group count.
2. Chooses a level for its target resolution or rendering budget.
3. Applies row group spatial pruning within the selected prefix, from `0` through `row_group_end`.
4. Can further prune pages within the retained row groups when page indexes are available.
5. Selects the rendering geometry named by the level's `lod` when overviews are declared and their encoding is supported; otherwise selects the primary geometry.
6. Fetches the selected geometry and required attribute data and evaluates the per-feature predicate.
7. Fetches additional data when finer detail or a different viewport is requested, reusing cached data where possible.

A rendering reader using declared overviews MUST NOT fall back to the primary WKB column when an overview value is absent. The non-null coverage requirement ensures that each selected prefix is independently renderable.

Decoded overview coordinates use the primary geometry's CRS, XY axis order,
and coordinate units. Spatial selection MUST evaluate the primary geometry's
covering bbox, independent of the selected LoD. Overviews represent the
selected features for rendering; their bounds MUST NOT replace or expand the
primary bbox predicate.

One possible level-selection policy is to choose the finest level whose `resolution` is greater than or equal to the target. Clamp to the first level when the target is coarser than every level, and to the last when it is finer than every level. With the example above, a target of 250 CRS units selects the level with `resolution: 1000`; a target of 100 CRS units selects the level with `resolution: 100`. Applications may choose a finer level when visual completeness matters more than transfer cost.

A prefix is a partial feature selection. Readers MUST NOT treat it as a complete query result unless the selected prefix includes every row group that could contribute to that query. Analytical operations such as counts, sums, and spatial joins must consider all potentially matching row groups, independently of display resolution. Coarse prefixes are not statistically representative samples.

Reading a prefix of row groups does not mean downloading a standalone prefix of the file's bytes. The complete Parquet footer is still needed, and column projection and spatial pruning may produce multiple range requests. An ordinary reader can ignore the extension and read the complete table; the extension does not guarantee that such a reader will visit row groups in order.

## Producer guidance

The assignment of features to levels is intentionally producer-defined. Point data can use spatial thinning; lines and polygons can use geometric size or visibility criteria; thematic datasets can use application-specific importance. These choices affect rendering quality but do not change the reader interface.

Producers SHOULD distribute coarse-level features across the dataset's spatial extent where that is meaningful. Merely moving one spatial corner of a globally sorted dataset into the first level rarely provides a useful overview. Features that cannot be assigned a meaningful display scale, such as null or empty geometries, MUST still be preserved and can be assigned to the final level.

Producers SHOULD keep early row groups small enough for responsive initial access and provide spatial statistics appropriate to the GeoParquet version. GeoParquet 1.1 bbox covering statistics and GeoParquet 2.0 native geospatial statistics can support spatial pruning. Page indexes can refine access further. Readers must use conservative pruning and handle unavailable statistics without discarding potential matches.

No compression codec, row group size, page size, thinning algorithm, or spatial ordering algorithm is required. These choices depend on the dataset and expected access pattern. Coarse-to-fine ordering can reduce locality across levels compared with a single global spatial sort, so producers should measure both progressive rendering and full-resolution spatial queries.

Feature selection reduces the number of features fetched at coarse scales. Without overviews, a large detailed polygon can still dominate transfer and decoding cost. Scale-appropriate simplified rendering geometries address this per-feature cost. Line- and Polygon-family producers SHOULD provide them.

Producers MUST derive every LoD directly from the lossless primary geometry or from an
equivalent progressive hierarchy; error MUST NOT accumulate by repeatedly
simplifying the previous LoD. The primary geometry remains unchanged.

Any operation that changes row order, row group boundaries, feature membership, or the primary geometry MUST remove or regenerate the extension metadata. Copying it unchanged through a generic rewrite can silently produce incomplete rendering results.

## Validation

A structural validator can check the metadata types, non-empty levels, positive finite and strictly decreasing resolutions, and non-decreasing row group boundaries. It can verify that each boundary is within the footer's row group count and that the final boundary includes the last row group. It can also validate the underlying GeoParquet file.

Structural validation confirms only that the metadata is consistent with the file's row groups. It does not verify that every source row was preserved, nor that early levels form a useful coarse view; both require comparison with the source data or dataset-specific evaluation.

When overviews are declared, also validate the column reference and level-to-LoD
references. For a supported encoding, validate its metadata, physical schema
and each LoD's non-null coverage through its effective boundary. A validator
that does not support the encoding MUST report that it could not validate the
overview representation; it MUST NOT claim full validation of those overviews.

Compression, page sizing, and primary WKB statistics are implementation choices,
not additional conformance requirements.

## License

This document is licensed under [CC BY 4.0](LICENSE-SPEC).
