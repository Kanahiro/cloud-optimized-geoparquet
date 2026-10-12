//! Lazy bbox PageIndex loading and conservative row selection.
//!
//! The Parquet footer already carries every ColumnIndex/OffsetIndex byte range.
//! Loading all indexes when a [`crate::reader::Reader`] opens would make startup
//! proportional to the entire dataset. This module instead fetches only the
//! four bbox indexes for Row Groups that survived footer-level pruning.

use anyhow::{bail, Context, Result};
use parquet::arrow::arrow_reader::RowSelection;
#[cfg(feature = "async")]
use parquet::arrow::async_reader::AsyncFileReader;
use parquet::basic::Type;
use parquet::file::metadata::ParquetMetaData;
use parquet::file::page_index::column_index::ColumnIndexMetaData;
use parquet::file::page_index::index_reader::{decode_column_index, decode_offset_index};
use parquet::file::page_index::offset_index::OffsetIndexMetaData;
use parquet::file::reader::ChunkReader;
use std::ops::Range;

#[derive(Clone, Copy)]
enum BboxLeaf {
    Xmin,
    Ymin,
    Xmax,
    Ymax,
}

impl BboxLeaf {
    fn misses(self, min: f64, max: f64, query: [f64; 4]) -> bool {
        let [qxmin, qymin, qxmax, qymax] = query;
        match self {
            Self::Xmin => min > qxmax,
            Self::Ymin => min > qymax,
            Self::Xmax => max < qxmin,
            Self::Ymax => max < qymin,
        }
    }
}

struct Request {
    output_row_start: usize,
    row_group_rows: usize,
    leaf: BboxLeaf,
    column_type: Type,
    column_index: Range<u64>,
    offset_index: Range<u64>,
}

struct Plan {
    total_rows: usize,
    requests: Vec<Request>,
}

impl Plan {
    fn new(metadata: &ParquetMetaData, row_groups: &[usize], bbox_columns: [usize; 4]) -> Self {
        let mut output_row_start = 0;
        let mut requests = Vec::new();
        for &row_group_index in row_groups {
            let Some(row_group) = metadata.row_groups().get(row_group_index) else {
                continue;
            };
            let row_group_rows = row_group.num_rows() as usize;
            for (leaf, column_index) in [
                BboxLeaf::Xmin,
                BboxLeaf::Ymin,
                BboxLeaf::Xmax,
                BboxLeaf::Ymax,
            ]
            .into_iter()
            .zip(bbox_columns)
            {
                let Some(column) = row_group.columns().get(column_index) else {
                    continue;
                };
                let (Some(column_index), Some(offset_index)) = (
                    index_range(column.column_index_offset(), column.column_index_length()),
                    index_range(column.offset_index_offset(), column.offset_index_length()),
                ) else {
                    continue;
                };
                requests.push(Request {
                    output_row_start,
                    row_group_rows,
                    leaf,
                    column_type: column.column_type(),
                    column_index,
                    offset_index,
                });
            }
            output_row_start += row_group_rows;
        }
        Self {
            total_rows: output_row_start,
            requests,
        }
    }

    fn ranges(&self) -> Vec<Range<u64>> {
        self.requests
            .iter()
            .flat_map(|request| [request.column_index.clone(), request.offset_index.clone()])
            .collect()
    }

    fn selection<I, B>(self, buffers: I, query: [f64; 4]) -> Result<Option<RowSelection>>
    where
        I: IntoIterator<Item = B>,
        B: AsRef<[u8]>,
    {
        if self.requests.is_empty() {
            return Ok(None);
        }
        let mut buffers = buffers.into_iter();
        let mut keep = vec![true; self.total_rows];
        for request in self.requests {
            let column_bytes = buffers.next().context("missing ColumnIndex response")?;
            let offset_bytes = buffers.next().context("missing OffsetIndex response")?;
            let column = decode_column_index(column_bytes.as_ref(), request.column_type)
                .context("decoding bbox ColumnIndex")?;
            let offset =
                decode_offset_index(offset_bytes.as_ref()).context("decoding bbox OffsetIndex")?;
            prune_pages(&mut keep, &request, &column, &offset, query);
        }
        if buffers.next().is_some() {
            bail!("received more PageIndex responses than requested");
        }
        Ok(Some(selection_from_bitmap(&keep)))
    }
}

pub(crate) fn read_sync<R: ChunkReader>(
    reader: &R,
    metadata: &ParquetMetaData,
    row_groups: &[usize],
    bbox_columns: [usize; 4],
    query: [f64; 4],
) -> Result<Option<RowSelection>> {
    let plan = Plan::new(metadata, row_groups, bbox_columns);
    let buffers = plan
        .ranges()
        .into_iter()
        .map(|range| {
            let len = usize::try_from(range.end - range.start)?;
            Ok(reader.get_bytes(range.start, len)?)
        })
        .collect::<Result<Vec<_>>>()?;
    plan.selection(buffers, query)
}

#[cfg(feature = "async")]
pub(crate) async fn read_async<R: AsyncFileReader + Send>(
    reader: &mut R,
    metadata: &ParquetMetaData,
    row_groups: &[usize],
    bbox_columns: [usize; 4],
    query: [f64; 4],
) -> Result<Option<RowSelection>> {
    let plan = Plan::new(metadata, row_groups, bbox_columns);
    let ranges = plan.ranges();
    if ranges.is_empty() {
        return Ok(None);
    }
    let buffers = reader.get_byte_ranges(ranges).await?;
    plan.selection(buffers, query)
}

fn index_range(offset: Option<i64>, length: Option<i32>) -> Option<Range<u64>> {
    let start = u64::try_from(offset?).ok()?;
    let length = u64::try_from(length?).ok()?;
    start.checked_add(length).map(|end| start..end)
}

fn prune_pages(
    keep: &mut [bool],
    request: &Request,
    column: &ColumnIndexMetaData,
    offset: &OffsetIndexMetaData,
    query: [f64; 4],
) {
    let ColumnIndexMetaData::DOUBLE(column) = column else {
        return;
    };
    let locations = offset.page_locations();
    let page_count = column
        .min_values()
        .len()
        .min(column.max_values().len())
        .min(locations.len());
    for page_index in 0..page_count {
        if column.is_null_page(page_index) {
            continue;
        }
        let min = column.min_values()[page_index];
        let max = column.max_values()[page_index];
        if !request.leaf.misses(min, max, query) {
            continue;
        }
        let Ok(start) = usize::try_from(locations[page_index].first_row_index) else {
            continue;
        };
        let end = locations
            .get(page_index + 1)
            .and_then(|page| usize::try_from(page.first_row_index).ok())
            .unwrap_or(request.row_group_rows)
            .min(request.row_group_rows);
        if start >= end || start >= request.row_group_rows {
            continue;
        }
        let start = request.output_row_start + start;
        let end = request.output_row_start + end;
        keep[start..end].fill(false);
    }
}

fn selection_from_bitmap(keep: &[bool]) -> RowSelection {
    let mut ranges = Vec::new();
    let mut start = None;
    for (row, &selected) in keep.iter().enumerate() {
        match (start, selected) {
            (None, true) => start = Some(row),
            (Some(first), false) => {
                ranges.push(first..row);
                start = None;
            }
            _ => {}
        }
    }
    if let Some(first) = start {
        ranges.push(first..keep.len());
    }
    RowSelection::from_consecutive_ranges(ranges.into_iter(), keep.len())
}
