# Quantized geometry overviews

This optional rendering extension complements the feature selection defined in
[SPEC.md](SPEC.md). The base `geo.lod` extension selects primary features only;
readers that do not implement this document ignore its additional fields and
read the lossless primary geometry. Implementation release numbers such as
`2.0.0` do not version `geo.lod`.

## Metadata

A producer may add `overviews` to `geo.lod` and `lod` to its level objects.
`overviews.encoding` MUST equal `quantized_xy_v1`. `overviews.lods` MUST be a
non-empty object mapping names to transforms. Each transform contains `scale`
and `offset`, each an array of exactly two finite numbers. Scale values MUST be
positive. All resolutions and transforms use primary geometry CRS units.

When `overviews` is declared, each level MUST name a LoD in `overviews.lods`.
When it is absent, levels MUST omit `lod`. Consecutive levels may select the same
row-group prefix with different LoDs; a LoD may serve multiple prefixes.
The base extension's boundary and resolution constraints always apply.

For example:

```json
{"levels":[{"row_group_end":0,"resolution":1,"lod":"l0"},
           {"row_group_end":0,"resolution":0.1,"lod":"l1"}],
 "overviews":{"encoding":"quantized_xy_v1","lods":{
   "l0":{"scale":[0.5,0.5],"offset":[0,0]},
   "l1":{"scale":[0.0625,0.0625],"offset":[0,0]}}}}
```

## Physical encoding

Point-family files MUST NOT declare `geo.lod.overviews` metadata. Point and MultiPoint coordinates cannot be
simplified usefully, so rendering readers project the primary WKB column.

Line- and Polygon-family producers SHOULD provide scale-appropriate simplified
rendering geometries. A producer that provides them MUST declare
`geo.lod.overviews` and contain exactly one top-level column named `overviews`,
with this logical structure:

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

A Line- or Polygon-family file MAY omit `geo.lod.overviews`. An undeclared column named `overviews` is an ordinary attribute. In that case every level MUST omit `lod`, and rendering
readers use the lossless primary WKB geometry. This remains conforming but may
increase transfer, decoding, and rendering cost, especially for complex
geometries at coarse resolutions.

Every key in `geo.lod.overviews.lods` MUST name exactly one `<lod>` child, and
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
exclusive end, in ring count, of each polygon. This rendering extension applies to non-null, non-empty geometries. Files with null or empty geometries remain valid under the base LoD extension and may omit rendering overviews.

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


## Validation

Validate the base layout first, then the declared rendering metadata, physical
schema and each LoD's non-null coverage through its effective boundary.
Compression, page sizing, and primary WKB statistics are implementation choices,
not additional conformance requirements.

## License

This document is licensed under [CC BY 4.0](LICENSE-SPEC).
