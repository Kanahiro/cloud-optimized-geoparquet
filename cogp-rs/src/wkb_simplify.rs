//! Scale-based simplification and integer XY encoding for rendering overviews.
//!
//! Every LoD is derived independently from primary WKB. Source coordinates are
//! snapped once to a power-of-two grid no coarser than the tolerance, and every
//! later step works on those integer cells, so encoding never moves a vertex.
//! Polygons are made valid on the grid and then simplified only in ways that
//! keep them valid (see [`crate::overview_topology`]); lines and points have no
//! topology to preserve. Polygon-family overviews always use MultiPolygon so
//! repair cannot change the shared type between LoDs. Z/M exist only in the
//! lossless primary geometry; the overview contract intentionally emits XY
//! alone. No shared-edge topology is promised across neighboring features.

use crate::overview_topology::{self, Point, Polygons, Ring};
use anyhow::{bail, Result};
use byteorder::{BigEndian, ByteOrder, LittleEndian};

/// Per-LoD simplification settings, all in primary-geometry CRS units.
#[derive(Clone, Copy, Debug)]
pub struct OverviewParams {
    /// Simplification tolerance; also determines the quantization grid.
    pub tolerance: f64,
    /// Polygon parts and holes with area below `min_part_size²`, and line parts
    /// shorter than `min_part_size`, are omitted while a larger part of the
    /// same feature remains. Zero keeps every part.
    pub min_part_size: f64,
}

impl OverviewParams {
    #[cfg(test)]
    fn tolerance(tolerance: f64) -> Self {
        Self {
            tolerance,
            min_part_size: 0.0,
        }
    }
}

#[derive(Clone)]
struct Coordinate(Vec<f64>);

#[derive(Clone)]
struct Geometry {
    raw_type: u32,
    body: Body,
}

#[derive(Clone)]
enum Body {
    Point(Coordinate),
    LineString(Vec<Coordinate>),
    Polygon(Vec<Vec<Coordinate>>),
    Collection(Vec<Geometry>),
}

/// Internal flat representation, assembled into nested GeoArrow lists by the writer.
/// `part_ends` partitions coordinates into line strings or polygon rings;
/// `polygon_ends` partitions polygon rings for a MultiPolygon.
#[derive(Debug, Clone, PartialEq)]
pub struct QuantizedOverview {
    pub geometry_type: i8,
    pub x: Vec<i32>,
    pub y: Vec<i32>,
    pub part_ends: Vec<i32>,
    pub polygon_ends: Vec<i32>,
}

impl QuantizedOverview {
    /// The zero-part value covering a null or empty source row. It uses the
    /// LoD's Multi type, so it renders nothing and needs no coordinate lists.
    pub fn empty(polygon: bool) -> Self {
        Self {
            geometry_type: if polygon { 6 } else { 5 },
            x: Vec::new(),
            y: Vec::new(),
            part_ends: Vec::new(),
            polygon_ends: Vec::new(),
        }
    }
}

/// The actual coordinate grid used for a requested rendering tolerance.
/// Power-of-two spacing improves compression and is never coarser than the
/// requested tolerance.
pub fn overview_scale(tolerance: f64) -> Result<f64> {
    validate_tolerance(tolerance)?;
    Ok(quantization_grid(tolerance))
}

/// Build an XY-only integer overview. `offset` must be aligned to `scale`;
/// producers normally choose an aligned point near the dataset bbox centre so
/// signed 32-bit coordinates cover the largest possible extent.
#[cfg(test)]
pub fn quantized_overview(
    bytes: &[u8],
    tolerance: f64,
    offset: [f64; 2],
) -> Result<QuantizedOverview> {
    let params = OverviewParams::tolerance(tolerance);
    quantized_overview_with_fallback(bytes, &params, &params, offset)?
        .ok_or_else(|| anyhow::anyhow!("empty source geometry"))
}

/// Build an overview, repeating a coarser representation when the requested
/// grid collapses a polygon that no surrogate can stand in for. Simplification
/// viability is not monotonic across fixed grids: a thin polygon can be valid
/// on one grid, collapse on the next, and become valid again on a finer grid.
/// Reusing the feature's entry-level shape keeps it visible without requiring
/// callers to understand or pre-scan that edge case. `offset` must be aligned
/// to the grid.
///
/// Returns `None` for an empty source geometry; callers cover it with
/// [`QuantizedOverview::empty`] of the LoD's family.
pub fn quantized_overview_with_fallback(
    bytes: &[u8],
    params: &OverviewParams,
    fallback: &OverviewParams,
    offset: [f64; 2],
) -> Result<Option<QuantizedOverview>> {
    validate_params(params)?;
    validate_params(fallback)?;
    if fallback.tolerance < params.tolerance {
        bail!("overview fallback tolerance must be at least the requested tolerance");
    }
    let mut source = parse_complete_geometry(bytes)?;
    if !has_coordinates(&source) {
        return Ok(None);
    }
    strip_to_xy(&mut source);
    let grid = quantization_grid(params.tolerance);
    let geometry = match build_overview(&source, params) {
        OverviewOutcome::Built(geometry) => geometry,
        // A feature can reach the finest level without being viable at that
        // level (for example, a sub-pixel polygon). Its required overview must
        // still be independently renderable without falling back to WKB.
        OverviewOutcome::NotViable | OverviewOutcome::PreserveSource => {
            rendering_fallback(&source, grid)
                .or_else(|| {
                    if fallback.tolerance == params.tolerance {
                        return None;
                    }
                    // Power-of-two grids nest, so a coarser overview is exact
                    // on this grid after scaling.
                    let factor = quantization_grid(fallback.tolerance) / grid;
                    match build_overview(&source, fallback) {
                        OverviewOutcome::Built(geometry) if factor.fract() == 0.0 => {
                            Some(geometry.scaled(factor as i64))
                        }
                        _ => None,
                    }
                })
                .ok_or_else(|| {
                    anyhow::anyhow!("geometry cannot be represented as a valid rendering overview")
                })?
        }
    };
    geometry.encode(grid, offset).map(Some)
}

/// Empty geometries carry no display scale; they are covered by an empty value.
fn has_coordinates(geometry: &Geometry) -> bool {
    match &geometry.body {
        Body::Point(point) => point.0.iter().any(|value| !value.is_nan()),
        Body::LineString(points) => !points.is_empty(),
        Body::Polygon(rings) => rings.iter().any(|ring| !ring.is_empty()),
        Body::Collection(children) => children.iter().any(has_coordinates),
    }
}

/// An overview in absolute grid cells. Polygon rings are implicitly closed.
#[derive(Debug)]
enum GridGeometry {
    Points { multi: bool, points: Vec<Point> },
    Lines { multi: bool, lines: Vec<Vec<Point>> },
    Polygons(Polygons),
}

impl GridGeometry {
    fn scaled(mut self, factor: i64) -> Self {
        let scale = |point: &mut Point| *point = [point[0] * factor, point[1] * factor];
        match &mut self {
            Self::Points { points, .. } => points.iter_mut().for_each(scale),
            Self::Lines { lines, .. } => lines.iter_mut().flatten().for_each(scale),
            Self::Polygons(polygons) => polygons.iter_mut().flatten().flatten().for_each(scale),
        }
        self
    }

    /// Translate cells to the LoD's offset. This is exact, so the encoded
    /// geometry has the same topology as the one that was built.
    fn encode(&self, grid: f64, offset: [f64; 2]) -> Result<QuantizedOverview> {
        let shift = offset.map(|value| value / grid);
        if shift
            .iter()
            .any(|value| value.fract() != 0.0 || value.abs() >= MAX_CELL)
        {
            bail!("overview offset must be a finite multiple of the quantization grid");
        }
        let shift = shift.map(|value| value as i64);
        let (geometry_type, parts): (i8, Vec<&[Point]>) = match self {
            Self::Points { multi, points } => (
                if *multi { 4 } else { 1 },
                points.iter().map(std::slice::from_ref).collect(),
            ),
            Self::Lines { multi, lines } => (
                if *multi { 5 } else { 2 },
                lines.iter().map(Vec::as_slice).collect(),
            ),
            Self::Polygons(polygons) => (6, polygons.iter().flatten().map(Vec::as_slice).collect()),
        };
        let mut overview = QuantizedOverview {
            geometry_type,
            x: Vec::new(),
            y: Vec::new(),
            part_ends: Vec::new(),
            polygon_ends: Vec::new(),
        };
        let closed = matches!(self, Self::Polygons(_));
        for part in parts {
            let closing = part.first().filter(|_| closed);
            for point in part.iter().chain(closing) {
                for (value, shift, output) in [
                    (point[0], shift[0], &mut overview.x),
                    (point[1], shift[1], &mut overview.y),
                ] {
                    let Ok(value) = i32::try_from(value - shift) else {
                        bail!(
                            "overview coordinate exceeds the signed 32-bit range; use coarser resolutions"
                        );
                    };
                    output.push(value);
                }
            }
            if matches!(geometry_type, 5 | 6) {
                overview.part_ends.push(i32::try_from(overview.x.len())?);
            }
        }
        if let Self::Polygons(polygons) = self {
            let mut rings = 0;
            for polygon in polygons {
                rings += polygon.len();
                overview.polygon_ends.push(i32::try_from(rings)?);
            }
        }
        Ok(overview)
    }
}

/// Return the first coarse-to-fine tolerance at which the geometry remains
/// independently renderable. Parsing happens once; each candidate simplifies
/// the source independently so approximation error never accumulates between levels.
pub fn first_viable_level(bytes: &[u8], levels: &[OverviewParams]) -> Result<usize> {
    if levels.is_empty() {
        bail!("simplification profile requires at least one tolerance");
    }
    let mut geometry = parse_complete_geometry(bytes)?;
    if !has_coordinates(&geometry) {
        // Level assignment already defers empty geometries to the final level.
        return Ok(0);
    }
    strip_to_xy(&mut geometry);
    for (level, params) in levels.iter().enumerate() {
        validate_params(params)?;
        if matches!(build_overview(&geometry, params), OverviewOutcome::Built(_)) {
            return Ok(level);
        }
    }
    // Rows that never become viable are still stored at the final level.
    // Check their required fallback during the scan, before writing a large
    // output that would otherwise fail only near its last row group.
    let grid = quantization_grid(levels.last().unwrap().tolerance);
    if rendering_fallback(&geometry, grid).is_none() {
        bail!("geometry cannot be represented as a valid rendering overview at the final level");
    }
    Ok(levels.len() - 1)
}

enum OverviewOutcome {
    Built(GridGeometry),
    /// The feature is too small to see at this LoD.
    NotViable,
    /// The feature cannot be represented on this grid.
    PreserveSource,
}

fn validate_tolerance(tolerance: f64) -> Result<()> {
    if !tolerance.is_finite() || tolerance <= 0.0 {
        bail!("simplification tolerance must be positive and finite");
    }
    Ok(())
}

fn validate_params(params: &OverviewParams) -> Result<()> {
    validate_tolerance(params.tolerance)?;
    if !params.min_part_size.is_finite() || params.min_part_size < 0.0 {
        bail!("minimum part size must be non-negative and finite");
    }
    Ok(())
}

fn parse_complete_geometry(bytes: &[u8]) -> Result<Geometry> {
    let mut offset = 0;
    let geometry = parse_geometry(bytes, &mut offset, 0)?;
    if offset != bytes.len() {
        bail!("trailing bytes after WKB geometry");
    }
    Ok(geometry)
}

/// Rendering overviews deliberately omit Z and M.
fn strip_to_xy(geometry: &mut Geometry) {
    fn strip_coordinate(coordinate: &mut Coordinate) {
        coordinate.0.truncate(2);
    }

    match &mut geometry.body {
        Body::Point(point) => strip_coordinate(point),
        Body::LineString(points) => points.iter_mut().for_each(strip_coordinate),
        Body::Polygon(rings) => rings.iter_mut().flatten().for_each(strip_coordinate),
        Body::Collection(children) => children.iter_mut().for_each(strip_to_xy),
    }
}

/// Build one overview using only the source geometry and requested tolerance.
/// Keeping viability and materialization behind this interface prevents them
/// from disagreeing about grid collapse.
fn build_overview(source: &Geometry, params: &OverviewParams) -> OverviewOutcome {
    let grid = quantization_grid(params.tolerance);
    build(
        source,
        &BuildContext {
            tolerance2: params.tolerance * params.tolerance,
            min_part_size: params.min_part_size,
            grid,
            simplify: Some(params.tolerance / grid),
        },
    )
}

/// Preserve as much source shape as the target grid permits when ordinary
/// simplification cannot produce a viable required overview: every source
/// vertex is snapped and every part kept, and sub-grid lines/polygons receive a
/// one-cell rendering surrogate rather than an empty or invalid geometry.
fn rendering_fallback(source: &Geometry, grid: f64) -> Option<GridGeometry> {
    let context = BuildContext {
        tolerance2: 0.0,
        min_part_size: 0.0,
        grid,
        simplify: None,
    };
    match build(source, &context) {
        OverviewOutcome::Built(geometry) => Some(geometry),
        OverviewOutcome::NotViable | OverviewOutcome::PreserveSource => None,
    }
}

struct BuildContext {
    tolerance2: f64,
    min_part_size: f64,
    grid: f64,
    /// Simplification tolerance in grid cells. `None` keeps every snapped
    /// vertex and every part, without viability checks.
    simplify: Option<f64>,
}

fn build(source: &Geometry, context: &BuildContext) -> OverviewOutcome {
    let children = |kind: u32| match &source.body {
        Body::Collection(children)
            if children
                .iter()
                .all(|child| geometry_kind(child.raw_type) == kind) =>
        {
            Some(children.iter().map(|child| &child.body).collect::<Vec<_>>())
        }
        _ => None,
    };
    let built = match (geometry_kind(source.raw_type), &source.body) {
        (1, Body::Point(point)) => snap(point, context.grid).map(|point| GridGeometry::Points {
            multi: false,
            points: vec![point],
        }),
        (4, _) => children(1).and_then(|points| {
            let points = points
                .into_iter()
                .map(|body| match body {
                    Body::Point(point) => snap(point, context.grid),
                    _ => None,
                })
                .collect::<Option<_>>()?;
            Some(GridGeometry::Points {
                multi: true,
                points,
            })
        }),
        (2, Body::LineString(points)) => {
            return lines_overview(&[points], context).map_or_else(
                |outcome| outcome,
                |lines| {
                    OverviewOutcome::Built(GridGeometry::Lines {
                        multi: false,
                        lines,
                    })
                },
            )
        }
        (5, _) => {
            let Some(lines) = children(2).and_then(|bodies| {
                bodies
                    .into_iter()
                    .map(|body| match body {
                        Body::LineString(points) => Some(points),
                        _ => None,
                    })
                    .collect::<Option<Vec<_>>>()
            }) else {
                return OverviewOutcome::PreserveSource;
            };
            return lines_overview(&lines, context).map_or_else(
                |outcome| outcome,
                |lines| OverviewOutcome::Built(GridGeometry::Lines { multi: true, lines }),
            );
        }
        (3, Body::Polygon(rings)) => return polygons_overview(&[rings], context),
        (6, _) => {
            let Some(members) = children(3).and_then(|bodies| {
                bodies
                    .into_iter()
                    .map(|body| match body {
                        Body::Polygon(rings) => Some(rings),
                        _ => None,
                    })
                    .collect::<Option<Vec<_>>>()
            }) else {
                return OverviewOutcome::PreserveSource;
            };
            return polygons_overview(&members, context);
        }
        _ => None,
    };
    built.map_or(OverviewOutcome::PreserveSource, OverviewOutcome::Built)
}

/// Multi* members to represent: in a simplified LoD, members large enough to
/// see that also survive simplification. Omitting small members must not
/// change when a feature first becomes renderable, so when no large member
/// survives, every member is considered.
fn select_members<'a, T: ?Sized>(
    members: &[&'a T],
    context: &BuildContext,
    small: impl Fn(&T) -> bool,
    viable: impl Fn(&T) -> bool,
) -> Vec<&'a T> {
    if context.simplify.is_none() {
        return members.to_vec();
    }
    let significant: Vec<_> = members
        .iter()
        .copied()
        .filter(|member| !small(member))
        .collect();
    let selected: Vec<_> = significant
        .iter()
        .copied()
        .filter(|member| viable(member))
        .collect();
    if selected.is_empty() && significant.len() < members.len() {
        return members
            .iter()
            .copied()
            .filter(|member| viable(member))
            .collect();
    }
    selected
}

fn lines_overview(
    members: &[&Vec<Coordinate>],
    context: &BuildContext,
) -> std::result::Result<Vec<Vec<Point>>, OverviewOutcome> {
    let selected = select_members(
        members,
        context,
        |points| context.min_part_size > 0.0 && line_length(points) < context.min_part_size,
        |points| {
            let simplified = select(points, &simplify_indices(points, context.tolerance2, 2));
            simplified.len() >= 2 && line_length(&simplified) > context.tolerance2.sqrt()
        },
    );
    if selected.is_empty() {
        return Err(OverviewOutcome::NotViable);
    }
    selected
        .into_iter()
        .map(|points| line_overview(points, context))
        .collect::<Option<_>>()
        .ok_or(OverviewOutcome::PreserveSource)
}

fn line_overview(points: &[Coordinate], context: &BuildContext) -> Option<Vec<Point>> {
    let mut snapped = points
        .iter()
        .map(|point| snap(point, context.grid))
        .collect::<Option<Vec<_>>>()?;
    snapped.dedup();
    if snapped.len() < 2 {
        return revive_short_line(points, context.grid);
    }
    if let Some(tolerance) = context.simplify {
        let cells: Vec<_> = snapped
            .iter()
            .map(|point| Coordinate(vec![point[0] as f64, point[1] as f64]))
            .collect();
        // A closed line keeps a third vertex so it cannot collapse to a point.
        let minimum = if snapped.first() == snapped.last() {
            3
        } else {
            2
        };
        let kept = simplify_indices(&cells, tolerance * tolerance, minimum);
        snapped = kept.into_iter().map(|index| snapped[index]).collect();
    }
    Some(snapped)
}

fn polygons_overview(members: &[&Vec<Vec<Coordinate>>], context: &BuildContext) -> OverviewOutcome {
    let selected = select_members(
        members,
        context,
        |rings| polygon_is_small(rings, context.min_part_size),
        |rings| {
            rings
                .first()
                .is_some_and(|shell| ring_indices(shell, context.tolerance2).is_some())
        },
    );
    if selected.is_empty() {
        return OverviewOutcome::NotViable;
    }
    // A collapsed or sub-pixel hole is too small to see, not a reason to
    // discard an otherwise viable polygon.
    let kept_rings: Vec<Vec<&Vec<Coordinate>>> = selected
        .iter()
        .map(|rings| {
            let holes = rings[1..].iter().filter(|hole| {
                context.simplify.is_none()
                    || (!is_small_hole(hole, context.min_part_size)
                        && ring_indices(hole, context.tolerance2).is_some())
            });
            rings[..1].iter().chain(holes).collect()
        })
        .collect();
    let Some(snapped) = kept_rings
        .iter()
        .map(|rings| {
            rings
                .iter()
                .map(|ring| {
                    ring.iter()
                        .map(|point| snap(point, context.grid))
                        .collect::<Option<Ring>>()
                })
                .collect::<Option<Vec<_>>>()
        })
        .collect::<Option<Polygons>>()
    else {
        return OverviewOutcome::PreserveSource;
    };
    let revive = |index: usize| revive_tiny_polygon(selected[index], &snapped[index], context.grid);
    let Some(mut polygons) = overview_topology::normalize(snapped.clone(), revive) else {
        return OverviewOutcome::PreserveSource;
    };
    if let Some(tolerance) = context.simplify {
        overview_topology::simplify(&mut polygons, tolerance);
    }
    OverviewOutcome::Built(GridGeometry::Polygons(polygons))
}

fn polygon_is_small(rings: &[Vec<Coordinate>], min_part_size: f64) -> bool {
    if min_part_size <= 0.0 {
        return false;
    }
    let exterior = rings.first().map_or(0.0, |ring| ring_area(ring));
    let holes: f64 = rings.iter().skip(1).map(|ring| ring_area(ring)).sum();
    exterior - holes < min_part_size * min_part_size
}

fn is_small_hole(ring: &[Coordinate], min_part_size: f64) -> bool {
    min_part_size > 0.0 && ring_area(ring) < min_part_size * min_part_size
}

fn ring_area(ring: &[Coordinate]) -> f64 {
    signed_area2(ring).abs() / 2.0
}

/// Cells beyond this magnitude lose integer precision in `f64`.
const MAX_CELL: f64 = (1u64 << 52) as f64;

fn snap(coordinate: &Coordinate, grid: f64) -> Option<Point> {
    let x = (coordinate.0[0] / grid).round();
    let y = (coordinate.0[1] / grid).round();
    // Comparisons are false for NaN, so non-finite input is rejected too.
    (x.abs() < MAX_CELL && y.abs() < MAX_CELL).then_some([x as i64, y as i64])
}

/// Tippecanoe revives a polygon that disappears at tile precision as a small
/// rectangle. Restrict that approximation to tiny or sub-grid-width polygons
/// so a collapse cannot replace a substantial two-dimensional feature.
/// `snapped` is the source snapped to the grid.
fn revive_tiny_polygon(
    source_rings: &[Vec<Coordinate>],
    snapped: &[Ring],
    grid: f64,
) -> Option<Ring> {
    // Up to 8×8 output cells is still a small rendering symbol at the target
    // LoD. Administrative datasets contain thin rings whose signed source area
    // is several cells even though every lobe collapses onto the same grid
    // lines; rejecting those polygons makes an otherwise valid file impossible
    // to render or even produce.
    const MAX_AREA_IN_GRID_CELLS: f64 = 64.0;

    let exterior_area2 = signed_area2(source_rings.first()?).abs();
    let holes_area2: f64 = source_rings[1..]
        .iter()
        .map(|ring| signed_area2(ring).abs())
        .sum();
    let area_in_grid_cells = ((exterior_area2 - holes_area2).max(0.0) / 2.0) / (grid * grid);
    if !area_in_grid_cells.is_finite() || area_in_grid_cells <= 0.0 {
        return None;
    }

    let points: Vec<[f64; 2]> = snapped
        .iter()
        .flatten()
        .map(|point| [point[0] as f64, point[1] as f64])
        .collect();
    if points.is_empty() {
        return None;
    }
    let center_x = points.iter().map(|point| point[0]).sum::<f64>() / points.len() as f64;
    let center_y = points.iter().map(|point| point[1]).sum::<f64>() / points.len() as f64;
    let extent = |axis: usize| {
        let values = points.iter().map(|point| point[axis]);
        values.clone().fold(f64::NEG_INFINITY, f64::max) - values.fold(f64::INFINITY, f64::min)
    };
    // Measure width perpendicular to the source's long axis. Axis-aligned
    // bbox width misses diagonal slivers that also disappear on the grid.
    let axis = usize::from(extent(1) > extent(0));
    let start = source_rings
        .iter()
        .flatten()
        .min_by(|a, b| a.0[axis].total_cmp(&b.0[axis]))?;
    let end = source_rings
        .iter()
        .flatten()
        .max_by(|a, b| a.0[axis].total_cmp(&b.0[axis]))?;
    // Use the midpoint of each end cap: choosing opposite corners would
    // overestimate a tapered strip's width by adding both end-cap widths.
    let end_cap = |position: f64| {
        let (min, max) = source_rings
            .iter()
            .flatten()
            .filter(|p| p.0[axis] == position)
            .map(|p| p.0[1 - axis])
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(min, max), v| {
                (min.min(v), max.max(v))
            });
        let mut point = [0.0; 2];
        point[axis] = position / grid;
        point[1 - axis] = (min + max) * 0.5 / grid;
        point
    };
    let a = end_cap(start.0[axis]);
    let b = end_cap(end.0[axis]);
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let length = dx.hypot(dy);
    let (min_distance, max_distance) = source_rings
        .iter()
        .flatten()
        .map(|p| ((p.0[0] / grid - a[0]) * -dy + (p.0[1] / grid - a[1]) * dx) / length)
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(min, max), d| {
            (min.min(d), max.max(d))
        });
    let a = [a[0].round(), a[1].round()];
    let b = [b[0].round(), b[1].round()];
    let corners = if length > 0.0 && max_distance - min_distance <= 1.0 && a[axis] != b[axis] {
        // Preserve the long axis. A one-cell transverse step makes a valid
        // grid polygon without replacing the feature with a compact symbol.
        let step = if axis == 1 { [1.0, 0.0] } else { [0.0, 1.0] };
        [
            a,
            b,
            [b[0] + step[0], b[1] + step[1]],
            [a[0] + step[0], a[1] + step[1]],
        ]
    } else {
        if area_in_grid_cells > MAX_AREA_IN_GRID_CELLS {
            return None;
        }
        let height = area_in_grid_cells.sqrt().ceil().max(1.0);
        let width = (area_in_grid_cells / height).round().max(1.0);
        let x0 = center_x.round() - (width / 2.0).floor();
        let y0 = center_y.round() - (height / 2.0).floor();
        [
            [x0, y0],
            [x0 + width, y0],
            [x0 + width, y0 + height],
            [x0, y0 + height],
        ]
    };
    corners
        .into_iter()
        .map(|[x, y]| (x.abs() < MAX_CELL && y.abs() < MAX_CELL).then_some([x as i64, y as i64]))
        .collect()
}

/// A line shorter than one cell becomes a one-cell segment along its longer
/// extent.
fn revive_short_line(points: &[Coordinate], grid: f64) -> Option<Vec<Point>> {
    if points.len() < 2 || line_length(points) == 0.0 {
        return None;
    }
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for point in points {
        if !point.0[0].is_finite() || !point.0[1].is_finite() {
            return None;
        }
        min_x = min_x.min(point.0[0]);
        min_y = min_y.min(point.0[1]);
        max_x = max_x.max(point.0[0]);
        max_y = max_y.max(point.0[1]);
    }
    let center = snap(
        &Coordinate(vec![(min_x + max_x) * 0.5, (min_y + max_y) * 0.5]),
        grid,
    )?;
    let end = if max_x - min_x >= max_y - min_y {
        [center[0] + 1, center[1]]
    } else {
        [center[0], center[1] + 1]
    };
    Some(vec![center, end])
}

/// Choose the largest power-of-two grid spacing no greater than the requested
/// tolerance. Besides staying inside the existing precision budget, this makes
/// rounded f64 values share zeroed mantissa bits instead of merely sharing
/// multiples of an arbitrary floating-point value.
fn quantization_grid(tolerance: f64) -> f64 {
    let grid = f64::from_bits(tolerance.to_bits() & 0x7ff0_0000_0000_0000);
    if grid == 0.0 {
        tolerance
    } else {
        grid
    }
}

/// Retained indices of a closed source ring simplified at `tolerance2`, or
/// `None` when it collapses. This decides viability only; the overview itself
/// is simplified on the grid.
fn ring_indices(ring: &[Coordinate], tolerance2: f64) -> Option<Vec<usize>> {
    if ring.len() < 4 || !same_xy(&ring[0], ring.last()?) {
        return None;
    }
    // A ring that collapses below three unique vertices is deferred to a finer level.
    let unclosed = &ring[..ring.len() - 1];
    let viability = select(unclosed, &simplify_indices(unclosed, tolerance2, 2));
    if viability.len() < 3 || signed_area2(&viability) == 0.0 {
        return None;
    }

    // Tippecanoe passes the duplicated closing point through Douglas-Peucker
    // and forces four retained coordinates. Starting from the degenerate
    // first-to-last segment avoids making an arbitrary ring edge the baseline.
    let kept = simplify_indices(ring, tolerance2, 4);
    let simplified = select(ring, &kept);
    if simplified.len() < 4
        || !same_xy(&simplified[0], simplified.last()?)
        || signed_area2(&simplified[..simplified.len() - 1]) == 0.0
    {
        return None;
    }
    Some(kept)
}

fn select(points: &[Coordinate], indices: &[usize]) -> Vec<Coordinate> {
    indices.iter().map(|&index| points[index].clone()).collect()
}

fn geometry_kind(raw_type: u32) -> u32 {
    (raw_type & 0xffff) % 1000
}

fn signed_area2(points: &[Coordinate]) -> f64 {
    let Some(origin) = points.first() else {
        return 0.0;
    };
    // Polygon area is translation invariant. Subtracting a nearby origin
    // avoids catastrophic cancellation for sub-meter footprints expressed as
    // longitude/latitude values far from zero.
    let origin_x = origin.0[0];
    let origin_y = origin.0[1];
    let mut area2 = 0.0;
    for index in 0..points.len() {
        let next = (index + 1) % points.len();
        let x0 = points[index].0[0] - origin_x;
        let y0 = points[index].0[1] - origin_y;
        let x1 = points[next].0[0] - origin_x;
        let y1 = points[next].0[1] - origin_y;
        area2 += x0 * y1 - x1 * y0;
    }
    area2
}

fn line_length(points: &[Coordinate]) -> f64 {
    points
        .windows(2)
        .map(|segment| {
            let dx = segment[1].0[0] - segment[0].0[0];
            let dy = segment[1].0[1] - segment[0].0[1];
            dx.hypot(dy)
        })
        .sum()
}

/// Ramer-Douglas-Peucker with a minimum output cardinality, returning the
/// retained indices (always including both endpoints). Every overview is
/// derived directly from raw WKB, so errors do not accumulate between levels.
fn simplify_indices(points: &[Coordinate], tolerance2: f64, minimum: usize) -> Vec<usize> {
    if points.len() <= minimum {
        return (0..points.len()).collect();
    }
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut retained = 2;
    let mut stack = vec![(0usize, points.len() - 1)];
    while let Some((start, end)) = stack.pop() {
        let mut greatest_distance2 = if retained < minimum { -1.0 } else { tolerance2 };
        let mut greatest_index = None;
        for index in start + 1..end {
            let distance2 = segment_distance2(&points[index], &points[start], &points[end]);
            if distance2 > greatest_distance2 {
                greatest_distance2 = distance2;
                greatest_index = Some(index);
            }
        }
        if let Some(index) = greatest_index {
            keep[index] = true;
            retained += 1;
            stack.push((start, index));
            stack.push((index, end));
        }
    }
    if retained < minimum {
        return (0..points.len()).collect();
    }
    keep.iter()
        .enumerate()
        .filter_map(|(index, keep)| keep.then_some(index))
        .collect()
}

fn segment_distance2(point: &Coordinate, start: &Coordinate, end: &Coordinate) -> f64 {
    let (px, py) = (point.0[0], point.0[1]);
    let (ax, ay) = (start.0[0], start.0[1]);
    let (bx, by) = (end.0[0], end.0[1]);
    let (dx, dy) = (bx - ax, by - ay);
    if dx == 0.0 && dy == 0.0 {
        return (px - ax).powi(2) + (py - ay).powi(2);
    }
    let t = (((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
    (px - (ax + t * dx)).powi(2) + (py - (ay + t * dy)).powi(2)
}

fn same_xy(left: &Coordinate, right: &Coordinate) -> bool {
    left.0[0] == right.0[0] && left.0[1] == right.0[1]
}

fn parse_geometry(bytes: &[u8], offset: &mut usize, depth: usize) -> Result<Geometry> {
    anyhow::ensure!(depth < 64, "WKB nesting exceeds 64 levels");
    let byte_order = take_u8(bytes, offset)?;
    if byte_order > 1 {
        bail!("invalid WKB byte order: {byte_order}");
    }
    let raw_type = take_u32(bytes, offset, byte_order)?;
    let dimensions = crate::wkb_bbox::wkb_dimensions(raw_type);
    if raw_type & 0x2000_0000 != 0 {
        // EWKB SRID; overviews do not carry it.
        take_u32(bytes, offset, byte_order)?;
    }
    let kind = geometry_kind(raw_type);
    let body = match kind {
        1 => Body::Point(take_coordinate(bytes, offset, byte_order, dimensions)?),
        2 => Body::LineString(take_coordinates(bytes, offset, byte_order, dimensions)?),
        3 => {
            let count = take_u32(bytes, offset, byte_order)? as usize;
            let mut rings = checked_capacity(count, bytes.len() - *offset, 4)?;
            for _ in 0..count {
                rings.push(take_coordinates(bytes, offset, byte_order, dimensions)?);
            }
            Body::Polygon(rings)
        }
        4..=7 => {
            let count = take_u32(bytes, offset, byte_order)? as usize;
            let mut children = checked_capacity(count, bytes.len() - *offset, 5)?;
            for _ in 0..count {
                let child = parse_geometry(bytes, offset, depth + 1)?;
                anyhow::ensure!(
                    kind == 7 || geometry_kind(child.raw_type) == kind - 3,
                    "invalid WKB Multi geometry child type"
                );
                children.push(child);
            }
            Body::Collection(children)
        }
        _ => bail!("unsupported WKB geometry type: {kind}"),
    };
    Ok(Geometry { raw_type, body })
}

fn take_u8(bytes: &[u8], offset: &mut usize) -> Result<u8> {
    let value = *bytes
        .get(*offset)
        .ok_or_else(|| anyhow::anyhow!("truncated WKB"))?;
    *offset += 1;
    Ok(value)
}

fn take_u32(bytes: &[u8], offset: &mut usize, order: u8) -> Result<u32> {
    let bytes = take(bytes, offset, 4)?;
    Ok(if order == 0 {
        BigEndian::read_u32(bytes)
    } else {
        LittleEndian::read_u32(bytes)
    })
}

fn take_f64(bytes: &[u8], offset: &mut usize, order: u8) -> Result<f64> {
    let bytes = take(bytes, offset, 8)?;
    Ok(if order == 0 {
        BigEndian::read_f64(bytes)
    } else {
        LittleEndian::read_f64(bytes)
    })
}

fn take<'a>(bytes: &'a [u8], offset: &mut usize, length: usize) -> Result<&'a [u8]> {
    let end = offset
        .checked_add(length)
        .ok_or_else(|| anyhow::anyhow!("WKB offset overflow"))?;
    let value = bytes
        .get(*offset..end)
        .ok_or_else(|| anyhow::anyhow!("truncated WKB"))?;
    *offset = end;
    Ok(value)
}

fn take_coordinate(
    bytes: &[u8],
    offset: &mut usize,
    order: u8,
    dimensions: usize,
) -> Result<Coordinate> {
    let mut ordinates = Vec::with_capacity(dimensions);
    for _ in 0..dimensions {
        ordinates.push(take_f64(bytes, offset, order)?);
    }
    Ok(Coordinate(ordinates))
}

// Reject impossible counts before allocation, then surface allocation failures as errors.
fn checked_capacity<T>(count: usize, remaining: usize, minimum_bytes: usize) -> Result<Vec<T>> {
    anyhow::ensure!(
        count <= remaining / minimum_bytes,
        "WKB count exceeds remaining bytes"
    );
    let mut values = Vec::new();
    values.try_reserve_exact(count)?;
    Ok(values)
}

fn take_coordinates(
    bytes: &[u8],
    offset: &mut usize,
    order: u8,
    dimensions: usize,
) -> Result<Vec<Coordinate>> {
    let count = take_u32(bytes, offset, order)? as usize;
    let mut coordinates = checked_capacity(count, bytes.len() - *offset, dimensions * 8)?;
    for _ in 0..count {
        coordinates.push(take_coordinate(bytes, offset, order, dimensions)?);
    }
    Ok(coordinates)
}

#[cfg(test)]
fn put_u32(output: &mut Vec<u8>, value: u32, order: u8) {
    let mut bytes = [0; 4];
    if order == 0 {
        BigEndian::write_u32(&mut bytes, value);
    } else {
        LittleEndian::write_u32(&mut bytes, value);
    }
    output.extend_from_slice(&bytes);
}

#[cfg(test)]
fn put_f64(output: &mut Vec<u8>, value: f64, order: u8) {
    let mut bytes = [0; 8];
    if order == 0 {
        BigEndian::write_f64(&mut bytes, value);
    } else {
        LittleEndian::write_f64(&mut bytes, value);
    }
    output.extend_from_slice(&bytes);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry_validation::multipolygon_valid;
    use geo::{Coord, LineString, Polygon};

    fn levels(tolerances: &[f64]) -> Vec<OverviewParams> {
        tolerances
            .iter()
            .map(|&tolerance| OverviewParams::tolerance(tolerance))
            .collect()
    }

    fn polygon_wkb(rings: &[Vec<(f64, f64)>]) -> Vec<u8> {
        let mut wkb = vec![1];
        put_u32(&mut wkb, 3, 1);
        put_u32(&mut wkb, rings.len() as u32, 1);
        for ring in rings {
            put_u32(&mut wkb, ring.len() as u32, 1);
            for &(x, y) in ring {
                put_f64(&mut wkb, x, 1);
                put_f64(&mut wkb, y, 1);
            }
        }
        wkb
    }

    fn multi_wkb(kind: u32, members: &[Vec<u8>]) -> Vec<u8> {
        let mut wkb = vec![1];
        put_u32(&mut wkb, kind, 1);
        put_u32(&mut wkb, members.len() as u32, 1);
        for member in members {
            wkb.extend(member);
        }
        wkb
    }

    fn line_wkb(points: &[(f64, f64)]) -> Vec<u8> {
        let mut wkb = vec![1];
        put_u32(&mut wkb, 2, 1);
        put_u32(&mut wkb, points.len() as u32, 1);
        for &(x, y) in points {
            put_f64(&mut wkb, x, 1);
            put_f64(&mut wkb, y, 1);
        }
        wkb
    }

    fn square(x: f64, y: f64, side: f64) -> Vec<(f64, f64)> {
        vec![
            (x, y),
            (x + side, y),
            (x + side, y + side),
            (x, y + side),
            (x, y),
        ]
    }

    fn review_rectangle(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<u8> {
        polygon_wkb(&[vec![(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]])
    }

    /// Decode a polygon overview and check it against the validator's rules.
    fn assert_valid_quantized_multipolygon(overview: &QuantizedOverview) {
        assert_eq!(overview.geometry_type, 6);
        assert_eq!(overview.x.len(), overview.y.len());
        assert!(!overview.polygon_ends.is_empty());
        let mut coordinate_start = 0;
        let mut ring_start = 0;
        let mut polygons = Vec::new();
        for &polygon_end in &overview.polygon_ends {
            let polygon_end = polygon_end as usize;
            assert!(polygon_end > ring_start && polygon_end <= overview.part_ends.len());
            let mut rings = Vec::new();
            for &part_end in &overview.part_ends[ring_start..polygon_end] {
                let part_end = part_end as usize;
                assert!(part_end > coordinate_start && part_end <= overview.x.len());
                rings.push(LineString(
                    (coordinate_start..part_end)
                        .map(|index| Coord {
                            x: overview.x[index] as f64,
                            y: overview.y[index] as f64,
                        })
                        .collect(),
                ));
                coordinate_start = part_end;
            }
            let exterior = rings.remove(0);
            polygons.push(Polygon::new(exterior, rings));
            ring_start = polygon_end;
        }
        assert_eq!(coordinate_start, overview.x.len());
        assert_eq!(ring_start, overview.part_ends.len());
        assert!(
            multipolygon_valid(&polygons),
            "invalid overview: {overview:?}"
        );
    }

    #[test]
    fn buildings_l12_regression() {
        // An overlay attached holes to the wrong shells for this building.
        let wkb = include_bytes!("../tests/fixtures/buildings-invalid-l12.wkb");
        let params = OverviewParams {
            tolerance: 0.00008583029586459785 * 0.25,
            min_part_size: 0.00008583029586459785,
        };
        let offset = [137.9925994873047, 33.21240234375];
        let overview = quantized_overview_with_fallback(wkb, &params, &params, offset)
            .unwrap()
            .unwrap();
        assert_valid_quantized_multipolygon(&overview);
    }

    #[test]
    fn malicious_counts_and_deep_collections_are_rejected_before_allocation() {
        for kind in [2u32, 3, 6] {
            let mut bytes = vec![1];
            bytes.extend(kind.to_le_bytes());
            bytes.extend(u32::MAX.to_le_bytes());
            assert!(parse_complete_geometry(&bytes)
                .err()
                .unwrap()
                .to_string()
                .contains("count"));
        }
        let mut nested = Vec::new();
        for _ in 0..65 {
            nested.push(1);
            nested.extend(7u32.to_le_bytes());
            nested.extend(1u32.to_le_bytes());
        }
        nested.push(1);
        nested.extend(1u32.to_le_bytes());
        nested.extend([0; 16]);
        assert!(parse_complete_geometry(&nested)
            .err()
            .unwrap()
            .to_string()
            .contains("nesting"));
        assert!(crate::wkb_bbox::bbox_from_wkb(&nested)
            .unwrap_err()
            .to_string()
            .contains("nesting"));
    }

    #[test]
    fn ewkb_flags_are_not_iso_dimension_offsets() {
        for (kind, dims) in [
            (0x8000_0002u32, 3),
            (0x4000_0002, 3),
            (0xc000_0002, 4),
            (1002, 3),
            (2002, 3),
            (3002, 4),
        ] {
            let mut bytes = vec![1];
            bytes.extend(kind.to_le_bytes());
            bytes.extend(2u32.to_le_bytes());
            for point in [0f64, 10.] {
                for _ in 0..dims {
                    bytes.extend(point.to_le_bytes());
                }
            }
            let result = quantized_overview(&bytes, 1., [0., 0.]).unwrap();
            assert_eq!(result.x, vec![0, 10]);
            assert_eq!(crate::wkb_bbox::bbox_from_wkb(&bytes).unwrap().0.xmax, 10.);
        }
    }

    #[test]
    fn long_sliver_survives_and_snapped_multipolygon_members_are_unioned() {
        let thin = review_rectangle(0.1, 0.1, 400.1, 0.3);
        assert_eq!(first_viable_level(&thin, &levels(&[1.])).unwrap(), 0);
        assert_eq!(
            quantized_overview(&thin, 1., [0., 0.]).unwrap().x,
            vec![0, 400, 400, 0, 0]
        );
        let bytes = multi_wkb(
            6,
            &[
                review_rectangle(0., 0., 10.1, 10.),
                review_rectangle(10.4, 0., 20., 10.),
            ],
        );
        let result = quantized_overview(&bytes, 1., [0., 0.]).unwrap();
        assert_valid_quantized_multipolygon(&result);
        assert_eq!(result.polygon_ends.len(), 1);
    }

    #[test]
    fn simplifies_a_linestring_on_the_grid() {
        let wkb = line_wkb(&[(0., 0.), (1., 0.01), (2., -0.01), (3., 0.)]);
        let overview = quantized_overview(&wkb, 0.1, [0., 0.]).unwrap();
        assert_eq!(overview.geometry_type, 2);
        assert_eq!((overview.x, overview.y), (vec![0, 48], vec![0, 0]));
    }

    #[test]
    fn line_z_is_dropped_and_xy_is_snapped() {
        let mut wkb = vec![1];
        put_u32(&mut wkb, 1002, 1); // ISO WKB LineString Z
        put_u32(&mut wkb, 3, 1);
        for (x, y, z) in [
            (0.04, 0.04, 12.345),
            (1.5, 0.01, 23.456),
            (2.96, -0.04, 34.567),
        ] {
            put_f64(&mut wkb, x, 1);
            put_f64(&mut wkb, y, 1);
            put_f64(&mut wkb, z, 1);
        }
        // Grid 0.0625: (0.04, 0.04) → (1, 1) and (2.96, -0.04) → (47, -1).
        let overview = quantized_overview(&wkb, 0.1, [0., 0.]).unwrap();
        assert_eq!((overview.x, overview.y), (vec![1, 47], vec![1, -1]));
    }

    #[test]
    fn closed_line_keeps_a_third_vertex() {
        // Douglas-Peucker from (0, 0) back to (0, 0) would keep only the
        // endpoints; the farthest vertex keeps the line non-degenerate.
        let wkb = line_wkb(&[(0., 0.), (5., 0.01), (10., 0.), (5., -0.01), (0., 0.)]);
        let overview = quantized_overview(&wkb, 1.0, [0., 0.]).unwrap();
        assert_eq!((overview.x, overview.y), (vec![0, 10, 0], vec![0, 0, 0]));
    }

    #[test]
    fn quantization_grid_is_binary_and_no_coarser_than_tolerance() {
        assert_eq!(quantization_grid(0.1), 0.0625);
        assert_eq!(quantization_grid(1024.0), 1024.0);
        assert!(quantization_grid(1000.0) <= 1000.0);
    }

    #[test]
    fn line_viability_defers_sub_tolerance_results() {
        let wkb = line_wkb(&[(0., 0.), (0.25, 0.)]);
        assert_eq!(first_viable_level(&wkb, &levels(&[1.0, 0.1])).unwrap(), 1);
    }

    #[test]
    fn finest_overview_revives_a_sub_grid_line() {
        let wkb = line_wkb(&[(0.0, 0.0), (0.25, 0.0)]);
        let overview = quantized_overview(&wkb, 1.0, [0.0, 0.0]).unwrap();
        assert_eq!(overview.geometry_type, 2);
        assert_eq!(overview.x.len(), 2);
        assert!(overview
            .x
            .iter()
            .zip(&overview.y)
            .collect::<Vec<_>>()
            .windows(2)
            .any(|pair| pair[0] != pair[1]));
    }

    #[test]
    fn polygon_ring_remains_closed_and_simplified() {
        let wkb = polygon_wkb(&[vec![
            (0.04, 0.04),
            (0.54, 0.04),
            (1.04, 0.04),
            (1.04, 1.04),
            (0.04, 1.04),
            (0.04, 0.04),
        ]]);
        let overview = quantized_overview(&wkb, 0.1, [0., 0.]).unwrap();
        assert_valid_quantized_multipolygon(&overview);
        // The collinear midpoint of the bottom edge is dropped.
        assert_eq!(overview.x.len(), 5);
    }

    const STAR: [(f64, f64); 11] = [
        (1.56, 0.0),
        (7.82, 4.37),
        (2.37, 7.87),
        (-1.29, 5.99),
        (-2.58, 1.85),
        (-2.26, 0.27),
        (-1.11, -0.78),
        (-1.22, -4.1),
        (0.41, -1.45),
        (2.12, -1.77),
        (1.56, 0.0),
    ];

    #[test]
    fn polygon_simplification_does_not_introduce_self_intersection() {
        // Plain RDP at tolerance 5 replaces the lower-left chain with a chord
        // that crosses the closing edge from (2.12, -1.77) to (1.56, 0).
        let overview = quantized_overview(&polygon_wkb(&[STAR.to_vec()]), 5.0, [0., 0.]).unwrap();
        assert_valid_quantized_multipolygon(&overview);
    }

    #[test]
    fn polygon_z_is_dropped() {
        let mut wkb = vec![1];
        put_u32(&mut wkb, 1003, 1); // ISO WKB Polygon Z
        put_u32(&mut wkb, 1, 1);
        put_u32(&mut wkb, STAR.len() as u32, 1);
        for (index, (x, y)) in STAR.into_iter().enumerate() {
            put_f64(&mut wkb, x, 1);
            put_f64(&mut wkb, y, 1);
            put_f64(&mut wkb, index as f64, 1);
        }
        let overview = quantized_overview(&wkb, 5.0, [0., 0.]).unwrap();
        assert_valid_quantized_multipolygon(&overview);
    }

    #[test]
    fn quantization_collapse_keeps_a_tiny_polygon_visible() {
        let wkb = polygon_wkb(&[vec![
            (0.0, 0.0),
            (1.0, 0.49),
            (2.0, 0.0),
            (1.0, -0.49),
            (0.0, 0.0),
        ]]);
        assert_eq!(first_viable_level(&wkb, &levels(&[1.0, 0.1])).unwrap(), 0);
        let overview = quantized_overview(&wkb, 1.0, [0., 0.]).unwrap();
        assert_valid_quantized_multipolygon(&overview);
    }

    #[test]
    fn sub_meter_polygon_far_from_origin_gets_a_rendering_fallback() {
        // buildings.cogp.parquet row 73,031,160 exposed cancellation in the
        // shoelace sum: products around 136×36 hid an area around 1e-12.
        let wkb = polygon_wkb(&[vec![
            (136.2325434, 36.2068124),
            (136.2325424, 36.2068124),
            (136.2325425, 36.2068115),
            (136.2325434, 36.2068115),
            (136.2325434, 36.2068124),
        ]]);
        let tolerance = 0.60 / 111_320.0;
        let overview = quantized_overview(&wkb, tolerance, [136.0, 36.0]).unwrap();
        assert_valid_quantized_multipolygon(&overview);
    }

    #[test]
    fn polygon_type_and_topology_are_stable_across_overview_levels() {
        let wkb = polygon_wkb(&[square(0., 0., 1.)]);
        // The coarse level needs a one-cell fallback while the fine level can
        // retain the source polygon. Both must use the shared MultiPolygon
        // interpretation expected by the browser decoder.
        let coarse = quantized_overview(&wkb, 10.0, [0.0, 0.0]).unwrap();
        let fine = quantized_overview(&wkb, 0.1, [0.0, 0.0]).unwrap();
        assert_valid_quantized_multipolygon(&coarse);
        assert_valid_quantized_multipolygon(&fine);
        assert_eq!(coarse.geometry_type, fine.geometry_type);
    }

    #[test]
    fn sub_grid_width_polygon_preserves_its_long_axis() {
        for vertical in [false, true] {
            // Area is 100 grid cells, above the tiny-polygon threshold. Both
            // sides of the narrow dimension nevertheless snap to the same cell.
            let ring: Vec<_> = [
                (0.0, 0.0),
                (400.0, 0.0),
                (400.0, 0.25),
                (0.0, 0.25),
                (0.0, 0.0),
            ]
            .into_iter()
            .map(|(x, y)| if vertical { (y, x) } else { (x, y) })
            .collect();
            let overview = quantized_overview(&polygon_wkb(&[ring]), 1.0, [0.0, 0.0]).unwrap();
            assert_valid_quantized_multipolygon(&overview);
            let extent =
                |values: &[i32]| values.iter().max().unwrap() - values.iter().min().unwrap();
            assert_eq!(
                (extent(&overview.x), extent(&overview.y)),
                if vertical { (1, 400) } else { (400, 1) }
            );
        }
    }

    #[test]
    fn diagonal_sub_grid_polygon_preserves_its_long_axis() {
        let wkb = polygon_wkb(&[vec![
            (135.5509395, 34.6617107),
            (135.5509392, 34.6617107),
            (135.5509249, 34.6615756),
            (135.5509256, 34.6615756),
            (135.5509395, 34.6617107),
        ]]);
        let tolerance = 0.000001341;
        assert_eq!(first_viable_level(&wkb, &levels(&[tolerance])).unwrap(), 0);
        let overview = quantized_overview(&wkb, tolerance, [135.5, 34.5]).unwrap();
        assert_valid_quantized_multipolygon(&overview);
        assert!(overview.y.iter().max().unwrap() - overview.y.iter().min().unwrap() > 100);
    }

    #[test]
    fn invalid_thin_polygon_still_has_a_rendering_overview() {
        let wkb = polygon_wkb(&[vec![
            (141.050830337, 45.3),
            (141.050767613, 45.300359973),
            (141.051285305, 45.301426333),
            (141.05255808, 45.301483694),
            (141.052563087, 45.301543441),
            (141.05055153, 45.301463667),
            (141.05055345, 45.301396721),
            (141.051186667, 45.301422775),
            (141.050676978, 45.300365919),
            (141.050741388, 45.3),
            (141.051271855, 45.296986108),
            (141.051354112, 45.296994387),
            (141.050830337, 45.3),
        ]]);
        let overview = quantized_overview(&wkb, 38.22 / 111_320.0, [141.0, 45.0]).unwrap();
        assert_valid_quantized_multipolygon(&overview);
    }

    #[test]
    fn polygon_below_tolerance_is_not_viable_but_has_a_fallback() {
        let mut ring = Vec::new();
        for x in 0..=100 {
            ring.push((x as f64 / 100.0, 0.0));
        }
        for y in 1..=100 {
            ring.push((1.0, y as f64 / 100.0));
        }
        for x in (0..100).rev() {
            ring.push((x as f64 / 100.0, 1.0));
        }
        for y in (1..100).rev() {
            ring.push((0.0, y as f64 / 100.0));
        }
        ring.push(ring[0]);
        let wkb = polygon_wkb(&[ring]);
        let source = parse_complete_geometry(&wkb).unwrap();
        assert!(matches!(
            build_overview(&source, &OverviewParams::tolerance(10.0)),
            OverviewOutcome::NotViable
        ));
        let overview = quantized_overview(&wkb, 10.0, [0., 0.]).unwrap();
        assert_valid_quantized_multipolygon(&overview);
    }

    #[test]
    fn polygon_viability_defers_until_a_ring_survives() {
        let wkb = polygon_wkb(&[square(0., 0., 1.)]);
        assert_eq!(first_viable_level(&wkb, &levels(&[10.0, 0.1])).unwrap(), 1);
    }

    #[test]
    fn coarser_fallback_covers_non_monotonic_polygon_viability() {
        // This valid, thin quadrilateral survives coarser and finer grids but
        // collapses on the grid between them. It is distilled from a real
        // building footprint.
        let wkb = polygon_wkb(&[vec![
            (124.0727199, 39.8270021),
            (124.0775812, 39.828717),
            (124.0775559, 39.8287598),
            (124.0726945, 39.8270449),
            (124.0727199, 39.8270021),
        ]]);
        let tolerance = 9.554_628_535_647_032 / 111_320.0;
        let entry_tolerance = 305.748_113_140_705 / 111_320.0;
        let overview = quantized_overview_with_fallback(
            &wkb,
            &OverviewParams::tolerance(tolerance),
            &OverviewParams::tolerance(entry_tolerance),
            [124.0, 40.0],
        )
        .unwrap()
        .unwrap();
        assert_valid_quantized_multipolygon(&overview);
    }

    /// A closed star-shaped ring, simple by construction, whose radius has
    /// deterministic roughness down to the vertex spacing.
    fn rough_star(center: (f64, f64), radius: f64, count: usize, seed: u64) -> Vec<(f64, f64)> {
        let mut state = seed;
        let mut ring: Vec<_> = (0..count)
            .map(|index| {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                let jitter = (state >> 11) as f64 / (1u64 << 53) as f64 - 0.5;
                let angle = index as f64 / count as f64 * std::f64::consts::TAU;
                let wave: f64 = (1..=32)
                    .map(|k| (k as f64 * 5.0 * angle + k as f64).sin() / k as f64)
                    .sum();
                let r = radius * (1.0 + 0.05 * wave + 0.01 * jitter);
                (center.0 + r * angle.cos(), center.1 + r * angle.sin())
            })
            .collect();
        ring.push(ring[0]);
        ring
    }

    #[test]
    fn rough_ring_is_simplified_without_restoring_source_vertices() {
        // Snapping makes this ring self-touching in places. Simplification
        // still removes most source vertices.
        let ring = rough_star((0.0, 0.0), 1.0, 20_000, 7);
        let source = ring.len();
        let overview = quantized_overview(&polygon_wkb(&[ring]), 0.001, [0.0, 0.0]).unwrap();
        assert_valid_quantized_multipolygon(&overview);
        assert!(
            overview.x.len() < source / 2,
            "{} of {source} vertices",
            overview.x.len()
        );
    }

    #[test]
    fn rough_rings_with_holes_and_islands_stay_valid_at_every_level() {
        let mut shell = vec![rough_star((0.0, 0.0), 1.0, 4_000, 1)];
        let mut members = Vec::new();
        for lake in 0..6 {
            let angle = lake as f64 / 6.0 * std::f64::consts::TAU;
            let center = (0.5 * angle.cos(), 0.5 * angle.sin());
            let mut hole = rough_star(center, 0.12, 600, lake + 2);
            hole.reverse();
            shell.push(hole);
            members.push(polygon_wkb(&[rough_star(center, 0.05, 300, lake + 20)]));
        }
        members.insert(0, polygon_wkb(&shell));
        let wkb = multi_wkb(6, &members);
        for tolerance in [0.5, 0.1, 0.03, 0.01, 0.003, 0.001, 0.0003] {
            let overview = quantized_overview(&wkb, tolerance, [0.0, 0.0]).unwrap();
            assert_valid_quantized_multipolygon(&overview);
        }
    }

    fn overview_with_min_part(bytes: &[u8], min_part_size: f64) -> QuantizedOverview {
        let params = OverviewParams {
            tolerance: 1.0,
            min_part_size,
        };
        quantized_overview_with_fallback(bytes, &params, &params, [0.0, 0.0])
            .unwrap()
            .unwrap()
    }

    #[test]
    fn small_parts_and_holes_are_omitted_while_a_larger_part_remains() {
        // A 100-unit square with a large and a 1.5-unit hole, plus a
        // 1.5-unit island. At a 2-unit minimum part size the small hole and
        // island (area 2.25 < 4) disappear; at zero both remain.
        let wkb = multi_wkb(
            6,
            &[
                polygon_wkb(&[
                    square(0., 0., 100.),
                    square(20., 20., 20.),
                    square(60., 60., 1.5),
                ]),
                polygon_wkb(&[square(200., 0., 1.5)]),
            ],
        );
        let kept = overview_with_min_part(&wkb, 0.0);
        assert_eq!((kept.polygon_ends.len(), kept.part_ends.len()), (2, 4));
        let omitted = overview_with_min_part(&wkb, 2.0);
        assert_valid_quantized_multipolygon(&omitted);
        assert_eq!(
            (omitted.polygon_ends.len(), omitted.part_ends.len()),
            (1, 2)
        );

        let lines = multi_wkb(
            5,
            &[
                line_wkb(&[(0., 0.), (100., 0.)]),
                line_wkb(&[(0., 10.), (1.5, 10.)]),
            ],
        );
        assert_eq!(overview_with_min_part(&lines, 0.0).part_ends.len(), 2);
        assert_eq!(overview_with_min_part(&lines, 2.0).part_ends.len(), 1);
    }

    #[test]
    fn omitting_small_parts_never_defers_a_feature() {
        // Every member is below the minimum part size, so all are kept and
        // the feature becomes renderable at the same level as without it.
        let wkb = multi_wkb(
            6,
            &[
                polygon_wkb(&[square(0., 0., 1.5)]),
                polygon_wkb(&[square(10., 0., 1.5)]),
            ],
        );
        let level = |min_part_size| {
            let params = |tolerance| OverviewParams {
                tolerance,
                min_part_size,
            };
            first_viable_level(&wkb, &[params(1.0), params(0.1)]).unwrap()
        };
        assert_eq!(level(2.0), level(0.0));
        assert_eq!(overview_with_min_part(&wkb, 2.0).polygon_ends.len(), 2);
    }

    #[test]
    fn misaligned_offsets_are_rejected() {
        let wkb = polygon_wkb(&[square(0., 0., 10.)]);
        assert!(quantized_overview(&wkb, 1.0, [0.5, 0.0]).is_err());
    }
}
