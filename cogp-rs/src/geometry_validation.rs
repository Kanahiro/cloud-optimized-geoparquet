//! Topology checks shared by overview generation and validation. Spatial indexes
//! restrict intersection work to overlapping envelopes rather than all edge pairs.
use geo::{
    coordinate_position::CoordPos,
    dimensions::Dimensions,
    line_intersection::{line_intersection, LineIntersection},
    BoundingRect, Intersects, Line, LineString, MonotoneChainPolygon, Polygon, PreparedGeometry,
    Relate,
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
    // Envelope overlap is common among irregular islands that never meet.
    // A monotone-chain intersection check can prove those pairs disjoint
    // without constructing their full DE-9IM relation graph.
    let chains: Vec<_> = polygons.iter().map(MonotoneChainPolygon::from).collect();
    let mut prepared: Vec<_> = (0..polygons.len()).map(|_| None).collect();
    for item in &tree {
        for other in tree.locate_in_envelope_intersecting(&item.envelope()) {
            if other.data <= item.data {
                continue;
            }
            if !chains[item.data].intersects(&chains[other.data]) {
                continue;
            }
            if prepared[item.data].is_none() {
                prepared[item.data] = Some(PreparedGeometry::from(&polygons[item.data]));
            }
            if prepared[other.data].is_none() {
                prepared[other.data] = Some(PreparedGeometry::from(&polygons[other.data]));
            }
            let relation = prepared[item.data]
                .as_ref()
                .unwrap()
                .relate(prepared[other.data].as_ref().unwrap());
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
    use super::*;

    fn ring(points: &[(f64, f64)]) -> LineString<f64> {
        LineString::from(points.to_vec())
    }

    #[test]
    fn indexed_checks_reject_crossings_spikes_and_invalid_holes() {
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

    #[test]
    fn overlapping_envelopes_prefilter_preserves_boundary_rules() {
        let c_shape = Polygon::new(
            ring(&[
                (0., 0.),
                (4., 0.),
                (4., 1.),
                (1., 1.),
                (1., 3.),
                (4., 3.),
                (4., 4.),
                (0., 4.),
                (0., 0.),
            ]),
            vec![],
        );
        let in_notch = Polygon::new(
            ring(&[(2., 1.5), (3., 1.5), (3., 2.5), (2., 2.5), (2., 1.5)]),
            vec![],
        );
        assert!(c_shape
            .bounding_rect()
            .unwrap()
            .intersects(&in_notch.bounding_rect().unwrap()));
        assert!(!MonotoneChainPolygon::from(&c_shape)
            .intersects(&MonotoneChainPolygon::from(&in_notch)));
        assert!(multipolygon_valid(&[c_shape, in_notch]));

        let first = Polygon::new(
            ring(&[(0., 0.), (1., 0.), (1., 1.), (0., 1.), (0., 0.)]),
            vec![],
        );
        let point_touch = Polygon::new(
            ring(&[(1., 1.), (2., 1.), (2., 2.), (1., 2.), (1., 1.)]),
            vec![],
        );
        let edge_touch = Polygon::new(
            ring(&[(1., 0.), (2., 0.), (2., 1.), (1., 1.), (1., 0.)]),
            vec![],
        );
        assert!(multipolygon_valid(&[first.clone(), point_touch]));
        assert!(!multipolygon_valid(&[first, edge_touch]));
    }
}
