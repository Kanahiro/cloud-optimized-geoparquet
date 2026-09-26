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
    geometry_family, GeoMeta, GeometryFamily, LodMeta, OverviewsMeta, GEO_METADATA_KEY,
};

/// Outcome of validating one file.
#[derive(Debug, Default)]
pub struct Report {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    /// Encoding of declared overviews, if any.
    pub overview_encoding: Option<String>,
    /// Whether the overview representation was checked. Unsupported encodings
    /// leave it unchecked; level metadata and the column reference are still validated.
    pub overviews_validated: bool,
}

impl Report {
    pub fn is_valid(&self) -> bool {
        self.errors.is_empty()
    }
}

/// Validate a file and print a report. Fails when the file is not a valid COGP file.
pub fn run(path: &Path) -> Result<()> {
    let report = check(path)?;
    print_report(path, &report);
    if !report.is_valid() {
        bail!("validation failed: {} error(s)", report.errors.len());
    }
    Ok(())
}

/// Validate a file without printing. `Err` is reserved for I/O and Parquet failures.
pub fn check(path: &Path) -> Result<Report> {
    let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let reader = SerializedFileReader::new(file)?;
    let metadata = reader.metadata();
    let file_meta = metadata.file_metadata();
    let kv = file_meta.key_value_metadata();

    let mut report = Report::default();
    let errors = &mut report.errors;
    let warnings = &mut report.warnings;

    let geo_json = kv
        .and_then(|kv| kv.iter().find(|entry| entry.key == GEO_METADATA_KEY))
        .and_then(|entry| entry.value.as_deref());
    let Some(geo_json) = geo_json else {
        errors.push("missing `geo` key-value metadata (not a GeoParquet file)".into());
        return Ok(report);
    };
    let raw: serde_json::Value = match serde_json::from_str(geo_json) {
        Ok(value) => value,
        Err(e) => {
            errors.push(format!("`geo` metadata is not valid JSON: {e}"));
            return Ok(report);
        }
    };
    let geo: GeoMeta = match serde_json::from_value(raw.clone()) {
        Ok(geo) => geo,
        Err(e) => {
            errors.push(format!("invalid `geo` metadata: {e}"));
            return Ok(report);
        }
    };
    // Readers tolerate these omissions; GeoParquet requires them.
    if !raw["version"].is_string() {
        errors.push("`geo.version` is required".into());
    }
    for name in geo.columns.keys() {
        let column = &raw["columns"][name];
        if !column["encoding"].is_string() {
            errors.push(format!("`geo.columns.{name}.encoding` is required"));
        }
        if !column["geometry_types"].is_array() {
            errors.push(format!("`geo.columns.{name}.geometry_types` is required"));
        }
    }

    let primary = geo.primary_column.clone();
    let Some(primary_col) = geo.columns.get(&primary).cloned() else {
        errors.push(format!(
            "`geo.columns` is missing primary_column `{primary}`"
        ));
        return Ok(report);
    };
    let num_rgs = metadata.num_row_groups();
    match &geo.lod {
        Some(lod) => {
            if let Err(e) = lod.validate(num_rgs) {
                errors.push(e.to_string());
            }
            if file_meta.num_rows() == 0 {
                errors.push("empty files must omit geo.lod".into());
            }
        }
        None if file_meta.num_rows() == 0 => {}
        None => errors.push("missing geo.lod metadata (required for COGP)".into()),
    }
    let bbox_paths = primary_col
        .covering
        .as_ref()
        .map(|covering| {
            vec![
                ("xmin", &covering.bbox.xmin),
                ("ymin", &covering.bbox.ymin),
                ("xmax", &covering.bbox.xmax),
                ("ymax", &covering.bbox.ymax),
            ]
        })
        .unwrap_or_default();

    if let Some(overviews) = geo.lod.as_ref().and_then(|lod| lod.overviews.as_ref()) {
        report.overview_encoding = Some(overviews.encoding.clone());
        report.overviews_validated = overviews.is_supported();
        if overviews.column == primary {
            errors.push("overview column must differ from primary geometry".into());
        }
        let root = file_meta.schema_descr().root_schema();
        if !root
            .get_fields()
            .iter()
            .any(|field| field.name() == overviews.column)
        {
            errors.push(format!(
                "declared overview column `{}` is missing",
                overviews.column
            ));
        }
        if overviews.is_supported() {
            if !matches!(
                geometry_family(&primary_col.geometry_types),
                Some(GeometryFamily::Line | GeometryFamily::Polygon)
            ) {
                errors.push("overviews require one Line or Polygon geometry family".into());
            }
            for lod in overviews.lods.values() {
                if let Ok(quantization) = lod.quantization() {
                    if geometry_family(&[quantization.geometry_type])
                        != geometry_family(&primary_col.geometry_types)
                    {
                        errors.push(
                            "overview geometry_type must match primary geometry family".into(),
                        );
                    }
                }
            }
            match parquet_to_arrow_schema(metadata.file_metadata().schema_descr(), kv) {
                Ok(schema) => validate_overviews_schema(schema.fields(), overviews, errors),
                Err(error) => errors.push(format!("cannot decode Arrow schema: {error}")),
            }
            validate_standard_lists(file_meta.schema_descr(), &overviews.column, errors);
        } else {
            warnings.push(format!(
                "overview encoding `{}` is not supported by this validator; its representation was not validated",
                overviews.encoding
            ));
        }
    }
    // Missing statistics reduce pruning but do not invalidate the layout.
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
                                warnings.push(format!(
                                    "row group {rg_i} column `{dotted}` has no min/max stats"
                                ));
                            }
                        }
                        None => warnings.push(format!(
                            "row group {rg_i} column `{dotted}` has no statistics"
                        )),
                    }
                }
            }
        }
    }

    if let Some(lod) = geo.lod.as_ref().filter(|lod| {
        errors.is_empty()
            && lod
                .overviews
                .as_ref()
                .is_some_and(OverviewsMeta::is_supported)
    }) {
        if let Err(error) = validate_lod_coverage(
            path,
            lod,
            geometry_family(&primary_col.geometry_types).unwrap(),
        ) {
            errors.push(format!("{error:#}"));
        }
    }
    Ok(report)
}

/// Validate every overview coordinate and part without reading primary WKB pages.
fn validate_lod_coverage(path: &Path, lod_meta: &LodMeta, family: GeometryFamily) -> Result<()> {
    let overviews = lod_meta.overviews.as_ref().unwrap();
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
                parts
                    .first()
                    .is_some_and(|name| name == overviews.column.as_str())
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
                .column_by_name(overviews.column.as_str())
                .and_then(|array| array.as_any().downcast_ref::<StructArray>())
                .context("missing overviews while checking LoD coverage")?;
            for (lod, lod_metadata) in &overviews.lods {
                let boundary = lod_meta
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
                let quantization = lod_metadata.quantization()?;
                let kind = match quantization.geometry_type.as_str() {
                    "LineString" => 2,
                    "Polygon" => 3,
                    "MultiLineString" => 5,
                    "MultiPolygon" => 6,
                    other => bail!("overview `{lod}` has invalid geometry_type `{other}`"),
                };
                for row in 0..batch.num_rows() {
                    anyhow::ensure!(!root.is_null(row), "null overview root");
                    if values.is_null(row) {
                        continue;
                    }
                    crate::overview_validation::validate_value(
                        values.as_ref(),
                        row,
                        kind,
                        &quantization,
                        family,
                    )
                    .with_context(|| format!("row group {group}, row {row}, LoD {lod}"))?;
                }
            }
        }
    }
    Ok(())
}

/// Check the physical `quantized_geoarrow` schema of the declared overview column.
pub(crate) fn validate_overviews_schema(
    fields: &Fields,
    overviews: &OverviewsMeta,
    errors: &mut Vec<String>,
) {
    let column = overviews.column.as_str();
    let Some(root) = fields.iter().find(|field| field.name() == column) else {
        errors.push(format!("declared overview column `{column}` is missing"));
        return;
    };
    if root.is_nullable() {
        errors.push(format!("overview column `{column}` must be required"));
    }
    let DataType::Struct(children) = root.data_type() else {
        errors.push(format!("overview column `{column}` must be a struct"));
        return;
    };
    if let Some(name) = geoarrow_extension(root) {
        errors.push(format!(
            "overview column `{column}` must not use GeoArrow extension type `{name}`"
        ));
    }
    for child in children {
        if !overviews.lods.contains_key(child.name()) {
            errors.push(format!(
                "`{column}.{}` has no geo.lod.overviews.lods entry",
                child.name()
            ));
        }
    }
    for (name, lod) in &overviews.lods {
        let Some((_, field)) = children.find(name) else {
            errors.push(format!(
                "geo.lod.overviews.lods.{name} has no `{column}.{name}` field"
            ));
            continue;
        };
        let Some(depth) = lod.quantization().ok().and_then(|q| q.list_depth()) else {
            continue;
        };
        let mut data_type = field.data_type();
        let mut valid = field.is_nullable();
        for _ in 0..depth {
            if let DataType::List(element) = data_type {
                valid &= !element.is_nullable();
                data_type = element.data_type();
            } else {
                valid = false;
                break;
            }
        }
        valid &= matches!(data_type, DataType::Struct(axes)
            if axes.len() == 2 && ["x", "y"].iter().zip(axes.iter()).all(|(name, axis)|
                axis.name() == name && axis.data_type() == &DataType::Int32 && !axis.is_nullable()));
        if !valid {
            errors.push(format!(
                "`{column}.{name}` must be a nullable {depth}-level list of non-null struct<x: int32, y: int32>"
            ));
        }
    }
}

/// Overview lists must use the standard three-level Parquet LIST representation;
/// the Arrow schema alone also accepts non-standard two-level lists.
pub(crate) fn validate_standard_lists(
    schema: &parquet::schema::types::SchemaDescriptor,
    column: &str,
    errors: &mut Vec<String>,
) {
    use parquet::basic::{ConvertedType, LogicalType, Repetition};
    use parquet::schema::types::Type;
    fn walk(node: &Type, path: &str, errors: &mut Vec<String>) {
        let Type::GroupType { fields, .. } = node else {
            return;
        };
        let info = node.get_basic_info();
        let list = info.converted_type() == ConvertedType::LIST
            || matches!(info.logical_type(), Some(LogicalType::List));
        for child in fields {
            let child_path = format!("{path}.{}", child.name());
            let repeated = child.get_basic_info().has_repetition()
                && child.get_basic_info().repetition() == Repetition::REPEATED;
            if list {
                let standard = fields.len() == 1
                    && repeated
                    && matches!(child.as_ref(), Type::GroupType { fields, .. } if fields.len() == 1);
                if !standard {
                    errors.push(format!(
                        "`{path}` must use the standard Parquet LIST representation"
                    ));
                    return;
                }
                if let Type::GroupType { fields, .. } = child.as_ref() {
                    walk(
                        &fields[0],
                        &format!("{child_path}.{}", fields[0].name()),
                        errors,
                    );
                }
            } else if repeated {
                errors.push(format!(
                    "`{child_path}` must use the standard Parquet LIST representation"
                ));
            } else {
                walk(child, &child_path, errors);
            }
        }
    }
    if let Some(root) = schema
        .root_schema()
        .get_fields()
        .iter()
        .find(|field| field.name() == column)
    {
        walk(root, column, errors);
    }
}

/// Integer overview arrays must not be labelled as standard GeoArrow types.
fn geoarrow_extension(field: &Field) -> Option<String> {
    if let Some(name) = field
        .metadata()
        .get("ARROW:extension:name")
        .filter(|name| name.starts_with("geoarrow."))
    {
        return Some(name.clone());
    }
    match field.data_type() {
        DataType::Struct(children) => children.iter().find_map(|child| geoarrow_extension(child)),
        DataType::List(element) => geoarrow_extension(element),
        _ => None,
    }
}

fn print_report(path: &Path, report: &Report) {
    if !report.is_valid() {
        println!(
            "FAIL: {} ({} error(s))",
            path.display(),
            report.errors.len()
        );
    } else {
        let overviews = match (&report.overview_encoding, report.overviews_validated) {
            (None, _) => String::new(),
            (Some(_), true) => ", including overviews".into(),
            (Some(encoding), false) => format!("; overviews (`{encoding}`) were not validated"),
        };
        println!(
            "OK: {} passed metadata and layout checks{overviews}",
            path.display()
        );
    }
    for w in &report.warnings {
        println!("  warning: {w}");
    }
    for e in &report.errors {
        println!("  error:   {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;

    fn overviews(geometry_type: &str) -> OverviewsMeta {
        serde_json::from_value(serde_json::json!({
            "column": "render",
            "encoding": "quantized_geoarrow",
            "lods": {"l0": {"level_indices": [0], "geometry_type": geometry_type,
                "scale": [1, 1], "offset": [0, 0]}}
        }))
        .unwrap()
    }

    fn line_field(coordinate: Field) -> Fields {
        let coordinates = DataType::List(Arc::new(Field::new(
            "element",
            DataType::Struct(Fields::from(vec![
                coordinate,
                Field::new("y", DataType::Int32, false),
            ])),
            false,
        )));
        Fields::from(vec![Field::new(
            "render",
            DataType::Struct(Fields::from(vec![Field::new("l0", coordinates, true)])),
            false,
        )])
    }

    #[test]
    fn geoarrow_schema_requires_int32_xy_and_rejects_extension_names() {
        let mut errors = Vec::new();
        let valid = line_field(Field::new("x", DataType::Int32, false));
        validate_overviews_schema(&valid, &overviews("LineString"), &mut errors);
        assert!(errors.is_empty(), "{errors:?}");

        validate_overviews_schema(&valid, &overviews("MultiLineString"), &mut errors);
        assert!(
            errors.iter().any(|e| e.contains("2-level list")),
            "{errors:?}"
        );

        errors.clear();
        let unsigned = line_field(Field::new("x", DataType::UInt32, false));
        validate_overviews_schema(&unsigned, &overviews("LineString"), &mut errors);
        assert_eq!(errors.len(), 1, "{errors:?}");

        errors.clear();
        let labelled = line_field(Field::new("x", DataType::Int32, false).with_metadata(
            HashMap::from([(
                "ARROW:extension:name".to_string(),
                "geoarrow.point".to_string(),
            )]),
        ));
        validate_overviews_schema(&labelled, &overviews("LineString"), &mut errors);
        assert!(
            errors.iter().any(|e| e.contains("geoarrow.point")),
            "{errors:?}"
        );
    }
}
