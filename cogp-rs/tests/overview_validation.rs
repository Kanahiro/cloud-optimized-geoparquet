use arrow::array::{Array, ArrayRef, Int32Array, ListArray, RecordBatch, StructArray};
use parquet::{
    arrow::{arrow_reader::ParquetRecordBatchReaderBuilder, ArrowWriter},
    file::metadata::KeyValue,
};
use std::{fs::File, path::PathBuf, sync::Arc};

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn alter(array: &ArrayRef, path: &str) -> ArrayRef {
    if let Some(values) = array.as_any().downcast_ref::<StructArray>() {
        let fields = values.fields().clone();
        let arrays = fields
            .iter()
            .zip(values.columns())
            .map(|(field, value)| {
                if field.name() == path && path == "x" {
                    let old = value.as_any().downcast_ref::<Int32Array>().unwrap();
                    return Arc::new(Int32Array::from_iter_values(
                        (0..old.len()).map(|i| old.value(i) + i32::from(i == 0)),
                    )) as ArrayRef;
                }
                alter(value, path)
            })
            .collect();
        Arc::new(StructArray::new(fields, arrays, values.nulls().cloned()))
    } else if let Some(values) = array.as_any().downcast_ref::<ListArray>() {
        Arc::new(ListArray::new(
            match values.data_type() {
                arrow::datatypes::DataType::List(f) => f.clone(),
                _ => unreachable!(),
            },
            values.offsets().clone(),
            alter(values.values(), path),
            values.nulls().cloned(),
        ))
    } else {
        array.clone()
    }
}

fn fixture(name: &str, change: &str) -> Fixture {
    let source =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../test-data/{name}.parquet"));
    let builder = ParquetRecordBatchReaderBuilder::try_new(File::open(source).unwrap()).unwrap();
    let mut geo: serde_json::Value = serde_json::from_str(
        builder
            .metadata()
            .file_metadata()
            .key_value_metadata()
            .unwrap()
            .iter()
            .find(|kv| kv.key == "geo")
            .unwrap()
            .value
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    match change {
        "family" => {
            geo["columns"]["geometry"]["geometry_types"] = serde_json::json!(["LineString"]);
        }
        "overflow" => {
            for (_, lod) in geo["lod"]["overviews"]["lods"].as_object_mut().unwrap() {
                lod["scale"] = serde_json::json!([f64::MAX, f64::MAX]);
            }
        }
        "future" => {
            geo["lod"]["overviews"]["encoding"] = "future_v3".into();
            for (_, lod) in geo["lod"]["overviews"]["lods"].as_object_mut().unwrap() {
                lod.as_object_mut().unwrap().remove("scale");
                lod.as_object_mut().unwrap().remove("offset");
                lod["geometry_type"] = serde_json::json!({"future":true});
            }
        }
        _ => {}
    }
    let schema = builder.schema().clone();
    let metadata = builder.metadata().clone();
    let path = std::env::temp_dir().join(format!(
        "cogp-overview-{}-{}-{name}-{change}.parquet",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut writer =
        ArrowWriter::try_new(File::create(&path).unwrap(), schema.clone(), None).unwrap();
    let batches: Vec<_> = builder.build().unwrap().map(Result::unwrap).collect();
    let batch = arrow::compute::concat_batches(&schema, &batches).unwrap();
    let arrays = batch.columns().iter().map(|a| alter(a, change)).collect();
    let batch = RecordBatch::try_new(schema, arrays).unwrap();
    let mut offset = 0;
    for group in metadata.row_groups() {
        let n = group.num_rows() as usize;
        writer.write(&batch.slice(offset, n)).unwrap();
        writer.flush().unwrap();
        offset += n;
    }
    writer.append_key_value_metadata(KeyValue::new(
        "geo".into(),
        serde_json::to_string(&geo).unwrap(),
    ));
    writer.close().unwrap();
    Fixture(path)
}

#[test]
fn validator_rejects_broken_overview_values_and_family() {
    for (name, change) in [
        ("quantized-geoarrow-polygon", "x"),
        ("quantized-geoarrow-polygon", "family"),
        ("quantized-geoarrow-polygon", "overflow"),
        ("refinement", "overflow"),
    ] {
        let file = fixture(name, change);
        assert!(
            cogp::validate::run(&file.0).is_err(),
            "accepted {name} {change}"
        );
    }
}

#[test]
fn unknown_encoding_retains_level_selection_and_is_valid_but_unvalidated() {
    let file = fixture("quantized-geoarrow-polygon", "future");
    let reader = cogp::reader::Reader::open(&file.0).unwrap();
    assert_eq!(reader.row_groups_up_to_level(0), 0..1);
    assert_eq!(
        reader
            .sync_batch_reader(File::open(&file.0).unwrap(), &[0])
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .num_rows(),
        1
    );
    assert!(!reader.has_overviews());
    let report = cogp::validate::check(&file.0).unwrap();
    assert!(report.is_valid(), "{:?}", report.errors);
    assert_eq!(report.overview_encoding.as_deref(), Some("future_v3"));
    assert!(!report.overviews_validated);
    cogp::validate::run(&file.0).unwrap();
}
