/**
 * @import {ColumnLevelPage, DecodedArray, ParquetColumnLeaf, ParquetColumnView, ParquetParsers, SchemaTree} from '../src/types.js'
 */
import type { ColumnLevelPage, ParquetColumnView, ParquetParsers, SchemaTree } from '../src/types.js';
/**
 * Keep physical leaf values and their row boundaries in columns. A row is
 * assembled only when requested by get() or toArray().
 *
 * @param {SchemaTree} schema top-level selected column
 * @param {{pathInSchema: string[], schemaPath: SchemaTree[], pages: ColumnLevelPage[], rowStart: number}[]} decodedLeaves
 * @param {number} groupStart absolute first row of the row group
 * @param {number} groupRows number of rows in the row group
 * @param {number} rowStart absolute first requested row
 * @param {number} rowEnd absolute end of requested rows
 * @param {Partial<ParquetParsers> | undefined} parsers
 * @returns {ParquetColumnView}
 */
export declare function createColumnView(schema: SchemaTree, decodedLeaves: {
    pathInSchema: string[];
    schemaPath: SchemaTree[];
    pages: ColumnLevelPage[];
    rowStart: number;
}[], groupStart: number, groupRows: number, rowStart: number, rowEnd: number, parsers: Partial<ParquetParsers> | undefined): ParquetColumnView;
//# sourceMappingURL=columnview.d.ts.map