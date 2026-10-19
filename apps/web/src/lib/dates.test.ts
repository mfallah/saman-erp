import { describe, expect, it } from 'vitest';
import {
  addDaysISO,
  formatJalali,
  formatJalaliInput,
  isValidJalali,
  jalaliToISO,
  lastNDaysISO,
  parseJalaliInput,
  relativeTimeFa,
  toJalaliParts,
} from './dates';

describe('Jalali calendar helpers (ADR-0014)', () => {
  it('converts Nowruz boundaries correctly', () => {
    expect(toJalaliParts('2026-03-21')).toEqual({ year: 1405, month: 1, day: 1 });
    expect(jalaliToISO(1405, 1, 1)).toBe('2026-03-21');
    expect(toJalaliParts('2025-03-20')).toEqual({ year: 1403, month: 12, day: 30 });
    expect(jalaliToISO(1403, 12, 30)).toBe('2025-03-20');
  });

  it('round-trips mid-year dates', () => {
    const iso = '2026-07-18';
    const parts = toJalaliParts(iso);
    expect(jalaliToISO(parts.year, parts.month, parts.day)).toBe(iso);
  });

  it('validates Jalali input including leap-year day limits', () => {
    expect(parseJalaliInput('۱۴۰۵/۰۴/۲۷')).toBe('2026-07-18');
    expect(parseJalaliInput('1405-4-7')).toBe(jalaliToISO(1405, 4, 7));
    expect(isValidJalali(1403, 12, 30)).toBe(true);
    expect(isValidJalali(1403, 12, 31)).toBe(false);
    expect(isValidJalali(1404, 13, 1)).toBe(false);
    expect(() => parseJalaliInput('1405/13/01')).toThrow(RangeError);
    expect(() => parseJalaliInput('not-a-date')).toThrow(RangeError);
  });

  it('formats dates in Persian calendar and digits', () => {
    const formatted = formatJalali('2026-03-21');
    expect(formatted).toContain('۱۴۰۵');
    expect(formatJalaliInput('2026-07-18')).toBe('۱۴۰۵/۰۴/۲۷');
  });

  it('builds date ranges and adds days', () => {
    expect(addDaysISO('2026-07-18', 1)).toBe('2026-07-19');
    expect(addDaysISO('2026-07-01', -1)).toBe('2026-06-30');
    const range = lastNDaysISO(7);
    const from = new Date(`${range.from}T00:00:00Z`).getTime();
    const to = new Date(`${range.to}T00:00:00Z`).getTime();
    expect(Math.round((to - from) / 86_400_000)).toBe(6);
  });

  it('renders Persian relative time', () => {
    const result = relativeTimeFa(new Date(Date.now() - 3 * 60_000).toISOString());
    expect(result).toContain('دقیقه');
  });
});
