// Insertion-ordered Map doubles as an LRU: `get` re-inserts the entry at the
// end (most recent), `set` evicts from the head (oldest) until the running
// total weight is back under the configured budget. The caller supplies the
// weight at insert time — for Promise values this means weighing by an
// upstream known size (e.g. row count from metadata) rather than waiting on
// resolution.

interface Entry<V> {
  value: V;
  weight: number;
}

export class LruCache<V> {
  private readonly map = new Map<string, Entry<V>>();
  private totalWeight = 0;

  constructor(private readonly maxWeight: number) {}

  /** Move `key` to most-recent position and return its value, if present. */
  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Insert or replace, then evict LRU entries until under `maxWeight`. */
  set(key: string, value: V, weight: number): void {
    const prev = this.map.get(key);
    if (prev !== undefined) {
      this.totalWeight -= prev.weight;
      this.map.delete(key);
    }
    this.map.set(key, { value, weight });
    this.totalWeight += weight;
    while (this.totalWeight > this.maxWeight && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value!;
      const victim = this.map.get(oldestKey)!;
      this.totalWeight -= victim.weight;
      this.map.delete(oldestKey);
    }
  }

  clear(): void {
    this.map.clear();
    this.totalWeight = 0;
  }

  get weight(): number {
    return this.totalWeight;
  }

  get size(): number {
    return this.map.size;
  }
}
