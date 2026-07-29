use anyhow::{bail, Result};
use byteorder::{BigEndian, LittleEndian, ReadBytesExt, WriteBytesExt};
use rayon::prelude::*;
use std::collections::HashSet;
use std::io::{Cursor, Read, Write};

#[derive(Clone)]
struct Header {
    order: u8,
    type_code: u32,
    dimensions: usize,
    srid: Option<u32>,
}

#[derive(Clone)]
struct Coord(Vec<f64>);

#[derive(Clone)]
enum Geometry {
    Point(Header, Coord),
    LineString(Header, Vec<Coord>),
    Polygon(Header, Vec<Vec<Coord>>),
    Multi(Header, Vec<Geometry>),
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct CoordKey {
    x: u64,
    y: u64,
}

impl CoordKey {
    fn new(coord: &Coord) -> Self {
        fn canonical_bits(value: f64) -> u64 {
            if value == 0.0 {
                0
            } else {
                value.to_bits()
            }
        }
        Self {
            x: canonical_bits(coord.0[0]),
            y: canonical_bits(coord.0[1]),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct VertexContext {
    mid: CoordKey,
    neighbor_1: CoordKey,
    neighbor_2: CoordKey,
}

impl VertexContext {
    fn new(previous: &Coord, mid: &Coord, next: &Coord) -> Self {
        let mut neighbor_1 = CoordKey::new(previous);
        let mut neighbor_2 = CoordKey::new(next);
        if neighbor_2 < neighbor_1 {
            std::mem::swap(&mut neighbor_1, &mut neighbor_2);
        }
        Self {
            mid: CoordKey::new(mid),
            neighbor_1,
            neighbor_2,
        }
    }
}

#[derive(Default)]
pub(crate) struct SharedNodes(HashSet<CoordKey>);

impl SharedNodes {
    fn contains(&self, coord: &Coord) -> bool {
        self.0.contains(&CoordKey::new(coord))
    }

    pub(crate) fn len(&self) -> usize {
        self.0.len()
    }
}

pub(crate) fn vertex_contexts(wkb: &[u8]) -> Result<Vec<VertexContext>> {
    let mut cursor = Cursor::new(wkb);
    let geometry = read_geometry(&mut cursor)?;
    if cursor.position() as usize != wkb.len() {
        bail!("trailing bytes after WKB geometry");
    }
    let mut contexts = Vec::new();
    collect_vertex_contexts(&geometry, &mut contexts);
    Ok(contexts)
}

pub(crate) fn detect_shared_nodes(mut contexts: Vec<VertexContext>) -> SharedNodes {
    contexts.par_sort_unstable();
    let mut nodes = HashSet::new();
    let mut start = 0;
    while start < contexts.len() {
        let mid = contexts[start].mid;
        let mut end = start + 1;
        let first_neighbors = (contexts[start].neighbor_1, contexts[start].neighbor_2);
        let mut differs = false;
        while end < contexts.len() && contexts[end].mid == mid {
            differs |= (contexts[end].neighbor_1, contexts[end].neighbor_2) != first_neighbors;
            end += 1;
        }
        if differs {
            nodes.insert(mid);
        }
        start = end;
    }
    SharedNodes(nodes)
}

/// Simplify WKB with Douglas–Peucker while retaining shared/junction nodes.
///
/// `None` means simplification can no longer form a geometry of the original
/// top-level type. Point geometries are returned unchanged.
pub(crate) fn simplify_wkb(
    wkb: &[u8],
    tolerance: f64,
    shared_nodes: &SharedNodes,
) -> Result<Option<Vec<u8>>> {
    if !tolerance.is_finite() || tolerance <= 0.0 {
        bail!("simplification tolerance must be finite and positive");
    }
    let mut cursor = Cursor::new(wkb);
    let geometry = read_geometry(&mut cursor)?;
    if cursor.position() as usize != wkb.len() {
        bail!("trailing bytes after WKB geometry");
    }
    let Some(simplified) = simplify_geometry(&geometry, tolerance, shared_nodes) else {
        return Ok(None);
    };
    let mut output = Vec::with_capacity(wkb.len());
    write_geometry(&mut output, &simplified)?;
    Ok(Some(output))
}

fn read_geometry<R: Read>(reader: &mut R) -> Result<Geometry> {
    let order = reader.read_u8()?;
    if order > 1 {
        bail!("invalid WKB byte order: {order}");
    }
    let type_code = read_u32(reader, order)?;
    let base_type = (type_code & 0xffff) % 1000;
    let has_z = type_code & 0x8000_0000 != 0 || matches!((type_code / 1000) % 10, 1 | 3);
    let has_m = type_code & 0x4000_0000 != 0 || matches!((type_code / 1000) % 10, 2 | 3);
    let srid = if type_code & 0x2000_0000 != 0 {
        Some(read_u32(reader, order)?)
    } else {
        None
    };
    let header = Header {
        order,
        type_code,
        dimensions: 2 + has_z as usize + has_m as usize,
        srid,
    };
    Ok(match base_type {
        1 => Geometry::Point(header.clone(), read_coord(reader, &header)?),
        2 => Geometry::LineString(header.clone(), read_coords(reader, &header)?),
        3 => {
            let count = read_u32(reader, order)?;
            let mut rings = Vec::with_capacity(count as usize);
            for _ in 0..count {
                rings.push(read_coords(reader, &header)?);
            }
            Geometry::Polygon(header, rings)
        }
        4..=7 => {
            let count = read_u32(reader, order)?;
            let mut children = Vec::with_capacity(count as usize);
            for _ in 0..count {
                children.push(read_geometry(reader)?);
            }
            Geometry::Multi(header, children)
        }
        other => bail!("unsupported WKB geometry type: {other}"),
    })
}

fn read_coords<R: Read>(reader: &mut R, header: &Header) -> Result<Vec<Coord>> {
    let count = read_u32(reader, header.order)?;
    (0..count).map(|_| read_coord(reader, header)).collect()
}

fn read_coord<R: Read>(reader: &mut R, header: &Header) -> Result<Coord> {
    let values = (0..header.dimensions)
        .map(|_| read_f64(reader, header.order))
        .collect::<Result<_>>()?;
    Ok(Coord(values))
}

fn collect_vertex_contexts(geometry: &Geometry, output: &mut Vec<VertexContext>) {
    match geometry {
        Geometry::Point(..) => {}
        Geometry::LineString(_, coords) => {
            for (index, coord) in coords.iter().enumerate() {
                let previous = index
                    .checked_sub(1)
                    .map_or(coord, |previous| &coords[previous]);
                let next = coords.get(index + 1).unwrap_or(coord);
                output.push(VertexContext::new(previous, coord, next));
            }
        }
        Geometry::Polygon(_, rings) => {
            for ring in rings {
                if ring.len() < 4 || !same_coord(ring.first().unwrap(), ring.last().unwrap()) {
                    continue;
                }
                let open = &ring[..ring.len() - 1];
                for i in 0..open.len() {
                    output.push(VertexContext::new(
                        &open[(i + open.len() - 1) % open.len()],
                        &open[i],
                        &open[(i + 1) % open.len()],
                    ));
                }
            }
        }
        Geometry::Multi(_, children) => {
            for child in children {
                collect_vertex_contexts(child, output);
            }
        }
    }
}

fn simplify_geometry(
    geometry: &Geometry,
    tolerance: f64,
    shared_nodes: &SharedNodes,
) -> Option<Geometry> {
    match geometry {
        Geometry::Point(..) => Some(geometry.clone()),
        Geometry::LineString(header, coords) => simplify_line(coords, tolerance, shared_nodes)
            .map(|line| Geometry::LineString(header.clone(), line)),
        Geometry::Polygon(header, rings) => {
            let exterior = simplify_ring(rings.first()?, tolerance, shared_nodes)?;
            let mut simplified = vec![exterior];
            simplified.extend(
                rings[1..]
                    .iter()
                    .filter_map(|ring| simplify_ring(ring, tolerance, shared_nodes)),
            );
            Some(Geometry::Polygon(header.clone(), simplified))
        }
        Geometry::Multi(header, children) => {
            let simplified: Vec<_> = children
                .iter()
                .filter_map(|child| simplify_geometry(child, tolerance, shared_nodes))
                .collect();
            if simplified.is_empty() {
                None
            } else {
                Some(Geometry::Multi(header.clone(), simplified))
            }
        }
    }
}

fn simplify_line(
    coords: &[Coord],
    tolerance: f64,
    shared_nodes: &SharedNodes,
) -> Option<Vec<Coord>> {
    if coords.len() < 2 {
        return None;
    }
    let mut anchors = vec![0, coords.len() - 1];
    anchors.extend(
        coords[1..coords.len() - 1]
            .iter()
            .enumerate()
            .filter(|(_, coord)| shared_nodes.contains(coord))
            .map(|(i, _)| i + 1),
    );
    anchors.sort_unstable();
    anchors.dedup();
    let mut keep = vec![false; coords.len()];
    for pair in anchors.windows(2) {
        simplify_arc(
            coords,
            &(pair[0]..=pair[1]).collect::<Vec<_>>(),
            tolerance,
            &mut keep,
        );
    }
    let simplified: Vec<_> = coords
        .iter()
        .zip(keep)
        .filter(|(_, keep)| *keep)
        .map(|(coord, _)| coord.clone())
        .collect();
    if simplified.len() >= 2 && !same_xy(&simplified[0], simplified.last()?) {
        Some(simplified)
    } else {
        None
    }
}

fn simplify_ring(
    coords: &[Coord],
    tolerance: f64,
    shared_nodes: &SharedNodes,
) -> Option<Vec<Coord>> {
    if coords.len() < 4 || !same_coord(coords.first()?, coords.last()?) {
        return None;
    }
    let open = &coords[..coords.len() - 1];
    let mut anchors: Vec<usize> = open
        .iter()
        .enumerate()
        .filter(|(_, coord)| shared_nodes.contains(coord))
        .map(|(i, _)| i)
        .collect();
    add_ring_endpoints(open, &mut anchors);
    anchors.sort_unstable();
    anchors.dedup();
    if anchors.len() < 2 {
        return None;
    }

    let mut keep = vec![false; open.len()];
    for i in 0..anchors.len() {
        let start = anchors[i];
        let end = anchors[(i + 1) % anchors.len()];
        let indices: Vec<usize> = if start < end {
            (start..=end).collect()
        } else {
            (start..open.len()).chain(0..=end).collect()
        };
        simplify_arc(open, &indices, tolerance, &mut keep);
    }
    let mut simplified: Vec<_> = open
        .iter()
        .zip(keep)
        .filter(|(_, keep)| *keep)
        .map(|(coord, _)| coord.clone())
        .collect();
    let unique = simplified
        .iter()
        .enumerate()
        .filter(|(i, point)| !simplified[..*i].iter().any(|prior| same_xy(prior, point)))
        .count();
    if unique < 3 {
        return None;
    }
    simplified.push(simplified[0].clone());
    (signed_area(&simplified).abs() > 0.0).then_some(simplified)
}

/// Give a closed ring a deterministic cut when topology did not already
/// provide two junctions. Two endpoints intentionally are not enough to make
/// a polygon: if DP removes every other vertex, the caller defers the feature
/// to a finer level rather than inventing a triangle.
fn add_ring_endpoints(coords: &[Coord], anchors: &mut Vec<usize>) {
    if anchors.is_empty() {
        anchors.push(
            (0..coords.len())
                .min_by_key(|i| CoordKey::new(&coords[*i]))
                .unwrap(),
        );
    }
    if anchors.len() == 1 {
        let origin = anchors[0];
        anchors.push(
            (0..coords.len())
                .filter(|i| *i != origin)
                .max_by(|a, b| {
                    squared_distance(&coords[*a], &coords[origin])
                        .total_cmp(&squared_distance(&coords[*b], &coords[origin]))
                        .then_with(|| CoordKey::new(&coords[*b]).cmp(&CoordKey::new(&coords[*a])))
                })
                .unwrap(),
        );
    }
}

fn simplify_arc(coords: &[Coord], indices: &[usize], tolerance: f64, keep: &mut [bool]) {
    if indices.is_empty() {
        return;
    }
    keep[indices[0]] = true;
    keep[*indices.last().unwrap()] = true;
    if indices.len() <= 2 {
        return;
    }
    let tolerance_sq = tolerance * tolerance;
    let mut stack = vec![(0usize, indices.len() - 1)];
    while let Some((start, end)) = stack.pop() {
        let a = &coords[indices[start]];
        let b = &coords[indices[end]];
        let mut farthest: Option<(usize, f64)> = None;
        for position in start + 1..end {
            let distance = point_segment_distance_sq(&coords[indices[position]], a, b);
            if distance <= tolerance_sq {
                continue;
            }
            let replace = farthest.is_none_or(|(current, current_distance)| {
                distance > current_distance
                    || (distance == current_distance
                        && CoordKey::new(&coords[indices[position]])
                            < CoordKey::new(&coords[indices[current]]))
            });
            if replace {
                farthest = Some((position, distance));
            }
        }
        if let Some((position, _)) = farthest {
            keep[indices[position]] = true;
            stack.push((start, position));
            stack.push((position, end));
        }
    }
}

fn point_segment_distance_sq(point: &Coord, start: &Coord, end: &Coord) -> f64 {
    let dx = end.0[0] - start.0[0];
    let dy = end.0[1] - start.0[1];
    let length_sq = dx * dx + dy * dy;
    if length_sq == 0.0 {
        return squared_distance(point, start);
    }
    let t = (((point.0[0] - start.0[0]) * dx + (point.0[1] - start.0[1]) * dy) / length_sq)
        .clamp(0.0, 1.0);
    let x = start.0[0] + t * dx;
    let y = start.0[1] + t * dy;
    (point.0[0] - x).powi(2) + (point.0[1] - y).powi(2)
}

fn squared_distance(a: &Coord, b: &Coord) -> f64 {
    (a.0[0] - b.0[0]).powi(2) + (a.0[1] - b.0[1]).powi(2)
}

fn same_xy(a: &Coord, b: &Coord) -> bool {
    a.0[0] == b.0[0] && a.0[1] == b.0[1]
}

fn same_coord(a: &Coord, b: &Coord) -> bool {
    a.0 == b.0
}

fn signed_area(ring: &[Coord]) -> f64 {
    ring.windows(2)
        .map(|pair| pair[0].0[0] * pair[1].0[1] - pair[1].0[0] * pair[0].0[1])
        .sum::<f64>()
        * 0.5
}

fn write_geometry<W: Write>(writer: &mut W, geometry: &Geometry) -> Result<()> {
    let header = match geometry {
        Geometry::Point(header, _)
        | Geometry::LineString(header, _)
        | Geometry::Polygon(header, _)
        | Geometry::Multi(header, _) => header,
    };
    writer.write_all(&[header.order])?;
    write_u32(writer, header.order, header.type_code)?;
    if let Some(srid) = header.srid {
        write_u32(writer, header.order, srid)?;
    }
    match geometry {
        Geometry::Point(_, coord) => write_coord(writer, header, coord)?,
        Geometry::LineString(_, coords) => write_coords(writer, header, coords)?,
        Geometry::Polygon(_, rings) => {
            write_u32(writer, header.order, rings.len() as u32)?;
            for ring in rings {
                write_coords(writer, header, ring)?;
            }
        }
        Geometry::Multi(_, children) => {
            write_u32(writer, header.order, children.len() as u32)?;
            for child in children {
                write_geometry(writer, child)?;
            }
        }
    }
    Ok(())
}

fn write_coords<W: Write>(writer: &mut W, header: &Header, coords: &[Coord]) -> Result<()> {
    write_u32(writer, header.order, coords.len() as u32)?;
    for coord in coords {
        write_coord(writer, header, coord)?;
    }
    Ok(())
}

fn write_coord<W: Write>(writer: &mut W, header: &Header, coord: &Coord) -> Result<()> {
    for value in &coord.0 {
        match header.order {
            0 => writer.write_f64::<BigEndian>(*value)?,
            1 => writer.write_f64::<LittleEndian>(*value)?,
            _ => unreachable!(),
        }
    }
    Ok(())
}

fn read_u32<R: Read>(reader: &mut R, order: u8) -> Result<u32> {
    Ok(match order {
        0 => reader.read_u32::<BigEndian>()?,
        1 => reader.read_u32::<LittleEndian>()?,
        _ => unreachable!(),
    })
}

fn read_f64<R: Read>(reader: &mut R, order: u8) -> Result<f64> {
    Ok(match order {
        0 => reader.read_f64::<BigEndian>()?,
        1 => reader.read_f64::<LittleEndian>()?,
        _ => unreachable!(),
    })
}

fn write_u32<W: Write>(writer: &mut W, order: u8, value: u32) -> Result<()> {
    match order {
        0 => writer.write_u32::<BigEndian>(value)?,
        1 => writer.write_u32::<LittleEndian>(value)?,
        _ => unreachable!(),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn polygon(size: f64) -> Vec<u8> {
        let mut bytes = vec![1];
        bytes.extend_from_slice(&3u32.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&5u32.to_le_bytes());
        for (x, y) in [
            (0.0, 0.0),
            (size, 0.0),
            (size, size),
            (0.0, size),
            (0.0, 0.0),
        ] {
            bytes.extend_from_slice(&x.to_le_bytes());
            bytes.extend_from_slice(&y.to_le_bytes());
        }
        bytes
    }

    fn line(points: &[(f64, f64)]) -> Vec<u8> {
        let mut bytes = vec![1];
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&(points.len() as u32).to_le_bytes());
        for (x, y) in points {
            bytes.extend_from_slice(&x.to_le_bytes());
            bytes.extend_from_slice(&y.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn point_is_preserved_exactly() {
        let mut point = vec![1];
        point.extend_from_slice(&1u32.to_le_bytes());
        point.extend_from_slice(&10f64.to_le_bytes());
        point.extend_from_slice(&20f64.to_le_bytes());
        assert_eq!(
            simplify_wkb(&point, 1_000.0, &SharedNodes::default()).unwrap(),
            Some(point)
        );
    }

    #[test]
    fn polygon_returns_none_when_simplification_cannot_form_a_ring() {
        assert_eq!(
            simplify_wkb(&polygon(10.0), 100.0, &SharedNodes::default()).unwrap(),
            None
        );
    }

    #[test]
    fn line_drops_sub_tolerance_bend() {
        let original = line(&[(0.0, 0.0), (5.0, 0.1), (10.0, 0.0)]);
        let simplified = simplify_wkb(&original, 1.0, &SharedNodes::default())
            .unwrap()
            .unwrap();
        assert_eq!(u32::from_le_bytes(simplified[5..9].try_into().unwrap()), 2);
    }

    #[test]
    fn detects_junctions_but_not_identical_shared_arc_interiors() {
        let first = line(&[(-1.0, 0.0), (0.0, 0.0), (1.0, 0.1), (2.0, 0.0), (3.0, 0.0)]);
        let second = line(&[(0.0, -1.0), (0.0, 0.0), (1.0, 0.1), (2.0, 0.0), (2.0, -1.0)]);
        let mut contexts = vertex_contexts(&first).unwrap();
        contexts.extend(vertex_contexts(&second).unwrap());
        let nodes = detect_shared_nodes(contexts);
        assert!(nodes.contains(&Coord(vec![0.0, 0.0])));
        assert!(nodes.contains(&Coord(vec![2.0, 0.0])));
        assert!(!nodes.contains(&Coord(vec![1.0, 0.1])));
    }

    #[test]
    fn shared_nodes_split_douglas_peucker_arcs() {
        let original = line(&[(-1.0, 0.0), (0.0, 0.0), (1.0, 0.1), (2.0, 0.0), (3.0, 0.0)]);
        let nodes = SharedNodes(HashSet::from([
            CoordKey::new(&Coord(vec![0.0, 0.0])),
            CoordKey::new(&Coord(vec![2.0, 0.0])),
        ]));
        let simplified = simplify_wkb(&original, 1.0, &nodes).unwrap().unwrap();
        assert_eq!(u32::from_le_bytes(simplified[5..9].try_into().unwrap()), 4);
    }

    #[test]
    fn reversed_shared_arcs_simplify_to_the_same_vertices() {
        let first = line(&[
            (-1.0, 0.0),
            (0.0, 0.0),
            (1.0, 0.1),
            (2.0, -0.1),
            (3.0, 0.0),
            (4.0, 0.0),
        ]);
        let second = line(&[
            (3.0, 1.0),
            (3.0, 0.0),
            (2.0, -0.1),
            (1.0, 0.1),
            (0.0, 0.0),
            (0.0, 1.0),
        ]);
        let mut contexts = vertex_contexts(&first).unwrap();
        contexts.extend(vertex_contexts(&second).unwrap());
        let nodes = detect_shared_nodes(contexts);

        let line_coords = |wkb: &[u8]| {
            let Geometry::LineString(_, coords) = read_geometry(&mut Cursor::new(wkb)).unwrap()
            else {
                panic!("expected line");
            };
            coords
        };
        let first_simplified = simplify_wkb(&first, 0.15, &nodes).unwrap().unwrap();
        let second_simplified = simplify_wkb(&second, 0.15, &nodes).unwrap().unwrap();
        let first_arc = line_coords(&first_simplified)[1..]
            .iter()
            .take_while(|coord| coord.0[0] <= 3.0)
            .map(CoordKey::new)
            .collect::<Vec<_>>();
        let mut second_arc = line_coords(&second_simplified)[1..]
            .iter()
            .take_while(|coord| coord.0[0] >= 0.0 && coord.0[1] != 1.0)
            .map(CoordKey::new)
            .collect::<Vec<_>>();
        second_arc.reverse();
        assert_eq!(first_arc, second_arc);
    }

    #[test]
    fn rejects_invalid_tolerance() {
        let original = line(&[(0.0, 0.0), (1.0, 1.0)]);
        assert!(simplify_wkb(&original, 0.0, &SharedNodes::default()).is_err());
        assert!(simplify_wkb(&original, f64::INFINITY, &SharedNodes::default()).is_err());
    }
}
