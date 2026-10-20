/**
 * Inbound webhook verification — R1-security H-03 / M-03 / ADR-0006 revision.
 *
 * - Signature header name, algorithm and required-ness are **compile-time**
 *   per adapter. Nothing here is read from `channel_account.settings`.
 * - Timestamp is mandatory (no feature flag, no grace window).
 * - MAC input is exactly:
 *     `${channelId}.${accountId}.${eventId}.${timestampHeaderValue}.${rawBody}`
 *   so a captured delivery cannot be replayed with a mutated event id.
 * - Comparison is constant-time over fixed-length digests; both the active and
 *   the previous (24 h rotation window) secret are tried.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  ChannelCode,
  WebhookRejectionReason,
  WebhookVerdict,
  WebhookVerifyInput,
} from './channel.types';

export const WEBHOOK_MAX_SKEW_SECONDS = 300;
export const WEBHOOK_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const WEBHOOK_MAX_HEADER_BYTES = 16 * 1024;

export interface WebhookSignatureConfig {
  readonly channelCode: ChannelCode;
  readonly headerNames: readonly string[];
  readonly eventIdHeaders: readonly string[];
  readonly timestampHeaders: readonly string[];
  readonly algorithm: 'sha256';
  readonly required: true;
  /** Hex accepts an optional `sha256=` prefix. */
  readonly encoding: 'hex';
}

/**
 * Compile-time configuration. Adding a channel means a code change + review.
 * `TBD-DIGIKALA`: the envelope/header *names* are not confirmed by the supplied
 * catalog; these are the documented candidates and remain declarative constants
 * until sandbox validation (never runtime-editable).
 */
export const WEBHOOK_SIGNATURE_CONFIG: Readonly<Record<ChannelCode, WebhookSignatureConfig>> = {
  carexy: {
    channelCode: 'carexy',
    headerNames: ['x-signature', 'x-hub-signature-256'],
    eventIdHeaders: ['x-event-id'],
    timestampHeaders: ['x-timestamp'],
    algorithm: 'sha256',
    required: true,
    encoding: 'hex',
  },
  digikala: {
    channelCode: 'digikala',
    // TBD-DIGIKALA: candidate headers; compile-time only.
    headerNames: ['x-digikala-signature', 'x-signature', 'x-hub-signature-256'],
    eventIdHeaders: ['x-event-id', 'x-digikala-event-id'],
    timestampHeaders: ['x-timestamp', 'x-digikala-timestamp'],
    algorithm: 'sha256',
    required: true,
    encoding: 'hex',
  },
  mock: {
    channelCode: 'mock',
    headerNames: ['x-mock-signature'],
    eventIdHeaders: ['x-event-id'],
    timestampHeaders: ['x-timestamp'],
    algorithm: 'sha256',
    required: true,
    encoding: 'hex',
  },
};

/** Raw MAC message bytes. `rawBody` is appended byte-for-byte. */
export function buildWebhookMacInput(input: {
  readonly channelId: string;
  readonly accountId: string;
  readonly eventId: string;
  readonly timestamp: string;
  readonly rawBody: Buffer;
}): Buffer {
  const prefix = `${input.channelId}.${input.accountId}.${input.eventId}.${input.timestamp}.`;
  return Buffer.concat([Buffer.from(prefix, 'utf8'), input.rawBody]);
}

export function computeWebhookSignature(
  secret: string,
  input: Parameters<typeof buildWebhookMacInput>[0],
): string {
  return createHmac('sha256', secret).update(buildWebhookMacInput(input)).digest('hex');
}

function header(
  headers: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = headers[name.toLowerCase()];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function parseTimestamp(raw: string): Date | null {
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    // Unix seconds, optionally milliseconds. Reject implausible values.
    const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const iso = new Date(raw);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

function normalizeSignature(raw: string): string {
  const value = raw.trim();
  return value.startsWith('sha256=') ? value.slice('sha256='.length) : value;
}

/**
 * Constant-time comparison of two hex digests. Invalid hex still performs a
 * comparison against a zero digest, so length/encoding failures do not leak a
 * distinguishable timing side channel.
 */
function safeEqualHex(expectedHex: string, providedHex: string): boolean {
  const expected = /^[0-9a-f]{64}$/i.test(expectedHex)
    ? Buffer.from(expectedHex, 'hex')
    : Buffer.alloc(32);
  const provided = /^[0-9a-f]{64}$/i.test(providedHex)
    ? Buffer.from(providedHex, 'hex')
    : Buffer.alloc(32);
  const equal = timingSafeEqual(expected, provided);
  return equal && expectedHex.toLowerCase() === providedHex.toLowerCase();
}

export interface VerifyOptions {
  readonly config?: WebhookSignatureConfig;
  readonly maxSkewSeconds?: number;
}

export function verifyWebhook(input: WebhookVerifyInput, options: VerifyOptions = {}): WebhookVerdict {
  const config = options.config ?? WEBHOOK_SIGNATURE_CONFIG.carexy;
  const maxSkewSeconds = options.maxSkewSeconds ?? WEBHOOK_MAX_SKEW_SECONDS;

  if (input.rawBody.length > WEBHOOK_MAX_BODY_BYTES) {
    return { valid: false, reason: 'body_unavailable' };
  }
  if (input.secrets.length === 0 || input.secrets.every((secret) => secret.length === 0)) {
    return { valid: false, reason: 'secret_not_configured' };
  }

  const eventId = header(input.headers, config.eventIdHeaders);
  if (eventId === undefined || eventId.length > 200) {
    return { valid: false, reason: 'event_id_missing' };
  }

  const timestampRaw = header(input.headers, config.timestampHeaders);
  if (timestampRaw === undefined) {
    // M-03: mandatory; the old WEBHOOK_REQUIRE_TIMESTAMP flag is gone.
    return { valid: false, reason: 'timestamp_missing', eventId };
  }
  const timestamp = parseTimestamp(timestampRaw);
  if (timestamp === null) {
    return { valid: false, reason: 'timestamp_invalid', eventId };
  }

  const now = input.now ?? new Date();
  const skewSeconds = Math.abs(now.getTime() - timestamp.getTime()) / 1000;
  if (skewSeconds > maxSkewSeconds) {
    return { valid: false, reason: 'timestamp_skew', eventId };
  }

  const providedRaw = header(input.headers, config.headerNames);
  if (providedRaw === undefined) {
    return { valid: false, reason: 'signature_missing', eventId };
  }
  const provided = normalizeSignature(providedRaw);

  const macInput = {
    channelId: input.channelId,
    accountId: input.accountId,
    eventId,
    timestamp: timestampRaw,
    rawBody: input.rawBody,
  };

  let matched = false;
  let matchedHeader = '';
  for (const secret of input.secrets) {
    if (secret.length === 0) continue;
    const expected = computeWebhookSignature(secret, macInput);
    // Loop all secrets so the active/previous rotation window is accepted and
    // timing does not reveal which one matched.
    if (safeEqualHex(expected, provided)) {
      matched = true;
      matchedHeader = config.headerNames[0] ?? '';
    }
  }

  if (!matched) {
    return { valid: false, reason: 'signature_invalid', eventId };
  }
  return { valid: true, eventId, timestamp, headerName: matchedHeader };
}

export function rejectionToReason(reason: WebhookRejectionReason): string {
  switch (reason) {
    case 'signature_missing':
      return 'webhook_signature_missing';
    case 'signature_invalid':
      return 'webhook_signature_invalid';
    case 'timestamp_missing':
      return 'webhook_timestamp_missing';
    case 'timestamp_invalid':
      return 'webhook_timestamp_invalid';
    case 'timestamp_skew':
      return 'webhook_timestamp_skew';
    case 'event_id_missing':
      return 'webhook_event_id_missing';
    case 'secret_not_configured':
      return 'webhook_secret_not_configured';
    case 'body_unavailable':
      return 'webhook_body_unavailable';
  }
}
