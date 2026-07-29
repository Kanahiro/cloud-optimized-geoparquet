use anyhow::{bail, Context, Result};
use parquet::basic::{Repetition, Type as PhysicalType};
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::file::statistics::Statistics;
use std::fs::File;
use std::path::Path;

use crate::meta::lod_level_index;

use crate::meta::{CogpMeta, GeoMeta, COGP_METADATA_KEY, GEO_METADATA_KEY};

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
            "GeoParquet version is `{}`; COGP v1.0 targets 1.1.x",
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
    if major != 1 {
        errors.push(format!(
            "unsupported cogp major version `{}`; this validator implements 1.x",
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
        // partial_cmp so NaN resolution values also fall into the error branch.
        if level.resolution.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
            errors.push(format!(
                "levels[{i}].resolution={} must be positive",
                level.resolution
            ));
        }
        if let Some(p) = prev_resolution {
            if level.resolution.partial_cmp(&p) != Some(std::cmp::Ordering::Less) {
                errors.push(format!(
                    "levels[{i}].resolution={} must be strictly less than previous ({})",
                    level.resolution, p
                ));
            }
        }
        prev_resolution = Some(level.resolution);
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

    // §5.1 cont: bbox covering columns must have row group min/max stats.
    // Locate the column indexes for each bbox sub-field.
    let schema = file_meta.schema_descr();
    if let Some(lods_column) = cogp.lods_column.as_deref() {
        if lods_column.is_empty() {
            errors.push("`cogp.lods_column` must not be empty".into());
        } else if lods_column == primary {
            errors.push("`cogp.lods_column` must not be the primary geometry column".into());
        } else if geo.columns.contains_key(lods_column) {
            errors.push(format!(
                "lods column `{lods_column}` must not be listed in `geo.columns`"
            ));
        }
        let lods = schema
            .root_schema()
            .get_fields()
            .iter()
            .find(|field| field.name() == lods_column);
        match lods {
            None => errors.push(format!(
                "lods column `{lods_column}` not found in file schema"
            )),
            Some(lods) if lods.is_primitive() => errors.push(format!(
                "lods column `{lods_column}` must be a required struct"
            )),
            Some(lods) => {
                let repetition = lods.get_basic_info().repetition();
                if repetition != Repetition::REQUIRED {
                    errors.push(format!("lods column `{lods_column}` must be required"));
                }
                let children = lods.get_fields();
                if children.is_empty() {
                    errors.push(format!(
                        "lods column `{lods_column}` must have at least one child"
                    ));
                }
                for child in children {
                    let Some(level_index) = lod_level_index(child.name()) else {
                        errors.push(format!(
                            "lods child `{}` must be named `level_<i>` using canonical decimal notation",
                            child.name()
                        ));
                        continue;
                    };
                    if level_index >= cogp.levels.len() {
                        errors.push(format!(
                            "lods child `{}` refers to level {}, but only {} level(s) exist",
                            child.name(),
                            level_index,
                            cogp.levels.len()
                        ));
                    }
                    if !child.is_primitive()
                        || child.get_physical_type() != PhysicalType::BYTE_ARRAY
                    {
                        errors.push(format!(
                            "lods child `{}` must be a BYTE_ARRAY",
                            child.name()
                        ));
                    }
                    if child.get_basic_info().repetition() != Repetition::OPTIONAL {
                        errors.push(format!("lods child `{}` must be optional", child.name()));
                    }
                }
            }
        }
    }
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
        println!("OK: {} conforms to COGP v1.0", path.display());
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
