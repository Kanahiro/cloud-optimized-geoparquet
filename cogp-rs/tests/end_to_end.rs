//! End-to-end pipeline test: build a tiny GeoParquet input → run
//! `convert::run` → run `validate::run` → open the output with `Reader`
//! and exercise every selector. Uses `std::env::temp_dir()` to stay
//! dependency-free.

use std::collections::BTreeMap;
use std::fs::File;
use std::path::PathBuf;
use std::sync::Arc;

use arrow::array::{
    Array, ArrayRef, BinaryArray, Float64Array, Int32Array, ListArray, RecordBatch, StringArray,
    StructArray,
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
        simplification_tolerance_factor: 1.0,
        min_root_features: 1, // Existing fixtures exercise the complete candidate ladder.
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
    let output = tmp.path().join("output.lod.parquet");
    write_input(&input);

    cogp::convert::run(convert_args(&input, &output)).unwrap();

    // The validator must accept the output.
    cogp::validate::run(&output).unwrap();

    let reader = Reader::open(&output).unwrap();
    assert!(!reader.levels().is_empty(), "must emit at least one level");
    assert_eq!(reader.primary_column(), "geometry");

    let lod = reader.lod_meta();
    let overviews = lod.overviews.as_ref().unwrap();
    assert_eq!(overviews.encoding, "quantized_geoarrow");
    assert!(overviews
        .lods
        .values()
        .all(|lod| lod.quantization().unwrap().geometry_type == "MultiPolygon"));
    // levels list constraints (validator already checks these but assert here
    // so the reader's view stays in sync).
    let mut prev_rge: Option<i64> = None;
    let mut prev_resolution: Option<f64> = None;
    for l in &lod.levels {
        if let Some(p) = prev_rge {
            assert!(l.row_group_end >= p);
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
        lod.levels.last().unwrap().row_group_end as usize + 1,
        total_rgs
    );

    // Page layout writes offset indexes for every projected leaf, while only
    // the four bbox leaves need Page-level min/max column indexes.
    for row_group in reader.parquet_metadata().row_groups() {
        // All physical leaves, including attributes and nested overviews, must
        // remain readable without fetching a column-chunk-wide dictionary.
        for column in row_group.columns() {
            assert!(column.dictionary_page_offset().is_none());
            assert!(!column
                .encodings()
                .contains(&parquet::basic::Encoding::RLE_DICTIONARY));
        }
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
fn root_minimum_preserves_rows_and_uses_the_first_sufficient_resolution() {
    let tmp = TempDir::new("root-minimum");
    let input = tmp.path().join("input.parquet");
    write_input(&input);
    // 26 large polygons enter at 0.1; 14 small ones enter at 0.01.
    for (minimum, root_resolution, root_rows, level_count) in [
        (1, 0.1, 26, 3),
        (26, 0.1, 26, 3),
        (27, 0.01, 40, 2),
        (2048, 0.001, 40, 1),
    ] {
        let output = tmp.path().join(format!("root-{minimum}.parquet"));
        let mut args = convert_args(&input, &output);
        args.resolution = vec![1.0, 0.1, 0.01, 0.001];
        args.min_root_features = minimum;
        cogp::convert::run(args).unwrap();
        cogp::validate::run(&output).unwrap();
        let reader = Reader::open(&output).unwrap();
        assert_eq!(reader.levels().len(), level_count);
        assert_eq!(reader.levels()[0].resolution, root_resolution);
        let coarse_groups = reader.row_groups_up_to_resolution(1000.0);
        let count: i64 = coarse_groups
            .map(|i| reader.parquet_metadata().row_group(i).num_rows())
            .sum();
        assert_eq!(count, root_rows);
        let groups: Vec<_> = (0..reader.num_row_groups()).collect();
        let mut ids_seen = std::collections::BTreeSet::new();
        for batch in reader
            .sync_batch_reader(File::open(&output).unwrap(), &groups)
            .unwrap()
        {
            let batch = batch.unwrap();
            let ids = batch
                .column_by_name("id")
                .unwrap()
                .as_any()
                .downcast_ref::<Int32Array>()
                .unwrap();
            let names = batch
                .column_by_name("name")
                .unwrap()
                .as_any()
                .downcast_ref::<StringArray>()
                .unwrap();
            let geoms = batch
                .column_by_name("geometry")
                .unwrap()
                .as_any()
                .downcast_ref::<BinaryArray>()
                .unwrap();
            for row in 0..batch.num_rows() {
                let id = ids.value(row);
                assert!(ids_seen.insert(id));
                assert_eq!(names.value(row), format!("feature-{id}"));
                let x = f64::from(id % 10);
                let y = f64::from(id / 10);
                let size = if id % 3 == 0 { 0.05 } else { 0.5 };
                assert_eq!(
                    geoms.value(row),
                    wkb::polygon(&[
                        (x, y),
                        (x + size, y),
                        (x + size, y + size),
                        (x, y + size),
                        (x, y),
                    ])
                );
            }
        }
        assert_eq!(ids_seen, (0..40).collect());
    }
}

#[test]
fn root_minimum_rejects_zero() {
    let tmp = TempDir::new("invalid-root-minimum");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("output.parquet");
    let mut args = convert_args(&input, &output);
    args.min_root_features = 0;
    let error = cogp::convert::run(args).unwrap_err();
    assert!(error.to_string().contains("--min-root-features"));
    assert!(!output.exists());
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
    let output = tmp.path().join("out.lod.parquet");

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
        vec!["id", "extent", "geometry", "overviews"]
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
    // Rewriting reuses the covering and preserves the old overview column as data.
    // The regenerated overview uses a collision-free name.
    let rewritten = tmp.path().join("rewritten.parquet");
    cogp::convert::run(convert_args(&output, &rewritten)).unwrap();
    let reread = Reader::open(&rewritten).unwrap();
    assert_eq!(
        &reread.arrow_metadata().schema().fields()[..schema.fields().len()],
        schema.fields().as_ref()
    );
    assert_eq!(
        reread
            .geo_meta()
            .lod
            .as_ref()
            .unwrap()
            .overviews
            .as_ref()
            .unwrap()
            .column,
        "overviews_"
    );
    cogp::validate::run(&rewritten).unwrap();
}

#[test]
fn convert_explicit_resolution_path() {
    let tmp = TempDir::new("explicit-resolution");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("out.lod.parquet");
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
    }, "lod": {"levels":[{"row_group_end":999,"resolution":42}]}});
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
    assert_ne!(result["lod"]["levels"][0]["resolution"], 42);
    let overview_column = result["lod"]["overviews"]["column"]
        .as_str()
        .expect("null/empty rows must not suppress overviews")
        .to_string();
    let mut actual = Vec::new();
    let mut empty_overviews = 0;
    for batch in builder.build().unwrap() {
        let batch = batch.unwrap();
        let geom = batch
            .column(0)
            .as_any()
            .downcast_ref::<BinaryArray>()
            .unwrap();
        let overviews = batch
            .column_by_name(&overview_column)
            .unwrap()
            .as_any()
            .downcast_ref::<arrow::array::StructArray>()
            .unwrap();
        for i in 0..batch.num_rows() {
            let source_empty = geom.is_null(i) || geom.value(i) == empty.as_slice();
            for lod in overviews.columns() {
                let lod = lod
                    .as_any()
                    .downcast_ref::<arrow::array::ListArray>()
                    .unwrap();
                if !lod.is_null(i) {
                    assert_eq!(lod.value(i).is_empty(), source_empty);
                    empty_overviews += usize::from(source_empty);
                }
            }
        }
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
    assert!(
        empty_overviews >= 2,
        "null and empty rows need empty overviews"
    );
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
        "lod":{"levels":[{"row_group_end":0,"resolution":1}]}
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
    assert_eq!(reader.levels().len(), 1);
    assert!(
        (reader.levels()[0].resolution - 40_075_016.685_578_49 / (1024.0 * 65536.0 * 111_320.0))
            .abs()
            < 1e-12
    );
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

fn write_line_input(path: &std::path::Path, lines: &[Vec<(f64, f64)>]) {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int32, false),
        Field::new("geometry", DataType::Binary, false),
    ]));
    let geometries: Vec<Vec<u8>> = lines
        .iter()
        .map(|points| {
            let mut bytes = vec![1];
            bytes.extend_from_slice(&2_u32.to_le_bytes());
            bytes.extend_from_slice(&(points.len() as u32).to_le_bytes());
            for (x, y) in points {
                bytes.extend_from_slice(&x.to_le_bytes());
                bytes.extend_from_slice(&y.to_le_bytes());
            }
            bytes
        })
        .collect();
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(Int32Array::from_iter_values(0..lines.len() as i32)),
            Arc::new(BinaryArray::from_iter_values(geometries.iter())),
        ],
    )
    .unwrap();
    let mut writer = ArrowWriter::try_new(File::create(path).unwrap(), schema, None).unwrap();
    writer.write(&batch).unwrap();
    writer.append_key_value_metadata(KeyValue {
        key: GEO_METADATA_KEY.into(),
        value: Some(
            serde_json::json!({
                "version": "1.1.0", "primary_column": "geometry",
                "columns": {"geometry": {"encoding": "WKB", "geometry_types": ["LineString"]}}
            })
            .to_string(),
        ),
    });
    writer.close().unwrap();
}

#[test]
fn root_minimum_is_applied_after_overview_viability() {
    let tmp = TempDir::new("root-overview-viability");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("output.parquet");
    write_line_input(
        &input,
        &[
            vec![(0.4, 0.4), (100.4, 0.4)],
            vec![(0.4, 10.4), (10.4, 10.4)],
        ],
    );
    let mut args = convert_args(&input, &output);
    args.resolution = vec![16.0, 4.0, 1.0, 0.25];
    args.line_visibility_factor = 1;
    args.simplification_tolerance_factor = 8.0;
    args.min_root_features = 2;
    cogp::convert::run(args).unwrap();
    cogp::validate::run(&output).unwrap();
    let reader = Reader::open(&output).unwrap();
    assert_eq!(
        reader
            .levels()
            .iter()
            .map(|level| level.resolution)
            .collect::<Vec<_>>(),
        vec![1.0, 0.25]
    );
    assert_eq!(reader.row_groups_up_to_resolution(1000.0), 0..1);
    assert_eq!(reader.parquet_metadata().row_group(0).num_rows(), 2);
    let batch = reader
        .sync_batch_reader(File::open(&output).unwrap(), &[0])
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
    let overviews = batch
        .column_by_name("overviews")
        .unwrap()
        .as_any()
        .downcast_ref::<StructArray>()
        .unwrap();
    // The root contains both usable overviews and retains the finer refinement.
    for lod in ["l0", "l1"] {
        let lod = overviews
            .column_by_name(lod)
            .unwrap()
            .as_any()
            .downcast_ref::<ListArray>()
            .unwrap();
        let coordinates = lod.values().as_any().downcast_ref::<ListArray>().unwrap();
        for row in 0..2 {
            assert!(!lod.is_null(row));
            assert!(!coordinates.is_null(row));
            assert!(coordinates.value_length(row) >= 2);
        }
    }
}

#[test]
fn convert_preserves_refinement_without_new_features() {
    let tmp = TempDir::new("refinement");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("output.parquet");
    write_line_input(&input, &[vec![(0.4, 0.4), (50.4, 3.4), (100.4, 0.4)]]);
    let mut args = convert_args(&input, &output);
    args.line_visibility_factor = 1;
    args.resolution = vec![256.0, 8.0, 4.0, 1.0, 0.5];
    cogp::convert::run(args).unwrap();
    cogp::validate::run(&output).unwrap();
    let reader = Reader::open(&output).unwrap();

    assert_eq!(
        reader
            .levels()
            .iter()
            .map(|level| level.resolution)
            .collect::<Vec<_>>(),
        vec![8.0, 4.0, 1.0, 0.5]
    );
    assert_eq!(reader.num_row_groups(), 1);
    for index in 0..4 {
        assert_eq!(reader.row_groups_up_to_level(index), 0..1);
        assert_eq!(
            reader.row_groups_in_level(index),
            Some(if index == 0 { 0..1 } else { 1..1 })
        );
    }
    let batch = reader
        .sync_batch_reader(File::open(&output).unwrap(), &[0])
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
    assert_eq!(batch.num_rows(), 1);
    let root = batch
        .column_by_name("overviews")
        .unwrap()
        .as_any()
        .downcast_ref::<StructArray>()
        .unwrap();
    let coordinate_count = |lod| {
        root.column_by_name(lod)
            .unwrap()
            .as_any()
            .downcast_ref::<ListArray>()
            .unwrap()
            .values()
            .as_any()
            .downcast_ref::<ListArray>()
            .unwrap()
            .value_length(0)
    };
    assert_eq!(coordinate_count("l0"), 2);
    assert_eq!(coordinate_count("l3"), 3);
}

#[test]
fn lower_tolerance_retains_line_detail_at_the_same_resolution() {
    let tmp = TempDir::new("overview-detail");
    let input = tmp.path().join("input.parquet");
    write_line_input(&input, &[vec![(0.0, 0.0), (50.0, 3.0), (100.0, 0.0)]]);
    for (factor, expected_vertices) in [(1.0, 2), (0.25, 3)] {
        let output = tmp.path().join(format!("{factor}.parquet"));
        let mut args = convert_args(&input, &output);
        args.resolution = vec![8.0];
        args.simplification_tolerance_factor = factor;
        cogp::convert::run(args).unwrap();
        cogp::validate::run(&output).unwrap();
        let reader = Reader::open(&output).unwrap();
        let batch = reader
            .sync_batch_reader(File::open(&output).unwrap(), &[0])
            .unwrap()
            .next()
            .unwrap()
            .unwrap();
        let overview = batch
            .column_by_name("overviews")
            .unwrap()
            .as_any()
            .downcast_ref::<StructArray>()
            .unwrap();
        let lines = overview
            .column_by_name("l0")
            .unwrap()
            .as_any()
            .downcast_ref::<ListArray>()
            .unwrap();
        assert_eq!(lines.value_length(0), 1);
        let vertices = lines.values().as_any().downcast_ref::<ListArray>().unwrap();
        assert_eq!(vertices.value_length(0), expected_vertices);
    }
}

// Preserve row-group boundaries and data while varying only the contract under
// test. This also supplies a bbox-without-ColumnIndex interoperability fixture.
fn rewrite_contract(source: &std::path::Path, output: &std::path::Path, lod: &cogp::meta::LodMeta) {
    use parquet::file::properties::{EnabledStatistics, WriterProperties};
    use parquet::schema::types::ColumnPath;
    let reader = Reader::open(source).unwrap();
    let props = WriterProperties::builder()
        .set_column_statistics_enabled(ColumnPath::from("geometry"), EnabledStatistics::None)
        .build();
    let mut writer = ArrowWriter::try_new(
        File::create(output).unwrap(),
        reader.arrow_metadata().schema().clone(),
        Some(props),
    )
    .unwrap();
    for group in 0..reader.num_row_groups() {
        for batch in reader
            .sync_batch_reader(File::open(source).unwrap(), &[group])
            .unwrap()
        {
            writer.write(&batch.unwrap()).unwrap();
        }
        writer.flush().unwrap();
    }
    for entry in reader
        .parquet_metadata()
        .file_metadata()
        .key_value_metadata()
        .unwrap()
    {
        if entry.key != "ARROW:schema" && entry.key != "geo" {
            writer.append_key_value_metadata(entry.clone());
        }
    }
    writer.append_key_value_metadata(KeyValue {
        key: "geo".into(),
        value: Some({
            let mut geo = reader.geo_meta().clone();
            geo.lod = Some(lod.clone());
            serde_json::to_string(&geo).unwrap()
        }),
    });
    writer.close().unwrap();
}

#[test]
fn shared_lod_contract_fixtures() {
    let tmp = TempDir::new("shared-lod");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("refinement.parquet");
    write_line_input(
        &input,
        &[
            vec![(0.4, 0.4), (50.4, 3.4), (100.4, 0.4)],
            vec![(10.4, 20.4), (13.4, 20.4)],
        ],
    );
    let mut args = convert_args(&input, &output);
    args.line_visibility_factor = 1;
    args.resolution = vec![8.0, 1.0, 0.5];
    cogp::convert::run(args).unwrap();
    cogp::validate::run(&output).unwrap();
    let reader = Reader::open(&output).unwrap();
    assert_eq!(
        reader
            .levels()
            .iter()
            .map(|level| level.row_group_end)
            .collect::<Vec<_>>(),
        vec![0, 1, 1]
    );

    let mut shared = reader.lod_meta().clone();
    shared.levels.insert(
        1,
        cogp::meta::Level {
            row_group_end: 0,
            resolution: 4.0,
        },
    );
    let lods = &mut shared.overviews.as_mut().unwrap().lods;
    lods.get_mut("l1").unwrap().level_indices = vec![1, 2];
    lods.get_mut("l2").unwrap().level_indices = vec![3];
    let shared_file = tmp.path().join("shared.parquet");
    rewrite_contract(&output, &shared_file, &shared);
    cogp::validate::run(&shared_file).unwrap();
    let shared_reader = Reader::open(&shared_file).unwrap();
    assert_eq!(shared_reader.lod_meta().lod_row_group_end("l1"), Some(1));
    assert_eq!(shared_reader.row_groups_in_level(1), Some(1..1));
    assert_eq!(shared_reader.row_groups_up_to_resolution(4.0), 0..1);
    assert_eq!(shared_reader.lod_for_resolution(4.0), Some("l1"));
    assert_eq!(shared_reader.lod_for_resolution(1.0), Some("l1"));

    let mut invalid = shared.clone();
    // l0 is physically null in RG 1, but this new reference requires it there.
    invalid.levels.insert(
        3,
        cogp::meta::Level {
            row_group_end: 1,
            resolution: 0.75,
        },
    );
    let lods = &mut invalid.overviews.as_mut().unwrap().lods;
    lods.get_mut("l0").unwrap().level_indices = vec![0, 3];
    lods.get_mut("l2").unwrap().level_indices = vec![4];
    invalid.validate(2).unwrap();
    let invalid_file = tmp.path().join("invalid.parquet");
    rewrite_contract(&output, &invalid_file, &invalid);
    assert!(cogp::validate::run(&invalid_file).is_err());
    // l1 is physically non-null in RG 1; no reference now permits it there.
    let mut invalid = shared.clone();
    invalid.levels[2].row_group_end = 0;
    invalid.validate(2).unwrap();
    rewrite_contract(&output, &invalid_file, &invalid);
    assert!(cogp::validate::run(&invalid_file).is_err());

    // Distinct boundaries also use the same optional rendering contract.
    let distinct_output = tmp.path().join("distinct-source.parquet");
    let mut args = convert_args(&input, &distinct_output);
    args.line_visibility_factor = 1;
    args.resolution = vec![8.0, 1.0];
    cogp::convert::run(args).unwrap();
    let distinct = Reader::open(&distinct_output).unwrap().lod_meta().clone();

    let distinct_file = tmp.path().join("distinct-boundaries.parquet");
    rewrite_contract(&distinct_output, &distinct_file, &distinct);
    cogp::validate::run(&distinct_file).unwrap();

    // The overview column name is producer-defined.
    let renamed_file = tmp.path().join("renamed-overview.parquet");
    rename_overview_column(&output, &renamed_file, "render_geometry");
    cogp::validate::run(&renamed_file).unwrap();
    assert!(Reader::open(&renamed_file).unwrap().has_overviews());

    // Explicit opt-in regenerates the small checked-in JS contract fixtures.
    if let Some(directory) = std::env::var_os("COGP_TEST_FIXTURE_DIR") {
        let directory = PathBuf::from(directory);
        std::fs::create_dir_all(&directory).unwrap();
        for file in [&output, &shared_file, &distinct_file, &renamed_file] {
            std::fs::copy(file, directory.join(file.file_name().unwrap())).unwrap();
        }
    }
}

/// Copy a converted file with its overview column renamed, row groups intact.
fn rename_overview_column(source: &std::path::Path, output: &std::path::Path, name: &str) {
    let reader = Reader::open(source).unwrap();
    let mut lod = reader.lod_meta().clone();
    let overviews = lod.overviews.as_mut().unwrap();
    let previous = std::mem::replace(&mut overviews.column, name.to_string());
    let schema = reader.arrow_metadata().schema();
    let fields: Vec<_> = schema
        .fields()
        .iter()
        .map(|field| {
            if field.name() == &previous {
                Arc::new(field.as_ref().clone().with_name(name))
            } else {
                field.clone()
            }
        })
        .collect();
    let schema = Arc::new(Schema::new(fields));
    let props = parquet::file::properties::WriterProperties::builder()
        .set_compression(parquet::basic::Compression::ZSTD(Default::default()))
        .build();
    let mut writer =
        ArrowWriter::try_new(File::create(output).unwrap(), schema.clone(), Some(props)).unwrap();
    for group in 0..reader.num_row_groups() {
        for batch in reader
            .sync_batch_reader(File::open(source).unwrap(), &[group])
            .unwrap()
        {
            let batch = batch.unwrap();
            writer
                .write(&RecordBatch::try_new(schema.clone(), batch.columns().to_vec()).unwrap())
                .unwrap();
        }
        writer.flush().unwrap();
    }
    let mut geo = reader.geo_meta().clone();
    geo.lod = Some(lod);
    writer.append_key_value_metadata(KeyValue {
        key: "geo".into(),
        value: Some(serde_json::to_string(&geo).unwrap()),
    });
    writer.close().unwrap();
}

#[test]
fn base_layout_preserves_unrelated_overviews_attribute_and_optional_statistics() {
    use parquet::file::properties::{EnabledStatistics, WriterProperties};
    let tmp = TempDir::new("base-contract");
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int32, false),
        Field::new("geometry", DataType::Binary, true),
        Field::new("west", DataType::Float64, true),
        Field::new("south", DataType::Float64, true),
        Field::new("east", DataType::Float64, true),
        Field::new("north", DataType::Float64, true),
        Field::new("overviews", DataType::Utf8, false),
    ]));
    let points: Vec<_> = [0.0_f64, 10.0]
        .iter()
        .map(|x| {
            let mut bytes = vec![1];
            bytes.extend_from_slice(&1_u32.to_le_bytes());
            bytes.extend_from_slice(&x.to_le_bytes());
            bytes.extend_from_slice(&x.to_le_bytes());
            bytes
        })
        .collect();
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(Int32Array::from(vec![0, 1, 2])),
            Arc::new(BinaryArray::from(vec![
                Some(points[0].as_slice()),
                Some(points[1].as_slice()),
                None,
            ])),
            Arc::new(Float64Array::from(vec![Some(0.0), Some(10.0), None])),
            Arc::new(Float64Array::from(vec![Some(0.0), Some(10.0), None])),
            Arc::new(Float64Array::from(vec![Some(0.0), Some(10.0), None])),
            Arc::new(Float64Array::from(vec![Some(0.0), Some(10.0), None])),
            Arc::new(StringArray::from(vec![
                "ordinary",
                "attribute",
                "null geometry",
            ])),
        ],
    )
    .unwrap();
    for with_covering in [true, false] {
        let name = if with_covering {
            "base-covering.parquet"
        } else {
            "base-no-covering.parquet"
        };
        let output = tmp.path().join(name);
        let mut geo = serde_json::json!({"version":"1.1.0", "primary_column":"geometry",
            "columns":{"geometry":{"encoding":"WKB","geometry_types":["Point"]}},
            "lod":{"levels":[{"row_group_end":0,"resolution":1}]}});
        if with_covering {
            geo["columns"]["geometry"]["covering"] = serde_json::json!({"bbox":{
                "xmin":["west"],"ymin":["south"],"xmax":["east"],"ymax":["north"]}});
        }
        let props = WriterProperties::builder()
            .set_statistics_enabled(EnabledStatistics::None)
            .build();
        let mut writer =
            ArrowWriter::try_new(File::create(&output).unwrap(), schema.clone(), Some(props))
                .unwrap();
        writer.write(&batch).unwrap();
        writer.append_key_value_metadata(KeyValue {
            key: "geo".into(),
            value: Some(geo.to_string()),
        });
        writer.close().unwrap();
        cogp::validate::run(&output).unwrap();
        Reader::open(&output).unwrap();
        if let Some(directory) = std::env::var_os("COGP_TEST_FIXTURE_DIR") {
            std::fs::copy(output, PathBuf::from(directory).join(name)).unwrap();
        }
    }
}

#[test]
fn attribute_encodings_preserve_values_and_nested_paths() {
    use arrow::array::{BooleanArray, FixedSizeBinaryArray, Float32Array, Int64Array};
    use arrow::datatypes::Float64Type;
    use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
    use parquet::basic::Encoding;

    let tmp = TempDir::new("attribute-encodings");
    let seed = tmp.path().join("seed.parquet");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("output.parquet");
    write_input(&seed);
    let seed_reader = ParquetRecordBatchReaderBuilder::try_new(File::open(&seed).unwrap()).unwrap();
    let kv = seed_reader
        .metadata()
        .file_metadata()
        .key_value_metadata()
        .cloned();
    let seed_batch = seed_reader.build().unwrap().next().unwrap().unwrap();
    let n = seed_batch.num_rows();
    let mut fields = seed_batch.schema().fields().to_vec();
    let mut columns = seed_batch.columns().to_vec();
    let nested_fields = Fields::from(vec![
        Field::new("score", DataType::Float64, true),
        Field::new("label", DataType::Utf8, true),
    ]);
    let nested = StructArray::new(
        nested_fields.clone(),
        vec![
            Arc::new(Float64Array::from(
                (0..n)
                    .map(|i| {
                        if i % 3 == 0 {
                            None
                        } else {
                            Some(i as f64 * 0.25)
                        }
                    })
                    .collect::<Vec<_>>(),
            )),
            Arc::new(StringArray::from(
                (0..n)
                    .map(|i| {
                        if i % 3 == 0 {
                            None
                        } else {
                            Some(format!("名前-{i}"))
                        }
                    })
                    .collect::<Vec<_>>(),
            )),
        ],
        None,
    );
    let list = ListArray::from_iter_primitive::<Float64Type, _, _>((0..n).map(|i| {
        if i % 3 == 0 {
            None
        } else {
            Some(vec![Some(i as f64 + 0.5), None, Some(-0.0)])
        }
    }));
    let extra: Vec<(&str, ArrayRef)> = vec![
        (
            "long",
            Arc::new(Int64Array::from(
                (0..n)
                    .map(|i| match i % 3 {
                        0 => Some(i64::MIN),
                        1 => Some(i64::MAX),
                        _ => None,
                    })
                    .collect::<Vec<_>>(),
            )),
        ),
        (
            "float",
            Arc::new(Float32Array::from(
                (0..n)
                    .map(|i| {
                        if i % 3 == 0 {
                            None
                        } else {
                            Some(i as f32 * 0.5)
                        }
                    })
                    .collect::<Vec<_>>(),
            )),
        ),
        (
            "flag",
            Arc::new(BooleanArray::from(
                (0..n)
                    .map(|i| if i % 3 == 0 { None } else { Some(i % 2 == 0) })
                    .collect::<Vec<_>>(),
            )),
        ),
        (
            "binary",
            Arc::new(BinaryArray::from_iter((0..n).map(|i| {
                if i % 3 == 0 {
                    None
                } else {
                    Some(vec![0, i as u8, 255])
                }
            }))),
        ),
        (
            "fixed",
            Arc::new(FixedSizeBinaryArray::try_from_iter((0..n).map(|i| [i as u8; 16])).unwrap()),
        ),
        ("nested", Arc::new(nested)),
        ("values", Arc::new(list)),
    ];
    for (name, array) in extra {
        fields.push(Arc::new(Field::new(name, array.data_type().clone(), true)));
        columns.push(array);
    }
    let schema = Arc::new(Schema::new(fields));
    let original = RecordBatch::try_new(schema.clone(), columns).unwrap();
    let props = parquet::file::properties::WriterProperties::builder()
        .set_key_value_metadata(kv)
        .build();
    let mut writer =
        ArrowWriter::try_new(File::create(&input).unwrap(), schema, Some(props)).unwrap();
    writer.write(&original).unwrap();
    writer.close().unwrap();
    cogp::convert::run(convert_args(&input, &output)).unwrap();
    cogp::validate::run(&output).unwrap();

    let reader = ParquetRecordBatchReaderBuilder::try_new(File::open(&output).unwrap()).unwrap();
    for group in reader.metadata().row_groups() {
        for column in group.columns() {
            assert!(column.dictionary_page_offset().is_none());
            let parts = column.column_path().parts();
            let expected = if parts[0] == "overviews" && parts.len() > 2 {
                Encoding::DELTA_BINARY_PACKED
            } else {
                Encoding::PLAIN
            };
            assert!(
                column.encodings().contains(&expected),
                "{}: {:?}",
                column.column_path(),
                column.encodings()
            );
        }
    }
    let mut count = 0;
    for batch in reader.build().unwrap() {
        let batch = batch.unwrap();
        let ids = batch
            .column(0)
            .as_any()
            .downcast_ref::<Int32Array>()
            .unwrap();
        for row in 0..batch.num_rows() {
            let id = ids.value(row) as usize;
            for col in 0..original.num_columns() {
                assert_eq!(
                    batch.column(col).slice(row, 1).to_data(),
                    original.column(col).slice(id, 1).to_data()
                );
            }
            count += 1;
        }
    }
    assert_eq!(count, n);
    if let Some(directory) = std::env::var_os("COGP_TEST_FIXTURE_DIR") {
        let directory = PathBuf::from(directory);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::copy(output, directory.join("attribute-encodings.parquet")).unwrap();
    }
}
