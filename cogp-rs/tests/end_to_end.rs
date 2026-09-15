//! End-to-end pipeline test: build a tiny GeoParquet input → run
//! `convert::run` → run `validate::run` → open the output with `Reader`
//! and exercise every selector. Uses `std::env::temp_dir()` to stay
//! dependency-free.

use std::collections::BTreeMap;
use std::fs::File;
use std::path::PathBuf;
use std::sync::Arc;

use arrow::array::{
    ArrayRef, BinaryArray, Float64Array, Int32Array, ListArray, RecordBatch, StringArray,
    StructArray,
};
use arrow::datatypes::{DataType, Field, Fields, Schema};
use cogp::convert::{ConvertArgs, InputUnits, SortKeyOrder};
use cogp::meta::{BboxCovering, Covering, GeoColumn, GeoMeta, GEO_METADATA_KEY};
use cogp::reader::Reader;
use parquet::arrow::ArrowWriter;
use parquet::basic::Encoding;
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
        resolution: vec![],
        webmerc_minzoom: 0,
        webmerc_maxzoom: 4,
        row_group_size: 8,
        simplification_tolerance_factor: 1.0,
        input_units: InputUnits::Degrees,
        geometry_column: None,
        webmerc_resolution: 1024,
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
    let overviews = cogp.overviews.as_ref().unwrap();
    assert!(cogp
        .levels
        .iter()
        .all(|level| overviews.lods.contains_key(level.lod.as_deref().unwrap())));
    assert_eq!(
        reader.lod_for_resolution(cogp.levels[0].resolution),
        cogp.levels[0].lod.as_deref()
    );
    let finest_level = cogp.levels.last().unwrap();
    assert_eq!(
        reader.lod_for_resolution(finest_level.resolution / 2.0),
        finest_level.lod.as_deref()
    );
    for row_group in reader.parquet_metadata().row_groups() {
        for column in row_group.columns() {
            let path = column.column_path().string();
            if path.starts_with("overviews.") && !path.ends_with("geometry_type") {
                assert!(column.encodings().contains(&Encoding::DELTA_BINARY_PACKED));
                assert!(!column.encodings().contains(&Encoding::RLE_DICTIONARY));
            }
        }
    }
    // levels list constraints (validator already checks these but assert here
    // so the reader's view stays in sync).
    let mut prev_rge: Option<i64> = None;
    let mut previous_resolution: Option<f64> = None;
    for l in &cogp.levels {
        if let Some(p) = prev_rge {
            assert!(l.row_group_end >= p);
        }
        prev_rge = Some(l.row_group_end);
        assert!(l.resolution > 0.0);
        if let Some(previous) = previous_resolution {
            assert!(l.resolution < previous);
        }
        previous_resolution = Some(l.resolution);
    }
    let total_rgs = reader.num_row_groups();
    assert_eq!(
        cogp.levels.last().unwrap().row_group_end as usize + 1,
        total_rgs
    );

    // Bbox leaves carry page min/max indexes; every column carries an offset
    // index so a bbox-derived row selection can avoid unrelated data pages.
    for row_group in reader.parquet_metadata().row_groups() {
        for column in row_group.columns() {
            let path = column.column_path().string();
            assert!(column.offset_index_offset().is_some(), "{path}");
            if path.starts_with("bbox.") {
                assert!(column.column_index_offset().is_some(), "{path}");
            } else {
                assert!(column.column_index_offset().is_none(), "{path}");
            }
        }
    }

    // Selector contracts.
    assert!(reader.row_groups_in_level(reader.levels().len()).is_none());
    let in_zero = reader.row_groups_in_level(0).unwrap();
    assert_eq!(in_zero.start, 0);
    assert!(in_zero.end > in_zero.start);

    let up_to_huge = reader.row_groups_up_to_level(999);
    assert_eq!(up_to_huge.end, total_rgs);

    // Tiny target resolution includes every level; a huge target falls back
    // to the coarsest available prefix.
    let everything = reader.row_groups_up_to_resolution(1e-12);
    let coarsest = reader.row_groups_up_to_resolution(1e12);
    assert_eq!(everything.end, total_rgs);
    assert_eq!(coarsest, reader.row_groups_up_to_level(0));
    // The coarsest level's own resolution must qualify itself.
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
    // Overview quantization must never leak into the lossless primary column.
    for batch in &batches {
        let ids = batch
            .column_by_name("id")
            .unwrap()
            .as_any()
            .downcast_ref::<Int32Array>()
            .unwrap();
        let geometry = batch
            .column_by_name("geometry")
            .unwrap()
            .as_any()
            .downcast_ref::<BinaryArray>()
            .unwrap();
        for row in 0..batch.num_rows() {
            let id = ids.value(row);
            let x0 = f64::from(id % 10);
            let y0 = f64::from(id / 10);
            let size = if id % 3 == 0 { 0.05 } else { 0.5 };
            let expected = wkb::polygon(&[
                (x0, y0),
                (x0 + size, y0),
                (x0 + size, y0 + size),
                (x0, y0 + size),
                (x0, y0),
            ]);
            assert_eq!(geometry.value(row), expected);
        }
    }

    // Bbox struct must be present in the output schema and be a non-nullable
    // struct of four f64 children.
    let schema = batches[0].schema();
    let bbox_field = schema.field_with_name("bbox").unwrap();
    let mut geometry_boundaries = BTreeMap::new();
    for level in &cogp.levels {
        geometry_boundaries
            .entry(level.lod.as_deref().unwrap())
            .and_modify(|boundary: &mut usize| {
                *boundary = (*boundary).max(level.row_group_end as usize)
            })
            .or_insert(level.row_group_end as usize);
    }
    let overviews_field = schema.field_with_name("overviews").unwrap();
    let DataType::Struct(overview_fields) = overviews_field.data_type() else {
        panic!("overviews must be a struct")
    };
    for lod in geometry_boundaries.keys() {
        let lod_field = overview_fields
            .iter()
            .find(|field| field.name() == *lod)
            .unwrap();
        let DataType::Struct(lod_fields) = lod_field.data_type() else {
            panic!("overview LoD must be a struct")
        };
        assert_eq!(
            lod_fields
                .iter()
                .map(|field| field.name().as_str())
                .collect::<Vec<_>>(),
            ["coordinates", "part_ends", "polygon_ends"]
        );
        let DataType::List(coordinate_element) =
            lod_fields.find("coordinates").unwrap().1.data_type()
        else {
            panic!("overview coordinates must be a list")
        };
        let DataType::Struct(axes) = coordinate_element.data_type() else {
            panic!("overview coordinate must be a struct")
        };
        assert_eq!(
            axes.iter()
                .map(|field| field.name().as_str())
                .collect::<Vec<_>>(),
            ["x", "y"]
        );
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

    // Each LoD is complete through its greatest referenced boundary and
    // entirely NULL afterward. This lets a renderer project one overview
    // without any per-row fallback.
    for row_group_index in 0..total_rgs {
        let file = File::open(&output).unwrap();
        let row_group_batches: Vec<RecordBatch> = reader
            .sync_batch_reader(file, &[row_group_index])
            .unwrap()
            .map(|batch| batch.unwrap())
            .collect();
        for (lod_name, boundary) in &geometry_boundaries {
            let (nulls, rows) = row_group_batches
                .iter()
                .fold((0, 0), |(nulls, rows), batch| {
                    let overviews = batch
                        .column_by_name("overviews")
                        .unwrap()
                        .as_any()
                        .downcast_ref::<StructArray>()
                        .unwrap();
                    let column = overviews.column_by_name(lod_name).unwrap();
                    if let Some(lod) = column.as_any().downcast_ref::<StructArray>() {
                        let coordinates = lod
                            .column_by_name("coordinates")
                            .unwrap()
                            .as_any()
                            .downcast_ref::<ListArray>()
                            .unwrap();
                        let coordinate_values = coordinates
                            .values()
                            .as_any()
                            .downcast_ref::<StructArray>()
                            .unwrap();
                        assert_eq!(coordinate_values.num_columns(), 2);
                        assert_eq!(
                            coordinate_values.column(0).len(),
                            coordinate_values.column(1).len()
                        );
                    }
                    (nulls + column.null_count(), rows + batch.num_rows())
                });
            assert_eq!(
                nulls,
                if row_group_index <= *boundary {
                    0
                } else {
                    rows
                },
                "unexpected sparse layout for {} in row group {row_group_index}",
                lod_name
            );
        }
    }
}

#[test]
fn convert_point_omits_overviews() {
    let tmp = TempDir::new("point-primary-wkb");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("output.cogp.parquet");
    write_point_input(&input);

    let mut args = convert_args(&input, &output);
    args.resolution = vec![100_000.0, 10_000.0, 1_000.0];
    args.row_group_size = 8;
    cogp::convert::run(args).unwrap();
    cogp::validate::run(&output).unwrap();

    let reader = Reader::open(&output).unwrap();
    assert!(reader.cogp_meta().overviews.is_none());
    assert!(reader.levels().iter().all(|level| level.lod.is_none()));
    assert_eq!(reader.lod_for_resolution(1_000.0), None);
    let all_row_groups: Vec<usize> = (0..reader.num_row_groups()).collect();
    let batches: Vec<RecordBatch> = reader
        .sync_batch_reader(File::open(&output).unwrap(), &all_row_groups)
        .unwrap()
        .map(|batch| batch.unwrap())
        .collect();
    let schema = batches[0].schema();
    assert!(schema.field_with_name("geometry").is_ok());
    assert!(schema.field_with_name("overviews").is_err());
    assert_eq!(batches.iter().map(RecordBatch::num_rows).sum::<usize>(), 8);
}

#[test]
fn convert_rejects_non_positive_resolution() {
    let tmp = TempDir::new("bad-resolution");
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
        Field::new("bbox", DataType::Struct(bbox_struct_fields.clone()), false),
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
    let batch = RecordBatch::try_new(schema.clone(), vec![id_arr, bbox_arr, geom_arr]).unwrap();

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
fn convert_row_group_size_is_a_row_limit() {
    let tmp = TempDir::new("row-group-rows");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("out.cogp.parquet");
    write_input(&input);

    let mut args = convert_args(&input, &output);
    // These polygons span many cells at this resolution. Their spatial
    // footprint must not reduce the configured eight-row group limit.
    args.resolution = vec![1.0];
    args.row_group_size = 8;
    cogp::convert::run(args).unwrap();

    let reader = Reader::open(&output).unwrap();
    assert_eq!(reader.num_row_groups(), 5);
    assert!(reader
        .parquet_metadata()
        .row_groups()
        .iter()
        .all(|group| group.num_rows() <= 8));
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
fn convert_preserves_refinement_without_new_features() {
    let tmp = TempDir::new("refinement");
    let input = tmp.path().join("input.parquet");
    let output = tmp.path().join("output.parquet");
    write_line_input(&input, &[vec![(0.4, 0.4), (50.4, 3.4), (100.4, 0.4)]]);
    let mut args = convert_args(&input, &output);
    args.input_units = InputUnits::Meters;
    args.resolution = vec![256.0, 8.0, 4.0, 1.0, 0.5];
    cogp::convert::run(args).unwrap();
    cogp::validate::run(&output).unwrap();
    let reader = Reader::open(&output).unwrap();
    assert_eq!(reader.cogp_meta().version, "0.2.0");
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
            .downcast_ref::<StructArray>()
            .unwrap()
            .column_by_name("coordinates")
            .unwrap()
            .as_any()
            .downcast_ref::<ListArray>()
            .unwrap()
            .value_length(0)
    };
    assert_eq!(coordinate_count("l0"), 2);
    assert_eq!(coordinate_count("l3"), 3);
}

// Preserve row-group boundaries and data while varying only the contract under
// test. This also supplies a bbox-without-ColumnIndex interoperability fixture.
fn rewrite_contract(
    source: &std::path::Path,
    output: &std::path::Path,
    cogp: &cogp::meta::CogpMeta,
) {
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
        if entry.key != "ARROW:schema" && entry.key != "cogp" {
            writer.append_key_value_metadata(entry.clone());
        }
    }
    writer.append_key_value_metadata(KeyValue {
        key: "cogp".into(),
        value: Some(serde_json::to_string(cogp).unwrap()),
    });
    writer.close().unwrap();
}

#[test]
fn shared_lod_contract_and_legacy_interoperability() {
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
    args.input_units = InputUnits::Meters;
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

    let mut shared = reader.cogp_meta().clone();
    shared.levels.insert(
        1,
        cogp::meta::Level {
            row_group_end: 0,
            resolution: 4.0,
            lod: Some("l1".into()),
        },
    );
    let shared_file = tmp.path().join("shared.parquet");
    rewrite_contract(&output, &shared_file, &shared);
    cogp::validate::run(&shared_file).unwrap();
    let shared_reader = Reader::open(&shared_file).unwrap();
    assert_eq!(shared_reader.cogp_meta().lod_row_group_end("l1"), Some(1));
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
            lod: Some("l0".into()),
        },
    );
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

    // A strict-boundary 0.2 file remains interoperable with the refined rules.
    let legacy_output = tmp.path().join("legacy-source.parquet");
    let mut args = convert_args(&input, &legacy_output);
    args.input_units = InputUnits::Meters;
    args.resolution = vec![8.0, 1.0];
    cogp::convert::run(args).unwrap();
    let mut legacy = Reader::open(&legacy_output).unwrap().cogp_meta().clone();
    legacy.version = "0.2.0".into();
    let legacy_file = tmp.path().join("legacy.parquet");
    rewrite_contract(&legacy_output, &legacy_file, &legacy);
    cogp::validate::run(&legacy_file).unwrap();
    assert_eq!(
        Reader::open(&legacy_file).unwrap().cogp_meta().version,
        "0.2.0"
    );

    // Explicit opt-in regenerates the small checked-in JS contract fixtures.
    if let Some(directory) = std::env::var_os("COGP_TEST_FIXTURE_DIR") {
        let directory = PathBuf::from(directory);
        std::fs::create_dir_all(&directory).unwrap();
        for file in [&output, &shared_file, &legacy_file] {
            std::fs::copy(file, directory.join(file.file_name().unwrap())).unwrap();
        }
    }
}
