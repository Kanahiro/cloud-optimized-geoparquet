use anyhow::{bail, Context, Result};
use arrow::array::{Array, StructArray};
use arrow::datatypes::{DataType, Field, Fields};
use parquet::arrow::arrow_reader::{ArrowReaderMetadata, ParquetRecordBatchReaderBuilder};
use parquet::arrow::parquet_to_arrow_schema;
use parquet::arrow::ProjectionMask;
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::file::statistics::Statistics;
use std::fs::File;
use std::path::Path;

use crate::meta::{
    geometry_family, CogpMeta, GeoMeta, GeometryFamily, COGP_METADATA_KEY, COGP_VERSION,
    GEO_METADATA_KEY, OVERVIEWS_COLUMN,
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
    let geometry_family = geometry_family(&primary_col.geometry_types);
    if geometry_family.is_none() {
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

    let num_rgs = metadata.num_row_groups();
    if let Err(error) = cogp.validate(num_rgs) {
        errors.push(error.to_string());
    }
    match geometry_family {
        Some(GeometryFamily::Point) if cogp.overviews.is_some() => {
            errors.push("Point-family files must not declare overviews".into())
        }
        Some(GeometryFamily::Line | GeometryFamily::Polygon) if cogp.overviews.is_none() => {
            warnings
                .push("Line/Polygon files should declare overviews for efficient rendering".into())
        }
        _ => {}
    }

    let parquet_schema = metadata.file_metadata().schema_descr();
    match parquet_to_arrow_schema(parquet_schema, kv) {
        Ok(schema) => match geometry_family {
            Some(GeometryFamily::Point) => {
                if schema.field_with_name(OVERVIEWS_COLUMN).is_ok() {
                    errors.push("Point-family files must not contain an `overviews` column".into());
                }
            }
            Some(GeometryFamily::Line | GeometryFamily::Polygon) => {
                if let Some(overviews) = &cogp.overviews {
                    validate_overviews_schema(schema.fields(), overviews, &mut errors);
                } else if schema.field_with_name(OVERVIEWS_COLUMN).is_ok() {
                    errors.push(
                        "files without overviews metadata must not contain an `overviews` column"
                            .into(),
                    );
                }
            }
            None => {}
        },
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

    if errors.is_empty() && cogp.overviews.is_some() {
        if let Err(error) = validate_lod_coverage(path, &cogp) {
            errors.push(format!("{error:#}"));
        }
    }
    print_report(path, &errors, &warnings);
    if !errors.is_empty() {
        bail!("validation failed: {} error(s)", errors.len());
    }
    Ok(())
}

/// One required child preserves its optional LoD parent's definition level.
/// Read the small topology leaf, not every coordinate or primary WKB page.
fn validate_lod_coverage(path: &Path, cogp: &CogpMeta) -> Result<()> {
    let file = File::open(path)?;
    let metadata = ArrowReaderMetadata::load(&file, Default::default())?;
    let schema = metadata.metadata().file_metadata().schema_descr();
    let projection = ProjectionMask::leaves(
        schema,
        schema
            .columns()
            .iter()
            .enumerate()
            .filter(|(_, column)| {
                let parts = column.path().parts();
                parts.first().is_some_and(|name| name == OVERVIEWS_COLUMN)
                    && parts.get(2).is_some_and(|name| name == "part_ends")
            })
            .map(|(index, _)| index),
    );
    for group in 0..metadata.metadata().num_row_groups() {
        let batches =
            ParquetRecordBatchReaderBuilder::new_with_metadata(file.try_clone()?, metadata.clone())
                .with_projection(projection.clone())
                .with_row_groups(vec![group])
                .build()?;
        for batch in batches {
            let batch = batch?;
            let root = batch
                .column_by_name(OVERVIEWS_COLUMN)
                .and_then(|array| array.as_any().downcast_ref::<StructArray>())
                .context("missing overviews while checking LoD coverage")?;
            for lod in cogp.overviews.as_ref().unwrap().lods.keys() {
                let boundary = cogp
                    .lod_row_group_end(lod)
                    .context("validated overview LoD is not referenced by a level")?;
                let values = root
                    .column_by_name(lod)
                    .context("missing LoD in coverage projection")?;
                let expected_nulls = if group as i64 <= boundary {
                    0
                } else {
                    batch.num_rows()
                };
                if values.null_count() != expected_nulls {
                    bail!("row group {group} overview `{lod}` must be {} (effective boundary {boundary})",
                        if expected_nulls == 0 { "non-null" } else { "null" });
                }
            }
        }
    }
    Ok(())
}

fn validate_overviews_schema(
    fields: &Fields,
    overviews: &crate::meta::OverviewsMeta,
    errors: &mut Vec<String>,
) {
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
        if !overviews.lods.contains_key(child.name()) {
            errors.push(format!(
                "overview child `{}` has no cogp.overviews.lods metadata",
                child.name()
            ));
        }
        validate_lod_field(child, errors);
    }
    for lod in overviews.lods.keys() {
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
    let expected = ["coordinates", "part_ends", "polygon_ends"];
    if children.len() != expected.len() {
        errors.push(format!(
            "`overviews.{}` must contain exactly coordinates, part_ends, polygon_ends",
            field.name()
        ));
    }
    let coordinates_valid = children.find("coordinates").is_some_and(|(_, child)| {
        !child.is_nullable()
            && matches!(child.data_type(), DataType::List(element)
                if !element.is_nullable()
                    && matches!(element.data_type(), DataType::Struct(axes)
                        if axes.len() == 2
                            && ["x", "y"].iter().all(|name| axes.find(name).is_some_and(|(_, axis)|
                                !axis.is_nullable() && axis.data_type() == &DataType::Int32)))
            )
    });
    if !coordinates_valid {
        errors.push(format!(
            "`overviews.{}.coordinates` must be required list<required struct<x: required int32, y: required int32>>",
            field.name()
        ));
    }
    for name in ["part_ends", "polygon_ends"] {
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
        println!(
            "OK: {} passed metadata, schema and LoD coverage checks",
            path.display()
        );
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn integer_list() -> DataType {
        DataType::List(Arc::new(Field::new("element", DataType::Int32, false)))
    }

    #[test]
    fn lod_schema_requires_one_coordinate_list_with_struct_axes() {
        let old_layout = Field::new(
            "l0",
            DataType::Struct(Fields::from(vec![
                Field::new("x", integer_list(), false),
                Field::new("y", integer_list(), false),
                Field::new("part_ends", integer_list(), false),
                Field::new("polygon_ends", integer_list(), false),
            ])),
            true,
        );
        let mut errors = Vec::new();
        validate_lod_field(&old_layout, &mut errors);
        assert!(errors.iter().any(|error| error.contains("coordinates")));

        let coordinate = DataType::Struct(Fields::from(vec![
            Field::new("x", DataType::Int32, false),
            Field::new("y", DataType::Int32, false),
        ]));
        let current_layout = Field::new(
            "l0",
            DataType::Struct(Fields::from(vec![
                Field::new(
                    "coordinates",
                    DataType::List(Arc::new(Field::new("element", coordinate, false))),
                    false,
                ),
                Field::new("part_ends", integer_list(), false),
                Field::new("polygon_ends", integer_list(), false),
            ])),
            true,
        );
        errors.clear();
        validate_lod_field(&current_layout, &mut errors);
        assert!(errors.is_empty(), "{errors:?}");
    }
}
