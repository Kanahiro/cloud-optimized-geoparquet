//! Experimental scale-based WKB simplification for rendering overview columns.
//!
//! The simplifier preserves WKB byte order, type flags, SRID, and retained
//! ordinates. Distance tests use XY only. Polygon rings keep their closure and
//! minimum vertex count. A simplified line is viable only when its length
//! exceeds the active tolerance. This local algorithm does not promise
//! topology preservation across rings or neighboring features.

use anyhow::{bail, Result};
use byteorder::{BigEndian, ByteOrder, LittleEndian};

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
    if !tolerance.is_finite() || tolerance <= 0.0 {
        bail!("simplification tolerance must be positive and finite");
    }
    let mut offset = 0;
    let mut geometry = parse_geometry(bytes, &mut offset)?;
    if offset != bytes.len() {
        bail!("trailing bytes after WKB geometry");
    }
    // A source feature must remain available at the finest level. If even the
    // requested tolerance cannot form a valid geometry, retaining raw WKB is
    // a lossless (zero-error) fallback. Level assignment prevents this fallback
    // at coarser levels by deferring the feature until simplification survives.
    if !simplify_geometry(&mut geometry, tolerance * tolerance) {
        return Ok(bytes.to_vec());
    }
    let mut output = Vec::with_capacity(bytes.len());
    write_geometry(&geometry, &mut output);
    Ok(output)
}

pub struct SimplificationProfile {
    /// First coarse-to-fine tolerance at which the geometry remains valid.
    pub minimum_viable_level: usize,
    /// Exact encoded WKB length at every candidate tolerance. An invalid
    /// candidate records the lossless fallback length.
    pub wkb_sizes: Vec<u64>,
}

/// Evaluate one geometry across the complete candidate tolerance ladder.
/// Parsing happens once; each candidate simplifies an independent clone so
/// approximation error never accumulates between levels.
pub fn simplification_profile(bytes: &[u8], tolerances: &[f64]) -> Result<SimplificationProfile> {
    if tolerances.is_empty() {
        bail!("simplification profile requires at least one tolerance");
    }
    let mut offset = 0;
    let geometry = parse_geometry(bytes, &mut offset)?;
    if offset != bytes.len() {
        bail!("trailing bytes after WKB geometry");
    }
    let mut minimum_viable_level = None;
    let mut wkb_sizes = Vec::with_capacity(tolerances.len());
    for (level, tolerance) in tolerances.iter().enumerate() {
        if !tolerance.is_finite() || *tolerance <= 0.0 {
            bail!("simplification tolerance must be positive and finite");
        }
        let mut candidate = geometry.clone();
        if simplify_geometry(&mut candidate, tolerance * tolerance) {
            minimum_viable_level.get_or_insert(level);
            wkb_sizes.push(geometry_wkb_size(&candidate));
        } else {
            wkb_sizes.push(bytes.len() as u64);
        }
    }
    Ok(SimplificationProfile {
        minimum_viable_level: minimum_viable_level.unwrap_or(tolerances.len() - 1),
        wkb_sizes,
    })
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
            // to discard an otherwise valid polygon.
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
    let mut simplified = simplify_line(&ring[..ring.len() - 1], tolerance2, 2);
    if simplified.len() < 3 || signed_area2(&simplified) == 0.0 {
        return None;
    }
    simplified.push(simplified[0].clone());
    Some(simplified)
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

fn geometry_wkb_size(geometry: &Geometry) -> u64 {
    let header = 1 + 4 + u64::from(geometry.srid.is_some()) * 4;
    header
        + match &geometry.body {
            Body::Point(point) => coordinate_bytes(point),
            Body::LineString(points) => 4 + coordinates_bytes(points),
            Body::Polygon(rings) => {
                4 + rings
                    .iter()
                    .map(|ring| 4 + coordinates_bytes(ring))
                    .sum::<u64>()
            }
            Body::Collection(children) => 4 + children.iter().map(geometry_wkb_size).sum::<u64>(),
        }
}

fn coordinate_bytes(coordinate: &Coordinate) -> u64 {
    coordinate.0.len() as u64 * 8
}

fn coordinates_bytes(coordinates: &[Coordinate]) -> u64 {
    coordinates.iter().map(coordinate_bytes).sum()
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
    let mut stack = vec![(0usize, points.len() - 1)];
    while let Some((start, end)) = stack.pop() {
        let mut greatest_distance2 = tolerance2;
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
    let kind = (raw_type & 0xffff) % 1000;
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
    fn line_viability_defers_sub_tolerance_results() {
        let mut wkb = vec![1];
        put_u32(&mut wkb, 2, 1);
        put_u32(&mut wkb, 2, 1);
        for (x, y) in [(0., 0.), (0.25, 0.)] {
            put_f64(&mut wkb, x, 1);
            put_f64(&mut wkb, y, 1);
        }

        let profile = simplification_profile(&wkb, &[1.0, 0.1]).unwrap();
        assert_eq!(profile.minimum_viable_level, 1);
        assert_eq!(profile.wkb_sizes[0], wkb.len() as u64);
        assert_eq!(profile.wkb_sizes[1], wkb.len() as u64);
    }

    #[test]
    fn polygon_ring_remains_closed_and_has_minimum_vertices() {
        let coordinates = [(0., 0.), (0.5, 0.), (1., 0.), (1., 1.), (0., 1.), (0., 0.)];
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
        assert!(simplified.len() < wkb.len());
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

        let profile = simplification_profile(&wkb, &[10.0, 0.1]).unwrap();
        assert_eq!(profile.minimum_viable_level, 1);
        assert_eq!(profile.wkb_sizes.len(), 2);
        assert!(profile.wkb_sizes[1] <= wkb.len() as u64);
    }
}
