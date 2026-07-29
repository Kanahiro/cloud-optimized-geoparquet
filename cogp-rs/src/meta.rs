use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const COGP_METADATA_KEY: &str = "cogp";
pub const GEO_METADATA_KEY: &str = "geo";
pub const COGP_VERSION: &str = "0.1.0";
pub const GEOPARQUET_VERSION: &str = "1.1.0";

/// Parse the profile's required `MAJOR.MINOR.PATCH` version shape.
///
/// Keeping this strict avoids accidentally accepting values such as `0.1`
/// or `0.x.0` when checking reader compatibility.
pub(crate) fn parse_cogp_version(version: &str) -> Option<(u32, u32, u32)> {
    let mut parts = version.split('.');
    let parsed = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    (parts.next().is_none()).then_some(parsed)
}

/// Parse the COGP rendering-sidecar child naming contract.
///
/// Canonical decimal spelling keeps each level index mapped to exactly one
/// possible field name (`level_0`, not aliases such as `level_00`).
pub fn lod_level_index(name: &str) -> Option<usize> {
    let suffix = name.strip_prefix("level_")?;
    if suffix.is_empty()
        || !suffix.bytes().all(|byte| byte.is_ascii_digit())
        || (suffix.len() > 1 && suffix.starts_with('0'))
    {
        return None;
    }
    suffix.parse().ok()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CogpMeta {
    pub version: String,
    /// Optional rendering sidecar root. Readers fall back to the primary WKB
    /// column when this is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lods_column: Option<String>,
    pub levels: Vec<Level>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Level {
    pub row_group_end: i64,
    pub resolution: f64,
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
            lods_column: Some("geometry_lods".to_string()),
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
        assert_eq!(parsed.version, COGP_VERSION);
        assert_eq!(parsed.lods_column.as_deref(), Some("geometry_lods"));
        assert_eq!(parsed.levels.len(), 2);
        assert_eq!(parsed.levels[0].row_group_end, 0);
        assert_eq!(parsed.levels[1].resolution, 250.0);
    }

    #[test]
    fn point_metadata_omits_lods_column() {
        let metadata = CogpMeta {
            version: COGP_VERSION.into(),
            lods_column: None,
            levels: vec![Level {
                row_group_end: 0,
                resolution: 1.0,
            }],
        };
        let json = serde_json::to_string(&metadata).unwrap();
        assert!(!json.contains("lods_column"));
        let parsed: CogpMeta = serde_json::from_str(&json).unwrap();
        assert!(parsed.lods_column.is_none());
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
        assert_eq!(COGP_VERSION, "0.1.0");
        assert_eq!(parse_cogp_version(COGP_VERSION), Some((0, 1, 0)));
        assert_eq!(parse_cogp_version("0.1"), None);
        assert_eq!(parse_cogp_version("0.x.0"), None);
    }

    #[test]
    fn lod_child_names_use_canonical_level_indices() {
        assert_eq!(lod_level_index("level_0"), Some(0));
        assert_eq!(lod_level_index("level_42"), Some(42));
        assert_eq!(lod_level_index("level_00"), None);
        assert_eq!(lod_level_index("level_-1"), None);
        assert_eq!(lod_level_index("level_"), None);
        assert_eq!(lod_level_index("other_1"), None);
    }
}
