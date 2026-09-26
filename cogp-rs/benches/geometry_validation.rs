#[path = "../src/geometry_validation.rs"]
mod validation;
use geo::{Coord, LineString, Polygon, Validation};
fn main() {
    for n in [5000, 10000, 20000] {
        let ring = LineString(
            (0..=n)
                .map(|i| {
                    let a = std::f64::consts::TAU * (i % n) as f64 / n as f64;
                    Coord {
                        x: a.cos(),
                        y: a.sin(),
                    }
                })
                .collect(),
        );
        let polygon = Polygon::new(ring, vec![]);
        let now = std::time::Instant::now();
        assert!(validation::polygon_valid(&polygon));
        let indexed = now.elapsed();
        assert!(validation::multipolygon_valid(std::slice::from_ref(
            &polygon
        )));
        let now = std::time::Instant::now();
        assert!(polygon.is_valid());
        let old = now.elapsed();
        println!("{n} vertices: indexed {indexed:?}; geo {old:?}");
    }
}
