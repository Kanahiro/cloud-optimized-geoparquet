import type { AsyncBuffer, BloomFilter, ByteRange, FileMetaData, GroupPlan, PageLocation, PageRanges, ParquetParsers, ParquetQueryFilter, ParquetReadOptions, QueryPlan, RowGroup, SchemaElement } from '../src/types.js';
/**
 * Plan which byte ranges to read to satisfy a read request.
 * Metadata must be non-null.
 *
 * @param {ParquetReadOptions & { bloomFiltersByGroup?: Record<string, BloomFilter>[], schemaElements?: Record<string, SchemaElement>, pageRangesByGroup?: (PageRanges | undefined)[], pageLocationsByGroup?: Record<string, PageLocation[]>[] }} options
 * @returns {QueryPlan}
 */
export declare function parquetPlan(options: ParquetReadOptions & {
    bloomFiltersByGroup?: Record<string, BloomFilter>[];
    schemaElements?: Record<string, SchemaElement>;
    pageRangesByGroup?: (PageRanges | undefined)[];
    pageLocationsByGroup?: Record<string, PageLocation[]>[];
}): QueryPlan;
/**
 * Select physical row-group ranges without planning column reads.
 *
 * @param {ParquetReadOptions & { bloomFiltersByGroup?: Record<string, BloomFilter>[], schemaElements?: Record<string, SchemaElement>, pageRangesByGroup?: (PageRanges | undefined)[], pageLocationsByGroup?: Record<string, PageLocation[]>[] }} options
 * @returns {{groups: {rowGroup: RowGroup, groupIndex: number, groupStart: number, groupRows: number, ranges: PageRanges, pageRanges?: PageRanges, pageLocations?: Record<string, PageLocation[]>}[], rowEnd: number}}
 */
export declare function parquetPlanGroups({ metadata, rowStart, rowEnd, columns, filter, filterStrict, bloomFiltersByGroup, schemaElements, pageRangesByGroup, pageLocationsByGroup }: ParquetReadOptions & {
    bloomFiltersByGroup?: Record<string, BloomFilter>[];
    schemaElements?: Record<string, SchemaElement>;
    pageRangesByGroup?: (PageRanges | undefined)[];
    pageLocationsByGroup?: Record<string, PageLocation[]>[];
}): {
    groups: {
        rowGroup: RowGroup;
        groupIndex: number;
        groupStart: number;
        groupRows: number;
        ranges: PageRanges;
        pageRanges?: PageRanges;
        pageLocations?: Record<string, PageLocation[]>;
    }[];
    rowEnd: number;
};
/**
 * Build byte plans for retained ranges in one row group.
 *
 * @param {object} options
 * @param {RowGroup} options.rowGroup
 * @param {number} options.groupStart
 * @param {number} options.groupRows
 * @param {PageRanges} options.ranges
 * @param {string[]} [options.columns]
 * @param {boolean} [options.useOffsetIndex]
 * @param {PageRanges} [options.pageRanges]
 * @param {Record<string, PageLocation[]>} [options.pageLocations]
 * @returns {{groups: GroupPlan[], fetches: ByteRange[], indexes: ByteRange[]}}
 */
export declare function parquetPlanGroup({ rowGroup, groupStart, groupRows, ranges, columns, useOffsetIndex, pageRanges, pageLocations }: {
    rowGroup: RowGroup;
    groupStart: number;
    groupRows: number;
    ranges: PageRanges;
    columns?: string[];
    useOffsetIndex?: boolean;
    pageRanges?: PageRanges;
    pageLocations?: Record<string, PageLocation[]>;
}): {
    groups: GroupPlan[];
    fetches: ByteRange[];
    indexes: ByteRange[];
};
/**
 * Fetch bloom filters for $eq / $in columns of row groups not already provably
 * skippable by statistics alone. Returns an array indexed by row-group ordinal;
 * each entry maps top-level column name → BloomFilter for any chunk whose
 * bloom filter we were able to parse. Adds one round-trip when at least one
 * bloom filter is fetched; otherwise returns synchronously.
 *
 * @param {object} options
 * @param {AsyncBuffer} options.file
 * @param {FileMetaData} options.metadata
 * @param {ParquetQueryFilter} options.filter
 * @param {boolean} [options.filterStrict]
 * @returns {Promise<Record<string, BloomFilter>[]>}
 */
export declare function prefetchBloomFilters({ file, metadata, filter, filterStrict }: {
    file: AsyncBuffer;
    metadata: FileMetaData;
    filter: ParquetQueryFilter;
    filterStrict?: boolean;
}): Promise<Record<string, BloomFilter>[]>;
/**
 * Fetch page indexes (column index + offset index) for filter columns of row
 * groups that survive row-group-level pruning, and compute candidate row
 * ranges per group from the per-page min/max statistics.
 *
 * Returns pageRangesByGroup indexed by row-group ordinal: sorted disjoint
 * [start, end) row ranges (relative to the group) that could match the filter.
 * An empty array means the group provably contains no matching rows; undefined
 * means no page-level information was available for that group.
 * Also returns pageLocationsByGroup, mapping row-group ordinals and physical
 * leaf paths to page locations, so the read path can reuse the parsed offset
 * indexes without refetching them.
 *
 * @param {object} options
 * @param {AsyncBuffer} options.file
 * @param {FileMetaData} options.metadata
 * @param {ParquetQueryFilter} [options.filter]
 * @param {boolean} [options.filterStrict]
 * @param {number} [options.rowStart]
 * @param {number} [options.rowEnd]
 * @param {string[]} [options.columns]
 * @param {Record<string, BloomFilter>[]} [options.bloomFiltersByGroup]
 * @param {Record<string, SchemaElement>} [options.schemaElements]
 * @param {Partial<ParquetParsers>} [options.parsers]
 * @returns {Promise<{pageRangesByGroup: (PageRanges | undefined)[], pageLocationsByGroup: Record<string, PageLocation[]>[]}>}
 */
export declare function prefetchPageIndexes({ file, metadata, filter, filterStrict, rowStart, rowEnd, columns, bloomFiltersByGroup, schemaElements, parsers }: {
    file: AsyncBuffer;
    metadata: FileMetaData;
    filter?: ParquetQueryFilter;
    filterStrict?: boolean;
    rowStart?: number;
    rowEnd?: number;
    columns?: string[];
    bloomFiltersByGroup?: Record<string, BloomFilter>[];
    schemaElements?: Record<string, SchemaElement>;
    parsers?: Partial<ParquetParsers>;
}): Promise<{
    pageRangesByGroup: (PageRanges | undefined)[];
    pageLocationsByGroup: Record<string, PageLocation[]>[];
}>;
/**
 * Prefetch byte ranges from an AsyncBuffer.
 *
 * @param {AsyncBuffer} file
 * @param {{fetches: ByteRange[]}} options
 * @returns {AsyncBuffer}
 */
export declare function prefetchAsyncBuffer(file: AsyncBuffer, { fetches }: {
    fetches: ByteRange[];
}): AsyncBuffer;
//# sourceMappingURL=plan.d.ts.map