//! Reader for COGP (Cloud Optimized GeoParquet Profile) files.
//!
//! The Parquet footer (and the `geo` / `cogp` key-value metadata it carries) is
//! parsed exactly once when the reader is constructed and cached as an
//! [`ArrowReaderMetadata`]. All later reads — sync or async, local or remote —
//! reuse that cached metadata via `new_with_metadata`, so the footer is never
//! re-read. The selector methods take `&self` and never consume the reader, so
//! a single `Reader` can be held in server state and fan out across requests.
//!
//! Two paths are provided:
//!
//! - **Sync** ([`Reader::open`] / [`Reader::try_new`] /
//!   [`Reader::sync_batch_reader`]) — for local files or any
//!   [`parquet::file::reader::ChunkReader`].
//! - **Async** ([`Reader::try_new_async`] / [`Reader::async_batch_stream`],
//!   `feature = "async"`) — for remote sources behind
//!   [`parquet::arrow::async_reader::AsyncFileReader`]. Enable the
//!   `object_store` feature to use `ParquetObjectReader` with S3 / GCS / HTTP.
//!
//! Geometries stay in their on-disk WKB form in the returned
//! [`arrow_array::RecordBatch`]es; downstream callers convert them via
//! [`geozero`](https://crates.io/crates/geozero) — see the README.
use anyhow::{anyhow, Context, Result};
use parquet::arrow::arrow_reader::{
    ArrowReaderMetadata, ArrowReaderOptions, ParquetRecordBatchReader,
    ParquetRecordBatchReaderBuilder,
};
use parquet::file::metadata::ParquetMetaData;
use parquet::file::reader::ChunkReader;
use parquet::file::statistics::Statistics;
use std::fs::File;
use std::ops::Range;
use std::path::Path;
use std::sync::Arc;

#[cfg(feature = "async")]
use parquet::arrow::async_reader::{
    AsyncFileReader, ParquetRecordBatchStream, ParquetRecordBatchStreamBuilder,
};

#[cfg(feature = "object_store")]
pub use parquet::arrow::async_reader::ParquetObjectReader;

use crate::meta::{CogpMeta, GeoMeta, Level, COGP_METADATA_KEY, GEO_METADATA_KEY};

/// Cached COGP file handle. Holds the parsed footer + COGP/GeoParquet metadata.
/// Cheap to clone (the underlying `ArrowReaderMetadata` is `Arc`-backed) and
/// `Send + Sync`, so it can live in shared server state.
#[derive(Clone)]
pub struct Reader {
    arrow_meta: ArrowReaderMetadata,
    geo_meta: GeoMeta,
    cogp_meta: CogpMeta,
}

impl Reader {
    /// Open a local file, parse the footer once, then drop the file handle.
    /// Per-request reads supply a fresh `File` (or any [`ChunkReader`]).
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
        Self::try_new(file)
    }

    /// Parse the footer from any [`ChunkReader`] (e.g. `File`, `bytes::Bytes`).
    /// The reader is consumed for the footer read; it is **not** stored — pass
    /// a fresh reader to [`Self::sync_batch_reader`] per request.
    pub fn try_new<R: ChunkReader + 'static>(reader: R) -> Result<Self> {
        let arrow_meta = ArrowReaderMetadata::load(&reader, ArrowReaderOptions::new())?;
        Self::from_arrow_metadata(arrow_meta)
    }

    /// Parse the footer from an [`AsyncFileReader`] (e.g. an `object_store`
    /// [`ParquetObjectReader`]). Borrows the reader so the caller retains it
    /// for later batch streams — but you must hand a fresh `AsyncFileReader`
    /// to [`Self::async_batch_stream`] per request because building the
    /// stream consumes the reader by value.
    #[cfg(feature = "async")]
    pub async fn try_new_async<R: AsyncFileReader>(reader: &mut R) -> Result<Self> {
        let arrow_meta =
            ArrowReaderMetadata::load_async(reader, ArrowReaderOptions::new()).await?;
        Self::from_arrow_metadata(arrow_meta)
    }

    /// Build from an already-parsed [`ArrowReaderMetadata`]. Useful when the
    /// caller has its own footer cache (e.g. a CDN / Redis layer in front of
    /// S3) and wants to skip even the initial range request.
    pub fn from_arrow_metadata(arrow_meta: ArrowReaderMetadata) -> Result<Self> {
        let (geo_meta, cogp_meta) = parse_cogp_kv(arrow_meta.metadata())?;
        Ok(Self {
            arrow_meta,
            geo_meta,
            cogp_meta,
        })
    }

    pub fn arrow_metadata(&self) -> &ArrowReaderMetadata {
        &self.arrow_meta
    }

    pub fn parquet_metadata(&self) -> &Arc<ParquetMetaData> {
        self.arrow_meta.metadata()
    }

    pub fn geo_meta(&self) -> &GeoMeta {
        &self.geo_meta
    }

    pub fn cogp_meta(&self) -> &CogpMeta {
        &self.cogp_meta
    }

    pub fn levels(&self) -> &[Level] {
        &self.cogp_meta.levels
    }

    pub fn primary_column(&self) -> &str {
        &self.geo_meta.primary_column
    }

    pub fn num_row_groups(&self) -> usize {
        self.arrow_meta.metadata().num_row_groups()
    }

    /// Row groups belonging to a single level (start..=end), or `None` if `level`
    /// is out of range. Row groups within one level are STR-packed so reading in
    /// natural order yields a spatially coherent stream.
    pub fn row_groups_in_level(&self, level: usize) -> Option<Range<usize>> {
        let l = self.cogp_meta.levels.get(level)?;
        let start = if level == 0 {
            0
        } else {
            (self.cogp_meta.levels[level - 1].row_group_end + 1) as usize
        };
        let end = (l.row_group_end + 1) as usize;
        Some(start..end)
    }

    /// Row groups for all levels up to and including `level` — the typical
    /// "progressive read" shape: include this level plus every coarser one.
    /// Clamps to the available level range; returns an empty range if there
    /// are no levels.
    pub fn row_groups_up_to_level(&self, level: usize) -> Range<usize> {
        if self.cogp_meta.levels.is_empty() {
            return 0..0;
        }
        let i = level.min(self.cogp_meta.levels.len() - 1);
        0..(self.cogp_meta.levels[i].row_group_end + 1) as usize
    }

    /// Row groups for every level whose GSD is `>= min_gsd` (coarser than the
    /// caller's target resolution). Use this when you have a target ground
    /// resolution (e.g. screen meters/pixel) and want every level that's
    /// still useful at that scale, plus all coarser overviews.
    pub fn row_groups_up_to_gsd(&self, min_gsd: f64) -> Range<usize> {
        let last = self
            .cogp_meta
            .levels
            .iter()
            .rposition(|l| l.gsd >= min_gsd);
        match last {
            Some(i) => 0..(self.cogp_meta.levels[i].row_group_end + 1) as usize,
            None => 0..0,
        }
    }

    /// Row groups whose covering-bbox envelope intersects `[xmin, ymin, xmax, ymax]`.
    /// Uses the Parquet `Double` min/max statistics on the covering bbox sub-columns
    /// declared by `geo.columns[primary].covering.bbox`. Row groups missing stats
    /// are conservatively kept.
    ///
    /// On a remote source this only needs the cached footer — **no extra range
    /// requests** — so it's the cheap pre-filter to feed into
    /// [`Self::async_batch_stream`].
    pub fn row_groups_intersecting_bbox(&self, bbox: [f64; 4]) -> Vec<usize> {
        let metadata = self.arrow_meta.metadata();
        let n = metadata.num_row_groups();
        let primary = &self.geo_meta.primary_column;
        let covering = match self
            .geo_meta
            .columns
            .get(primary)
            .and_then(|c| c.covering.as_ref())
        {
            Some(c) => c,
            None => return (0..n).collect(),
        };
        let schema = metadata.file_metadata().schema_descr();
        let find_col = |path_parts: &[String]| -> Option<usize> {
            let dotted = path_parts.join(".");
            (0..schema.num_columns()).find(|i| schema.column(*i).path().string() == dotted)
        };
        let (Some(xmin_i), Some(ymin_i), Some(xmax_i), Some(ymax_i)) = (
            find_col(&covering.bbox.xmin),
            find_col(&covering.bbox.ymin),
            find_col(&covering.bbox.xmax),
            find_col(&covering.bbox.ymax),
        ) else {
            return (0..n).collect();
        };
        let [qxmin, qymin, qxmax, qymax] = bbox;
        let mut out = Vec::with_capacity(n);
        for rg_i in 0..n {
            let rg = metadata.row_group(rg_i);
            let dmin = |idx: usize| -> Option<f64> {
                match rg.column(idx).statistics()? {
                    Statistics::Double(s) => s.min_opt().copied(),
                    _ => None,
                }
            };
            let dmax = |idx: usize| -> Option<f64> {
                match rg.column(idx).statistics()? {
                    Statistics::Double(s) => s.max_opt().copied(),
                    _ => None,
                }
            };
            // Row-group envelope: every feature's bbox satisfies
            //   feature.xmin >= min(xmin column), feature.xmax <= max(xmax column), …
            // so the group's overall envelope is [min xmin, min ymin, max xmax, max ymax].
            // Missing stats → keep the group (caller can re-filter per row).
            let keep = match (dmin(xmin_i), dmin(ymin_i), dmax(xmax_i), dmax(ymax_i)) {
                (Some(gxmin), Some(gymin), Some(gxmax), Some(gymax)) => {
                    gxmax >= qxmin && gxmin <= qxmax && gymax >= qymin && gymin <= qymax
                }
                _ => true,
            };
            if keep {
                out.push(rg_i);
            }
        }
        out
    }

    /// Build a sync [`ParquetRecordBatchReader`] against a fresh `ChunkReader`,
    /// reusing the cached footer metadata (no second footer parse).
    pub fn sync_batch_reader<R: ChunkReader + 'static>(
        &self,
        reader: R,
        row_groups: &[usize],
    ) -> Result<ParquetRecordBatchReader> {
        let builder =
            ParquetRecordBatchReaderBuilder::new_with_metadata(reader, self.arrow_meta.clone());
        Ok(builder.with_row_groups(row_groups.to_vec()).build()?)
    }

    /// Build an async [`ParquetRecordBatchStream`] against a fresh
    /// `AsyncFileReader`, reusing the cached footer metadata. The Parquet
    /// reader fetches only the byte ranges for the selected row groups, so
    /// pairing this with [`Self::row_groups_intersecting_bbox`] and/or
    /// [`Self::row_groups_up_to_gsd`] gives you a near-minimal remote read.
    #[cfg(feature = "async")]
    pub fn async_batch_stream<R: AsyncFileReader + Send + 'static>(
        &self,
        reader: R,
        row_groups: &[usize],
    ) -> Result<ParquetRecordBatchStream<R>> {
        let builder =
            ParquetRecordBatchStreamBuilder::new_with_metadata(reader, self.arrow_meta.clone());
        Ok(builder.with_row_groups(row_groups.to_vec()).build()?)
    }
}

fn parse_cogp_kv(metadata: &Arc<ParquetMetaData>) -> Result<(GeoMeta, CogpMeta)> {
    let kv = metadata
        .file_metadata()
        .key_value_metadata()
        .cloned()
        .unwrap_or_default();
    let geo_str = kv
        .iter()
        .find(|kv| kv.key == GEO_METADATA_KEY)
        .and_then(|kv| kv.value.as_deref())
        .ok_or_else(|| anyhow!("missing `geo` key-value metadata (not a GeoParquet file)"))?;
    let geo_meta: GeoMeta = serde_json::from_str(geo_str)
        .map_err(|e| anyhow!("`geo` metadata is not valid JSON: {e}"))?;
    let cogp_str = kv
        .iter()
        .find(|kv| kv.key == COGP_METADATA_KEY)
        .and_then(|kv| kv.value.as_deref())
        .ok_or_else(|| anyhow!("missing `cogp` key-value metadata"))?;
    let cogp_meta: CogpMeta = serde_json::from_str(cogp_str)
        .map_err(|e| anyhow!("`cogp` metadata is not valid JSON: {e}"))?;
    Ok((geo_meta, cogp_meta))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meta::{
        BboxCovering, CogpMeta, Covering, GeoColumn, GeoMeta, COGP_VERSION, GEOPARQUET_VERSION,
    };
    use arrow::datatypes::{DataType, Field, Schema};
    use parquet::arrow::ArrowWriter;
    use parquet::file::metadata::KeyValue;
    use std::collections::BTreeMap;

    fn level(row_group_end: i64, gsd: f64) -> Level {
        Level { row_group_end, gsd }
    }

    /// Construct a `Reader` whose footer carries the supplied COGP levels.
    /// The Arrow schema and row-group count are minimal — only the selector
    /// tests below read them. The construction path itself goes through the
    /// real `from_arrow_metadata`, so the metadata-parse code runs as well.
    fn reader_with_levels(levels: Vec<Level>) -> Reader {
        let schema = Arc::new(Schema::new(vec![Field::new("v", DataType::Int32, false)]));
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut w = ArrowWriter::try_new(&mut buf, schema.clone(), None).unwrap();
            let mut cols = BTreeMap::new();
            cols.insert(
                "geometry".to_string(),
                GeoColumn {
                    encoding: "WKB".into(),
                    geometry_types: vec![],
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
                version: GEOPARQUET_VERSION.into(),
                primary_column: "geometry".into(),
                columns: cols,
            };
            let cogp = CogpMeta {
                version: COGP_VERSION.into(),
                levels,
            };
            w.append_key_value_metadata(KeyValue {
                key: GEO_METADATA_KEY.into(),
                value: Some(serde_json::to_string(&geo).unwrap()),
            });
            w.append_key_value_metadata(KeyValue {
                key: COGP_METADATA_KEY.into(),
                value: Some(serde_json::to_string(&cogp).unwrap()),
            });
            w.close().unwrap();
        }
        Reader::try_new(bytes::Bytes::from(buf)).unwrap()
    }

    #[test]
    fn row_groups_in_level_boundaries() {
        let r = reader_with_levels(vec![level(1, 1000.0), level(4, 100.0), level(9, 10.0)]);
        assert_eq!(r.row_groups_in_level(0).unwrap(), 0..2);
        assert_eq!(r.row_groups_in_level(1).unwrap(), 2..5);
        assert_eq!(r.row_groups_in_level(2).unwrap(), 5..10);
        assert!(r.row_groups_in_level(3).is_none());
    }

    #[test]
    fn row_groups_up_to_level_clamps_and_inclusive() {
        let r = reader_with_levels(vec![level(1, 1000.0), level(4, 100.0), level(9, 10.0)]);
        assert_eq!(r.row_groups_up_to_level(0), 0..2);
        assert_eq!(r.row_groups_up_to_level(1), 0..5);
        assert_eq!(r.row_groups_up_to_level(2), 0..10);
        // Out-of-range index clamps to the finest level rather than panicking.
        assert_eq!(r.row_groups_up_to_level(999), 0..10);
    }

    #[test]
    fn row_groups_up_to_level_empty_when_no_levels() {
        let r = reader_with_levels(vec![]);
        assert!(r.row_groups_up_to_level(0).is_empty());
    }

    #[test]
    fn row_groups_up_to_gsd_picks_last_level_above_target() {
        let r = reader_with_levels(vec![level(1, 1000.0), level(4, 100.0), level(9, 10.0)]);
        // target finer than every level → include every level
        assert_eq!(r.row_groups_up_to_gsd(1.0), 0..10);
        // target equal to the finest level GSD → include every level
        assert_eq!(r.row_groups_up_to_gsd(10.0), 0..10);
        // target between levels 1 and 2 → cut off after level 1
        assert_eq!(r.row_groups_up_to_gsd(50.0), 0..5);
        // target finer than the coarsest only
        assert_eq!(r.row_groups_up_to_gsd(500.0), 0..2);
        // target coarser than every level → empty
        assert!(r.row_groups_up_to_gsd(1e9).is_empty());
    }

    /// Build a tiny parquet `bytes::Bytes` blob with the given KV metadata
    /// entries and return the reader-construction result.
    fn try_open_with_kv(kv: Vec<KeyValue>) -> Result<Reader> {
        let schema = Arc::new(Schema::new(vec![Field::new("v", DataType::Int32, false)]));
        let mut buf: Vec<u8> = Vec::new();
        let mut w = ArrowWriter::try_new(&mut buf, schema, None).unwrap();
        for e in kv {
            w.append_key_value_metadata(e);
        }
        w.close().unwrap();
        Reader::try_new(bytes::Bytes::from(buf))
    }

    #[test]
    fn parse_cogp_kv_rejects_missing_geo() {
        let cogp = CogpMeta {
            version: COGP_VERSION.into(),
            levels: vec![],
        };
        let err = try_open_with_kv(vec![KeyValue {
            key: COGP_METADATA_KEY.into(),
            value: Some(serde_json::to_string(&cogp).unwrap()),
        }])
        .err()
        .expect("expected reader construction to fail");
        assert!(format!("{err}").contains("geo"), "{err}");
    }

    #[test]
    fn parse_cogp_kv_rejects_missing_cogp() {
        let mut cols = BTreeMap::new();
        cols.insert(
            "geometry".to_string(),
            GeoColumn {
                encoding: "WKB".into(),
                geometry_types: vec![],
                covering: None,
                bbox: None,
                crs: None,
            },
        );
        let geo = GeoMeta {
            version: GEOPARQUET_VERSION.into(),
            primary_column: "geometry".into(),
            columns: cols,
        };
        let err = try_open_with_kv(vec![KeyValue {
            key: GEO_METADATA_KEY.into(),
            value: Some(serde_json::to_string(&geo).unwrap()),
        }])
        .err()
        .expect("expected reader construction to fail");
        assert!(format!("{err}").contains("cogp"), "{err}");
    }

    #[test]
    fn parse_cogp_kv_rejects_malformed_geo_json() {
        let err = try_open_with_kv(vec![KeyValue {
            key: GEO_METADATA_KEY.into(),
            value: Some("{not valid json".into()),
        }])
        .err()
        .expect("expected reader construction to fail");
        assert!(format!("{err}").contains("geo"), "{err}");
    }
}
