//! End-to-end pipeline test: build a tiny GeoParquet input → run
//! `convert::run` → run `validate::run` → open the output with `Reader`
//! and exercise every selector. Uses `std::env::temp_dir()` to stay
//! dependency-free.

use std::collections::BTreeMap;
use std::fs::File;
use std::path::PathBuf;
use std::sync::Arc;

use arrow::array::{
    ArrayRef, BinaryArray, Float64Array, Int32Array, RecordBatch, StringArray, StructArray,
};
use arrow::datatypes::{DataType, Field, Fields, Schema};
use cogp::convert::{ConvertArgs, PriorityColumnOrder};
use cogp::meta::{BboxCovering, Covering, GeoColumn, GeoMeta, GEO_METADATA_KEY};
use cogp::reader::Reader;
use parquet::arrow::ArrowWriter;
use parquet::file::metadata::KeyValue;

/// Little-endian WKB encoder for the geometry kinds we use in the fixture.
mod wkb {
    pub fn polygon(corners: &[(f64, f64)]) -> Vec<u8> {
        let mut v = Vec::new();
        v.push(1);
        v.extend_from_slice(&3u32.to_le_bytes());
        v.extend_from_slice(&1u32.to_le_bytes()); // rings
        v.extend_from_slice(&(corners.len() as u32).to_le_bytes());
        for (x, y) in corners {
            v.extend_from_slice(&x.to_le_bytes());
            v.extend_from_slice(&y.to_le_bytes());
        }
        v
    }
}

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!(
            "cogp-test-{}-{}-{}",
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

/// Build a small GeoParquet file with a Polygon column plus a string and int
/// attribute, mirroring the shape of a real building / parcels dataset.
fn write_input(path: &std::path::Path) {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int32, false),
        Field::new("name", DataType::Utf8, false),
        Field::new("geometry", DataType::Binary, false),
    ]));

    // 40 polygons spread across a 4×10 grid; sizes vary so visibility
    // gating has something to do.
    let mut ids: Vec<i32> = Vec::new();
    let mut names = Vec::new();
    let mut geoms: Vec<Vec<u8>> = Vec::new();
    for i in 0..40i32 {
        let ix = f64::from(i % 10);
        let iy = f64::from(i / 10);
        // Mix small (degree-scale) and medium polygons.
        let size = if i % 3 == 0 { 0.05 } else { 0.5 };
        let x0 = ix;
        let y0 = iy;
        ids.push(i);
        names.push(format!("feature-{i}"));
        geoms.push(wkb::polygon(&[
            (x0, y0),
            (x0 + size, y0),
            (x0 + size, y0 + size),
            (x0, y0 + size),
            (x0, y0),
        ]));
    }

    let id_arr: ArrayRef = Arc::new(Int32Array::from(ids));
    let name_arr: ArrayRef = Arc::new(StringArray::from(names));
    let geom_arr: ArrayRef = Arc::new(BinaryArray::from(
        geoms.iter().map(|v| v.as_slice()).collect::<Vec<_>>(),
    ));
    let batch = RecordBatch::try_new(schema.clone(), vec![id_arr, name_arr, geom_arr]).unwrap();

    // Minimal `geo` metadata — no covering bbox: convert must fall back to
    // computing per-feature bboxes from WKB.
    let mut cols = BTreeMap::new();
    cols.insert(
        "geometry".to_string(),
        GeoColumn {
            encoding: "WKB".into(),
            geometry_types: vec!["Polygon".into()],
            covering: None,
            bbox: None,
            crs: None,
        },
    );
    let geo = GeoMeta {
        lod: None,
        version: "1.1.0".into(),
        primary_column: "geometry".into(),
        columns: cols,
    };

    let file = File::create(path).unwrap();
    let props = parquet::file::properties::WriterProperties::builder().build();
    let mut writer = ArrowWriter::try_new(file, schema, Some(props)).unwrap();
    writer.write(&batch).unwrap();
    writer.append_key_value_metadata(KeyValue {
        key: GEO_METADATA_KEY.to_string(),
        value: Some(serde_json::to_string(&geo).unwrap()),
    });
    writer.close().unwrap();
}

fn convert_args(input: &std::path::Path, output: &std::path::Path) -> ConvertArgs {
    ConvertArgs {
        input: input.to_path_buf(),
        output: output.to_path_buf(),
        resolution: vec![],
        webmerc_minzoom: 0,
        webmerc_maxzoom: 4,
        row_group_size: 8,
        page_row_count: 2,
        webmerc_resolution: 1024,
        point_thinning_factor: 4,
        line_visibility_factor: 2,
        polygon_visibility_factor: 4,
        priority_column: None,
        priority_column_order: PriorityColumnOrder::Desc,
    }
}

#[test]
fn convert_reader_validate_pipeline() {
    let tmp = TempDir::new("pipeline");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("output.cogp.parquet");
    write_input(&input);

    cogp::convert::run(convert_args(&input, &output)).unwrap();

    // The validator must accept the output.
    cogp::validate::run(&output).unwrap();

    let reader = Reader::open(&output).unwrap();
    assert!(!reader.levels().is_empty(), "must emit at least one level");
    assert_eq!(reader.primary_column(), "geometry");

    let cogp = reader.cogp_meta();
    // levels list constraints (validator already checks these but assert here
    // so the reader's view stays in sync).
    let mut prev_rge: Option<i64> = None;
    let mut prev_resolution: Option<f64> = None;
    for l in &cogp.levels {
        if let Some(p) = prev_rge {
            assert!(l.row_group_end > p);
        }
        prev_rge = Some(l.row_group_end);
        assert!(l.resolution > 0.0);
        if let Some(p) = prev_resolution {
            assert!(l.resolution < p);
        }
        prev_resolution = Some(l.resolution);
    }
    let total_rgs = reader.num_row_groups();
    assert_eq!(
        cogp.levels.last().unwrap().row_group_end as usize + 1,
        total_rgs
    );

    // Page layout writes offset indexes for every projected leaf, while only
    // the four bbox leaves need Page-level min/max column indexes.
    for row_group in reader.parquet_metadata().row_groups() {
        assert!(row_group
            .columns()
            .iter()
            .all(|column| column.offset_index_offset().is_some()));
        let bbox_indexes = row_group
            .columns()
            .iter()
            .filter(|column| {
                column.column_path().parts().first().map(String::as_str) == Some("bbox")
                    && column.column_index_offset().is_some()
            })
            .count();
        assert_eq!(bbox_indexes, 4);
    }

    // Selector contracts.
    assert!(reader.row_groups_in_level(reader.levels().len()).is_none());
    let in_zero = reader.row_groups_in_level(0).unwrap();
    assert_eq!(in_zero.start, 0);
    assert!(in_zero.end > in_zero.start);

    let up_to_huge = reader.row_groups_up_to_level(999);
    assert_eq!(up_to_huge.end, total_rgs);

    // `row_groups_up_to_resolution` returns levels whose Resolution is ≥ min_resolution (i.e.
    // coarser than the caller's target). Tiny min_resolution → every level
    // qualifies; huge min_resolution → no level is that coarse.
    let everything = reader.row_groups_up_to_resolution(1e-12);
    let nothing = reader.row_groups_up_to_resolution(1e12);
    assert_eq!(everything.end, total_rgs);
    assert_eq!(nothing, reader.row_groups_up_to_level(0));
    // The coarsest level's own Resolution must qualify itself.
    let coarsest_resolution = reader.levels()[0].resolution;
    let with_coarsest = reader.row_groups_up_to_resolution(coarsest_resolution);
    assert!(!with_coarsest.is_empty());

    // The dataset spans roughly [0,0]..[10,4] in degrees; an outside query
    // must drop all row groups while an enclosing query keeps them all.
    let outside = reader.row_groups_intersecting_bbox([100.0, 100.0, 200.0, 200.0]);
    assert!(outside.is_empty(), "expected zero hits, got {outside:?}");
    let inside = reader.row_groups_intersecting_bbox([-1.0, -1.0, 100.0, 100.0]);
    assert_eq!(inside.len(), total_rgs);

    // Round-trip the row count by reading every row group back.
    let row_groups: Vec<usize> = (0..total_rgs).collect();
    let file = File::open(&output).unwrap();
    let batches: Vec<RecordBatch> = reader
        .sync_batch_reader(file, &row_groups)
        .unwrap()
        .map(|b| b.unwrap())
        .collect();
    let total_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    assert_eq!(total_rows, 40, "all input rows must survive convert");

    // Bbox struct must be present in the output schema and be a non-nullable
    // struct of four f64 children.
    let schema = batches[0].schema();
    let bbox_field = schema.field_with_name("bbox").unwrap();
    match bbox_field.data_type() {
        DataType::Struct(fs) => {
            let names: Vec<&str> = fs.iter().map(|f| f.name().as_str()).collect();
            assert_eq!(names, vec!["xmin", "ymin", "xmax", "ymax"]);
            for f in fs.iter() {
                assert_eq!(f.data_type(), &DataType::Float64);
            }
        }
        other => panic!("bbox must be a struct, got {other:?}"),
    }
}

#[test]
fn convert_rejects_non_positive_resolution() {
    let tmp = TempDir::new("badresolution");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("out.parquet");
    write_input(&input);
    let mut args = convert_args(&input, &output);
    args.resolution = vec![100.0, -1.0];
    let err = cogp::convert::run(args).unwrap_err();
    let msg = format!("{err}");
    assert!(
        msg.contains("strictly decreasing") || msg.contains("positive"),
        "unexpected error: {msg}"
    );
}

#[test]
fn convert_rejects_zero_thinning_factor() {
    let tmp = TempDir::new("zerofactor");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("out.parquet");
    write_input(&input);
    let mut args = convert_args(&input, &output);
    args.point_thinning_factor = 0;
    let err = cogp::convert::run(args).unwrap_err();
    assert!(format!("{err}").contains("point-thinning-factor"));
}

/// Convert reuses an existing GeoParquet 1.1 `covering.bbox` column instead
/// of recomputing per-feature bboxes from WKB, preserving the original column.
#[test]
fn convert_reuses_existing_bbox_column() {
    let tmp = TempDir::new("reuse-bbox");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("out.cogp.parquet");

    let bbox_struct_fields = Fields::from(vec![
        Field::new("xmin", DataType::Float64, false),
        Field::new("ymin", DataType::Float64, false),
        Field::new("xmax", DataType::Float64, false),
        Field::new("ymax", DataType::Float64, false),
    ]);
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int32, false),
        Field::new(
            "extent",
            DataType::Struct(bbox_struct_fields.clone()),
            false,
        ),
        Field::new("geometry", DataType::Binary, false),
    ]));

    let mut ids = Vec::new();
    let mut xmins = Vec::new();
    let mut ymins = Vec::new();
    let mut xmaxs = Vec::new();
    let mut ymaxs = Vec::new();
    let mut geoms: Vec<Vec<u8>> = Vec::new();
    for i in 0..16i32 {
        let x0 = (i % 4) as f64;
        let y0 = (i / 4) as f64;
        let size = 0.5_f64;
        ids.push(i);
        xmins.push(x0 + 100.0);
        ymins.push(y0);
        xmaxs.push(x0 + size + 100.0);
        ymaxs.push(y0 + size);
        geoms.push(wkb::polygon(&[
            (x0, y0),
            (x0 + size, y0),
            (x0 + size, y0 + size),
            (x0, y0 + size),
            (x0, y0),
        ]));
    }

    let id_arr: ArrayRef = Arc::new(Int32Array::from(ids));
    let bbox_arr: ArrayRef = Arc::new(
        StructArray::try_new(
            bbox_struct_fields,
            vec![
                Arc::new(Float64Array::from(xmins)),
                Arc::new(Float64Array::from(ymins)),
                Arc::new(Float64Array::from(xmaxs)),
                Arc::new(Float64Array::from(ymaxs)),
            ],
            None,
        )
        .unwrap(),
    );
    let geom_arr: ArrayRef = Arc::new(BinaryArray::from(
        geoms.iter().map(|v| v.as_slice()).collect::<Vec<_>>(),
    ));
    let batch = RecordBatch::try_new(schema.clone(), vec![id_arr, bbox_arr, geom_arr]).unwrap();

    let mut cols = BTreeMap::new();
    cols.insert(
        "geometry".to_string(),
        GeoColumn {
            encoding: "WKB".into(),
            geometry_types: vec!["Polygon".into()],
            covering: Some(Covering {
                bbox: BboxCovering {
                    xmin: vec!["extent".into(), "xmin".into()],
                    ymin: vec!["extent".into(), "ymin".into()],
                    xmax: vec!["extent".into(), "xmax".into()],
                    ymax: vec!["extent".into(), "ymax".into()],
                },
            }),
            bbox: None,
            crs: None,
        },
    );
    let geo = GeoMeta {
        lod: None,
        version: "1.1.0".into(),
        primary_column: "geometry".into(),
        columns: cols,
    };

    let file = File::create(&input).unwrap();
    let props = parquet::file::properties::WriterProperties::builder().build();
    let mut writer = ArrowWriter::try_new(file, schema, Some(props)).unwrap();
    writer.write(&batch).unwrap();
    writer.append_key_value_metadata(KeyValue {
        key: GEO_METADATA_KEY.to_string(),
        value: Some(serde_json::to_string(&geo).unwrap()),
    });
    writer.close().unwrap();

    cogp::convert::run(convert_args(&input, &output)).unwrap();
    cogp::validate::run(&output).unwrap();

    // Trust covering metadata even when its column is not named bbox.
    let reader = Reader::open(&output).unwrap();
    let rgs: Vec<usize> = (0..reader.num_row_groups()).collect();
    let f = File::open(&output).unwrap();
    let batches: Vec<RecordBatch> = reader
        .sync_batch_reader(f, &rgs)
        .unwrap()
        .map(|b| b.unwrap())
        .collect();
    let schema = batches[0].schema();
    assert_eq!(
        schema
            .fields()
            .iter()
            .map(|f| f.name().as_str())
            .collect::<Vec<_>>(),
        vec!["id", "extent", "geometry"]
    );
    assert!(schema.field_with_name("id").is_ok());
    assert!(schema.field_with_name("extent").is_ok());
    assert!(schema.field_with_name("geometry").is_ok());
    // Deliberately distinct covering values prove they were trusted, not recomputed from WKB.
    assert_eq!(
        reader.geo_meta().columns["geometry"].bbox.as_ref().unwrap()[0],
        100.0
    );
    for batch in &batches {
        let ids = batch
            .column(0)
            .as_any()
            .downcast_ref::<Int32Array>()
            .unwrap();
        let extent = batch
            .column(1)
            .as_any()
            .downcast_ref::<StructArray>()
            .unwrap();
        let xmin = extent
            .column_by_name("xmin")
            .unwrap()
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        for i in 0..batch.num_rows() {
            assert_eq!(xmin.value(i), (ids.value(i) % 4) as f64 + 100.0);
        }
    }
    let total: usize = batches.iter().map(|b| b.num_rows()).sum();
    assert_eq!(total, 16);
    assert_eq!(
        reader.geo_meta().columns["geometry"]
            .covering
            .as_ref()
            .unwrap()
            .bbox
            .xmin,
        vec!["extent", "xmin"]
    );
    // Rewriting must reuse the same covering again, without growing the schema.
    let rewritten = tmp.path().join("rewritten.parquet");
    cogp::convert::run(convert_args(&output, &rewritten)).unwrap();
    let reread = Reader::open(&rewritten).unwrap();
    assert_eq!(reread.arrow_metadata().schema().fields(), schema.fields());
}

#[test]
fn convert_explicit_resolution_path() {
    let tmp = TempDir::new("explicit-resolution");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("out.cogp.parquet");
    write_input(&input);
    let mut args = convert_args(&input, &output);
    args.resolution = vec![1000.0, 100.0, 10.0];
    cogp::convert::run(args).unwrap();
    cogp::validate::run(&output).unwrap();
}

#[test]
fn preserves_null_empty_duplicate_rows_and_crs_metadata() {
    use arrow::array::Array;
    use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
    let tmp = TempDir::new("lossless");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("output.parquet");
    let schema = Arc::new(Schema::new(vec![
        Field::new("geometry", DataType::Binary, true),
        Field::new("bbox", DataType::Utf8, true),
    ]));
    let polygon = wkb::polygon(&[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 0.0)]);
    let empty = vec![1, 3, 0, 0, 0, 0, 0, 0, 0];
    let geometries = vec![
        Some(polygon.as_slice()),
        None,
        Some(empty.as_slice()),
        Some(polygon.as_slice()),
    ];
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(BinaryArray::from(geometries.clone())),
            Arc::new(StringArray::from(vec![
                Some("keep"),
                None,
                Some("empty"),
                Some("keep"),
            ])),
        ],
    )
    .unwrap();
    let geo = serde_json::json!({"version":"1.1.0", "primary_column":"geometry", "columns": {
        "geometry": {"encoding":"WKB", "geometry_types":["Polygon"], "crs":null, "edges":"planar", "future":"preserve"}
    }, "coarse_to_fine": {"levels":[{"row_group_end":999,"resolution":42}]}});
    let mut writer = ArrowWriter::try_new(File::create(&input).unwrap(), schema, None).unwrap();
    writer.write(&batch).unwrap();
    writer.append_key_value_metadata(KeyValue {
        key: "geo".into(),
        value: Some(geo.to_string()),
    });
    writer.close().unwrap();
    let mut args = convert_args(&input, &output);
    args.resolution = vec![1.0, 0.1];
    cogp::convert::run(args).unwrap();
    cogp::validate::run(&output).unwrap();
    let builder = ParquetRecordBatchReaderBuilder::try_new(File::open(&output).unwrap()).unwrap();
    let kv = builder
        .metadata()
        .file_metadata()
        .key_value_metadata()
        .unwrap();
    assert!(!kv.iter().any(|e| e.key == "cogp"));
    let result: serde_json::Value = serde_json::from_str(
        kv.iter()
            .find(|e| e.key == "geo")
            .unwrap()
            .value
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        result["columns"]["geometry"]["crs"],
        serde_json::Value::Null
    );
    assert_eq!(result["columns"]["geometry"]["future"], "preserve");
    assert!(result["lod"].get("version").is_none());
    assert!(result.get("coarse_to_fine").is_none());
    let mut actual = Vec::new();
    for batch in builder.build().unwrap() {
        let batch = batch.unwrap();
        let geom = batch
            .column(0)
            .as_any()
            .downcast_ref::<BinaryArray>()
            .unwrap();
        let attr = batch
            .column(1)
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap();
        for i in 0..batch.num_rows() {
            actual.push((
                (!geom.is_null(i)).then(|| geom.value(i).to_vec()),
                (!attr.is_null(i)).then(|| attr.value(i).to_string()),
            ));
        }
    }
    let mut expected = vec![
        (Some(polygon.clone()), Some("keep".into())),
        (None, None),
        (Some(empty), Some("empty".into())),
        (Some(polygon), Some("keep".into())),
    ];
    actual.sort();
    expected.sort();
    assert_eq!(actual, expected);
}

#[test]
fn empty_input_omits_extension() {
    use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
    let tmp = TempDir::new("empty");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("output.parquet");
    let schema = Arc::new(Schema::new(vec![Field::new(
        "geometry",
        DataType::Binary,
        true,
    )]));
    let mut writer = ArrowWriter::try_new(File::create(&input).unwrap(), schema, None).unwrap();
    writer.append_key_value_metadata(KeyValue { key: "geo".into(), value: Some(serde_json::json!({
        "version":"1.1.0", "primary_column":"geometry", "columns":{"geometry":{"encoding":"WKB","geometry_types":[]}},
        "coarse_to_fine":{"levels":[{"row_group_end":0,"resolution":1}]}
    }).to_string()) });
    writer.close().unwrap();
    cogp::convert::run(convert_args(&input, &output)).unwrap();
    cogp::validate::run(&output).unwrap();
    let builder = ParquetRecordBatchReaderBuilder::try_new(File::open(&output).unwrap()).unwrap();
    assert_eq!(builder.metadata().file_metadata().num_rows(), 0);
    let kv = builder
        .metadata()
        .file_metadata()
        .key_value_metadata()
        .unwrap();
    let geo: serde_json::Value = serde_json::from_str(
        kv.iter()
            .find(|e| e.key == "geo")
            .unwrap()
            .value
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    assert!(geo.get("lod").is_none());
    assert!(geo.get("coarse_to_fine").is_none());
}

#[test]
fn cli_defaults_write_page_indexes() {
    let tmp = TempDir::new("cli-default-pages");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("output.parquet");
    write_input(&input);
    let result = std::process::Command::new(env!("CARGO_BIN_EXE_cogp"))
        .arg("convert")
        .arg(&input)
        .arg(&output)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let reader = Reader::open(&output).unwrap();
    assert_eq!(reader.parquet_metadata().file_metadata().num_rows(), 40);
    for group in reader.parquet_metadata().row_groups() {
        assert!(group
            .columns()
            .iter()
            .all(|c| c.offset_index_offset().is_some()));
        assert_eq!(
            group
                .columns()
                .iter()
                .filter(|c| {
                    c.column_path().parts().first().map(String::as_str) == Some("bbox")
                        && c.column_index_offset().is_some()
                })
                .count(),
            4
        );
    }
}

#[test]
fn cli_rejects_retired_options() {
    for flag in [
        "--row-group-max-bytes",
        "--dictionary-page-size-limit",
        "--input-units",
        "--geometry-column",
        "--sort-key",
        "--sort-order",
    ] {
        let result = std::process::Command::new(env!("CARGO_BIN_EXE_cogp"))
            .args(["convert", "input.parquet", "output.parquet", flag, "1"])
            .output()
            .unwrap();
        assert!(!result.status.success());
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(stderr.contains("unexpected argument"), "{flag}: {stderr}");
    }
}
