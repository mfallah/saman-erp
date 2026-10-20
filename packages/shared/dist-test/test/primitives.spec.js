"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const expect_1 = require("./expect");
const enums_1 = require("../src/enums");
const digits_1 = require("../src/digits");
const phone_1 = require("../src/phone");
(0, node_test_1.describe)('digit normalization', () => {
    (0, node_test_1.it)('normalizes Persian and Arabic digits to ASCII', () => {
        (0, expect_1.expect)((0, digits_1.toAsciiDigits)('۱۲۳۴۵۶۷۸۹۰')).toBe('1234567890');
        (0, expect_1.expect)((0, digits_1.toAsciiDigits)('١٢٣٤٥٦٧٨٩٠')).toBe('1234567890');
        (0, expect_1.expect)((0, digits_1.toAsciiDigits)('کد ۱۲۳')).toBe('کد 123');
        (0, expect_1.expect)((0, digits_1.toAsciiDigits)('already 123')).toBe('already 123');
    });
    (0, node_test_1.it)('renders Persian/Arabic digits and round-trips', () => {
        (0, expect_1.expect)((0, digits_1.toPersianDigits)('2025')).toBe('۲۰۲۵');
        (0, expect_1.expect)((0, digits_1.toArabicDigits)('2025')).toBe('٢٠٢٥');
        (0, expect_1.expect)((0, digits_1.toAsciiDigits)((0, digits_1.toPersianDigits)('1403/07/27'))).toBe('1403/07/27');
        (0, expect_1.expect)((0, digits_1.normalizeDigits)('١٢۳', 'persian')).toBe('۱۲۳');
    });
});
(0, node_test_1.describe)('Iranian mobile normalization', () => {
    const valid = [
        ['09123456789', '09123456789'],
        ['+989123456789', '09123456789'],
        ['00989123456789', '09123456789'],
        ['989123456789', '09123456789'],
        ['9123456789', '09123456789'],
        ['0912 345 6789', '09123456789'],
        ['0912-345-6789', '09123456789'],
        ['۰۹۱۲۳۴۵۶۷۸۹', '09123456789'],
    ];
    (0, node_test_1.it)('normalizes all supported notations', () => {
        for (const [input, expected] of valid) {
            (0, expect_1.expect)((0, phone_1.normalizeIranianMobile)(input)).toBe(expected);
            (0, expect_1.expect)((0, phone_1.isValidIranianMobile)(input)).toBe(true);
        }
    });
    (0, node_test_1.it)('rejects invalid numbers', () => {
        (0, expect_1.expect)((0, phone_1.normalizeIranianMobile)('08123456789')).toBeNull();
        (0, expect_1.expect)((0, phone_1.normalizeIranianMobile)('0912345678')).toBeNull();
        (0, expect_1.expect)((0, phone_1.normalizeIranianMobile)('091234567890')).toBeNull();
        (0, expect_1.expect)((0, phone_1.normalizeIranianMobile)('not-a-phone')).toBeNull();
    });
    (0, node_test_1.it)('converts to E.164', () => {
        (0, expect_1.expect)((0, phone_1.toIranianE164)('09123456789')).toBe('+989123456789');
        (0, expect_1.expect)(() => (0, phone_1.toIranianE164)('123')).toThrow(TypeError);
    });
    (0, node_test_1.it)('walks through the zod schema', () => {
        (0, expect_1.expect)(phone_1.IranianMobileString.parse('+98 912 345 6789')).toBe('09123456789');
        (0, expect_1.expect)(phone_1.IranianMobileString.safeParse('12345').success).toBe(false);
    });
});
(0, node_test_1.describe)('status vocabularies', () => {
    (0, node_test_1.it)('keeps order status tokens of the contract', () => {
        (0, expect_1.expect)(enums_1.ORDER_STATUSES).toContain('confirmed');
        (0, expect_1.expect)(enums_1.ORDER_STATUSES).toContain('packed');
        (0, expect_1.expect)(enums_1.ORDER_STATUSES).not.toContain('unknown');
        (0, expect_1.expect)(enums_1.DOCUMENT_STATUSES).toEqual(['draft', 'pending_approval', 'approved', 'posted', 'voided']);
    });
    (0, node_test_1.it)('narrows values at runtime', () => {
        (0, expect_1.expect)((0, enums_1.isInVocabulary)(enums_1.ORDER_STATUSES, 'shipped')).toBe(true);
        (0, expect_1.expect)((0, enums_1.isInVocabulary)(enums_1.ORDER_STATUSES, 'nope')).toBe(false);
    });
});
