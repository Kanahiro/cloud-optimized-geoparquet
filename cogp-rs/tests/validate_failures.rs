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
    BboxCovering, Covering, GeoColumn, GeoMeta, Level, LodMeta, GEOPARQUET_VERSION,
    GEO_METADATA_KEY,
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
        lod: None,
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

fn kv(geo: Option<GeoMeta>, lod: Option<LodMeta>) -> Vec<KeyValue> {
    let mut out = Vec::new();
    if let Some(mut g) = geo {
        g.lod = lod;
        out.push(KeyValue {
            key: GEO_METADATA_KEY.into(),
            value: Some(serde_json::to_string(&g).unwrap()),
        });
    }

    out
}

fn assert_validate_fails(path: &std::path::Path, msg_substring: &str) {
    let report = cogp::validate::check(path).unwrap();
    assert!(
        report
            .errors
            .iter()
            .any(|error| error.contains(msg_substring)),
        "expected an error containing `{msg_substring}` for {}: {:?}",
        path.display(),
        report.errors
    );
    assert!(cogp::validate::run(path).is_err());
}

#[test]
fn validate_happy_path_accepts_well_formed_file() {
    let tmp = TempDir::new("happy");
    let p = tmp.path().join("ok.parquet");
    let lod = LodMeta {
        overviews: None,
        levels: vec![
            Level {
                row_group_end: 0,
                resolution: 1000.0,
            },
            Level {
                row_group_end: 2,
                resolution: 100.0,
            },
        ],
    };
    write_file(&p, 3, kv(Some(standard_geo()), Some(lod)));
    cogp::validate::run(&p).unwrap();
}

#[test]
fn validate_rejects_missing_geo() {
    let tmp = TempDir::new("missing-geo");
    let p = tmp.path().join("bad.parquet");
    let lod = LodMeta {
        overviews: None,
        levels: vec![Level {
            row_group_end: 0,
            resolution: 1.0,
        }],
    };
    write_file(&p, 1, kv(None, Some(lod)));
    assert_validate_fails(&p, "geo");
}

#[test]
fn validate_requires_geo_lod() {
    let tmp = TempDir::new("missing-lod");
    let p = tmp.path().join("bad.parquet");
    write_file(&p, 1, kv(Some(standard_geo()), None));
    assert_validate_fails(&p, "geo.lod");
}

#[test]
fn validate_requires_geoparquet_fields_that_readers_tolerate() {
    let tmp = TempDir::new("geoparquet-fields");
    let p = tmp.path().join("bad.parquet");
    let mut geo = serde_json::to_value(standard_geo()).unwrap();
    geo["lod"] = serde_json::json!({"levels": [{"row_group_end": 0, "resolution": 1.0}]});
    geo.as_object_mut().unwrap().remove("version");
    geo["columns"]["geometry"]
        .as_object_mut()
        .unwrap()
        .remove("geometry_types");
    write_file(
        &p,
        1,
        vec![KeyValue {
            key: GEO_METADATA_KEY.into(),
            value: Some(geo.to_string()),
        }],
    );
    assert_validate_fails(&p, "geo.version");
    assert_validate_fails(&p, "geometry_types");
}

#[test]
fn validate_rejects_non_decreasing_resolution() {
    let tmp = TempDir::new("flat-resolution");
    let p = tmp.path().join("bad.parquet");
    let lod = LodMeta {
        overviews: None,
        levels: vec![
            Level {
                row_group_end: 0,
                resolution: 100.0,
            },
            // equal to previous → must be strictly less
            Level {
                row_group_end: 1,
                resolution: 100.0,
            },
        ],
    };
    write_file(&p, 2, kv(Some(standard_geo()), Some(lod)));
    assert_validate_fails(&p, "resolution");
}

#[test]
fn validate_rejects_non_increasing_row_group_end() {
    let tmp = TempDir::new("flat-rge");
    let p = tmp.path().join("bad.parquet");
    let lod = LodMeta {
        overviews: None,
        levels: vec![
            Level {
                row_group_end: 1,
                resolution: 100.0,
            },
            Level {
                row_group_end: 0,
                resolution: 10.0,
            }, // decreasing
        ],
    };
    write_file(&p, 2, kv(Some(standard_geo()), Some(lod)));
    assert_validate_fails(&p, "row_group_end");
}

#[test]
fn validate_rejects_final_row_group_end_mismatch() {
    let tmp = TempDir::new("trailing-rg");
    let p = tmp.path().join("bad.parquet");
    // File has 3 row groups, but levels stop at index 1 → 2 ≠ 3-1.
    let lod = LodMeta {
        overviews: None,
        levels: vec![
            Level {
                row_group_end: 0,
                resolution: 100.0,
            },
            Level {
                row_group_end: 1,
                resolution: 10.0,
            },
        ],
    };
    write_file(&p, 3, kv(Some(standard_geo()), Some(lod)));
    assert_validate_fails(&p, "num_row_groups");
}

#[test]
fn validate_rejects_negative_resolution() {
    let tmp = TempDir::new("neg-resolution");
    let p = tmp.path().join("bad.parquet");
    let lod = LodMeta {
        overviews: None,
        levels: vec![Level {
            row_group_end: 0,
            resolution: -1.0,
        }],
    };
    write_file(&p, 1, kv(Some(standard_geo()), Some(lod)));
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
    let lod = LodMeta {
        overviews: None,
        levels: vec![Level {
            row_group_end: 0,
            resolution: 1.0,
        }],
    };
    write_file(&p, 1, kv(Some(geo), Some(lod)));
    assert_validate_fails(&p, "covering");
}

#[test]
fn validate_rejects_empty_levels() {
    let tmp = TempDir::new("empty-levels");
    let p = tmp.path().join("bad.parquet");
    let lod = LodMeta {
        levels: vec![],
        overviews: None,
    };
    write_file(&p, 1, kv(Some(standard_geo()), Some(lod)));
    assert_validate_fails(&p, "non-empty");
}

#[test]
fn repeated_boundaries_and_optional_covering_are_valid() {
    let tmp = TempDir::new("repeated-boundaries");
    let path = tmp.path().join("valid.parquet");
    let mut geo = standard_geo();
    geo.columns.get_mut("geometry").unwrap().covering = None;
    let layout = LodMeta {
        overviews: None,
        levels: vec![
            Level {
                row_group_end: 0,
                resolution: 1.0,
            },
            Level {
                row_group_end: 0,
                resolution: 0.1,
            },
            Level {
                row_group_end: 1,
                resolution: 0.01,
            },
        ],
    };
    write_file(&path, 2, kv(Some(geo), Some(layout)));
    cogp::validate::run(&path).unwrap();
    let reader = cogp::reader::Reader::open(&path).unwrap();
    assert_eq!(reader.row_groups_in_level(1).unwrap(), 1..1);
    assert_eq!(
        reader.row_groups_intersecting_bbox([0.0, 0.0, 1.0, 1.0]),
        vec![0, 1]
    );
}

#[test]
fn reader_rejects_invalid_prefix_before_selection() {
    let tmp = TempDir::new("invalid-prefix");
    let path = tmp.path().join("bad.parquet");
    for levels in [
        vec![Level {
            row_group_end: 0,
            resolution: 1.0,
        }],
        vec![Level {
            row_group_end: 2,
            resolution: 1.0,
        }],
        vec![Level {
            row_group_end: 1,
            resolution: -1.0,
        }],
        vec![
            Level {
                row_group_end: 1,
                resolution: 1.0,
            },
            Level {
                row_group_end: 1,
                resolution: 2.0,
            },
        ],
    ] {
        write_file(
            &path,
            2,
            kv(
                Some(standard_geo()),
                Some(LodMeta {
                    levels,
                    overviews: None,
                }),
            ),
        );
        assert!(cogp::reader::Reader::open(&path).is_err());
    }
}
