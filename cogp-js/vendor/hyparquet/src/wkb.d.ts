/**
 * WKB (Well-Known Binary) decoder for geometry objects.
 *
 * @param {DataReader} reader
 * @returns {Geometry} geometry object
 */
export declare function wkbToGeojson(reader: DataReader): Geometry;
export type WkbFlags = {
    littleEndian: boolean;
    type: number;
    dim: number;
    count: number;
};
import type { DataReader, Geometry } from '../src/types.js';
/**
 * @typedef {object} WkbFlags
 * @property {boolean} littleEndian
 * @property {number} type
 * @property {number} dim
 * @property {number} count
 */
/**
 * @import {DataReader, Geometry} from '../src/types.js'
 */
//# sourceMappingURL=wkb.d.ts.map