//! Measure how well a COGP file's physical layout prunes viewport reads.
//!
//! For each level scope (the cumulative row-group prefix a reader selects at
//! that level's resolution) it samples square query windows sized in level
//! resolution units and reports, per query:
//!
//! - row groups whose bbox statistics intersect the window, and how many of
//!   those contain no intersecting feature ("empty");
//! - bbox pages (Page Index row intervals) whose bbox intersects the window,
//!   and how many of those are empty;
//! - compressed MB of every column's pages overlapping the selected rows;
//! - precision: intersecting features / rows in the selected pages.
//!
//! ```sh
//! cargo run --release --example layout_eval -- file.cogp.parquet
//! ```

use std::fs::File;
use std::path::PathBuf;

use anyhow::{Context, Result};
use arrow_array::{cast::AsArray, types::Float64Type, Array, RecordBatch};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::arrow::arrow_reader::{ArrowReaderMetadata, ArrowReaderOptions};
use parquet::arrow::ProjectionMask;

type Bbox = [f64; 4];

fn empty() -> Bbox {
    [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ]
}
fn merge(a: &mut Bbox, b: &Bbox) {
    a[0] = a[0].min(b[0]);
    a[1] = a[1].min(b[1]);
    a[2] = a[2].max(b[2]);
    a[3] = a[3].max(b[3]);
}
fn hit(a: &Bbox, q: &Bbox) -> bool {
    a[2] >= q[0] && a[0] <= q[2] && a[3] >= q[1] && a[1] <= q[3]
}

/// xorshift64*: deterministic and dependency-free.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

struct Args {
    path: PathBuf,
    queries: usize,
    seed: u64,
    windows: Vec<f64>,
    all_levels: bool,
    breakdown: bool,
}

fn parse_args() -> Result<Args> {
    let mut it = std::env::args().skip(1);
    let mut args = Args {
        path: PathBuf::new(),
        queries: 2000,
        seed: 1,
        windows: vec![1024.0, 4096.0],
        all_levels: false,
        breakdown: false,
    };
    while let Some(a) = it.next() {
        match a.as_str() {
            "--queries" => args.queries = it.next().context("--queries N")?.parse()?,
            "--seed" => args.seed = it.next().context("--seed N")?.parse()?,
            "--windows" => {
                args.windows = it
                    .next()
                    .context("--windows a,b")?
                    .split(',')
                    .map(str::parse)
                    .collect::<Result<_, _>>()?
            }
            "--all-levels" => args.all_levels = true,
            "--breakdown" => args.breakdown = true,
            _ => args.path = PathBuf::from(a),
        }
    }
    anyhow::ensure!(!args.path.as_os_str().is_empty(), "usage: layout_eval FILE [--queries N] [--seed N] [--windows 1024,4096] [--all-levels] [--breakdown]");
    Ok(args)
}

struct RowGroup {
    start: usize,
    rows: usize,
    bbox: Bbox,
    /// Bbox pages: (first row offset in group, row count, bbox).
    pages: Vec<(usize, usize, Bbox)>,
    /// Per column: (first row offset in group, file offset, compressed page bytes).
    column_pages: Vec<Vec<(usize, u64, u64)>>,
    /// Page Index bytes a pruning reader fetches for this group: bbox
    /// ColumnIndexes plus every column's OffsetIndex.
    index_bytes: u64,
}

#[derive(Default, Clone, Copy)]
struct Tally {
    rg: f64,
    rg_empty: f64,
    pages: f64,
    pages_empty: f64,
    bytes: f64,
    useful_rows: f64,
    selected_rows: f64,
    index_bytes: f64,
    /// Contiguous data byte ranges (adjacent pages merged, gaps never filled).
    requests: f64,
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let reader = cogp::reader::Reader::open(&args.path)?;
    let file = File::open(&args.path)?;
    let meta = ArrowReaderMetadata::load(&file, ArrowReaderOptions::new().with_page_index(true))?;
    let pq = meta.metadata().clone();
    let geo = reader.geo_meta();
    let covering = geo
        .columns
        .get(&geo.primary_column)
        .and_then(|c| c.covering.as_ref())
        .context("primary geometry has no bbox covering")?;
    let schema = pq.file_metadata().schema_descr();
    let find = |parts: &[String]| -> Result<usize> {
        let dotted = parts.join(".");
        (0..schema.num_columns())
            .find(|i| schema.column(*i).path().string() == dotted)
            .with_context(|| format!("covering column {dotted} not found"))
    };
    let cols = [
        find(&covering.bbox.xmin)?,
        find(&covering.bbox.ymin)?,
        find(&covering.bbox.xmax)?,
        find(&covering.bbox.ymax)?,
    ];

    // Per-row bboxes in file order.
    let builder = ParquetRecordBatchReaderBuilder::try_new(File::open(&args.path)?)?;
    let mask = ProjectionMask::leaves(schema, cols);
    let batches = builder
        .with_projection(mask)
        .with_batch_size(65_536)
        .build()?;
    let mut bboxes: Vec<Bbox> = Vec::with_capacity(pq.file_metadata().num_rows() as usize);
    for batch in batches {
        let batch: RecordBatch = batch?;
        // Projection keeps the bbox struct; flatten its four leaves.
        let leaves: Vec<_> = flatten_f64(&batch)?;
        anyhow::ensure!(leaves.len() == 4, "expected four bbox leaves");
        let [xmin, ymin, xmax, ymax] = [&leaves[0], &leaves[1], &leaves[2], &leaves[3]];
        bboxes.extend(
            xmin.iter()
                .zip(ymin)
                .zip(xmax)
                .zip(ymax)
                .map(|(((a, b), c), d)| [*a, *b, *c, *d]),
        );
    }

    let offsets = pq.offset_index().context("file has no offset index")?;
    let mut groups = Vec::with_capacity(pq.num_row_groups());
    let mut start = 0usize;
    for (rg_i, rg) in pq.row_groups().iter().enumerate() {
        let rows = rg.num_rows() as usize;
        let mut bbox = empty();
        for b in &bboxes[start..start + rows] {
            merge(&mut bbox, b);
        }
        let page_starts = |col: usize| -> Vec<(usize, u64, u64)> {
            offsets[rg_i][col]
                .page_locations()
                .iter()
                .map(|p| {
                    (
                        p.first_row_index as usize,
                        p.offset as u64,
                        p.compressed_page_size as u64,
                    )
                })
                .collect()
        };
        let xmin_pages = page_starts(cols[0]);
        let pages = xmin_pages
            .iter()
            .enumerate()
            .map(|(i, (first, _, _))| {
                let end = xmin_pages.get(i + 1).map_or(rows, |p| p.0);
                let mut b = empty();
                for r in &bboxes[start + first..start + end] {
                    merge(&mut b, r);
                }
                (*first, end - first, b)
            })
            .collect();
        let column_pages = (0..rg.num_columns()).map(page_starts).collect();
        let index_bytes = rg
            .columns()
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let column_index = if cols.contains(&i) {
                    c.column_index_length().unwrap_or(0) as u64
                } else {
                    0
                };
                column_index + c.offset_index_length().unwrap_or(0) as u64
            })
            .sum();
        groups.push(RowGroup {
            start,
            rows,
            bbox,
            pages,
            column_pages,
            index_bytes,
        });
        start += rows;
    }

    let mut extent = empty();
    for g in &groups {
        merge(&mut extent, &g.bbox);
    }
    let levels = reader.levels();
    println!(
        "{}: {} rows, {} row groups, {} levels",
        args.path.display(),
        bboxes.len(),
        groups.len(),
        levels.len()
    );
    let scopes: Vec<usize> = if args.all_levels {
        (0..levels.len()).collect()
    } else {
        let mut v = vec![levels.len() / 2, levels.len() - 1];
        v.dedup();
        v
    };
    println!("| level | window | centers | RG/q | empty RG/q | pages/q | empty pages/q | MB/q | precision | index MB/q | requests/q |");
    println!("|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|");
    for &level in &scopes {
        let end = reader.row_groups_up_to_level(level).end;
        let scope = &groups[..end];
        let scope_rows = scope.last().map_or(0, |g| g.start + g.rows);
        for &mult in &args.windows {
            let side = levels[level].resolution * mult;
            for centers in ["features", "uniform"] {
                let mut rng = Rng(args.seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
                let mut per_group = vec![Tally::default(); scope.len()];
                for _ in 0..args.queries {
                    let (cx, cy) = if centers == "features" {
                        let b = &bboxes[(rng.next() % scope_rows as u64) as usize];
                        ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0)
                    } else {
                        (
                            extent[0] + rng.unit() * (extent[2] - extent[0]),
                            extent[1] + rng.unit() * (extent[3] - extent[1]),
                        )
                    };
                    let q = [
                        cx - side / 2.0,
                        cy - side / 2.0,
                        cx + side / 2.0,
                        cy + side / 2.0,
                    ];
                    evaluate(scope, &bboxes, &q, &mut per_group);
                }
                let n = args.queries as f64;
                let t = sum(&per_group);
                println!(
                    "| {level} | {mult} | {centers} | {:.2} | {:.2} | {:.1} | {:.1} | {:.3} | {:.3} | {:.3} | {:.1} |",
                    t.rg / n,
                    t.rg_empty / n,
                    t.pages / n,
                    t.pages_empty / n,
                    t.bytes / n / 1e6,
                    if t.selected_rows > 0.0 { t.useful_rows / t.selected_rows } else { 0.0 },
                    t.index_bytes / n / 1e6,
                    t.requests / n,
                );
                if args.breakdown && level == *scopes.last().unwrap() {
                    // Attribute each row group to the level that owns it.
                    for (owner, lv) in levels.iter().enumerate() {
                        let range = reader.row_groups_in_level(owner).unwrap_or(0..0);
                        if range.is_empty() || range.start >= end {
                            continue;
                        }
                        let rows: usize = scope[range.clone()].iter().map(|g| g.rows).sum();
                        let t = sum(&per_group[range.clone()]);
                        println!(
                            "|  ↳ L{owner} ({rows} rows, {} RG, res {:.2e}) | | | {:.2} | {:.2} | {:.1} | {:.1} | {:.3} | {:.3} |",
                            range.len(),
                            lv.resolution,
                            t.rg / n,
                            t.rg_empty / n,
                            t.pages / n,
                            t.pages_empty / n,
                            t.bytes / n / 1e6,
                            if t.selected_rows > 0.0 { t.useful_rows / t.selected_rows } else { 0.0 },
                        );
                    }
                }
            }
        }
    }
    Ok(())
}

fn evaluate(scope: &[RowGroup], bboxes: &[Bbox], q: &Bbox, per_group: &mut [Tally]) {
    for (g, t) in scope.iter().zip(per_group.iter_mut()) {
        if !hit(&g.bbox, q) {
            continue;
        }
        t.rg += 1.0;
        t.index_bytes += g.index_bytes as f64;
        let mut selected: Vec<(usize, usize)> = Vec::new();
        let mut group_useful = 0usize;
        for (first, rows, b) in &g.pages {
            if !hit(b, q) {
                continue;
            }
            t.pages += 1.0;
            let useful = bboxes[g.start + first..g.start + first + rows]
                .iter()
                .filter(|r| hit(r, q))
                .count();
            if useful == 0 {
                t.pages_empty += 1.0;
            }
            group_useful += useful;
            t.selected_rows += *rows as f64;
            selected.push((*first, first + rows));
        }
        if group_useful == 0 {
            t.rg_empty += 1.0;
        }
        t.useful_rows += group_useful as f64;
        let mut ranges: Vec<(u64, u64)> = Vec::new();
        for pages in &g.column_pages {
            for (i, (first, offset, size)) in pages.iter().enumerate() {
                let end = pages.get(i + 1).map_or(g.rows, |p| p.0);
                if selected.iter().any(|(s, e)| *first < *e && *s < end) {
                    t.bytes += *size as f64;
                    ranges.push((*offset, offset + size));
                }
            }
        }
        ranges.sort_unstable();
        let mut last_end = None;
        for (start, end) in ranges {
            if last_end != Some(start) {
                t.requests += 1.0;
            }
            last_end = Some(end);
        }
    }
}

fn sum(tallies: &[Tally]) -> Tally {
    tallies.iter().fold(Tally::default(), |mut a, t| {
        a.rg += t.rg;
        a.rg_empty += t.rg_empty;
        a.pages += t.pages;
        a.pages_empty += t.pages_empty;
        a.bytes += t.bytes;
        a.useful_rows += t.useful_rows;
        a.selected_rows += t.selected_rows;
        a.index_bytes += t.index_bytes;
        a.requests += t.requests;
        a
    })
}

fn flatten_f64(batch: &RecordBatch) -> Result<Vec<Vec<f64>>> {
    let mut out = Vec::new();
    for col in batch.columns() {
        collect(col.as_ref(), &mut out)?;
    }
    Ok(out)
}

fn collect(array: &dyn Array, out: &mut Vec<Vec<f64>>) -> Result<()> {
    if let Some(s) = array.as_struct_opt() {
        for c in s.columns() {
            collect(c.as_ref(), out)?;
        }
        return Ok(());
    }
    let values = array
        .as_primitive_opt::<Float64Type>()
        .context("bbox covering leaves must be Float64")?;
    out.push(values.values().to_vec());
    Ok(())
}
