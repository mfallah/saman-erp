/**
 * Retry policy shared by channel jobs (ADR-0010): exponential backoff
 * 30 s → 1 h, maximum 10 attempts, full jitter.
 */
export const MAX_SYNC_ATTEMPTS = 10;
export const BASE_BACKOFF_MS = 30_000;
export const MAX_BACKOFF_MS = 60 * 60 * 1000;

export interface BackoffState {
  readonly attempts: number;
  readonly baseMs?: number;
  readonly maxMs?: number;
}

export function backoffDelayMs(state: BackoffState, random: () => number = Math.random): number {
  const base = state.baseMs ?? BASE_BACKOFF_MS;
  const max = state.maxMs ?? MAX_BACKOFF_MS;
  const exponent = Math.min(Math.max(state.attempts, 0), 16);
  const raw = Math.min(max, base * 2 ** exponent);
  // Full jitter prevents synchronized retry storms across accounts.
  return Math.floor(random() * raw);
}

export function nextAttemptAt(
  attempts: number,
  now: Date = new Date(),
  random: () => number = Math.random,
): Date {
  return new Date(now.getTime() + backoffDelayMs({ attempts }, random));
}

export function shouldDeadLetter(attempts: number, maxAttempts = MAX_SYNC_ATTEMPTS): boolean {
  return attempts >= maxAttempts;
}

/** Debounce bucket: all stock changes in the same window share one job key. */
export function debounceKey(prefix: string, debounceMs: number, now: number): string {
  const window = Math.max(1, Math.floor(debounceMs));
  return `${prefix}:${Math.floor(now / window)}`;
}

/** Stable SHA-256 of a natural key, used for idempotency request hashes. */
import { createHash } from 'node:crypto';

export function hashNaturalKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
