export interface AsyncBufferLike {
  byteLength: number;
  slice(start: number, end?: number): ArrayBuffer | Promise<ArrayBuffer>;
}

export interface RangeCoalescingOptions {
  /** Maximum single unrequested gap included in a merged request. */
  maxGapBytes?: number;
  /** Maximum cumulative unrequested bytes included in one merged request. */
  maxExtraBytes?: number;
  /** Maximum byte length of a merged request. Individual source reads may be larger. */
  maxRequestBytes?: number;
}

interface PendingSlice {
  start: number;
  end: number;
  resolve: (buffer: ArrayBuffer) => void;
  reject: (reason: unknown) => void;
}

interface SliceRun {
  start: number;
  end: number;
  extraBytes: number;
  slices: PendingSlice[];
}

const DEFAULT_MAX_GAP_BYTES = 32 * 1024;
const DEFAULT_MAX_EXTRA_BYTES = 128 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 2 * 1024 * 1024;

/**
 * Batch concurrent AsyncBuffer slices into nearby contiguous reads.
 *
 * Parquet page pruning can issue one small slice per physical column and row
 * group. Waiting until the current microtask finishes exposes that batch
 * without adding a timer delay. Nearby slices are fetched as one ordinary HTTP
 * Range and split back into exact per-caller buffers. Three absolute byte
 * budgets bound the tradeoff: a single hole, all holes in one request, and
 * the merged request itself. Absolute limits remain predictable for both tiny
 * PageIndex reads and large data pages; a ratio does not.
 */
export function coalescingAsyncBuffer(
  source: AsyncBufferLike,
  options: RangeCoalescingOptions = {},
): AsyncBufferLike {
  const maxGapBytes = options.maxGapBytes ?? DEFAULT_MAX_GAP_BYTES;
  const maxExtraBytes = options.maxExtraBytes ?? DEFAULT_MAX_EXTRA_BYTES;
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  validateByteBudget('maxGapBytes', maxGapBytes, true);
  validateByteBudget('maxExtraBytes', maxExtraBytes, true);
  validateByteBudget('maxRequestBytes', maxRequestBytes, false);

  let pending: PendingSlice[] = [];
  let flushScheduled = false;

  const flush = (): void => {
    flushScheduled = false;
    const batch = pending;
    pending = [];
    const runs = makeRuns(batch, maxGapBytes, maxExtraBytes, maxRequestBytes);
    for (const run of runs) void fetchRun(source, run);
  };

  return {
    byteLength: source.byteLength,
    slice(start: number, end = source.byteLength): Promise<ArrayBuffer> {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        return Promise.reject(new Error(`slice bounds must be safe integers, got [${start}, ${end})`));
      }
      if (start < 0 || end < start || end > source.byteLength) {
        return Promise.reject(
          new Error(`slice [${start}, ${end}) is outside buffer length ${source.byteLength}`),
        );
      }
      if (start === end) return Promise.resolve(new ArrayBuffer(0));

      const result = new Promise<ArrayBuffer>((resolve, reject) => {
        pending.push({ start, end, resolve, reject });
      });
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flush);
      }
      return result;
    },
  };
}

function makeRuns(
  batch: PendingSlice[],
  maxGapBytes: number,
  maxExtraBytes: number,
  maxRequestBytes: number,
): SliceRun[] {
  const sorted = batch.sort((a, b) => a.start - b.start || a.end - b.end);
  const runs: SliceRun[] = [];
  for (const slice of sorted) {
    const run = runs[runs.length - 1];
    if (!run) {
      runs.push({
        start: slice.start,
        end: slice.end,
        extraBytes: 0,
        slices: [slice],
      });
      continue;
    }

    const gap = Math.max(0, slice.start - run.end);
    const mergedEnd = Math.max(run.end, slice.end);
    const mergedSpan = mergedEnd - run.start;
    const mergedExtraBytes = run.extraBytes + gap;
    // Overlapping ranges never add transfer bytes, so merge them even when an
    // individual request is already larger than either configured budget.
    if (
      gap === 0 ||
      (gap <= maxGapBytes &&
        mergedExtraBytes <= maxExtraBytes &&
        mergedSpan <= maxRequestBytes)
    ) {
      run.end = mergedEnd;
      run.extraBytes = mergedExtraBytes;
      run.slices.push(slice);
    } else {
      runs.push({
        start: slice.start,
        end: slice.end,
        extraBytes: 0,
        slices: [slice],
      });
    }
  }
  return runs;
}

function validateByteBudget(name: string, value: number, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    const requirement = allowZero ? 'a non-negative' : 'a positive';
    throw new Error(`${name} must be ${requirement} safe integer, got ${value}`);
  }
}

async function fetchRun(source: AsyncBufferLike, run: SliceRun): Promise<void> {
  try {
    const buffer = await source.slice(run.start, run.end);
    const expected = run.end - run.start;
    if (buffer.byteLength < expected) {
      throw new Error(
        `source returned ${buffer.byteLength} bytes for [${run.start}, ${run.end}), expected ${expected}`,
      );
    }
    for (const slice of run.slices) {
      slice.resolve(buffer.slice(slice.start - run.start, slice.end - run.start));
    }
  } catch (error) {
    for (const slice of run.slices) slice.reject(error);
  }
}
