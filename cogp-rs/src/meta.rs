use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const COGP_METADATA_KEY: &str = "cogp";
pub const GEO_METADATA_KEY: &str = "geo";
pub const COGP_VERSION: &str = "0.2.0";
pub const GEOPARQUET_VERSION: &str = "1.1.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CogpMeta {
    pub version: String,
    pub levels: Vec<Level>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub geometry_overviews: Vec<GeometryOverview>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Level {
    pub row_group_end: i64,
    pub gsd: f64,
}

/// A scale-specific WKB column. `level` supplies its non-null row-group
/// boundary; `tolerance_meters` independently describes its spatial error.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GeometryOverview {
    pub column: String,
    pub level: usize,
    pub tolerance_meters: f64,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeometryFamily {
    Point,
    Line,
    Polygon,
}

/// COGP keeps one topological geometry family per file. Singular and Multi
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
    fn cogp_meta_roundtrip() {
        let m = CogpMeta {
            version: COGP_VERSION.to_string(),
            levels: vec![
                Level {
                    row_group_end: 0,
                    gsd: 1000.0,
                },
                Level {
                    row_group_end: 3,
                    gsd: 250.0,
                },
            ],
            geometry_overviews: vec![GeometryOverview {
                column: "geometry_ovr_0".into(),
                level: 0,
                tolerance_meters: 250.0,
            }],
        };
        let s = serde_json::to_string(&m).unwrap();
        let parsed: CogpMeta = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed.version, COGP_VERSION);
        assert_eq!(parsed.levels.len(), 2);
        assert_eq!(parsed.levels[0].row_group_end, 0);
        assert_eq!(parsed.levels[1].gsd, 250.0);
        assert_eq!(parsed.geometry_overviews[0].level, 0);
        assert_eq!(parsed.geometry_overviews[0].tolerance_meters, 250.0);
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
