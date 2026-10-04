//! Synthetic end-to-end timing of overview generation. Run with
//! `cargo test --release --lib overview_bench -- --ignored --nocapture`.
//! Every generated overview is also checked against the validator's topology
//! rules, so the timings never come from invalid output.

use crate::geometry_validation::multipolygon_valid;
use crate::wkb_simplify::{
    first_viable_level, overview_scale, quantized_overview_with_fallback, OverviewParams,
    QuantizedOverview,
};
use geo::{Coord, LineString, Polygon};
use std::time::{Duration, Instant};

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn polygon_wkb(polygons: &[Vec<Vec<(f64, f64)>>]) -> Vec<u8> {
    let mut wkb = vec![1];
    wkb.extend(6u32.to_le_bytes());
    wkb.extend((polygons.len() as u32).to_le_bytes());
    for rings in polygons {
        wkb.push(1);
        wkb.extend(3u32.to_le_bytes());
        wkb.extend((rings.len() as u32).to_le_bytes());
        for ring in rings {
            wkb.extend((ring.len() as u32 + 1).to_le_bytes());
            for &(x, y) in ring.iter().chain(std::iter::once(&ring[0])) {
                wkb.extend(x.to_le_bytes());
                wkb.extend(y.to_le_bytes());
            }
        }
    }
    wkb
}

/// A building-like footprint: an orthogonal polygon with a few notches,
/// rotated, a few metres across.
fn building(rng: &mut Lcg, cx: f64, cy: f64) -> Vec<Vec<(f64, f64)>> {
    let w = 5.0 + rng.next() * 30.0;
    let h = 5.0 + rng.next() * 30.0;
    let notch = rng.next() * 0.4;
    let local = [
        (0.0, 0.0),
        (w, 0.0),
        (w, h * (1.0 - notch)),
        (w * (1.0 - notch), h * (1.0 - notch)),
        (w * (1.0 - notch), h),
        (0.0, h),
    ];
    let angle = rng.next() * std::f64::consts::PI;
    let (s, c) = angle.sin_cos();
    let metre = 1.0 / 111_320.0;
    vec![local
        .iter()
        .map(|&(x, y)| (cx + (x * c - y * s) * metre, cy + (x * s + y * c) * metre))
        .collect()]
}

/// A simple star-shaped ring with roughness down to its vertex spacing.
fn rough_ring(rng: &mut Lcg, cx: f64, cy: f64, radius: f64, count: usize) -> Vec<(f64, f64)> {
    let phase = rng.next() * 10.0;
    (0..count)
        .map(|index| {
            let angle = index as f64 / count as f64 * std::f64::consts::TAU;
            let wave: f64 = (1..=48)
                .map(|k| (k as f64 * 3.0 * angle + k as f64 * phase).sin() / k as f64)
                .sum();
            let r = radius * (1.0 + 0.08 * wave + 0.01 * (rng.next() - 0.5));
            (cx + r * angle.cos(), cy + r * angle.sin())
        })
        .collect()
}

fn datasets() -> Vec<(&'static str, Vec<Vec<u8>>)> {
    let mut rng = Lcg(42);
    let buildings = (0..20_000)
        .map(|_| {
            let cx = 139.6 + rng.next() * 0.2;
            let cy = 35.6 + rng.next() * 0.2;
            polygon_wkb(&[building(&mut rng, cx, cy)])
        })
        .collect();
    // Administrative-like areas: a large rough shell with lakes and islands
    // (islands inside lakes as separate members).
    let admin = (0..12)
        .map(|index| {
            let cx = 130.0 + index as f64 * 1.5;
            let cy = 35.0;
            let mut shell = vec![rough_ring(&mut rng, cx, cy, 0.6, 60_000)];
            let mut members = Vec::new();
            for lake in 0..20 {
                let angle = lake as f64 / 20.0 * std::f64::consts::TAU;
                let (lx, ly) = (cx + 0.3 * angle.cos(), cy + 0.3 * angle.sin());
                let mut hole = rough_ring(&mut rng, lx, ly, 0.04, 3_000);
                hole.reverse();
                shell.push(hole);
                members.push(vec![rough_ring(&mut rng, lx, ly, 0.01, 800)]);
            }
            members.insert(0, shell);
            polygon_wkb(&members)
        })
        .collect();
    vec![("buildings", buildings), ("admin", admin)]
}

fn assert_valid(overview: &QuantizedOverview) {
    let mut coordinate = 0usize;
    let mut ring = 0usize;
    let mut polygons = Vec::new();
    for &polygon_end in &overview.polygon_ends {
        let mut rings = Vec::new();
        for &part_end in &overview.part_ends[ring..polygon_end as usize] {
            rings.push(LineString(
                (coordinate..part_end as usize)
                    .map(|i| Coord {
                        x: overview.x[i] as f64,
                        y: overview.y[i] as f64,
                    })
                    .collect(),
            ));
            coordinate = part_end as usize;
        }
        ring = polygon_end as usize;
        let exterior = rings.remove(0);
        polygons.push(Polygon::new(exterior, rings));
    }
    assert!(multipolygon_valid(&polygons), "invalid overview");
}

#[test]
#[ignore]
fn overview_bench() {
    // Web Mercator z0..=z16 resolutions in degrees for a 1024-unit tile side,
    // with the converter's default factors.
    let levels: Vec<_> = (0..=16)
        .map(|zoom| {
            let resolution = 360.0 / (1024.0 * f64::powi(2.0, zoom));
            OverviewParams {
                tolerance: resolution * 0.25,
                min_part_size: resolution,
            }
        })
        .collect();
    for (name, rows) in datasets() {
        let source_vertices: usize = rows.iter().map(|row| (row.len() - 9) / 16).sum();
        let mut viability = Duration::ZERO;
        let mut building = Duration::ZERO;
        let mut vertices = 0usize;
        for row in &rows {
            let now = Instant::now();
            let entry = first_viable_level(row, &levels).unwrap();
            viability += now.elapsed();
            for params in &levels[entry..] {
                let scale = overview_scale(params.tolerance).unwrap();
                let offset = [
                    (135.0 / scale).round() * scale,
                    (35.0 / scale).round() * scale,
                ];
                let now = Instant::now();
                let overview =
                    quantized_overview_with_fallback(row, params, &levels[entry], offset)
                        .unwrap()
                        .unwrap();
                building += now.elapsed();
                vertices += overview.x.len();
                assert_valid(&overview);
            }
        }
        println!(
            "{name}: {} rows, ~{source_vertices} source vertices; viability {viability:.2?}, \
             overviews {building:.2?}, {vertices} output vertices",
            rows.len()
        );
    }
}
