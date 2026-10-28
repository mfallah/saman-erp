/**
 * Per-channel-account request pacing + circuit breaker for partner HTTP.
 *
 * Two independent mechanisms, both keyed on the account:
 *
 * 1. **Minimum interval** — at most one outbound request per account every
 *    `minIntervalFor(channelCode)` ms, serialised per account so a burst can never
 *    leave the process. Overridable per channel with
 *    `CHANNEL_MIN_INTERVAL_MS_<CODE>` (e.g. `CHANNEL_MIN_INTERVAL_MS_CAREXY`).
 * 2. **Circuit breaker** — a partner that answers 429 opens a cooldown for that
 *    (account, operation) pair *and* for the account as a whole. While a cooldown
 *    is open, requests fail fast with a typed `RATE_LIMITED` error and no socket
 *    is opened. The cooldown honours `Retry-After` when present, otherwise starts
 *    at 60 s and doubles per consecutive strike up to 10 min.
 *
 * State is process-local on purpose (no Redis round-trip before every call): the
 * API runs a single sync worker, and the durable retry/backoff lives in
 * `erp.channel_sync_jobs`.
 */
import { IntegrationError } from '../domain/channel.types';

/** Conservative, explicit defaults; a channel can always override via env. */
const DEFAULT_MIN_INTERVAL_MS: Readonly<Record<string, number>> = {
  carexy: 1_000,
  digikala: 300,
};
const FALLBACK_MIN_INTERVAL_MS = 250;
const BASE_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000;

export interface RateGateAccount {
  readonly id: string;
  readonly channelCode: string;
}

export interface AccountRateGateOptions {
  readonly now?: () => number;
  readonly sleepImpl?: (ms: number) => Promise<void>;
  readonly minIntervalByChannel?: Readonly<Record<string, number>>;
  readonly fallbackMinIntervalMs?: number;
  readonly baseCooldownMs?: number;
  readonly maxCooldownMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface Cooldown {
  until: number;
  strikes: number;
}

export class AccountRateGate {
  private readonly now: () => number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly minIntervalByChannel: Readonly<Record<string, number>>;
  private readonly fallbackMinIntervalMs: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly env: Readonly<Record<string, string | undefined>>;

  /** Earliest moment the next request may leave; serialised per account. */
  private readonly nextSlot = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly accountCooldown = new Map<string, Cooldown>();
  private readonly operationCooldown = new Map<string, Cooldown>();

  constructor(options: AccountRateGateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
    this.minIntervalByChannel = options.minIntervalByChannel ?? DEFAULT_MIN_INTERVAL_MS;
    this.fallbackMinIntervalMs = Math.max(0, options.fallbackMinIntervalMs ?? FALLBACK_MIN_INTERVAL_MS);
    this.baseCooldownMs = Math.max(1_000, options.baseCooldownMs ?? BASE_COOLDOWN_MS);
    this.maxCooldownMs = Math.max(this.baseCooldownMs, options.maxCooldownMs ?? MAX_COOLDOWN_MS);
    this.env = options.env ?? process.env;
  }

  /** Configured spacing for a channel: env override, then channel default. */
  minIntervalFor(channelCode: string): number {
    const envKey = `CHANNEL_MIN_INTERVAL_MS_${channelCode.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const raw = this.env[envKey];
    if (raw !== undefined && raw.trim().length > 0) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
    }
    const configured = this.minIntervalByChannel[channelCode];
    return configured === undefined ? this.fallbackMinIntervalMs : Math.max(0, configured);
  }

  /**
   * Throws `RATE_LIMITED` (retryable) while a breaker is open, so a retrying sync
   * job backs off instead of re-entering the partner's rate limiter.
   */
  assertAvailable(account: RateGateAccount, operation: string): void {
    const now = this.now();
    const accountState = this.accountCooldown.get(account.id);
    const operationState = this.operationCooldown.get(operationKey(account.id, operation));
    const until = Math.max(
      accountState !== undefined && accountState.until > now ? accountState.until : 0,
      operationState !== undefined && operationState.until > now ? operationState.until : 0,
    );
    if (until <= now) return;
    const retryAfterMs = Math.max(1, until - now);
    throw new IntegrationError('RATE_LIMITED', {
      messageFa: `محدودیت نرخ کانال فعال است؛ ${Math.ceil(retryAfterMs / 1000)} ثانیه صبر کنید.`,
      retryable: true,
      httpStatus: 429,
      details: {
        scope: accountState !== undefined && accountState.until > now ? 'account' : 'operation',
        retryAfterMs: String(retryAfterMs),
        fastFail: 'true',
      },
    });
  }

  /** Waits for the account's next slot; serialised so concurrent callers queue. */
  async acquire(account: RateGateAccount): Promise<number> {
    const previous = this.chains.get(account.id) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.chains.set(account.id, previous.then(() => current));
    await previous;
    try {
      const now = this.now();
      const slot = Math.max(this.nextSlot.get(account.id) ?? 0, now);
      const waitMs = slot - now;
      if (waitMs > 0) await this.sleepImpl(waitMs);
      this.nextSlot.set(account.id, this.now() + this.minIntervalFor(account.channelCode));
      return Math.max(0, waitMs);
    } finally {
      release();
    }
  }

  /** A 2xx clears the operation breaker; the account one decays by time only. */
  noteSuccess(accountId: string, operation: string): void {
    this.operationCooldown.delete(operationKey(accountId, operation));
  }

  /**
   * Opens both breakers after a 429. Returns the cooldown length in ms so the
   * caller can put the same number in the typed error.
   */
  noteRateLimited(
    account: RateGateAccount,
    operation: string,
    retryAfterHeader: string | null,
  ): number {
    const now = this.now();
    const key = operationKey(account.id, operation);
    const strikes = (this.operationCooldown.get(key)?.strikes ?? 0) + 1;
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
    const exponential = Math.min(
      this.maxCooldownMs,
      this.baseCooldownMs * 2 ** Math.min(strikes - 1, 6),
    );
    // `Retry-After` is authoritative when the partner sends it; otherwise the
    // cooldown starts at 60 s and doubles per consecutive strike (cap 10 min).
    const cooldownMs = retryAfterMs === null ? exponential : Math.max(retryAfterMs, 1_000);
    const until = now + cooldownMs;
    this.operationCooldown.set(key, { until, strikes });
    const accountStrikes = (this.accountCooldown.get(account.id)?.strikes ?? 0) + 1;
    this.accountCooldown.set(account.id, {
      until: Math.max(until, this.accountCooldown.get(account.id)?.until ?? 0),
      strikes: accountStrikes,
    });
    return cooldownMs;
  }

  /** Snapshot for health checks and tests. */
  snapshot(accountId: string, operation: string): {
    accountCooldownMs: number;
    operationCooldownMs: number;
    minIntervalMs: number | null;
  } {
    const now = this.now();
    const accountState = this.accountCooldown.get(accountId);
    const operationState = this.operationCooldown.get(operationKey(accountId, operation));
    return {
      accountCooldownMs: accountState === undefined ? 0 : Math.max(0, accountState.until - now),
      operationCooldownMs: operationState === undefined ? 0 : Math.max(0, operationState.until - now),
      minIntervalMs: null,
    };
  }
}

function operationKey(accountId: string, operation: string): string {
  return `${accountId}|${operation}`;
}

/** `Retry-After` is either delta-seconds or an HTTP date; both are accepted. */
function parseRetryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.trunc(seconds * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

async function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
