import { describe, it } from 'node:test';

import { expect } from './expect';

import {
  MoneyString,
  PercentString,
  QuantityString,
  RateString,
  add,
  applyPercent,
  applyRate,
  assertBalanced,
  clamp,
  compare,
  divideByQuantity,
  equals,
  formatMoney,
  formatMoneyGrouped,
  max,
  min,
  multiplyByQuantity,
  neg,
  parseMoney,
  roundHalfUp,
  splitProportionally,
  sub,
  sum,
} from '../src/money';

describe('money parsing and formatting', () => {
  it('round-trips integer IRR strings', () => {
    expect(parseMoney('12500000')).toBe(12500000n);
    expect(formatMoney(12500000n)).toBe('12500000');
    expect(formatMoney(parseMoney('-42'))).toBe('-42');
  });

  it('rejects non-integer money strings (no floats on money paths)', () => {
    expect(() => parseMoney('12.5')).toThrow(TypeError);
    expect(() => parseMoney('1e3')).toThrow(TypeError);
    expect(() => parseMoney('')).toThrow(TypeError);
    expect(() => parseMoney(' 1 000 ')).toThrow(TypeError);
  });

  it('groups thousands with ASCII digits', () => {
    expect(formatMoneyGrouped(1234567n)).toBe('1,234,567');
    expect(formatMoneyGrouped(-1000n)).toBe('-1,000');
    expect(formatMoneyGrouped(999n)).toBe('999');
  });

  it('validates zod money primitives', () => {
    expect(MoneyString.parse('12500000')).toBe('12500000');
    expect(MoneyString.safeParse('12500000.00').success).toBe(false);
    expect(QuantityString.safeParse('3.0000').success).toBe(true);
    expect(QuantityString.safeParse('3.00001').success).toBe(false);
    expect(QuantityString.safeParse('0').success).toBe(true);
    expect(RateString.safeParse('0.090000').success).toBe(true);
    expect(RateString.safeParse('0.0900001').success).toBe(false);
    expect(PercentString.safeParse('9').success).toBe(true);
  });
});

describe('basic bigint arithmetic', () => {
  it('adds, subtracts and sums without precision loss', () => {
    expect(add(12500000n, 7500000n)).toBe(20000000n);
    expect(sub(12500000n, 7500000n)).toBe(5000000n);
    expect(sum([1n, 2n, 3n])).toBe(6n);
    expect(sum([])).toBe(0n);
    expect(neg(7n)).toBe(-7n);
  });

  it('compares and clamps', () => {
    expect(compare(1n, 2n)).toBe(-1);
    expect(compare(2n, 2n)).toBe(0);
    expect(compare(3n, 2n)).toBe(1);
    expect(equals(5n, 5n)).toBe(true);
    expect(min([3n, 1n, 2n])).toBe(1n);
    expect(max([3n, 1n, 2n])).toBe(3n);
    expect(clamp(15n, 1n, 10n)).toBe(10n);
    expect(clamp(-5n, 0n, 10n)).toBe(0n);
    expect(() => min([])).toThrow(RangeError);
    expect(() => clamp(1n, 5n, 2n)).toThrow(RangeError);
  });

  it('asserts ledger balance', () => {
    expect(() => assertBalanced([10n, -10n])).not.toThrow();
    expect(() => assertBalanced([10n, -9n])).toThrow(RangeError);
  });
});

describe('ROUND_HALF_UP', () => {
  it('rounds exact halves away from zero', () => {
    expect(roundHalfUp(5n, 2n)).toBe(3n);
    expect(roundHalfUp(4n, 2n)).toBe(2n);
    expect(roundHalfUp(-5n, 2n)).toBe(-3n);
    expect(roundHalfUp(1n, 3n)).toBe(0n);
    expect(roundHalfUp(10n, 3n)).toBe(3n);
    expect(() => roundHalfUp(1n, 0n)).toThrow(RangeError);
  });
});

describe('rates and percentages', () => {
  it('applies fractional rates with half-up rounding', () => {
    expect(applyRate(12500000n, '0.090000')).toBe(1125000n);
    expect(applyRate(1000n, '0.075')).toBe(75n);
    expect(applyRate(1n, '0.5')).toBe(1n);
    expect(applyRate(3n, '0.5')).toBe(2n);
    expect(applyRate(-3n, '0.5')).toBe(-2n);
    expect(applyRate(0n, '0.09')).toBe(0n);
  });

  it('applies percentages', () => {
    expect(applyPercent(1000n, '9')).toBe(90n);
    expect(applyPercent(1000n, '7.5')).toBe(75n);
    expect(applyPercent(100n, '33.333333')).toBe(33n);
  });

  it('multiplies and divides by decimal quantities', () => {
    expect(multiplyByQuantity(1250000n, '3.0000')).toBe(3750000n);
    expect(multiplyByQuantity(100n, '0.3333')).toBe(33n);
    expect(multiplyByQuantity(100n, '0.3350')).toBe(34n);
    expect(divideByQuantity(3750000n, '3.0000')).toBe(1250000n);
    expect(() => divideByQuantity(1n, '0')).toThrow(RangeError);
  });
});

describe('splitProportionally (largest remainder)', () => {
  it('allocates without losing a rial', () => {
    expect(splitProportionally(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(splitProportionally(100n, [1n, 2n])).toEqual([33n, 67n]);
    expect(splitProportionally(0n, [1n, 2n])).toEqual([0n, 0n]);
    expect(sum(splitProportionally(12345n, [7n, 11n, 13n]))).toBe(12345n);
  });

  it('handles negative totals and deterministic ties', () => {
    expect(splitProportionally(-100n, [1n, 1n, 1n])).toEqual([-34n, -33n, -33n]);
    expect(splitProportionally(5n, [1n, 1n, 1n, 1n, 1n])).toEqual([1n, 1n, 1n, 1n, 1n]);
    expect(splitProportionally(2n, [1n, 1n, 1n])).toEqual([1n, 1n, 0n]);
  });

  it('rejects invalid weights', () => {
    expect(() => splitProportionally(100n, [])).toThrow(RangeError);
    expect(() => splitProportionally(100n, [0n, 0n])).toThrow(RangeError);
    expect(() => splitProportionally(100n, [1n, -1n])).toThrow(RangeError);
  });
});
