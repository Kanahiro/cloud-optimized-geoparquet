# Quantized XY encoding

The `quantized_xy_v1` identifier defines the encoding of the overview column
referenced by `geo.lod.overviews.column` in [SPEC.md](../SPEC.md). This document
defines its physical representation and decoding parameters. Level selection,
row alignment, non-null coverage, and primary geometry preservation follow
SPEC.md and are independent of this encoding.

The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" in this
document are to be interpreted as described in
[RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

## Physical representation and decoding

This encoding supports non-null, non-empty Line- and Polygon-family geometries.
Point-family files MUST NOT declare this encoding. Files with null or empty
geometries may omit overviews.

The referenced column has this logical structure (`<column>` is the name from
`overviews.column`):

```text
<column>: required struct<
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

Every key in `overviews.lods` MUST name exactly one `<lod>` child, and every
`<lod>` child MUST have corresponding metadata. LoD names MUST NOT be
`geometry_type`. Each LoD's metadata MUST contain `scale` and `offset`, each an
array of exactly two finite numbers. Scale values MUST be positive. Both use
primary geometry CRS units.

`geometry_type` uses the OGC WKB type codes: `2` LineString, `3` Polygon,
`5` MultiLineString, and `6` MultiPolygon. GeometryCollection is not permitted.
A row's `geometry_type` MUST describe every non-null LoD in that row. In
particular, a producer whose polygon repair can split a Polygon at some
resolutions MUST encode all of that row's polygon LoDs as MultiPolygon; an
unsplit Polygon is represented as a one-member MultiPolygon in those LoDs.

`coordinates` is the flattened coordinate sequence. Its separated `x` and `y`
leaves share the list's single offset buffer, so coordinate pairing and equal
axis lengths are structural properties of the schema. A coordinate is decoded
using the LoD metadata:

```text
x_decoded = offset[0] + scale[0] * x_integer
y_decoded = offset[1] + scale[1] * y_integer
```

For LineString, both end arrays are empty. For Polygon, `part_ends` contains the
exclusive end of each ring. For MultiLineString it contains the exclusive end
of each line. For MultiPolygon, `part_ends` contains the exclusive end of each
ring and `polygon_ends` contains the exclusive end, in ring count, of each polygon.

Only XY is represented by this encoding. Z and M ordinates, when present in the
primary geometry, are intentionally omitted.

## Producer requirements

Producers MUST choose one positive scale per axis for
each LoD and apply it to all rows. The quantization scale and simplification
tolerance SHOULD be derived from the finest `resolution` of any level
referencing that LoD.

## Validation

Validate the referenced column against the physical schema, including the
one-to-one mapping between LoD names and child fields. Check each LoD's scale
and offset, permitted geometry types, and non-null coverage as required by
[SPEC.md](../SPEC.md#boundaries).

## License

This document is licensed under [CC BY 4.0](../LICENSE-SPEC).
