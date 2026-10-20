"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const expect_1 = require("./expect");
const money_1 = require("../src/money");
(0, node_test_1.describe)('money parsing and formatting', () => {
    (0, node_test_1.it)('round-trips integer IRR strings', () => {
        (0, expect_1.expect)((0, money_1.parseMoney)('12500000')).toBe(12500000n);
        (0, expect_1.expect)((0, money_1.formatMoney)(12500000n)).toBe('12500000');
        (0, expect_1.expect)((0, money_1.formatMoney)((0, money_1.parseMoney)('-42'))).toBe('-42');
    });
    (0, node_test_1.it)('rejects non-integer money strings (no floats on money paths)', () => {
        (0, expect_1.expect)(() => (0, money_1.parseMoney)('12.5')).toThrow(TypeError);
        (0, expect_1.expect)(() => (0, money_1.parseMoney)('1e3')).toThrow(TypeError);
        (0, expect_1.expect)(() => (0, money_1.parseMoney)('')).toThrow(TypeError);
        (0, expect_1.expect)(() => (0, money_1.parseMoney)(' 1 000 ')).toThrow(TypeError);
    });
    (0, node_test_1.it)('groups thousands with ASCII digits', () => {
        (0, expect_1.expect)((0, money_1.formatMoneyGrouped)(1234567n)).toBe('1,234,567');
        (0, expect_1.expect)((0, money_1.formatMoneyGrouped)(-1000n)).toBe('-1,000');
        (0, expect_1.expect)((0, money_1.formatMoneyGrouped)(999n)).toBe('999');
    });
    (0, node_test_1.it)('validates zod money primitives', () => {
        (0, expect_1.expect)(money_1.MoneyString.parse('12500000')).toBe('12500000');
        (0, expect_1.expect)(money_1.MoneyString.safeParse('12500000.00').success).toBe(false);
        (0, expect_1.expect)(money_1.QuantityString.safeParse('3.0000').success).toBe(true);
        (0, expect_1.expect)(money_1.QuantityString.safeParse('3.00001').success).toBe(false);
        (0, expect_1.expect)(money_1.QuantityString.safeParse('0').success).toBe(true);
        (0, expect_1.expect)(money_1.RateString.safeParse('0.090000').success).toBe(true);
        (0, expect_1.expect)(money_1.RateString.safeParse('0.0900001').success).toBe(false);
        (0, expect_1.expect)(money_1.PercentString.safeParse('9').success).toBe(true);
    });
});
(0, node_test_1.describe)('basic bigint arithmetic', () => {
    (0, node_test_1.it)('adds, subtracts and sums without precision loss', () => {
        (0, expect_1.expect)((0, money_1.add)(12500000n, 7500000n)).toBe(20000000n);
        (0, expect_1.expect)((0, money_1.sub)(12500000n, 7500000n)).toBe(5000000n);
        (0, expect_1.expect)((0, money_1.sum)([1n, 2n, 3n])).toBe(6n);
        (0, expect_1.expect)((0, money_1.sum)([])).toBe(0n);
        (0, expect_1.expect)((0, money_1.neg)(7n)).toBe(-7n);
    });
    (0, node_test_1.it)('compares and clamps', () => {
        (0, expect_1.expect)((0, money_1.compare)(1n, 2n)).toBe(-1);
        (0, expect_1.expect)((0, money_1.compare)(2n, 2n)).toBe(0);
        (0, expect_1.expect)((0, money_1.compare)(3n, 2n)).toBe(1);
        (0, expect_1.expect)((0, money_1.equals)(5n, 5n)).toBe(true);
        (0, expect_1.expect)((0, money_1.min)([3n, 1n, 2n])).toBe(1n);
        (0, expect_1.expect)((0, money_1.max)([3n, 1n, 2n])).toBe(3n);
        (0, expect_1.expect)((0, money_1.clamp)(15n, 1n, 10n)).toBe(10n);
        (0, expect_1.expect)((0, money_1.clamp)(-5n, 0n, 10n)).toBe(0n);
        (0, expect_1.expect)(() => (0, money_1.min)([])).toThrow(RangeError);
        (0, expect_1.expect)(() => (0, money_1.clamp)(1n, 5n, 2n)).toThrow(RangeError);
    });
    (0, node_test_1.it)('asserts ledger balance', () => {
        (0, expect_1.expect)(() => (0, money_1.assertBalanced)([10n, -10n])).not.toThrow();
        (0, expect_1.expect)(() => (0, money_1.assertBalanced)([10n, -9n])).toThrow(RangeError);
    });
});
(0, node_test_1.describe)('ROUND_HALF_UP', () => {
    (0, node_test_1.it)('rounds exact halves away from zero', () => {
        (0, expect_1.expect)((0, money_1.roundHalfUp)(5n, 2n)).toBe(3n);
        (0, expect_1.expect)((0, money_1.roundHalfUp)(4n, 2n)).toBe(2n);
        (0, expect_1.expect)((0, money_1.roundHalfUp)(-5n, 2n)).toBe(-3n);
        (0, expect_1.expect)((0, money_1.roundHalfUp)(1n, 3n)).toBe(0n);
        (0, expect_1.expect)((0, money_1.roundHalfUp)(10n, 3n)).toBe(3n);
        (0, expect_1.expect)(() => (0, money_1.roundHalfUp)(1n, 0n)).toThrow(RangeError);
    });
});
(0, node_test_1.describe)('rates and percentages', () => {
    (0, node_test_1.it)('applies fractional rates with half-up rounding', () => {
        (0, expect_1.expect)((0, money_1.applyRate)(12500000n, '0.090000')).toBe(1125000n);
        (0, expect_1.expect)((0, money_1.applyRate)(1000n, '0.075')).toBe(75n);
        (0, expect_1.expect)((0, money_1.applyRate)(1n, '0.5')).toBe(1n);
        (0, expect_1.expect)((0, money_1.applyRate)(3n, '0.5')).toBe(2n);
        (0, expect_1.expect)((0, money_1.applyRate)(-3n, '0.5')).toBe(-2n);
        (0, expect_1.expect)((0, money_1.applyRate)(0n, '0.09')).toBe(0n);
    });
    (0, node_test_1.it)('applies percentages', () => {
        (0, expect_1.expect)((0, money_1.applyPercent)(1000n, '9')).toBe(90n);
        (0, expect_1.expect)((0, money_1.applyPercent)(1000n, '7.5')).toBe(75n);
        (0, expect_1.expect)((0, money_1.applyPercent)(100n, '33.333333')).toBe(33n);
    });
    (0, node_test_1.it)('multiplies and divides by decimal quantities', () => {
        (0, expect_1.expect)((0, money_1.multiplyByQuantity)(1250000n, '3.0000')).toBe(3750000n);
        (0, expect_1.expect)((0, money_1.multiplyByQuantity)(100n, '0.3333')).toBe(33n);
        (0, expect_1.expect)((0, money_1.multiplyByQuantity)(100n, '0.3350')).toBe(34n);
        (0, expect_1.expect)((0, money_1.divideByQuantity)(3750000n, '3.0000')).toBe(1250000n);
        (0, expect_1.expect)(() => (0, money_1.divideByQuantity)(1n, '0')).toThrow(RangeError);
    });
});
(0, node_test_1.describe)('splitProportionally (largest remainder)', () => {
    (0, node_test_1.it)('allocates without losing a rial', () => {
        (0, expect_1.expect)((0, money_1.splitProportionally)(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
        (0, expect_1.expect)((0, money_1.splitProportionally)(100n, [1n, 2n])).toEqual([33n, 67n]);
        (0, expect_1.expect)((0, money_1.splitProportionally)(0n, [1n, 2n])).toEqual([0n, 0n]);
        (0, expect_1.expect)((0, money_1.sum)((0, money_1.splitProportionally)(12345n, [7n, 11n, 13n]))).toBe(12345n);
    });
    (0, node_test_1.it)('handles negative totals and deterministic ties', () => {
        (0, expect_1.expect)((0, money_1.splitProportionally)(-100n, [1n, 1n, 1n])).toEqual([-34n, -33n, -33n]);
        (0, expect_1.expect)((0, money_1.splitProportionally)(5n, [1n, 1n, 1n, 1n, 1n])).toEqual([1n, 1n, 1n, 1n, 1n]);
        (0, expect_1.expect)((0, money_1.splitProportionally)(2n, [1n, 1n, 1n])).toEqual([1n, 1n, 0n]);
    });
    (0, node_test_1.it)('rejects invalid weights', () => {
        (0, expect_1.expect)(() => (0, money_1.splitProportionally)(100n, [])).toThrow(RangeError);
        (0, expect_1.expect)(() => (0, money_1.splitProportionally)(100n, [0n, 0n])).toThrow(RangeError);
        (0, expect_1.expect)(() => (0, money_1.splitProportionally)(100n, [1n, -1n])).toThrow(RangeError);
    });
});
