use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const COGP_METADATA_KEY: &str = "cogp";
pub const GEO_METADATA_KEY: &str = "geo";
pub const COGP_VERSION: &str = "0.1.0";
pub const GEOPARQUET_VERSION: &str = "1.1.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CogpMeta {
    pub version: String,
    pub levels: Vec<Level>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Level {
    pub row_group_end: i64,
    pub gsd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoMeta {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cogp_meta_roundtrip() {
        let m = CogpMeta {
            version: COGP_VERSION.to_string(),
            levels: vec![
                Level { row_group_end: 0, gsd: 1000.0 },
                Level { row_group_end: 3, gsd: 250.0 },
            ],
        };
        let s = serde_json::to_string(&m).unwrap();
        let parsed: CogpMeta = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed.version, COGP_VERSION);
        assert_eq!(parsed.levels.len(), 2);
        assert_eq!(parsed.levels[0].row_group_end, 0);
        assert_eq!(parsed.levels[1].gsd, 250.0);
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
        assert_eq!(COGP_METADATA_KEY, "cogp");
        assert_eq!(GEO_METADATA_KEY, "geo");
        // COGP_VERSION must be SemVer-like; major must parse.
        let major: u32 = COGP_VERSION.split('.').next().unwrap().parse().unwrap();
        assert_eq!(major, 0);
    }
}
