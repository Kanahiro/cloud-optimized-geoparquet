use arrow_array::{Array, StructArray};
use cogp::reader::Reader;
use std::fs::File;
use std::path::PathBuf;

#[test]
fn nested_overviews_are_readable_for_each_geometry_family() {
    for kind in ["linestring", "multilinestring", "polygon", "multipolygon"] {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../test-data/quantized-geoarrow-{kind}.parquet"));
        let reader = Reader::open(&path).unwrap();
        let batches = reader
            .sync_batch_reader(File::open(&path).unwrap(), &[0, 1, 2])
            .unwrap();
        let mut rows = 0;
        let mut coarse_nulls = 0;
        for batch in batches {
            let batch = batch.unwrap();
            let root = batch
                .column_by_name("render_geometry")
                .unwrap()
                .as_any()
                .downcast_ref::<StructArray>()
                .unwrap();
            rows += batch.num_rows();
            coarse_nulls += root.column_by_name("coarse").unwrap().null_count();
            assert_eq!(root.column_by_name("fine").unwrap().null_count(), 0);
            assert!(batch.column_by_name("overviews").is_some());
        }
        assert_eq!(rows, 3);
        assert_eq!(coarse_nulls, 2);
        cogp::validate::run(&path).unwrap();
    }
}

#[test]
fn overviews_allow_a_custom_column_name() {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test-data/renamed-overview.parquet");
    let reader = Reader::open(&path).unwrap();
    assert!(reader.has_overviews());
    assert_eq!(
        reader.lod_meta().overviews.as_ref().unwrap().column,
        "render_geometry"
    );
    cogp::validate::run(&path).unwrap();
}

#[test]
fn overviews_require_an_explicit_nonempty_column_and_geometry_type() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/metadata-overviews.json")).unwrap();
    let mut value = fixture.clone();
    value["overviews"].as_object_mut().unwrap().remove("column");
    let error = serde_json::from_value::<cogp::meta::LodMeta>(value.clone()).unwrap_err();
    assert!(error.to_string().contains("column"));
    value["overviews"]["column"] = "".into();
    let metadata: cogp::meta::LodMeta = serde_json::from_value(value).unwrap();
    assert!(metadata
        .validate(4)
        .unwrap_err()
        .to_string()
        .contains("column"));

    let mut value = fixture;
    value["overviews"]["lods"]["l0"]
        .as_object_mut()
        .unwrap()
        .remove("geometry_type");
    let metadata: cogp::meta::LodMeta = serde_json::from_value(value).unwrap();
    assert!(metadata
        .validate(4)
        .unwrap_err()
        .to_string()
        .contains("geometry_type"));
}
