//! Focused failure-mode coverage for COGP 0.2 metadata validation.

use std::collections::BTreeMap;
use std::fs::File;
use std::path::PathBuf;
use std::sync::Arc;

use arrow::array::{ArrayRef, BinaryArray, Float64Array, RecordBatch, StructArray};
use arrow::datatypes::{DataType, Field, Fields, Schema};
use cogp::meta::{
    BboxCovering, CogpMeta, Covering, GeoColumn, GeoMeta, Level, LodMeta, OverviewsMeta,
    COGP_METADATA_KEY, COGP_VERSION, GEOPARQUET_VERSION, GEO_METADATA_KEY, OVERVIEWS_ENCODING,
};
use cogp::reader::Reader;
use parquet::arrow::ArrowWriter;
use parquet::file::metadata::KeyValue;
use parquet::file::properties::{EnabledStatistics, WriterProperties};
use parquet::schema::types::ColumnPath;

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "cogp-validate-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn standard_geo() -> GeoMeta {
    GeoMeta {
        version: GEOPARQUET_VERSION.into(),
        primary_column: "geometry".into(),
        columns: BTreeMap::from([(
            "geometry".into(),
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
        )]),
    }
}

fn cogp(levels: Vec<Level>) -> CogpMeta {
    let lods = levels
        .iter()
        .map(|level| {
            (
                level.lod.clone().unwrap(),
                LodMeta {
                    scale: [1.0, 1.0],
                    offset: [0.0, 0.0],
                },
            )
        })
        .collect();
    CogpMeta {
        version: COGP_VERSION.into(),
        levels,
        overviews: Some(OverviewsMeta {
            encoding: OVERVIEWS_ENCODING.into(),
            lods,
        }),
    }
}

fn write_file(path: &std::path::Path, geo: Option<GeoMeta>, cogp: Option<CogpMeta>) {
    let bbox_fields = Fields::from(vec![
        Field::new("xmin", DataType::Float64, false),
        Field::new("ymin", DataType::Float64, false),
        Field::new("xmax", DataType::Float64, false),
        Field::new("ymax", DataType::Float64, false),
    ]);
    let schema = Arc::new(Schema::new(vec![
        Field::new("bbox", DataType::Struct(bbox_fields.clone()), false),
        Field::new("geometry", DataType::Binary, false),
    ]));
    let bbox: ArrayRef = Arc::new(StructArray::new(
        bbox_fields,
        vec![
            Arc::new(Float64Array::from(vec![0.0])),
            Arc::new(Float64Array::from(vec![0.0])),
            Arc::new(Float64Array::from(vec![1.0])),
            Arc::new(Float64Array::from(vec![1.0])),
        ],
        None,
    ));
    let geometry: ArrayRef = Arc::new(BinaryArray::from(vec![&[1_u8][..]]));
    let file = File::create(path).unwrap();
    let props = WriterProperties::builder()
        .set_column_statistics_enabled(ColumnPath::from("geometry"), EnabledStatistics::None)
        .build();
    let mut writer = ArrowWriter::try_new(file, schema.clone(), Some(props)).unwrap();
    writer
        .write(&RecordBatch::try_new(schema, vec![bbox, geometry]).unwrap())
        .unwrap();
    if let Some(value) = geo {
        writer.append_key_value_metadata(KeyValue {
            key: GEO_METADATA_KEY.into(),
            value: Some(serde_json::to_string(&value).unwrap()),
        });
    }
    if let Some(value) = cogp {
        writer.append_key_value_metadata(KeyValue {
            key: COGP_METADATA_KEY.into(),
            value: Some(serde_json::to_string(&value).unwrap()),
        });
    }
    writer.close().unwrap();
}

fn assert_invalid(path: &std::path::Path) {
    assert!(cogp::validate::run(path).is_err());
}

#[test]
fn accepts_polygon_without_overviews() {
    let dir = TempDir::new("polygon-primary-wkb");
    let path = dir.0.join("valid.parquet");
    write_file(
        &path,
        Some(standard_geo()),
        Some(CogpMeta {
            version: COGP_VERSION.into(),
            levels: vec![Level {
                row_group_end: 0,
                resolution: 100.0,
                lod: None,
            }],
            overviews: None,
        }),
    );
    cogp::validate::run(&path).unwrap();
    let reader = Reader::open(&path).unwrap();
    assert!(reader.cogp_meta().overviews.is_none());
    assert_eq!(reader.lod_for_resolution(100.0), None);
}

#[test]
fn rejects_missing_geo_metadata() {
    let dir = TempDir::new("missing-geo");
    let path = dir.0.join("bad.parquet");
    write_file(
        &path,
        None,
        Some(cogp(vec![Level {
            row_group_end: 0,
            resolution: 100.0,
            lod: Some("l0".into()),
        }])),
    );
    assert_invalid(&path);
}

#[test]
fn rejects_non_decreasing_resolution() {
    let dir = TempDir::new("resolution");
    let path = dir.0.join("bad.parquet");
    write_file(
        &path,
        Some(standard_geo()),
        Some(cogp(vec![
            Level {
                row_group_end: 0,
                resolution: 100.0,
                lod: Some("l0".into()),
            },
            Level {
                row_group_end: 0,
                resolution: 100.0,
                lod: Some("l1".into()),
            },
        ])),
    );
    assert_invalid(&path);
}

#[test]
fn rejects_level_referencing_unknown_lod() {
    let dir = TempDir::new("unknown-lod");
    let path = dir.0.join("bad.parquet");
    let mut metadata = cogp(vec![Level {
        row_group_end: 0,
        resolution: 100.0,
        lod: Some("l0".into()),
    }]);
    metadata.levels[0].lod = Some("missing".into());
    write_file(&path, Some(standard_geo()), Some(metadata));
    assert_invalid(&path);
}

#[test]
fn rejects_point_family_overviews() {
    let dir = TempDir::new("point-overviews");
    let path = dir.0.join("bad.parquet");
    let mut geo = standard_geo();
    geo.columns.get_mut("geometry").unwrap().geometry_types = vec!["Point".into()];
    write_file(
        &path,
        Some(geo),
        Some(cogp(vec![Level {
            row_group_end: 0,
            resolution: 100.0,
            lod: Some("l0".into()),
        }])),
    );
    assert_invalid(&path);
}
