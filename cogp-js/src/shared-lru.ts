import { raceAbort, throwIfAborted } from './abort.js';

export interface LruEntry<V> { value: V; bytes: number }
interface Pending<V> { controller: AbortController; consumers: number; promise: Promise<V> }

/** Byte-budgeted LRU whose in-flight loads are shared by key. A load is aborted
 * only after its last consumer leaves, and is retained only if it completes unaborted. */
export class SharedLru<V> {
  readonly entries = new Map<string, LruEntry<V>>();
  private readonly pending = new Map<string, Pending<V>>();
  bytes = 0;

  constructor(private readonly maxBytes: number, private readonly maxEntries = Infinity) {}

  /** Return a retained value and mark it most recently used. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }

  load(key: string, fetch: (signal: AbortSignal) => Promise<LruEntry<V>>, signal?: AbortSignal): Promise<V> {
    throwIfAborted(signal);
    let entry = this.pending.get(key);
    if (!entry || entry.controller.signal.aborted) {
      const controller = new AbortController();
      const fresh: Pending<V> = { controller, consumers: 0, promise: undefined as never };
      this.pending.set(key, fresh);
      fresh.promise = Promise.resolve().then(async () => {
        throwIfAborted(controller.signal);
        const { value, bytes } = await fetch(controller.signal);
        // A transport that ignores abort must not populate the cache.
        throwIfAborted(controller.signal);
        this.retain(key, value, bytes);
        return value;
      }).finally(() => {
        if (this.pending.get(key) === fresh) this.pending.delete(key);
      });
      entry = fresh;
    }
    return this.consume(key, entry, signal);
  }

  private async consume(key: string, entry: Pending<V>, signal?: AbortSignal): Promise<V> {
    entry.consumers++;
    try {
      const value = await raceAbort(entry.promise, signal);
      throwIfAborted(signal);
      return value;
    } finally {
      entry.consumers--;
      if (!entry.consumers && this.pending.get(key) === entry) entry.controller.abort();
    }
  }

  private retain(key: string, value: V, bytes: number): void {
    if (bytes > this.maxBytes) return;
    const previous = this.entries.get(key);
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
    // The entry cap also bounds bookkeeping for datasets with many tiny values.
    while (this.bytes + bytes > this.maxBytes || this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, bytes }); this.bytes += bytes;
  }
}
