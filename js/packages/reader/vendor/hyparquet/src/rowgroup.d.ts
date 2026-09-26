/**
 * @import {AsyncColumn, AsyncRowGroup, ChunkPlan, ColumnDecoder, DecodedArray, GroupPlan, PageLocation, ParquetParsers, ParquetReadOptions, QueryPlan, SchemaTree} from '../src/types.js'
 */
import type { AsyncRowGroup, GroupPlan, ParquetParsers, ParquetReadOptions, QueryPlan, SchemaTree } from '../src/types.js';
/**
 * Read a row group from a file-like object.
 *
 * @param {ParquetReadOptions} options
 * @param {QueryPlan} plan
 * @param {GroupPlan} groupPlan
 * @returns {AsyncRowGroup} resolves to column data
 */
export declare function readRowGroup(options: ParquetReadOptions, { metadata }: QueryPlan, groupPlan: GroupPlan): AsyncRowGroup;
/**
 * Read physical leaf pages for a column view. The view indexes
 * Dremel row boundaries before materializing any nested JavaScript values.
 *
 * @param {ParquetReadOptions} options
 * @param {QueryPlan} plan
 * @param {GroupPlan} groupPlan
 * @returns {{pathInSchema: string[], schemaPath: SchemaTree[], pages: Promise<{pages: import('../src/types.js').ColumnLevelPage[], rowStart: number}>}[]}
 */
export declare function readRowGroupPages(options: ParquetReadOptions, { metadata }: QueryPlan, groupPlan: GroupPlan): {
    pathInSchema: string[];
    schemaPath: SchemaTree[];
    pages: Promise<{
        pages: import('../src/types.js').ColumnLevelPage[];
        rowStart: number;
    }>;
}[];
export declare function asyncGroupToRows(asyncGroup: AsyncRowGroup, selectStart: number, selectEnd: number, columns: string[] | undefined, rowFormat: 'object'): Promise<Record<string, any>[]>;
export declare function asyncGroupToRows(asyncGroup: AsyncRowGroup, selectStart: number, selectEnd: number, columns: string[] | undefined, rowFormat?: 'array'): Promise<any[][]>;
/**
 * Assemble physical columns into top-level columns asynchronously.
 *
 * @param {AsyncRowGroup} asyncRowGroup
 * @param {SchemaTree} schemaTree
 * @param {Partial<ParquetParsers>} [parsers]
 * @returns {AsyncRowGroup}
 */
export declare function assembleAsync(asyncRowGroup: AsyncRowGroup, schemaTree: SchemaTree, parsers?: Partial<ParquetParsers>): AsyncRowGroup;
//# sourceMappingURL=rowgroup.d.ts.map