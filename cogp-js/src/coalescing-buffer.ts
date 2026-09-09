import { abortReason } from './abort.js';

export interface AsyncBufferLike {
  byteLength: number;
  slice(start: number, end?: number, signal?: AbortSignal): ArrayBuffer | Promise<ArrayBuffer>;
}

interface CoalescingOptions {
  /** Byte intervals that must neither be requested nor crossed by a merge. */
  protectedRanges?: readonly ByteRange[];
}

export interface ByteRange {
  start: number;
  end: number;
}

interface PendingSlice {
  start: number;
  end: number;
  resolve: (buffer: ArrayBuffer) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
}

interface SliceRun {
  start: number;
  end: number;
  requestedBytes: number;
  slices: PendingSlice[];
}

// This is the measured knee across polygon, line, and building workloads:
// larger budgets add transfer much faster than they reduce concurrent reads.
const MAX_OVERFETCH_BYTES = 32 * 1024;

/**
 * Batch concurrent AsyncBuffer slices into nearby contiguous reads.
 *
 * Parquet page pruning can issue one small slice per physical column and row
 * group. Waiting until the current microtask finishes exposes that batch
 * without adding a timer delay. Nearby slices are fetched as one ordinary HTTP
 * Range and split back into exact per-caller buffers. The cumulative
 * overfetch budget is deliberately the only merge policy: it bounds wasted
 * transfer and avoids exposing transport-tuning details to callers.
 */
export function coalescingAsyncBuffer(
  source: AsyncBufferLike,
  options: CoalescingOptions = {},
): AsyncBufferLike {
  const protectedRanges = normalizeRanges(options.protectedRanges ?? [], source.byteLength);

  let pending: PendingSlice[] = [];
  let flushScheduled = false;

  const flush = (): void => {
    flushScheduled = false;
    const batch = pending;
    pending = [];
    const runs = makeRuns(batch, protectedRanges);
    for (const run of runs) void fetchRun(source, run);
  };

  return {
    byteLength: source.byteLength,
    slice(start: number, end = source.byteLength, signal?: AbortSignal): Promise<ArrayBuffer> {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        return Promise.reject(new Error(`slice bounds must be safe integers, got [${start}, ${end})`));
      }
      if (start < 0 || end < start || end > source.byteLength) {
        return Promise.reject(
          new Error(`slice [${start}, ${end}) is outside buffer length ${source.byteLength}`),
        );
      }
      if (start === end) return Promise.resolve(new ArrayBuffer(0));
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      if (intersectsAny(start, end, protectedRanges)) {
        return Promise.reject(new Error(`slice [${start}, ${end}) intersects a protected range`));
      }

      const result = new Promise<ArrayBuffer>((resolve, reject) => {
        const slice: PendingSlice = { start, end, resolve, reject, signal, settled: false };
        if (signal) {
          slice.onAbort = () => rejectSlice(slice, abortReason(signal));
          signal.addEventListener('abort', slice.onAbort, { once: true });
        }
        pending.push(slice);
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
  protectedRanges: readonly ByteRange[],
): SliceRun[] {
  const sorted = batch.filter(slice => !slice.settled)
    .sort((a, b) => a.start - b.start || a.end - b.end);
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
    const overfetchBytes = mergedSpan - mergedRequestedBytes;
    // Overlapping ranges never add transfer bytes, so merge them regardless
    // of the overfetch budget.
    if (
      gap <= 0 ||
      (overfetchBytes <= MAX_OVERFETCH_BYTES
        && !intersectsAny(run.end, slice.start, protectedRanges))
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

function normalizeRanges(ranges: readonly ByteRange[], byteLength: number): ByteRange[] {
  const sorted = ranges.map(({ start, end }) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > byteLength) {
      throw new Error(`protected range [${start}, ${end}) is outside buffer length ${byteLength}`);
    }
    return { start, end };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: ByteRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push(range);
  }
  return merged;
}

function intersectsAny(start: number, end: number, ranges: readonly ByteRange[]): boolean {
  if (end <= start) return false;
  return ranges.some((range) => range.start < end && start < range.end);
}

async function fetchRun(source: AsyncBufferLike, run: SliceRun): Promise<void> {
  const controller = new AbortController();
  const abortIfUnused = (): void => {
    if (run.slices.every(slice => slice.settled)) controller.abort();
  };
  for (const slice of run.slices) slice.signal?.addEventListener('abort', abortIfUnused);
  try {
    const buffer = await source.slice(run.start, run.end, controller.signal);
    const expected = run.end - run.start;
    if (buffer.byteLength < expected) {
      throw new Error(
        `source returned ${buffer.byteLength} bytes for [${run.start}, ${run.end}), expected ${expected}`,
      );
    }
    for (const slice of run.slices) {
      // The common one-request run already has the exact ArrayBuffer the
      // caller asked for. Passing it through avoids copying every compressed
      // Parquet page solely because it traversed the coalescing layer.
      if (slice.start === run.start && slice.end === run.end) resolveSlice(slice, buffer);
      else resolveSlice(slice, buffer.slice(slice.start - run.start, slice.end - run.start));
    }
  } catch (error) {
    for (const slice of run.slices) rejectSlice(slice, error);
  } finally {
    for (const slice of run.slices) slice.signal?.removeEventListener('abort', abortIfUnused);
  }
}

function finishSlice(slice: PendingSlice): boolean {
  if (slice.settled) return false;
  slice.settled = true;
  if (slice.signal && slice.onAbort) slice.signal.removeEventListener('abort', slice.onAbort);
  return true;
}

function resolveSlice(slice: PendingSlice, value: ArrayBuffer): void {
  if (finishSlice(slice)) slice.resolve(value);
}

function rejectSlice(slice: PendingSlice, error: unknown): void {
  if (finishSlice(slice)) slice.reject(error);
}
