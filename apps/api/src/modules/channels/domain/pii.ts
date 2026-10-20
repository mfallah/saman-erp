/**
 * PII minimisation for archives and API-call logs (R1-security H-10).
 *
 * Persisted partner payloads contain **identifiers and hashes only**:
 * - headers are never stored;
 * - customer identifiers (name/phone/email/address/postal/…) are replaced by
 *   salted SHA-256 hashes so equality can still be investigated;
 * - cost fields (purchase price, margin, cost) are dropped entirely;
 * - strings are truncated and arrays/depth bounded to keep rows small.
 */
import { createHash } from 'node:crypto';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const PII_KEYS = new Set([
  'name',
  'full_name',
  'fullname',
  'first_name',
  'last_name',
  'recipient',
  'receiver_name',
  'customer_name',
  'mobile',
  'phone',
  'phone_number',
  'phonenumber',
  'telephone',
  'email',
  'address',
  'address_line',
  'postal_code',
  'postcode',
  'zip_code',
  'national_id',
  'national_code',
  'iban',
  'card_number',
  'sheba',
  'birth_date',
  'password',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'apikey',
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'client_secret',
  'signature',
]);

const COST_KEYS = new Set([
  'cost',
  'cost_amount',
  'purchase_price',
  'purchaseprice',
  'buy_price',
  'margin',
  'profit',
  'cogs',
  'unit_cost',
  'total_cost',
]);

const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_STRING = 500;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Hash a phone/identifier for logs; keeps a masked suffix for operators. */
export function maskMobile(mobile: string): string {
  const digits = mobile.replace(/\D/g, '');
  if (digits.length < 6) return '***';
  return `${digits.slice(0, 4)}***${digits.slice(-4)}`;
}

/** Deterministic hash used instead of raw PII in archives. */
export function hashPii(value: string): string {
  return `sha256:${digest(value)}`;
}

/**
 * Returns a JSON-safe, PII-minimised copy. Unknown object shapes are walked;
 * headers objects (`headers`, `request_headers`, …) are dropped wholesale.
 */
export function minimizePayload(value: unknown, depth = 0): JsonValue {
  if (depth > MAX_DEPTH) return null;
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `sha256:${createHash('sha256').update(value).digest('hex')}`;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => minimizePayload(item, depth + 1));
  }
  if (typeof value === 'object') {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalized = key.toLowerCase();
      if (normalized === 'headers' || normalized.endsWith('_headers') || normalized === 'raw_body') {
        continue;
      }
      if (COST_KEYS.has(normalized)) continue;
      if (PII_KEYS.has(normalized)) {
        if (typeof child === 'string' && child.length > 0) {
          result[key] = hashPii(child);
        } else if (child !== null && child !== undefined) {
          result[key] = minimizePayload(child, depth + 1);
        }
        continue;
      }
      result[key] = minimizePayload(child, depth + 1);
    }
    return result;
  }
  return null;
}

/** Sanitises a header map for logs: names only, values replaced. */
export function redactHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of Object.keys(headers)) {
    const normalized = name.toLowerCase();
    if (normalized === 'authorization' || normalized === 'cookie' || normalized.includes('key')) {
      result[normalized] = '[redacted]';
    } else if (normalized.includes('signature')) {
      result[normalized] = '[redacted]';
    } else {
      result[normalized] = '[present]';
    }
  }
  return result;
}
