use anyhow::{bail, Context, Result};
use arrow::datatypes::{DataType, Field, Fields};
use parquet::arrow::parquet_to_arrow_schema;
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::file::statistics::Statistics;
use std::fs::File;
use std::path::Path;

use crate::meta::{
    geometry_family, CogpMeta, GeoMeta, COGP_METADATA_KEY, COGP_VERSION, GEO_METADATA_KEY,
    OVERVIEWS_COLUMN, OVERVIEWS_ENCODING,
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
    if cogp.overviews.encoding != OVERVIEWS_ENCODING {
        errors.push(format!(
            "cogp.overviews.encoding must be `{OVERVIEWS_ENCODING}`, got `{}`",
            cogp.overviews.encoding
        ));
    }
    if cogp.overviews.lods.is_empty() {
        errors.push("`cogp.overviews.lods` must be non-empty".into());
    }
    for (lod, metadata) in &cogp.overviews.lods {
        if lod.is_empty() {
            errors.push("overview LoD names must be non-empty".into());
        }
        for axis in 0..2 {
            if metadata.scale[axis].partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
                errors.push(format!(
                    "overviews.lods.{lod}.scale[{axis}] must be positive and finite"
                ));
            }
            if !metadata.offset[axis].is_finite() {
                errors.push(format!(
                    "overviews.lods.{lod}.offset[{axis}] must be finite"
                ));
            }
        }
    }
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
        if level.resolution.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
            errors.push(format!(
                "levels[{i}].resolution={} must be positive",
                level.resolution
            ));
        }
        if let Some(previous) = prev_resolution {
            if level.resolution.partial_cmp(&previous) != Some(std::cmp::Ordering::Less) {
                errors.push(format!(
                    "levels[{i}].resolution={} must be strictly less than previous ({previous})",
                    level.resolution
                ));
            }
        }
        prev_resolution = Some(level.resolution);
        if level.lod.is_empty() {
            errors.push(format!("levels[{i}].lod must be a non-empty string"));
        } else if !cogp.overviews.lods.contains_key(&level.lod) {
            errors.push(format!(
                "levels[{i}].lod `{}` is missing from cogp.overviews.lods",
                level.lod
            ));
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
    match parquet_to_arrow_schema(parquet_schema, kv) {
        Ok(schema) => validate_overviews_schema(schema.fields(), &cogp, &mut errors),
        Err(error) => errors.push(format!("cannot decode Arrow schema: {error}")),
    }

    // §5.1 cont: bbox covering columns must have row group min/max stats.
    // Locate the column indexes for each bbox sub-field.
    let schema = file_meta.schema_descr();
    if let Some(primary_idx) =
        (0..schema.num_columns()).find(|index| schema.column(*index).path().string() == primary)
    {
        for rg_i in 0..num_rgs {
            if metadata
                .row_group(rg_i)
                .column(primary_idx)
                .statistics()
                .is_some()
            {
                errors.push(format!(
                    "row group {rg_i} primary WKB column `{primary}` must not have statistics"
                ));
            }
        }
    } else {
        errors.push(format!(
            "primary geometry column `{primary}` not found in file schema"
        ));
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

fn validate_overviews_schema(fields: &Fields, cogp: &CogpMeta, errors: &mut Vec<String>) {
    let Some(root) = fields.iter().find(|field| field.name() == OVERVIEWS_COLUMN) else {
        errors.push(format!("missing required `{OVERVIEWS_COLUMN}` struct"));
        return;
    };
    if root.is_nullable() {
        errors.push(format!("`{OVERVIEWS_COLUMN}` struct must be required"));
    }
    let DataType::Struct(children) = root.data_type() else {
        errors.push(format!("`{OVERVIEWS_COLUMN}` must be a struct"));
        return;
    };
    match children.find("geometry_type") {
        Some((_, field)) if field.data_type() == &DataType::Int8 && !field.is_nullable() => {}
        _ => errors.push("`overviews.geometry_type` must be required int8".into()),
    }

    for child in children
        .iter()
        .filter(|field| field.name() != "geometry_type")
    {
        if !cogp.overviews.lods.contains_key(child.name()) {
            errors.push(format!(
                "overview child `{}` has no cogp.overviews.lods metadata",
                child.name()
            ));
        }
        validate_lod_field(child, errors);
    }
    for lod in cogp.overviews.lods.keys() {
        if children.find(lod).is_none() {
            errors.push(format!(
                "cogp.overviews.lods.{lod} has no physical overview child"
            ));
        }
    }
}

fn validate_lod_field(field: &Field, errors: &mut Vec<String>) {
    if !field.is_nullable() {
        errors.push(format!("`overviews.{}` must be nullable", field.name()));
    }
    let DataType::Struct(children) = field.data_type() else {
        errors.push(format!("`overviews.{}` must be a struct", field.name()));
        return;
    };
    let expected = ["x", "y", "part_ends", "polygon_ends"];
    if children.len() != expected.len() {
        errors.push(format!(
            "`overviews.{}` must contain exactly x, y, part_ends, polygon_ends",
            field.name()
        ));
    }
    for name in expected {
        let valid = children.find(name).is_some_and(|(_, child)| {
            !child.is_nullable()
                && matches!(
                    child.data_type(),
                    DataType::List(element)
                        if element.data_type() == &DataType::Int32 && !element.is_nullable()
                )
        });
        if !valid {
            errors.push(format!(
                "`overviews.{}.{name}` must be required list<required int32>",
                field.name()
            ));
        }
    }
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
