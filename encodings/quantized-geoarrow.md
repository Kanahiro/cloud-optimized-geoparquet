# Quantized GeoArrow encoding

The `quantized_geoarrow` identifier defines a rendering geometry encoding for
[SPEC.md](../SPEC.md). It uses the nested list and separated-coordinate structure
of [GeoArrow native geometry layouts](https://geoarrow.org/format.html), with
signed 32-bit integer XY coordinates and a per-LoD coordinate transform.

This is not a standard GeoArrow extension type: standard GeoArrow coordinates
are doubles. Integer arrays MUST NOT be labelled with standard `geoarrow.*`
extension type names. Decoding the coordinates to doubles produces the
corresponding GeoArrow geometry layout without changing list boundaries.

The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" in this
document are to be interpreted as described in
[RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

## Metadata

`geo.lod.overviews.encoding` MUST equal `quantized_geoarrow`. The column named by
`geo.lod.overviews.column` contains the representations described below; no column
name is reserved.

In addition to the `level_indices` required by SPEC.md, each entry in
`geo.lod.overviews.lods` MUST contain:

| Field | Type | Description |
| --- | --- | --- |
| `geometry_type` | string | One of `LineString`, `MultiLineString`, `Polygon`, or `MultiPolygon`. Determines the nested structure for this LoD. |
| `scale` | array of numbers | Exactly two positive finite values, ordered X, Y. |
| `offset` | array of numbers | Exactly two finite values, ordered X, Y. |

Scale and offset use the primary geometry's CRS coordinate units. One transform
applies to all rows of a given LoD. The declared geometry type applies to every
non-null value of that LoD and MUST belong to the same line or polygon family as
the primary geometry. Point-family geometries and GeometryCollection are not
supported by this encoding. Only XY is represented; primary Z and M ordinates
are intentionally omitted.

## Physical representation

The referenced top-level column MUST be a required struct. Each key in
`overviews.lods` MUST name exactly one nullable child of that struct, and every
child MUST have a corresponding metadata entry. Each child stores one complete
rendering geometry per source row.

```text
Coordinate = required struct<x: required int32, y: required int32>

LineString      = list<Coordinate>
MultiLineString = list<list<Coordinate>>
Polygon         = list<list<Coordinate>>
MultiPolygon    = list<list<list<Coordinate>>>

<column>: required struct<
  <lod>: nullable <type selected by geometry_type>,
  ...
>
```

Lists MUST use the standard Parquet LIST logical representation. Only each
LoD child's outermost list may be null or empty. All nested lists, coordinate
structs, and coordinate values MUST be non-null, and nested lists MUST be
non-empty. List element field names do not carry
geometry semantics; nesting and `geometry_type` determine the interpretation.
Coordinate fields MUST be named `x` and `y`, in that order.

For LineString, the list contains vertices. For MultiLineString, it contains
lines, each containing vertices. For Polygon, it contains rings, each containing
vertices. For MultiPolygon, it contains polygons, each containing rings.
A polygon's first ring is its exterior; subsequent rings are holes. Rings MUST
be closed, with identical first and last integer coordinate pairs.

Singular and multi geometries of the same family MUST be represented using the
Multi type when both occur in a LoD. A singular geometry then uses a one-element
outer list. A simplification or repair that splits a Polygon therefore requires
that LoD to use MultiPolygon for all its rows. No per-row geometry type column,
`part_ends`, or `polygon_ends` arrays are stored.

## Coordinate transform

Readers decode coordinates using double precision:

```text
x_decoded = offset[0] + scale[0] * x_integer
y_decoded = offset[1] + scale[1] * y_integer
```

Decoded coordinates use the primary geometry's CRS and XY axis order. Producers
quantize simplified coordinates using:

```text
q = round((coordinate - offset[axis]) / scale[axis])
```

Ties MUST round away from zero. Each quantized value MUST lie in the signed
32-bit range `[-2147483648, 2147483647]`; producers MUST NOT wrap or clamp
out-of-range values. Producers MUST choose transforms that yield finite decoded
coordinates.

## Coverage and geometry generation

The row alignment and non-null coverage rules in
[SPEC.md](../SPEC.md#boundaries) apply unchanged. Each LoD MUST be present for
every row through its effective boundary and MUST be null in later row groups.
Null MUST NOT be used to discard a geometry that collapses during simplification
or quantization.

A row whose primary geometry is null or empty MUST be represented within the
coverage by an empty outermost list: a non-null value with no parts, which
renders nothing. Empty values MUST NOT be used for any other row, including a
non-empty geometry that collapses during simplification or quantization.
Readers decode an empty value as an empty geometry of the declared
`geometry_type`. Every other value is a non-empty rendering geometry.

Producers SHOULD derive simplification tolerance and quantization scale from
the finest `resolution` among the levels identified by the LoD's `level_indices`.
Simplification and quantization MUST be considered together: the resulting integer geometry MUST
retain valid line or polygon structure, including non-degenerate parts and rings.
If the chosen parameters collapse or invalidate a geometry, producers must adjust
the parameters or repair the geometry while preserving the required coverage.
The primary geometry remains unchanged.

The encoding does not prescribe a Parquet value encoding or compression codec.

## Validation

Validate the declared geometry types, transforms, and one-to-one mapping between
LoD names and struct children. Check the physical types and nullability at each
nesting level, finite decoded coordinates, ring closure, and geometry structure.
Confirming that empty values correspond only to null or empty primary
geometries requires reading the primary geometry.
Validate row coverage against each LoD's effective boundary as defined in
[SPEC.md](../SPEC.md#boundaries). Structural validation does not establish visual
quality or a bound on simplification error.

## License

This document is licensed under [CC BY 4.0](../LICENSE-SPEC).
