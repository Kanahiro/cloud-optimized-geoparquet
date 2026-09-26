/**
 * @import {AsyncBuffer} from '../src/types.js'
 */
import type { AsyncBuffer } from '../src/types.js';
export * from './index.js';
/**
 * Construct an AsyncBuffer for a local file using node fs package.
 *
 * @param {string} filename
 * @returns {Promise<AsyncBuffer>}
 */
export declare function asyncBufferFromFile(filename: string): Promise<AsyncBuffer>;
//# sourceMappingURL=node.d.ts.map