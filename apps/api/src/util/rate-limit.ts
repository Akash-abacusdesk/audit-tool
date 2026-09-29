/**
 * Sliding-window counter. Keys are evicted as their window empties and by a
 * periodic sweep, so rotating keys (spoofed IPs) cannot grow the map forever.
 * ponytail: per-process; move to a shared store if the API ever runs >1 replica.
 */
export function createLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  const live = (key: string, now: number): number[] => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length) hits.set(key, recent);
    else hits.delete(key);
    return recent;
  };
  setInterval(() => {
    const now = Date.now();
    for (const key of [...hits.keys()]) live(key, now);
  }, Math.max(windowMs, 60_000)).unref();

  return {
    /** Count a hit; true when over the limit. */
    hit(key: string): boolean {
      const now = Date.now();
      const recent = live(key, now);
      recent.push(now);
      hits.set(key, recent);
      return recent.length > max;
    },
    /** True when the key is already at the limit (does not count). */
    blocked(key: string): boolean {
      return live(key, Date.now()).length >= max;
    },
    /** Count a failure without checking. */
    record(key: string): void {
      const list = live(key, Date.now());
      list.push(Date.now());
      hits.set(key, list);
    },
  };
}
