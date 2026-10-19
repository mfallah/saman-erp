/**
 * Money, quantity and rate arithmetic (`ADR-0013`).
 *
 * Money is **bigint IRR** (integer rials). The only values allowed to carry
 * fractions are quantities (`numeric(18,4)`), unit prices (`numeric(18,4)`) and
 * rates/percentages (`numeric(9,6)`), transported as decimal strings. Floats are
 * never allowed on a money path; all rounding happens here with
 * `ROUND_HALF_UP` at well-defined boundaries.
 */
import { z } from 'zod';

export type Money = bigint;
/** Decimal string with up to 4 fractional digits (quantities, unit prices). */
export type Quantity = string;
/** Decimal string with up to 6 fractional digits (rates, percentages). */
export type Rate = string;

const MONEY_PATTERN = /^-?\d+$/;
const QUANTITY_PATTERN = /^-?\d+(?:\.\d{1,4})?$/;
const RATE_PATTERN = /^-?\d+(?:\.\d{1,6})?$/;

/** Zod schema for an IRR money value transported as a string. */
export const MoneyString = z
  .string()
  .trim()
  .regex(MONEY_PATTERN, { message: 'money_must_be_integer_string' });
export type MoneyString = z.infer<typeof MoneyString>;

/** Zod schema for a `numeric(18,4)` quantity or unit amount. */
export const QuantityString = z
  .string()
  .trim()
  .regex(QUANTITY_PATTERN, { message: 'quantity_must_be_decimal_string' });
export type QuantityString = z.infer<typeof QuantityString>;

/** Zod schema for a `numeric(9,6)` rate (fraction, e.g. `0.090000` = 9%). */
export const RateString = z
  .string()
  .trim()
  .regex(RATE_PATTERN, { message: 'rate_must_be_decimal_string' });
export type RateString = z.infer<typeof RateString>;

/** Zod schema for a `numeric(9,6)` percentage (e.g. `9` = 9%). */
export const PercentString = z
  .string()
  .trim()
  .regex(RATE_PATTERN, { message: 'percent_must_be_decimal_string' });
export type PercentString = z.infer<typeof PercentString>;

interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function parseDecimal(input: string, pattern: RegExp): Rational {
  const value = input.trim();
  if (!pattern.test(value)) {
    throw new TypeError(`invalid_decimal_string:${JSON.stringify(input)}`);
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const dot = unsigned.indexOf('.');
  const whole = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fraction = dot === -1 ? '' : unsigned.slice(dot + 1);
  const digits = `${whole}${fraction}`;
  const denominator = 10n ** BigInt(fraction.length);
  const magnitude = BigInt(digits.length > 0 ? digits : '0');
  return { numerator: negative ? -magnitude : magnitude, denominator };
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * ROUND_HALF_UP division of two integers (`numerator / denominator`), away from
 * zero on exact halves — the Iranian accounting convention.
 */
export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new RangeError('division_by_zero');
  }
  const negative = numerator < 0n !== denominator < 0n;
  const n = absBigInt(numerator);
  const d = absBigInt(denominator);
  let quotient = n / d;
  if ((n % d) * 2n >= d) {
    quotient += 1n;
  }
  return negative ? -quotient : quotient;
}

/** Parses a validated money string into a bigint. */
export function parseMoney(input: MoneyString | string): bigint {
  const value = input.trim();
  if (!MONEY_PATTERN.test(value)) {
    throw new TypeError(`invalid_money_string:${JSON.stringify(input)}`);
  }
  return BigInt(value);
}

/** Formats money as a plain ASCII integer string (JSON transport form). */
export function formatMoney(value: bigint): string {
  return value.toString();
}

/** Formats money with thousands separators, ASCII digits (logs/reports). */
export function formatMoneyGrouped(value: bigint): string {
  const negative = value < 0n;
  const digits = absBigInt(value).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `-${grouped}` : grouped;
}

export function add(left: bigint, right: bigint): bigint {
  return left + right;
}

export function sub(left: bigint, right: bigint): bigint {
  return left - right;
}

export function neg(value: bigint): bigint {
  return -value;
}

export function abs(value: bigint): bigint {
  return absBigInt(value);
}

export function sum(values: readonly bigint[]): bigint {
  let total = 0n;
  for (const value of values) {
    total += value;
  }
  return total;
}

export function isZero(value: bigint): boolean {
  return value === 0n;
}

export function isNegative(value: bigint): boolean {
  return value < 0n;
}

export function compare(left: bigint, right: bigint): -1 | 0 | 1 {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function equals(left: bigint, right: bigint): boolean {
  return left === right;
}

export function min(values: readonly bigint[]): bigint {
  if (values.length === 0) {
    throw new RangeError('empty_values');
  }
  let result = values[0] as bigint;
  for (const value of values) {
    if (value < result) result = value;
  }
  return result;
}

export function max(values: readonly bigint[]): bigint {
  if (values.length === 0) {
    throw new RangeError('empty_values');
  }
  let result = values[0] as bigint;
  for (const value of values) {
    if (value > result) result = value;
  }
  return result;
}

/** Clamps `value` into `[lower, upper]` inclusive. */
export function clamp(value: bigint, lower: bigint, upper: bigint): bigint {
  if (lower > upper) {
    throw new RangeError('invalid_clamp_bounds');
  }
  if (value < lower) return lower;
  if (value > upper) return upper;
  return value;
}

/** Applies a fractional rate to money: `amount * rate`, ROUND_HALF_UP. */
export function applyRate(amount: bigint, rate: RateString | string): bigint {
  const parsed = parseDecimal(rate, RATE_PATTERN);
  return roundHalfUp(amount * parsed.numerator, parsed.denominator);
}

/** Applies a percentage to money: `amount * (percent / 100)`, ROUND_HALF_UP. */
export function applyPercent(amount: bigint, percent: PercentString | string): bigint {
  const parsed = parseDecimal(percent, RATE_PATTERN);
  return roundHalfUp(amount * parsed.numerator, parsed.denominator * 100n);
}

/**
 * Line total: `unitAmount * quantity`, ROUND_HALF_UP to whole rials.
 * `quantity` is a `numeric(18,4)` decimal string.
 */
export function multiplyByQuantity(unitAmount: bigint, quantity: QuantityString | string): bigint {
  const parsed = parseDecimal(quantity, QUANTITY_PATTERN);
  return roundHalfUp(unitAmount * parsed.numerator, parsed.denominator);
}

/** Unit amount derived from a line total: `total / quantity`, ROUND_HALF_UP. */
export function divideByQuantity(total: bigint, quantity: QuantityString | string): bigint {
  const parsed = parseDecimal(quantity, QUANTITY_PATTERN);
  if (parsed.numerator === 0n) {
    throw new RangeError('division_by_zero');
  }
  return roundHalfUp(total * parsed.denominator, parsed.numerator);
}

/** Greatest-remainder allocation of `total` across positive `weights`. */
export function splitProportionally(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) {
    throw new RangeError('empty_weights');
  }
  let weightTotal = 0n;
  for (const weight of weights) {
    if (weight < 0n) {
      throw new RangeError('negative_weight');
    }
    weightTotal += weight;
  }
  if (weightTotal === 0n) {
    throw new RangeError('zero_weight_total');
  }

  const sign = total < 0n ? -1n : 1n;
  const magnitude = absBigInt(total);
  const bases: bigint[] = [];
  const remainders: bigint[] = [];
  let assigned = 0n;
  for (const weight of weights) {
    const exact = magnitude * weight;
    const base = exact / weightTotal;
    bases.push(base);
    remainders.push(exact % weightTotal);
    assigned += base;
  }

  let leftover = magnitude - assigned;
  const order = weights.map((_weight, index) => index);
  order.sort((a, b) => {
    const left = remainders[a] as bigint;
    const right = remainders[b] as bigint;
    if (left === right) return a - b;
    return left > right ? -1 : 1;
  });

  for (const index of order) {
    if (leftover === 0n) break;
    bases[index] = (bases[index] as bigint) + 1n;
    leftover -= 1n;
  }

  return bases.map((base) => base * sign);
}

/** Sum of `amounts`, asserting the result matches `expected` (ledger guard). */
export function assertBalanced(amounts: readonly bigint[], expected = 0n): void {
  const actual = sum(amounts);
  if (actual !== expected) {
    throw new RangeError(`unbalanced:${actual.toString()}`);
  }
}
