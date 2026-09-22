use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const GEO_METADATA_KEY: &str = "geo";
pub const GEOPARQUET_VERSION: &str = "1.1.0";
pub const OVERVIEWS_COLUMN: &str = "overviews";
pub const OVERVIEWS_ENCODING: &str = "quantized_xy_v1";
pub const GEOARROW_ENCODING: &str = "quantized_geoarrow";

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
        use anyhow::ensure;
        ensure!(!self.levels.is_empty(), "geo.lod.levels must be non-empty");
        ensure!(num_row_groups > 0, "file has zero row groups");
        let mut previous_end = -1;
        let mut previous_resolution = f64::INFINITY;
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
            previous_end = level.row_group_end;
            previous_resolution = level.resolution;
        }
        ensure!(
            previous_end as u64 == num_row_groups as u64 - 1,
            "final row_group_end must equal num_row_groups-1"
        );
        if let Some(overviews) = &self.overviews {
            ensure!(
                matches!(
                    overviews.encoding.as_str(),
                    OVERVIEWS_ENCODING | GEOARROW_ENCODING
                ),
                "unsupported overviews.encoding"
            );
            ensure!(
                !overviews.lods.is_empty(),
                "overviews.lods must be non-empty"
            );
            ensure!(
                !overviews.column.is_empty(),
                "overview column must be non-empty"
            );
            let mut assigned = vec![false; self.levels.len()];
            for (lod, transform) in &overviews.lods {
                if overviews.encoding == GEOARROW_ENCODING {
                    ensure!(
                        transform.list_depth().is_some(),
                        "overview `{lod}` has invalid geometry_type"
                    );
                }
                ensure!(
                    !lod.is_empty()
                        && (overviews.encoding != OVERVIEWS_ENCODING || lod != "geometry_type"),
                    "invalid overview LoD name `{lod}`"
                );
                ensure!(
                    !transform.level_indices.is_empty(),
                    "overview `{lod}` level_indices must be non-empty"
                );
                for &index in &transform.level_indices {
                    ensure!(
                        index < assigned.len(),
                        "overview `{lod}` level_indices index {index} out of range"
                    );
                    ensure!(!assigned[index], "level {index} is assigned more than once");
                    assigned[index] = true;
                }
                ensure!(
                    transform.scale.iter().all(|v| v.is_finite() && *v > 0.0),
                    "overview `{lod}` scale must be positive and finite"
                );
                ensure!(
                    transform.offset.iter().all(|v| v.is_finite()),
                    "overview `{lod}` offset must be finite"
                );
            }
            ensure!(
                assigned.iter().all(|value| *value),
                "every level must be assigned to an overview"
            );
        }
        Ok(())
    }

    /// Resolve rendering independently of the feature-selection level structure.
    pub fn lod_for_level(&self, index: usize) -> Option<&str> {
        self.overviews
            .as_ref()?
            .lods
            .iter()
            .find(|(_, metadata)| metadata.level_indices.contains(&index))
            .map(|(name, _)| name.as_str())
    }

    /// The shared LoD is present through the largest prefix that selects it.
    pub fn lod_row_group_end(&self, lod: &str) -> Option<i64> {
        self.overviews
            .as_ref()?
            .lods
            .get(lod)?
            .level_indices
            .iter()
            .filter_map(|&index| self.levels.get(index))
            .map(|level| level.row_group_end)
            .max()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Level {
    pub row_group_end: i64,
    pub resolution: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverviewsMeta {
    pub column: String,
    pub encoding: String,
    pub lods: BTreeMap<String, LodMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LodMeta {
    pub level_indices: Vec<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geometry_type: Option<String>,
    pub scale: [f64; 2],
    pub offset: [f64; 2],
}

impl LodMeta {
    pub fn list_depth(&self) -> Option<usize> {
        match self.geometry_type.as_deref()? {
            "LineString" => Some(1),
            "MultiLineString" | "Polygon" => Some(2),
            "MultiPolygon" => Some(3),
            _ => None,
        }
    }
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
    fn levels_are_independent_of_optional_overviews() {
        let metadata = CogpMeta {
            levels: vec![Level {
                row_group_end: 0,
                resolution: 1000.0,
            }],
            overviews: None,
        };
        metadata.validate(1).unwrap();

        let serialized = serde_json::to_value(&metadata).unwrap();
        assert_eq!(
            serialized,
            json!({"levels": [{"row_group_end": 0, "resolution": 1000.0}]})
        );
    }

    #[test]
    fn overview_assignments_are_complete_unique_and_in_range() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/metadata-overviews.json"))
                .unwrap();
        for indices in [json!([]), json!([4]), json!([0, 0]), json!([1])] {
            let mut value = fixture.clone();
            value["overviews"]["lods"]["l0"]["level_indices"] = indices;
            let metadata: CogpMeta = serde_json::from_value(value).unwrap();
            assert!(metadata.validate(4).is_err());
        }
        for indices in [
            json!(null),
            json!(-1),
            json!([-1]),
            json!([0.5]),
            json!("0"),
        ] {
            let mut value = fixture.clone();
            value["overviews"]["lods"]["l0"]["level_indices"] = indices;
            assert!(serde_json::from_value::<CogpMeta>(value).is_err());
        }
        let mut missing = fixture.clone();
        missing["overviews"]["lods"]
            .as_object_mut()
            .unwrap()
            .remove("l0");
        assert!(serde_json::from_value::<CogpMeta>(missing)
            .unwrap()
            .validate(4)
            .is_err());
        let mut old = fixture;
        old["overviews"]["lods"]["l0"]
            .as_object_mut()
            .unwrap()
            .remove("level_indices");
        assert!(serde_json::from_value::<CogpMeta>(old).is_err());
    }

    #[test]
    fn shared_overviews_use_explicit_indices_and_maximum_coverage() {
        let mut metadata: CogpMeta =
            serde_json::from_str(include_str!("../tests/fixtures/metadata-overviews.json"))
                .unwrap();
        metadata
            .overviews
            .as_mut()
            .unwrap()
            .lods
            .get_mut("l1")
            .unwrap()
            .level_indices = vec![2, 1];
        metadata.validate(4).unwrap();
        assert_eq!(metadata.lod_for_level(1), Some("l1"));
        assert_eq!(metadata.lod_for_level(2), Some("l1"));
        assert_eq!(metadata.lod_row_group_end("l1"), Some(3));
        assert_eq!(metadata.lod_for_level(4), None);
        assert_eq!(metadata.lod_row_group_end("missing"), None);
        // Shared levels need not be adjacent, nor their indices sorted.
        let lods = &mut metadata.overviews.as_mut().unwrap().lods;
        lods.get_mut("l0").unwrap().level_indices = vec![2, 0];
        lods.get_mut("l1").unwrap().level_indices = vec![1];
        metadata.validate(4).unwrap();
        assert_eq!(metadata.lod_row_group_end("l0"), Some(3));
        let with_overviews = serde_json::to_value(&metadata).unwrap();
        metadata.overviews = None;
        metadata.validate(4).unwrap();
        assert_eq!(
            with_overviews["levels"],
            serde_json::to_value(&metadata).unwrap()["levels"]
        );
        assert_eq!(metadata.lod_for_level(0), None);
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
