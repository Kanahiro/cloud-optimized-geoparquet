import { abortReason } from './abort.js';

export interface AsyncBufferLike {
  byteLength: number;
  slice(start: number, end?: number, signal?: AbortSignal): ArrayBuffer | Promise<ArrayBuffer>;
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
  slices: PendingSlice[];
}

/**
 * Batch overlapping or adjacent AsyncBuffer slices into contiguous reads.
 *
 * Waiting until the current microtask finishes exposes concurrent page reads
 * without adding a timer delay. Never fill gaps: this keeps transfer limited
 * to requested bytes even when parallel runs change the batch boundaries.
 */
export function coalescingAsyncBuffer(source: AsyncBufferLike): AsyncBufferLike {
  let pending: PendingSlice[] = [];
  let flushScheduled = false;

  const flush = (): void => {
    flushScheduled = false;
    const batch = pending;
    pending = [];
    const runs = makeRuns(batch);
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

function makeRuns(batch: PendingSlice[]): SliceRun[] {
  const sorted = batch.filter(slice => !slice.settled)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const runs: SliceRun[] = [];
  for (const slice of sorted) {
    const run = runs[runs.length - 1];
    if (run && slice.start <= run.end) {
      run.end = Math.max(run.end, slice.end);
      run.slices.push(slice);
    } else {
      runs.push({ start: slice.start, end: slice.end, slices: [slice] });
    }
  }
  return runs;
}

/**
 * Reject slices intersecting any protected byte interval before they reach
 * `source`. Since coalescing never fills gaps, merged requests behind this
 * guard cannot cross a protected interval either.
 */
export function protectedAsyncBuffer(source: AsyncBufferLike, ranges: readonly ByteRange[]): AsyncBufferLike {
  const protectedRanges = normalizeRanges(ranges, source.byteLength);
  if (protectedRanges.length === 0) return source;
  return {
    byteLength: source.byteLength,
    slice(start: number, end = source.byteLength, signal?: AbortSignal) {
      if (intersectsAny(start, end, protectedRanges)) {
        return Promise.reject(new Error(`slice [${start}, ${end}) intersects a protected range`));
      }
      return source.slice(start, end, signal);
    },
  };
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
