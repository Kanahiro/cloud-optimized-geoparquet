# Cloud Optimized GeoParquet Profile (COGP)

A GeoParquet profile for progressive map rendering and partial access over HTTP range requests or object storage.

## TL;DR

A COGP file is a valid [GeoParquet 1.1](https://geoparquet.org/) file whose row groups are physically ordered from coarse to fine rendering detail, with file-level metadata describing where each level ends.

COGP is **feature-level**: it reorders features across row groups; it does not simplify, aggregate, or duplicate them. Each source feature appears in exactly one row group, with its geometry preserved verbatim.

A COGP-aware reader can stream just the leading row groups needed for its target rendering resolution and stop. A reader that does not understand the profile can ignore the `cogp` metadata and read the file as ordinary GeoParquet 1.1.

## Design influences

COGP is informed by several existing cloud-optimized and progressive rendering patterns:

- Cloud Optimized GeoTIFF: remaining a valid GeoTIFF while adding cloud-friendly layout and overview structure;
- Cloud Optimized Point Cloud: remaining a valid LAZ file while adding thinning and multi-resolution level concepts;
- tippecanoe: design choice to avoid rendering every feature literally at low zoom levels.

COGP applies these ideas at the GeoParquet row group level. Unlike raster overviews or vector tile simplification pipelines, COGP keeps each feature geometry unchanged and places each source feature in exactly one level.

## Why

GeoParquet is well suited for analytics and cloud storage, but ordinary GeoParquet files are not laid out for progressive visual access. For map rendering, tile serving, and viewport-driven applications, readers often want to fetch a coarse overview first and only descend into finer detail when the display scale requires it.

COGP is a small, conservative layout convention that enables this without changing GeoParquet's data model.

## Specification

See [`SPEC.md`](./SPEC.md) for the normative specification.

## Roadmap

- [ ] Producer implementation: a tool/library that converts existing GeoParquet 1.1 files into the COGP layout.
- [ ] Reader implementation: a client that interprets the `cogp` metadata and fetches only the leading row groups required for the target resolution via HTTP range requests.
- [ ] Benchmarking: file size, read performance...

A proof-of-concept exploring this layout exists at [Kanahiro/yosegi](https://github.com/Kanahiro/yosegi).

## Status and feedback

COGP v0.1 is an early draft. Feedback, issues, and discussion are welcome via GitHub Issues.

## License

This specification is licensed under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/). See [`LICENSE`](./LICENSE) for details.
