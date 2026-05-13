use anyhow::{anyhow, bail, Context, Result};
use arrow::array::{Array, ArrayRef, BinaryArray, Float64Array, LargeBinaryArray, RecordBatch, StructArray, UInt32Array};
use arrow::compute::{concat_batches, take};
use arrow::datatypes::{DataType, Field, Fields, Schema};
use clap::Args;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::arrow::ArrowWriter;
use parquet::file::properties::WriterProperties;
use parquet::file::metadata::KeyValue;
use parquet::basic::Compression;
use parquet::basic::ZstdLevel;
use parquet::schema::types::ColumnPath;
use rayon::prelude::*;
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::path::PathBuf;
use std::sync::mpsc::sync_channel;
use std::sync::Arc;
use std::thread;

use crate::meta::{
    default_generator, BboxCovering, CogpMeta, Covering, GeoColumn, GeoMeta, Lod,
    COGP_METADATA_KEY, COGP_VERSION, GEOPARQUET_VERSION, GEO_METADATA_KEY,
};
use crate::wkb_bbox::{bbox_from_wkb, Bbox};

#[derive(Args)]
pub struct ConvertArgs {
    /// Input GeoParquet 1.x file
    pub input: PathBuf,
    /// Output COGP file
    pub output: PathBuf,
    /// Comma-separated GSD list, meters, coarse to fine (e.g. 1000,500,100,50).
    /// If omitted, GSDs are auto-derived from --minzoom..=--maxzoom using the
    /// Web Mercator per-pixel resolution at the equator.
    #[arg(long, value_delimiter = ',', num_args = 1.., conflicts_with_all = ["minzoom", "maxzoom"])]
    pub gsd: Vec<f64>,
    /// Coarsest Web Mercator zoom level (used only when --gsd is omitted)
    #[arg(long, default_value_t = 0)]
    pub minzoom: u32,
    /// Finest Web Mercator zoom level (used only when --gsd is omitted)
    #[arg(long, default_value_t = 16)]
    pub maxzoom: u32,
    /// Parquet row group size in rows
    #[arg(long, default_value_t = 10000)]
    pub row_group_size: usize,
    /// Coordinate units in the input file. `auto` (default) inspects the GeoParquet
    /// `crs` PROJJSON: `ProjectedCRS` → meters, otherwise degrees. Override with
    /// `degrees` or `meters` if needed.
    #[arg(long, default_value = "auto")]
    pub input_units: InputUnits,
    /// Override auto-detected primary geometry column
    #[arg(long)]
    pub geometry_column: Option<String>,
    /// Base resolution per tile side (units) used to derive the LoD thinning
    /// grid when auto-deriving GSDs from zoom. The LoD-i GSD is the ground
    /// distance covered by one base unit at zoom i (≈ `40_075_016 / (base ·
    /// 2^i)` meters at the equator). Independent of the renderer's MVT
    /// coordinate extent — this controls *thinning* granularity, not output
    /// coordinate precision. The default of 512 matches MapLibre's 512-pixel
    /// tile rendering. Ignored when `--gsd` is given.
    #[arg(long, default_value_t = 512)]
    pub base_resolution: u32,
    /// Point-like features (zero-area bbox) use a thinning grid this many
    /// times coarser than `prec` per axis, yielding ~factor² fewer points
    /// per LoD than polygons. Compensates for the fact that polygons span
    /// multiple cells visually while points occupy one, so equal grid
    /// density looks too dense for points. `1` disables (legacy behavior).
    #[arg(long, default_value_t = 4)]
    pub point_thinning_factor: u32,
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
pub enum InputUnits {
    /// Detect from the GeoParquet `crs` field (ProjectedCRS → meters, else degrees).
    Auto,
    Degrees,
    Meters,
}

/// Inspect the GeoParquet column `crs` PROJJSON value to guess coordinate units.
/// Absent / null `crs` defaults to OGC:CRS84 (degrees).
fn detect_input_units(input_geo: Option<&GeoMeta>, geom_col: &str) -> InputUnits {
    let Some(geo) = input_geo else {
        return InputUnits::Degrees;
    };
    let Some(col) = geo.columns.get(geom_col) else {
        return InputUnits::Degrees;
    };
    let Some(crs) = col.crs.as_ref() else {
        return InputUnits::Degrees;
    };
    if crs.is_null() {
        return InputUnits::Degrees;
    }
    fn classify(v: &serde_json::Value) -> Option<InputUnits> {
        let t = v.get("type")?.as_str()?;
        if t.contains("Projected") {
            return Some(InputUnits::Meters);
        }
        if t.contains("Geographic") {
            return Some(InputUnits::Degrees);
        }
        if t == "BoundCRS" {
            return v.get("source_crs").and_then(classify);
        }
        None
    }
    classify(crs).unwrap_or(InputUnits::Degrees)
}

/// Web Mercator equatorial circumference, used as `2π · 6_378_137 m`.
const WEB_MERCATOR_CIRCUMFERENCE_M: f64 = 40_075_016.685_578_488;

/// Ground distance per base unit at the equator at zoom 0, for a tile sliced
/// into `base_resolution` units per side. The default of 512 yields ~78272 m
/// per unit at zoom 0 — the smallest distance the thinning grid distinguishes
/// at the coarsest LoD.
fn base_unit_gsd_z0(base_resolution: u32) -> f64 {
    WEB_MERCATOR_CIRCUMFERENCE_M / (base_resolution as f64)
}

fn web_mercator_gsds(minzoom: u32, maxzoom: u32, base_resolution: u32) -> Vec<f64> {
    let z0 = base_unit_gsd_z0(base_resolution);
    (minzoom..=maxzoom)
        .map(|z| z0 / (1u64 << z) as f64)
        .collect()
}

pub fn run(args: ConvertArgs) -> Result<()> {
    let gsds: Vec<f64> = if !args.gsd.is_empty() {
        args.gsd.clone()
    } else {
        if args.minzoom > args.maxzoom {
            bail!(
                "--minzoom ({}) must be <= --maxzoom ({})",
                args.minzoom,
                args.maxzoom
            );
        }
        if args.maxzoom > 30 {
            bail!("--maxzoom must be <= 30 (got {})", args.maxzoom);
        }
        if args.base_resolution == 0 {
            bail!(
                "--base-resolution must be > 0 (got {})",
                args.base_resolution
            );
        }
        let derived = web_mercator_gsds(args.minzoom, args.maxzoom, args.base_resolution);
        eprintln!(
            "      auto-derived {} LoD(s) from Web Mercator z{}..=z{} (base resolution {})",
            derived.len(),
            args.minzoom,
            args.maxzoom,
            args.base_resolution,
        );
        derived
    };
    for w in gsds.windows(2) {
        if !(w[0] > w[1]) {
            bail!("GSD values must be strictly decreasing, got {:?}", gsds);
        }
    }
    for g in &gsds {
        if !(*g > 0.0) {
            bail!("GSD values must be positive, got {:?}", gsds);
        }
    }

    eprintln!("[1/4] Reading input: {}", args.input.display());
    let file = File::open(&args.input)
        .with_context(|| format!("opening {}", args.input.display()))?;
    let builder = ParquetRecordBatchReaderBuilder::try_new(file)?;

    let input_schema = builder.schema().clone();
    let pq_meta = builder.metadata().clone();
    let input_kv = pq_meta
        .file_metadata()
        .key_value_metadata()
        .cloned()
        .unwrap_or_default();
    let input_geo: Option<GeoMeta> = input_kv
        .iter()
        .find(|kv| kv.key == GEO_METADATA_KEY)
        .and_then(|kv| kv.value.as_ref())
        .and_then(|v| serde_json::from_str(v).ok());

    let geom_col_name = if let Some(c) = &args.geometry_column {
        c.clone()
    } else if let Some(g) = &input_geo {
        g.primary_column.clone()
    } else {
        guess_geometry_column(&input_schema)
            .ok_or_else(|| anyhow!("could not auto-detect geometry column; pass --geometry-column"))?
    };
    let geom_col_idx = input_schema
        .index_of(&geom_col_name)
        .with_context(|| format!("geometry column `{geom_col_name}` not found"))?;
    eprintln!("      geometry column: {geom_col_name}");

    let input_units = match args.input_units {
        InputUnits::Auto => {
            let detected = detect_input_units(input_geo.as_ref(), &geom_col_name);
            eprintln!(
                "      input units (auto): {}",
                match detected {
                    InputUnits::Degrees => "degrees",
                    InputUnits::Meters => "meters",
                    InputUnits::Auto => unreachable!(),
                }
            );
            detected
        }
        explicit => explicit,
    };

    let reader = builder.build()?;
    let mut input_batches = Vec::new();
    for batch in reader {
        input_batches.push(batch?);
    }
    let table: RecordBatch = if input_batches.is_empty() {
        bail!("input file has no rows");
    } else {
        concat_batches(&input_schema, &input_batches)?
    };
    let n_rows = table.num_rows();
    eprintln!("      features: {n_rows}");

    let (bboxes, existing_bbox_col) =
        match read_existing_bboxes(&table, input_geo.as_ref(), &geom_col_name) {
            Some((name, bb)) => {
                eprintln!("[2/4] Reusing existing bbox column `{name}` from input");
                (bb, Some(name))
            }
            None => {
                eprintln!("[2/4] Computing per-feature bbox from WKB");
                (compute_bboxes(&table, geom_col_idx)?, None)
            }
        };

    if args.point_thinning_factor == 0 {
        bail!(
            "--point-thinning-factor must be >= 1 (got {})",
            args.point_thinning_factor
        );
    }
    eprintln!("[3/4] Assigning features to {} LoD(s)", gsds.len());
    let assignment = assign_lods(&bboxes, &gsds, input_units, args.point_thinning_factor)?;
    let mut per_lod_full: Vec<Vec<u32>> = vec![Vec::new(); gsds.len()];
    for (idx, lod_i) in assignment.iter().enumerate() {
        per_lod_full[*lod_i as usize].push(idx as u32);
    }
    // SPEC §5.3 requires each LoD entry to have a real row group end; a LoD with zero
    // features cannot be represented. Drop empty LoDs and keep the GSDs that survive.
    let mut gsds: Vec<f64> = gsds;
    let mut per_lod: Vec<Vec<u32>> = Vec::with_capacity(per_lod_full.len());
    let mut kept_gsds: Vec<f64> = Vec::with_capacity(gsds.len());
    let mut dropped = 0usize;
    for (rows, g) in per_lod_full.into_iter().zip(gsds.iter().copied()) {
        if rows.is_empty() {
            dropped += 1;
        } else {
            per_lod.push(rows);
            kept_gsds.push(g);
        }
    }
    gsds = kept_gsds;
    if per_lod.is_empty() {
        bail!("no LoDs received any features; check input data and GSD selection");
    }
    if dropped > 0 {
        eprintln!("      note: dropped {dropped} empty LoD(s)");
    }
    for (i, rows) in per_lod.iter().enumerate() {
        eprintln!(
            "      LoD {i} (gsd={:>10.2} m): {:>9} features",
            gsds[i],
            rows.len()
        );
    }

    // STR-pack each LoD.
    for (i, rows) in per_lod.iter_mut().enumerate() {
        str_pack(rows, &bboxes, args.row_group_size);
        let _ = i;
    }

    eprintln!("[4/4] Writing COGP file: {}", args.output.display());
    // Build output schema: input schema (drop pre-existing `bbox` if any) + our bbox struct.
    let mut drop_names: Vec<String> = vec!["bbox".to_string()];
    if let Some(name) = existing_bbox_col.as_ref() {
        if !drop_names.iter().any(|n| n == name) {
            drop_names.push(name.clone());
        }
    }
    let mut output_fields: Vec<Arc<Field>> = Vec::new();
    let mut keep_col_indices: Vec<usize> = Vec::new();
    for (i, f) in input_schema.fields().iter().enumerate() {
        if drop_names.iter().any(|n| n == f.name()) {
            eprintln!("      note: dropping input column `{}` (will be overwritten)", f.name());
            continue;
        }
        output_fields.push(f.clone());
        keep_col_indices.push(i);
    }
    let bbox_field = bbox_struct_field();
    output_fields.push(Arc::new(bbox_field.clone()));
    let bbox_column_position = output_fields.len() - 1;
    let output_schema = Arc::new(Schema::new(output_fields));

    // Build full bbox struct array once.
    let bbox_struct = build_bbox_struct(&bboxes)?;

    // Compute dataset-level bbox (parallel reduce).
    let dataset_bbox = bboxes
        .par_iter()
        .fold(Bbox::empty, |mut acc, b| {
            acc.merge(b);
            acc
        })
        .reduce(Bbox::empty, |mut a, b| {
            a.merge(&b);
            a
        });

    // Disable dictionary encoding for the geometry column (WKB is high-cardinality, dict
    // is pure overhead) and for the bbox struct's float fields (each value is unique).
    let mut props_builder = WriterProperties::builder()
        .set_compression(Compression::ZSTD(ZstdLevel::try_new(3)?))
        .set_max_row_group_size(args.row_group_size)
        .set_statistics_enabled(parquet::file::properties::EnabledStatistics::Chunk)
        .set_column_dictionary_enabled(ColumnPath::from(geom_col_name.as_str()), false);
    for child in ["xmin", "ymin", "xmax", "ymax"] {
        props_builder = props_builder.set_column_dictionary_enabled(
            ColumnPath::from(vec!["bbox".to_string(), child.to_string()]),
            false,
        );
    }
    let props = props_builder.build();
    let out_file = File::create(&args.output)
        .with_context(|| format!("creating {}", args.output.display()))?;
    let mut writer = ArrowWriter::try_new(out_file, output_schema.clone(), Some(props))?;

    // Producer/consumer pipeline: a background thread builds RecordBatches (`take` per
    // column is non-trivial for wide tables) while the main thread flushes the previous
    // batch through the parquet writer. Channel capacity of 2 gives enough buffer to
    // overlap I/O without blowing up memory.
    let (tx, rx) = sync_channel::<(usize, RecordBatch)>(2);
    let producer_schema = output_schema.clone();
    let producer_table = Arc::new(table);
    let producer_bbox = Arc::new(bbox_struct);
    let producer_keep = keep_col_indices.clone();
    let producer_per_lod = per_lod.clone();
    let producer_row_group_size = args.row_group_size;
    let producer = thread::spawn(move || -> Result<()> {
        for (lod_i, rows) in producer_per_lod.iter().enumerate() {
            for chunk in rows.chunks(producer_row_group_size) {
                let indices = UInt32Array::from(chunk.to_vec());
                let mut cols: Vec<ArrayRef> =
                    Vec::with_capacity(producer_schema.fields().len());
                for ki in &producer_keep {
                    cols.push(take(producer_table.column(*ki).as_ref(), &indices, None)?);
                }
                let bbox_arr: ArrayRef = Arc::new((*producer_bbox).clone());
                cols.push(take(bbox_arr.as_ref(), &indices, None)?);
                let batch = RecordBatch::try_new(producer_schema.clone(), cols)?;
                if tx.send((lod_i, batch)).is_err() {
                    // consumer dropped the channel (e.g. parquet write failed)
                    return Ok(());
                }
            }
        }
        Ok(())
    });

    let _ = bbox_column_position;
    let mut current_rg: i64 = -1;
    let mut last_lod: Option<usize> = None;
    let mut lods_meta: Vec<Lod> = Vec::with_capacity(gsds.len());
    while let Ok((lod_i, batch)) = rx.recv() {
        if let Some(prev) = last_lod {
            if prev != lod_i {
                lods_meta.push(Lod {
                    row_group_end: current_rg,
                    gsd: gsds[prev],
                });
            }
        }
        writer.write(&batch)?;
        writer.flush()?;
        current_rg += 1;
        last_lod = Some(lod_i);
    }
    if let Some(prev) = last_lod {
        lods_meta.push(Lod {
            row_group_end: current_rg,
            gsd: gsds[prev],
        });
    }
    producer
        .join()
        .map_err(|e| anyhow!("batch producer panicked: {:?}", e))??;

    // Build geo metadata: preserve original column metadata if available, override covering + bbox.
    let mut columns: BTreeMap<String, GeoColumn> = BTreeMap::new();
    if let Some(g) = &input_geo {
        if let Some(orig) = g.columns.get(&geom_col_name) {
            let mut c = orig.clone();
            c.covering = Some(default_covering());
            c.bbox = Some(vec![
                dataset_bbox.xmin,
                dataset_bbox.ymin,
                dataset_bbox.xmax,
                dataset_bbox.ymax,
            ]);
            columns.insert(geom_col_name.clone(), c);
        }
    }
    columns.entry(geom_col_name.clone()).or_insert_with(|| GeoColumn {
        encoding: "WKB".to_string(),
        geometry_types: Vec::new(),
        covering: Some(default_covering()),
        bbox: Some(vec![
            dataset_bbox.xmin,
            dataset_bbox.ymin,
            dataset_bbox.xmax,
            dataset_bbox.ymax,
        ]),
        crs: None,
    });
    let geo_meta = GeoMeta {
        version: GEOPARQUET_VERSION.to_string(),
        primary_column: geom_col_name.clone(),
        columns,
    };
    let cogp_meta = CogpMeta {
        version: COGP_VERSION.to_string(),
        lods: lods_meta,
        generator: Some(default_generator()),
    };

    writer.append_key_value_metadata(KeyValue {
        key: GEO_METADATA_KEY.to_string(),
        value: Some(serde_json::to_string(&geo_meta)?),
    });
    writer.append_key_value_metadata(KeyValue {
        key: COGP_METADATA_KEY.to_string(),
        value: Some(serde_json::to_string(&cogp_meta)?),
    });
    let _ = writer.close()?;

    eprintln!(
        "      wrote {} row group(s) across {} LoD(s)",
        current_rg + 1,
        cogp_meta.lods.len()
    );
    Ok(())
}

fn default_covering() -> Covering {
    Covering {
        bbox: BboxCovering {
            xmin: vec!["bbox".into(), "xmin".into()],
            ymin: vec!["bbox".into(), "ymin".into()],
            xmax: vec!["bbox".into(), "xmax".into()],
            ymax: vec!["bbox".into(), "ymax".into()],
        },
    }
}

fn bbox_struct_field() -> Field {
    let fields = Fields::from(vec![
        Field::new("xmin", DataType::Float64, false),
        Field::new("ymin", DataType::Float64, false),
        Field::new("xmax", DataType::Float64, false),
        Field::new("ymax", DataType::Float64, false),
    ]);
    Field::new("bbox", DataType::Struct(fields), false)
}

fn build_bbox_struct(bboxes: &[Bbox]) -> Result<StructArray> {
    let xmin: ArrayRef = Arc::new(Float64Array::from(
        bboxes.par_iter().map(|b| b.xmin).collect::<Vec<_>>(),
    ));
    let ymin: ArrayRef = Arc::new(Float64Array::from(
        bboxes.par_iter().map(|b| b.ymin).collect::<Vec<_>>(),
    ));
    let xmax: ArrayRef = Arc::new(Float64Array::from(
        bboxes.par_iter().map(|b| b.xmax).collect::<Vec<_>>(),
    ));
    let ymax: ArrayRef = Arc::new(Float64Array::from(
        bboxes.par_iter().map(|b| b.ymax).collect::<Vec<_>>(),
    ));
    let fields = Fields::from(vec![
        Field::new("xmin", DataType::Float64, false),
        Field::new("ymin", DataType::Float64, false),
        Field::new("xmax", DataType::Float64, false),
        Field::new("ymax", DataType::Float64, false),
    ]);
    Ok(StructArray::try_new(
        fields,
        vec![xmin, ymin, xmax, ymax],
        None,
    )?)
}

fn guess_geometry_column(schema: &Schema) -> Option<String> {
    for f in schema.fields() {
        let n = f.name();
        if matches!(f.data_type(), DataType::Binary | DataType::LargeBinary)
            && (n == "geometry" || n == "geom" || n == "wkb")
        {
            return Some(n.clone());
        }
    }
    for f in schema.fields() {
        if matches!(f.data_type(), DataType::Binary | DataType::LargeBinary) {
            return Some(f.name().clone());
        }
    }
    None
}

/// If the input declares a bbox covering column (GeoParquet 1.1 `covering.bbox`),
/// read the per-row bboxes directly from it instead of recomputing from WKB.
/// Returns `None` if the metadata is missing, the referenced column is not a
/// top-level Float64 struct with the expected children, or any value is null.
fn read_existing_bboxes(
    table: &RecordBatch,
    input_geo: Option<&GeoMeta>,
    geom_col: &str,
) -> Option<(String, Vec<Bbox>)> {
    let covering = input_geo?.columns.get(geom_col)?.covering.as_ref()?;
    let b = &covering.bbox;
    if b.xmin.len() != 2 || b.ymin.len() != 2 || b.xmax.len() != 2 || b.ymax.len() != 2 {
        return None;
    }
    let col_name = &b.xmin[0];
    if &b.ymin[0] != col_name || &b.xmax[0] != col_name || &b.ymax[0] != col_name {
        return None;
    }
    let col_idx = table.schema().index_of(col_name).ok()?;
    let struct_arr = table
        .column(col_idx)
        .as_any()
        .downcast_ref::<StructArray>()?;
    let get = |name: &str| -> Option<&Float64Array> {
        struct_arr
            .column_by_name(name)?
            .as_any()
            .downcast_ref::<Float64Array>()
    };
    let xmin = get(&b.xmin[1])?;
    let ymin = get(&b.ymin[1])?;
    let xmax = get(&b.xmax[1])?;
    let ymax = get(&b.ymax[1])?;
    let n = table.num_rows();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        if xmin.is_null(i) || ymin.is_null(i) || xmax.is_null(i) || ymax.is_null(i) {
            return None;
        }
        out.push(Bbox {
            xmin: xmin.value(i),
            ymin: ymin.value(i),
            xmax: xmax.value(i),
            ymax: ymax.value(i),
        });
    }
    Some((col_name.clone(), out))
}

fn compute_bboxes(table: &RecordBatch, geom_col_idx: usize) -> Result<Vec<Bbox>> {
    let col = table.column(geom_col_idx);
    let n = col.len();
    if let Some(arr) = col.as_any().downcast_ref::<BinaryArray>() {
        (0..n)
            .into_par_iter()
            .map(|i| {
                if arr.is_null(i) {
                    bail!("null geometry at row {i}");
                }
                bbox_from_wkb(arr.value(i))
            })
            .collect()
    } else if let Some(arr) = col.as_any().downcast_ref::<LargeBinaryArray>() {
        (0..n)
            .into_par_iter()
            .map(|i| {
                if arr.is_null(i) {
                    bail!("null geometry at row {i}");
                }
                bbox_from_wkb(arr.value(i))
            })
            .collect()
    } else {
        bail!(
            "geometry column has unsupported type `{:?}`; only WKB Binary/LargeBinary is supported",
            col.data_type()
        );
    }
}

/// Grid-based density thinning. Returns an assignment of each row to a LoD index.
///
/// For each LoD (coarse → fine), bucket remaining features into grid cells of side
/// `prec` (the LoD's GSD in input CRS units). Within each cell, pick the highest-
/// priority feature to assign to this LoD; the rest fall through to the next LoD.
///
/// Features whose bbox is smaller than `prec` are deferred to a finer LoD where they
/// become independently meaningful — except point-like features (size <= 0) which
/// are always eligible from the coarsest LoD.
fn assign_lods(
    bboxes: &[Bbox],
    gsds: &[f64],
    units: InputUnits,
    point_thinning_factor: u32,
) -> Result<Vec<u16>> {
    // WGS84 equatorial circumference / 360°: meters per degree of longitude at the equator.
    // Used only as a rendering-grade scale factor — see the README note on geodesy.
    const METERS_PER_DEGREE: f64 = 111_320.0;

    let n = bboxes.len();
    let mut assigned: Vec<i32> = vec![-1; n];
    let mut remaining: Vec<u32> = (0..n as u32).collect();
    let last_lod = (gsds.len() - 1) as u16;

    let precs: Vec<f64> = gsds
        .iter()
        .map(|g| match units {
            InputUnits::Degrees => g / METERS_PER_DEGREE,
            InputUnits::Meters => *g,
            InputUnits::Auto => unreachable!("Auto must be resolved before assign_lods"),
        })
        .collect();

    // Zero-area bbox → point-like (true Point or coincident multi-point). These need
    // a coarser grid than extent features: polygons of size==prec span ~1 cell so 1
    // pick/cell already overlaps visually, but points are point-sized so a full cell
    // grid renders saturated. Multiplying prec by `point_thinning_factor` per axis
    // gives ~factor² fewer points per LoD.
    let is_point: Vec<bool> = bboxes
        .par_iter()
        .map(|b| b.width() <= 0.0 && b.height() <= 0.0)
        .collect();
    let point_mul = point_thinning_factor as f64;

    // For each feature, the coarsest LoD index at which it becomes independently meaningful.
    let min_visible: Vec<u16> = bboxes
        .par_iter()
        .map(|b| {
            let size = b.width().max(b.height());
            if size <= 0.0 {
                return 0u16;
            }
            for (i, prec) in precs.iter().enumerate() {
                if size >= *prec {
                    return i as u16;
                }
            }
            last_lod
        })
        .collect();

    for (lod_i, prec) in precs.iter().enumerate() {
        // Build the per-cell winner map in parallel: each rayon thread accumulates a
        // local HashMap, then the reduce step merges them, picking the higher priority
        // entry on collisions. This keeps the priority semantics identical to the
        // sequential version (priority is a total order on (area_bits, row_hash)).
        // Key namespaced by feature kind because point cells use a different grid
        // pitch (prec*point_mul) than polygon cells (prec); without the kind tag,
        // a point cell (i,j) and a polygon cell (i,j) would collide in the map
        // despite representing entirely different physical regions.
        let best: HashMap<(u8, i64, i64), u32> = remaining
            .par_iter()
            .fold(HashMap::new, |mut local, &row| {
                if min_visible[row as usize] as usize > lod_i {
                    return local;
                }
                let b = bboxes[row as usize];
                let pt = is_point[row as usize];
                let eff_prec = if pt { prec * point_mul } else { *prec };
                let key = (
                    pt as u8,
                    (b.cx() / eff_prec).floor() as i64,
                    (b.cy() / eff_prec).floor() as i64,
                );
                match local.get(&key) {
                    None => {
                        local.insert(key, row);
                    }
                    Some(&cur) => {
                        if priority(&bboxes[row as usize], row)
                            > priority(&bboxes[cur as usize], cur)
                        {
                            local.insert(key, row);
                        }
                    }
                }
                local
            })
            .reduce(HashMap::new, |mut a, mut b| {
                if a.len() < b.len() {
                    std::mem::swap(&mut a, &mut b);
                }
                for (k, row) in b {
                    match a.get(&k) {
                        None => {
                            a.insert(k, row);
                        }
                        Some(&cur) => {
                            if priority(&bboxes[row as usize], row)
                                > priority(&bboxes[cur as usize], cur)
                            {
                                a.insert(k, row);
                            }
                        }
                    }
                }
                a
            });
        let picked: Vec<u32> = best.values().copied().collect();
        for r in &picked {
            assigned[*r as usize] = lod_i as i32;
        }
        let picked_set: std::collections::HashSet<u32> = picked.iter().copied().collect();
        remaining.retain(|r| !picked_set.contains(r));
        if remaining.is_empty() {
            break;
        }
    }
    // Anything left over → finest LoD.
    for r in remaining {
        assigned[r as usize] = last_lod as i32;
    }
    let mut out: Vec<u16> = Vec::with_capacity(n);
    for (i, a) in assigned.iter().enumerate() {
        if *a < 0 {
            bail!("internal: row {i} was never assigned");
        }
        out.push(*a as u16);
    }
    Ok(out)
}

fn priority(b: &Bbox, row: u32) -> (u64, u64) {
    // Primary: area (encoded as bits for total ordering); secondary: hash of row for stable tie-break.
    let area = b.width().max(0.0) * b.height().max(0.0);
    let area_bits = if area.is_finite() && area >= 0.0 {
        area.to_bits()
    } else {
        0
    };
    let mut h = row as u64;
    h = h.wrapping_mul(0x9E3779B97F4A7C15);
    h ^= h >> 30;
    (area_bits, h)
}

/// Sort-Tile-Recursive packing: divide into ~sqrt(N/M) strips by center-x, then sort by
/// center-y inside each strip with boustrophedon (alternating direction across strips).
fn str_pack(rows: &mut Vec<u32>, bboxes: &[Bbox], row_group_size: usize) {
    let n = rows.len();
    if n <= row_group_size {
        rows.par_sort_by(|a, b| {
            bboxes[*a as usize]
                .cx()
                .partial_cmp(&bboxes[*b as usize].cx())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        return;
    }
    let m = row_group_size as f64;
    let strips = (((n as f64) / m).sqrt().round() as usize).max(1);
    let strip_size = (strips * row_group_size).max(row_group_size);
    rows.par_sort_by(|a, b| {
        bboxes[*a as usize]
            .cx()
            .partial_cmp(&bboxes[*b as usize].cx())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    // Each strip is sorted by center-y independently → parallel across strips.
    rows.par_chunks_mut(strip_size)
        .enumerate()
        .for_each(|(strip_id, slice)| {
            if strip_id % 2 == 0 {
                slice.sort_by(|a, b| {
                    bboxes[*a as usize]
                        .cy()
                        .partial_cmp(&bboxes[*b as usize].cy())
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
            } else {
                slice.sort_by(|a, b| {
                    bboxes[*b as usize]
                        .cy()
                        .partial_cmp(&bboxes[*a as usize].cy())
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
            }
        });
}
