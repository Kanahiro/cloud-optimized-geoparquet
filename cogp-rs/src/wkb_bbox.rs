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
        4..=7 => {
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

#[cfg(test)]
mod tests {
    use super::*;

    // Minimal little-endian WKB writer used by the test cases below.
    struct Wkb(Vec<u8>);
    impl Wkb {
        fn new(type_code: u32) -> Self {
            let mut v = Vec::with_capacity(5);
            v.push(1); // little-endian
            v.extend_from_slice(&type_code.to_le_bytes());
            Self(v)
        }
        fn u32(mut self, x: u32) -> Self {
            self.0.extend_from_slice(&x.to_le_bytes());
            self
        }
        fn xy(mut self, x: f64, y: f64) -> Self {
            self.0.extend_from_slice(&x.to_le_bytes());
            self.0.extend_from_slice(&y.to_le_bytes());
            self
        }
        fn f64v(mut self, x: f64) -> Self {
            self.0.extend_from_slice(&x.to_le_bytes());
            self
        }
        fn done(self) -> Vec<u8> {
            self.0
        }
    }

    fn point_le(x: f64, y: f64) -> Vec<u8> {
        Wkb::new(1).xy(x, y).done()
    }

    fn bbox_close(a: Bbox, x0: f64, y0: f64, x1: f64, y1: f64) {
        assert!((a.xmin - x0).abs() < 1e-9, "xmin {} != {}", a.xmin, x0);
        assert!((a.ymin - y0).abs() < 1e-9, "ymin {} != {}", a.ymin, y0);
        assert!((a.xmax - x1).abs() < 1e-9, "xmax {} != {}", a.xmax, x1);
        assert!((a.ymax - y1).abs() < 1e-9, "ymax {} != {}", a.ymax, y1);
    }

    #[test]
    fn bbox_ops() {
        let mut b = Bbox::empty();
        assert!(b.is_empty());
        b.add(1.0, 2.0);
        b.add(3.0, 4.0);
        assert_eq!(b.width(), 2.0);
        assert_eq!(b.height(), 2.0);
        assert_eq!(b.cx(), 2.0);
        assert_eq!(b.cy(), 3.0);
        let mut c = Bbox::empty();
        c.add(0.0, 0.0);
        b.merge(&c);
        bbox_close(b, 0.0, 0.0, 3.0, 4.0);
    }

    #[test]
    fn point_little_endian() {
        let (b, k) = bbox_from_wkb(&point_le(10.0, 20.0)).unwrap();
        bbox_close(b, 10.0, 20.0, 10.0, 20.0);
        assert_eq!(k, GeomKind::Point);
    }

    #[test]
    fn point_big_endian() {
        let mut bytes = vec![0u8]; // big-endian
        bytes.extend_from_slice(&1u32.to_be_bytes());
        bytes.extend_from_slice(&1.5f64.to_be_bytes());
        bytes.extend_from_slice(&2.5f64.to_be_bytes());
        let (b, k) = bbox_from_wkb(&bytes).unwrap();
        bbox_close(b, 1.5, 2.5, 1.5, 2.5);
        assert_eq!(k, GeomKind::Point);
    }

    #[test]
    fn linestring_kind_and_bbox() {
        let bytes = Wkb::new(2).u32(3).xy(0.0, 0.0).xy(5.0, 1.0).xy(2.0, 4.0).done();
        let (b, k) = bbox_from_wkb(&bytes).unwrap();
        bbox_close(b, 0.0, 0.0, 5.0, 4.0);
        assert_eq!(k, GeomKind::Line);
    }

    #[test]
    fn polygon_kind_and_bbox() {
        // single ring, 4 points (closed quad)
        let bytes = Wkb::new(3)
            .u32(1) // rings
            .u32(4) // points
            .xy(0.0, 0.0)
            .xy(10.0, 0.0)
            .xy(10.0, 10.0)
            .xy(0.0, 0.0)
            .done();
        let (b, k) = bbox_from_wkb(&bytes).unwrap();
        bbox_close(b, 0.0, 0.0, 10.0, 10.0);
        assert_eq!(k, GeomKind::Polygon);
    }

    #[test]
    fn multipoint_kind_is_point() {
        // MultiPoint with two child points
        let child1 = point_le(1.0, 2.0);
        let child2 = point_le(3.0, 4.0);
        let mut bytes = Wkb::new(4).u32(2).done();
        bytes.extend(child1);
        bytes.extend(child2);
        let (b, k) = bbox_from_wkb(&bytes).unwrap();
        bbox_close(b, 1.0, 2.0, 3.0, 4.0);
        assert_eq!(k, GeomKind::Point);
    }

    #[test]
    fn geometry_collection_picks_highest_dim() {
        // Collection of a Point and a Polygon; kind should be Polygon.
        let pt = point_le(0.0, 0.0);
        let poly = Wkb::new(3)
            .u32(1)
            .u32(4)
            .xy(0.0, 0.0)
            .xy(5.0, 0.0)
            .xy(5.0, 5.0)
            .xy(0.0, 0.0)
            .done();
        let mut bytes = Wkb::new(7).u32(2).done();
        bytes.extend(pt);
        bytes.extend(poly);
        let (b, k) = bbox_from_wkb(&bytes).unwrap();
        bbox_close(b, 0.0, 0.0, 5.0, 5.0);
        assert_eq!(k, GeomKind::Polygon);
    }

    #[test]
    fn point_z_iso_skips_z_coord() {
        // ISO PointZ has type 1001 and three coords per vertex.
        let bytes = Wkb::new(1001).xy(7.0, 8.0).f64v(99.0).done();
        let (b, k) = bbox_from_wkb(&bytes).unwrap();
        bbox_close(b, 7.0, 8.0, 7.0, 8.0);
        assert_eq!(k, GeomKind::Point);
    }

    #[test]
    fn point_m_iso_skips_m_coord() {
        let bytes = Wkb::new(2001).xy(7.0, 8.0).f64v(99.0).done();
        let (b, k) = bbox_from_wkb(&bytes).unwrap();
        bbox_close(b, 7.0, 8.0, 7.0, 8.0);
        assert_eq!(k, GeomKind::Point);
    }

    #[test]
    fn point_zm_iso_skips_two_extras() {
        let bytes = Wkb::new(3001).xy(7.0, 8.0).f64v(99.0).f64v(42.0).done();
        let (b, _) = bbox_from_wkb(&bytes).unwrap();
        bbox_close(b, 7.0, 8.0, 7.0, 8.0);
    }

    #[test]
    fn ewkb_point_with_srid() {
        // EWKB Point with SRID flag (0x20000000) + Z flag (0x80000000).
        let type_code: u32 = 1 | 0x20000000 | 0x80000000;
        let mut bytes = vec![1u8];
        bytes.extend_from_slice(&type_code.to_le_bytes());
        bytes.extend_from_slice(&4326u32.to_le_bytes()); // SRID
        bytes.extend_from_slice(&1.0f64.to_le_bytes());
        bytes.extend_from_slice(&2.0f64.to_le_bytes());
        bytes.extend_from_slice(&3.0f64.to_le_bytes()); // Z
        let (b, k) = bbox_from_wkb(&bytes).unwrap();
        bbox_close(b, 1.0, 2.0, 1.0, 2.0);
        assert_eq!(k, GeomKind::Point);
    }

    #[test]
    fn empty_polygon_errors() {
        // Polygon with zero rings has no points, so the bbox stays empty.
        let bytes = Wkb::new(3).u32(0).done();
        assert!(bbox_from_wkb(&bytes).is_err());
    }

    #[test]
    fn bad_byte_order_errors() {
        let bytes = vec![2u8, 0, 0, 0, 1];
        assert!(bbox_from_wkb(&bytes).is_err());
    }

    #[test]
    fn unsupported_geom_type_errors() {
        let bytes = Wkb::new(99).done();
        assert!(bbox_from_wkb(&bytes).is_err());
    }

    #[test]
    fn truncated_wkb_errors() {
        // header only — no payload for a Point
        let bytes = vec![1u8, 1, 0, 0, 0];
        assert!(bbox_from_wkb(&bytes).is_err());
    }

    #[test]
    fn kind_from_wkb_fast_path() {
        assert_eq!(kind_from_wkb(&point_le(0.0, 0.0)).unwrap(), GeomKind::Point);
        let ls = Wkb::new(2).u32(0).done();
        assert_eq!(kind_from_wkb(&ls).unwrap(), GeomKind::Line);
        let poly = Wkb::new(3).u32(0).done();
        assert_eq!(kind_from_wkb(&poly).unwrap(), GeomKind::Polygon);
        let mp = Wkb::new(4).u32(0).done();
        assert_eq!(kind_from_wkb(&mp).unwrap(), GeomKind::Point);
        // ISO MultiPolygon (1006) → Polygon
        let iso_mp = Wkb::new(1006).u32(0).done();
        assert_eq!(kind_from_wkb(&iso_mp).unwrap(), GeomKind::Polygon);
    }

    #[test]
    fn kind_from_wkb_short_input_errors() {
        assert!(kind_from_wkb(&[1, 0, 0]).is_err());
    }
}
