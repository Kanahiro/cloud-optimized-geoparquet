//! Configurable range coalescing for asynchronous Parquet readers.
//!
//! `object_store` coalesces vectored reads with a fixed one-megabyte gap. This
//! adapter deliberately calls the wrapped reader's single-range operation so
//! that its two explicit budgets are the only coalescing policy applied.

use anyhow::{bail, Result};
use bytes::Bytes;
use futures::future::BoxFuture;
use futures::{FutureExt, StreamExt, TryStreamExt};
use parquet::arrow::arrow_reader::ArrowReaderOptions;
use parquet::arrow::async_reader::AsyncFileReader;
use parquet::errors::{ParquetError, Result as ParquetResult};
use parquet::file::metadata::ParquetMetaData;
use std::ops::Range;
use std::sync::Arc;

const DEFAULT_MAX_GAP_BYTES: u64 = 128 * 1024;
const DEFAULT_MAX_OVERFETCH_RATIO: f64 = 1.25;
const MAX_PARALLEL_REQUESTS: usize = 10;

/// Controls when adjacent byte ranges are fetched as one request.
///
/// A merge must satisfy both limits. Overlapping ranges are always combined
/// because doing so introduces no extra transfer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RangeCoalescingOptions {
    max_gap_bytes: u64,
    max_overfetch_ratio: f64,
}

impl Default for RangeCoalescingOptions {
    fn default() -> Self {
        Self {
            max_gap_bytes: DEFAULT_MAX_GAP_BYTES,
            max_overfetch_ratio: DEFAULT_MAX_OVERFETCH_RATIO,
        }
    }
}

impl RangeCoalescingOptions {
    pub fn with_max_gap_bytes(mut self, bytes: u64) -> Self {
        self.max_gap_bytes = bytes;
        self
    }

    pub fn with_max_overfetch_ratio(mut self, ratio: f64) -> Self {
        self.max_overfetch_ratio = ratio;
        self
    }

    pub fn max_gap_bytes(&self) -> u64 {
        self.max_gap_bytes
    }

    pub fn max_overfetch_ratio(&self) -> f64 {
        self.max_overfetch_ratio
    }

    fn validate(&self) -> Result<()> {
        if !self.max_overfetch_ratio.is_finite() || self.max_overfetch_ratio < 1.0 {
            bail!(
                "max_overfetch_ratio must be a finite number >= 1, got {}",
                self.max_overfetch_ratio
            );
        }
        Ok(())
    }
}

/// An [`AsyncFileReader`] adapter that applies configurable coalescing to
/// vectored reads while preserving the exact ranges expected by Parquet.
///
/// The wrapped reader must be cheaply cloneable so merged requests can run in
/// parallel without serializing on `&mut self`. `ParquetObjectReader` satisfies
/// this contract: its clones share the underlying object store.
#[derive(Clone, Debug)]
pub struct RangeCoalescingReader<R> {
    inner: R,
    options: RangeCoalescingOptions,
}

impl<R> RangeCoalescingReader<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            options: RangeCoalescingOptions::default(),
        }
    }

    pub fn try_new(inner: R, options: RangeCoalescingOptions) -> Result<Self> {
        options.validate()?;
        Ok(Self { inner, options })
    }

    pub fn inner(&self) -> &R {
        &self.inner
    }

    pub fn into_inner(self) -> R {
        self.inner
    }

    pub fn options(&self) -> RangeCoalescingOptions {
        self.options
    }
}

impl<R> AsyncFileReader for RangeCoalescingReader<R>
where
    R: AsyncFileReader + Clone + Send + 'static,
{
    fn get_bytes(&mut self, range: Range<u64>) -> BoxFuture<'_, ParquetResult<Bytes>> {
        self.inner.get_bytes(range)
    }

    fn get_byte_ranges(
        &mut self,
        ranges: Vec<Range<u64>>,
    ) -> BoxFuture<'_, ParquetResult<Vec<Bytes>>> {
        let merged = match make_merged_ranges(&ranges, self.options) {
            Ok(merged) => merged,
            Err(error) => return futures::future::ready(Err(error)).boxed(),
        };
        let readers = merged
            .iter()
            .map(|_| self.inner.clone())
            .collect::<Vec<_>>();

        async move {
            let fetched = futures::stream::iter(readers.into_iter().zip(merged.iter().cloned()))
                .map(|(mut reader, range)| async move { reader.get_bytes(range).await })
                .buffered(MAX_PARALLEL_REQUESTS)
                .try_collect::<Vec<_>>()
                .await?;

            ranges
                .iter()
                .map(|range| slice_merged_range(range, &merged, &fetched))
                .collect()
        }
        .boxed()
    }

    fn get_metadata<'a>(
        &'a mut self,
        options: Option<&'a ArrowReaderOptions>,
    ) -> BoxFuture<'a, ParquetResult<Arc<ParquetMetaData>>> {
        self.inner.get_metadata(options)
    }
}

#[derive(Debug)]
struct Run {
    range: Range<u64>,
    requested_bytes: u64,
}

fn make_merged_ranges(
    ranges: &[Range<u64>],
    options: RangeCoalescingOptions,
) -> ParquetResult<Vec<Range<u64>>> {
    let mut sorted = ranges.to_vec();
    if sorted.iter().any(|range| range.start > range.end) {
        return Err(ParquetError::General("invalid byte range".into()));
    }
    sorted.retain(|range| !range.is_empty());
    sorted.sort_unstable_by_key(|range| (range.start, range.end));

    let mut runs: Vec<Run> = Vec::new();
    for range in sorted {
        let Some(run) = runs.last_mut() else {
            let requested_bytes = range.end - range.start;
            runs.push(Run {
                range,
                requested_bytes,
            });
            continue;
        };

        let gap = range.start.saturating_sub(run.range.end);
        let merged_end = run.range.end.max(range.end);
        let added_requested = range.end.saturating_sub(range.start.max(run.range.end));
        let requested_bytes = run.requested_bytes + added_requested;
        let merged_span = merged_end - run.range.start;
        let ratio = merged_span as f64 / requested_bytes as f64;
        let overlaps = range.start <= run.range.end;

        if overlaps || (gap <= options.max_gap_bytes && ratio <= options.max_overfetch_ratio) {
            run.range.end = merged_end;
            run.requested_bytes = requested_bytes;
        } else {
            runs.push(Run {
                requested_bytes: range.end - range.start,
                range,
            });
        }
    }
    Ok(runs.into_iter().map(|run| run.range).collect())
}

fn slice_merged_range(
    requested: &Range<u64>,
    merged: &[Range<u64>],
    fetched: &[Bytes],
) -> ParquetResult<Bytes> {
    if requested.is_empty() {
        return Ok(Bytes::new());
    }
    let index = merged.partition_point(|range| range.start <= requested.start);
    let index = index
        .checked_sub(1)
        .ok_or_else(|| ParquetError::General(format!("no merged range contains {requested:?}")))?;
    let container = &merged[index];
    if requested.end > container.end {
        return Err(ParquetError::General(format!(
            "no merged range contains {requested:?}"
        )));
    }
    let start = usize::try_from(requested.start - container.start)?;
    let end = usize::try_from(requested.end - container.start)?;
    let bytes = fetched.get(index).ok_or_else(|| {
        ParquetError::General(format!("missing response for merged range {container:?}"))
    })?;
    if end > bytes.len() {
        return Err(ParquetError::EOF(format!(
            "received {} bytes for {container:?}, need {end}",
            bytes.len()
        )));
    }
    Ok(bytes.slice(start..end))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(gap: u64, ratio: f64) -> RangeCoalescingOptions {
        RangeCoalescingOptions::default()
            .with_max_gap_bytes(gap)
            .with_max_overfetch_ratio(ratio)
    }

    #[test]
    fn merges_only_within_both_budgets() {
        let ranges = vec![0..10, 15..25, 31..41, 200..210];
        assert_eq!(
            make_merged_ranges(&ranges, options(100, 1.25)).unwrap(),
            vec![0..25, 31..41, 200..210]
        );
    }

    #[test]
    fn overlapping_ranges_always_merge() {
        let ranges = vec![20..40, 10..30, 25..26];
        assert_eq!(
            make_merged_ranges(&ranges, options(0, 1.0)).unwrap(),
            vec![10..40]
        );
    }

    #[test]
    fn rejects_invalid_ratio() {
        assert!(RangeCoalescingReader::try_new(
            (),
            RangeCoalescingOptions::default().with_max_overfetch_ratio(0.9)
        )
        .is_err());
    }

    #[test]
    fn restores_original_order_and_exact_slices() {
        let merged = vec![10..40, 100..110];
        let fetched = vec![
            Bytes::from((10_u8..40).collect::<Vec<_>>()),
            Bytes::from_static(b"abcdefghij"),
        ];
        assert_eq!(
            slice_merged_range(&(25..30), &merged, &fetched).unwrap(),
            Bytes::from_static(&[25, 26, 27, 28, 29])
        );
        assert_eq!(
            slice_merged_range(&(100..103), &merged, &fetched).unwrap(),
            Bytes::from_static(b"abc")
        );
    }
}
