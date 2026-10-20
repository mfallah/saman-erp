"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IranianMobileString = exports.IRANIAN_MOBILE_PATTERN = void 0;
exports.normalizeIranianMobile = normalizeIranianMobile;
exports.isValidIranianMobile = isValidIranianMobile;
exports.toIranianE164 = toIranianE164;
/**
 * Iranian mobile number normalization (`API.md` §4.1 identity, SMS providers).
 *
 * Canonical internal form is the national `09XXXXXXXXX` form. Channel/provider
 * payloads may carry `+98...`, `0098...`, `98...` or bare `9XXXXXXXXX`; all are
 * normalized before persistence, hashing, deduplication or rate limiting.
 */
const zod_1 = require("zod");
const digits_1 = require("./digits");
/** National Iranian mobile form: 09 + 9 digits. */
exports.IRANIAN_MOBILE_PATTERN = /^09\d{9}$/;
const SEPARATORS = /[\s\-().]/g;
/**
 * Normalizes an Iranian mobile number to `09XXXXXXXXX`.
 * Returns `null` when the value cannot be a valid Iranian mobile number.
 */
function normalizeIranianMobile(input) {
    let value = (0, digits_1.toAsciiDigits)(input).replace(SEPARATORS, '');
    if (value.startsWith('+98')) {
        value = `0${value.slice(3)}`;
    }
    else if (value.startsWith('0098')) {
        value = `0${value.slice(4)}`;
    }
    else if (value.length === 12 && value.startsWith('98')) {
        value = `0${value.slice(2)}`;
    }
    else if (value.length === 10 && value.startsWith('9')) {
        value = `0${value}`;
    }
    return exports.IRANIAN_MOBILE_PATTERN.test(value) ? value : null;
}
/** Returns true when `input` normalizes to a valid Iranian mobile number. */
function isValidIranianMobile(input) {
    return normalizeIranianMobile(input) !== null;
}
/** Converts a normalized mobile (`09XXXXXXXXX`) to E.164 (`+989XXXXXXXXX`). */
function toIranianE164(mobile) {
    const normalized = normalizeIranianMobile(mobile);
    if (normalized === null) {
        throw new TypeError('invalid_iranian_mobile');
    }
    return `+98${normalized.slice(1)}`;
}
/** Zod schema that accepts any common Iranian mobile notation and normalizes it. */
exports.IranianMobileString = zod_1.z.string().transform((value, ctx) => {
    const normalized = normalizeIranianMobile(value);
    if (normalized === null) {
        ctx.addIssue({ code: zod_1.z.ZodIssueCode.custom, message: 'invalid_iranian_mobile' });
        return value;
    }
    return normalized;
});
