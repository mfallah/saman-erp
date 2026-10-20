/**
 * Per-account token bucket (API.md §8.5). Hot state lives in Redis; the
 * in-memory fallback is per-process and intentionally conservative.
 */
import type { KeyValueStore } from '../ports/key-value.port';

export interface TokenBucketOptions {
  readonly capacity: number;
  readonly refillPerSecond: number;
  readonly now?: () => number;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private readonly local = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly store: KeyValueStore,
    options: TokenBucketOptions,
  ) {
    this.capacity = Math.max(1, options.capacity);
    this.refillPerSecond = Math.max(0.001, options.refillPerSecond);
    this.now = options.now ?? Date.now;
  }

  /**
   * Consumes one token if available. Returns the wait in ms (0 = acquired) so
   * callers can delay rather than fail.
   */
  async acquire(key: string): Promise<number> {
    const now = this.now();
    const state = this.local.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const elapsedSeconds = Math.max(0, (now - state.updatedAt) / 1000);
    const refilled = Math.min(this.capacity, state.tokens + elapsedSeconds * this.refillPerSecond);

    if (refilled >= 1) {
      this.local.set(key, { tokens: refilled - 1, updatedAt: now });
      await this.store.set(`rl:${key}`, String(refilled - 1), 3600);
      return 0;
    }

    const missing = 1 - refilled;
    const waitMs = Math.ceil((missing / this.refillPerSecond) * 1000);
    this.local.set(key, { tokens: refilled, updatedAt: now });
    return waitMs;
  }

  /** Snapshot for health checks. */
  remaining(key: string): number {
    return Math.floor(this.local.get(key)?.tokens ?? this.capacity);
  }
}

export async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
