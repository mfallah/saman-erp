"use strict";
/**
 * Digit normalization.
 *
 * The API always speaks ASCII digits in JSON (`API.md` §1.8); Persian/Arabic
 * digits are accepted on input from humans (forms, SMS, imports) and normalized
 * at the edge. Rendering Persian digits is a frontend concern.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.toAsciiDigits = toAsciiDigits;
exports.toPersianDigits = toPersianDigits;
exports.toArabicDigits = toArabicDigits;
exports.normalizeDigits = normalizeDigits;
/** Persian (Extended Arabic-Indic) digit range U+06F0..U+06F9. */
const PERSIAN_DIGIT_START = 0x06f0;
/** Arabic-Indic digit range U+0660..U+0669. */
const ARABIC_DIGIT_START = 0x0660;
const NON_ASCII_DIGIT = /[\u06F0-\u06F9\u0660-\u0669]/g;
const ASCII_DIGIT = /[0-9]/g;
/**
 * Converts every Persian/Arabic-Indic digit in `input` to its ASCII equivalent.
 * Non-digit characters are preserved. Safe to call on already-normalized text.
 */
function toAsciiDigits(input) {
    return input.replace(NON_ASCII_DIGIT, (char) => {
        const code = char.charCodeAt(0);
        const base = code >= PERSIAN_DIGIT_START ? PERSIAN_DIGIT_START : ARABIC_DIGIT_START;
        return String.fromCharCode(0x30 + (code - base));
    });
}
/** Converts ASCII digits in `input` to Persian digits. */
function toPersianDigits(input) {
    return input.replace(ASCII_DIGIT, (char) => String.fromCharCode(PERSIAN_DIGIT_START + (char.charCodeAt(0) - 0x30)));
}
/** Converts ASCII digits in `input` to Arabic-Indic digits. */
function toArabicDigits(input) {
    return input.replace(ASCII_DIGIT, (char) => String.fromCharCode(ARABIC_DIGIT_START + (char.charCodeAt(0) - 0x30)));
}
/** Normalizes digits to the requested target script (defaults to ASCII). */
function normalizeDigits(input, target = 'ascii') {
    switch (target) {
        case 'ascii':
            return toAsciiDigits(input);
        case 'persian':
            return toPersianDigits(toAsciiDigits(input));
        case 'arabic':
            return toArabicDigits(toAsciiDigits(input));
        default:
            return input;
    }
}
