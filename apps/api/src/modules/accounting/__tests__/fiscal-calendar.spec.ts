/** Jalali fiscal calendar: monthly periods, leap years, period 13 rules. */
import { describe, expect, it } from 'vitest';
import {
  assertPeriodAcceptsEntryType,
  buildAdjustmentPeriod,
  findPeriodForDate,
  generateMonthlyPeriods,
  isPostingBlocked,
} from '../periods/fiscal-calendar';

describe('fiscal calendar generation', () => {
  it('generates 12 Jalali monthly periods covering the fiscal year', () => {
    const periods = generateMonthlyPeriods('2025-03-21', '2026-03-20');
    expect(periods).toHaveLength(12);
    expect(periods[0]?.periodNo).toBe(1);
    expect(periods[0]?.startDate).toBe('2025-03-21');
    expect(periods[11]?.endDate).toBe('2026-03-20');
    for (let index = 1; index < periods.length; index += 1) {
      const previous = periods[index - 1];
      const current = periods[index];
      expect((previous?.endDate ?? '') < (current?.startDate ?? '')).toBe(true);
    }
  });

  it('honours leap years (1403 ends on 2025-03-20)', () => {
    const periods = generateMonthlyPeriods('2024-03-20', '2025-03-20');
    expect(periods).toHaveLength(12);
    expect(periods[11]?.startDate).toBe('2025-02-19');
    expect(periods[11]?.endDate).toBe('2025-03-20');
  });

  it('clips a partial first month to the fiscal-year start', () => {
    const periods = generateMonthlyPeriods('2025-04-01', '2026-03-20');
    expect(periods[0]?.startDate).toBe('2025-04-01');
    expect(periods[0]?.periodNo).toBe(1);
  });

  it('rejects an inverted range', () => {
    expect(() => generateMonthlyPeriods('2026-03-20', '2025-03-21')).toThrow();
  });

  it('rejects a range longer than twelve periods', () => {
    expect(() => generateMonthlyPeriods('2024-01-01', '2026-12-31')).toThrow();
  });
});

describe('period 13 and posting guards', () => {
  it('creates a single-day adjustment period', () => {
    expect(buildAdjustmentPeriod('2026-03-20')).toEqual({
      periodNo: 13,
      nameFa: 'دوره تعدیلات پایان سال',
      startDate: '2026-03-20',
      endDate: '2026-03-20',
    });
  });

  it('accepts only adjustment entries in period 13', () => {
    expect(() => assertPeriodAcceptsEntryType(13, 'adjustment')).not.toThrow();
    expect(() => assertPeriodAcceptsEntryType(13, 'normal')).toThrow();
    expect(() => assertPeriodAcceptsEntryType(12, 'normal')).not.toThrow();
  });

  it('blocks posting into closed or locked periods', () => {
    expect(isPostingBlocked('closed')).toBe(true);
    expect(isPostingBlocked('locked')).toBe(true);
    expect(isPostingBlocked('open')).toBe(false);
  });

  it('resolves the owning period by date', () => {
    const periods = generateMonthlyPeriods('2025-03-21', '2026-03-20');
    expect(findPeriodForDate(periods, '2025-03-21')?.periodNo).toBe(1);
    expect(findPeriodForDate(periods, '2026-03-20')?.periodNo).toBe(12);
    expect(findPeriodForDate(periods, '2030-01-01')).toBeUndefined();
  });
});
