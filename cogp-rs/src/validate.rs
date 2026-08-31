use anyhow::{bail, Context, Result};
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::file::statistics::Statistics;
use std::collections::HashMap;
use std::fs::File;
use std::path::Path;

use crate::meta::{
    geometry_family, CogpMeta, GeoMeta, COGP_METADATA_KEY, COGP_VERSION, GEO_METADATA_KEY,
};

pub fn run(path: &Path) -> Result<()> {
    let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let reader = SerializedFileReader::new(file)?;
    let metadata = reader.metadata();
    let file_meta = metadata.file_metadata();
    let kv = file_meta.key_value_metadata();

    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    let mut geo_meta: Option<GeoMeta> = None;
    let mut cogp_meta: Option<CogpMeta> = None;

    if let Some(kv) = kv {
        for entry in kv {
            let value = match entry.value.as_deref() {
                Some(v) => v,
                None => continue,
            };
            match entry.key.as_str() {
                GEO_METADATA_KEY => match serde_json::from_str::<GeoMeta>(value) {
                    Ok(m) => geo_meta = Some(m),
                    Err(e) => errors.push(format!("`geo` metadata is not valid JSON: {e}")),
                },
                COGP_METADATA_KEY => match serde_json::from_str::<CogpMeta>(value) {
                    Ok(m) => cogp_meta = Some(m),
                    Err(e) => errors.push(format!("`cogp` metadata is not valid JSON: {e}")),
                },
                _ => {}
            }
        }
    }

    // §5.1 GeoParquet compatibility
    let geo = match geo_meta {
        Some(g) => g,
        None => {
            errors.push("missing `geo` key-value metadata (not a GeoParquet file)".into());
            print_report(path, &errors, &warnings);
            bail!("validation failed");
        }
    };
    if !geo.version.starts_with("1.") {
        warnings.push(format!(
            "GeoParquet version is `{}`; COGP {COGP_VERSION} targets 1.1.x",
            geo.version
        ));
    }

    let primary = geo.primary_column.clone();
    let primary_col = match geo.columns.get(&primary) {
        Some(c) => c.clone(),
        None => {
            errors.push(format!(
                "`geo.columns` is missing primary_column `{primary}`"
            ));
            print_report(path, &errors, &warnings);
            bail!("validation failed");
        }
    };
    if geometry_family(&primary_col.geometry_types).is_none() {
        errors.push(format!(
            "`geo.columns[{primary}].geometry_types` must declare exactly one Point, Line, or Polygon family"
        ));
    }

    let covering = match primary_col.covering.as_ref() {
        Some(c) => c,
        None => {
            errors.push(format!(
                "`geo.columns[{primary}].covering` is required by COGP §5.1"
            ));
            print_report(path, &errors, &warnings);
            bail!("validation failed");
        }
    };

    let bbox_paths = [
        ("xmin", &covering.bbox.xmin),
        ("ymin", &covering.bbox.ymin),
        ("xmax", &covering.bbox.xmax),
        ("ymax", &covering.bbox.ymax),
    ];

    // §5.3 cogp metadata
    let cogp = match cogp_meta {
        Some(c) => c,
        None => {
            errors.push("missing `cogp` key-value metadata".into());
            print_report(path, &errors, &warnings);
            bail!("validation failed");
        }
    };

    let major: u32 = cogp
        .version
        .split('.')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if major != 0 {
        errors.push(format!(
            "unsupported cogp major version `{}`; this validator implements 0.x",
            cogp.version
        ));
    }
    if cogp.levels.is_empty() {
        errors.push("`cogp.levels` must be non-empty".into());
    }

    let num_rgs = metadata.num_row_groups();
    if num_rgs == 0 {
        errors.push("file has zero row groups".into());
    }

    let mut prev_rge: Option<i64> = None;
    let mut prev_resolution: Option<f64> = None;
    let mut geometry_boundaries: HashMap<&str, i64> = HashMap::new();
    for (i, level) in cogp.levels.iter().enumerate() {
        if level.row_group_end < 0 || (level.row_group_end as usize) >= num_rgs {
            errors.push(format!(
                "levels[{i}].row_group_end={} out of range [0, {})",
                level.row_group_end, num_rgs
            ));
        }
        if let Some(p) = prev_rge {
            if level.row_group_end <= p {
                errors.push(format!(
                    "levels[{i}].row_group_end={} must be strictly greater than previous ({})",
                    level.row_group_end, p
                ));
            }
        }
        prev_rge = Some(level.row_group_end);
        // partial_cmp so NaN values also fall into the error branch.
        if level.resolution_meters.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
            errors.push(format!(
                "levels[{i}].resolution_meters={} must be positive",
                level.resolution_meters
            ));
        }
        if let Some(previous) = prev_resolution {
            if level.resolution_meters.partial_cmp(&previous) != Some(std::cmp::Ordering::Less) {
                errors.push(format!(
                    "levels[{i}].resolution_meters={} must be strictly less than previous ({previous})",
                    level.resolution_meters
                ));
            }
        }
        prev_resolution = Some(level.resolution_meters);
        if level.geometry_column.is_empty() {
            errors.push(format!(
                "levels[{i}].geometry_column must be a non-empty string"
            ));
        } else {
            geometry_boundaries
                .entry(&level.geometry_column)
                .and_modify(|boundary| *boundary = (*boundary).max(level.row_group_end))
                .or_insert(level.row_group_end);
        }
    }
    if let Some(last) = cogp.levels.last() {
        if num_rgs > 0 && last.row_group_end != (num_rgs as i64) - 1 {
            errors.push(format!(
                "final levels[].row_group_end={} must equal num_row_groups-1={}",
                last.row_group_end,
                num_rgs - 1
            ));
        }
    }

    let parquet_schema = metadata.file_metadata().schema_descr();
    for (geometry_column, boundary) in geometry_boundaries {
        match geo.columns.get(geometry_column) {
            Some(column) if column.encoding == "WKB" => {}
            Some(column) => errors.push(format!(
                "level geometry column `{geometry_column}` must have GeoParquet WKB encoding, got `{}`",
                column.encoding
            )),
            None => errors.push(format!(
                "level geometry column `{geometry_column}` is missing from `geo.columns`"
            )),
        }

        let parquet_column = (0..parquet_schema.num_columns()).find(|column_index| {
            parquet_schema.column(*column_index).path().string() == geometry_column
        });
        let Some(parquet_column) = parquet_column else {
            errors.push(format!(
                "level geometry column `{geometry_column}` is missing from the Parquet schema"
            ));
            continue;
        };
        if geometry_column != primary
            && !parquet_schema
                .column(parquet_column)
                .self_type()
                .is_optional()
        {
            errors.push(format!(
                "non-primary level geometry column `{geometry_column}` must be nullable in the Parquet schema"
            ));
        }

        if geometry_column == primary {
            continue;
        }
        for row_group_index in 0..num_rgs {
            let row_group = metadata.row_group(row_group_index);
            let expected_nulls = if (row_group_index as i64) <= boundary {
                0
            } else {
                row_group.num_rows() as u64
            };
            let actual_nulls = row_group
                .column(parquet_column)
                .statistics()
                .and_then(Statistics::null_count_opt);
            if let Some(actual_nulls) = actual_nulls {
                if actual_nulls != expected_nulls {
                    errors.push(format!(
                        "row group {row_group_index} level geometry column `{geometry_column}` has {actual_nulls} null(s), expected {expected_nulls}"
                    ));
                }
            } else {
                warnings.push(format!(
                    "row group {row_group_index} level geometry column `{geometry_column}` has no null-count statistics; sparse boundary was not verified"
                ));
            }
        }
    }

    // §5.1 cont: bbox covering columns must have row group min/max stats.
    // Locate the column indexes for each bbox sub-field.
    let schema = file_meta.schema_descr();
    for (name, path_parts) in &bbox_paths {
        let dotted = path_parts.join(".");
        let col_idx = (0..schema.num_columns()).find(|i| {
            let path = schema.column(*i).path().string();
            path == dotted
        });
        match col_idx {
            None => errors.push(format!(
                "covering bbox column `{name}` -> `{dotted}` not found in file schema"
            )),
            Some(idx) => {
                for rg_i in 0..num_rgs {
                    let rg = metadata.row_group(rg_i);
                    let col = rg.column(idx);
                    match col.statistics() {
                        Some(stats) => {
                            let has_min_max = match stats {
                                Statistics::Boolean(s) => {
                                    s.min_bytes_opt().is_some() && s.max_bytes_opt().is_some()
                                }
                                Statistics::Int32(s) => {
                                    s.min_bytes_opt().is_some() && s.max_bytes_opt().is_some()
                                }
                                Statistics::Int64(s) => {
                                    s.min_bytes_opt().is_some() && s.max_bytes_opt().is_some()
                                }
                                Statistics::Int96(s) => {
                                    s.min_bytes_opt().is_some() && s.max_bytes_opt().is_some()
                                }
                                Statistics::Float(s) => {
                                    s.min_bytes_opt().is_some() && s.max_bytes_opt().is_some()
                                }
                                Statistics::Double(s) => {
                                    s.min_bytes_opt().is_some() && s.max_bytes_opt().is_some()
                                }
                                Statistics::ByteArray(s) => {
                                    s.min_bytes_opt().is_some() && s.max_bytes_opt().is_some()
                                }
                                Statistics::FixedLenByteArray(s) => {
                                    s.min_bytes_opt().is_some() && s.max_bytes_opt().is_some()
                                }
                            };
                            if !has_min_max {
                                errors.push(format!(
                                    "row group {rg_i} column `{dotted}` has no min/max stats"
                                ));
                            }
                        }
                        None => errors.push(format!(
                            "row group {rg_i} column `{dotted}` has no statistics"
                        )),
                    }
                }
            }
        }
    }

    print_report(path, &errors, &warnings);
    if !errors.is_empty() {
        bail!("validation failed: {} error(s)", errors.len());
    }
    Ok(())
}

fn print_report(path: &Path, errors: &[String], warnings: &[String]) {
    if errors.is_empty() {
        println!("OK: {} conforms to COGP {COGP_VERSION}", path.display());
    } else {
        println!("FAIL: {} ({} error(s))", path.display(), errors.len());
    }
    for w in warnings {
        println!("  warning: {w}");
    }
    for e in errors {
        println!("  error:   {e}");
    }
}
