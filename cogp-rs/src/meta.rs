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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generator: Option<Generator>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Level {
    pub row_group_end: i64,
    pub gsd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Generator {
    pub name: String,
    pub version: String,
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

pub fn default_generator() -> Generator {
    Generator {
        name: "cogp".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}
