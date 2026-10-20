/**
 * Minimal key/value + counter store used for token buckets, token caches, SMS
 * budgets and fixed-window rate limits. Redis is the production binding; an
 * in-memory implementation keeps unit tests deterministic and lets the API
 * degrade when Redis is unavailable (ARCHITECTURE §13).
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Atomic increment returning the new value; applies TTL on first write. */
  incrBy(key: string, amount: number, ttlSeconds?: number): Promise<number>;
  /** Best-effort bulk delete for cleanup jobs. */
  delPrefix?(prefix: string): Promise<void>;
}

interface MemoryEntry {
  value: string;
  expiresAt: number | null;
}

export class InMemoryKeyValueStore implements KeyValueStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAt: ttlSeconds === undefined ? null : this.now() + ttlSeconds * 1000,
    });
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async incrBy(key: string, amount: number, ttlSeconds?: number): Promise<number> {
    const current = Number((await this.get(key)) ?? '0');
    const next = current + amount;
    const existing = this.entries.get(key);
    const expiresAt =
      existing?.expiresAt ?? (ttlSeconds === undefined ? null : this.now() + ttlSeconds * 1000);
    this.entries.set(key, { value: String(next), expiresAt });
    return next;
  }

  async delPrefix(prefix: string): Promise<void> {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  /** Test helper. */
  clear(): void {
    this.entries.clear();
  }
}
