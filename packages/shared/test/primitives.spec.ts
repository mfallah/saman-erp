import { describe, expect, it } from 'vitest';

import { isInVocabulary, ORDER_STATUSES, DOCUMENT_STATUSES } from '../src/enums';
import { toArabicDigits, toAsciiDigits, toPersianDigits, normalizeDigits } from '../src/digits';
import { IranianMobileString, isValidIranianMobile, normalizeIranianMobile, toIranianE164 } from '../src/phone';

describe('digit normalization', () => {
  it('normalizes Persian and Arabic digits to ASCII', () => {
    expect(toAsciiDigits('۱۲۳۴۵۶۷۸۹۰')).toBe('1234567890');
    expect(toAsciiDigits('١٢٣٤٥٦٧٨٩٠')).toBe('1234567890');
    expect(toAsciiDigits('کد ۱۲۳')).toBe('کد 123');
    expect(toAsciiDigits('already 123')).toBe('already 123');
  });

  it('renders Persian/Arabic digits and round-trips', () => {
    expect(toPersianDigits('2025')).toBe('۲۰۲۵');
    expect(toArabicDigits('2025')).toBe('٢٠٢٥');
    expect(toAsciiDigits(toPersianDigits('1403/07/27'))).toBe('1403/07/27');
    expect(normalizeDigits('١٢۳', 'persian')).toBe('۱۲۳');
  });
});

describe('Iranian mobile normalization', () => {
  const valid = [
    ['09123456789', '09123456789'],
    ['+989123456789', '09123456789'],
    ['00989123456789', '09123456789'],
    ['989123456789', '09123456789'],
    ['9123456789', '09123456789'],
    ['0912 345 6789', '09123456789'],
    ['0912-345-6789', '09123456789'],
    ['۰۹۱۲۳۴۵۶۷۸۹', '09123456789'],
  ] as const;

  it.each(valid)('normalizes %s to %s', (input, expected) => {
    expect(normalizeIranianMobile(input)).toBe(expected);
    expect(isValidIranianMobile(input)).toBe(true);
  });

  it('rejects invalid numbers', () => {
    expect(normalizeIranianMobile('08123456789')).toBeNull();
    expect(normalizeIranianMobile('0912345678')).toBeNull();
    expect(normalizeIranianMobile('091234567890')).toBeNull();
    expect(normalizeIranianMobile('not-a-phone')).toBeNull();
  });

  it('converts to E.164', () => {
    expect(toIranianE164('09123456789')).toBe('+989123456789');
    expect(() => toIranianE164('123')).toThrow(TypeError);
  });

  it('walks through the zod schema', () => {
    expect(IranianMobileString.parse('+98 912 345 6789')).toBe('09123456789');
    expect(IranianMobileString.safeParse('12345').success).toBe(false);
  });
});

describe('status vocabularies', () => {
  it('keeps order status tokens of the contract', () => {
    expect(ORDER_STATUSES).toContain('confirmed');
    expect(ORDER_STATUSES).toContain('packed');
    expect(ORDER_STATUSES).not.toContain('unknown');
    expect(DOCUMENT_STATUSES).toEqual(['draft', 'pending_approval', 'approved', 'posted', 'voided']);
  });

  it('narrows values at runtime', () => {
    expect(isInVocabulary(ORDER_STATUSES, 'shipped')).toBe(true);
    expect(isInVocabulary(ORDER_STATUSES, 'nope')).toBe(false);
  });
});
