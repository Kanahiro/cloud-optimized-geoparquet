//! Spool a row group's Arrow batches to disk, then encode a small set of leaves
//! at a time. This keeps the requested row-group boundary independent of memory
//! while the file writer alone owns offsets, row-group order, and footer.

use arrow::array::{Array, ArrayRef, RecordBatch, StructArray};
use arrow::datatypes::{DataType, FieldRef, Schema, SchemaRef};
use arrow_ipc::reader::StreamReader;
use arrow_ipc::writer::StreamWriter;
use parquet::arrow::arrow_writer::{compute_leaves, ArrowColumnWriter, ArrowRowGroupWriterFactory};
use parquet::arrow::ArrowWriter;
use parquet::errors::{ParquetError, Result};
use parquet::file::metadata::{KeyValue, RowGroupMetaData};
use parquet::file::properties::WriterProperties;
use parquet::file::writer::SerializedFileWriter;
use rayon::prelude::*;
use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use tempfile::NamedTempFile;

struct GroupSpool {
    source_field: usize,
    child: Option<usize>,
    field: FieldRef,
    schema: SchemaRef,
    spool: NamedTempFile,
    stream: StreamWriter<File>,
}

impl GroupSpool {
    fn new(
        source_field: usize,
        child: Option<usize>,
        field: FieldRef,
        spool_dir: &Path,
    ) -> Result<Self> {
        let schema = Arc::new(Schema::new(vec![field.clone()]));
        let spool = NamedTempFile::new_in(spool_dir)?;
        let stream = StreamWriter::try_new(spool.reopen()?, schema.as_ref())?;
        Ok(Self {
            source_field,
            child,
            field,
            schema,
            spool,
            stream,
        })
    }

    fn write(&mut self, batch: &RecordBatch) -> Result<()> {
        let source = batch.column(self.source_field);
        let column: ArrayRef = match self.child {
            Some(index) => {
                let parent = source
                    .as_any()
                    .downcast_ref::<StructArray>()
                    .ok_or_else(|| ParquetError::General("expected struct column".into()))?;
                let child_field = match self.field.data_type() {
                    DataType::Struct(fields) => fields[0].clone(),
                    _ => unreachable!(),
                };
                Arc::new(StructArray::new(
                    vec![child_field].into(),
                    vec![parent.column(index).clone()],
                    parent.nulls().cloned(),
                ))
            }
            None => source.clone(),
        };
        let projected = RecordBatch::try_new(self.schema.clone(), vec![column])?;
        self.stream.write(&projected)?;
        Ok(())
    }
}

struct InProgress {
    groups: Vec<GroupSpool>,
    rows: usize,
}

pub(crate) struct ParallelWriter<W: Write + Send> {
    file: SerializedFileWriter<W>,
    factory: ArrowRowGroupWriterFactory,
    schema: SchemaRef,
    spool_dir: std::path::PathBuf,
    in_progress: Option<InProgress>,
}

impl<W: Write + Send> ParallelWriter<W> {
    pub(crate) fn try_new(
        output: W,
        schema: SchemaRef,
        properties: Option<WriterProperties>,
        spool_dir: &Path,
    ) -> Result<Self> {
        let writer = ArrowWriter::try_new(output, schema.clone(), properties)?;
        let (file, factory) = writer.into_serialized_writer()?;
        Ok(Self {
            file,
            factory,
            schema,
            spool_dir: spool_dir.to_path_buf(),
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
        if self.in_progress.is_none() {
            let mut groups = Vec::new();
            for (index, field) in self.schema.fields().iter().enumerate() {
                match field.data_type() {
                    DataType::Struct(children) if children.len() > 1 => {
                        for (child, child_field) in children.iter().enumerate() {
                            let projected = Arc::new(field.as_ref().clone().with_data_type(
                                DataType::Struct(vec![child_field.clone()].into()),
                            ));
                            groups.push(GroupSpool::new(
                                index,
                                Some(child),
                                projected,
                                &self.spool_dir,
                            )?);
                        }
                    }
                    _ => groups.push(GroupSpool::new(
                        index,
                        None,
                        field.clone(),
                        &self.spool_dir,
                    )?),
                }
            }
            self.in_progress = Some(InProgress { groups, rows: 0 });
        }
        let active = self.in_progress.as_mut().unwrap();
        for group in &mut active.groups {
            group.write(batch)?;
        }
        active.rows += batch.num_rows();
        Ok(())
    }

    pub(crate) fn in_progress_rows(&self) -> usize {
        self.in_progress.as_ref().map_or(0, |group| group.rows)
    }

    pub(crate) fn flushed_row_groups(&self) -> &[RowGroupMetaData] {
        self.file.flushed_row_groups()
    }

    pub(crate) fn flush(&mut self) -> Result<()> {
        let Some(active) = self.in_progress.take() else {
            return Ok(());
        };
        let mut columns = self
            .factory
            .create_column_writers(self.file.flushed_row_groups().len())?;
        let mut row_group = self.file.next_row_group()?;
        for mut group in active.groups {
            group.stream.finish()?;
            drop(group.stream);
            let mut reader = StreamReader::try_new(group.spool.reopen()?, None)?;
            let first = reader
                .next()
                .ok_or_else(|| ParquetError::General("empty row-group spool".into()))??;
            let first_leaves = compute_leaves(&group.field, first.column(0))?;
            if first_leaves.len() > columns.len() {
                return Err(ParquetError::General("Parquet leaf count mismatch".into()));
            }
            let mut field_writers: Vec<ArrowColumnWriter> =
                columns.drain(..first_leaves.len()).collect();
            field_writers
                .par_iter_mut()
                .zip(first_leaves.into_par_iter())
                .try_for_each(|(writer, leaf)| writer.write(&leaf))?;
            for batch in reader {
                let batch = batch?;
                let leaves = compute_leaves(&group.field, batch.column(0))?;
                if leaves.len() != field_writers.len() {
                    return Err(ParquetError::General("Parquet leaf count mismatch".into()));
                }
                field_writers
                    .par_iter_mut()
                    .zip(leaves.into_par_iter())
                    .try_for_each(|(writer, leaf)| writer.write(&leaf))?;
            }
            let chunks = field_writers
                .into_par_iter()
                .map(|writer| writer.close())
                .collect::<Result<Vec<_>>>()?;
            for chunk in chunks {
                chunk.append_to_row_group(&mut row_group)?;
            }
        }
        if !columns.is_empty() {
            return Err(ParquetError::General("Parquet leaf count mismatch".into()));
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
            let mut writer = ParallelWriter::try_new(
                &mut actual,
                schema,
                Some(props),
                std::env::temp_dir().as_path(),
            )
            .unwrap();
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
