//! Decode only overview columns for structural and topology validation.
use crate::geometry_validation::{multipolygon_valid, polygon_valid};
use crate::meta::{GeometryFamily, QuantizationMeta};
use anyhow::{ensure, Context, Result};
use arrow::array::{Array, ArrayRef, Int32Array, ListArray, StructArray};
use geo::{Coord, LineString, Polygon};

fn structure(array: &dyn Array) -> Result<&StructArray> {
    array
        .as_any()
        .downcast_ref()
        .context("expected overview struct")
}
fn child<'a>(array: &'a StructArray, name: &str) -> Result<&'a dyn Array> {
    Ok(array
        .column_by_name(name)
        .with_context(|| format!("missing overview {name}"))?
        .as_ref())
}
fn list(array: &dyn Array, row: usize) -> Result<ArrayRef> {
    ensure!(!array.is_null(row), "null overview part");
    Ok(array
        .as_any()
        .downcast_ref::<ListArray>()
        .context("expected overview list")?
        .value(row))
}
fn integers(array: &dyn Array) -> Result<&Int32Array> {
    ensure!(array.null_count() == 0, "null overview integer");
    array
        .as_any()
        .downcast_ref()
        .context("expected int32 overview values")
}
fn points(array: &dyn Array, transform: &QuantizationMeta) -> Result<Vec<Coord<f64>>> {
    ensure!(array.null_count() == 0, "null overview coordinate");
    let coords = structure(array)?;
    let xs = integers(child(coords, "x")?)?;
    let ys = integers(child(coords, "y")?)?;
    (0..coords.len())
        .map(|i| {
            let x = transform.offset[0] + transform.scale[0] * f64::from(xs.value(i));
            let y = transform.offset[1] + transform.scale[1] * f64::from(ys.value(i));
            ensure!(
                x.is_finite() && y.is_finite(),
                "non-finite decoded overview coordinate"
            );
            Ok(Coord { x, y })
        })
        .collect()
}
pub(crate) fn validate_value(
    array: &dyn Array,
    row: usize,
    kind: i8,
    transform: &QuantizationMeta,
    family: GeometryFamily,
) -> Result<()> {
    ensure!(
        matches!(kind, 2 | 3 | 5 | 6),
        "unsupported overview geometry_type {kind}"
    );
    ensure!(
        (matches!(kind, 2 | 5) && family == GeometryFamily::Line)
            || (matches!(kind, 3 | 6) && family == GeometryFamily::Polygon),
        "overview geometry_type must match primary geometry family"
    );
    let mut coordinates = Vec::new();
    let mut part_ends = Vec::new();
    let mut polygon_ends = Vec::new();
    let value = list(array, row)?;
    if value.is_empty() {
        // Covers a null or empty primary geometry; only the outermost list may be empty.
        return Ok(());
    }
    match kind {
        2 => coordinates = points(value.as_ref(), transform)?,
        3 | 5 => {
            for i in 0..value.len() {
                coordinates.extend(points(list(value.as_ref(), i)?.as_ref(), transform)?);
                part_ends.push(coordinates.len());
            }
        }
        6 => {
            for i in 0..value.len() {
                let polygon = list(value.as_ref(), i)?;
                ensure!(!polygon.is_empty(), "empty overview polygon");
                for j in 0..polygon.len() {
                    coordinates.extend(points(list(polygon.as_ref(), j)?.as_ref(), transform)?);
                    part_ends.push(coordinates.len());
                }
                polygon_ends.push(part_ends.len());
            }
        }
        _ => unreachable!(),
    }
    ensure!(!coordinates.is_empty(), "empty overview geometry");
    if kind == 2 {
        ensure!(
            part_ends.is_empty() && polygon_ends.is_empty(),
            "unexpected LineString part ends"
        );
        part_ends.push(coordinates.len());
    } else {
        ensure!(
            !part_ends.is_empty() && part_ends.last() == Some(&coordinates.len()),
            "missing overview parts"
        );
    }
    if kind != 6 {
        ensure!(polygon_ends.is_empty(), "unexpected polygon ends");
    }
    let mut parts = Vec::new();
    let mut start = 0;
    for end in part_ends {
        let part = &coordinates[start..end];
        ensure!(
            part.len() >= 2 && part.windows(2).any(|p| p[0] != p[1]),
            "degenerate overview part"
        );
        if matches!(kind, 3 | 6) {
            ensure!(
                part.len() >= 4 && part.first() == part.last(),
                "overview ring must be closed with at least four coordinates"
            );
        }
        parts.push(LineString(part.to_vec()));
        start = end;
    }
    if kind == 3 {
        polygon_ends.push(parts.len());
    }
    if matches!(kind, 3 | 6) {
        ensure!(
            !polygon_ends.is_empty() && polygon_ends.last() == Some(&parts.len()),
            "missing overview polygons"
        );
        let mut polygons = Vec::new();
        let mut start = 0;
        for end in polygon_ends {
            ensure!(end > start, "empty overview polygon");
            polygons.push(Polygon::new(
                parts[start].clone(),
                parts[start + 1..end].to_vec(),
            ));
            start = end;
        }
        ensure!(
            if kind == 3 {
                polygon_valid(&polygons[0])
            } else {
                multipolygon_valid(&polygons)
            },
            "invalid overview polygon topology"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::datatypes::{DataType, Field, Fields};
    use arrow_buffer::OffsetBuffer;
    use std::sync::Arc;

    fn list(values: ArrayRef, offsets: Vec<i32>) -> ArrayRef {
        let field = Arc::new(Field::new("element", values.data_type().clone(), false));
        Arc::new(ListArray::new(
            field,
            OffsetBuffer::new(offsets.into()),
            values,
            None,
        ))
    }

    #[test]
    fn only_the_outermost_list_may_be_empty() {
        let coordinates: ArrayRef = Arc::new(StructArray::new(
            Fields::from(vec![
                Field::new("x", DataType::Int32, false),
                Field::new("y", DataType::Int32, false),
            ]),
            vec![
                Arc::new(Int32Array::from(Vec::<i32>::new())),
                Arc::new(Int32Array::from(Vec::<i32>::new())),
            ],
            None,
        ));
        // Row 0 has no polygons; row 1 has one polygon without rings.
        let rings = list(coordinates, vec![0]);
        let polygons = list(rings, vec![0, 0]);
        let rows = list(polygons, vec![0, 0, 1]);
        let transform = QuantizationMeta {
            geometry_type: "MultiPolygon".into(),
            scale: [1.0, 1.0],
            offset: [0.0, 0.0],
        };
        validate_value(rows.as_ref(), 0, 6, &transform, GeometryFamily::Polygon).unwrap();
        assert!(validate_value(rows.as_ref(), 1, 6, &transform, GeometryFamily::Polygon).is_err());
    }
}
