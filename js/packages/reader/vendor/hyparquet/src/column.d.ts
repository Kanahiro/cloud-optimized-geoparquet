/**
 * @import {ColumnDecoder, DataReader, DecodedArray, PageHeader, PageResult, RowGroupSelect, SubColumnData} from '../src/types.js'
 */
import type { ColumnDecoder, DataReader, DecodedArray, PageHeader, PageResult, RowGroupSelect, SubColumnData } from '../src/types.js';
/**
 * Parse column data from a buffer.
 *
 * @param {DataReader} reader
 * @param {RowGroupSelect} rowGroupSelect row group selection
 * @param {ColumnDecoder} columnDecoder column decoder params
 * @param {(chunk: SubColumnData) => void} [onPage] callback for each page
 * @returns {{ data: DecodedArray[], skipped: number }}
 */
export declare function readColumn(reader: DataReader, { groupStart, selectStart, selectEnd }: RowGroupSelect, columnDecoder: ColumnDecoder, onPage?: (chunk: SubColumnData) => void): {
    data: DecodedArray[];
    skipped: number;
};
/**
 * Decode physical pages without creating one array per nested row. The caller
 * owns row alignment and materialization; values have already passed through
 * the existing logical type parsers.
 *
 * @param {DataReader} reader
 * @param {ColumnDecoder} columnDecoder
 * @returns {import('../src/types.js').ColumnLevelPage[]}
 */
export declare function readColumnPages(reader: DataReader, columnDecoder: ColumnDecoder): import('../src/types.js').ColumnLevelPage[];
/**
 * Read a page (data or dictionary) from a buffer.
 *
 * @param {DataReader} reader
 * @param {PageHeader} header
 * @param {ColumnDecoder} columnDecoder
 * @param {DecodedArray | undefined} dictionary
 * @param {DecodedArray | undefined} previousChunk
 * @param {number} pageStart skip this many rows in the page
 * @returns {PageResult}
 */
export declare function readPage(reader: DataReader, header: PageHeader, columnDecoder: ColumnDecoder, dictionary: DecodedArray | undefined, previousChunk: DecodedArray | undefined, pageStart: number): PageResult;
//# sourceMappingURL=column.d.ts.map