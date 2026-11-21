// In-memory fixed-window counter per key (client IP). One server instance (plan A2), so memory is
// enough; a restart forgets the counts, which only helps an attacker for one window.

export interface RateLimiter {
  /** True when `key` has used up its budget in the current window. */
  readonly blocked: (key: string) => boolean;
  /** Counts one hit for `key`. */
  readonly hit: (key: string) => void;
}

export const makeRateLimiter = (options: {
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: () => number;
  /** Keys kept at most; the oldest windows are dropped first. Bounds memory under a flood. */
  readonly maxKeys?: number;
}): RateLimiter => {
  const { limit, windowMs, now = Date.now, maxKeys = 10_000 } = options;
  const windows = new Map<string, { start: number; count: number }>();

  const current = (key: string) => {
    const entry = windows.get(key);
    if (entry === undefined) return undefined;
    if (now() - entry.start >= windowMs) {
      windows.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    blocked: (key) => (current(key)?.count ?? 0) >= limit,
    hit: (key) => {
      const entry = current(key);
      if (entry) {
        entry.count += 1;
        return;
      }
      if (windows.size >= maxKeys) {
        const oldest = windows.keys().next().value;
        if (oldest !== undefined) windows.delete(oldest);
      }
      windows.set(key, { start: now(), count: 1 });
    },
  };
};
