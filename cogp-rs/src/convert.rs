use anyhow::{anyhow, bail, Context, Result};
use arrow::array::{
    Array, ArrayRef, BinaryArray, Float64Array, GenericBinaryArray, Int32Builder, Int8Array,
    LargeBinaryArray, LargeStringArray, ListBuilder, OffsetSizeTrait, RecordBatch, StringArray,
    StructArray, StructBuilder,
};
use arrow::compute::{cast, concat, interleave, rank, SortOptions};
use arrow::datatypes::{DataType, Field, Fields, Schema};
use arrow_buffer::NullBuffer;
use clap::Args;
use parquet::arrow::arrow_reader::{
    ArrowReaderMetadata, ParquetRecordBatchReaderBuilder, RowSelection, RowSelector,
};
use parquet::arrow::{ArrowWriter, ProjectionMask};
use parquet::basic::ZstdLevel;
use parquet::basic::{Compression, Encoding};
use parquet::file::metadata::KeyValue;
use parquet::file::properties::{EnabledStatistics, WriterProperties};
use parquet::schema::types::ColumnPath;
use rayon::prelude::*;
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::sync_channel;
use std::sync::Arc;
use std::thread;

use crate::meta::{
    geometry_family, BboxCovering, CogpMeta, Covering, GeoColumn, GeoMeta, GeometryFamily, Level,
    LodMeta, OverviewsMeta, GEOPARQUET_VERSION, GEO_METADATA_KEY, OVERVIEWS_COLUMN,
    OVERVIEWS_ENCODING,
};
use crate::wkb_bbox::{bbox_from_wkb, kind_from_wkb, Bbox, GeomKind};

use crate::wkb_simplify::{
    first_viable_level, overview_scale, quantized_overview_with_fallback, QuantizedOverview,
};

#[derive(Args)]
pub struct ConvertArgs {
    /// Input GeoParquet 1.x file
    pub input: PathBuf,
    /// Output COGP file
    pub output: PathBuf,
    /// Comma-separated rendering resolutions in primary geometry CRS units, coarse to fine.
    /// For geographic coordinates use degrees; for projected coordinates use their horizontal units.
    /// If omitted, resolutions are auto-derived
    /// from --webmerc-minzoom..=--webmerc-maxzoom assuming a Web Mercator tile
    /// pyramid (see --webmerc-minzoom/--webmerc-maxzoom/--webmerc-resolution).
    /// Pass --resolution directly if you target a non-Web-Mercator renderer.
    #[arg(long, value_delimiter = ',', num_args = 1.., conflicts_with_all = ["webmerc_minzoom", "webmerc_maxzoom"])]
    pub resolution: Vec<f64>,
    /// Coarsest Web Mercator zoom level for Resolution auto-derivation. Used only
    /// when --resolution is omitted. Assumes the consumer renders on a Web Mercator
    /// (EPSG:3857) tile pyramid; for other projections, supply --resolution.
    #[arg(long, default_value_t = 0)]
    pub webmerc_minzoom: u32,
    /// Finest Web Mercator zoom level for Resolution auto-derivation. Used only
    /// when --resolution is omitted. Same Web Mercator assumption as --webmerc-minzoom.
    #[arg(long, default_value_t = 16)]
    pub webmerc_maxzoom: u32,
    /// Minimum cumulative feature count for the coarsest output level.
    /// Sparse coarse levels are folded into the first level reaching this count.
    /// If the entire input is smaller, all rows use the finest requested level.
    /// Set to 1 to retain the first occupied level.
    #[arg(long, default_value_t = 2048)]
    pub min_root_features: usize,
    /// Maximum Parquet row group size in rows.
    #[arg(long, default_value_t = 65_536)]
    pub row_group_size: usize,
    /// Simplification tolerance in multiples of the CRS-unit resolution.
    #[arg(long, default_value_t = 1.0)]
    pub simplification_tolerance_factor: f64,
    /// Maximum top-level rows per data page. Page indexes and spatial page
    /// packing are always enabled; smaller pages permit finer spatial pruning.
    #[arg(long, default_value_t = 2048)]
    pub page_row_count: usize,
    /// **Web Mercator only.** Base resolution per tile side (units) used to
    /// derive level visibility thresholds and the point-thinning grid when
    /// auto-deriving resolutions from
    /// --webmerc-minzoom/--webmerc-maxzoom. The level-i Resolution is the ground
    /// distance covered by one base unit at zoom i, computed as
    /// `40_075_016 / (base · 2^i)` meters at the equator — i.e. it bakes in
    /// the Web Mercator equatorial circumference and the standard `2^z` tile
    /// pyramid. This controls level granularity, not output coordinate
    /// precision. The default of 1024 is ~4× the typical 256-pixel tile
    /// resolution, so features collapsing within a few subpixels are deferred
    /// to finer levels. Ignored when --resolution is given (in that case the resolutions are
    /// taken verbatim and no projection is assumed).
    #[arg(long, default_value_t = 1024)]
    pub webmerc_resolution: u32,
    /// Point-like features (WKB Point / MultiPoint) use a thinning grid this
    /// many times coarser than `prec` per axis, yielding ~factor² fewer points
    /// per level than a factor of 1. Set to `1` for the finest supported
    /// thinning grid (one winner per resolution-sized cell).
    #[arg(long, default_value_t = 4)]
    pub point_thinning_factor: u32,
    /// Minimum line bbox diagonal in resolution units. The default uses the
    /// same four-unit visibility scale as points and polygons; this is a
    /// rendering heuristic, not a guarantee of equal perceived size.
    #[arg(long, default_value_t = 4)]
    pub line_visibility_factor: u32,
    /// Minimum polygon bbox diagonal in resolution units. Larger factors defer
    /// smaller polygons to finer levels without changing their geometries.
    #[arg(long, default_value_t = 4)]
    pub polygon_visibility_factor: u32,
    /// Attribute column deciding which feature wins when several contend for the
    /// same point-thinning cell. When set it is the primary criterion: the
    /// higher-ranked feature survives to coarser levels, so the more important
    /// one is kept instead of an arbitrary one. Bbox size only breaks ties
    /// between equal-valued features, then a deterministic row-index hash.
    /// Line and polygon features do not compete in cells, so this option does
    /// not affect their level. The
    /// column must be rank-able: numeric, boolean, or string. Rows whose value
    /// is null always lose the tie.
    #[arg(long)]
    pub priority_column: Option<String>,
    /// Direction for --priority-column: `desc` (default) keeps the feature with the
    /// largest value, `asc` keeps the smallest. Ignored when --priority-column is unset.
    #[arg(long, default_value = "desc")]
    pub priority_column_order: PriorityColumnOrder,
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
pub enum PriorityColumnOrder {
    /// Largest --priority-column value wins the cell.
    Desc,
    /// Smallest --priority-column value wins the cell.
    Asc,
}

/// Write without allowing an input batch to push a row group beyond the
/// public row-count limit. Levels explicitly flush at their boundaries.
fn write_with_row_group_limit<W: Write + Send>(
    writer: &mut ArrowWriter<W>,
    batch: &RecordBatch,
    max_rows: usize,
) -> Result<()> {
    let mut offset = 0;
    while offset < batch.num_rows() {
        if writer.in_progress_rows() >= max_rows {
            writer.flush()?;
        }
        let capacity = max_rows - writer.in_progress_rows();
        let rows = (batch.num_rows() - offset).min(capacity);
        writer.write(&batch.slice(offset, rows))?;
        offset += rows;
    }
    Ok(())
}

fn flushed_row_group_end<W: Write + Send>(writer: &ArrowWriter<W>) -> Result<i64> {
    let count = writer.flushed_row_groups().len();
    if count == 0 {
        bail!("internal error: level ended before any row group was written");
    }
    Ok((count as i64) - 1)
}

/// Convert equatorial meter hints to horizontal CRS units; never guess that
/// every projected CRS uses meters, or that explicit null means CRS84.
fn auto_resolution_scale(geo: Option<&serde_json::Value>, column: &str) -> Result<f64> {
    let Some(mut crs) = geo.and_then(|g| g["columns"][column].get("crs")) else {
        return Ok(1.0 / 111_320.0); // GeoParquet's absent CRS is CRS84.
    };
    if crs["type"] == "BoundCRS" {
        crs = &crs["source_crs"];
    }
    let unit = &crs["coordinate_system"]["axis"][0]["unit"];
    let factor = match unit.as_str() {
        Some("metre" | "meter") => Some(1.0),
        Some("degree") => Some(111_320.0),
        Some("foot") => Some(0.3048),
        Some("US survey foot") => Some(1200.0 / 3937.0),
        _ if unit["type"] == "LinearUnit" => unit["conversion_factor"].as_f64(),
        _ if unit["type"] == "AngularUnit" => unit["conversion_factor"]
            .as_f64()
            .map(|f| f * 180.0 / std::f64::consts::PI * 111_320.0),
        _ => None,
    };
    let factor = factor
        .filter(|v| v.is_finite() && *v > 0.0)
        .ok_or_else(|| anyhow!("unknown CRS units: provide --resolution in coordinate units"))?;
    Ok(1.0 / factor)
}

/// Web Mercator equatorial circumference, used as `2π · 6_378_137 m`.
const WEB_MERCATOR_CIRCUMFERENCE_M: f64 = 40_075_016.685_578_49;

/// Ground distance per base unit at the equator at zoom 0, for a tile sliced
/// into `webmerc_resolution` units per side. The default of 1024 yields
/// ~39136 m per unit at zoom 0 — the coarsest level's base visibility unit.
fn base_unit_resolution_z0(webmerc_resolution: u32) -> f64 {
    WEB_MERCATOR_CIRCUMFERENCE_M / (webmerc_resolution as f64)
}

fn web_mercator_resolutions(
    webmerc_minzoom: u32,
    webmerc_maxzoom: u32,
    webmerc_resolution: u32,
) -> Vec<f64> {
    let z0 = base_unit_resolution_z0(webmerc_resolution);
    (webmerc_minzoom..=webmerc_maxzoom)
        .map(|z| z0 / (1u64 << z) as f64)
        .collect()
}

pub fn run(args: ConvertArgs) -> Result<()> {
    let mut resolutions: Vec<f64> = if !args.resolution.is_empty() {
        args.resolution.clone()
    } else {
        if args.webmerc_minzoom > args.webmerc_maxzoom {
            bail!(
                "--webmerc-minzoom ({}) must be <= --webmerc-maxzoom ({})",
                args.webmerc_minzoom,
                args.webmerc_maxzoom
            );
        }
        if args.webmerc_maxzoom > 30 {
            bail!(
                "--webmerc-maxzoom must be <= 30 (got {})",
                args.webmerc_maxzoom
            );
        }
        if args.webmerc_resolution == 0 {
            bail!(
                "--webmerc-resolution must be > 0 (got {})",
                args.webmerc_resolution
            );
        }
        let derived = web_mercator_resolutions(
            args.webmerc_minzoom,
            args.webmerc_maxzoom,
            args.webmerc_resolution,
        );
        eprintln!(
            "      auto-derived {} level(s) from Web Mercator z{}..=z{} (resolution {})",
            derived.len(),
            args.webmerc_minzoom,
            args.webmerc_maxzoom,
            args.webmerc_resolution,
        );
        derived
    };
    // `partial_cmp` rather than `<=` / `<` so NaN values also fail the check
    // (NaN compares as `None`, which is not `Some(Greater)`).
    for w in resolutions.windows(2) {
        if w[0].partial_cmp(&w[1]) != Some(std::cmp::Ordering::Greater) {
            bail!(
                "Resolution values must be strictly decreasing, got {:?}",
                resolutions
            );
        }
    }
    for g in &resolutions {
        if !g.is_finite() || g.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
            bail!("Resolution values must be positive, got {:?}", resolutions);
        }
    }
    if args.min_root_features == 0 {
        bail!("--min-root-features must be >= 1");
    }
    if args.point_thinning_factor == 0 {
        bail!(
            "--point-thinning-factor must be >= 1 (got {})",
            args.point_thinning_factor
        );
    }
    if args.line_visibility_factor == 0 {
        bail!(
            "--line-visibility-factor must be >= 1 (got {})",
            args.line_visibility_factor
        );
    }
    if args.polygon_visibility_factor == 0 {
        bail!(
            "--polygon-visibility-factor must be >= 1 (got {})",
            args.polygon_visibility_factor
        );
    }
    if args.row_group_size == 0 {
        bail!("--row-group-size must be >= 1");
    }
    anyhow::ensure!(
        args.simplification_tolerance_factor.is_finite()
            && args.simplification_tolerance_factor > 0.0,
        "simplification tolerance factor must be positive and finite"
    );
    if args.page_row_count == 0 {
        bail!("--page-row-count must be >= 1");
    }
    eprintln!("[1/4] Reading input metadata: {}", args.input.display());
    let file =
        File::open(&args.input).with_context(|| format!("opening {}", args.input.display()))?;
    // Footer parsed once; both streaming passes below reuse it via
    // `new_with_metadata`, and each pass opens its own file handle.
    let arrow_meta = ArrowReaderMetadata::load(&file, Default::default())?;
    drop(file);

    let input_schema = arrow_meta.schema().clone();
    let input_kv = arrow_meta
        .metadata()
        .file_metadata()
        .key_value_metadata()
        .cloned()
        .unwrap_or_default();
    let input_geo_json: Option<serde_json::Value> = input_kv
        .iter()
        .find(|kv| kv.key == GEO_METADATA_KEY)
        .and_then(|kv| kv.value.as_ref())
        .map(|v| serde_json::from_str(v))
        .transpose()
        .context("invalid geo metadata")?;
    let input_geo: Option<GeoMeta> = input_geo_json
        .clone()
        .map(serde_json::from_value)
        .transpose()
        .context("invalid geo metadata fields")?;

    let geom_col_name = input_geo
        .as_ref()
        .ok_or_else(|| anyhow!("input requires GeoParquet geo metadata with primary_column"))?
        .primary_column
        .clone();
    let geom_col_idx = input_schema
        .index_of(&geom_col_name)
        .with_context(|| format!("geometry column `{geom_col_name}` not found"))?;
    eprintln!("      geometry column: {geom_col_name}");

    let n_rows = arrow_meta.metadata().file_metadata().num_rows() as usize;
    if n_rows == 0 {
        let mut geo = input_geo_json
            .clone()
            .ok_or_else(|| anyhow!("empty input requires geo metadata"))?;
        geo.as_object_mut().unwrap().remove("lod");
        geo.as_object_mut().unwrap().remove("coarse_to_fine");
        let props = WriterProperties::builder()
            .set_dictionary_enabled(false)
            .set_key_value_metadata(Some(vec![KeyValue {
                key: GEO_METADATA_KEY.into(),
                value: Some(serde_json::to_string(&geo)?),
            }]))
            .build();
        ArrowWriter::try_new(
            File::create(&args.output)?,
            input_schema.clone(),
            Some(props),
        )?
        .close()?;
        return Ok(());
    }
    // Explicit resolutions are already in coordinate units. Only auto zoom
    // hints need conversion; unknown CRS units require an explicit resolution.
    if args.resolution.is_empty() {
        let scale = auto_resolution_scale(input_geo_json.as_ref(), &geom_col_name)?;
        for value in &mut resolutions {
            *value *= scale;
            anyhow::ensure!(
                value.is_finite() && *value > 0.0,
                "auto-derived resolution is out of range"
            );
        }
    }

    eprintln!("      features: {n_rows}");

    let priority_column_idx = match &args.priority_column {
        Some(name) => Some(
            input_schema
                .index_of(name)
                .with_context(|| format!("--priority-column column `{name}` not found"))?,
        ),
        None => None,
    };

    let covering = covering_plan(&input_schema, input_geo.as_ref(), &geom_col_name)?;
    match &covering {
        Some(p) => eprintln!(
            "[2/4] Scanning geometry (reusing existing bbox column `{}`)",
            p.bbox.xmin.join(".")
        ),
        None => eprintln!("[2/4] Scanning geometry (computing per-feature bbox from WKB)"),
    }
    // Pass 1: stream only the geometry (+ covering bbox / priority-column) columns.
    // Everything retained per row is O(1)-sized (bbox, kind, rank), so memory
    // stays bounded by the row count, not by the file's attribute payload.
    let ScanResult {
        bboxes,
        kinds,
        priority_column,
    } = scan_input(
        &args.input,
        &arrow_meta,
        geom_col_idx,
        covering.as_ref(),
        priority_column_idx,
    )?;

    let sort_ranks = match &priority_column {
        Some(col) => {
            compute_sort_ranks(col.as_ref(), args.priority_column_order).with_context(|| {
                format!(
                    "ranking --priority-column column `{:?}`",
                    args.priority_column
                )
            })?
        }
        None => vec![0u64; n_rows],
    };
    drop(priority_column);
    if let Some(col) = &args.priority_column {
        eprintln!(
            "      tie-break sort key: {col} ({})",
            match args.priority_column_order {
                PriorityColumnOrder::Desc => "desc, largest wins",
                PriorityColumnOrder::Asc => "asc, smallest wins",
            }
        );
    }

    eprintln!("[3/4] Assigning features to {} level(s)", resolutions.len());
    let mut assignment = assign_levels(
        &bboxes,
        &kinds,
        &resolutions,
        args.point_thinning_factor,
        VisibilityFactors {
            line: args.line_visibility_factor,
            polygon: args.polygon_visibility_factor,
        },
        &sort_ranks,
    )?;
    let family = input_geo
        .as_ref()
        .and_then(|g| g.columns.get(&geom_col_name))
        .and_then(|c| geometry_family(&c.geometry_types));
    let with_overviews = matches!(family, Some(GeometryFamily::Line | GeometryFamily::Polygon))
        && bboxes.iter().all(|bbox| !bbox.is_empty())
        && !input_schema
            .fields()
            .iter()
            .any(|field| field.name() == OVERVIEWS_COLUMN);
    if with_overviews {
        // A feature enters only once its derived representation survives. This
        // changes ordering only: the primary geometry and every attribute stay intact.
        let tolerances: Vec<_> = resolutions
            .iter()
            .map(|r| r * args.simplification_tolerance_factor)
            .collect();
        let reader = ParquetRecordBatchReaderBuilder::new_with_metadata(
            File::open(&args.input)?,
            arrow_meta.clone(),
        )
        .with_projection(ProjectionMask::roots(
            arrow_meta.metadata().file_metadata().schema_descr(),
            [geom_col_idx],
        ))
        .build()?;
        let mut row = 0;
        for batch in reader {
            let batch = batch?;
            let geometry = batch.column(0);
            let minimum: Vec<usize> = (0..batch.num_rows())
                .into_par_iter()
                .map(|i| {
                    let bytes = if let Some(a) = geometry.as_any().downcast_ref::<BinaryArray>() {
                        a.value(i)
                    } else {
                        geometry
                            .as_any()
                            .downcast_ref::<LargeBinaryArray>()
                            .unwrap()
                            .value(i)
                    };
                    first_viable_level(bytes, &tolerances)
                })
                .collect::<Result<_>>()?;
            for viable in minimum {
                assignment[row] = assignment[row].max(viable.min(resolutions.len() - 1) as u16);
                row += 1;
            }
        }
    }
    // Count only after overview viability has deferred collapsed geometries;
    // otherwise the selected root can fall below the requested minimum.
    consolidate_sparse_root(&mut assignment, resolutions.len(), args.min_root_features);
    let occupied = occupied_level_candidates(&assignment, resolutions.len())?;
    let selected = if with_overviews {
        (occupied[0]..resolutions.len()).collect()
    } else {
        occupied
    };
    let mut per_level = remap_levels(&assignment, &selected)?;
    let resolutions: Vec<_> = selected.iter().map(|i| resolutions[*i]).collect();
    for (i, rows) in per_level.iter().enumerate() {
        eprintln!(
            "      level {i} (resolution={:>10.6} CRS units): {:>9} features",
            resolutions[i],
            rows.len()
        );
    }

    for (level_idx, rows) in per_level.iter_mut().enumerate() {
        str_pack(rows, &bboxes, args.row_group_size, level_idx);
        str_pack_pages(
            rows,
            &bboxes,
            args.row_group_size,
            args.page_row_count,
            level_idx,
        );
    }

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

    let overview_plan: Vec<OverviewPlan> = if !with_overviews {
        Vec::new()
    } else {
        resolutions
            .iter()
            .enumerate()
            .map(|(level, resolution)| {
                let tolerance = *resolution * args.simplification_tolerance_factor;
                let scale = overview_scale(tolerance)?;
                let center = [
                    (dataset_bbox.xmin + dataset_bbox.xmax) * 0.5,
                    (dataset_bbox.ymin + dataset_bbox.ymax) * 0.5,
                ];
                Ok(OverviewPlan {
                    id: format!("l{level}"),
                    level,
                    tolerance,
                    scale: [scale, scale],
                    offset: [
                        (center[0] / scale).round() * scale,
                        (center[1] / scale).round() * scale,
                    ],
                })
            })
            .collect::<Result<_>>()?
    };

    eprintln!("[4/4] Writing COGP file: {}", args.output.display());
    // Existing covering metadata is authoritative; column names have no semantics.
    let mut output_fields = input_schema.fields().to_vec();
    let keep_col_indices: Vec<usize> = (0..output_fields.len()).collect();
    let (output_covering, append_bbox) = if let Some(plan) = &covering {
        (
            Covering {
                bbox: plan.bbox.clone(),
            },
            false,
        )
    } else {
        let mut name = "bbox".to_string();
        while input_schema.index_of(&name).is_ok() {
            name.push('_');
        }
        output_fields.push(Arc::new(Field::new(
            &name,
            DataType::Struct(bbox_child_fields()),
            false,
        )));
        (default_covering(&name), true)
    };
    if !overview_plan.is_empty() {
        output_fields.push(Arc::new(overviews_struct_field(&overview_plan)));
    }
    let output_schema = Arc::new(Schema::new(output_fields));

    // ZSTD 9 reduced representative Range payloads without the decode cost
    // observed with Brotli 6. Keep this workload-specific choice internal.
    // Selective page reads should not require a column-chunk-wide dictionary.
    // Keep dictionaries disabled for every leaf, including nested attributes.
    // Physical-type transforms can worsen ZSTD compression on arbitrary attributes.
    // Use PLAIN by default and specialize only the generated overview integers.
    let mut props_builder = WriterProperties::builder()
        .set_dictionary_enabled(false)
        .set_encoding(Encoding::PLAIN)
        .set_compression(Compression::ZSTD(ZstdLevel::try_new(9)?))
        .set_max_row_group_size(args.row_group_size)
        .set_statistics_enabled(EnabledStatistics::Chunk)
        .set_column_statistics_enabled(
            ColumnPath::from(geom_col_name.as_str()),
            EnabledStatistics::None,
        );
    let bbox_paths = [
        &output_covering.bbox.xmin,
        &output_covering.bbox.ymin,
        &output_covering.bbox.xmax,
        &output_covering.bbox.ymax,
    ];
    // Overview coordinates and topology offsets are locally correlated integer
    // sequences. Delta encoding preserves the simple logical schema while
    // avoiding a dictionary that grows with every distinct coordinate.
    for overview in &overview_plan {
        for axis in ["x", "y"] {
            let path = ColumnPath::from(vec![
                OVERVIEWS_COLUMN.to_string(),
                overview.id.clone(),
                "coordinates".to_string(),
                "list".to_string(),
                "element".to_string(),
                axis.to_string(),
            ]);
            props_builder = props_builder.set_column_encoding(path, Encoding::DELTA_BINARY_PACKED);
        }
        for child in ["part_ends", "polygon_ends"] {
            let path = ColumnPath::from(vec![
                OVERVIEWS_COLUMN.to_string(),
                overview.id.clone(),
                child.to_string(),
                "list".to_string(),
                "element".to_string(),
            ]);
            props_builder = props_builder.set_column_encoding(path, Encoding::DELTA_BINARY_PACKED);
        }
    }
    for parts in bbox_paths {
        let path = ColumnPath::from(parts.clone());
        props_builder = props_builder.set_column_statistics_enabled(path, EnabledStatistics::Page);
    }
    // Keep bbox page statistics and offsets for all projected columns.
    props_builder = props_builder
        .set_data_page_row_count_limit(args.page_row_count)
        .set_write_batch_size(args.page_row_count);
    let props = props_builder.build();
    let out_file = File::create(&args.output)
        .with_context(|| format!("creating {}", args.output.display()))?;
    let mut writer = ArrowWriter::try_new(out_file, output_schema.clone(), Some(props))?;

    // Pass 2: a background thread gathers output chunks straight from the
    // input file (row-selection read + interleave into output order) while the
    // main thread flushes finished batches through the parquet writer. Chunks
    // are independent, so the producer gathers them in rayon-parallel waves of
    // one chunk per worker; each wave is sent in order once complete. Resident
    // memory is bounded by one wave of `row_group_size`-row chunks plus the
    // channel, never the whole table. The barrier per wave costs little
    // because chunks are equal-sized and similarly priced.
    let (tx, rx) = sync_channel::<(usize, RecordBatch)>(2);
    let producer_schema = output_schema.clone();
    let producer_bboxes = Arc::new(bboxes);
    let producer_meta = arrow_meta.clone();
    let producer_input = args.input.clone();
    let producer_keep = keep_col_indices;
    let producer_append_bbox = append_bbox;
    let producer_geom_col = geom_col_idx;
    let producer_overview_plan = overview_plan.clone();
    let producer_per_level = per_level;
    let producer_row_group_size = args.row_group_size;
    let producer = thread::spawn(move || -> Result<()> {
        let chunks: Vec<(usize, &[u32])> = producer_per_level
            .iter()
            .enumerate()
            .flat_map(|(level_i, rows)| {
                rows.chunks(producer_row_group_size)
                    .map(move |chunk| (level_i, chunk))
            })
            .collect();
        for wave in chunks.chunks(rayon::current_num_threads()) {
            let gathered = wave
                .par_iter()
                .map(|(level_i, chunk)| {
                    let batches = gather_chunk(
                        &producer_input,
                        &producer_meta,
                        &producer_keep,
                        chunk,
                        &producer_bboxes,
                        &GatherLayout {
                            output_schema: &producer_schema,
                            append_bbox: producer_append_bbox,
                            geometry_col: producer_geom_col,
                            feature_level: *level_i,
                            overview_plan: &producer_overview_plan,
                        },
                    )?;
                    Ok((*level_i, batches))
                })
                .collect::<Result<Vec<_>>>()?;
            for (level_i, batches) in gathered {
                for batch in batches {
                    if tx.send((level_i, batch)).is_err() {
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    });

    let mut last_level: Option<usize> = None;
    let mut levels_meta: Vec<Level> = Vec::with_capacity(resolutions.len());
    while let Ok((level_i, batch)) = rx.recv() {
        if let Some(prev) = last_level {
            if prev != level_i {
                writer.flush()?;
                let boundary = flushed_row_group_end(&writer)?;
                for (level, &resolution) in resolutions.iter().enumerate().take(level_i).skip(prev)
                {
                    levels_meta.push(Level {
                        row_group_end: boundary,
                        resolution,
                        lod: overview_plan.get(level).map(|overview| overview.id.clone()),
                    });
                }
            }
        }
        write_with_row_group_limit(&mut writer, &batch, args.row_group_size)?;
        last_level = Some(level_i);
    }
    if let Some(prev) = last_level {
        writer.flush()?;
        let boundary = flushed_row_group_end(&writer)?;
        for (level, &resolution) in resolutions.iter().enumerate().skip(prev) {
            levels_meta.push(Level {
                row_group_end: boundary,
                resolution,
                lod: overview_plan.get(level).map(|overview| overview.id.clone()),
            });
        }
    }
    producer
        .join()
        .map_err(|e| anyhow!("batch producer panicked: {:?}", e))??;

    let mut columns: BTreeMap<String, GeoColumn> = input_geo
        .as_ref()
        .map(|g| g.columns.clone())
        .unwrap_or_default();
    if let Some(g) = &input_geo {
        if let Some(orig) = g.columns.get(&geom_col_name) {
            let mut c = orig.clone();
            c.covering = Some(output_covering.clone());
            c.bbox = (!dataset_bbox.is_empty()).then(|| {
                vec![
                    dataset_bbox.xmin,
                    dataset_bbox.ymin,
                    dataset_bbox.xmax,
                    dataset_bbox.ymax,
                ]
            });
            columns.insert(geom_col_name.clone(), c);
        }
    }
    columns
        .entry(geom_col_name.clone())
        .or_insert_with(|| GeoColumn {
            encoding: "WKB".to_string(),
            geometry_types: Vec::new(),
            covering: Some(output_covering.clone()),
            bbox: (!dataset_bbox.is_empty()).then(|| {
                vec![
                    dataset_bbox.xmin,
                    dataset_bbox.ymin,
                    dataset_bbox.xmax,
                    dataset_bbox.ymax,
                ]
            }),
            crs: None,
        });
    let mut geo_meta = GeoMeta {
        lod: None,
        version: GEOPARQUET_VERSION.to_string(),
        primary_column: geom_col_name.clone(),
        columns,
    };
    let cogp_meta = CogpMeta {
        levels: levels_meta,
        overviews: (!overview_plan.is_empty()).then(|| OverviewsMeta {
            encoding: OVERVIEWS_ENCODING.to_string(),
            lods: overview_plan
                .iter()
                .map(|overview| {
                    (
                        overview.id.clone(),
                        LodMeta {
                            scale: overview.scale,
                            offset: overview.offset,
                        },
                    )
                })
                .collect(),
        }),
    };

    geo_meta.lod = Some(cogp_meta.clone());
    let mut output_geo = serde_json::to_value(&geo_meta)?;
    // Retain CRS null (unknown), edge semantics, and other GeoParquet fields.
    if let Some(mut original) = input_geo_json {
        original["primary_column"] = serde_json::json!(geom_col_name);
        original.as_object_mut().unwrap().remove("coarse_to_fine");
        original["lod"] = output_geo["lod"].clone();
        if original["columns"].get(&geom_col_name).is_some() {
            if append_bbox {
                original["columns"][&geom_col_name]["covering"] =
                    output_geo["columns"][&geom_col_name]["covering"].clone();
            }
            if let Some(bbox) = output_geo["columns"][&geom_col_name].get("bbox") {
                original["columns"][&geom_col_name]["bbox"] = bbox.clone();
            } else {
                original["columns"][&geom_col_name]
                    .as_object_mut()
                    .unwrap()
                    .remove("bbox");
            }
        } else {
            original["columns"][&geom_col_name] = output_geo["columns"][&geom_col_name].clone();
        }
        output_geo = original;
    }
    writer.append_key_value_metadata(KeyValue {
        key: GEO_METADATA_KEY.to_string(),
        value: Some(serde_json::to_string(&output_geo)?),
    });

    for entry in input_kv {
        if !matches!(entry.key.as_str(), "geo" | "cogp" | "ARROW:schema") {
            writer.append_key_value_metadata(entry);
        }
    }
    let _ = writer.close()?;

    let row_group_count = cogp_meta
        .levels
        .last()
        .map(|level| level.row_group_end + 1)
        .unwrap_or(0);
    eprintln!(
        "      wrote {} row group(s) across {} level(s)",
        row_group_count,
        cogp_meta.levels.len()
    );
    Ok(())
}

#[derive(Clone, Debug)]
struct OverviewPlan {
    id: String,
    level: usize,
    tolerance: f64,
    scale: [f64; 2],
    offset: [f64; 2],
}

fn integer_list_type() -> DataType {
    DataType::List(Arc::new(Field::new("element", DataType::Int32, false)))
}

fn coordinate_fields() -> Fields {
    Fields::from(vec![
        Field::new("x", DataType::Int32, false),
        Field::new("y", DataType::Int32, false),
    ])
}

fn coordinate_list_type() -> DataType {
    DataType::List(Arc::new(Field::new(
        "element",
        DataType::Struct(coordinate_fields()),
        false,
    )))
}

fn lod_child_fields() -> Fields {
    Fields::from(vec![
        Field::new("coordinates", coordinate_list_type(), false),
        Field::new("part_ends", integer_list_type(), false),
        Field::new("polygon_ends", integer_list_type(), false),
    ])
}

fn overviews_struct_field(plan: &[OverviewPlan]) -> Field {
    let mut children = Vec::with_capacity(plan.len() + 1);
    children.push(Field::new("geometry_type", DataType::Int8, false));
    children.extend(
        plan.iter()
            .map(|overview| Field::new(&overview.id, DataType::Struct(lod_child_fields()), true)),
    );
    Field::new(
        OVERVIEWS_COLUMN,
        DataType::Struct(Fields::from(children)),
        false,
    )
}

fn default_covering(name: &str) -> Covering {
    Covering {
        bbox: BboxCovering {
            xmin: vec![name.into(), "xmin".into()],
            ymin: vec![name.into(), "ymin".into()],
            xmax: vec![name.into(), "xmax".into()],
            ymax: vec![name.into(), "ymax".into()],
        },
    }
}

fn bbox_child_fields() -> Fields {
    Fields::from(vec![
        Field::new("xmin", DataType::Float64, true),
        Field::new("ymin", DataType::Float64, true),
        Field::new("xmax", DataType::Float64, true),
        Field::new("ymax", DataType::Float64, true),
    ])
}

fn build_bbox_struct(bboxes: &[Bbox]) -> Result<StructArray> {
    let xmin: ArrayRef = Arc::new(Float64Array::from(
        bboxes
            .par_iter()
            .map(|b| (!b.is_empty()).then_some(b.xmin))
            .collect::<Vec<_>>(),
    ));
    let ymin: ArrayRef = Arc::new(Float64Array::from(
        bboxes
            .par_iter()
            .map(|b| (!b.is_empty()).then_some(b.ymin))
            .collect::<Vec<_>>(),
    ));
    let xmax: ArrayRef = Arc::new(Float64Array::from(
        bboxes
            .par_iter()
            .map(|b| (!b.is_empty()).then_some(b.xmax))
            .collect::<Vec<_>>(),
    ));
    let ymax: ArrayRef = Arc::new(Float64Array::from(
        bboxes
            .par_iter()
            .map(|b| (!b.is_empty()).then_some(b.ymax))
            .collect::<Vec<_>>(),
    ));
    Ok(StructArray::try_new(
        bbox_child_fields(),
        vec![xmin, ymin, xmax, ymax],
        None,
    )?)
}

/// Resolve covering paths independently of root names or nesting depth.
struct CoveringPlan {
    bbox: BboxCovering,
    roots: Vec<usize>,
}

fn covering_plan(
    schema: &Schema,
    input_geo: Option<&GeoMeta>,
    geom_col: &str,
) -> Result<Option<CoveringPlan>> {
    let Some(covering) = input_geo
        .and_then(|g| g.columns.get(geom_col))
        .and_then(|c| c.covering.as_ref())
    else {
        return Ok(None);
    };
    let bbox = covering.bbox.clone();
    let roots = [&bbox.xmin, &bbox.ymin, &bbox.xmax, &bbox.ymax]
        .iter()
        .map(|path| {
            let name = path
                .first()
                .ok_or_else(|| anyhow!("empty covering bbox path"))?;
            schema
                .index_of(name)
                .with_context(|| format!("covering column `{name}` not found"))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Some(CoveringPlan { bbox, roots }))
}

struct CoverCoordinate<'a> {
    array: &'a dyn Array,
    parents: Vec<&'a StructArray>,
}

impl<'a> CoverCoordinate<'a> {
    fn from_batch(batch: &'a RecordBatch, path: &[String]) -> Result<Self> {
        let mut array = batch
            .column_by_name(&path[0])
            .ok_or_else(|| anyhow!("missing covering column"))?
            .as_ref();
        let mut parents = Vec::new();
        for part in &path[1..] {
            let parent = array
                .as_any()
                .downcast_ref::<StructArray>()
                .ok_or_else(|| anyhow!("covering path must traverse structs"))?;
            parents.push(parent);
            array = parent
                .column_by_name(part)
                .ok_or_else(|| anyhow!("missing covering child `{part}`"))?
                .as_ref();
        }
        anyhow::ensure!(
            matches!(array.data_type(), DataType::Float32 | DataType::Float64),
            "covering coordinate must be Float32 or Float64"
        );
        Ok(Self { array, parents })
    }

    fn value(&self, row: usize) -> Option<f64> {
        if self.array.is_null(row) || self.parents.iter().any(|p| p.is_null(row)) {
            return None;
        }
        if let Some(a) = self.array.as_any().downcast_ref::<Float64Array>() {
            Some(a.value(row))
        } else {
            Some(
                self.array
                    .as_any()
                    .downcast_ref::<arrow_array::Float32Array>()
                    .unwrap()
                    .value(row) as f64,
            )
        }
    }
}

struct CoverCols<'a> {
    coordinates: [CoverCoordinate<'a>; 4],
}

impl<'a> CoverCols<'a> {
    fn from_batch(batch: &'a RecordBatch, plan: &CoveringPlan) -> Result<Self> {
        let b = &plan.bbox;
        Ok(Self {
            coordinates: [
                CoverCoordinate::from_batch(batch, &b.xmin)?,
                CoverCoordinate::from_batch(batch, &b.ymin)?,
                CoverCoordinate::from_batch(batch, &b.xmax)?,
                CoverCoordinate::from_batch(batch, &b.ymax)?,
            ],
        })
    }
    fn value(&self, row: usize) -> Option<Bbox> {
        Some(Bbox {
            xmin: self.coordinates[0].value(row)?,
            ymin: self.coordinates[1].value(row)?,
            xmax: self.coordinates[2].value(row)?,
            ymax: self.coordinates[3].value(row)?,
        })
    }
}

struct ScanResult {
    bboxes: Vec<Bbox>,
    kinds: Vec<GeomKind>,
    /// The fully materialized `--priority-column` column, when one was requested —
    /// the only column the convert still holds in memory in its entirety.
    priority_column: Option<ArrayRef>,
}

/// Pass 1: stream the file reading only the geometry column (plus, when
/// present, the covering bbox column and the `--priority-column` column) and reduce
/// each row to its bbox + geometry kind. Batches are dropped as soon as they
/// are consumed, so peak memory is one batch plus the per-row outputs.
fn scan_input(
    input: &Path,
    meta: &ArrowReaderMetadata,
    geom_col_idx: usize,
    covering: Option<&CoveringPlan>,
    priority_column_idx: Option<usize>,
) -> Result<ScanResult> {
    let mut roots: Vec<usize> = vec![geom_col_idx];
    if let Some(p) = covering {
        roots.extend_from_slice(&p.roots);
    }
    if let Some(i) = priority_column_idx {
        roots.push(i);
    }
    roots.sort_unstable();
    roots.dedup();
    // Projected batches keep the schema's field order, so a column's index in
    // the batch is its rank within the sorted projection roots.
    let proj_idx = |orig: usize| roots.iter().position(|r| *r == orig).unwrap();

    let file = File::open(input).with_context(|| format!("opening {}", input.display()))?;
    let mask = ProjectionMask::roots(
        meta.metadata().file_metadata().schema_descr(),
        roots.iter().copied(),
    );
    // Only 1-3 narrow columns are projected, so large batches are cheap and
    // keep the per-batch rayon fan-out (WKB parsing) coarse enough that
    // fork/join overhead stays negligible next to the parse work.
    const SCAN_BATCH_ROWS: usize = 64 * 1024;
    let reader = ParquetRecordBatchReaderBuilder::new_with_metadata(file, meta.clone())
        .with_projection(mask)
        .with_batch_size(SCAN_BATCH_ROWS)
        .build()?;

    let n_rows = meta.metadata().file_metadata().num_rows() as usize;
    let mut bboxes: Vec<Bbox> = Vec::with_capacity(n_rows);
    let mut kinds: Vec<GeomKind> = Vec::with_capacity(n_rows);
    let mut priority_column_parts: Vec<ArrayRef> = Vec::new();
    let mut row_base = 0usize;
    for batch in reader {
        let batch = batch?;
        let cover = match covering {
            Some(p) => Some(CoverCols::from_batch(&batch, p)?),
            None => None,
        };
        let pairs = scan_geometry_batch(
            batch.column(proj_idx(geom_col_idx)).as_ref(),
            cover.as_ref(),
            row_base,
        )?;
        for (bb, k) in pairs {
            bboxes.push(bb);
            kinds.push(k);
        }
        if let Some(i) = priority_column_idx {
            priority_column_parts.push(batch.column(proj_idx(i)).clone());
        }
        row_base += batch.num_rows();
    }
    let priority_column = match priority_column_idx {
        Some(_) => Some(concat_priority_column(&priority_column_parts)?),
        None => None,
    };
    Ok(ScanResult {
        bboxes,
        kinds,
        priority_column,
    })
}

fn scan_geometry_batch(
    geom: &dyn Array,
    cover: Option<&CoverCols>,
    row_base: usize,
) -> Result<Vec<(Bbox, GeomKind)>> {
    if let Some(arr) = geom.as_any().downcast_ref::<BinaryArray>() {
        scan_wkb_rows(arr, cover, row_base)
    } else if let Some(arr) = geom.as_any().downcast_ref::<LargeBinaryArray>() {
        scan_wkb_rows(arr, cover, row_base)
    } else {
        bail!(
            "geometry column has unsupported type `{:?}`; only WKB Binary/LargeBinary is supported",
            geom.data_type()
        );
    }
}

fn scan_wkb_rows<O: OffsetSizeTrait>(
    arr: &GenericBinaryArray<O>,
    cover: Option<&CoverCols>,
    _row_base: usize,
) -> Result<Vec<(Bbox, GeomKind)>> {
    (0..arr.len())
        .into_par_iter()
        .map(|i| {
            if arr.is_null(i) {
                return Ok((Bbox::empty(), GeomKind::Point));
            }
            let wkb = arr.value(i);
            if let Some(c) = cover {
                return Ok((c.value(i).unwrap_or_else(Bbox::empty), kind_from_wkb(wkb)?));
            }
            bbox_from_wkb(wkb)
        })
        .collect()
}

/// Concatenate the per-batch priority-column arrays into one column for `rank`.
/// A variable-width column whose accumulated bytes would overflow i32 offsets
/// (arrow panics past ~2 GiB) is upcast to its Large counterpart first; the
/// 1 GiB threshold leaves headroom and keeps small columns on the i32 path.
fn concat_priority_column(parts: &[ArrayRef]) -> Result<ArrayRef> {
    const PROMOTE_THRESHOLD: usize = 1 << 30;
    match parts {
        [] => bail!("internal: priority-column scan produced no batches"),
        [only] => return Ok(only.clone()),
        _ => {}
    }
    let large = match parts[0].data_type() {
        DataType::Binary => Some(DataType::LargeBinary),
        DataType::Utf8 => Some(DataType::LargeUtf8),
        _ => None,
    };
    let total: usize = parts.iter().map(|p| var_width_total(p.as_ref())).sum();
    let parts: Vec<ArrayRef> = match large {
        Some(large) if total >= PROMOTE_THRESHOLD => parts
            .iter()
            .map(|p| Ok(cast(p.as_ref(), &large)?))
            .collect::<Result<_>>()?,
        _ => parts.to_vec(),
    };
    let refs: Vec<&dyn Array> = parts.iter().map(|p| p.as_ref()).collect();
    Ok(concat(&refs)?)
}

fn var_width_total(arr: &dyn Array) -> usize {
    match arr.data_type() {
        DataType::Binary => arr
            .as_any()
            .downcast_ref::<BinaryArray>()
            .map(|a| a.value_data().len()),
        DataType::LargeBinary => arr
            .as_any()
            .downcast_ref::<LargeBinaryArray>()
            .map(|a| a.value_data().len()),
        DataType::Utf8 => arr
            .as_any()
            .downcast_ref::<StringArray>()
            .map(|a| a.value_data().len()),
        DataType::LargeUtf8 => arr
            .as_any()
            .downcast_ref::<LargeStringArray>()
            .map(|a| a.value_data().len()),
        _ => None,
    }
    .unwrap_or(0)
}

/// Per-row byte contribution to variable-width output arrays; used to split a
/// gathered chunk so no interleaved output column can overflow i32 offsets.
fn var_width_bytes_at(arr: &dyn Array, i: usize) -> usize {
    match arr.data_type() {
        DataType::Binary => arr
            .as_any()
            .downcast_ref::<BinaryArray>()
            .map(|a| a.value_length(i) as usize),
        DataType::LargeBinary => arr
            .as_any()
            .downcast_ref::<LargeBinaryArray>()
            .map(|a| a.value_length(i) as usize),
        DataType::Utf8 => arr
            .as_any()
            .downcast_ref::<StringArray>()
            .map(|a| a.value_length(i) as usize),
        DataType::LargeUtf8 => arr
            .as_any()
            .downcast_ref::<LargeStringArray>()
            .map(|a| a.value_length(i) as usize),
        _ => None,
    }
    .unwrap_or(0)
}

/// Cap on the summed variable-width bytes per interleaved output batch. The
/// sum across columns bounds each single column, so staying under 1 GiB keeps
/// every i32-offset column comfortably below arrow's ~2 GiB overflow point.
const SEGMENT_MAX_BYTES: usize = 1 << 30;

/// Skip/select run-length selection over the whole file for the given
/// ascending, duplicate-free row indices.
fn row_selection_for(sorted: &[u32]) -> RowSelection {
    let mut selectors: Vec<RowSelector> = Vec::new();
    let mut cursor = 0usize;
    let mut i = 0;
    while i < sorted.len() {
        let start = sorted[i] as usize;
        let mut end = start + 1;
        i += 1;
        while i < sorted.len() && sorted[i] as usize == end {
            end += 1;
            i += 1;
        }
        if start > cursor {
            selectors.push(RowSelector::skip(start - cursor));
        }
        selectors.push(RowSelector::select(end - start));
        cursor = end;
    }
    RowSelection::from(selectors)
}

/// Pass 2 gather: read exactly `chunk`'s rows from the input via a parquet
/// row selection, interleave them into the chunk's (STR-packed) output order,
/// and append the bbox struct built from the already-computed `bboxes`.
/// Returns one batch normally; the chunk is split into several whenever its
/// variable-width payload approaches the i32 offset budget (see
/// `SEGMENT_MAX_BYTES`), so arbitrarily fat rows cannot overflow.
struct GatherLayout<'a> {
    output_schema: &'a Arc<Schema>,
    append_bbox: bool,
    geometry_col: usize,
    feature_level: usize,
    overview_plan: &'a [OverviewPlan],
}

fn gather_chunk(
    input: &Path,
    meta: &ArrowReaderMetadata,
    keep_cols: &[usize],
    chunk: &[u32],
    bboxes: &[Bbox],
    layout: &GatherLayout<'_>,
) -> Result<Vec<RecordBatch>> {
    let mut sorted = chunk.to_vec();
    sorted.sort_unstable();

    let file = File::open(input).with_context(|| format!("opening {}", input.display()))?;
    let mask = ProjectionMask::roots(
        meta.metadata().file_metadata().schema_descr(),
        keep_cols.iter().copied(),
    );
    let reader = ParquetRecordBatchReaderBuilder::new_with_metadata(file, meta.clone())
        .with_projection(mask)
        .with_row_selection(row_selection_for(&sorted))
        .build()?;
    let mut batches = reader.collect::<std::result::Result<Vec<_>, _>>()?;
    batches.retain(|b| b.num_rows() > 0);
    let gathered: usize = batches.iter().map(|b| b.num_rows()).sum();
    if gathered != sorted.len() {
        bail!(
            "internal: row selection returned {gathered} rows, expected {}",
            sorted.len()
        );
    }

    // Selected rows arrive in ascending input-row order; map each output
    // position back to (batch, row-in-batch) through the sorted index list.
    let mut starts = Vec::with_capacity(batches.len());
    let mut acc = 0usize;
    for b in &batches {
        starts.push(acc);
        acc += b.num_rows();
    }
    let locs: Vec<(usize, usize)> = chunk
        .iter()
        .map(|r| {
            let p = sorted
                .binary_search(r)
                .expect("chunk row missing from its own sorted copy");
            let b = starts.partition_point(|s| *s <= p) - 1;
            (b, p - starts[b])
        })
        .collect();

    let n_cols = keep_cols.len();
    let col_refs: Vec<Vec<&dyn Array>> = (0..n_cols)
        .map(|c| batches.iter().map(|b| b.column(c).as_ref()).collect())
        .collect();
    let weights: Vec<usize> = locs
        .iter()
        .map(|(b, i)| {
            batches[*b]
                .columns()
                .iter()
                .map(|col| var_width_bytes_at(col.as_ref(), *i))
                .sum()
        })
        .collect();

    let mut out = Vec::new();
    let mut seg_start = 0usize;
    while seg_start < chunk.len() {
        let mut seg_end = seg_start + 1;
        let mut seg_bytes = weights[seg_start];
        while seg_end < chunk.len() && seg_bytes + weights[seg_end] <= SEGMENT_MAX_BYTES {
            seg_bytes += weights[seg_end];
            seg_end += 1;
        }
        let mut cols: Vec<ArrayRef> =
            Vec::with_capacity(n_cols + usize::from(!layout.overview_plan.is_empty()) + 1);
        for refs in &col_refs {
            cols.push(interleave(refs, &locs[seg_start..seg_end])?);
        }
        if layout.append_bbox {
            let seg_bboxes: Vec<Bbox> = chunk[seg_start..seg_end]
                .iter()
                .map(|r| bboxes[*r as usize])
                .collect();
            cols.push(Arc::new(build_bbox_struct(&seg_bboxes)?));
        }
        if !layout.overview_plan.is_empty() {
            let raw_geometry = cols[layout.geometry_col].clone();
            cols.push(Arc::new(build_overviews_array(
                raw_geometry.as_ref(),
                layout.feature_level,
                layout.overview_plan,
                &chunk[seg_start..seg_end],
            )?));
        }
        out.push(RecordBatch::try_new(layout.output_schema.clone(), cols)?);
        seg_start = seg_end;
    }
    Ok(out)
}

fn occupied_level_candidates(assignment: &[u16], candidate_count: usize) -> Result<Vec<usize>> {
    if assignment.is_empty() || candidate_count == 0 {
        bail!("internal: cannot build an empty level hierarchy");
    }
    let mut occupied = vec![false; candidate_count];
    for level in assignment {
        let level = *level as usize;
        if level >= candidate_count {
            bail!("internal: feature level {level} is outside the candidate ladder");
        }
        occupied[level] = true;
    }
    Ok(occupied
        .iter()
        .enumerate()
        .filter_map(|(level, occupied)| occupied.then_some(level))
        .collect())
}

fn remap_levels(assignment: &[u16], selected_candidates: &[usize]) -> Result<Vec<Vec<u32>>> {
    if selected_candidates.is_empty() {
        bail!("internal: no selected levels");
    }
    let mut per_level = vec![Vec::new(); selected_candidates.len()];
    for (row, source_level) in assignment.iter().enumerate() {
        let source_level = *source_level as usize;
        let output_level = selected_candidates.partition_point(|level| *level < source_level);
        let rows = per_level.get_mut(output_level).ok_or_else(|| {
            anyhow!("internal: feature level {source_level} has no selected successor")
        })?;
        rows.push(u32::try_from(row).map_err(|_| anyhow!("more than u32::MAX input rows"))?);
    }
    Ok(per_level)
}

fn build_overviews_array(
    array: &dyn Array,
    feature_level: usize,
    plan: &[OverviewPlan],
    source_rows: &[u32],
) -> Result<StructArray> {
    if source_rows.len() != array.len() {
        bail!("internal: overview source-row mapping length mismatch");
    }
    let bytes_at = |index: usize| -> Option<&[u8]> {
        if let Some(values) = array.as_any().downcast_ref::<BinaryArray>() {
            (!values.is_null(index)).then(|| values.value(index))
        } else if let Some(values) = array.as_any().downcast_ref::<LargeBinaryArray>() {
            (!values.is_null(index)).then(|| values.value(index))
        } else {
            None
        }
    };
    if !matches!(array.data_type(), DataType::Binary | DataType::LargeBinary) {
        bail!("primary geometry is not a WKB Binary/LargeBinary column");
    }
    let fallback_tolerance = plan
        .get(feature_level)
        .ok_or_else(|| anyhow!("internal: feature level has no overview plan"))?
        .tolerance;

    let mut geometry_types = vec![None; array.len()];
    let mut lod_arrays: Vec<ArrayRef> = Vec::with_capacity(plan.len());
    for overview in plan {
        let values: Vec<Option<QuantizedOverview>> = (0..array.len())
            .into_par_iter()
            .map(|index| {
                if feature_level > overview.level {
                    return Ok(None);
                }
                bytes_at(index)
                    .map(|bytes| {
                        quantized_overview_with_fallback(
                            bytes,
                            overview.tolerance,
                            fallback_tolerance,
                            overview.offset,
                        )
                        .with_context(|| {
                            format!(
                                "building {} overview for input row {} (feature level {})",
                                overview.id, source_rows[index], feature_level
                            )
                        })
                    })
                    .transpose()
            })
            .collect::<Result<_>>()?;
        for (geometry_type, value) in geometry_types.iter_mut().zip(&values) {
            let Some(value) = value else {
                continue;
            };
            match *geometry_type {
                Some(expected) if expected != value.geometry_type => {
                    bail!(
                        "overview geometry type changed across LoDs from {expected} to {}",
                        value.geometry_type
                    );
                }
                None => *geometry_type = Some(value.geometry_type),
                Some(_) => {}
            }
        }
        lod_arrays.push(Arc::new(build_lod_array(&values)?));
    }

    let mut arrays: Vec<ArrayRef> = Vec::with_capacity(lod_arrays.len() + 1);
    let geometry_types = geometry_types
        .into_iter()
        .map(|geometry_type| {
            geometry_type.ok_or_else(|| anyhow!("overview geometry type was not produced"))
        })
        .collect::<Result<Vec<_>>>()?;
    arrays.push(Arc::new(Int8Array::from(geometry_types)));
    arrays.extend(lod_arrays);
    let fields = match overviews_struct_field(plan).data_type() {
        DataType::Struct(fields) => fields.clone(),
        _ => unreachable!(),
    };
    Ok(StructArray::new(fields, arrays, None))
}

fn build_lod_array(values: &[Option<QuantizedOverview>]) -> Result<StructArray> {
    let list_field = || Arc::new(Field::new("element", DataType::Int32, false));
    let coordinate_builder = StructBuilder::new(
        coordinate_fields(),
        vec![Box::new(Int32Builder::new()), Box::new(Int32Builder::new())],
    );
    let coordinate_field = Arc::new(Field::new(
        "element",
        DataType::Struct(coordinate_fields()),
        false,
    ));
    let mut coordinates = ListBuilder::new(coordinate_builder).with_field(coordinate_field);
    let mut part_ends = ListBuilder::new(Int32Builder::new()).with_field(list_field());
    let mut polygon_ends = ListBuilder::new(Int32Builder::new()).with_field(list_field());
    let mut valid = Vec::with_capacity(values.len());
    for value in values {
        if let Some(value) = value {
            if value.x.len() != value.y.len() {
                bail!("internal: quantized overview x/y lengths differ");
            }
            let coordinate_values = coordinates.values();
            coordinate_values
                .field_builder::<Int32Builder>(0)
                .expect("coordinate x builder")
                .append_slice(&value.x);
            coordinate_values
                .field_builder::<Int32Builder>(1)
                .expect("coordinate y builder")
                .append_slice(&value.y);
            for _ in 0..value.x.len() {
                coordinate_values.append(true);
            }
            part_ends.values().append_slice(&value.part_ends);
            polygon_ends.values().append_slice(&value.polygon_ends);
            valid.push(true);
        } else {
            valid.push(false);
        }
        // Child lists are required. Their values are ignored whenever the
        // enclosing LoD struct is null.
        coordinates.append(true);
        part_ends.append(true);
        polygon_ends.append(true);
    }
    Ok(StructArray::new(
        lod_child_fields(),
        vec![
            Arc::new(coordinates.finish()),
            Arc::new(part_ends.finish()),
            Arc::new(polygon_ends.finish()),
        ],
        Some(NullBuffer::from(valid)),
    ))
}

/// Fold sparse leading levels into the first cumulative prefix meeting the
/// root minimum. Keep later assignments intact: this is not a minimum for every
/// level. Falling back to the final candidate preserves all rows for small inputs.
fn consolidate_sparse_root(assignment: &mut [u16], level_count: usize, minimum: usize) {
    let mut counts = vec![0usize; level_count];
    for &level in assignment.iter() {
        counts[level as usize] += 1;
    }
    let mut cumulative = 0;
    let root = counts
        .iter()
        .position(|count| {
            cumulative += count;
            cumulative >= minimum
        })
        .unwrap_or(level_count - 1) as u16;
    for level in assignment {
        *level = (*level).max(root);
    }
}

/// Per-kind multipliers on `prec` for the visibility (eligibility) threshold.
/// Points are excluded — they have no extent, so they are always eligible
/// from level 0 regardless of any factor.
#[derive(Clone, Copy)]
struct VisibilityFactors {
    line: u32,
    polygon: u32,
}

/// Per-row tie-break ranks derived from the `--priority-column` attribute column: a
/// larger rank means higher priority within a point-thinning cell (see `priority`).
/// Equal column values share a rank, so ties still fall through to the hashed
/// row index; null values rank below every non-null and so always lose.
fn compute_sort_ranks(col: &dyn Array, order: PriorityColumnOrder) -> Result<Vec<u64>> {
    // nulls_first keeps nulls at the lowest rank in both directions; `descending`
    // only flips which end of the value range earns the highest (winning) rank.
    let opts = SortOptions {
        descending: matches!(order, PriorityColumnOrder::Asc),
        nulls_first: true,
    };
    let ranks = rank(col, Some(opts))?;
    Ok(ranks.into_iter().map(u64::from).collect())
}

/// Assign features to progressive levels, with grid thinning only for points.
///
/// For each level (coarse → fine), eligible Point/MultiPoint features compete in
/// grid cells and the highest-priority feature in each cell is assigned. Lines and
/// polygons are spatially extended: representing either by its bbox center can hide a
/// feature that contributes visible information across many cells. They therefore do
/// not compete in cells and are assigned as soon as they pass the visibility gate.
///
/// A feature is *eligible* at a level only once its bbox diagonal reaches
/// `vis_factor · prec` for its kind (see `min_visible`); below that it is excluded and
/// deferred to a finer level where it becomes independently meaningful. This is a hard
/// gate, not a tie-break, so the reader does not fetch sub-resolution extended features
/// at a coarse zoom. It does not impose a density bound on visible lines or polygons.
/// The trade-off is that a lone sub-threshold feature does not appear at coarser zooms.
/// Point-kind features have no extent and are eligible from level 0.
///
/// Cells already occupied by a feature assigned at a coarser level are blocked: any
/// remaining candidate whose center re-projects into such a cell at the current
/// level's grid is skipped (it stays in `remaining` for a finer level). Without
/// this, a tight cluster would surface one feature per level in the same visual
/// neighborhood — a coarse winner plus near-identical fine winners around it.
/// Blocking applies only to points.
fn assign_levels(
    bboxes: &[Bbox],
    kinds: &[GeomKind],
    resolutions: &[f64],
    point_thinning_factor: u32,
    visibility: VisibilityFactors,
    sort_ranks: &[u64],
) -> Result<Vec<u16>> {
    let n = bboxes.len();
    let mut assigned: Vec<i32> = vec![-1; n];
    let mut remaining: Vec<u32> = (0..n as u32).collect();
    let last_level = (resolutions.len() - 1) as u16;

    let precs = resolutions.to_vec();

    let point_thin_mul = point_thinning_factor as f64;
    let line_vis_mul = visibility.line as f64;
    let polygon_vis_mul = visibility.polygon as f64;

    // Coarsest level at which each feature is independently meaningful: its bbox
    // diagonal ≥ `vis_factor · prec` for the feature's kind. Diagonal — rather
    // than max(w, h) — so a 45° line is rated by its actual length, not its
    // axis-aligned shadow. Compared in squared form to avoid a per-row sqrt.
    // Points have no extent so are eligible from level 0. Used as a hard
    // eligibility gate in the per-cell selection below.
    let sq_line_vis: Vec<f64> = precs
        .iter()
        .map(|p| (p * line_vis_mul) * (p * line_vis_mul))
        .collect();
    let sq_polygon_vis: Vec<f64> = precs
        .iter()
        .map(|p| (p * polygon_vis_mul) * (p * polygon_vis_mul))
        .collect();
    let min_visible: Vec<u16> = bboxes
        .par_iter()
        .zip(kinds.par_iter())
        .map(|(b, k)| {
            if b.is_empty() {
                return last_level;
            }
            if *k == GeomKind::Point {
                return 0u16;
            }
            let sq_diag = b.width().powi(2) + b.height().powi(2);
            if sq_diag <= 0.0 {
                return 0u16;
            }
            let thresholds = match k {
                GeomKind::Line => &sq_line_vis,
                GeomKind::Polygon => &sq_polygon_vis,
                GeomKind::Point => unreachable!(),
            };
            for (i, sp) in thresholds.iter().enumerate() {
                if sq_diag >= *sp {
                    return i as u16;
                }
            }
            last_level
        })
        .collect();

    let cell_key = |row: u32, prec: f64| -> (i64, i64) {
        let b = bboxes[row as usize];
        let ep = prec * point_thin_mul;
        ((b.cx() / ep).floor() as i64, (b.cy() / ep).floor() as i64)
    };

    let mut assigned_points: Vec<u32> = Vec::new();
    for (level_i, prec) in precs.iter().enumerate() {
        // Re-project every coarser-level point onto this level's grid and mark
        // those cells as blocked, so a candidate point falling into the same
        // cell as an already-placed coarse winner is skipped.
        // Rebuilt per level because each level's grid pitch differs.
        let blocked: std::collections::HashSet<(i64, i64)> = assigned_points
            .par_iter()
            .map(|&row| cell_key(row, *prec))
            .collect();

        let prio = |row: u32| priority(&bboxes[row as usize], sort_ranks[row as usize], row);

        // Per-cell point winner map built in parallel: each thread folds into a
        // local HashMap, then reduce merges them keeping the higher-score row
        // on collision.
        let best: HashMap<(i64, i64), u32> = remaining
            .par_iter()
            .fold(HashMap::new, |mut local, &row| {
                // Points are meaningful from level 0. The visibility gate for
                // extended geometries is applied below when they are collected.
                if min_visible[row as usize] as usize > level_i {
                    return local;
                }
                if kinds[row as usize] != GeomKind::Point {
                    return local;
                }
                let key = cell_key(row, *prec);
                if blocked.contains(&key) {
                    return local;
                }
                match local.get(&key) {
                    None => {
                        local.insert(key, row);
                    }
                    Some(&cur) => {
                        if prio(row) > prio(cur) {
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
                            if prio(row) > prio(cur) {
                                a.insert(k, row);
                            }
                        }
                    }
                }
                a
            });
        let mut picked: Vec<u32> = best.values().copied().collect();
        let extended: Vec<u32> = remaining
            .par_iter()
            .filter_map(|&row| {
                (kinds[row as usize] != GeomKind::Point
                    && min_visible[row as usize] as usize <= level_i)
                    .then_some(row)
            })
            .collect();
        picked.extend(extended);
        for r in &picked {
            assigned[*r as usize] = level_i as i32;
        }
        assigned_points.extend(best.values().copied());
        let picked_set: std::collections::HashSet<u32> = picked.iter().copied().collect();
        remaining.retain(|r| !picked_set.contains(r));
        if remaining.is_empty() {
            break;
        }
    }
    for r in remaining {
        assigned[r as usize] = last_level as i32;
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

/// Point-cell winner priority. The optional `--priority-column` rank leads, bbox
/// diagonal breaks ties for an extended MultiPoint, and a hashed row index gives
/// a deterministic final order. Ordinary Point bboxes have zero size.
fn priority(b: &Bbox, sort_rank: u64, row: u32) -> (u64, u64, u64) {
    let w = b.width().max(0.0);
    let h = b.height().max(0.0);
    let sq_diag = w * w + h * h;
    let sq_bits = if sq_diag.is_finite() && sq_diag >= 0.0 {
        sq_diag.to_bits()
    } else {
        0
    };
    let mut hash = row as u64;
    hash = hash.wrapping_mul(0x9E3779B97F4A7C15);
    hash ^= hash >> 30;
    (sort_rank, sq_bits, hash)
}

/// Per-axis sort direction inherited down the recursion tree.
#[derive(Clone, Copy)]
struct SortDir {
    rev_x: bool,
    rev_y: bool,
}

impl SortDir {
    /// Whether the sort along `axis` should be descending.
    fn reverse_on(self, split_x: bool) -> bool {
        if split_x {
            self.rev_x
        } else {
            self.rev_y
        }
    }

    /// Right-child direction: flip the *other* axis so the right subtree's
    /// next split along that axis runs in reverse, making the right
    /// subtree's first leaf land next to the left subtree's last leaf.
    fn flip_for_right_child(self, split_x: bool) -> Self {
        if split_x {
            Self {
                rev_x: self.rev_x,
                rev_y: !self.rev_y,
            }
        } else {
            Self {
                rev_x: !self.rev_x,
                rev_y: self.rev_y,
            }
        }
    }
}

/// Corner the snake traversal starts from at the root of a level.
#[derive(Clone, Copy)]
enum SnakeStart {
    /// (low x, high y) — even levels.
    TopLeft,
    /// (high x, low y) — odd levels; reverses the previous level's exit.
    BottomRight,
}

impl SnakeStart {
    fn for_level(level_idx: usize) -> Self {
        if level_idx.is_multiple_of(2) {
            Self::TopLeft
        } else {
            Self::BottomRight
        }
    }

    fn initial_dir(self) -> SortDir {
        match self {
            Self::TopLeft => SortDir {
                rev_x: false,
                rev_y: true,
            },
            Self::BottomRight => SortDir {
                rev_x: true,
                rev_y: false,
            },
        }
    }
}

/// STR bulk-loading into spatially compact row-group leaves.
fn str_pack(rows: &mut Vec<u32>, bboxes: &[Bbox], row_group_size: usize, level_idx: usize) {
    let dir = SnakeStart::for_level(level_idx).initial_dir();
    let mut scratch: Vec<(f64, u32)> = vec![(0.0, 0); rows.len()];
    str_pack_rec(
        rows.as_mut_slice(),
        &mut scratch,
        bboxes,
        row_group_size,
        dir,
    );
}

/// Preserve row-group membership while recursively packing each row group's
/// page-sized intervals. Page indexes describe row intervals, so locality must
/// hold at this nested physical unit rather than only at the row-group level.
fn str_pack_pages(
    rows: &mut [u32],
    bboxes: &[Bbox],
    row_group_size: usize,
    page_row_count: usize,
    level_idx: usize,
) {
    rows.chunks_mut(row_group_size)
        .enumerate()
        .for_each(|(row_group_idx, row_group)| {
            let mut scratch = vec![(0.0, 0); row_group.len()];
            let dir = SnakeStart::for_level(level_idx + row_group_idx).initial_dir();
            str_pack_rec(row_group, &mut scratch, bboxes, page_row_count, dir);
        });
}

fn str_pack_rec(
    rows: &mut [u32],
    scratch: &mut [(f64, u32)],
    bboxes: &[Bbox],
    m: usize,
    dir: SortDir,
) {
    let n = rows.len();
    if n <= m {
        return;
    }
    let extent = rows
        .par_iter()
        .fold(Bbox::empty, |mut acc, i| {
            acc.merge(&bboxes[*i as usize]);
            acc
        })
        .reduce(Bbox::empty, |mut a, b| {
            a.merge(&b);
            a
        });
    let split_x = extent.width() >= extent.height();
    let reverse = dir.reverse_on(split_x);

    // Decorate-Sort-Undecorate: stage (key, row_idx) pairs once, sort by
    // key, then write the reordered row indices back. The sort comparator
    // touches only the local scratch buffer instead of doing O(n log n)
    // random reads into `bboxes`.
    scratch
        .par_iter_mut()
        .zip(rows.par_iter())
        .for_each(|(slot, i)| {
            let b = &bboxes[*i as usize];
            let key = if split_x { b.cx() } else { b.cy() };
            *slot = (key, *i);
        });
    scratch.par_sort_unstable_by(|a, b| {
        let ord = a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal);
        if reverse {
            ord.reverse()
        } else {
            ord
        }
    });
    rows.par_iter_mut()
        .zip(scratch.par_iter())
        .for_each(|(r, (_, i))| {
            *r = *i;
        });

    // Split on the caller's physical-unit boundary (row group in the outer
    // pass, page in the inner pass). Only the final leaf may be partial.
    let num_leaves = n.div_ceil(m);
    let left_leaves = (num_leaves / 2).max(1);
    let split_at = left_leaves * m;
    let (left_rows, right_rows) = rows.split_at_mut(split_at);
    let (left_scratch, right_scratch) = scratch.split_at_mut(split_at);
    let right_dir = dir.flip_for_right_child(split_x);
    rayon::join(
        || str_pack_rec(left_rows, left_scratch, bboxes, m, dir),
        || str_pack_rec(right_rows, right_scratch, bboxes, m, right_dir),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_visibility_defaults_and_priority_options() {
        use clap::Parser;
        #[derive(Parser)]
        struct Cli {
            #[command(flatten)]
            args: ConvertArgs,
        }
        let cli = Cli::try_parse_from([
            "cogp",
            "input",
            "output",
            "--priority-column",
            "population",
            "--priority-column-order",
            "asc",
        ])
        .unwrap();
        assert_eq!(cli.args.min_root_features, 2048);
        assert_eq!(cli.args.point_thinning_factor, 4);
        assert_eq!(cli.args.line_visibility_factor, 4);
        assert_eq!(cli.args.polygon_visibility_factor, 4);
        assert_eq!(cli.args.page_row_count, 2048);
        assert_eq!(cli.args.priority_column.as_deref(), Some("population"));
        assert!(matches!(
            cli.args.priority_column_order,
            PriorityColumnOrder::Asc
        ));
    }

    #[test]
    fn sparse_root_uses_cumulative_count_and_preserves_finer_levels() {
        let mut levels = vec![0, 0, 2, 2, 3, 4];
        consolidate_sparse_root(&mut levels, 5, 4);
        assert_eq!(levels, vec![2, 2, 2, 2, 3, 4]);
    }

    #[test]
    fn sparse_root_handles_exact_threshold_small_inputs_and_opt_out() {
        let mut exact = vec![0; 2048];
        exact.push(1);
        let expected = exact.clone();
        consolidate_sparse_root(&mut exact, 3, 2048);
        assert_eq!(exact, expected);
        let mut small = vec![0, 1, 1];
        consolidate_sparse_root(&mut small, 5, 2048);
        assert_eq!(small, vec![4; 3]);
        let mut single_level = vec![0; 3];
        consolidate_sparse_root(&mut single_level, 1, 2048);
        assert_eq!(single_level, vec![0; 3]);
        let mut unchanged = vec![1, 1, 3];
        consolidate_sparse_root(&mut unchanged, 5, 1);
        assert_eq!(unchanged, vec![1, 1, 3]);
    }

    fn bb(xmin: f64, ymin: f64, xmax: f64, ymax: f64) -> Bbox {
        Bbox {
            xmin,
            ymin,
            xmax,
            ymax,
        }
    }

    #[test]
    fn web_mercator_resolutions_monotonic_and_halving() {
        let g = web_mercator_resolutions(0, 4, 1024);
        assert_eq!(g.len(), 5);
        for w in g.windows(2) {
            assert!(
                (w[0] / 2.0 - w[1]).abs() < 1e-6,
                "expected halving, got {w:?}"
            );
        }
        // Web Mercator equatorial circumference / 1024 at z0.
        assert!((g[0] - WEB_MERCATOR_CIRCUMFERENCE_M / 1024.0).abs() < 1e-6);
    }

    #[test]
    fn auto_hints_respect_crs_units_and_unknown_crs() {
        use serde_json::json;
        assert_eq!(
            auto_resolution_scale(None, "geom").unwrap(),
            1.0 / 111_320.0
        );
        for (unit, expected) in [
            (json!("metre"), 1.0),
            (json!("degree"), 1.0 / 111_320.0),
            (
                json!({"type":"LinearUnit", "conversion_factor":0.3048}),
                1.0 / 0.3048,
            ),
        ] {
            let geo = json!({"columns":{"geom":{"crs":{"type":"ProjectedCRS","coordinate_system":{"axis":[{"unit":unit}]}}}}});
            assert_eq!(auto_resolution_scale(Some(&geo), "geom").unwrap(), expected);
        }
        let unknown = json!({"columns":{"geom":{"crs":null}}});
        assert!(auto_resolution_scale(Some(&unknown), "geom").is_err());
    }

    #[test]
    fn priority_orders_by_sort_rank_then_diagonal_then_hash() {
        // Higher sort rank wins even against a much larger MultiPoint bbox.
        let big_low_rank = priority(&bb(0.0, 0.0, 10.0, 10.0), 1, 0);
        let small_high_rank = priority(&bb(0.0, 0.0, 1.0, 1.0), 2, 0);
        assert!(small_high_rank > big_low_rank);

        // Equal sort rank → larger diagonal wins.
        let small = priority(&bb(0.0, 0.0, 1.0, 1.0), 5, 0);
        let large = priority(&bb(0.0, 0.0, 10.0, 10.0), 5, 0);
        assert!(large > small);

        // Equal sort rank and diagonal, different row → deterministic but
        // distinguishable via the hashed tertiary key.
        let a = priority(&bb(0.0, 0.0, 1.0, 1.0), 0, 0);
        let b = priority(&bb(0.0, 0.0, 1.0, 1.0), 0, 1);
        assert_eq!((a.0, a.1), (b.0, b.1));
        assert_ne!(a.2, b.2);
    }

    #[test]
    fn assign_levels_points_always_eligible_from_level_zero() {
        // Two coarse points, far apart → both should land on level 0.
        let bboxes = vec![bb(0.0, 0.0, 0.0, 0.0), bb(1000.0, 1000.0, 1000.0, 1000.0)];
        let kinds = vec![GeomKind::Point, GeomKind::Point];
        let resolutions = vec![100.0, 50.0];
        let out = assign_levels(
            &bboxes,
            &kinds,
            &resolutions,
            1,
            VisibilityFactors {
                line: 1,
                polygon: 1,
            },
            &[0, 0],
        )
        .unwrap();
        assert_eq!(out, vec![0, 0]);
    }

    #[test]
    fn assign_levels_thins_dense_points_to_finer_levels() {
        // Two points falling into the same level-0 grid cell (`prec=100`):
        // one wins level 0, the other gets deferred. With point_thin=1
        // they're both in cell `(0, 0)` at the coarse level.
        let bboxes = vec![bb(10.0, 10.0, 10.0, 10.0), bb(20.0, 20.0, 20.0, 20.0)];
        let kinds = vec![GeomKind::Point, GeomKind::Point];
        let resolutions = vec![100.0, 10.0];
        let out = assign_levels(
            &bboxes,
            &kinds,
            &resolutions,
            1,
            VisibilityFactors {
                line: 1,
                polygon: 1,
            },
            &[0, 0],
        )
        .unwrap();
        let mut sorted = out.clone();
        sorted.sort();
        assert_eq!(sorted, vec![0, 1]);
    }

    #[test]
    fn assign_levels_sort_rank_picks_cell_winner() {
        // Same dense-cluster setup as above (both points share level-0 cell
        // (0,0)), but a higher sort rank on row 1 forces it to win level 0,
        // overriding the otherwise-arbitrary hashed tie-break.
        let bboxes = vec![bb(10.0, 10.0, 10.0, 10.0), bb(20.0, 20.0, 20.0, 20.0)];
        let kinds = vec![GeomKind::Point, GeomKind::Point];
        let resolutions = vec![100.0, 10.0];
        let out = assign_levels(
            &bboxes,
            &kinds,
            &resolutions,
            1,
            VisibilityFactors {
                line: 1,
                polygon: 1,
            },
            &[1, 5],
        )
        .unwrap();
        assert_eq!(out, vec![1, 0]);
    }

    #[test]
    fn compute_sort_ranks_orders_by_value_and_sinks_nulls() {
        use arrow::array::Int32Array;
        let col = Int32Array::from(vec![Some(10), None, Some(30), Some(20)]);

        // desc → largest value gets the highest rank, null the lowest.
        let desc = compute_sort_ranks(&col, PriorityColumnOrder::Desc).unwrap();
        assert!(desc[2] > desc[3] && desc[3] > desc[0] && desc[0] > desc[1]);

        // asc → smallest value gets the highest rank, null still lowest.
        let asc = compute_sort_ranks(&col, PriorityColumnOrder::Asc).unwrap();
        assert!(asc[0] > asc[3] && asc[3] > asc[2] && asc[2] > asc[1]);
    }

    #[test]
    fn row_selection_for_builds_skip_select_runs() {
        let sel = row_selection_for(&[0, 1, 2, 5, 6, 9]);
        let expected = RowSelection::from(vec![
            RowSelector::select(3),
            RowSelector::skip(2),
            RowSelector::select(2),
            RowSelector::skip(2),
            RowSelector::select(1),
        ]);
        assert_eq!(sel, expected);

        // Leading skip when the first selected row is not row 0.
        let sel = row_selection_for(&[3, 4]);
        let expected = RowSelection::from(vec![RowSelector::skip(3), RowSelector::select(2)]);
        assert_eq!(sel, expected);
    }

    #[test]
    fn assign_levels_subthreshold_feature_deferred_to_finer_level() {
        // A lone polygon below the visibility threshold (diagonal² ≈ 2 vs the
        // level-0 threshold² of (10·4)² = 1600) is excluded from the coarse
        // level by the hard gate even though its cell is otherwise empty, and
        // deferred to the finest level. This is what bounds a coarse-zoom read
        // by screen density instead of total dataset size.
        let bboxes = vec![bb(0.0, 0.0, 1.0, 1.0)];
        let kinds = vec![GeomKind::Polygon];
        let resolutions = vec![10.0, 0.5];
        let out = assign_levels(
            &bboxes,
            &kinds,
            &resolutions,
            1,
            VisibilityFactors {
                line: 2,
                polygon: 4,
            },
            &[0],
        )
        .unwrap();
        assert_eq!(out, vec![1]);
    }

    #[test]
    fn assign_levels_visible_feature_beats_subthreshold_in_same_cell() {
        // Two polygons in the same level-0 cell (pitch 10): the visible one
        // (diagonal² = 3200 ≥ 1600) takes level 0; the sub-threshold one
        // (diagonal² = 2) is gated out of level 0 and deferred to a finer
        // level, not dropped.
        let big = bb(-15.0, -15.0, 25.0, 25.0); // center (5,5)
        let small = bb(1.0, 1.0, 2.0, 2.0); // center (1.5,1.5)
        let bboxes = vec![big, small];
        let kinds = vec![GeomKind::Polygon, GeomKind::Polygon];
        let resolutions = vec![10.0, 0.5];
        let out = assign_levels(
            &bboxes,
            &kinds,
            &resolutions,
            1,
            VisibilityFactors {
                line: 2,
                polygon: 4,
            },
            &[0, 0],
        )
        .unwrap();
        assert_eq!(out, vec![0, 1]);
    }

    #[test]
    fn assign_levels_does_not_thin_visible_extended_features() {
        // Each pair has the same bbox center and passes the coarse-level
        // visibility threshold. A center-cell grid would retain only one line
        // and one polygon; extended geometries must all enter the first
        // eligible level.
        let bboxes = vec![
            bb(-30.0, -10.0, 30.0, 10.0),
            bb(-10.0, -30.0, 10.0, 30.0),
            bb(-30.0, -10.0, 30.0, 10.0),
            bb(-10.0, -30.0, 10.0, 30.0),
        ];
        let kinds = vec![
            GeomKind::Line,
            GeomKind::Line,
            GeomKind::Polygon,
            GeomKind::Polygon,
        ];
        let resolutions = vec![10.0, 1.0];
        let out = assign_levels(
            &bboxes,
            &kinds,
            &resolutions,
            1,
            VisibilityFactors {
                line: 2,
                polygon: 4,
            },
            &[0, 0, 0, 0],
        )
        .unwrap();
        assert_eq!(out, vec![0, 0, 0, 0]);
    }

    #[test]
    fn str_pack_preserves_set_and_uses_full_leaves() {
        // 17 features in row groups of 10 → never drops a row.
        let mut bboxes = Vec::new();
        for i in 0..17 {
            let x = (i % 5) as f64;
            let y = (i / 5) as f64;
            bboxes.push(bb(x, y, x + 0.1, y + 0.1));
        }
        let mut rows: Vec<u32> = (0..17u32).collect();
        str_pack(&mut rows, &bboxes, 10, 0);
        let mut sorted = rows.clone();
        sorted.sort();
        let expected: Vec<u32> = (0..17u32).collect();
        assert_eq!(sorted, expected, "str_pack must preserve the row set");
    }

    #[test]
    fn flushed_row_group_end_errors_on_empty() {
        // The shim error path is hard to hit in real code (there's always
        // ≥1 row group), but the helper must refuse to lie.
        let buf = Vec::new();
        let schema = Arc::new(Schema::new(vec![Field::new("a", DataType::Int32, false)]));
        let writer = ArrowWriter::try_new(buf, schema, None).unwrap();
        assert!(flushed_row_group_end(&writer).is_err());
    }

    #[test]
    fn snake_start_alternates_per_level() {
        // Even levels start top-left, odd levels bottom-right. The first
        // axis direction flips so the snake's exit on level N lines up
        // with the entry on level N+1.
        let d0 = SnakeStart::for_level(0).initial_dir();
        let d1 = SnakeStart::for_level(1).initial_dir();
        assert!(!d0.rev_x && d0.rev_y);
        assert!(d1.rev_x && !d1.rev_y);
    }
}
