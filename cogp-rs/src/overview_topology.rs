//! Valid-by-construction polygon overviews on the integer output grid.
//!
//! Coordinates are absolute grid cells. Every step after snapping works on
//! those integers with exact predicates, so no later step can move a vertex off
//! the grid or depend on floating-point rounding:
//!
//! 1. [`normalize`] turns snapped rings into valid polygons. Input that is
//!    already valid passes through unchanged. Otherwise each member's area
//!    (its even-odd shell minus its holes) is rebuilt by an overlay, members
//!    are unioned, and ring ownership is reassembled from containment rather
//!    than taken from the overlay's grouping.
//! 2. [`simplify`] is Douglas-Peucker restricted to replacements that keep the
//!    geometry valid: the new edge crosses or touches no other edge except at
//!    its own endpoints, and the region it sweeps over contains no other
//!    vertex. Every intermediate state is valid, so the result is too.
//!
//! "Valid" means the validator's polygon rules: closed simple rings, holes
//! inside their shell, and members whose interiors are disjoint. Rings may
//! meet only at isolated points.

use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay::Overlay;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::i_float::int::point::IntPoint;
use rstar::primitives::{GeomWithData, Rectangle};
use rstar::{Envelope, RTree, RTreeObject, AABB};

/// A coordinate in absolute grid cells.
pub(crate) type Point = [i64; 2];
/// An implicitly closed ring: the first point is not repeated.
pub(crate) type Ring = Vec<Point>;
/// Polygons as rings, shell first.
pub(crate) type Polygons = Vec<Vec<Ring>>;

fn cross(origin: Point, a: Point, b: Point) -> i128 {
    let (ax, ay) = ((a[0] - origin[0]) as i128, (a[1] - origin[1]) as i128);
    let (bx, by) = ((b[0] - origin[0]) as i128, (b[1] - origin[1]) as i128);
    ax * by - ay * bx
}

fn in_box(p: Point, a: Point, b: Point) -> bool {
    p[0] >= a[0].min(b[0])
        && p[0] <= a[0].max(b[0])
        && p[1] >= a[1].min(b[1])
        && p[1] <= a[1].max(b[1])
}

fn on_segment(p: Point, a: Point, b: Point) -> bool {
    cross(a, b, p) == 0 && in_box(p, a, b)
}

#[derive(Debug, PartialEq)]
enum Hit {
    None,
    /// The segments share exactly this point.
    Point(Point),
    /// A proper crossing or a collinear overlap.
    Cross,
}

fn hit(a: Point, b: Point, c: Point, d: Point) -> Hit {
    let (d1, d2) = (cross(a, b, c).signum(), cross(a, b, d).signum());
    let (d3, d4) = (cross(c, d, a).signum(), cross(c, d, b).signum());
    if d1 * d2 < 0 && d3 * d4 < 0 {
        return Hit::Cross;
    }
    if d1 == 0 && d2 == 0 {
        let mut shared: Vec<Point> = [c, d]
            .into_iter()
            .filter(|&p| in_box(p, a, b))
            .chain([a, b].into_iter().filter(|&p| in_box(p, c, d)))
            .collect();
        shared.sort_unstable();
        shared.dedup();
        return match shared.as_slice() {
            [] => Hit::None,
            [p] => Hit::Point(*p),
            _ => Hit::Cross,
        };
    }
    // Not collinear: at most one shared point, an endpoint of either segment.
    for (p, (s, t)) in [(c, (a, b)), (d, (a, b)), (a, (c, d)), (b, (c, d))] {
        if on_segment(p, s, t) {
            return Hit::Point(p);
        }
    }
    Hit::None
}

/// Winding number of an implicitly closed ring around `p`, or `None` when
/// `p` lies on the ring.
fn winding(ring: &[Point], p: Point) -> Option<i32> {
    let mut winding = 0;
    for index in 0..ring.len() {
        let (a, b) = (ring[index], ring[(index + 1) % ring.len()]);
        if on_segment(p, a, b) {
            return None;
        }
        if a[1] <= p[1] {
            if b[1] > p[1] && cross(a, b, p) > 0 {
                winding += 1;
            }
        } else if b[1] <= p[1] && cross(a, b, p) < 0 {
            winding -= 1;
        }
    }
    Some(winding)
}

fn area2(ring: &[Point]) -> i128 {
    let origin = ring[0];
    (1..ring.len().saturating_sub(1))
        .map(|index| cross(origin, ring[index], ring[index + 1]))
        .sum()
}

fn bounds(points: impl IntoIterator<Item = Point>) -> AABB<Point> {
    let mut points = points.into_iter();
    let first = points.next().expect("non-empty point set");
    points.fold(AABB::from_point(first), |envelope, point| {
        envelope.merged(&AABB::from_point(point))
    })
}

fn segment_distance2(p: Point, a: Point, b: Point) -> f64 {
    let (dx, dy) = ((b[0] - a[0]) as f64, (b[1] - a[1]) as f64);
    let (px, py) = ((p[0] - a[0]) as f64, (p[1] - a[1]) as f64);
    let length2 = dx * dx + dy * dy;
    if length2 == 0.0 {
        return px * px + py * py;
    }
    let t = ((px * dx + py * dy) / length2).clamp(0.0, 1.0);
    (px - t * dx).powi(2) + (py - t * dy).powi(2)
}

/// Remove repeated consecutive points, including a repeated closing point.
fn dedup_ring(mut ring: Ring) -> Ring {
    ring.dedup();
    while ring.len() > 1 && ring.first() == ring.last() {
        ring.pop();
    }
    ring
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Segment {
    a: Point,
    b: Point,
    ring: usize,
    start: usize,
}

impl RTreeObject for Segment {
    type Envelope = AABB<Point>;
    fn envelope(&self) -> Self::Envelope {
        AABB::from_corners(self.a, self.b)
    }
}

fn ring_segments(rings: &[&[Point]]) -> Vec<Segment> {
    rings
        .iter()
        .enumerate()
        .flat_map(|(ring, points)| {
            (0..points.len()).map(move |start| Segment {
                a: points[start],
                b: points[(start + 1) % points.len()],
                ring,
                start,
            })
        })
        .collect()
}

/// Whether every ring is simple and no two rings cross or overlap. With
/// `touching`, distinct rings may still share isolated points.
fn rings_noded(rings: &[&[Point]], touching: bool) -> bool {
    if rings.iter().any(|ring| ring.len() < 3) {
        return false;
    }
    let tree = RTree::bulk_load(ring_segments(rings));
    for segment in &tree {
        for other in tree.locate_in_envelope_intersecting(&segment.envelope()) {
            if (other.ring, other.start) <= (segment.ring, segment.start) {
                continue;
            }
            let shared = match hit(segment.a, segment.b, other.a, other.b) {
                Hit::None => continue,
                Hit::Cross => return false,
                Hit::Point(point) => point,
            };
            if segment.ring != other.ring {
                if touching {
                    continue;
                }
                return false;
            }
            // Within a ring only consecutive edges meet, at their common vertex.
            let count = rings[segment.ring].len();
            let consecutive = other.start == segment.start + 1
                || (segment.start == 0 && other.start == count - 1);
            let vertex = if other.start == segment.start + 1 {
                segment.b
            } else {
                segment.a
            };
            if !consecutive || shared != vertex {
                return false;
            }
        }
    }
    true
}

/// Whether `outer` contains `inner`, for rings that do not cross.
fn ring_contains(outer: &[Point], inner: &[Point]) -> Option<bool> {
    for &point in inner {
        if let Some(winding) = winding(outer, point) {
            return Some(winding != 0);
        }
    }
    // Every vertex touches `outer`. Edges do not overlap `outer`, so each
    // meets it at isolated points; try points along the edges, scaling all
    // coordinates by `parts` to keep them on the grid.
    for parts in 2..=8 {
        let scaled: Vec<Point> = outer.iter().map(|p| [p[0] * parts, p[1] * parts]).collect();
        for index in 0..inner.len() {
            let (a, b) = (inner[index], inner[(index + 1) % inner.len()]);
            let point = [a[0] * (parts - 1) + b[0], a[1] * (parts - 1) + b[1]];
            if let Some(winding) = winding(&scaled, point) {
                return Some(winding != 0);
            }
        }
    }
    None
}

/// The smallest ring containing each ring, for rings that do not cross.
fn ring_parents(rings: &[&[Point]]) -> Option<Vec<Option<usize>>> {
    let envelopes: Vec<_> = rings
        .iter()
        .map(|ring| bounds(ring.iter().copied()))
        .collect();
    let areas: Vec<_> = rings.iter().map(|ring| area2(ring).abs()).collect();
    let tree = RTree::bulk_load(
        envelopes
            .iter()
            .enumerate()
            .map(|(index, envelope)| {
                GeomWithData::new(
                    Rectangle::from_corners(envelope.lower(), envelope.upper()),
                    index,
                )
            })
            .collect(),
    );
    let mut parents = vec![None; rings.len()];
    for (child, envelope) in envelopes.iter().enumerate() {
        let mut parent: Option<usize> = None;
        for candidate in tree.locate_in_envelope_intersecting(envelope) {
            let candidate = candidate.data;
            if candidate == child
                || !envelopes[candidate].contains_envelope(envelope)
                || areas[candidate] <= areas[child]
                || parent.is_some_and(|parent| areas[parent] <= areas[candidate])
            {
                continue;
            }
            if ring_contains(rings[candidate], rings[child])? {
                parent = Some(candidate);
            }
        }
        parents[child] = parent;
    }
    Some(parents)
}

/// Group non-crossing rings into polygons by nesting depth: even depth is a
/// shell, odd depth a hole of its parent. For rings bounding one area this is
/// the area's only valid representation.
fn assemble(rings: Vec<Ring>) -> Option<Polygons> {
    let references: Vec<&[Point]> = rings.iter().map(Vec::as_slice).collect();
    let parents = ring_parents(&references)?;
    let mut depth = vec![0usize; rings.len()];
    for index in 0..rings.len() {
        let mut ancestor = parents[index];
        while let Some(next) = ancestor {
            depth[index] += 1;
            ancestor = parents[next];
        }
    }
    let mut shell_polygon = vec![usize::MAX; rings.len()];
    let mut polygons: Polygons = Vec::new();
    for index in 0..rings.len() {
        if depth[index].is_multiple_of(2) {
            shell_polygon[index] = polygons.len();
            polygons.push(vec![rings[index].clone()]);
        }
    }
    for index in 0..rings.len() {
        if depth[index] % 2 == 1 {
            let shell = parents[index]?;
            polygons[shell_polygon[shell]].push(rings[index].clone());
        }
    }
    Some(polygons)
}

/// Whether members already form a valid MultiPolygon, using the strict rule
/// that no two rings meet at all.
fn already_valid(members: &Polygons) -> bool {
    if members.iter().any(Vec::is_empty) {
        return false;
    }
    let references: Vec<&[Point]> = members.iter().flatten().map(Vec::as_slice).collect();
    if !rings_noded(&references, false) {
        return false;
    }
    let Some(parents) = ring_parents(&references) else {
        return false;
    };
    // Global ring index → (member, ring within member).
    let owners: Vec<(usize, usize)> = members
        .iter()
        .enumerate()
        .flat_map(|(member, rings)| (0..rings.len()).map(move |ring| (member, ring)))
        .collect();
    owners
        .iter()
        .zip(&parents)
        .all(|(&(member, ring), parent)| {
            match (ring, parent.map(|parent| owners[parent])) {
                // A hole lies directly inside its own shell.
                (1.., parent) => parent == Some((member, 0)),
                // A shell is outermost or an island directly inside another member's hole.
                (0, None) => true,
                (0, Some((other, hole))) => other != member && hole > 0,
            }
        })
}

/// Overlay contours with the `i64` engine, whose coordinate range (±2⁶²)
/// covers every snapped cell, and flatten the resulting shapes.
fn overlay(subject: &[Ring], clip: &[Ring], rule: OverlayRule, fill: FillRule) -> Vec<Ring> {
    let contours = |rings: &[Ring]| -> Vec<Vec<IntPoint<i64>>> {
        rings
            .iter()
            .map(|ring| ring.iter().map(|p| IntPoint::new(p[0], p[1])).collect())
            .collect()
    };
    let mut overlay = Overlay::from_subj_and_clip(&contours(subject), &contours(clip));
    overlay.options.ogc = true;
    overlay
        .overlay(rule, fill)
        .into_iter()
        .flatten()
        .map(|contour| contour.into_iter().map(|p| [p.x, p.y]).collect())
        .collect()
}

/// Build valid polygons covering the union of each member's area, where a
/// member's area is its shell under the even-odd rule minus its holes.
///
/// Rings are snapped coordinates and may be degenerate. A member whose area
/// collapses is replaced by `revive(member)`, a simple ring; `None` from it or
/// an inconsistent overlay result makes the whole feature unrepresentable.
pub(crate) fn normalize(
    members: Polygons,
    mut revive: impl FnMut(usize) -> Option<Ring>,
) -> Option<Polygons> {
    let members: Polygons = members
        .into_iter()
        .map(|rings| rings.into_iter().map(dedup_ring).collect())
        .collect();
    if already_valid(&members) {
        return Some(members);
    }

    let mut contours = Vec::new();
    let mut areas = 0;
    for (index, rings) in members.iter().enumerate() {
        let mut area = Vec::new();
        if rings.first().is_some_and(|shell| shell.len() >= 3) {
            let holes: Vec<Ring> = rings[1..]
                .iter()
                .filter(|hole| hole.len() >= 3)
                .cloned()
                .collect();
            area = overlay(
                &rings[..1],
                &holes,
                OverlayRule::Difference,
                FillRule::EvenOdd,
            );
        }
        if area.is_empty() {
            let surrogate = dedup_ring(revive(index)?);
            area = overlay(&[surrogate], &[], OverlayRule::Subject, FillRule::EvenOdd);
            if area.is_empty() {
                return None;
            }
        }
        areas += 1;
        contours.extend(area);
    }
    let rings = if areas > 1 {
        // Overlay output is consistently oriented, so the non-zero rule is
        // the union of the members.
        overlay(&contours, &[], OverlayRule::Subject, FillRule::NonZero)
    } else {
        contours
    };
    // Ring ownership below relies on contours that do not cross; check rather
    // than trust the overlay, whose shell grouping has been seen to be wrong.
    let references: Vec<&[Point]> = rings.iter().map(Vec::as_slice).collect();
    if !rings_noded(&references, true) {
        return None;
    }
    assemble(rings)
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Vertex {
    point: Point,
    ring: usize,
    index: usize,
}

impl RTreeObject for Vertex {
    type Envelope = AABB<Point>;
    fn envelope(&self) -> Self::Envelope {
        AABB::from_point(self.point)
    }
}

/// Topology-preserving Douglas-Peucker on valid polygons. `tolerance` is in
/// grid cells. Each ring keeps at least three non-collinear vertices, and
/// rings of up to four vertices are kept as they are.
pub(crate) fn simplify(polygons: &mut Polygons, tolerance: f64) {
    let counts: Vec<usize> = polygons.iter().map(Vec::len).collect();
    let mut rings: Vec<Ring> = polygons.drain(..).flatten().collect();
    for ring in &mut rings {
        // A canonical start vertex makes the result independent of ring rotation.
        let start = (0..ring.len())
            .min_by_key(|&index| ring[index])
            .unwrap_or(0);
        ring.rotate_left(start);
    }
    let references: Vec<&[Point]> = rings.iter().map(Vec::as_slice).collect();
    let mut state = SimplifyState {
        segments: RTree::bulk_load(ring_segments(&references)),
        vertices: RTree::bulk_load(
            rings
                .iter()
                .enumerate()
                .flat_map(|(ring, points)| {
                    points
                        .iter()
                        .enumerate()
                        .map(move |(index, &point)| Vertex { point, ring, index })
                })
                .collect(),
        ),
        tolerance2: tolerance * tolerance,
    };
    let mut simplified = rings.iter().enumerate().map(|(index, ring)| {
        let kept = state.simplify_ring(index, ring);
        ring.iter()
            .zip(kept)
            .filter_map(|(&point, kept)| kept.then_some(point))
            .collect()
    });
    for count in counts {
        polygons.push(simplified.by_ref().take(count).collect());
    }
}

struct SimplifyState {
    segments: RTree<Segment>,
    vertices: RTree<Vertex>,
    tolerance2: f64,
}

impl SimplifyState {
    fn simplify_ring(&mut self, ring_index: usize, ring: &[Point]) -> Vec<bool> {
        let count = ring.len();
        let mut kept = vec![true; count];
        // Dropping one vertex of a quadrilateral only distorts it.
        if count <= 4 {
            return kept;
        }
        // Anchors: the first vertex, the vertex farthest from it, and the
        // vertex farthest from the line through both. They are never
        // collinear in a valid ring, so the ring cannot collapse.
        let a = ring[0];
        let b = (1..count)
            .max_by_key(|&index| {
                let (dx, dy) = (
                    (ring[index][0] - a[0]) as i128,
                    (ring[index][1] - a[1]) as i128,
                );
                dx * dx + dy * dy
            })
            .unwrap();
        let c = (1..count)
            .max_by_key(|&index| cross(a, ring[b], ring[index]).abs())
            .unwrap();
        if cross(a, ring[b], ring[c]) == 0 {
            return kept;
        }
        let mut anchors = vec![0, b.min(c), b.max(c), count];
        anchors.dedup();
        let point = |index: usize| ring[index % count];
        let mut stack: Vec<(usize, usize)> =
            anchors.windows(2).map(|pair| (pair[0], pair[1])).collect();
        while let Some((start, end)) = stack.pop() {
            if end - start < 2 {
                continue;
            }
            let (from, to) = (point(start), point(end));
            let mut farthest = (start + end) / 2;
            let mut distance2 = 0.0;
            for index in start + 1..end {
                let candidate = segment_distance2(point(index), from, to);
                if candidate > distance2 {
                    distance2 = candidate;
                    farthest = index;
                }
            }
            if distance2 <= self.tolerance2
                && self.can_shortcut(ring_index, ring, start, end, distance2)
            {
                for index in start..end {
                    let removed = Segment {
                        a: point(index),
                        b: point(index + 1),
                        ring: ring_index,
                        start: index,
                    };
                    self.segments.remove(&removed);
                }
                for (index, kept) in kept.iter_mut().enumerate().take(end).skip(start + 1) {
                    self.vertices.remove(&Vertex {
                        point: point(index),
                        ring: ring_index,
                        index,
                    });
                    *kept = false;
                }
                self.segments.insert(Segment {
                    a: from,
                    b: to,
                    ring: ring_index,
                    start,
                });
            } else {
                stack.push((start, farthest));
                stack.push((farthest, end));
            }
        }
        kept
    }

    /// Whether replacing the chain `start..=end` of a ring with one edge keeps
    /// the geometry valid. The chain is still the original source chain.
    fn can_shortcut(
        &self,
        ring_index: usize,
        ring: &[Point],
        start: usize,
        end: usize,
        distance2: f64,
    ) -> bool {
        let count = ring.len();
        let chain: Vec<Point> = (start..=end).map(|index| ring[index % count]).collect();
        let (from, to) = (chain[0], chain[chain.len() - 1]);
        // The new edge may meet other edges only at its own endpoints.
        for segment in self
            .segments
            .locate_in_envelope_intersecting(&AABB::from_corners(from, to))
        {
            if segment.ring == ring_index && (start..end).contains(&segment.start) {
                continue;
            }
            match hit(from, to, segment.a, segment.b) {
                Hit::None => {}
                Hit::Point(point) if point == from || point == to => {}
                _ => return false,
            }
        }
        // No other vertex may lie in the region between the chain and the new
        // edge (or on its boundary). That region is within the chain's
        // distance of the new edge.
        let reach2 = (distance2.sqrt() + 1.0).powi(2);
        let envelope = bounds(chain.iter().copied());
        for vertex in self.vertices.locate_in_envelope_intersecting(&envelope) {
            let in_chain = vertex.ring == ring_index
                && ((start..=end).contains(&vertex.index) || (end == count && vertex.index == 0));
            if in_chain
                || vertex.point == from
                || vertex.point == to
                || segment_distance2(vertex.point, from, to) > reach2
            {
                continue;
            }
            if winding(&chain, vertex.point) != Some(0) {
                return false;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry_validation::multipolygon_valid;
    use geo::{Coord, LineString, Polygon};

    fn to_geo(polygons: &Polygons) -> Vec<Polygon<f64>> {
        polygons
            .iter()
            .map(|rings| {
                let mut rings: Vec<_> = rings
                    .iter()
                    .map(|ring| {
                        LineString(
                            ring.iter()
                                .chain(ring.first())
                                .map(|p| Coord {
                                    x: p[0] as f64,
                                    y: p[1] as f64,
                                })
                                .collect(),
                        )
                    })
                    .collect();
                let exterior = rings.remove(0);
                Polygon::new(exterior, rings)
            })
            .collect()
    }

    /// Valid under the validator's rules and geo's stricter OGC rules.
    fn valid(polygons: &Polygons) -> bool {
        use geo::Validation;
        let polygons = to_geo(polygons);
        !polygons.is_empty()
            && multipolygon_valid(&polygons)
            && geo::MultiPolygon(polygons).is_valid()
    }

    fn assert_valid(polygons: &Polygons) {
        assert!(valid(polygons), "invalid: {polygons:?}");
    }

    fn area(polygons: &Polygons) -> i128 {
        polygons
            .iter()
            .map(|rings| {
                area2(&rings[0]).abs() - rings[1..].iter().map(|r| area2(r).abs()).sum::<i128>()
            })
            .sum()
    }

    fn square(x: i64, y: i64, side: i64) -> Ring {
        vec![[x, y], [x + side, y], [x + side, y + side], [x, y + side]]
    }

    fn no_revive(_: usize) -> Option<Ring> {
        None
    }

    #[test]
    fn segment_hits_distinguish_touching_from_crossing() {
        assert_eq!(hit([0, 0], [2, 2], [0, 2], [2, 0]), Hit::Cross);
        assert_eq!(hit([0, 0], [2, 0], [2, 0], [3, 1]), Hit::Point([2, 0]));
        assert_eq!(hit([0, 0], [2, 0], [1, 0], [1, 1]), Hit::Point([1, 0]));
        assert_eq!(hit([0, 0], [2, 0], [1, 0], [3, 0]), Hit::Cross);
        assert_eq!(hit([0, 0], [2, 0], [2, 0], [3, 0]), Hit::Point([2, 0]));
        assert_eq!(hit([0, 0], [2, 0], [3, 0], [4, 0]), Hit::None);
        assert_eq!(hit([0, 0], [2, 0], [0, 1], [2, 1]), Hit::None);
    }

    #[test]
    fn winding_reports_boundary_points() {
        let ring = square(0, 0, 4);
        assert_eq!(winding(&ring, [2, 2]), Some(1));
        assert_eq!(winding(&ring, [5, 2]), Some(0));
        assert_eq!(winding(&ring, [4, 2]), None);
        assert_eq!(winding(&ring, [0, 0]), None);
    }

    #[test]
    fn valid_input_passes_through() {
        let members = vec![
            vec![square(0, 0, 100), square(10, 10, 30)],
            vec![square(15, 15, 5)],
            vec![square(200, 0, 10)],
        ];
        assert_eq!(normalize(members.clone(), no_revive), Some(members));
    }

    #[test]
    fn overlapping_members_are_unioned() {
        let members = vec![vec![square(0, 0, 10)], vec![square(5, 0, 10)]];
        let polygons = normalize(members, no_revive).unwrap();
        assert_valid(&polygons);
        assert_eq!((polygons.len(), area(&polygons)), (1, 2 * 150));
    }

    #[test]
    fn self_intersecting_shell_keeps_both_lobes() {
        let bowtie = vec![[0, 0], [10, 10], [10, 0], [0, 10]];
        let polygons = normalize(vec![vec![bowtie]], no_revive).unwrap();
        assert_valid(&polygons);
        assert_eq!(area(&polygons), 2 * 50);
    }

    #[test]
    fn hole_outside_its_shell_removes_only_the_overlap() {
        let members = vec![vec![square(0, 0, 10), square(5, 5, 10)]];
        let polygons = normalize(members, no_revive).unwrap();
        assert_valid(&polygons);
        assert_eq!(area(&polygons), 2 * (100 - 25));
    }

    #[test]
    fn ring_ownership_comes_from_containment() {
        // The second member's shell is an island inside the first member's
        // hole, but its own "hole" lies beside the island inside the outer
        // shell, so it overlaps nothing it could cut out.
        let members = vec![
            vec![square(0, 0, 100), square(10, 10, 80)],
            vec![square(20, 20, 10), square(92, 20, 5)],
        ];
        let polygons = normalize(members, no_revive).unwrap();
        assert_valid(&polygons);
        assert_eq!(area(&polygons), 2 * (100 * 100 - 80 * 80 + 100));
    }

    #[test]
    fn collapsed_member_is_revived() {
        let members = vec![
            vec![square(0, 0, 10)],
            vec![vec![[20, 0], [21, 0], [22, 0]]],
        ];
        let polygons = normalize(members, |index| (index == 1).then(|| square(20, 0, 1))).unwrap();
        assert_valid(&polygons);
        assert_eq!(polygons.len(), 2);
        assert!(normalize(vec![vec![vec![[0, 0], [1, 0], [2, 0]]]], no_revive).is_none());
    }

    #[test]
    fn simplification_cannot_sweep_a_hole_out_of_its_shell() {
        // The top edge zigzags within tolerance of a straight chord, and a
        // small hole sits between the zigzag and the chord. Plain
        // Douglas-Peucker (and JTS's topology-preserving variant, which only
        // checks edge crossings) would leave the hole outside the shell.
        let shell = vec![[0, 0], [100, 0], [100, 50], [50, 52], [0, 50]];
        let hole = vec![[49, 50], [50, 51], [51, 50]];
        let mut polygons = vec![vec![shell, hole]];
        assert_valid(&polygons);
        simplify(&mut polygons, 5.0);
        assert_valid(&polygons);
        assert!(polygons[0][0].contains(&[50, 52]));
    }

    #[test]
    fn simplification_keeps_nearby_members_apart() {
        let comb = |y: i64, flip: i64| -> Ring {
            let mut ring: Ring = (0..=20).map(|x| [x * 10, y + flip * (x % 2)]).collect();
            ring.extend([[200, y + flip * 20], [0, y + flip * 20]]);
            ring
        };
        let mut polygons = vec![vec![comb(0, -1)], vec![comb(1, 1)]];
        polygons[0][0].reverse();
        assert_valid(&polygons);
        simplify(&mut polygons, 3.0);
        assert_valid(&polygons);
    }

    #[test]
    fn rings_touching_at_every_vertex_are_still_nested() {
        // Found by the randomized test below: the union contains a ring whose
        // vertices and first edge midpoint all lie on another ring.
        let members: Polygons = vec![
            vec![vec![
                [29, 15],
                [26, 16],
                [25, 18],
                [23, 19],
                [22, 18],
                [20, 17],
                [19, 15],
                [20, 13],
                [21, 12],
                [23, 11],
                [25, 12],
                [27, 12],
            ]],
            vec![
                vec![
                    [14, 0],
                    [9, 36],
                    [33, 19],
                    [12, 8],
                    [21, 6],
                    [29, 12],
                    [5, 39],
                    [18, 22],
                    [5, 13],
                    [17, 37],
                    [10, 1],
                    [31, 23],
                ],
                vec![
                    [28, 16],
                    [28, 19],
                    [26, 20],
                    [23, 20],
                    [20, 18],
                    [19, 14],
                    [23, 13],
                    [26, 11],
                    [30, 12],
                ],
                vec![
                    [22, 8],
                    [22, 9],
                    [21, 9],
                    [21, 9],
                    [20, 9],
                    [20, 8],
                    [19, 7],
                    [20, 7],
                    [21, 6],
                    [22, 6],
                    [23, 7],
                ],
            ],
            vec![
                vec![[8, 16], [14, 19], [38, 9]],
                vec![
                    [13, 12],
                    [17, 32],
                    [15, 21],
                    [13, 24],
                    [25, 32],
                    [2, 30],
                    [8, 18],
                    [5, 17],
                    [29, 0],
                    [7, 29],
                ],
                vec![
                    [17, 14],
                    [15, 17],
                    [13, 20],
                    [11, 17],
                    [8, 15],
                    [9, 13],
                    [9, 10],
                    [13, 9],
                    [16, 11],
                ],
            ],
            vec![
                vec![
                    [23, 2],
                    [20, 8],
                    [16, 14],
                    [9, 12],
                    [4, 8],
                    [0, 2],
                    [3, -4],
                    [9, -8],
                    [16, -11],
                    [18, -2],
                ],
                vec![
                    [20, 4],
                    [19, 7],
                    [16, 7],
                    [14, 8],
                    [11, 9],
                    [10, 5],
                    [12, 3],
                    [12, 1],
                    [15, 1],
                    [16, 1],
                    [18, 2],
                ],
                vec![
                    [15, 2],
                    [15, 3],
                    [14, 3],
                    [14, 3],
                    [13, 4],
                    [13, 2],
                    [13, 2],
                    [13, 0],
                    [14, 1],
                    [15, 0],
                    [15, 1],
                ],
            ],
        ];
        let polygons = normalize(members, no_revive).unwrap();
        assert_valid(&polygons);
    }

    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self, range: i64) -> i64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((self.0 >> 33) % range as u64) as i64
        }
    }

    /// Random rings on a small grid: arbitrary (often self-intersecting)
    /// rings, and star-shaped rings around nearby centres that touch, nest
    /// and overlap.
    fn random_members(rng: &mut Lcg) -> Polygons {
        let members = 1 + rng.next(4);
        (0..members)
            .map(|_| {
                let rings = 1 + rng.next(3);
                let (cx, cy) = (rng.next(30), rng.next(30));
                (0..rings)
                    .map(|ring| {
                        let count = 3 + rng.next(12);
                        if rng.next(3) == 0 {
                            return (0..count).map(|_| [rng.next(40), rng.next(40)]).collect();
                        }
                        let radius = if ring == 0 {
                            6 + rng.next(14)
                        } else {
                            1 + rng.next(8)
                        };
                        let (hx, hy) = if ring == 0 {
                            (cx, cy)
                        } else {
                            (cx + rng.next(9) - 4, cy + rng.next(9) - 4)
                        };
                        (0..count)
                            .map(|index| {
                                let angle = index as f64 / count as f64 * std::f64::consts::TAU;
                                let r = (radius / 2 + rng.next(radius / 2 + 1)) as f64;
                                [
                                    hx + (r * angle.cos()).round() as i64,
                                    hy + (r * angle.sin()).round() as i64,
                                ]
                            })
                            .collect()
                    })
                    .collect()
            })
            .collect()
    }

    #[test]
    fn random_rings_normalize_and_simplify_to_valid_polygons() {
        // Fewer cases in unoptimized builds keep the suite fast; release
        // runs (and other seeds) cover far more.
        let cases = if cfg!(debug_assertions) {
            2_000
        } else {
            20_000
        };
        let mut rng = Lcg(1);
        for _ in 0..cases {
            let members = random_members(&mut rng);
            // A collapsed member becomes one cell at its first vertex, so only
            // an inconsistent overlay result could make normalization fail.
            let revive = |index: usize| {
                let [x, y] = members[index][0][0];
                Some(square(x, y, 1))
            };
            let mut polygons = normalize(members.clone(), revive)
                .unwrap_or_else(|| panic!("normalize({members:?}) failed"));
            assert!(valid(&polygons), "normalize({members:?}) = {polygons:?}");
            let normalized = polygons.clone();
            let tolerance = [0.5, 1.0, 2.0, 4.0, 8.0][rng.next(5) as usize];
            simplify(&mut polygons, tolerance);
            assert!(
                valid(&polygons),
                "simplify({normalized:?}, {tolerance}) = {polygons:?}"
            );
        }
    }
}
