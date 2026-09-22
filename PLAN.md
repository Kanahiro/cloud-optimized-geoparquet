# Implementation status

Release 2.0.0 combines the upstream versionless `geo.lod` feature layout with
the optional rendering overviews, both specified in [SPEC.md](SPEC.md).
Resolution values use primary CRS units.

The writer preserves source rows and attributes, existing bbox covering paths,
unknown GeoParquet fields, null CRS values, and non-layout key-value metadata.
It adds quantized XY overviews only when the input supports that representation.
Readers retain prefix selection, page pruning, Range caching, and lazy attributes.
Rust-generated fixtures exercise refinement and shared overview coverage in both
Rust and JavaScript.
