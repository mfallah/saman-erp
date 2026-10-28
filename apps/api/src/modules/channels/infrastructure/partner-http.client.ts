/**
 * Outbound HTTP for every channel adapter.
 *
 * - code-declared host allowlist checked on every request (M-05);
 * - per-account token bucket, 20 s total timeout, connect bounded by fetch;
 * - per-account minimum interval + circuit breaker (`AccountRateGate`): a 429
 *   opens a cooldown for that (account, operation) and for the account, and
 *   further calls fail fast with a typed `rate_limited` error instead of
 *   re-entering the partner's limiter. Only 5xx/network errors are retried
 *   inline; a 429 always returns to the job backoff;
 * - every call is written to `channel_api_calls` with headers omitted and PII
 *   hashed (H-10); secrets never enter URLs.
 */
import { IntegrationError } from '../domain/channel.types';
import type { AdapterAccount } from '../domain/channel.types';
import { AccountRateGate } from './account-rate-gate';
import { minimizePayload, type JsonValue } from '../domain/pii';
import { hashNaturalKey } from './backoff';
import { assertAllowedUrl } from './egress';
import type { ApiCallLogPort } from '../repositories/channel-api-call.repository';
import type { AppLogger } from '../ports/logger.port';
import type { TokenBucket } from './token-bucket';
import { sleep } from './token-bucket';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface PartnerRequest {
  readonly operation: string;
  readonly method: HttpMethod;
  /** Path relative to the resolved base URL, e.g. `/inventories/update/uuid`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  /** Authentication headers. Never logged or persisted. */
  readonly authHeaders: Readonly<Record<string, string>>;
  /** Extra headers (e.g. Content-Type). Also never logged. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly idempotent?: boolean;
  /** Skip retries for non-idempotent partner writes when the partner lacks an idempotency key. */
  readonly maxAttempts?: number;
  readonly syncJobId?: string | null;
  readonly traceId?: string | null;
  readonly responseType?: 'json' | 'text' | 'binary';
}

export interface PartnerResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly json: unknown;
  readonly text: string | null;
  readonly bytes: Buffer | null;
  readonly headers: Headers;
  readonly durationMs: number;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface PartnerHttpOptions {
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly now?: () => number;
  readonly sleepImpl?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** Shared per-account pacing/breaker; a private gate is created when omitted. */
  readonly rateGate?: AccountRateGate;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class PartnerHttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly gate: AccountRateGate;

  constructor(
    private readonly deps: {
      readonly logger: AppLogger;
      readonly apiCalls: ApiCallLogPort;
      readonly rateLimiter: TokenBucket;
      readonly declaredHosts: readonly string[];
    },
    options: PartnerHttpOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.now = options.now ?? Date.now;
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.random = options.random ?? Math.random;
    this.gate =
      options.rateGate ??
      new AccountRateGate({
        now: this.now,
        sleepImpl: this.sleepImpl,
      });
  }

  async request(account: AdapterAccount, request: PartnerRequest): Promise<PartnerResponse> {
    const base = assertAllowedUrl(account.baseUrl, this.deps.declaredHosts);
    const url = new URL(request.path.replace(/^\//, ''), `${base.url.replace(/\/$/, '')}/`);
    if (request.query !== undefined) {
      for (const [key, value] of Object.entries(request.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const maxAttempts = request.maxAttempts ?? this.maxAttempts;
    const canRetry = request.method === 'GET' || request.idempotent === true;
    let attempt = 0;
    let lastError: IntegrationError | null = null;

    while (attempt < maxAttempts) {
      attempt += 1;
      // Fail fast while a breaker is open: no socket, no retry storm.
      this.gate.assertAvailable(account, request.operation);
      await this.gate.acquire(account);
      const waitMs = await this.deps.rateLimiter.acquire(
        `channel:${account.id}:${request.operation}`,
      );
      if (waitMs > 0) await this.sleepImpl(Math.min(waitMs, 5_000));

      const startedAt = this.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const defaultUserAgent = (() => {
          if (account.channelCode === 'digikala') {
            const configured =
              typeof account.settings['userAgent'] === 'string' ? account.settings['userAgent'].trim() : '';
            if (configured.startsWith('DigikalaTrustedBot')) return configured;
            const sellerCode =
              (typeof account.settings['sellerCode'] === 'string' && account.settings['sellerCode'].trim().length > 0
                ? account.settings['sellerCode'].trim()
                : '') ||
              (account.credentials['seller_code'] ?? '') ||
              configured;
            if (sellerCode.length > 0) return `DigikalaTrustedBot/SelfToken/${sellerCode}`;
          }
          if (typeof account.settings['userAgent'] === 'string' && account.settings['userAgent'].length > 0) {
            return account.settings['userAgent'];
          }
          return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
        })();
        if (account.channelCode === 'digikala') {
          this.deps.logger.warn(
            { accountId: account.id, operation: request.operation, userAgent: defaultUserAgent.slice(0, 120) },
            'digikala request user-agent',
          );
        }
        const response = await this.fetchImpl(url.toString(), {
          method: request.method,
          headers: {
            accept: 'application/json',
            'user-agent': defaultUserAgent,
            ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...request.headers,
            ...request.authHeaders,
          },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          redirect: 'error',
          signal: controller.signal,
        });
        const durationMs = Math.max(0, this.now() - startedAt);
        const payload = await this.readPayload(response, request.responseType ?? 'json');
        const json = payload.json;
        const loggedResponse = payload.json ?? (payload.text === null ? null : payload.text.slice(0, 500));

        await this.log(account, request, startedAt, response.status, loggedResponse, durationMs);
        if (response.ok) {
          this.gate.noteSuccess(account.id, request.operation);
          return {
            status: response.status,
            ok: true,
            json,
            text: payload.text,
            bytes: payload.bytes,
            headers: response.headers,
            durationMs,
          };
        }

        if (response.status === 429) {
          // Open the breaker and leave the retrying to the durable job backoff:
          // retrying inline is exactly what tripped the partner's limiter.
          const cooldownMs = this.gate.noteRateLimited(
            account,
            request.operation,
            response.headers.get('retry-after'),
          );
          this.deps.logger.warn(
            { accountId: account.id, operation: request.operation, cooldownMs },
            'channel rate limited; breaker open',
          );
          throw new IntegrationError('RATE_LIMITED', {
            messageFa: 'محدودیت نرخ کانال فعال شده است؛ تلاش بعدی با فاصله انجام می‌شود.',
            retryable: true,
            httpStatus: 429,
            details: {
              retryAfterMs: String(cooldownMs),
              breaker: 'open',
            },
          });
        }

        const retryable = RETRYABLE_STATUS.has(response.status);
        lastError = this.toError(response.status, json, retryable);
        if (!retryable || !canRetry || attempt >= maxAttempts) throw lastError;
        await this.sleepImpl(this.retryDelay(attempt, response.headers.get('retry-after')));
      } catch (error) {
        if (error instanceof IntegrationError) {
          // A 429 (or a fail-fast breaker rejection) is final for this attempt.
          if (error.httpStatus === 429 || !error.retryable || !canRetry || attempt >= maxAttempts) {
            throw error;
          }
          lastError = error;
        } else {
          const durationMs = Math.max(0, this.now() - startedAt);
          const isAbort = error instanceof Error && error.name === 'AbortError';
          lastError = new IntegrationError(
            isAbort ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_UNAVAILABLE',
            {
              messageFa: isAbort
                ? 'پاسخ سرویس بیرونی در زمان مجاز دریافت نشد.'
                : 'ارتباط با سرویس بیرونی برقرار نشد.',
              retryable: true,
              cause: error,
            },
          );
          await this.log(account, request, startedAt, null, null, durationMs, lastError.code);
          if (!canRetry || attempt >= maxAttempts) throw lastError;
          await this.sleepImpl(this.retryDelay(attempt, null));
        }
        continue;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ??
      new IntegrationError('UPSTREAM_UNAVAILABLE', {
        messageFa: 'ارتباط با سرویس بیرونی برقرار نشد.',
        retryable: true,
      });
  }

  private retryDelay(attempt: number, retryAfter: string | null): number {
    const parsed = retryAfter === null ? Number.NaN : Number(retryAfter);
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed * 1000, 30_000);
    const raw = Math.min(5_000, 500 * 2 ** attempt);
    return Math.floor(this.random() * raw);
  }

  private async readPayload(
    response: Response,
    responseType: 'json' | 'text' | 'binary',
  ): Promise<{ json: unknown; text: string | null; bytes: Buffer | null }> {
    if (responseType === 'binary') {
      const bytes = Buffer.from(await response.arrayBuffer());
      return { json: null, text: null, bytes };
    }
    const text = await response.text();
    if (responseType === 'text') return { json: null, text, bytes: null };
    if (text.trim().length === 0) return { json: null, text, bytes: null };
    try {
      return { json: JSON.parse(text) as unknown, text, bytes: null };
    } catch {
      if (!response.ok) return { json: { raw: text.slice(0, 300) }, text, bytes: null };
      throw new IntegrationError('UPSTREAM_INVALID_RESPONSE', {
        messageFa: 'پاسخ سرویس بیرونی قابل خواندن نبود.',
        retryable: true,
      });
    }
  }

  private toError(status: number, json: unknown, retryable: boolean): IntegrationError {
    const body = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
    const providerMessage = typeof body['message'] === 'string' ? body['message'] : '';
    if (status === 401) {
      return new IntegrationError('UNAUTHENTICATED', {
        messageFa: 'اعتبارنامهٔ کانال پذیرفته نشد؛ حساب نیازمند بررسی است.',
        retryable: false,
        ...(providerMessage.length === 0
          ? {}
          : { details: { providerMessage: providerMessage.slice(0, 200) } }),
      });
    }
    if (status === 403) {
      return new IntegrationError('FORBIDDEN', {
        messageFa: 'دسترسی کانال به این عملیات مجاز نیست.',
        retryable: false,
      });
    }
    if (status === 429) {
      return new IntegrationError('RATE_LIMITED', {
        messageFa: 'محدودیت نرخ کانال فعال شده است؛ تلاش مجدد انجام می‌شود.',
        retryable: true,
        httpStatus: 429,
      });
    }
    return new IntegrationError(
      retryable ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_INVALID_RESPONSE',
      {
        messageFa: 'سرویس بیرونی خطا برگرداند.',
        retryable,
        httpStatus: status,
        details: { status: String(status) },
      },
    );
  }

  private async log(
    account: AdapterAccount,
    request: PartnerRequest,
    startedAt: number,
    status: number | null,
    json: unknown,
    durationMs: number,
    errorCode: string | null = null,
  ): Promise<void> {
    try {
      await this.deps.apiCalls.record({
        organizationId: account.organizationId,
        channelAccountId: account.id,
        operation: request.operation,
        method: request.method,
        endpoint: request.path,
        httpStatus: status,
        success: status !== null && status >= 200 && status < 300,
        durationMs,
        requestPayload: minimizePayload(request.body ?? null),
        responsePayload: minimizePayload(json ?? null),
        errorCode,
        syncJobId: request.syncJobId ?? null,
        traceId: request.traceId ?? null,
      });
    } catch (error) {
      this.deps.logger.error(
        {
          accountId: account.id,
          operation: request.operation,
          error: error instanceof Error ? error.message : 'log_failed',
        },
        'failed to persist channel api call log',
      );
    }
    this.deps.logger.debug(
      {
        accountId: account.id,
        operation: request.operation,
        status,
        durationMs,
        payloadHash: request.body === undefined ? null : hashNaturalKey(JSON.stringify(request.body)),
      },
      'partner call',
    );
  }
}

export function bearer(value: string): Record<string, string> {
  return { authorization: `Bearer ${value}` };
}

export function toJsonResult(response: PartnerResponse): JsonValue {
  return minimizePayload(response.json);
}
