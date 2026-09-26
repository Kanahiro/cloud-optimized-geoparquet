import { decodeGeometry, GeometryBuilder } from '../dist/geometry.js';

/** Non-enumerable source row attached by `records`. */
export const ROW = Symbol('row');

/** Row objects for assertions only; the library itself never builds them. */
export function records(batch, geometryName = 'geometry') {
  return Array.from({ length: batch.length }, (_, i) => {
    const row = {};
    for (const [name, values] of Object.entries(batch.columns)) row[name] = values[i];
    if (batch.geometry) row[geometryName] = decodeGeometry(batch.geometry, i);
    Object.defineProperty(row, ROW, { value: batch.rowIndex[i] });
    return row;
  });
}

export const readRecords = async (reader, options) => records(await reader.read(options), reader.primaryGeometryColumn);
export const readRecord = async (reader, row, options) => records(await reader.readRow(row, options), reader.primaryGeometryColumn)[0];

/** Build a GeometryColumn from GeoJSON geometries (null allowed). */
export function columnFromGeoJSON(geometries, { int32 = false, scale, offset } = {}) {
  const b = new GeometryBuilder(int32);
  const [sx, sy] = scale ?? [1, 1];
  const [ox, oy] = offset ?? [0, 0];
  const ring = coordinates => {
    b.startRing();
    b.reserve(coordinates.length);
    for (const [x, y] of coordinates) { b.x[b.coords] = (x - ox) / sx; b.y[b.coords++] = (y - oy) / sy; }
  };
  const types = { Point: 1, LineString: 2, Polygon: 3, MultiPoint: 4, MultiLineString: 5, MultiPolygon: 6 };
  for (const g of geometries) {
    if (!g) { b.startRow(0); continue; }
    b.startRow(types[g.type]);
    const c = g.coordinates;
    if (g.type === 'Point') { if (c.length) { b.startPolygon(); ring([c]); } }
    else if (g.type === 'LineString' || g.type === 'MultiPoint') { b.startPolygon(); ring(c); }
    else if (g.type === 'Polygon' || g.type === 'MultiLineString') { b.startPolygon(); c.forEach(ring); }
    else for (const polygon of c) { b.startPolygon(); polygon.forEach(ring); }
  }
  return b.finish(scale, offset);
}

/** Encode GeoJSON as WKB with the given byte order and optional ISO Z. */
export function encodeWkb(g, little = true, z = false) {
  const out = [];
  const u8 = v => out.push(v);
  const u32 = v => { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, v, little); out.push(...new Uint8Array(b.buffer)); };
  const f64 = v => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v, little); out.push(...new Uint8Array(b.buffer)); };
  const pos = p => { f64(p[0]); f64(p[1]); if (z) f64(p[2]); };
  const types = { Point: 1, LineString: 2, Polygon: 3, MultiPoint: 4, MultiLineString: 5, MultiPolygon: 6 };
  const geom = (g) => {
    u8(little ? 1 : 0); u32(types[g.type] + (z ? 1000 : 0));
    const c = g.coordinates;
    if (g.type === 'Point') pos(c);
    else if (g.type === 'LineString') { u32(c.length); c.forEach(pos); }
    else if (g.type === 'Polygon') { u32(c.length); for (const r of c) { u32(r.length); r.forEach(pos); } }
    else { u32(c.length); for (const part of c) geom({ type: g.type.slice(5), coordinates: part }); }
  };
  geom(g);
  return Uint8Array.from(out);
}

/**
 * Append one geometry from flat coordinates. `partEnds` are coordinate end
 * offsets of rings or lines; `polygonEnds` are end offsets into `partEnds`.
 */
export function appendFlat(builder, type, xs, ys, partEnds, polygonEnds) {
  builder.startRow(type);
  builder.reserve(xs.length);
  const write = (start, end) => {
    builder.startRing();
    for (let i = start; i < end; i++) { builder.x[builder.coords] = Number(xs[i]); builder.y[builder.coords++] = Number(ys[i]); }
  };
  const parts = (from, to) => { for (let part = from; part < to; part++) write(part ? Number(partEnds[part - 1]) : 0, Number(partEnds[part])); };
  if (type === 1 || type === 2 || type === 4) { builder.startPolygon(); write(0, type === 1 ? Math.min(xs.length, 1) : xs.length); }
  else if (type === 6) {
    let part = 0;
    for (const end of polygonEnds) { builder.startPolygon(); parts(part, Number(end)); part = Number(end); }
  } else { builder.startPolygon(); parts(0, partEnds.length); }
}
