//! Topology checks shared by overview generation and validation. Spatial indexes
//! restrict intersection work to overlapping envelopes rather than all edge pairs.
use geo::{
    coordinate_position::CoordPos,
    dimensions::Dimensions,
    line_intersection::{line_intersection, LineIntersection},
    BoundingRect, Line, LineString, Polygon, PreparedGeometry, Relate,
};
use rstar::{RTree, RTreeObject, AABB};

struct Edge {
    line: Line<f64>,
    index: usize,
}
impl RTreeObject for Edge {
    type Envelope = AABB<[f64; 2]>;
    fn envelope(&self) -> Self::Envelope {
        let a = self.line.start;
        let b = self.line.end;
        AABB::from_corners([a.x.min(b.x), a.y.min(b.y)], [a.x.max(b.x), a.y.max(b.y)])
    }
}

fn ring_valid(ring: &LineString<f64>) -> bool {
    if ring.0.len() < 4
        || ring.0.first() != ring.0.last()
        || ring.0.iter().any(|c| !c.x.is_finite() || !c.y.is_finite())
    {
        return false;
    }
    let edges: Vec<_> = ring
        .lines()
        .filter(|l| l.start != l.end)
        .enumerate()
        .map(|(index, line)| Edge { line, index })
        .collect();
    let count = edges.len();
    if count < 3 {
        return false;
    }
    let tree = RTree::bulk_load(edges);
    for edge in &tree {
        for other in tree.locate_in_envelope_intersecting(&edge.envelope()) {
            if other.index <= edge.index {
                continue;
            }
            if let Some(hit) = line_intersection(edge.line, other.line) {
                let adjacent =
                    other.index == edge.index + 1 || (edge.index == 0 && other.index == count - 1);
                if !adjacent
                    || !matches!(
                        hit,
                        LineIntersection::SinglePoint {
                            is_proper: false,
                            ..
                        }
                    )
                {
                    return false;
                }
            }
        }
    }
    true
}

pub(crate) fn polygon_valid(polygon: &Polygon<f64>) -> bool {
    if !std::iter::once(polygon.exterior())
        .chain(polygon.interiors())
        .all(ring_valid)
    {
        return false;
    }
    if polygon.interiors().is_empty() {
        return true;
    }
    let exterior = PreparedGeometry::from(Polygon::new(polygon.exterior().clone(), vec![]));
    let holes: Vec<_> = polygon
        .interiors()
        .iter()
        .map(|r| Polygon::new(r.clone(), vec![]))
        .collect();
    for hole in &holes {
        let relation = exterior.relate(hole);
        if !relation.is_contains()
            || relation.get(CoordPos::OnBoundary, CoordPos::OnBoundary)
                == Dimensions::OneDimensional
        {
            return false;
        }
    }
    interiors_disjoint(&holes)
}

pub(crate) fn multipolygon_valid(polygons: &[Polygon<f64>]) -> bool {
    !polygons.is_empty() && polygons.iter().all(polygon_valid) && interiors_disjoint(polygons)
}

/// Members may meet at isolated points, but cannot overlap or share an edge.
fn interiors_disjoint(polygons: &[Polygon<f64>]) -> bool {
    let envelopes: Vec<_> = polygons
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let r = p.bounding_rect().unwrap();
            rstar::primitives::GeomWithData::new(
                rstar::primitives::Rectangle::from_corners(
                    [r.min().x, r.min().y],
                    [r.max().x, r.max().y],
                ),
                i,
            )
        })
        .collect();
    let tree = RTree::bulk_load(envelopes);
    let prepared: Vec<_> = polygons.iter().map(PreparedGeometry::from).collect();
    for item in &tree {
        for other in tree.locate_in_envelope_intersecting(&item.envelope()) {
            if other.data <= item.data {
                continue;
            }
            let relation = prepared[item.data].relate(&prepared[other.data]);
            if relation.get(CoordPos::Inside, CoordPos::Inside) == Dimensions::TwoDimensional
                || relation.get(CoordPos::OnBoundary, CoordPos::OnBoundary)
                    == Dimensions::OneDimensional
            {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    #[test]
    fn indexed_checks_reject_crossings_spikes_and_invalid_holes() {
        use super::*;
        fn ring(points: &[(f64, f64)]) -> LineString<f64> {
            LineString::from(points.to_vec())
        }
        let square = ring(&[(0., 0.), (10., 0.), (10., 10.), (0., 10.), (0., 0.)]);
        let hole = ring(&[(2., 2.), (4., 2.), (4., 4.), (2., 4.), (2., 2.)]);
        assert!(polygon_valid(&Polygon::new(square.clone(), vec![hole])));
        assert!(!polygon_valid(&Polygon::new(
            ring(&[(0., 0.), (10., 10.), (0., 10.), (10., 0.), (0., 0.)]),
            vec![]
        )));
        assert!(!polygon_valid(&Polygon::new(
            ring(&[(0., 0.), (10., 0.), (5., 0.), (10., 10.), (0., 0.)]),
            vec![]
        )));
        let outside = ring(&[(20., 20.), (30., 20.), (30., 30.), (20., 30.), (20., 20.)]);
        assert!(!polygon_valid(&Polygon::new(
            square.clone(),
            vec![outside.clone()]
        )));
        assert!(multipolygon_valid(&[
            Polygon::new(square.clone(), vec![]),
            Polygon::new(outside, vec![])
        ]));
        assert!(!multipolygon_valid(&[
            Polygon::new(square.clone(), vec![]),
            Polygon::new(square, vec![])
        ]));
    }
}
