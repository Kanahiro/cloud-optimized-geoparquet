use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const GEO_METADATA_KEY: &str = "geo";
pub const GEOPARQUET_VERSION: &str = "1.1.0";
pub const OVERVIEWS_COLUMN: &str = "overviews";
pub const OVERVIEWS_ENCODING: &str = "quantized_xy_v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CogpMeta {
    pub levels: Vec<Level>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overviews: Option<OverviewsMeta>,
}

impl CogpMeta {
    /// Validate the layout and optional rendering contract before interpreting row ranges.
    /// Physical schema and per-row values are checked separately by the validator.
    pub fn validate(&self, num_row_groups: usize) -> anyhow::Result<()> {
        use anyhow::{bail, ensure};
        ensure!(!self.levels.is_empty(), "geo.lod.levels must be non-empty");
        ensure!(num_row_groups > 0, "file has zero row groups");
        let mut previous_end = -1;
        let mut previous_resolution = f64::INFINITY;
        let mut referenced = BTreeMap::new();
        for (index, level) in self.levels.iter().enumerate() {
            ensure!(
                level.row_group_end >= 0 && (level.row_group_end as u64) < num_row_groups as u64,
                "levels[{index}].row_group_end out of range"
            );
            ensure!(
                level.row_group_end >= previous_end,
                "levels[{index}].row_group_end must be non-decreasing"
            );
            ensure!(
                level.resolution.is_finite()
                    && level.resolution > 0.0
                    && level.resolution < previous_resolution,
                "levels[{index}].resolution must be positive, finite and strictly decreasing"
            );
            match (&self.overviews, &level.lod) {
                (Some(overviews), Some(lod)) => {
                    ensure!(
                        !lod.is_empty()
                            && lod != "geometry_type"
                            && overviews.lods.contains_key(lod),
                        "levels[{index}].lod does not name an overview LoD"
                    );
                    referenced.insert(lod.as_str(), level.row_group_end);
                }
                (None, None) => {}
                _ => bail!("levels[{index}].lod is required exactly when overviews are declared"),
            }
            previous_end = level.row_group_end;
            previous_resolution = level.resolution;
        }
        ensure!(
            previous_end as u64 == num_row_groups as u64 - 1,
            "final row_group_end must equal num_row_groups-1"
        );
        if let Some(overviews) = &self.overviews {
            ensure!(
                overviews.encoding == OVERVIEWS_ENCODING,
                "unsupported overviews.encoding"
            );
            ensure!(
                !overviews.lods.is_empty(),
                "overviews.lods must be non-empty"
            );
            for (lod, transform) in &overviews.lods {
                ensure!(
                    !lod.is_empty() && lod != "geometry_type",
                    "invalid overview LoD name `{lod}`"
                );
                ensure!(
                    referenced.contains_key(lod.as_str()),
                    "overview LoD `{lod}` is not referenced by a level"
                );
                ensure!(
                    transform.scale.iter().all(|v| v.is_finite() && *v > 0.0),
                    "overview `{lod}` scale must be positive and finite"
                );
                ensure!(
                    transform.offset.iter().all(|v| v.is_finite()),
                    "overview `{lod}` offset must be finite"
                );
            }
        }
        Ok(())
    }

    /// The shared LoD is present through the largest prefix that selects it.
    pub fn lod_row_group_end(&self, lod: &str) -> Option<i64> {
        self.levels
            .iter()
            .filter(|level| level.lod.as_deref() == Some(lod))
            .map(|level| level.row_group_end)
            .max()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Level {
    pub row_group_end: i64,
    pub resolution: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lod: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverviewsMeta {
    pub encoding: String,
    pub lods: BTreeMap<String, LodMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LodMeta {
    pub scale: [f64; 2],
    pub offset: [f64; 2],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lod: Option<CogpMeta>,
    pub version: String,
    pub primary_column: String,
    pub columns: BTreeMap<String, GeoColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoColumn {
    pub encoding: String,
    pub geometry_types: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub covering: Option<Covering>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crs: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeometryFamily {
    Point,
    Line,
    Polygon,
}

/// Rendering overviews use one topological geometry family. Singular and Multi
/// variants belong to the same family; dimensional suffixes such as `Z` and
/// `ZM` do not change it.
pub fn geometry_family(geometry_types: &[String]) -> Option<GeometryFamily> {
    fn one(geometry_type: &str) -> Option<GeometryFamily> {
        match geometry_type.split_ascii_whitespace().next()? {
            "Point" | "MultiPoint" => Some(GeometryFamily::Point),
            "LineString" | "MultiLineString" => Some(GeometryFamily::Line),
            "Polygon" | "MultiPolygon" => Some(GeometryFamily::Polygon),
            _ => None,
        }
    }

    let family = one(geometry_types.first()?)?;
    geometry_types
        .iter()
        .all(|geometry_type| one(geometry_type) == Some(family))
        .then_some(family)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Covering {
    pub bbox: BboxCovering,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BboxCovering {
    pub xmin: Vec<String>,
    pub ymin: Vec<String>,
    pub xmax: Vec<String>,
    pub ymax: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn geometry_family_accepts_singular_and_multi_but_rejects_mixed_dimensions() {
        assert_eq!(
            geometry_family(&["LineString".into(), "MultiLineString Z".into()]),
            Some(GeometryFamily::Line)
        );
        assert_eq!(
            geometry_family(&["LineString".into(), "Polygon".into()]),
            None
        );
        assert_eq!(geometry_family(&[]), None);
    }

    #[test]
    fn overviews_are_optional_but_lod_is_conditional() {
        let metadata = CogpMeta {
            levels: vec![Level {
                row_group_end: 0,
                resolution: 1000.0,
                lod: None,
            }],
            overviews: None,
        };
        metadata.validate(1).unwrap();

        let mut stray_lod = metadata;
        stray_lod.levels[0].lod = Some("l0".into());
        assert!(stray_lod.validate(1).is_err());
    }

    #[test]
    fn geo_meta_minimum_required_fields() {
        // Mimics the minimum a real GeoParquet writer would emit.
        let v = json!({
            "version": "1.1.0",
            "primary_column": "geometry",
            "columns": {
                "geometry": {
                    "encoding": "WKB",
                    "geometry_types": ["Polygon"],
                    "covering": {
                        "bbox": {
                            "xmin": ["bbox", "xmin"],
                            "ymin": ["bbox", "ymin"],
                            "xmax": ["bbox", "xmax"],
                            "ymax": ["bbox", "ymax"],
                        }
                    }
                }
            }
        });
        let parsed: GeoMeta = serde_json::from_value(v).unwrap();
        assert_eq!(parsed.primary_column, "geometry");
        let col = parsed.columns.get("geometry").unwrap();
        assert_eq!(col.encoding, "WKB");
        assert!(col.covering.is_some());
        assert!(col.bbox.is_none());
        assert!(col.crs.is_none());
    }

    #[test]
    fn geo_meta_optional_fields_skipped_on_serialize() {
        let col = GeoColumn {
            encoding: "WKB".into(),
            geometry_types: vec!["Polygon".into()],
            covering: None,
            bbox: None,
            crs: None,
        };
        let s = serde_json::to_string(&col).unwrap();
        // None values must be omitted, not serialized as null.
        assert!(!s.contains("covering"));
        assert!(!s.contains("bbox"));
        assert!(!s.contains("crs"));
    }
}
