use anyhow::{anyhow, bail, Result};
use byteorder::{BigEndian, LittleEndian, ReadBytesExt};
use std::io::{Cursor, Read};

#[derive(Debug, Clone, Copy)]
pub struct Bbox {
    pub xmin: f64,
    pub ymin: f64,
    pub xmax: f64,
    pub ymax: f64,
}

/// Topological dimension of a WKB geometry, used to drive kind-aware thinning.
/// Multi* variants take the singular kind; GeometryCollection takes the highest
/// dimension among its children.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeomKind {
    Point = 0,
    Line = 1,
    Polygon = 2,
}

impl GeomKind {
    fn merge(self, other: Self) -> Self {
        if (self as u8) >= (other as u8) { self } else { other }
    }
}

impl Bbox {
    pub fn empty() -> Self {
        Self { xmin: f64::INFINITY, ymin: f64::INFINITY, xmax: f64::NEG_INFINITY, ymax: f64::NEG_INFINITY }
    }
    pub fn add(&mut self, x: f64, y: f64) {
        if x < self.xmin { self.xmin = x; }
        if y < self.ymin { self.ymin = y; }
        if x > self.xmax { self.xmax = x; }
        if y > self.ymax { self.ymax = y; }
    }
    pub fn merge(&mut self, other: &Bbox) {
        if other.xmin < self.xmin { self.xmin = other.xmin; }
        if other.ymin < self.ymin { self.ymin = other.ymin; }
        if other.xmax > self.xmax { self.xmax = other.xmax; }
        if other.ymax > self.ymax { self.ymax = other.ymax; }
    }
    pub fn width(&self) -> f64 { self.xmax - self.xmin }
    pub fn height(&self) -> f64 { self.ymax - self.ymin }
    pub fn cx(&self) -> f64 { (self.xmin + self.xmax) * 0.5 }
    pub fn cy(&self) -> f64 { (self.ymin + self.ymax) * 0.5 }
    pub fn is_empty(&self) -> bool { self.xmin > self.xmax || self.ymin > self.ymax }
}

/// Compute a 2D bounding box and topological kind from a WKB byte slice.
/// Supports standard WKB (and ignores Z/M coordinates if present).
pub fn bbox_from_wkb(bytes: &[u8]) -> Result<(Bbox, GeomKind)> {
    let mut cur = Cursor::new(bytes);
    let mut bbox = Bbox::empty();
    let mut kind = GeomKind::Point;
    read_geom(&mut cur, &mut bbox, &mut kind)?;
    if bbox.is_empty() {
        bail!("empty geometry");
    }
    Ok((bbox, kind))
}

/// Cheap kind-only inspection: for non-collection geometries this reads only
/// the 5-byte type header. GeometryCollection (rare) falls back to a full
/// parse so we can pick the highest-dimension child.
pub fn kind_from_wkb(bytes: &[u8]) -> Result<GeomKind> {
    if bytes.len() < 5 {
        bail!("WKB too short");
    }
    let raw_bytes: [u8; 4] = bytes[1..5].try_into().unwrap();
    let raw_type = match bytes[0] {
        0 => u32::from_be_bytes(raw_bytes),
        1 => u32::from_le_bytes(raw_bytes),
        b => bail!("invalid WKB byte order: {b}"),
    };
    let geom_type = (raw_type & 0xFFFF) % 1000;
    match geom_type {
        1 | 4 => Ok(GeomKind::Point),
        2 | 5 => Ok(GeomKind::Line),
        3 | 6 => Ok(GeomKind::Polygon),
        7 => bbox_from_wkb(bytes).map(|(_, k)| k),
        t => bail!("unsupported WKB geometry type: {t}"),
    }
}

fn read_geom<R: Read>(cur: &mut R, bbox: &mut Bbox, kind: &mut GeomKind) -> Result<()> {
    let order = cur.read_u8()?;
    let raw_type = match order {
        0 => cur.read_u32::<BigEndian>()?,
        1 => cur.read_u32::<LittleEndian>()?,
        b => bail!("invalid WKB byte order: {b}"),
    };
    let has_z = (raw_type & 0x80000000) != 0 || ((raw_type / 1000) % 10 == 1) || ((raw_type / 1000) % 10 == 3);
    let has_m = (raw_type & 0x40000000) != 0 || ((raw_type / 1000) % 10 == 2) || ((raw_type / 1000) % 10 == 3);
    let has_srid = (raw_type & 0x20000000) != 0;
    let geom_type = (raw_type & 0xFFFF) % 1000;

    if has_srid {
        match order {
            0 => { cur.read_u32::<BigEndian>()?; }
            1 => { cur.read_u32::<LittleEndian>()?; }
            _ => unreachable!(),
        }
    }

    let extra_per_pt = (has_z as usize) + (has_m as usize);

    let local_kind = match geom_type {
        1 | 4 => Some(GeomKind::Point),
        2 | 5 => Some(GeomKind::Line),
        3 | 6 => Some(GeomKind::Polygon),
        7 => None,
        t => bail!("unsupported WKB geometry type: {t}"),
    };
    if let Some(k) = local_kind {
        *kind = kind.merge(k);
    }

    match geom_type {
        1 => read_point(cur, order, extra_per_pt, bbox)?,
        2 => read_linestring(cur, order, extra_per_pt, bbox)?,
        3 => read_polygon(cur, order, extra_per_pt, bbox)?,
        4 | 5 | 6 | 7 => {
            let n = read_u32(cur, order)?;
            for _ in 0..n {
                read_geom(cur, bbox, kind)?;
            }
        }
        t => bail!("unsupported WKB geometry type: {t}"),
    }
    Ok(())
}

fn read_u32<R: Read>(cur: &mut R, order: u8) -> Result<u32> {
    Ok(match order {
        0 => cur.read_u32::<BigEndian>()?,
        1 => cur.read_u32::<LittleEndian>()?,
        _ => return Err(anyhow!("bad byte order")),
    })
}

fn read_point<R: Read>(cur: &mut R, order: u8, extra: usize, bbox: &mut Bbox) -> Result<()> {
    let (x, y) = match order {
        0 => (cur.read_f64::<BigEndian>()?, cur.read_f64::<BigEndian>()?),
        1 => (cur.read_f64::<LittleEndian>()?, cur.read_f64::<LittleEndian>()?),
        _ => unreachable!(),
    };
    for _ in 0..extra {
        match order {
            0 => { cur.read_f64::<BigEndian>()?; }
            1 => { cur.read_f64::<LittleEndian>()?; }
            _ => unreachable!(),
        }
    }
    bbox.add(x, y);
    Ok(())
}

fn read_linestring<R: Read>(cur: &mut R, order: u8, extra: usize, bbox: &mut Bbox) -> Result<()> {
    let n = read_u32(cur, order)?;
    for _ in 0..n {
        read_point(cur, order, extra, bbox)?;
    }
    Ok(())
}

fn read_polygon<R: Read>(cur: &mut R, order: u8, extra: usize, bbox: &mut Bbox) -> Result<()> {
    let nrings = read_u32(cur, order)?;
    for _ in 0..nrings {
        read_linestring(cur, order, extra, bbox)?;
    }
    Ok(())
}
