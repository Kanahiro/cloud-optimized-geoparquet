export interface AsyncBufferLike {
  byteLength: number;
  slice(start: number, end?: number): ArrayBuffer | Promise<ArrayBuffer>;
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
  slices: PendingSlice[];
}

/**
 * Batch overlapping or adjacent AsyncBuffer slices into contiguous reads.
 *
 * Waiting until the current microtask finishes exposes concurrent page reads
 * without adding a timer delay. Never fill gaps: this keeps transfer limited
 * to requested bytes even when parallel reads change the batch boundaries.
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

function makeRuns(batch: PendingSlice[]): SliceRun[] {
  const sorted = batch.sort((a, b) => a.start - b.start || a.end - b.end);
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
