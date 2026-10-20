/**
 * Fixed-point quantity arithmetic for inventory (`ADR-0013`).
 *
 * Quantities are `numeric(18,4)`; every internal computation uses a bigint scaled
 * by 10^4 so no float ever touches stock math. Money always stays `bigint` IRR
 * and is rounded only at the defined boundary (ledger line total) with
 * `ROUND_HALF_UP` from `@saman/shared`.
 */
import { roundHalfUp } from '@saman/shared';

export const QUANTITY_SCALE_DIGITS = 4;
export const QUANTITY_SCALE = 10_000n;
const QUANTITY_PATTERN = /^-?\d+(?:\.\d{1,4})?$/;

export type ScaledQuantity = bigint;

export function parseQuantity(value: string): ScaledQuantity {
  const trimmed = value.trim();
  if (!QUANTITY_PATTERN.test(trimmed)) {
    throw new RangeError(`invalid_quantity:${JSON.stringify(value)}`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const dot = unsigned.indexOf('.');
  const whole = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fraction = dot === -1 ? '' : unsigned.slice(dot + 1);
  const padded = `${fraction}0000`.slice(0, QUANTITY_SCALE_DIGITS);
  const scaled = BigInt(whole) * QUANTITY_SCALE + BigInt(padded);
  return negative ? -scaled : scaled;
}

/** Canonical `numeric(18,4)` transport form (`"3.0000"`). */
export function formatQuantity(scaled: ScaledQuantity): string {
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const whole = magnitude / QUANTITY_SCALE;
  const fraction = (magnitude % QUANTITY_SCALE).toString().padStart(QUANTITY_SCALE_DIGITS, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/** Normalizes any accepted decimal string to `numeric(18,4)` form. */
export function normalizeQuantity(value: string): string {
  return formatQuantity(parseQuantity(value));
}

export function addQuantity(left: string, right: string): string {
  return formatQuantity(parseQuantity(left) + parseQuantity(right));
}

export function subQuantity(left: string, right: string): string {
  return formatQuantity(parseQuantity(left) - parseQuantity(right));
}

export function mulQuantity(left: string, right: string): string {
  const product = parseQuantity(left) * parseQuantity(right);
  return formatQuantity(roundHalfUp(product, QUANTITY_SCALE));
}

/** Compares quantities: -1 | 0 | 1. */
export function compareQuantity(left: string, right: string): -1 | 0 | 1 {
  const a = parseQuantity(left);
  const b = parseQuantity(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function isZeroQuantity(value: string): boolean {
  return parseQuantity(value) === 0n;
}

export function isPositiveQuantity(value: string): boolean {
  return parseQuantity(value) > 0n;
}

export function isNegativeQuantity(value: string): boolean {
  return parseQuantity(value) < 0n;
}

export function absQuantity(value: string): string {
  const scaled = parseQuantity(value);
  return formatQuantity(scaled < 0n ? -scaled : scaled);
}

export function minQuantity(left: string, right: string): string {
  return compareQuantity(left, right) <= 0 ? normalizeQuantity(left) : normalizeQuantity(right);
}

export function sumQuantities(values: readonly string[]): string {
  let total = 0n;
  for (const value of values) total += parseQuantity(value);
  return formatQuantity(total);
}

/** Multiplies an IRR unit amount by a quantity, ROUND_HALF_UP to whole rials. */
export function multiplyMoneyByQuantity(unitAmount: bigint, quantity: string): bigint {
  return roundHalfUp(unitAmount * parseQuantity(quantity), QUANTITY_SCALE);
}

/** Unit cost derived from a total (average costing), ROUND_HALF_UP to whole rials. */
export function divideMoneyByQuantity(total: bigint, quantity: string): bigint {
  const scaled = parseQuantity(quantity);
  if (scaled === 0n) {
    throw new RangeError('division_by_zero_quantity');
  }
  return roundHalfUp(total * QUANTITY_SCALE, scaled);
}

/** True when the quantity is a whole number of units (serial/unit tracking). */
export function isWholeQuantity(value: string): boolean {
  return parseQuantity(value) % QUANTITY_SCALE === 0n;
}
