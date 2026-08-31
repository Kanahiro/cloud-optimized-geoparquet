//! Experimental scale-based WKB simplification for rendering overview columns.
//!
//! The simplifier preserves WKB byte order, type flags, SRID, and retained
//! ordinates. Distance tests use XY only. Retained XY coordinates are snapped
//! to a power-of-two grid no coarser than the tolerance so their f64 low bits
//! compress well; Z/M ordinates remain lossless. Polygon rings keep their closure and minimum
//! vertex count. A simplified line is viable only when its length exceeds the
//! active tolerance. Like Tippecanoe, polygons are simplified first and cleaned
//! after coordinate quantization. No shared-edge topology is promised across
//! neighboring features.

use anyhow::{bail, Result};
use byteorder::{BigEndian, ByteOrder, LittleEndian};
use geo::{Coord, LineString, Polygon, Validation};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay::Overlay;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::i_float::int::point::IntPoint;

#[derive(Clone)]
struct Coordinate(Vec<f64>);

#[derive(Clone)]
struct Geometry {
    byte_order: u8,
    raw_type: u32,
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

pub fn simplify_wkb(bytes: &[u8], tolerance: f64) -> Result<Vec<u8>> {
    validate_tolerance(tolerance)?;
    let geometry = parse_complete_geometry(bytes)?;
    let OverviewOutcome::Built(geometry) = build_overview(&geometry, tolerance) else {
        // Callers keep the source at the finest selected level when it cannot
        // be represented safely. Coarser level selection uses the same outcome
        // and therefore never selects a source-WKB fallback as an overview.
        return Ok(bytes.to_vec());
    };
    let mut output = Vec::with_capacity(bytes.len());
    write_geometry(&geometry, &mut output);
    Ok(output)
}

/// Return the first coarse-to-fine tolerance at which the geometry remains
/// independently renderable. Parsing happens once; each candidate simplifies
/// an independent clone so approximation error never accumulates between levels.
pub fn first_viable_level(bytes: &[u8], tolerances: &[f64]) -> Result<usize> {
    if tolerances.is_empty() {
        bail!("simplification profile requires at least one tolerance");
    }
    let geometry = parse_complete_geometry(bytes)?;
    for (level, tolerance) in tolerances.iter().enumerate() {
        validate_tolerance(*tolerance)?;
        if matches!(
            build_overview(&geometry, *tolerance),
            OverviewOutcome::Built(_)
        ) {
            return Ok(level);
        }
    }
    Ok(tolerances.len() - 1)
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

fn parse_complete_geometry(bytes: &[u8]) -> Result<Geometry> {
    let mut offset = 0;
    let geometry = parse_geometry(bytes, &mut offset)?;
    if offset != bytes.len() {
        bail!("trailing bytes after WKB geometry");
    }
    Ok(geometry)
}

/// Build one overview using only the source geometry and requested tolerance.
/// Keeping viability and materialization behind this interface prevents them
/// from disagreeing about post-quantization polygon collapse.
fn build_overview(source: &Geometry, tolerance: f64) -> OverviewOutcome {
    let grid = quantization_grid(tolerance);
    build_geometry(source, tolerance * tolerance, grid)
}

fn build_geometry(source: &Geometry, tolerance2: f64, grid: f64) -> OverviewOutcome {
    if let Body::Collection(source_children) = &source.body {
        let mut children = Vec::with_capacity(source_children.len());
        for child in source_children {
            match build_geometry(child, tolerance2, grid) {
                OverviewOutcome::Built(child) => children.push(child),
                OverviewOutcome::NotViable => {}
                OverviewOutcome::PreserveSource => return OverviewOutcome::PreserveSource,
            }
        }
        if children.is_empty() {
            return OverviewOutcome::NotViable;
        }
        if geometry_kind(source.raw_type) == 6 {
            children = flatten_multipolygon_children(children);
        }
        let mut geometry = source.clone();
        geometry.body = Body::Collection(children);
        return OverviewOutcome::Built(geometry);
    }

    // Retrying with smaller distance tolerances retains more source vertices
    // without changing the output grid. The first failed viability check still
    // defers the feature; retries are only for post-quantization cleaning loss.
    const RETRY_TOLERANCE2_SCALES: [f64; 4] = [1.0, 0.25, 0.0625, 0.0];
    for (attempt, scale) in RETRY_TOLERANCE2_SCALES.into_iter().enumerate() {
        let mut candidate = source.clone();
        if !simplify_geometry(&mut candidate, tolerance2 * scale) {
            if attempt == 0 {
                return OverviewOutcome::NotViable;
            }
            continue;
        }
        quantize_geometry(&mut candidate, grid);
        let before_cleaning = candidate.clone();
        if clean_geometry(&mut candidate, grid) {
            return OverviewOutcome::Built(candidate);
        }
        if attempt == 0 {
            if let Some(revived) = revive_tiny_polygon(&before_cleaning, source, grid) {
                return OverviewOutcome::Built(revived);
            }
        }
    }
    OverviewOutcome::PreserveSource
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
/// rectangle. Restrict that approximation to truly tiny XY polygons so a
/// cleaning defect can never turn a substantial feature into a placeholder.
fn revive_tiny_polygon(candidate: &Geometry, source: &Geometry, grid: f64) -> Option<Geometry> {
    const MAX_AREA_IN_GRID_CELLS: f64 = 4.0;

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
    if !area_in_grid_cells.is_finite()
        || area_in_grid_cells <= 0.0
        || area_in_grid_cells > MAX_AREA_IN_GRID_CELLS
    {
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

    let height = area_in_grid_cells.sqrt().ceil().max(1.0);
    let width = (area_in_grid_cells / height).round().max(1.0);
    let x0 = center_x.round() - (width / 2.0).floor();
    let y0 = center_y.round() - (height / 2.0).floor();
    let x1 = x0 + width;
    let y1 = y0 + height;
    let coordinate = |x: f64, y: f64| {
        let x = x * grid;
        let y = y * grid;
        Coordinate(vec![
            if x == 0.0 { 0.0 } else { x },
            if y == 0.0 { 0.0 } else { y },
        ])
    };
    let ring = vec![
        coordinate(x0, y0),
        coordinate(x1, y0),
        coordinate(x1, y1),
        coordinate(x0, y1),
        coordinate(x0, y0),
    ];
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

fn simplify_geometry(geometry: &mut Geometry, tolerance2: f64) -> bool {
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
            // A collapsed interior ring is a sub-resolution hole, not a reason
            // to discard an otherwise viable polygon.
            for ring in &rings[1..] {
                if let Some(ring) = simplify_ring(ring, tolerance2) {
                    simplified.push(ring);
                }
            }
            *rings = simplified;
            true
        }
        Body::Collection(children) => {
            children.retain_mut(|child| simplify_geometry(child, tolerance2));
            !children.is_empty()
        }
    }
}

fn simplify_ring(ring: &[Coordinate], tolerance2: f64) -> Option<Vec<Coordinate>> {
    if ring.len() < 4 || !same_xy(&ring[0], ring.last()?) {
        return None;
    }
    // Keep level visibility compatible with the existing profile: a ring that
    // collapses below three unique vertices is deferred to a finer level.
    let viability = simplify_line(&ring[..ring.len() - 1], tolerance2, 2);
    if viability.len() < 3 || signed_area2(&viability) == 0.0 {
        return None;
    }

    // Tippecanoe passes the duplicated closing point through Douglas-Peucker
    // and forces four retained coordinates. Starting from the degenerate
    // first-to-last segment avoids making an arbitrary ring edge the baseline.
    let simplified = simplify_line(ring, tolerance2, 4);
    if simplified.len() < 4
        || !same_xy(&simplified[0], simplified.last()?)
        || signed_area2(&simplified[..simplified.len() - 1]) == 0.0
    {
        return None;
    }
    Some(simplified)
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
        Body::Point(_) | Body::LineString(_) => true,
    }
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
        return polygon_xy(rings)
            .is_valid()
            .then_some(PolygonCleanResult::Unchanged);
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
        *rings = polygon_coordinates(&cleaned[0], grid, &grid_polygon);
        return Some(PolygonCleanResult::Unchanged);
    }

    Some(PolygonCleanResult::Split(
        cleaned
            .iter()
            .map(|shape| polygon_coordinates(shape, grid, &grid_polygon))
            .collect(),
    ))
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
    let mut area2 = 0.0;
    for index in 0..points.len() {
        let next = (index + 1) % points.len();
        area2 += points[index].0[0] * points[next].0[1] - points[next].0[0] * points[index].0[1];
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

/// Ramer-Douglas-Peucker with a minimum output cardinality. Every overview is
/// derived directly from raw WKB, so errors do not accumulate between levels.
fn simplify_line(points: &[Coordinate], tolerance2: f64, minimum: usize) -> Vec<Coordinate> {
    if points.len() <= minimum {
        return points.to_vec();
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
    let simplified: Vec<Coordinate> = points
        .iter()
        .zip(keep)
        .filter(|(_, keep)| *keep)
        .map(|(point, _)| point.clone())
        .collect();
    if simplified.len() < minimum {
        points.to_vec()
    } else {
        simplified
    }
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

fn parse_geometry(bytes: &[u8], offset: &mut usize) -> Result<Geometry> {
    let byte_order = take_u8(bytes, offset)?;
    if byte_order > 1 {
        bail!("invalid WKB byte order: {byte_order}");
    }
    let raw_type = take_u32(bytes, offset, byte_order)?;
    let has_z = raw_type & 0x8000_0000 != 0 || matches!((raw_type / 1000) % 10, 1 | 3);
    let has_m = raw_type & 0x4000_0000 != 0 || matches!((raw_type / 1000) % 10, 2 | 3);
    let dimensions = 2 + usize::from(has_z) + usize::from(has_m);
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
            let mut rings = Vec::with_capacity(count);
            for _ in 0..count {
                rings.push(take_coordinates(bytes, offset, byte_order, dimensions)?);
            }
            Body::Polygon(rings)
        }
        4..=7 => {
            let count = take_u32(bytes, offset, byte_order)? as usize;
            let mut children = Vec::with_capacity(count);
            for _ in 0..count {
                children.push(parse_geometry(bytes, offset)?);
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

fn take_coordinates(
    bytes: &[u8],
    offset: &mut usize,
    order: u8,
    dimensions: usize,
) -> Result<Vec<Coordinate>> {
    let count = take_u32(bytes, offset, order)? as usize;
    let mut coordinates = Vec::with_capacity(count);
    for _ in 0..count {
        coordinates.push(take_coordinate(bytes, offset, order, dimensions)?);
    }
    Ok(coordinates)
}

fn put_u32(output: &mut Vec<u8>, value: u32, order: u8) {
    let mut bytes = [0; 4];
    if order == 0 {
        BigEndian::write_u32(&mut bytes, value);
    } else {
        LittleEndian::write_u32(&mut bytes, value);
    }
    output.extend_from_slice(&bytes);
}

fn put_f64(output: &mut Vec<u8>, value: f64, order: u8) {
    let mut bytes = [0; 8];
    if order == 0 {
        BigEndian::write_f64(&mut bytes, value);
    } else {
        LittleEndian::write_f64(&mut bytes, value);
    }
    output.extend_from_slice(&bytes);
}

fn put_coordinate(output: &mut Vec<u8>, coordinate: &Coordinate, order: u8) {
    for ordinate in &coordinate.0 {
        put_f64(output, *ordinate, order);
    }
}

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
        let parsed = parse_geometry(&simplified, &mut offset).unwrap();
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
        let parsed = parse_geometry(&simplified, &mut offset).unwrap();
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

        assert_eq!(first_viable_level(&wkb, &[1.0, 0.1]).unwrap(), 1);
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
        let parsed = parse_geometry(&simplified, &mut offset).unwrap();
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
        let parsed = parse_geometry(&simplified, &mut offset).unwrap();
        assert_valid_polygonal_geometry(&parsed);
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
        let parsed = parse_geometry(&simplified, &mut offset).unwrap();
        assert_valid_polygonal_geometry(&parsed);
        let Body::Polygon(rings) = parsed.body else {
            panic!("expected polygon")
        };
        assert!(rings[0]
            .iter()
            .all(|coordinate| coordinate.0[2].fract() == 0.0));
    }

    #[test]
    fn tiny_polygon_collapsed_by_quantization_is_revived_as_a_grid_cell() {
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
        let parsed = parse_geometry(&simplified, &mut offset).unwrap();
        assert_valid_polygonal_geometry(&parsed);
        let Body::Polygon(rings) = parsed.body else {
            panic!("expected polygon")
        };
        assert_eq!(rings[0].len(), 5);
        assert_eq!(signed_area2(&rings[0]).abs() / 2.0, 1.0);
        assert_ne!(simplified, wkb);
        assert_eq!(first_viable_level(&wkb, &[1.0, 0.1]).unwrap(), 0);
    }

    fn assert_valid_polygonal_geometry(geometry: &Geometry) {
        match (&geometry.body, geometry_kind(geometry.raw_type)) {
            (Body::Polygon(rings), 3) => assert!(polygon_xy(rings).is_valid()),
            (Body::Collection(children), 6) => {
                assert!(!children.is_empty());
                for child in children {
                    assert_valid_polygonal_geometry(child);
                }
            }
            _ => panic!("expected polygonal geometry"),
        }
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
        let parsed = parse_geometry(&simplified, &mut offset).unwrap();
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

        assert_eq!(first_viable_level(&wkb, &[10.0, 0.1]).unwrap(), 1);
    }
}
