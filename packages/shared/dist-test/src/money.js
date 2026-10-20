"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PercentString = exports.RateString = exports.QuantityString = exports.MoneyString = void 0;
exports.roundHalfUp = roundHalfUp;
exports.parseMoney = parseMoney;
exports.formatMoney = formatMoney;
exports.formatMoneyGrouped = formatMoneyGrouped;
exports.add = add;
exports.sub = sub;
exports.neg = neg;
exports.abs = abs;
exports.sum = sum;
exports.isZero = isZero;
exports.isNegative = isNegative;
exports.compare = compare;
exports.equals = equals;
exports.min = min;
exports.max = max;
exports.clamp = clamp;
exports.applyRate = applyRate;
exports.applyPercent = applyPercent;
exports.multiplyByQuantity = multiplyByQuantity;
exports.divideByQuantity = divideByQuantity;
exports.splitProportionally = splitProportionally;
exports.assertBalanced = assertBalanced;
/**
 * Money, quantity and rate arithmetic (`ADR-0013`).
 *
 * Money is **bigint IRR** (integer rials). The only values allowed to carry
 * fractions are quantities (`numeric(18,4)`), unit prices (`numeric(18,4)`) and
 * rates/percentages (`numeric(9,6)`), transported as decimal strings. Floats are
 * never allowed on a money path; all rounding happens here with
 * `ROUND_HALF_UP` at well-defined boundaries.
 */
const zod_1 = require("zod");
const MONEY_PATTERN = /^-?\d+$/;
const QUANTITY_PATTERN = /^-?\d+(?:\.\d{1,4})?$/;
const RATE_PATTERN = /^-?\d+(?:\.\d{1,6})?$/;
/** Zod schema for an IRR money value transported as a string. */
exports.MoneyString = zod_1.z
    .string()
    .trim()
    .regex(MONEY_PATTERN, { message: 'money_must_be_integer_string' });
/** Zod schema for a `numeric(18,4)` quantity or unit amount. */
exports.QuantityString = zod_1.z
    .string()
    .trim()
    .regex(QUANTITY_PATTERN, { message: 'quantity_must_be_decimal_string' });
/** Zod schema for a `numeric(9,6)` rate (fraction, e.g. `0.090000` = 9%). */
exports.RateString = zod_1.z
    .string()
    .trim()
    .regex(RATE_PATTERN, { message: 'rate_must_be_decimal_string' });
/** Zod schema for a `numeric(9,6)` percentage (e.g. `9` = 9%). */
exports.PercentString = zod_1.z
    .string()
    .trim()
    .regex(RATE_PATTERN, { message: 'percent_must_be_decimal_string' });
function parseDecimal(input, pattern) {
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
function absBigInt(value) {
    return value < 0n ? -value : value;
}
/**
 * ROUND_HALF_UP division of two integers (`numerator / denominator`), away from
 * zero on exact halves — the Iranian accounting convention.
 */
function roundHalfUp(numerator, denominator) {
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
function parseMoney(input) {
    const value = input.trim();
    if (!MONEY_PATTERN.test(value)) {
        throw new TypeError(`invalid_money_string:${JSON.stringify(input)}`);
    }
    return BigInt(value);
}
/** Formats money as a plain ASCII integer string (JSON transport form). */
function formatMoney(value) {
    return value.toString();
}
/** Formats money with thousands separators, ASCII digits (logs/reports). */
function formatMoneyGrouped(value) {
    const negative = value < 0n;
    const digits = absBigInt(value).toString();
    const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return negative ? `-${grouped}` : grouped;
}
function add(left, right) {
    return left + right;
}
function sub(left, right) {
    return left - right;
}
function neg(value) {
    return -value;
}
function abs(value) {
    return absBigInt(value);
}
function sum(values) {
    let total = 0n;
    for (const value of values) {
        total += value;
    }
    return total;
}
function isZero(value) {
    return value === 0n;
}
function isNegative(value) {
    return value < 0n;
}
function compare(left, right) {
    if (left < right)
        return -1;
    if (left > right)
        return 1;
    return 0;
}
function equals(left, right) {
    return left === right;
}
function min(values) {
    if (values.length === 0) {
        throw new RangeError('empty_values');
    }
    let result = values[0];
    for (const value of values) {
        if (value < result)
            result = value;
    }
    return result;
}
function max(values) {
    if (values.length === 0) {
        throw new RangeError('empty_values');
    }
    let result = values[0];
    for (const value of values) {
        if (value > result)
            result = value;
    }
    return result;
}
/** Clamps `value` into `[lower, upper]` inclusive. */
function clamp(value, lower, upper) {
    if (lower > upper) {
        throw new RangeError('invalid_clamp_bounds');
    }
    if (value < lower)
        return lower;
    if (value > upper)
        return upper;
    return value;
}
/** Applies a fractional rate to money: `amount * rate`, ROUND_HALF_UP. */
function applyRate(amount, rate) {
    const parsed = parseDecimal(rate, RATE_PATTERN);
    return roundHalfUp(amount * parsed.numerator, parsed.denominator);
}
/** Applies a percentage to money: `amount * (percent / 100)`, ROUND_HALF_UP. */
function applyPercent(amount, percent) {
    const parsed = parseDecimal(percent, RATE_PATTERN);
    return roundHalfUp(amount * parsed.numerator, parsed.denominator * 100n);
}
/**
 * Line total: `unitAmount * quantity`, ROUND_HALF_UP to whole rials.
 * `quantity` is a `numeric(18,4)` decimal string.
 */
function multiplyByQuantity(unitAmount, quantity) {
    const parsed = parseDecimal(quantity, QUANTITY_PATTERN);
    return roundHalfUp(unitAmount * parsed.numerator, parsed.denominator);
}
/** Unit amount derived from a line total: `total / quantity`, ROUND_HALF_UP. */
function divideByQuantity(total, quantity) {
    const parsed = parseDecimal(quantity, QUANTITY_PATTERN);
    if (parsed.numerator === 0n) {
        throw new RangeError('division_by_zero');
    }
    return roundHalfUp(total * parsed.denominator, parsed.numerator);
}
/** Greatest-remainder allocation of `total` across positive `weights`. */
function splitProportionally(total, weights) {
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
    const bases = [];
    const remainders = [];
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
        const left = remainders[a];
        const right = remainders[b];
        if (left === right)
            return a - b;
        return left > right ? -1 : 1;
    });
    for (const index of order) {
        if (leftover === 0n)
            break;
        bases[index] = bases[index] + 1n;
        leftover -= 1n;
    }
    return bases.map((base) => base * sign);
}
/** Sum of `amounts`, asserting the result matches `expected` (ledger guard). */
function assertBalanced(amounts, expected = 0n) {
    const actual = sum(amounts);
    if (actual !== expected) {
        throw new RangeError(`unbalanced:${actual.toString()}`);
    }
}
