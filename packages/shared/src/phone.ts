/**
 * Iranian mobile number normalization (`API.md` §4.1 identity, SMS providers).
 *
 * Canonical internal form is the national `09XXXXXXXXX` form. Channel/provider
 * payloads may carry `+98...`, `0098...`, `98...` or bare `9XXXXXXXXX`; all are
 * normalized before persistence, hashing, deduplication or rate limiting.
 */
import { z } from 'zod';

import { toAsciiDigits } from './digits';

/** National Iranian mobile form: 09 + 9 digits. */
export const IRANIAN_MOBILE_PATTERN = /^09\d{9}$/;

const SEPARATORS = /[\s\-().]/g;

/**
 * Normalizes an Iranian mobile number to `09XXXXXXXXX`.
 * Returns `null` when the value cannot be a valid Iranian mobile number.
 */
export function normalizeIranianMobile(input: string): string | null {
  let value = toAsciiDigits(input).replace(SEPARATORS, '');
  if (value.startsWith('+98')) {
    value = `0${value.slice(3)}`;
  } else if (value.startsWith('0098')) {
    value = `0${value.slice(4)}`;
  } else if (value.length === 12 && value.startsWith('98')) {
    value = `0${value.slice(2)}`;
  } else if (value.length === 10 && value.startsWith('9')) {
    value = `0${value}`;
  }
  return IRANIAN_MOBILE_PATTERN.test(value) ? value : null;
}

/** Returns true when `input` normalizes to a valid Iranian mobile number. */
export function isValidIranianMobile(input: string): boolean {
  return normalizeIranianMobile(input) !== null;
}

/** Converts a normalized mobile (`09XXXXXXXXX`) to E.164 (`+989XXXXXXXXX`). */
export function toIranianE164(mobile: string): string {
  const normalized = normalizeIranianMobile(mobile);
  if (normalized === null) {
    throw new TypeError('invalid_iranian_mobile');
  }
  return `+98${normalized.slice(1)}`;
}

/** Zod schema that accepts any common Iranian mobile notation and normalizes it. */
export const IranianMobileString = z.string().transform((value, ctx) => {
  const normalized = normalizeIranianMobile(value);
  if (normalized === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid_iranian_mobile' });
    return value;
  }
  return normalized;
});
