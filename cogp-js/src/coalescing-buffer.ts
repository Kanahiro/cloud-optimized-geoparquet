export interface AsyncBufferLike {
  byteLength: number;
  slice(start: number, end?: number): ArrayBuffer | Promise<ArrayBuffer>;
}

export interface RangeCoalescingOptions {
  /** Maximum unrequested gap included to eliminate one range request. */
  maxGapBytes?: number;
  /** Maximum merged bytes / uniquely requested bytes; must be at least 1. */
  maxOverfetchRatio?: number;
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
  requestedBytes: number;
  slices: PendingSlice[];
}

const DEFAULT_MAX_GAP_BYTES = 128 * 1024;
const DEFAULT_MAX_OVERFETCH_RATIO = 1.25;

/**
 * Batch concurrent AsyncBuffer slices into nearby contiguous reads.
 *
 * Parquet page pruning can issue one small slice per physical column and row
 * group. Waiting until the current microtask finishes exposes that batch
 * without adding a timer delay. Nearby slices are fetched as one ordinary HTTP
 * Range and split back into exact per-caller buffers. The gap limit makes the
 * request-count/extra-byte tradeoff explicit and bounded. Completed ranges are
 * not retained here. A correctly configured HTTP cache may reuse compatible
 * responses, but differently shaped partial ranges are not assumed reusable.
 */
export function coalescingAsyncBuffer(
  source: AsyncBufferLike,
  options: RangeCoalescingOptions = {},
): AsyncBufferLike {
  const maxGapBytes = options.maxGapBytes ?? DEFAULT_MAX_GAP_BYTES;
  const maxOverfetchRatio = options.maxOverfetchRatio ?? DEFAULT_MAX_OVERFETCH_RATIO;
  if (!Number.isSafeInteger(maxGapBytes) || maxGapBytes < 0) {
    throw new Error(`maxGapBytes must be a non-negative safe integer, got ${maxGapBytes}`);
  }
  if (!Number.isFinite(maxOverfetchRatio) || maxOverfetchRatio < 1) {
    throw new Error(`maxOverfetchRatio must be a finite number >= 1, got ${maxOverfetchRatio}`);
  }

  let pending: PendingSlice[] = [];
  let flushScheduled = false;

  const flush = (): void => {
    flushScheduled = false;
    const batch = pending;
    pending = [];
    const runs = makeRuns(batch, maxGapBytes, maxOverfetchRatio);
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
  maxOverfetchRatio: number,
): SliceRun[] {
  const sorted = batch.sort((a, b) => a.start - b.start || a.end - b.end);
  const runs: SliceRun[] = [];
  for (const slice of sorted) {
    const run = runs[runs.length - 1];
    if (!run) {
      runs.push({
        start: slice.start,
        end: slice.end,
        requestedBytes: slice.end - slice.start,
        slices: [slice],
      });
      continue;
    }

    const gap = slice.start - run.end;
    const mergedEnd = Math.max(run.end, slice.end);
    const mergedSpan = mergedEnd - run.start;
    const addedRequestedBytes = Math.max(0, slice.end - Math.max(slice.start, run.end));
    const mergedRequestedBytes = run.requestedBytes + addedRequestedBytes;
    const overfetchRatio = mergedSpan / mergedRequestedBytes;
    // Overlapping ranges never add transfer bytes, so merge them even when an
    // individual request is already larger than either configured budget.
    if (
      gap <= 0 ||
      (gap <= maxGapBytes && overfetchRatio <= maxOverfetchRatio)
    ) {
      run.end = mergedEnd;
      run.requestedBytes = mergedRequestedBytes;
      run.slices.push(slice);
    } else {
      runs.push({
        start: slice.start,
        end: slice.end,
        requestedBytes: slice.end - slice.start,
        slices: [slice],
      });
    }
  }
  return runs;
}

async function fetchRun(
  source: AsyncBufferLike,
  run: SliceRun,
): Promise<void> {
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
