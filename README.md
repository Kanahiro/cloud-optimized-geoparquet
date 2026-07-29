# Cloud Optimized GeoParquet Profile (COGP)

A GeoParquet profile for progressive map rendering and partial access over HTTP range requests or object storage.

## TL;DR

A COGP file is a valid [GeoParquet 1.1](https://geoparquet.org/) file whose row groups are
physically ordered from coarse to fine rendering detail. It may also carry a struct
sidecar with scale-appropriate WKB geometry fields for selected levels.

COGP always provides feature-level progression: row group prefixes control which features
are read. An optional geometry sidecar adds geometry-level progression by letting readers
project a scale-specific struct child. The sidecar does not need to contain every level;
a reader falls forward to the nearest finer field or, if none exists, to the primary
geometry. Each source feature appears in exactly one row group. Its primary geometry is
preserved verbatim, and any simplified sidecar geometries are used only for rendering.

Each level's `resolution` is its nominal ground resolution in meters—analogous to the
ground size of one grid cell or display pixel. The same value governs both which features
are included and which geometric details are retained; it is not a positional error
bound and does not snap coordinates to a grid.

The primary geometry column has exactly one geometry type. Mixed primary columns, such
as a combination of `Polygon` and `MultiPolygon`, are outside the profile.

A COGP-aware reader can stream just the leading row groups needed for its target
resolution. When a suitable sidecar field is present, it reads only the exact or nearest
finer field and avoids transferring and decoding the full-precision geometry. A reader
that does not understand the profile can ignore the `cogp` metadata and read the primary
geometry as ordinary GeoParquet 1.1.

## Design influences

COGP is informed by several existing cloud-optimized and progressive rendering patterns:

- Cloud Optimized GeoTIFF: remaining a valid GeoTIFF while adding cloud-friendly layout and overview structure;
- Cloud Optimized Point Cloud: remaining a valid LAZ file while adding thinning and multi-resolution level concepts;
- tippecanoe: design choice to avoid rendering every feature literally at low zoom levels.

COGP applies these ideas at both the GeoParquet row group and leaf-column levels. It
keeps the authoritative geometry unchanged, places each source feature in exactly one
level, and can store rendering-oriented simplifications without duplicating whole rows.

## Why

GeoParquet is well suited for analytics and cloud storage, but ordinary GeoParquet files are not laid out for progressive visual access. For map rendering, tile serving, and viewport-driven applications, readers often want to fetch a coarse overview first and only descend into finer detail when the display scale requires it.

COGP combines a conservative row layout with an optional profile-defined sidecar. The
primary geometry and ordinary-reader behavior remain GeoParquet-compatible.

## Benefits

- **Faster overview rendering, even for non-COGP-aware software.** Because coarse-detail features are physically placed at the front of the file, any GeoParquet 1.1 reader that streams row groups in order will see a usable overview almost immediately, without needing to understand the `cogp` metadata.
- **Efficient AoI-based spatial queries, even for non-COGP-aware software.** The layout preserves GeoParquet 1.1 semantics and row group statistics, so existing engines can still prune by bounding box and answer area-of-interest queries efficiently.
- **Minimal, resolution-targeted streaming for COGP-aware software.** A COGP-aware reader can consult the level metadata and fetch only the leading row groups required for its target geographic resolution, enabling fast progressive streaming with the smallest possible byte footprint.
- **Cheaper geometry transfer and rendering when useful.** With a sidecar, the reader
  projects only the nearest suitable child for the selected resolution, leaving the
  full-precision primary geometry and other precision levels unfetched when possible.

### Example: loading OvertureMaps buildings on QGIS 4.0

#### ordinary GeoParquet (spatially sorted)

https://github.com/user-attachments/assets/10d0390c-95ab-45e5-8503-6cbdbb015c93

#### COGP

https://github.com/user-attachments/assets/fd15605a-7d66-41a3-884d-c735e3467708

### Example: streaming from Cloudflare R2 to browser [demo page](https://kanahiro.github.io/cogp-js/)

https://github.com/user-attachments/assets/7daf178e-28b0-4440-845d-ee8f74fa5062

## Sample data

- [pois.cogp.parquet](https://cogp-demo.spatialty.io/pois.cogp.parquet) (OpenStreetMap)
- [segments.cogp.parquet](https://cogp-demo.spatialty.io/segments.cogp.parquet) (OvertureMaps)
- [buildings.cogp.parquet](https://cogp-demo.spatialty.io/buildings.cogp.parquet) (OvertureMaps)

## When COGP works well

COGP is particularly well suited to datasets of many small, well-distributed features — such as POIs or building footprints — where dropping later row groups still yields a meaningful overview.

Datasets dominated by large, complex geometries — coastlines, rivers, road networks, and
administrative boundaries — benefit especially from the geometry sidecar because coarse
views do not transfer invisible vertex detail. Producers should still tune row group size
and simplification quality together: more sidecar levels improve scale matching but
increase file size. Producers should omit the sidecar for Point and other datasets where
scale-specific geometries do not materially reduce cost.

## Specification

See [`SPEC.md`](./SPEC.md) for the normative specification.

## Roadmap

- [x] Producer implementation: a tool/library that converts existing GeoParquet 1.1 files into the COGP layout. 
- [x] Reader implementation: a client that interprets the `cogp` metadata and fetches only the leading row groups required for the target resolution via HTTP range requests.

The reference implementation and CLI live in [`cogp-rs/`](./cogp-rs/).

A proof-of-concept exploring this layout exists at [Kanahiro/yosegi](https://github.com/Kanahiro/yosegi).

## Status and feedback

COGP v1.0 is a draft. Feedback, issues, and discussion are welcome via GitHub Issues.

## License

This specification is licensed under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/). See [`LICENSE`](./LICENSE) for details.
