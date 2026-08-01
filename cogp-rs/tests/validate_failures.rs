//! Failure-mode coverage for `cogp::validate::run`. Each test builds a tiny
//! Parquet file by hand with carefully-broken metadata, then asserts the
//! validator rejects it with a message that names the broken rule.

use std::collections::BTreeMap;
use std::fs::File;
use std::path::PathBuf;
use std::sync::Arc;

use arrow::array::{ArrayRef, Float64Array, RecordBatch, StructArray};
use arrow::datatypes::{DataType, Field, Fields, Schema};
use cogp::meta::{
    BboxCovering, CogpMeta, Covering, GeoColumn, GeoMeta, Level, COGP_METADATA_KEY, COGP_VERSION,
    GEOPARQUET_VERSION, GEO_METADATA_KEY,
};
use parquet::arrow::ArrowWriter;
use parquet::file::metadata::KeyValue;
use parquet::file::properties::WriterProperties;

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!(
            "cogp-validate-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn bbox_struct_fields() -> Fields {
    Fields::from(vec![
        Field::new("xmin", DataType::Float64, false),
        Field::new("ymin", DataType::Float64, false),
        Field::new("xmax", DataType::Float64, false),
        Field::new("ymax", DataType::Float64, false),
    ])
}

fn standard_geo() -> GeoMeta {
    let mut cols = BTreeMap::new();
    cols.insert(
        "geometry".to_string(),
        GeoColumn {
            encoding: "WKB".into(),
            geometry_types: vec!["Polygon".into()],
            covering: Some(Covering {
                bbox: BboxCovering {
                    xmin: vec!["bbox".into(), "xmin".into()],
                    ymin: vec!["bbox".into(), "ymin".into()],
                    xmax: vec!["bbox".into(), "xmax".into()],
                    ymax: vec!["bbox".into(), "ymax".into()],
                },
            }),
            bbox: None,
            crs: None,
        },
    );
    GeoMeta {
        version: GEOPARQUET_VERSION.into(),
        primary_column: "geometry".into(),
        columns: cols,
    }
}

/// Write `row_groups` row groups, each with a single row in the bbox struct.
/// All four sub-columns have non-null values so Parquet always emits min/max
/// statistics for them. The KV metadata is whatever the caller passes.
fn write_file(path: &std::path::Path, row_groups: usize, kv: Vec<KeyValue>) {
    let schema = Arc::new(Schema::new(vec![Field::new(
        "bbox",
        DataType::Struct(bbox_struct_fields()),
        false,
    )]));
    let props = WriterProperties::builder()
        .set_max_row_group_size(1) // one row per row group
        .build();
    let file = File::create(path).unwrap();
    let mut writer = ArrowWriter::try_new(file, schema.clone(), Some(props)).unwrap();
    for i in 0..row_groups {
        let i = i as f64;
        let bbox: ArrayRef = Arc::new(
            StructArray::try_new(
                bbox_struct_fields(),
                vec![
                    Arc::new(Float64Array::from(vec![i])),
                    Arc::new(Float64Array::from(vec![i])),
                    Arc::new(Float64Array::from(vec![i + 1.0])),
                    Arc::new(Float64Array::from(vec![i + 1.0])),
                ],
                None,
            )
            .unwrap(),
        );
        let batch = RecordBatch::try_new(schema.clone(), vec![bbox]).unwrap();
        writer.write(&batch).unwrap();
        writer.flush().unwrap();
    }
    for entry in kv {
        writer.append_key_value_metadata(entry);
    }
    writer.close().unwrap();
}

fn kv(geo: Option<GeoMeta>, cogp: Option<CogpMeta>) -> Vec<KeyValue> {
    let mut out = Vec::new();
    if let Some(g) = geo {
        out.push(KeyValue {
            key: GEO_METADATA_KEY.into(),
            value: Some(serde_json::to_string(&g).unwrap()),
        });
    }
    if let Some(c) = cogp {
        out.push(KeyValue {
            key: COGP_METADATA_KEY.into(),
            value: Some(serde_json::to_string(&c).unwrap()),
        });
    }
    out
}

fn assert_validate_fails(path: &std::path::Path, _msg_substring: &str) {
    // The detail goes to stdout via `print_report`; the returned error is the
    // generic "validation failed" sentinel. We assert on it to confirm the
    // call returned an `Err` rather than silently passing.
    let Err(err) = cogp::validate::run(path) else {
        panic!("expected validate to fail for {}", path.display());
    };
    let s = format!("{err:#}");
    assert!(s.contains("validation failed"), "unexpected error: {s}");
}

#[test]
fn validate_happy_path_accepts_well_formed_file() {
    let tmp = TempDir::new("happy");
    let p = tmp.path().join("ok.parquet");
    let cogp = CogpMeta {
        version: COGP_VERSION.into(),
        levels: vec![
            Level { row_group_end: 0, gsd: 1000.0 },
            Level { row_group_end: 2, gsd: 100.0 },
        ],
    };
    write_file(&p, 3, kv(Some(standard_geo()), Some(cogp)));
    cogp::validate::run(&p).unwrap();
}

#[test]
fn validate_rejects_missing_geo() {
    let tmp = TempDir::new("missing-geo");
    let p = tmp.path().join("bad.parquet");
    let cogp = CogpMeta {
        version: COGP_VERSION.into(),
        levels: vec![Level { row_group_end: 0, gsd: 1.0 }],
    };
    write_file(&p, 1, kv(None, Some(cogp)));
    assert_validate_fails(&p, "geo");
}

#[test]
fn validate_rejects_missing_cogp() {
    let tmp = TempDir::new("missing-cogp");
    let p = tmp.path().join("bad.parquet");
    write_file(&p, 1, kv(Some(standard_geo()), None));
    assert_validate_fails(&p, "cogp");
}

#[test]
fn validate_rejects_non_decreasing_gsd() {
    let tmp = TempDir::new("flat-gsd");
    let p = tmp.path().join("bad.parquet");
    let cogp = CogpMeta {
        version: COGP_VERSION.into(),
        levels: vec![
            Level { row_group_end: 0, gsd: 100.0 },
            // equal to previous → must be strictly less
            Level { row_group_end: 1, gsd: 100.0 },
        ],
    };
    write_file(&p, 2, kv(Some(standard_geo()), Some(cogp)));
    assert_validate_fails(&p, "gsd");
}

#[test]
fn validate_rejects_non_increasing_row_group_end() {
    let tmp = TempDir::new("flat-rge");
    let p = tmp.path().join("bad.parquet");
    let cogp = CogpMeta {
        version: COGP_VERSION.into(),
        levels: vec![
            Level { row_group_end: 1, gsd: 100.0 },
            Level { row_group_end: 1, gsd: 10.0 }, // not strictly greater
        ],
    };
    write_file(&p, 2, kv(Some(standard_geo()), Some(cogp)));
    assert_validate_fails(&p, "row_group_end");
}

#[test]
fn validate_rejects_final_row_group_end_mismatch() {
    let tmp = TempDir::new("trailing-rg");
    let p = tmp.path().join("bad.parquet");
    // File has 3 row groups, but levels stop at index 1 → 2 ≠ 3-1.
    let cogp = CogpMeta {
        version: COGP_VERSION.into(),
        levels: vec![
            Level { row_group_end: 0, gsd: 100.0 },
            Level { row_group_end: 1, gsd: 10.0 },
        ],
    };
    write_file(&p, 3, kv(Some(standard_geo()), Some(cogp)));
    assert_validate_fails(&p, "num_row_groups");
}

#[test]
fn validate_rejects_negative_gsd() {
    let tmp = TempDir::new("neg-gsd");
    let p = tmp.path().join("bad.parquet");
    let cogp = CogpMeta {
        version: COGP_VERSION.into(),
        levels: vec![Level { row_group_end: 0, gsd: -1.0 }],
    };
    write_file(&p, 1, kv(Some(standard_geo()), Some(cogp)));
    assert_validate_fails(&p, "positive");
}

#[test]
fn validate_rejects_missing_covering_column_in_schema() {
    let tmp = TempDir::new("bad-covering");
    let p = tmp.path().join("bad.parquet");
    // Point the covering at columns that don't exist in the file schema.
    let mut geo = standard_geo();
    geo.columns.get_mut("geometry").unwrap().covering = Some(Covering {
        bbox: BboxCovering {
            xmin: vec!["nope".into(), "xmin".into()],
            ymin: vec!["nope".into(), "ymin".into()],
            xmax: vec!["nope".into(), "xmax".into()],
            ymax: vec!["nope".into(), "ymax".into()],
        },
    });
    let cogp = CogpMeta {
        version: COGP_VERSION.into(),
        levels: vec![Level { row_group_end: 0, gsd: 1.0 }],
    };
    write_file(&p, 1, kv(Some(geo), Some(cogp)));
    assert_validate_fails(&p, "covering");
}

#[test]
fn validate_rejects_empty_levels() {
    let tmp = TempDir::new("empty-levels");
    let p = tmp.path().join("bad.parquet");
    let cogp = CogpMeta {
        version: COGP_VERSION.into(),
        levels: vec![],
    };
    write_file(&p, 1, kv(Some(standard_geo()), Some(cogp)));
    assert_validate_fails(&p, "non-empty");
}
