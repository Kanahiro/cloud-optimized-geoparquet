//! Encode independent Parquet leaf columns in parallel, then append their chunks
//! in schema order. The file writer alone owns offsets, row-group order, and footer.

use arrow::array::RecordBatch;
use arrow::datatypes::SchemaRef;
use parquet::arrow::arrow_writer::{compute_leaves, ArrowColumnWriter, ArrowRowGroupWriterFactory};
use parquet::arrow::ArrowWriter;
use parquet::errors::{ParquetError, Result};
use parquet::file::metadata::{KeyValue, RowGroupMetaData};
use parquet::file::properties::WriterProperties;
use parquet::file::writer::SerializedFileWriter;
use rayon::prelude::*;
use std::io::Write;

struct InProgress {
    columns: Vec<ArrowColumnWriter>,
    rows: usize,
}

pub(crate) struct ParallelWriter<W: Write + Send> {
    file: SerializedFileWriter<W>,
    factory: ArrowRowGroupWriterFactory,
    schema: SchemaRef,
    in_progress: Option<InProgress>,
}

impl<W: Write + Send> ParallelWriter<W> {
    pub(crate) fn try_new(
        output: W,
        schema: SchemaRef,
        properties: Option<WriterProperties>,
    ) -> Result<Self> {
        let writer = ArrowWriter::try_new(output, schema.clone(), properties)?;
        let (file, factory) = writer.into_serialized_writer()?;
        Ok(Self {
            file,
            factory,
            schema,
            in_progress: None,
        })
    }

    pub(crate) fn write(&mut self, batch: &RecordBatch) -> Result<()> {
        if batch.num_rows() == 0 {
            return Ok(());
        }
        if batch.schema() != self.schema {
            return Err(ParquetError::General("Arrow schema mismatch".into()));
        }
        let leaves = self
            .schema
            .fields()
            .par_iter()
            .zip(batch.columns().par_iter())
            .map(|(field, column)| compute_leaves(field, column))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();

        if self.in_progress.is_none() {
            let columns = self
                .factory
                .create_column_writers(self.file.flushed_row_groups().len())?;
            self.in_progress = Some(InProgress { columns, rows: 0 });
        }
        let active = self.in_progress.as_mut().unwrap();
        if active.columns.len() != leaves.len() {
            return Err(ParquetError::General("Parquet leaf count mismatch".into()));
        }
        active
            .columns
            .par_iter_mut()
            .zip(leaves.into_par_iter())
            .try_for_each(|(writer, leaf)| writer.write(&leaf))?;
        active.rows += batch.num_rows();
        Ok(())
    }

    pub(crate) fn in_progress_rows(&self) -> usize {
        self.in_progress.as_ref().map_or(0, |group| group.rows)
    }

    pub(crate) fn memory_size(&self) -> usize {
        self.in_progress.as_ref().map_or(0, |group| {
            group
                .columns
                .iter()
                .map(|column| column.memory_size())
                .sum()
        })
    }

    pub(crate) fn flushed_row_groups(&self) -> &[RowGroupMetaData] {
        self.file.flushed_row_groups()
    }

    pub(crate) fn flush(&mut self) -> Result<()> {
        let Some(active) = self.in_progress.take() else {
            return Ok(());
        };
        let chunks = active
            .columns
            .into_par_iter()
            .map(|column| column.close())
            .collect::<Result<Vec<_>>>()?;
        let mut row_group = self.file.next_row_group()?;
        for chunk in chunks {
            chunk.append_to_row_group(&mut row_group)?;
        }
        row_group.close()?;
        Ok(())
    }

    pub(crate) fn append_key_value_metadata(&mut self, metadata: KeyValue) {
        self.file.append_key_value_metadata(metadata);
    }

    pub(crate) fn close(mut self) -> Result<()> {
        self.flush()?;
        self.file.close()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::array::{ArrayRef, Float64Array, Int32Array, StringArray, StructArray};
    use arrow::datatypes::{DataType, Field, Schema};
    use parquet::basic::{Compression, ZstdLevel};
    use std::sync::Arc;

    #[test]
    fn matches_arrow_writer_bytes_for_many_nested_leaves_and_multiple_batches() {
        let bbox_fields = vec![
            Arc::new(Field::new("xmin", DataType::Float64, false)),
            Arc::new(Field::new("xmax", DataType::Float64, false)),
        ];
        let coordinate_fields = vec![
            Arc::new(Field::new("x", DataType::Int32, false)),
            Arc::new(Field::new("y", DataType::Int32, false)),
        ];
        let overview_fields = (0..17)
            .map(|level| {
                Arc::new(Field::new(
                    format!("lod_{level}"),
                    DataType::Struct(coordinate_fields.clone().into()),
                    false,
                ))
            })
            .collect::<Vec<_>>();
        let overview_columns = (0..17)
            .map(|level| {
                Arc::new(StructArray::new(
                    coordinate_fields.clone().into(),
                    vec![
                        Arc::new(Int32Array::from(vec![level, level + 1])) as ArrayRef,
                        Arc::new(Int32Array::from(vec![level + 2, level + 3])) as ArrayRef,
                    ],
                    None,
                )) as ArrayRef
            })
            .collect();
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int32, false),
            Field::new("name", DataType::Utf8, false),
            Field::new("bbox", DataType::Struct(bbox_fields.clone().into()), false),
            Field::new(
                "overviews",
                DataType::Struct(overview_fields.clone().into()),
                false,
            ),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(Int32Array::from(vec![1, 2])),
                Arc::new(StringArray::from(vec!["one", "two"])),
                Arc::new(StructArray::new(
                    bbox_fields.into(),
                    vec![
                        Arc::new(Float64Array::from(vec![0.0, 2.0])) as ArrayRef,
                        Arc::new(Float64Array::from(vec![1.0, 3.0])) as ArrayRef,
                    ],
                    None,
                )),
                Arc::new(StructArray::new(
                    overview_fields.into(),
                    overview_columns,
                    None,
                )),
            ],
        )
        .unwrap();
        let props = WriterProperties::builder()
            .set_dictionary_enabled(false)
            .set_compression(Compression::ZSTD(ZstdLevel::try_new(9).unwrap()))
            .set_max_row_group_size(4)
            .build();

        let mut expected = Vec::new();
        {
            let mut writer =
                ArrowWriter::try_new(&mut expected, schema.clone(), Some(props.clone())).unwrap();
            writer.write(&batch).unwrap();
            writer.write(&batch).unwrap();
            writer.append_key_value_metadata(KeyValue {
                key: "test".into(),
                value: Some("value".into()),
            });
            writer.close().unwrap();
        }
        let mut actual = Vec::new();
        {
            let mut writer = ParallelWriter::try_new(&mut actual, schema, Some(props)).unwrap();
            writer.write(&batch).unwrap();
            writer.write(&batch).unwrap();
            writer.flush().unwrap();
            writer.append_key_value_metadata(KeyValue {
                key: "test".into(),
                value: Some("value".into()),
            });
            writer.close().unwrap();
        }
        assert_eq!(actual, expected);
    }
}
