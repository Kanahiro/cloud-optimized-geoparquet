use anyhow::Result;
use cogp::reader::Reader;
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
struct Sample {
    file: String,
    center: &'static str,
    resolution: f64,
    level: usize,
    candidate_row_groups: usize,
    candidate_rows: usize,
    selected_rows: usize,
    selected_runs: usize,
}

fn main() -> Result<()> {
    let centers: [(&str, f64, f64); 8] = [
        ("tokyo", 139.75, 35.68),
        ("osaka", 135.50, 34.70),
        ("nagoya", 136.90, 35.18),
        ("sapporo", 141.35, 43.06),
        ("fukuoka", 130.40, 33.59),
        ("sendai", 140.87, 38.27),
        ("hiroshima", 132.46, 34.39),
        ("naha", 127.68, 26.21),
    ];
    let resolutions = [1000.0, 100.0, 10.0];
    let mut samples = Vec::new();

    for arg in std::env::args().skip(1) {
        let reader = Reader::open(&arg)?;
        for resolution in resolutions {
            let level = reader
                .levels()
                .iter()
                .rposition(|candidate| candidate.resolution >= resolution)
                .unwrap_or(0);
            let prefix = reader.row_groups_up_to_resolution(resolution);
            for (name, x, y) in centers {
                let width_m = resolution * 512.0;
                let height_m = resolution * 512.0;
                let half_width = width_m / (2.0 * 111_320.0 * y.to_radians().cos());
                let half_height = height_m / (2.0 * 110_540.0);
                let bbox = [
                    x - half_width,
                    y - half_height,
                    x + half_width,
                    y + half_height,
                ];
                let row_groups = reader
                    .row_groups_intersecting_bbox(bbox)
                    .into_iter()
                    .filter(|row_group| prefix.contains(row_group))
                    .collect::<Vec<_>>();
                let candidate_rows = row_groups
                    .iter()
                    .map(|row_group| {
                        reader.parquet_metadata().row_group(*row_group).num_rows() as usize
                    })
                    .sum();
                let selection = reader.row_selection_intersecting_bbox(&row_groups, bbox);
                let selected_runs = selection.iter().filter(|selector| !selector.skip).count();
                samples.push(Sample {
                    file: Path::new(&arg)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    center: name,
                    resolution,
                    level,
                    candidate_row_groups: row_groups.len(),
                    candidate_rows,
                    selected_rows: selection.row_count(),
                    selected_runs,
                });
            }
        }
    }
    println!("{}", serde_json::to_string_pretty(&samples)?);
    Ok(())
}
