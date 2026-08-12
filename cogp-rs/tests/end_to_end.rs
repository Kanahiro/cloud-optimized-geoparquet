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
use cogp::convert::{ConvertArgs, InputUnits, SortKeyOrder};
use cogp::meta::{BboxCovering, Covering, GeoColumn, GeoMeta, GEO_METADATA_KEY};
use cogp::reader::Reader;
use parquet::arrow::ArrowWriter;
use parquet::file::metadata::KeyValue;

/// Little-endian WKB encoder for the geometry kinds we use in the fixture.
mod wkb {
    pub fn point(x: f64, y: f64) -> Vec<u8> {
        let mut v = Vec::new();
        v.push(1);
        v.extend_from_slice(&1u32.to_le_bytes());
        v.extend_from_slice(&x.to_le_bytes());
        v.extend_from_slice(&y.to_le_bytes());
        v
    }

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

fn write_point_input(path: &std::path::Path) {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int32, false),
        Field::new("geometry", DataType::Binary, false),
    ]));
    let ids: Vec<i32> = (0..8).collect();
    let geoms: Vec<Vec<u8>> = ids
        .iter()
        .map(|id| wkb::point(f64::from(*id), 0.0))
        .collect();
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(Int32Array::from(ids)),
            Arc::new(BinaryArray::from(
                geoms.iter().map(Vec::as_slice).collect::<Vec<_>>(),
            )),
        ],
    )
    .unwrap();

    let mut cols = BTreeMap::new();
    cols.insert(
        "geometry".to_string(),
        GeoColumn {
            encoding: "WKB".into(),
            geometry_types: vec!["Point".into()],
            covering: None,
            bbox: None,
            crs: None,
        },
    );
    let geo = GeoMeta {
        version: "1.1.0".into(),
        primary_column: "geometry".into(),
        columns: cols,
    };

    let file = File::create(path).unwrap();
    let mut writer = ArrowWriter::try_new(file, schema, None).unwrap();
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
        gsd: vec![],
        webmerc_minzoom: 0,
        webmerc_maxzoom: 4,
        row_group_size: 8,
        row_group_max_bytes: None,
        simplification_tolerance_factor: 1.0,
        input_units: InputUnits::Degrees,
        geometry_column: None,
        webmerc_resolution: 1024,
        point_thinning_factor: 4,
        sort_key: None,
        sort_order: SortKeyOrder::Desc,
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
    assert!(!cogp.geometry_overviews.is_empty());
    assert_eq!(cogp.geometry_overviews.len(), cogp.levels.len());
    assert!(cogp
        .geometry_overviews
        .iter()
        .enumerate()
        .all(|(level, overview)| overview.level == level));
    let coarsest_overview = &cogp.geometry_overviews[0];
    assert_eq!(
        reader.geometry_column_for_gsd(cogp.levels[coarsest_overview.level].gsd),
        coarsest_overview.column
    );
    let finest_overview = cogp.geometry_overviews.last().unwrap();
    assert_eq!(finest_overview.level, cogp.levels.len() - 1);
    assert_eq!(
        reader.geometry_column_for_gsd(cogp.levels[finest_overview.level].gsd / 2.0),
        finest_overview.column
    );
    // levels list constraints (validator already checks these but assert here
    // so the reader's view stays in sync).
    let mut prev_rge: Option<i64> = None;
    let mut prev_gsd: Option<f64> = None;
    for l in &cogp.levels {
        if let Some(p) = prev_rge {
            assert!(l.row_group_end > p);
        }
        prev_rge = Some(l.row_group_end);
        assert!(l.gsd > 0.0);
        if let Some(p) = prev_gsd {
            assert!(l.gsd < p);
        }
        prev_gsd = Some(l.gsd);
    }
    let total_rgs = reader.num_row_groups();
    assert_eq!(cogp.levels.last().unwrap().row_group_end as usize + 1, total_rgs);

    // The profile relies only on row-group statistics; the converter must not
    // add page-level index structures to the output.
    assert!(reader
        .parquet_metadata()
        .row_groups()
        .iter()
        .all(|row_group| {
            row_group.columns().iter().all(|column| {
                column.column_index_offset().is_none() && column.offset_index_offset().is_none()
            })
        }));

    // Selector contracts.
    assert!(reader.row_groups_in_level(reader.levels().len()).is_none());
    let in_zero = reader.row_groups_in_level(0).unwrap();
    assert_eq!(in_zero.start, 0);
    assert!(in_zero.end > in_zero.start);

    let up_to_huge = reader.row_groups_up_to_level(999);
    assert_eq!(up_to_huge.end, total_rgs);

    // `row_groups_up_to_gsd` returns levels whose GSD is ≥ min_gsd (i.e.
    // coarser than the caller's target). Tiny min_gsd → every level
    // qualifies; huge min_gsd → no level is that coarse.
    let everything = reader.row_groups_up_to_gsd(1e-12);
    let nothing = reader.row_groups_up_to_gsd(1e12);
    assert_eq!(everything.end, total_rgs);
    assert!(nothing.is_empty());
    // The coarsest level's own GSD must qualify itself.
    let coarsest_gsd = reader.levels()[0].gsd;
    let with_coarsest = reader.row_groups_up_to_gsd(coarsest_gsd);
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
    for overview in &cogp.geometry_overviews {
        let field = schema.field_with_name(&overview.column).unwrap();
        assert_eq!(field.data_type(), &DataType::Binary);
        assert!(field.is_nullable());
        assert!(reader.geo_meta().columns.contains_key(&overview.column));
    }
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

    // Each overview is complete through its linked feature-level boundary and
    // entirely NULL afterward. This lets a renderer read one projected WKB
    // column without per-row fallback.
    for row_group_index in 0..total_rgs {
        let file = File::open(&output).unwrap();
        let row_group_batches: Vec<RecordBatch> = reader
            .sync_batch_reader(file, &[row_group_index])
            .unwrap()
            .map(|batch| batch.unwrap())
            .collect();
        for overview in &cogp.geometry_overviews {
            let boundary = cogp.levels[overview.level].row_group_end as usize;
            let (nulls, rows) = row_group_batches.iter().fold((0, 0), |(nulls, rows), batch| {
                let column = batch.column_by_name(&overview.column).unwrap();
                (nulls + column.null_count(), rows + batch.num_rows())
            });
            assert_eq!(
                nulls,
                if row_group_index <= boundary { 0 } else { rows },
                "unexpected sparse layout for {} in row group {row_group_index}",
                overview.column
            );
        }
    }
}

#[test]
fn convert_point_uses_primary_wkb_without_overviews() {
    let tmp = TempDir::new("point-primary-wkb");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("output.cogp.parquet");
    write_point_input(&input);

    let mut args = convert_args(&input, &output);
    args.gsd = vec![100_000.0, 10_000.0, 1_000.0];
    args.row_group_size = 8;
    args.row_group_max_bytes = Some(42);
    cogp::convert::run(args).unwrap();
    cogp::validate::run(&output).unwrap();

    let reader = Reader::open(&output).unwrap();
    assert!(reader.geometry_overviews().is_empty());
    assert_eq!(reader.geometry_column_for_gsd(1.0), "geometry");
    assert!(reader.num_row_groups() > 1, "primary WKB must drive the byte budget");

    let all_row_groups: Vec<usize> = (0..reader.num_row_groups()).collect();
    let batches: Vec<RecordBatch> = reader
        .sync_batch_reader(File::open(&output).unwrap(), &all_row_groups)
        .unwrap()
        .map(|batch| batch.unwrap())
        .collect();
    let schema = batches[0].schema();
    assert!(schema.field_with_name("geometry").is_ok());
    assert!(schema.fields().iter().all(|field| !field.name().starts_with("geometry_ovr_")));
    assert_eq!(batches.iter().map(RecordBatch::num_rows).sum::<usize>(), 8);
}

#[test]
fn convert_rejects_non_positive_gsd() {
    let tmp = TempDir::new("badgsd");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("out.parquet");
    write_input(&input);
    let mut args = convert_args(&input, &output);
    args.gsd = vec![100.0, -1.0];
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
/// of recomputing per-feature bboxes from WKB. The reuse path also drops
/// the original column from the output.
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
            "bbox",
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
        xmins.push(x0);
        ymins.push(y0);
        xmaxs.push(x0 + size);
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
    let batch =
        RecordBatch::try_new(schema.clone(), vec![id_arr, bbox_arr, geom_arr]).unwrap();

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
    let geo = GeoMeta {
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

    // Output must still have exactly one `bbox` column (the writer's own) —
    // the input one was dropped and the new one was inserted. The id column
    // must survive intact.
    let reader = Reader::open(&output).unwrap();
    let rgs: Vec<usize> = (0..reader.num_row_groups()).collect();
    let f = File::open(&output).unwrap();
    let batches: Vec<RecordBatch> = reader
        .sync_batch_reader(f, &rgs)
        .unwrap()
        .map(|b| b.unwrap())
        .collect();
    let schema = batches[0].schema();
    assert!(schema.field_with_name("id").is_ok());
    assert!(schema.field_with_name("bbox").is_ok());
    assert!(schema.field_with_name("geometry").is_ok());
    let total: usize = batches.iter().map(|b| b.num_rows()).sum();
    assert_eq!(total, 16);
}

#[test]
fn convert_explicit_gsd_path() {
    let tmp = TempDir::new("explicit-gsd");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("out.cogp.parquet");
    write_input(&input);
    let mut args = convert_args(&input, &output);
    args.gsd = vec![1000.0, 100.0, 10.0];
    cogp::convert::run(args).unwrap();
    cogp::validate::run(&output).unwrap();
}

#[test]
fn convert_respects_render_wkb_row_group_budget() {
    let tmp = TempDir::new("wkb-budget");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("out.cogp.parquet");
    write_input(&input);

    let mut args = convert_args(&input, &output);
    args.gsd = vec![100_000.0];
    args.row_group_size = 40;
    args.row_group_max_bytes = Some(200);
    cogp::convert::run(args).unwrap();
    cogp::validate::run(&output).unwrap();

    let reader = Reader::open(&output).unwrap();
    assert!(
        reader.num_row_groups() > 1,
        "WKB budget must split the level"
    );
    let overview_names: Vec<&str> = reader
        .geometry_overviews()
        .iter()
        .map(|overview| overview.column.as_str())
        .collect();
    for row_group_index in 0..reader.num_row_groups() {
        let batches: Vec<RecordBatch> = reader
            .sync_batch_reader(File::open(&output).unwrap(), &[row_group_index])
            .unwrap()
            .map(|batch| batch.unwrap())
            .collect();
        let row_count: usize = batches.iter().map(|batch| batch.num_rows()).sum();
        let mut bytes = 0usize;
        for batch in batches {
            for row in 0..batch.num_rows() {
                let largest_overview = overview_names
                    .iter()
                    .map(|name| {
                        batch
                            .column_by_name(name)
                            .unwrap()
                            .as_any()
                            .downcast_ref::<BinaryArray>()
                            .unwrap()
                            .value(row)
                            .len()
                    })
                    .max()
                    .unwrap();
                bytes += largest_overview;
            }
        }
        assert!(
            bytes <= 200 || row_count == 1,
            "row group {row_group_index} has {bytes} render WKB bytes across {row_count} rows"
        );
    }
}
