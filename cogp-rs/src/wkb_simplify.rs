//! Scale-based simplification and integer XY encoding for rendering overviews.
//!
//! Every LoD is derived independently from primary WKB. Retained XY coordinates
//! are snapped to a power-of-two grid no coarser than the tolerance, polygon
//! rings retain closure and minimum cardinality, and invalid polygon results are
//! first refined only along their defective edges, then retried as a whole and
//! cleaned after quantization. Polygon-family overviews always use MultiPolygon
//! so repair cannot change the shared type between LoDs. Z/M exist only in the
//! lossless primary geometry; the overview contract intentionally emits XY
//! alone. No shared-edge topology is promised across neighboring features.

use crate::geometry_validation::{multipolygon_valid, polygon_valid};
use anyhow::{bail, Result};
use byteorder::{BigEndian, ByteOrder, LittleEndian};
use geo::line_intersection::{line_intersection, LineIntersection};
#[cfg(test)]
use geo::Validation;
use geo::{Coord, Line, LineString, Polygon, Relate};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay::Overlay;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::i_float::int::point::IntPoint;
use rstar::{RTree, RTreeObject, AABB};

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
    byte_order: u8,
    raw_type: u32,
    #[cfg_attr(not(test), allow(dead_code))]
    srid: Option<u32>,
    body: Body,
}

#[derive(Clone)]
enum Body {
    Point(Coordinate),
    LineString(Vec<Coordinate>),
    Polygon(Vec<Vec<Coordinate>>),
    Collection(Vec<Geometry>),
}

#[cfg(test)]
pub fn simplify_wkb(bytes: &[u8], tolerance: f64) -> Result<Vec<u8>> {
    validate_tolerance(tolerance)?;
    let geometry = parse_complete_geometry(bytes)?;
    let OverviewOutcome::Built(geometry) =
        build_overview(&geometry, &OverviewParams::tolerance(tolerance))
    else {
        // Callers keep the source at the finest selected level when it cannot
        // be represented safely. Coarser level selection uses the same outcome
        // and therefore never selects a source-WKB fallback as an overview.
        return Ok(bytes.to_vec());
    };
    let mut output = Vec::with_capacity(bytes.len());
    write_geometry(&geometry, &mut output);
    Ok(output)
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

/// Build an overview, repeating a known-valid coarser representation when
/// quantization makes an otherwise finer Polygon LoD invalid. Simplification
/// viability is not monotonic across fixed grids: a thin polygon can be valid
/// on one grid, collapse on the next, and become valid again on a finer grid.
/// Reusing the feature's entry-level shape keeps it visible without requiring
/// callers to understand or pre-scan that topology edge case.
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
    let scale = quantization_grid(params.tolerance);
    let geometry = match build_overview(&source, params) {
        OverviewOutcome::Built(geometry) => geometry,
        // A feature can reach the finest level without being viable at that
        // level (for example, a sub-pixel polygon). Its required overview must
        // still be independently renderable without falling back to WKB.
        OverviewOutcome::NotViable | OverviewOutcome::PreserveSource => {
            rendering_fallback(&source, scale)
                .or_else(|| {
                    if fallback.tolerance == params.tolerance {
                        return None;
                    }
                    match build_overview(&source, fallback) {
                        OverviewOutcome::Built(geometry) => Some(geometry),
                        OverviewOutcome::NotViable | OverviewOutcome::PreserveSource => None,
                    }
                })
                .ok_or_else(|| {
                    anyhow::anyhow!("geometry cannot be represented as a valid rendering overview")
                })?
        }
    };
    flatten_quantized(&geometry, scale, offset).map(Some)
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

fn flatten_quantized(
    geometry: &Geometry,
    scale: f64,
    offset: [f64; 2],
) -> Result<QuantizedOverview> {
    let kind = geometry_kind(geometry.raw_type);
    if !(1..=6).contains(&kind) {
        bail!("GeometryCollection is not supported in quantized_geoarrow overviews");
    }
    // Polygon repair can split a ring at one grid size but not another. Since
    // geometry_type is shared by every LoD, encode the entire polygon family
    // as MultiPolygon (with one member when unsplit) so its interpretation can
    // never vary between levels.
    let overview_kind = if kind == 3 { 6 } else { kind };
    let mut overview = QuantizedOverview {
        geometry_type: overview_kind as i8,
        x: Vec::new(),
        y: Vec::new(),
        part_ends: Vec::new(),
        polygon_ends: Vec::new(),
    };

    fn push_coordinate(
        overview: &mut QuantizedOverview,
        coordinate: &Coordinate,
        scale: f64,
        offset: [f64; 2],
    ) -> Result<()> {
        if coordinate.0.len() < 2 || !coordinate.0[0].is_finite() || !coordinate.0[1].is_finite() {
            bail!("overview coordinates must contain finite XY ordinates");
        }
        for (value, origin, output) in [
            (coordinate.0[0], offset[0], &mut overview.x),
            (coordinate.0[1], offset[1], &mut overview.y),
        ] {
            let integer = ((value - origin) / scale).round();
            if integer < i32::MIN as f64 || integer > i32::MAX as f64 {
                bail!(
                    "overview coordinate exceeds the signed 32-bit range; use coarser resolutions"
                );
            }
            output.push(integer as i32);
        }
        Ok(())
    }
    fn push_coordinates(
        overview: &mut QuantizedOverview,
        coordinates: &[Coordinate],
        scale: f64,
        offset: [f64; 2],
    ) -> Result<()> {
        for coordinate in coordinates {
            push_coordinate(overview, coordinate, scale, offset)?;
        }
        Ok(())
    }

    match (kind, &geometry.body) {
        (1, Body::Point(point)) => push_coordinate(&mut overview, point, scale, offset)?,
        (2, Body::LineString(points)) => push_coordinates(&mut overview, points, scale, offset)?,
        (3, Body::Polygon(rings)) => {
            for ring in rings {
                push_coordinates(&mut overview, ring, scale, offset)?;
                overview.part_ends.push(i32::try_from(overview.x.len())?);
            }
            overview
                .polygon_ends
                .push(i32::try_from(overview.part_ends.len())?);
        }
        (4, Body::Collection(points)) => {
            for point in points {
                let Body::Point(coordinate) = &point.body else {
                    bail!("invalid MultiPoint child geometry");
                };
                push_coordinate(&mut overview, coordinate, scale, offset)?;
            }
        }
        (5, Body::Collection(lines)) => {
            for line in lines {
                let Body::LineString(points) = &line.body else {
                    bail!("invalid MultiLineString child geometry");
                };
                push_coordinates(&mut overview, points, scale, offset)?;
                overview.part_ends.push(i32::try_from(overview.x.len())?);
            }
        }
        (6, Body::Collection(polygons)) => {
            for polygon in polygons {
                let Body::Polygon(rings) = &polygon.body else {
                    bail!("invalid MultiPolygon child geometry");
                };
                for ring in rings {
                    push_coordinates(&mut overview, ring, scale, offset)?;
                    overview.part_ends.push(i32::try_from(overview.x.len())?);
                }
                overview
                    .polygon_ends
                    .push(i32::try_from(overview.part_ends.len())?);
            }
        }
        _ => bail!("WKB geometry body does not match its type code"),
    }
    if overview.geometry_type == 6 && !quantized_multipolygon_valid(&overview) {
        bail!("invalid overview polygon topology after quantization");
    }
    Ok(overview)
}

fn quantized_multipolygon_valid(overview: &QuantizedOverview) -> bool {
    let mut coordinate_start = 0;
    let mut ring_start = 0;
    let mut polygons = Vec::with_capacity(overview.polygon_ends.len());
    for &polygon_end in &overview.polygon_ends {
        let Ok(polygon_end) = usize::try_from(polygon_end) else {
            return false;
        };
        if polygon_end <= ring_start || polygon_end > overview.part_ends.len() {
            return false;
        }
        let mut rings = Vec::new();
        for &part_end in &overview.part_ends[ring_start..polygon_end] {
            let Ok(part_end) = usize::try_from(part_end) else {
                return false;
            };
            if part_end <= coordinate_start || part_end > overview.x.len() {
                return false;
            }
            rings.push(
                overview.x[coordinate_start..part_end]
                    .iter()
                    .zip(&overview.y[coordinate_start..part_end])
                    .map(|(&x, &y)| Coordinate(vec![x as f64, y as f64]))
                    .collect::<Vec<_>>(),
            );
            coordinate_start = part_end;
        }
        polygons.push(polygon_xy(&rings));
        ring_start = polygon_end;
    }
    coordinate_start == overview.x.len()
        && overview.x.len() == overview.y.len()
        && ring_start == overview.part_ends.len()
        && multipolygon_valid(&polygons)
}

/// Return the first coarse-to-fine tolerance at which the geometry remains
/// independently renderable. Parsing happens once; each candidate simplifies
/// an independent clone so approximation error never accumulates between levels.
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
    Built(Geometry),
    NotViable,
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

/// Rendering overviews deliberately omit Z and M. Removing them before
/// simplification also lets polygon repair operate on exactly the XY topology
/// that browsers will receive, instead of validating a different dimensional
/// representation and discarding the extra ordinates afterward.
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
/// from disagreeing about post-quantization polygon collapse.
fn build_overview(source: &Geometry, params: &OverviewParams) -> OverviewOutcome {
    let context = BuildContext {
        tolerance2: params.tolerance * params.tolerance,
        min_part_size: params.min_part_size,
        grid: quantization_grid(params.tolerance),
    };
    build_geometry(source, &context)
}

#[derive(Clone, Copy)]
struct BuildContext {
    tolerance2: f64,
    min_part_size: f64,
    grid: f64,
}

// Retrying with smaller distance tolerances retains more source vertices
// without changing the output grid.
const RETRY_TOLERANCE2_SCALES: [f64; 4] = [1.0, 0.25, 0.0625, 0.0];

fn build_geometry(source: &Geometry, context: &BuildContext) -> OverviewOutcome {
    if let Body::Collection(source_children) = &source.body {
        let significant = significant_parts(source_children, context.min_part_size);
        let Some(mut children) = build_children(significant.iter().copied(), context) else {
            return OverviewOutcome::PreserveSource;
        };
        // Omitting small parts must not change when a feature first becomes
        // renderable: if no significant part survives, consider every part.
        if children.is_empty() && significant.len() < source_children.len() {
            let Some(all) = build_children(source_children.iter(), context) else {
                return OverviewOutcome::PreserveSource;
            };
            children = all;
        }
        if children.is_empty() {
            return OverviewOutcome::NotViable;
        }
        if geometry_kind(source.raw_type) == 6 {
            children = flatten_multipolygon_children(children);
        }
        let mut geometry = source.clone();
        geometry.body = Body::Collection(children);
        if geometry_kind(geometry.raw_type) == 6
            && !repair_multipolygon(&mut geometry, context.grid)
        {
            return OverviewOutcome::PreserveSource;
        }
        return OverviewOutcome::Built(geometry);
    }

    // Prefer a valid simplified ring over repairing a self-intersection after
    // the fact: an even-odd repair can legitimately discard a lobe and make
    // the rendered shape look broken. The first failed simplification
    // viability check still defers the feature.
    let mut last_candidate = None;
    let mut exhausted = None;
    for (attempt, scale) in RETRY_TOLERANCE2_SCALES.into_iter().enumerate() {
        let mut candidate = source.clone();
        if !simplify_geometry(
            &mut candidate,
            context.tolerance2 * scale,
            context.min_part_size,
        ) {
            if attempt == 0 {
                return OverviewOutcome::NotViable;
            }
            continue;
        }
        quantize_geometry(&mut candidate, context.grid);
        if rendering_geometry_is_valid(&candidate) {
            return OverviewOutcome::Built(candidate);
        }
        // A defect is usually confined to a few edges of a large polygon.
        // Refining only those spans keeps the rest of the ring at the
        // requested tolerance; whole-geometry retries remain the fallback.
        if attempt == 0 {
            if let Body::Polygon(rings) = &source.body {
                match refine_polygon(rings, context) {
                    Refinement::Valid(rings) => {
                        candidate.body = Body::Polygon(rings);
                        return OverviewOutcome::Built(candidate);
                    }
                    Refinement::Exhausted(rings) => {
                        let mut refined = candidate.clone();
                        refined.body = Body::Polygon(rings);
                        exhausted = Some(refined);
                    }
                    Refinement::Unsupported => {}
                }
            }
        }
        last_candidate = Some(candidate);
    }

    // At zero simplification tolerance, any remaining defect was introduced
    // by the fixed output grid (or was already present in the source). Repair
    // only here, after retaining every source vertex that the grid can express.
    // Local refinement retained every source vertex of its defective spans,
    // so cleaning it repairs the same defects without restoring every vertex
    // of the intact spans.
    if let Some(mut refined) = exhausted {
        if clean_geometry(&mut refined, context.grid) {
            return OverviewOutcome::Built(refined);
        }
    }
    if let Some(mut candidate) = last_candidate {
        let before_cleaning = candidate.clone();
        if clean_geometry(&mut candidate, context.grid) {
            return OverviewOutcome::Built(candidate);
        }
        if let Some(revived) = revive_tiny_polygon(&before_cleaning, source, context.grid) {
            return OverviewOutcome::Built(revived);
        }
    }
    OverviewOutcome::PreserveSource
}

/// Build Multi* members, skipping members that collapse. `None` means a
/// member must preserve its source, which makes the whole feature do so.
fn build_children<'a>(
    children: impl Iterator<Item = &'a Geometry>,
    context: &BuildContext,
) -> Option<Vec<Geometry>> {
    let mut built = Vec::new();
    for child in children {
        match build_geometry(child, context) {
            OverviewOutcome::Built(child) => built.push(child),
            OverviewOutcome::NotViable => {}
            OverviewOutcome::PreserveSource => return None,
        }
    }
    Some(built)
}

/// Multi* members large enough to see at this LoD. Every member is kept when
/// none is, so the feature still has a representation.
fn significant_parts(children: &[Geometry], min_part_size: f64) -> Vec<&Geometry> {
    let significant: Vec<_> = children
        .iter()
        .filter(|child| !is_small_part(child, min_part_size))
        .collect();
    if significant.is_empty() {
        children.iter().collect()
    } else {
        significant
    }
}

fn is_small_part(geometry: &Geometry, min_part_size: f64) -> bool {
    if min_part_size <= 0.0 {
        return false;
    }
    match &geometry.body {
        Body::Polygon(rings) => {
            let exterior = rings.first().map_or(0.0, |ring| ring_area(ring));
            let holes: f64 = rings.iter().skip(1).map(|ring| ring_area(ring)).sum();
            exterior - holes < min_part_size * min_part_size
        }
        Body::LineString(points) => line_length(points) < min_part_size,
        Body::Point(_) | Body::Collection(_) => false,
    }
}

fn is_small_hole(ring: &[Coordinate], min_part_size: f64) -> bool {
    min_part_size > 0.0 && ring_area(ring) < min_part_size * min_part_size
}

fn ring_area(ring: &[Coordinate]) -> f64 {
    signed_area2(ring).abs() / 2.0
}

/// A simplified ring as retained source indices, with the refinement step
/// (an index into `RETRY_TOLERANCE2_SCALES`) of each span between them.
struct RingPlan<'a> {
    source: &'a [Coordinate],
    kept: Vec<usize>,
    steps: Vec<usize>,
}

impl<'a> RingPlan<'a> {
    fn new(source: &'a [Coordinate], kept: Vec<usize>) -> Self {
        let steps = vec![0; kept.len() - 1];
        Self {
            source,
            kept,
            steps,
        }
    }

    fn materialize(&self, grid: f64) -> Vec<Coordinate> {
        self.kept
            .iter()
            .map(|&index| {
                let mut coordinate = self.source[index].clone();
                quantize_coordinate(&mut coordinate, grid);
                coordinate
            })
            .collect()
    }

    /// Re-simplify each defective span with the next smaller tolerance.
    /// Returns whether any span could still be refined.
    fn refine(&mut self, defective: &[bool], tolerance2: f64) -> bool {
        let mut refined = false;
        // Walk backwards so insertions do not shift spans not yet visited.
        for span in (0..defective.len()).rev() {
            let step = self.steps[span] + 1;
            let (start, end) = (self.kept[span], self.kept[span + 1]);
            if !defective[span] || step >= RETRY_TOLERANCE2_SCALES.len() || end - start < 2 {
                continue;
            }
            let tolerance2 = tolerance2 * RETRY_TOLERANCE2_SCALES[step];
            let inserted: Vec<usize> = simplify_indices(&self.source[start..=end], tolerance2, 2)
                .into_iter()
                .filter(|&index| index != 0 && index != end - start)
                .map(|index| start + index)
                .collect();
            self.steps
                .splice(span..=span, std::iter::repeat_n(step, inserted.len() + 1));
            self.kept.splice(span + 1..span + 1, inserted);
            refined = true;
        }
        refined
    }
}

enum Refinement {
    /// Quantized rings that form a valid polygon.
    Valid(Vec<Vec<Coordinate>>),
    /// Quantized rings whose defective spans keep every source vertex.
    Exhausted(Vec<Vec<Coordinate>>),
    /// The defect is not an edge intersection, or did not settle in time.
    Unsupported,
}

/// Refine only the spans of a simplified polygon whose edges take part in a
/// topology defect, each through the same tolerance ladder as whole-geometry
/// retries.
fn refine_polygon(source: &[Vec<Coordinate>], context: &BuildContext) -> Refinement {
    // Refined vertices can create new intersections with neighbouring spans,
    // which then start their own ladder; bound the total rounds.
    const MAX_ROUNDS: usize = 3 * RETRY_TOLERANCE2_SCALES.len();
    let mut plans = Vec::with_capacity(source.len());
    for (index, ring) in source.iter().enumerate() {
        if index > 0 && is_small_hole(ring, context.min_part_size) {
            continue;
        }
        match ring_indices(ring, context.tolerance2) {
            Some(kept) => plans.push(RingPlan::new(ring, kept)),
            None if index == 0 => return Refinement::Unsupported,
            None => {}
        }
    }
    for _ in 0..MAX_ROUNDS {
        let rings: Vec<_> = plans
            .iter()
            .map(|plan| plan.materialize(context.grid))
            .collect();
        if polygon_rings_valid(&rings) {
            return Refinement::Valid(rings);
        }
        let defects = defective_spans(&rings);
        if defects.iter().all(|spans| !spans.contains(&true)) {
            return Refinement::Unsupported;
        }
        let mut refined = false;
        for (plan, defective) in plans.iter_mut().zip(&defects) {
            refined |= plan.refine(defective, context.tolerance2);
        }
        if !refined {
            return Refinement::Exhausted(rings);
        }
    }
    Refinement::Unsupported
}

struct SpanEdge {
    line: Line<f64>,
    ring: usize,
    span: usize,
    order: usize,
}

impl RTreeObject for SpanEdge {
    type Envelope = AABB<[f64; 2]>;
    fn envelope(&self) -> Self::Envelope {
        let (a, b) = (self.line.start, self.line.end);
        AABB::from_corners([a.x.min(b.x), a.y.min(b.y)], [a.x.max(b.x), a.y.max(b.y)])
    }
}

/// Mark the spans of closed rings whose edges cross, overlap or touch another
/// edge where a valid polygon does not allow it. Mirrors the ring checks of
/// `polygon_valid`; rings may still touch each other at isolated points.
fn defective_spans(rings: &[Vec<Coordinate>]) -> Vec<Vec<bool>> {
    let mut defects: Vec<Vec<bool>> = rings
        .iter()
        .map(|ring| vec![false; ring.len().saturating_sub(1)])
        .collect();
    let mut edges = Vec::new();
    let mut counts = Vec::with_capacity(rings.len());
    for (ring_index, ring) in rings.iter().enumerate() {
        let first = edges.len();
        for (span, pair) in ring.windows(2).enumerate() {
            let line = Line::new(
                Coord {
                    x: pair[0].0[0],
                    y: pair[0].0[1],
                },
                Coord {
                    x: pair[1].0[0],
                    y: pair[1].0[1],
                },
            );
            if line.start != line.end {
                let order = edges.len() - first;
                edges.push(SpanEdge {
                    line,
                    ring: ring_index,
                    span,
                    order,
                });
            }
        }
        counts.push(edges.len() - first);
        // A ring collapsed by snapping has no single defective edge.
        if counts[ring_index] < 3 || ring.is_empty() || signed_area2(&ring[..ring.len() - 1]) == 0.0
        {
            defects[ring_index].fill(true);
        }
    }
    let tree = RTree::bulk_load(edges);
    for edge in &tree {
        for other in tree.locate_in_envelope_intersecting(&edge.envelope()) {
            if (other.ring, other.order) <= (edge.ring, edge.order) {
                continue;
            }
            let Some(hit) = line_intersection(edge.line, other.line) else {
                continue;
            };
            let touching = matches!(
                hit,
                LineIntersection::SinglePoint {
                    is_proper: false,
                    ..
                }
            );
            let allowed = if edge.ring == other.ring {
                let count = counts[edge.ring];
                let adjacent =
                    other.order == edge.order + 1 || (edge.order == 0 && other.order == count - 1);
                adjacent && touching
            } else {
                touching
            };
            if !allowed {
                defects[edge.ring][edge.span] = true;
                defects[other.ring][other.span] = true;
            }
        }
    }
    defects
}

/// Snapping can make distinct members touch or overlap. Union the whole feature
/// with consistently oriented exteriors/holes so overlaps are filled, not XORed.
fn repair_multipolygon(geometry: &mut Geometry, grid: f64) -> bool {
    let Body::Collection(children) = &geometry.body else {
        return false;
    };
    let polygons: Option<Vec<_>> = children
        .iter()
        .map(|child| match &child.body {
            Body::Polygon(rings) => Some(polygon_xy(rings)),
            _ => None,
        })
        .collect();
    let Some(polygons) = polygons else {
        return false;
    };
    if multipolygon_valid(&polygons) {
        return true;
    }
    let mut rings = Vec::new();
    for child in children {
        let Body::Polygon(parts) = &child.body else {
            return false;
        };
        for (index, ring) in parts.iter().enumerate() {
            let mut ring = ring.clone();
            if (signed_area2(&ring) > 0.0) != (index == 0) {
                ring.reverse();
            }
            rings.push(ring);
        }
    }
    let Some(coords) = polygon_grid(&rings, grid) else {
        return false;
    };
    let mut overlay = Overlay::with_contours(&coords.contours, &[]);
    overlay.options.ogc = true;
    let shapes = overlay.overlay(OverlayRule::Subject, FillRule::NonZero);
    if shapes.is_empty() {
        return false;
    }
    let repaired = shapes
        .iter()
        .map(|shape| polygon_coordinates(shape, grid, &coords))
        .collect::<Vec<_>>();
    let Some(repaired) = regroup_overlay_rings(repaired) else {
        return false;
    };
    geometry.body = Body::Collection(
        repaired
            .into_iter()
            .map(|rings| Geometry {
                byte_order: geometry.byte_order,
                raw_type: 3,
                srid: None,
                body: Body::Polygon(rings),
            })
            .collect(),
    );
    true
}

fn flatten_multipolygon_children(children: Vec<Geometry>) -> Vec<Geometry> {
    let mut flattened = Vec::with_capacity(children.len());
    for child in children {
        if geometry_kind(child.raw_type) == 6 {
            if let Body::Collection(grandchildren) = child.body {
                flattened.extend(grandchildren);
            }
        } else {
            flattened.push(child);
        }
    }
    flattened
}

/// Tippecanoe revives a polygon that disappears at tile precision as a small
/// rectangle. Restrict that approximation to tiny or sub-grid-width polygons
/// so a cleaning defect cannot replace a substantial two-dimensional feature.
fn revive_tiny_polygon(candidate: &Geometry, source: &Geometry, grid: f64) -> Option<Geometry> {
    // Up to 8×8 output cells is still a small rendering symbol at the target
    // LoD. Administrative datasets contain thin rings whose signed source area
    // is several cells even though every lobe collapses onto the same grid
    // lines; rejecting those polygons makes an otherwise valid file impossible
    // to render or even produce.
    const MAX_AREA_IN_GRID_CELLS: f64 = 64.0;

    let (Body::Polygon(candidate_rings), Body::Polygon(source_rings)) =
        (&candidate.body, &source.body)
    else {
        return None;
    };
    if source_rings
        .iter()
        .flatten()
        .any(|coordinate| coordinate.0.len() != 2)
    {
        return None;
    }
    let exterior_area2 = signed_area2(source_rings.first()?).abs();
    let holes_area2: f64 = source_rings[1..]
        .iter()
        .map(|ring| signed_area2(ring).abs())
        .sum();
    let area_in_grid_cells = ((exterior_area2 - holes_area2).max(0.0) / 2.0) / (grid * grid);
    if !area_in_grid_cells.is_finite() || area_in_grid_cells <= 0.0 {
        return None;
    }

    let points: Vec<&Coordinate> = candidate_rings.iter().flatten().collect();
    if points.is_empty() {
        return None;
    }
    let center_x = points.iter().map(|point| point.0[0] / grid).sum::<f64>() / points.len() as f64;
    let center_y = points.iter().map(|point| point.0[1] / grid).sum::<f64>() / points.len() as f64;
    if !center_x.is_finite() || !center_y.is_finite() {
        return None;
    }

    let min_x = points
        .iter()
        .map(|p| p.0[0] / grid)
        .fold(f64::INFINITY, f64::min);
    let max_x = points
        .iter()
        .map(|p| p.0[0] / grid)
        .fold(f64::NEG_INFINITY, f64::max);
    let min_y = points
        .iter()
        .map(|p| p.0[1] / grid)
        .fold(f64::INFINITY, f64::min);
    let max_y = points
        .iter()
        .map(|p| p.0[1] / grid)
        .fold(f64::NEG_INFINITY, f64::max);
    // Measure width perpendicular to the source's long axis. Axis-aligned
    // bbox width misses diagonal slivers that also disappear on the grid.
    let axis = usize::from(max_y - min_y > max_x - min_x);
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
            a,
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
            [x0, y0],
        ]
    };
    let ring = corners
        .into_iter()
        .map(|[x, y]| Coordinate(vec![canonical_zero(x * grid), canonical_zero(y * grid)]))
        .collect();
    let mut revived = source.clone();
    revived.body = Body::Polygon(vec![ring]);
    Some(revived)
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

/// Snap rendering-only XY coordinates without changing vertex counts or ring
/// closure. Keeping the representation as f64 preserves GeoParquet/WKB
/// compatibility while giving ZSTD highly repetitive low-order bytes.
fn quantize_geometry(geometry: &mut Geometry, grid: f64) {
    match &mut geometry.body {
        Body::Point(point) => quantize_coordinate(point, grid),
        Body::LineString(points) => quantize_coordinates(points, grid),
        Body::Polygon(rings) => {
            for ring in rings {
                quantize_coordinates(ring, grid);
            }
        }
        Body::Collection(children) => {
            for child in children {
                quantize_geometry(child, grid);
            }
        }
    }
}

fn quantize_coordinates(points: &mut [Coordinate], grid: f64) {
    for point in points {
        quantize_coordinate(point, grid);
    }
}

fn quantize_coordinate(coordinate: &mut Coordinate, grid: f64) {
    for ordinate in &mut coordinate.0[..2] {
        let snapped = (*ordinate / grid).round() * grid;
        // Canonicalize negative zero as well as the coordinate value. This is
        // invisible geometrically but avoids two byte patterns for grid zero.
        *ordinate = if snapped == 0.0 { 0.0 } else { snapped };
    }
}

/// Preserve as much source shape as the target grid permits when ordinary
/// simplification cannot produce a viable required overview. Topology is still
/// cleaned after snapping, and sub-grid lines/polygons receive a one-cell
/// rendering surrogate rather than an empty or invalid coordinate sequence.
fn rendering_fallback(source: &Geometry, grid: f64) -> Option<Geometry> {
    if let Body::Collection(source_children) = &source.body {
        let mut children = source_children
            .iter()
            .filter_map(|child| rendering_fallback(child, grid))
            .collect::<Vec<_>>();
        if children.is_empty() {
            return None;
        }
        if geometry_kind(source.raw_type) == 6 {
            children = flatten_multipolygon_children(children);
        }
        let mut fallback = source.clone();
        fallback.body = Body::Collection(children);
        if geometry_kind(fallback.raw_type) == 6 && !repair_multipolygon(&mut fallback, grid) {
            return None;
        }
        return Some(fallback);
    }

    let mut fallback = source.clone();
    quantize_geometry(&mut fallback, grid);
    if clean_geometry(&mut fallback, grid) {
        return Some(fallback);
    }

    match &source.body {
        Body::LineString(_) => revive_short_line(source, grid),
        Body::Polygon(_) => revive_tiny_polygon(&fallback, source, grid),
        Body::Point(_) | Body::Collection(_) => None,
    }
}

fn revive_short_line(source: &Geometry, grid: f64) -> Option<Geometry> {
    let Body::LineString(points) = &source.body else {
        return None;
    };
    if points.len() < 2 || line_length(points) == 0.0 {
        return None;
    }

    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for point in points {
        if point.0.len() < 2 || !point.0[0].is_finite() || !point.0[1].is_finite() {
            return None;
        }
        min_x = min_x.min(point.0[0]);
        min_y = min_y.min(point.0[1]);
        max_x = max_x.max(point.0[0]);
        max_y = max_y.max(point.0[1]);
    }

    let center_x = ((min_x + max_x) * 0.5 / grid).round();
    let center_y = ((min_y + max_y) * 0.5 / grid).round();
    let (end_x, end_y) = if max_x - min_x >= max_y - min_y {
        (center_x + 1.0, center_y)
    } else {
        (center_x, center_y + 1.0)
    };
    let coordinate =
        |x: f64, y: f64| Coordinate(vec![canonical_zero(x * grid), canonical_zero(y * grid)]);
    let mut revived = source.clone();
    revived.body = Body::LineString(vec![
        coordinate(center_x, center_y),
        coordinate(end_x, end_y),
    ]);
    Some(revived)
}

fn canonical_zero(value: f64) -> f64 {
    if value == 0.0 {
        0.0
    } else {
        value
    }
}

fn simplify_geometry(geometry: &mut Geometry, tolerance2: f64, min_part_size: f64) -> bool {
    match &mut geometry.body {
        Body::Point(_) => true,
        Body::LineString(points) => {
            *points = simplify_line(points, tolerance2, 2);
            points.len() >= 2 && line_length(points) > tolerance2.sqrt()
        }
        Body::Polygon(rings) => {
            let Some(exterior) = rings
                .first()
                .and_then(|ring| simplify_ring(ring, tolerance2))
            else {
                return false;
            };
            let mut simplified = Vec::with_capacity(rings.len());
            simplified.push(exterior);
            // A collapsed or sub-pixel interior ring is a hole too small to
            // see, not a reason to discard an otherwise viable polygon.
            for ring in &rings[1..] {
                if is_small_hole(ring, min_part_size) {
                    continue;
                }
                if let Some(ring) = simplify_ring(ring, tolerance2) {
                    simplified.push(ring);
                }
            }
            *rings = simplified;
            true
        }
        Body::Collection(children) => {
            children.retain_mut(|child| simplify_geometry(child, tolerance2, min_part_size));
            !children.is_empty()
        }
    }
}

fn simplify_ring(ring: &[Coordinate], tolerance2: f64) -> Option<Vec<Coordinate>> {
    ring_indices(ring, tolerance2).map(|kept| select(ring, &kept))
}

/// Retained source indices of a closed ring, or `None` when it collapses.
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

fn clean_geometry(geometry: &mut Geometry, grid: f64) -> bool {
    match &mut geometry.body {
        Body::Polygon(rings) => {
            let Some(cleaned) = clean_polygon(rings, grid) else {
                return false;
            };
            if let PolygonCleanResult::Split(polygons) = cleaned {
                let child_raw_type = raw_type_with_kind(geometry.raw_type & !0x2000_0000, 3);
                let children = polygons
                    .into_iter()
                    .map(|rings| Geometry {
                        byte_order: geometry.byte_order,
                        raw_type: child_raw_type,
                        srid: None,
                        body: Body::Polygon(rings),
                    })
                    .collect();
                geometry.raw_type = raw_type_with_kind(geometry.raw_type, 6);
                geometry.body = Body::Collection(children);
            }
            true
        }
        Body::Collection(children) => {
            if !children.iter_mut().all(|child| clean_geometry(child, grid)) {
                return false;
            }
            // A repaired Polygon can split into a MultiPolygon. Flatten it
            // when it is already nested in a MultiPolygon WKB container.
            if geometry_kind(geometry.raw_type) == 6 {
                let mut flattened = Vec::with_capacity(children.len());
                for child in std::mem::take(children) {
                    if geometry_kind(child.raw_type) == 6 {
                        let Body::Collection(grandchildren) = child.body else {
                            return false;
                        };
                        flattened.extend(grandchildren);
                    } else {
                        flattened.push(child);
                    }
                }
                *children = flattened;
            }
            true
        }
        Body::LineString(points) => {
            points.dedup_by(|right, left| same_xy(left, right));
            points.len() >= 2 && line_length(points) > 0.0
        }
        Body::Point(_) => true,
    }
}

fn rendering_geometry_is_valid(geometry: &Geometry) -> bool {
    match &geometry.body {
        Body::Point(point) => {
            point.0.len() >= 2 && point.0[0].is_finite() && point.0[1].is_finite()
        }
        Body::LineString(points) => {
            points.len() >= 2
                && points
                    .iter()
                    .all(|point| point.0.len() >= 2 && point.0[..2].iter().all(|v| v.is_finite()))
                && line_length(points) > 0.0
        }
        Body::Polygon(rings) => polygon_rings_valid(rings),
        Body::Collection(children) => {
            if children.is_empty() || !children.iter().all(rendering_geometry_is_valid) {
                return false;
            }
            if geometry_kind(geometry.raw_type) != 6 {
                return true;
            }
            let polygons: Option<Vec<_>> = children
                .iter()
                .map(|child| match &child.body {
                    Body::Polygon(rings) => Some(polygon_xy(rings)),
                    _ => None,
                })
                .collect();
            polygons.is_some_and(|polygons| multipolygon_valid(&polygons))
        }
    }
}

fn polygon_rings_valid(rings: &[Vec<Coordinate>]) -> bool {
    !rings.is_empty()
        && rings.iter().all(|ring| {
            ring.len() >= 4
                && same_xy(&ring[0], ring.last().expect("ring is non-empty"))
                && signed_area2(&ring[..ring.len() - 1]) != 0.0
        })
        && polygon_valid(&polygon_xy(rings))
}

enum PolygonCleanResult {
    Unchanged,
    Split(Vec<Vec<Vec<Coordinate>>>),
}

fn clean_polygon(rings: &mut Vec<Vec<Coordinate>>, grid: f64) -> Option<PolygonCleanResult> {
    if rings
        .iter()
        .flatten()
        .any(|coordinate| coordinate.0.len() != 2)
    {
        return polygon_valid(&polygon_xy(rings)).then_some(PolygonCleanResult::Unchanged);
    }

    // Tippecanoe cleans after scaling to integer tile coordinates. Do the same
    // on our power-of-two overview grid so newly noded intersections cannot
    // reintroduce arbitrary f64 low bits and defeat Parquet compression.
    let grid_polygon = polygon_grid(rings, grid)?;
    let mut overlay = Overlay::with_contours(&grid_polygon.contours, &[]);
    overlay.options.ogc = true;
    let cleaned = overlay.overlay(OverlayRule::Subject, FillRule::EvenOdd);
    if cleaned.is_empty() {
        return None;
    }
    if cleaned.len() == 1 {
        let result = polygon_coordinates(&cleaned[0], grid, &grid_polygon);
        if polygon_rings_valid(&result) {
            *rings = result;
            return Some(PolygonCleanResult::Unchanged);
        }
    }

    let split = cleaned
        .iter()
        .map(|shape| polygon_coordinates(shape, grid, &grid_polygon))
        .collect::<Vec<_>>();
    let regrouped = regroup_overlay_rings(split)?;
    if regrouped.len() == 1 {
        *rings = regrouped.into_iter().next().unwrap();
        Some(PolygonCleanResult::Unchanged)
    } else {
        Some(PolygonCleanResult::Split(regrouped))
    }
}

/// Some overlay results contain correct contours but attach holes to the wrong
/// shell. Rebuild ownership from ring containment; alternating nesting depth
/// preserves islands inside holes. Reject intersections and ambiguous output.
fn regroup_overlay_rings(shapes: Vec<Vec<Vec<Coordinate>>>) -> Option<Vec<Vec<Vec<Coordinate>>>> {
    if multipolygon_valid(
        &shapes
            .iter()
            .map(|rings| polygon_xy(rings))
            .collect::<Vec<_>>(),
    ) {
        return Some(shapes);
    }
    let rings: Vec<_> = shapes.into_iter().flatten().collect();
    let outlines: Vec<_> = rings
        .iter()
        .map(|ring| polygon_xy(&[ring.clone()]))
        .collect();
    if !outlines.iter().all(polygon_valid) {
        return None;
    }
    let mut parent = vec![None; rings.len()];
    for child in 0..rings.len() {
        for candidate in 0..rings.len() {
            if child == candidate || !outlines[candidate].relate(&outlines[child]).is_contains() {
                continue;
            }
            if parent[child].is_none_or(|current: usize| {
                ring_area(&rings[candidate]) < ring_area(&rings[current])
            }) {
                parent[child] = Some(candidate);
            }
        }
    }
    let mut depth = vec![0; rings.len()];
    for index in 0..rings.len() {
        let mut ancestor = parent[index];
        while let Some(next) = ancestor {
            depth[index] += 1;
            if depth[index] >= rings.len() {
                return None;
            }
            ancestor = parent[next];
        }
    }
    let mut polygons = Vec::new();
    for shell in 0..rings.len() {
        if depth[shell] % 2 != 0 {
            continue;
        }
        let mut polygon = vec![rings[shell].clone()];
        for hole in 0..rings.len() {
            if parent[hole] == Some(shell) && depth[hole] % 2 == 1 {
                polygon.push(rings[hole].clone());
            }
        }
        polygons.push(polygon);
    }
    multipolygon_valid(
        &polygons
            .iter()
            .map(|rings| polygon_xy(rings))
            .collect::<Vec<_>>(),
    )
    .then_some(polygons)
}

fn polygon_xy(rings: &[Vec<Coordinate>]) -> Polygon<f64> {
    let exterior = rings
        .first()
        .map_or_else(|| LineString::new(Vec::new()), |ring| xy_line_string(ring));
    Polygon::new(
        exterior,
        rings[1..].iter().map(|ring| xy_line_string(ring)).collect(),
    )
}

struct GridPolygon {
    contours: Vec<Vec<IntPoint>>,
    origin_x: f64,
    origin_y: f64,
}

fn polygon_grid(rings: &[Vec<Coordinate>], grid: f64) -> Option<GridPolygon> {
    let origin = rings.first()?.first()?;
    let origin_x = (origin.0[0] / grid).round();
    let origin_y = (origin.0[1] / grid).round();
    if !origin_x.is_finite() || !origin_y.is_finite() {
        return None;
    }
    let convert = |ring: &[Coordinate]| {
        let unclosed = if ring.len() >= 2 && same_xy(&ring[0], ring.last()?) {
            &ring[..ring.len() - 1]
        } else {
            ring
        };
        unclosed
            .iter()
            .map(|coordinate| {
                let x = coordinate.0[0] / grid - origin_x;
                let y = coordinate.0[1] / grid - origin_y;
                if !x.is_finite()
                    || !y.is_finite()
                    || x < i32::MIN as f64
                    || x > i32::MAX as f64
                    || y < i32::MIN as f64
                    || y > i32::MAX as f64
                {
                    return None;
                }
                Some(IntPoint::new(x.round() as i32, y.round() as i32))
            })
            .collect::<Option<Vec<_>>>()
    };
    let contours = rings
        .iter()
        .map(|ring| convert(ring))
        .collect::<Option<Vec<_>>>()?;
    Some(GridPolygon {
        contours,
        origin_x,
        origin_y,
    })
}

fn polygon_coordinates(
    shape: &[Vec<IntPoint>],
    grid: f64,
    grid_polygon: &GridPolygon,
) -> Vec<Vec<Coordinate>> {
    shape
        .iter()
        .map(|contour| {
            let mut ring: Vec<Coordinate> = contour
                .iter()
                .map(|coordinate| {
                    let x = (coordinate.x as f64 + grid_polygon.origin_x) * grid;
                    let y = (coordinate.y as f64 + grid_polygon.origin_y) * grid;
                    Coordinate(vec![
                        if x == 0.0 { 0.0 } else { x },
                        if y == 0.0 { 0.0 } else { y },
                    ])
                })
                .collect();
            if let Some(first) = ring.first().cloned() {
                ring.push(first);
            }
            ring
        })
        .collect()
}

fn geometry_kind(raw_type: u32) -> u32 {
    (raw_type & 0xffff) % 1000
}

fn raw_type_with_kind(raw_type: u32, kind: u32) -> u32 {
    if raw_type & 0xe000_0000 != 0 {
        (raw_type & 0xe000_0000) | kind
    } else {
        (raw_type / 1000) * 1000 + kind
    }
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

fn simplify_line(points: &[Coordinate], tolerance2: f64, minimum: usize) -> Vec<Coordinate> {
    select(points, &simplify_indices(points, tolerance2, minimum))
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

fn xy_line_string(points: &[Coordinate]) -> LineString<f64> {
    LineString::new(
        points
            .iter()
            .map(|point| Coord {
                x: point.0[0],
                y: point.0[1],
            })
            .collect(),
    )
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
    let srid = if raw_type & 0x2000_0000 != 0 {
        Some(take_u32(bytes, offset, byte_order)?)
    } else {
        None
    };
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
    Ok(Geometry {
        byte_order,
        raw_type,
        srid,
        body,
    })
}

#[cfg(test)]
fn write_geometry(geometry: &Geometry, output: &mut Vec<u8>) {
    output.push(geometry.byte_order);
    put_u32(output, geometry.raw_type, geometry.byte_order);
    if let Some(srid) = geometry.srid {
        put_u32(output, srid, geometry.byte_order);
    }
    match &geometry.body {
        Body::Point(point) => put_coordinate(output, point, geometry.byte_order),
        Body::LineString(points) => put_coordinates(output, points, geometry.byte_order),
        Body::Polygon(rings) => {
            put_u32(output, rings.len() as u32, geometry.byte_order);
            for ring in rings {
                put_coordinates(output, ring, geometry.byte_order);
            }
        }
        Body::Collection(children) => {
            put_u32(output, children.len() as u32, geometry.byte_order);
            for child in children {
                write_geometry(child, output);
            }
        }
    }
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
fn put_coordinate(output: &mut Vec<u8>, coordinate: &Coordinate, order: u8) {
    for ordinate in &coordinate.0 {
        put_f64(output, *ordinate, order);
    }
}

#[cfg(test)]
fn put_coordinates(output: &mut Vec<u8>, coordinates: &[Coordinate], order: u8) {
    put_u32(output, coordinates.len() as u32, order);
    for coordinate in coordinates {
        put_coordinate(output, coordinate, order);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buildings_l12_regression() {
        let wkb = include_bytes!("../tests/fixtures/buildings-invalid-l12.wkb");
        let params = OverviewParams {
            tolerance: 0.00008583029586459785 * 0.25,
            min_part_size: 0.00008583029586459785,
        };
        let offset = [137.9925994873047, 33.21240234375];
        let source = parse_complete_geometry(wkb).unwrap();
        let OverviewOutcome::Built(built) = build_overview(&source, &params) else {
            panic!("l12 build must return a valid geometry");
        };
        assert!(rendering_geometry_is_valid(&built));
        let overview = quantized_overview_with_fallback(wkb, &params, &params, offset)
            .unwrap()
            .unwrap();
        assert_valid_quantized_multipolygon(&overview);
    }

    #[test]
    fn overlay_ring_regrouping_preserves_nested_islands() {
        let ring = |x, y, side| {
            square(x, y, side)
                .into_iter()
                .map(|(x, y)| Coordinate(vec![x, y]))
                .collect::<Vec<_>>()
        };
        // The second shell is inside the outer hole. The hole assigned to
        // that shell is actually inside the outer shell, beside the island.
        let malformed = vec![
            vec![ring(0., 0., 100.), ring(10., 10., 80.)],
            vec![ring(20., 20., 10.), ring(92., 20., 5.)],
        ];
        let regrouped = regroup_overlay_rings(malformed).unwrap();
        assert_eq!(regrouped.len(), 2);
        assert_eq!(
            regrouped.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![3, 1]
        );
        assert!(multipolygon_valid(
            &regrouped
                .iter()
                .map(|rings| polygon_xy(rings))
                .collect::<Vec<_>>()
        ));
    }

    fn levels(tolerances: &[f64]) -> Vec<OverviewParams> {
        tolerances
            .iter()
            .map(|&tolerance| OverviewParams::tolerance(tolerance))
            .collect()
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

    fn review_rectangle(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<u8> {
        let mut bytes = vec![1];
        bytes.extend(3u32.to_le_bytes());
        bytes.extend(1u32.to_le_bytes());
        bytes.extend(5u32.to_le_bytes());
        for (x, y) in [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)] {
            bytes.extend(x.to_le_bytes());
            bytes.extend(y.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn long_sliver_survives_and_snapped_multipolygon_members_are_unioned() {
        let thin = review_rectangle(0.1, 0.1, 400.1, 0.3);
        assert_eq!(first_viable_level(&thin, &levels(&[1.])).unwrap(), 0);
        assert_eq!(
            quantized_overview(&thin, 1., [0., 0.]).unwrap().x,
            vec![0, 400, 400, 0, 0]
        );
        let mut bytes = vec![1];
        bytes.extend(6u32.to_le_bytes());
        bytes.extend(2u32.to_le_bytes());
        bytes.extend(review_rectangle(0., 0., 10.1, 10.));
        bytes.extend(review_rectangle(10.4, 0., 20., 10.));
        let result = quantized_overview(&bytes, 1., [0., 0.]).unwrap();
        assert_eq!(result.polygon_ends.len(), 1);
    }

    #[test]
    fn simplifies_a_linestring_from_raw_tolerance() {
        let mut wkb = vec![1];
        put_u32(&mut wkb, 2, 1);
        put_u32(&mut wkb, 4, 1);
        for (x, y) in [(0., 0.), (1., 0.01), (2., -0.01), (3., 0.)] {
            put_f64(&mut wkb, x, 1);
            put_f64(&mut wkb, y, 1);
        }
        let simplified = simplify_wkb(&wkb, 0.1).unwrap();
        assert!(simplified.len() < wkb.len());
        let mut offset = 0;
        let parsed = parse_geometry(&simplified, &mut offset, 0).unwrap();
        let Body::LineString(points) = parsed.body else {
            panic!("expected linestring")
        };
        assert_eq!(points.len(), 2);
        assert_eq!(points[0].0[..2], [0., 0.]);
        assert_eq!(points[1].0[..2], [3., 0.]);
    }

    #[test]
    fn simplified_xy_is_snapped_but_z_is_preserved() {
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

        let simplified = simplify_wkb(&wkb, 0.1).unwrap();
        let mut offset = 0;
        let parsed = parse_geometry(&simplified, &mut offset, 0).unwrap();
        let Body::LineString(points) = parsed.body else {
            panic!("expected linestring")
        };
        assert_eq!(points.len(), 2);
        assert_eq!(points[0].0, [0.0625, 0.0625, 12.345]);
        assert_eq!(points[1].0, [2.9375, -0.0625, 34.567]);
    }

    #[test]
    fn quantization_grid_is_binary_and_no_coarser_than_tolerance() {
        assert_eq!(quantization_grid(0.1), 0.0625);
        assert_eq!(quantization_grid(1024.0), 1024.0);
        assert!(quantization_grid(1000.0) <= 1000.0);
    }

    #[test]
    fn line_viability_defers_sub_tolerance_results() {
        let mut wkb = vec![1];
        put_u32(&mut wkb, 2, 1);
        put_u32(&mut wkb, 2, 1);
        for (x, y) in [(0., 0.), (0.25, 0.)] {
            put_f64(&mut wkb, x, 1);
            put_f64(&mut wkb, y, 1);
        }

        assert_eq!(first_viable_level(&wkb, &levels(&[1.0, 0.1])).unwrap(), 1);
    }

    #[test]
    fn finest_overview_revives_a_sub_grid_line() {
        let mut wkb = vec![1];
        put_u32(&mut wkb, 2, 1);
        put_u32(&mut wkb, 2, 1);
        for (x, y) in [(0.0, 0.0), (0.25, 0.0)] {
            put_f64(&mut wkb, x, 1);
            put_f64(&mut wkb, y, 1);
        }

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
    fn polygon_ring_remains_closed_and_has_minimum_vertices() {
        let coordinates = [
            (0.04, 0.04),
            (0.54, 0.04),
            (1.04, 0.04),
            (1.04, 1.04),
            (0.04, 1.04),
            (0.04, 0.04),
        ];
        let mut wkb = vec![1];
        put_u32(&mut wkb, 3, 1);
        put_u32(&mut wkb, 1, 1);
        put_u32(&mut wkb, coordinates.len() as u32, 1);
        for (x, y) in coordinates {
            put_f64(&mut wkb, x, 1);
            put_f64(&mut wkb, y, 1);
        }

        let simplified = simplify_wkb(&wkb, 0.1).unwrap();
        let mut offset = 0;
        let parsed = parse_geometry(&simplified, &mut offset, 0).unwrap();
        let Body::Polygon(rings) = parsed.body else {
            panic!("expected polygon")
        };
        assert_eq!(rings.len(), 1);
        assert!(rings[0].len() >= 4);
        assert!(same_xy(&rings[0][0], rings[0].last().unwrap()));
        assert!(rings[0].iter().all(|coordinate| {
            coordinate.0[..2]
                .iter()
                .all(|ordinate| *ordinate / 0.0625 == (*ordinate / 0.0625).round())
        }));
        assert!(simplified.len() < wkb.len());
    }

    #[test]
    fn polygon_simplification_does_not_introduce_self_intersection() {
        // Plain RDP at tolerance 5 replaces the lower-left chain with a chord
        // that crosses the closing edge from (2.12, -1.77) to (1.56, 0).
        let coordinates = [
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
        let mut wkb = vec![1];
        put_u32(&mut wkb, 3, 1);
        put_u32(&mut wkb, 1, 1);
        put_u32(&mut wkb, coordinates.len() as u32, 1);
        for (x, y) in coordinates {
            put_f64(&mut wkb, x, 1);
            put_f64(&mut wkb, y, 1);
        }

        let simplified = simplify_wkb(&wkb, 5.0).unwrap();
        let mut offset = 0;
        let parsed = parse_geometry(&simplified, &mut offset, 0).unwrap();
        assert_valid_polygonal_geometry(&parsed);
        assert_eq!(geometry_kind(parsed.raw_type), 3);

        let overview = quantized_overview(&wkb, 5.0, [0.0, 0.0]).unwrap();
        assert_valid_quantized_multipolygon(&overview);
    }

    #[test]
    fn polygon_z_retries_without_inventing_z() {
        let coordinates = [
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
        let mut wkb = vec![1];
        put_u32(&mut wkb, 1003, 1); // ISO WKB Polygon Z
        put_u32(&mut wkb, 1, 1);
        put_u32(&mut wkb, coordinates.len() as u32, 1);
        for (index, (x, y)) in coordinates.into_iter().enumerate() {
            put_f64(&mut wkb, x, 1);
            put_f64(&mut wkb, y, 1);
            put_f64(&mut wkb, index as f64, 1);
        }

        let simplified = simplify_wkb(&wkb, 5.0).unwrap();
        assert!(simplified.len() < wkb.len());
        let mut offset = 0;
        let parsed = parse_geometry(&simplified, &mut offset, 0).unwrap();
        assert_valid_polygonal_geometry(&parsed);
        let Body::Polygon(rings) = parsed.body else {
            panic!("expected polygon")
        };
        assert!(rings[0]
            .iter()
            .all(|coordinate| coordinate.0[2].fract() == 0.0));
    }

    #[test]
    fn quantization_retry_keeps_a_tiny_polygon_visible() {
        let coordinates = [
            (0.0, 0.0),
            (1.0, 0.49),
            (2.0, 0.0),
            (1.0, -0.49),
            (0.0, 0.0),
        ];
        let mut wkb = vec![1];
        put_u32(&mut wkb, 3, 1);
        put_u32(&mut wkb, 1, 1);
        put_u32(&mut wkb, coordinates.len() as u32, 1);
        for (x, y) in coordinates {
            put_f64(&mut wkb, x, 1);
            put_f64(&mut wkb, y, 1);
        }

        let simplified = simplify_wkb(&wkb, 1.0).unwrap();
        let mut offset = 0;
        let parsed = parse_geometry(&simplified, &mut offset, 0).unwrap();
        assert_valid_polygonal_geometry(&parsed);
        let Body::Polygon(rings) = parsed.body else {
            panic!("expected polygon")
        };
        assert!(rings[0].len() >= 4);
        assert!(signed_area2(&rings[0]).abs() > 0.0);
        assert_ne!(simplified, wkb);
        assert_eq!(first_viable_level(&wkb, &levels(&[1.0, 0.1])).unwrap(), 0);
    }

    #[test]
    fn sub_meter_polygon_far_from_origin_gets_a_rendering_fallback() {
        // buildings.cogp.parquet row 73,031,160 exposed cancellation in the
        // shoelace sum: products around 136×36 hid an area around 1e-12.
        let coordinates = [
            (136.2325434, 36.2068124),
            (136.2325424, 36.2068124),
            (136.2325425, 36.2068115),
            (136.2325434, 36.2068115),
            (136.2325434, 36.2068124),
        ];
        let mut wkb = vec![1];
        put_u32(&mut wkb, 3, 1);
        put_u32(&mut wkb, 1, 1);
        put_u32(&mut wkb, coordinates.len() as u32, 1);
        for (x, y) in coordinates {
            put_f64(&mut wkb, x, 1);
            put_f64(&mut wkb, y, 1);
        }

        let tolerance = 0.60 / 111_320.0;
        let overview = quantized_overview(&wkb, tolerance, [136.0, 36.0]).unwrap();
        assert_valid_quantized_multipolygon(&overview);
    }

    #[test]
    fn polygon_type_and_topology_are_stable_across_overview_levels() {
        let coordinates = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0), (0.0, 0.0)];
        let mut wkb = vec![1];
        put_u32(&mut wkb, 3, 1);
        put_u32(&mut wkb, 1, 1);
        put_u32(&mut wkb, coordinates.len() as u32, 1);
        for (x, y) in coordinates {
            put_f64(&mut wkb, x, 1);
            put_f64(&mut wkb, y, 1);
        }

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
            let mut wkb = vec![1];
            put_u32(&mut wkb, 3, 1);
            put_u32(&mut wkb, 1, 1);
            put_u32(&mut wkb, 5, 1);
            // Area is 100 grid cells, above the tiny-polygon threshold. Both
            // sides of the narrow dimension nevertheless snap to the same cell.
            for (x, y) in [
                (0.0, 0.0),
                (400.0, 0.0),
                (400.0, 0.25),
                (0.0, 0.25),
                (0.0, 0.0),
            ] {
                let (x, y) = if vertical { (y, x) } else { (x, y) };
                put_f64(&mut wkb, x, 1);
                put_f64(&mut wkb, y, 1);
            }
            let overview = quantized_overview(&wkb, 1.0, [0.0, 0.0]).unwrap();
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
        let mut wkb = vec![1];
        put_u32(&mut wkb, 3, 1);
        put_u32(&mut wkb, 1, 1);
        put_u32(&mut wkb, 5, 1);
        for (x, y) in [
            (135.5509395, 34.6617107),
            (135.5509392, 34.6617107),
            (135.5509249, 34.6615756),
            (135.5509256, 34.6615756),
            (135.5509395, 34.6617107),
        ] {
            put_f64(&mut wkb, x, 1);
            put_f64(&mut wkb, y, 1);
        }
        let tolerance = 0.000001341;
        assert_eq!(first_viable_level(&wkb, &levels(&[tolerance])).unwrap(), 0);
        let overview = quantized_overview(&wkb, tolerance, [135.5, 34.5]).unwrap();
        assert_valid_quantized_multipolygon(&overview);
        assert!(overview.y.iter().max().unwrap() - overview.y.iter().min().unwrap() > 100);
    }

    #[test]
    fn invalid_thin_polygon_still_has_a_rendering_overview() {
        let coordinates = [
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
        ];
        let mut wkb = vec![1];
        put_u32(&mut wkb, 3, 1);
        put_u32(&mut wkb, 1, 1);
        put_u32(&mut wkb, coordinates.len() as u32, 1);
        for (x, y) in coordinates {
            put_f64(&mut wkb, x, 1);
            put_f64(&mut wkb, y, 1);
        }

        let overview = quantized_overview(&wkb, 38.22 / 111_320.0, [141.0, 45.0]).unwrap();
        assert_valid_quantized_multipolygon(&overview);
    }

    fn assert_valid_polygonal_geometry(geometry: &Geometry) {
        match (&geometry.body, geometry_kind(geometry.raw_type)) {
            (Body::Polygon(rings), 3) => assert!(polygon_valid(&polygon_xy(rings))),
            (Body::Collection(children), 6) => {
                assert!(!children.is_empty());
                for child in children {
                    assert_valid_polygonal_geometry(child);
                }
            }
            _ => panic!("expected polygonal geometry"),
        }
    }

    fn assert_valid_quantized_multipolygon(overview: &QuantizedOverview) {
        assert_eq!(overview.geometry_type, 6);
        assert!(quantized_multipolygon_valid(overview));
        assert_eq!(overview.x.len(), overview.y.len());
        assert!(!overview.polygon_ends.is_empty());

        let mut coordinate_start = 0;
        let mut ring_start = 0;
        for &polygon_end in &overview.polygon_ends {
            let polygon_end = polygon_end as usize;
            assert!(polygon_end > ring_start && polygon_end <= overview.part_ends.len());
            let mut rings = Vec::new();
            for &part_end in &overview.part_ends[ring_start..polygon_end] {
                let part_end = part_end as usize;
                assert!(part_end > coordinate_start && part_end <= overview.x.len());
                rings.push(
                    overview.x[coordinate_start..part_end]
                        .iter()
                        .zip(&overview.y[coordinate_start..part_end])
                        .map(|(&x, &y)| Coordinate(vec![x as f64, y as f64]))
                        .collect(),
                );
                coordinate_start = part_end;
            }
            assert!(polygon_xy(&rings).is_valid());
            ring_start = polygon_end;
        }
        assert_eq!(coordinate_start, overview.x.len());
        assert_eq!(ring_start, overview.part_ends.len());
    }

    #[test]
    fn coarse_polygon_tolerance_falls_back_to_raw_at_the_final_level() {
        let mut coordinates = Vec::new();
        for x in 0..=100 {
            coordinates.push((x as f64 / 100.0, 0.0));
        }
        for y in 1..=100 {
            coordinates.push((1.0, y as f64 / 100.0));
        }
        for x in (0..100).rev() {
            coordinates.push((x as f64 / 100.0, 1.0));
        }
        for y in (1..100).rev() {
            coordinates.push((0.0, y as f64 / 100.0));
        }
        coordinates.push(coordinates[0]);

        let mut wkb = vec![1];
        put_u32(&mut wkb, 3, 1);
        put_u32(&mut wkb, 1, 1);
        put_u32(&mut wkb, coordinates.len() as u32, 1);
        for (x, y) in coordinates {
            put_f64(&mut wkb, x, 1);
            put_f64(&mut wkb, y, 1);
        }

        let simplified = simplify_wkb(&wkb, 10.0).unwrap();
        let mut offset = 0;
        let parsed = parse_geometry(&simplified, &mut offset, 0).unwrap();
        let Body::Polygon(rings) = parsed.body else {
            panic!("expected polygon")
        };
        assert_eq!(rings[0].len(), 401);
        assert!(same_xy(&rings[0][0], rings[0].last().unwrap()));
        assert_eq!(simplified, wkb);
    }

    #[test]
    fn polygon_viability_defers_until_a_ring_survives() {
        let coordinates = [(0., 0.), (1., 0.), (1., 1.), (0., 1.), (0., 0.)];
        let mut wkb = vec![1];
        put_u32(&mut wkb, 3, 1);
        put_u32(&mut wkb, 1, 1);
        put_u32(&mut wkb, coordinates.len() as u32, 1);
        for (x, y) in coordinates {
            put_f64(&mut wkb, x, 1);
            put_f64(&mut wkb, y, 1);
        }

        assert_eq!(first_viable_level(&wkb, &levels(&[10.0, 0.1])).unwrap(), 1);
    }

    #[test]
    fn coarser_fallback_covers_non_monotonic_polygon_viability() {
        // This valid, thin quadrilateral survives coarser and finer grids but
        // collapses on the grid between them. It is distilled from a real
        // building footprint.
        let coordinates = [
            (124.0727199, 39.8270021),
            (124.0775812, 39.828717),
            (124.0775559, 39.8287598),
            (124.0726945, 39.8270449),
            (124.0727199, 39.8270021),
        ];
        let mut wkb = vec![1];
        put_u32(&mut wkb, 3, 1);
        put_u32(&mut wkb, 1, 1);
        put_u32(&mut wkb, coordinates.len() as u32, 1);
        for (x, y) in coordinates {
            put_f64(&mut wkb, x, 1);
            put_f64(&mut wkb, y, 1);
        }

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
    fn local_defects_do_not_restore_every_source_vertex() {
        // Snapping makes this ring's simplification self-touching in a few
        // places. Whole-geometry retries end at tolerance zero and keep about
        // three quarters of the source vertices; refining only the defective
        // spans leaves the rest of the ring simplified.
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

    fn coordinates(points: &[(f64, f64)]) -> Vec<Coordinate> {
        points
            .iter()
            .map(|&(x, y)| Coordinate(vec![x, y]))
            .collect()
    }

    #[test]
    fn defective_spans_mark_only_offending_edges() {
        // Spans 3 and 5 dip below the bottom edge (span 0) and cross it.
        let crossing = coordinates(&[
            (0., 0.),
            (10., 0.),
            (10., 10.),
            (6., 10.),
            (6., -2.),
            (4., -2.),
            (4., 10.),
            (0., 10.),
            (0., 0.),
        ]);
        assert_eq!(
            defective_spans(&[crossing]),
            vec![vec![true, false, false, true, false, true, false, false]]
        );

        let square = coordinates(&[(0., 0.), (10., 0.), (10., 10.), (0., 10.), (0., 0.)]);
        let hole = coordinates(&[(2., 2.), (4., 2.), (4., 4.), (2., 4.), (2., 2.)]);
        assert_eq!(
            defective_spans(&[square, hole]),
            vec![vec![false; 4], vec![false; 4]]
        );
    }

    #[test]
    fn refinement_only_adds_vertices_to_defective_spans() {
        // Each side has nine interior vertices alternately 0.6 either side of
        // it: dropped at tolerance 1, retained at the first retry tolerance (0.5).
        let corners = [(0., 0.), (100., 0.), (100., 100.), (0., 100.), (0., 0.)];
        let mut points = Vec::new();
        for side in corners.windows(2) {
            let ((x0, y0), (x1, y1)) = (side[0], side[1]);
            let (nx, ny) = ((y1 - y0) / 100.0, (x0 - x1) / 100.0);
            for step in 0..10 {
                let t = step as f64 / 10.0;
                let offset = match step {
                    0 => 0.0,
                    _ if step % 2 == 1 => 0.6,
                    _ => -0.6,
                };
                points.push((
                    x0 + (x1 - x0) * t + nx * offset,
                    y0 + (y1 - y0) * t + ny * offset,
                ));
            }
        }
        points.push(points[0]);
        let ring = coordinates(&points);
        let kept = ring_indices(&ring, 1.0).unwrap();
        assert_eq!(kept, vec![0, 10, 20, 30, 40]);

        let mut plan = RingPlan::new(&ring, kept);
        assert!(plan.refine(&[false, true, false, false], 1.0));
        let mut expected = vec![0];
        expected.extend(10..=20);
        expected.extend([30, 40]);
        assert_eq!(plan.kept, expected);
        assert_eq!(plan.steps[0], 0);
        assert!(plan.steps[1..11].iter().all(|&step| step == 1));
        assert_eq!(plan.steps[11..], [0, 0]);
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
}
