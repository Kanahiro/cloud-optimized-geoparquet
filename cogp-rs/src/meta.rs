use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const GEO_METADATA_KEY: &str = "geo";
pub const GEOPARQUET_VERSION: &str = "1.1.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CogpMeta {
    pub levels: Vec<Level>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Level {
    pub row_group_end: i64,
    pub resolution: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoMeta {
    #[serde(
        default,
        alias = "coarse_to_fine",
        skip_serializing_if = "Option::is_none"
    )]
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

impl CogpMeta {
    /// Validate before using a prefix to exclude any row groups.
    pub fn validate(&self, num_row_groups: usize) -> anyhow::Result<()> {
        anyhow::ensure!(num_row_groups > 0, "empty files must omit geo.lod");
        anyhow::ensure!(!self.levels.is_empty(), "geo.lod.levels must be non-empty");
        for (i, level) in self.levels.iter().enumerate() {
            anyhow::ensure!(
                level.row_group_end >= 0 && (level.row_group_end as usize) < num_row_groups,
                "levels[{i}].row_group_end out of range"
            );
            anyhow::ensure!(
                level.resolution.is_finite() && level.resolution > 0.0,
                "levels[{i}].resolution must be positive and finite"
            );
            if i > 0 {
                let prev = &self.levels[i - 1];
                anyhow::ensure!(
                    level.row_group_end >= prev.row_group_end,
                    "levels[{i}].row_group_end must be non-decreasing"
                );
                anyhow::ensure!(
                    level.resolution < prev.resolution,
                    "levels[{i}].resolution must strictly decrease"
                );
            }
        }
        anyhow::ensure!(
            self.levels.last().unwrap().row_group_end as usize == num_row_groups - 1,
            "final row_group_end must equal num_row_groups - 1"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_extension_is_read_but_only_lod_is_written() {
        let mut value = json!({
            "version": "1.1.0", "primary_column": "geometry", "columns": {},
            "coarse_to_fine": {"levels": [{"row_group_end": 0, "resolution": 1.0}]}
        });
        let parsed: GeoMeta = serde_json::from_value(value.clone()).unwrap();
        parsed.lod.as_ref().unwrap().validate(1).unwrap();
        let output = serde_json::to_value(parsed).unwrap();
        assert_eq!(output["lod"], value["coarse_to_fine"]);
        assert!(output.get("coarse_to_fine").is_none());
        value["lod"] = value["coarse_to_fine"].clone();
        assert!(serde_json::from_value::<GeoMeta>(value).is_err());
    }

    #[test]
    fn cogp_meta_roundtrip() {
        let m = CogpMeta {
            levels: vec![
                Level {
                    row_group_end: 0,
                    resolution: 1000.0,
                },
                Level {
                    row_group_end: 3,
                    resolution: 250.0,
                },
            ],
        };
        let s = serde_json::to_string(&m).unwrap();
        let parsed: CogpMeta = serde_json::from_str(&s).unwrap();

        assert_eq!(parsed.levels.len(), 2);
        assert_eq!(parsed.levels[0].row_group_end, 0);
        assert_eq!(parsed.levels[1].resolution, 250.0);
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

    #[test]
    fn version_constants_match_spec() {
        // Catch accidental edits — these strings appear in on-disk files.
        assert_eq!(GEOPARQUET_VERSION, "1.1.0");

        assert_eq!(GEO_METADATA_KEY, "geo");
    }
}
