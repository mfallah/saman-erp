import { describe, expect, it } from 'vitest';
import {
  addMoney,
  formatMoney,
  formatNumber,
  formatPercent,
  formatQuantity,
  MoneyParseError,
  multiplyByRate,
  parseMoney,
  subtractMoney,
  sumMoney,
  toLatinDigits,
  toPersianDigits,
} from './money';

describe('money parsing and formatting (ADR-0013)', () => {
  it('formats rial with Persian grouping and digits', () => {
    expect(formatMoney('12500000')).toBe('۱۲٬۵۰۰٬۰۰۰ ریال');
    expect(formatMoney(0)).toBe('۰ ریال');
    expect(formatMoney('1500', { unit: '' })).toBe('۱٬۵۰۰');
  });

  it('formats negative and signed values', () => {
    expect(formatMoney('-1500', { unit: '' })).toBe('\u2212۱٬۵۰۰');
    expect(formatMoney('2500', { unit: '', signed: true })).toBe('+۲٬۵۰۰');
  });

  it('parses Persian/Arabic digits and separators exactly', () => {
    expect(parseMoney('۱۲٬۵۰۰٬۰۰۰')).toBe(12_500_000n);
    expect(parseMoney('1,234')).toBe(1_234n);
    expect(parseMoney(' ۲۵۰ ')).toBe(250n);
    expect(parseMoney(999)).toBe(999n);
    expect(parseMoney(10n)).toBe(10n);
    expect(() => parseMoney('12.5')).toThrow(MoneyParseError);
    expect(() => parseMoney('abc')).toThrow(MoneyParseError);
  });

  it('round-trips digits', () => {
    expect(toLatinDigits('۱۲۳۴۵۶۷۸۹۰')).toBe('1234567890');
    expect(toPersianDigits('1234567890')).toBe('۱۲۳۴۵۶۷۸۹۰');
  });

  it('does arithmetic with bigint (never floats)', () => {
    expect(addMoney('9007199254740993', '2')).toBe(9_007_199_254_740_995n);
    expect(subtractMoney('1000', '250')).toBe(750n);
    expect(sumMoney(['1', '۲', '3'])).toBe(6n);
  });

  it('applies decimal rates with ROUND_HALF_UP', () => {
    expect(multiplyByRate('1000', '0.09')).toBe(90n);
    expect(multiplyByRate('1000', '0.095')).toBe(95n);
    expect(multiplyByRate('1', '0.5')).toBe(1n);
    expect(multiplyByRate('2', '0.25')).toBe(1n);
    expect(multiplyByRate('-1', '0.5')).toBe(-1n);
    expect(multiplyByRate('1000000', '0.000001')).toBe(1n);
  });

  it('formats quantities, counts and percentages', () => {
    expect(formatQuantity('3.5000')).toContain('٫');
    expect(formatNumber(12345)).toBe('۱۲٬۳۴۵');
    expect(formatPercent('0.09')).toContain('۹');
  });
});
