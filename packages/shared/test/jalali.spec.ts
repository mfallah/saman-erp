import { describe, it } from 'node:test';

import { expect } from './expect';

import {
  JALALI_MONTH_NAMES,
  addJalaliDays,
  compareJalaliDates,
  daysBetweenJalali,
  endOfJalaliMonth,
  formatJalaliDate,
  gregorianToJalali,
  isJalaliLeapYear,
  isoToJalali,
  jalaliMonthLength,
  jalaliMonthName,
  jalaliMonthRange,
  jalaliToGregorian,
  jalaliToIso,
  jalaliYearRange,
  parseJalaliDate,
  startOfJalaliMonth,
} from '../src/jalali';

const PERSIAN_DATE_FORMAT = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  timeZone: 'UTC',
});

/** Independent oracle: ICU Persian calendar (validates the pure algorithm). */
function intlJalali(iso: string): { jy: number; jm: number; jd: number } {
  const parts = PERSIAN_DATE_FORMAT.formatToParts(new Date(`${iso}T00:00:00Z`));
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? Number.NaN : Number(part.value);
  };
  return { jy: value('year'), jm: value('month'), jd: value('day') };
}

describe('known Jalali/Gregorian boundaries', () => {
  const cases: ReadonlyArray<[number, number, number, string]> = [
    [1403, 1, 1, '2024-03-20'],
    [1403, 12, 30, '2025-03-20'],
    [1404, 1, 1, '2025-03-21'],
    [1404, 12, 29, '2026-03-20'],
    [1405, 1, 1, '2026-03-21'],
    [1402, 1, 1, '2023-03-21'],
    [1402, 12, 29, '2024-03-19'],
    [1399, 12, 30, '2021-03-20'],
    [1399, 1, 1, '2020-03-20'],
    [1398, 1, 1, '2019-03-21'],
  ];

  it('converts known boundary dates in both directions', () => {
    for (const [jy, jm, jd, iso] of cases) {
      expect(jalaliToIso({ jy, jm, jd })).toBe(iso);
      expect(isoToJalali(iso)).toEqual({ jy, jm, jd });
      const gregorian = jalaliToGregorian(jy, jm, jd);
      expect(gregorianToJalali(gregorian.gy, gregorian.gm, gregorian.gd)).toEqual({ jy, jm, jd });
    }
  });
});

describe('leap years', () => {
  it('matches the Iranian 33-year cycle for 1390..1420', () => {
    const expectedLeapYears = [1391, 1395, 1399, 1403, 1408, 1412, 1416, 1420];
    for (let jy = 1390; jy <= 1420; jy += 1) {
      expect(isJalaliLeapYear(jy)).toBe(expectedLeapYears.includes(jy));
    }
  });

  it('uses 30 days for Esfand in leap years only', () => {
    expect(jalaliMonthLength(1403, 12)).toBe(30);
    expect(jalaliMonthLength(1404, 12)).toBe(29);
    expect(jalaliMonthLength(1405, 12)).toBe(29);
    expect(jalaliMonthLength(1408, 12)).toBe(30);
  });

  it('has six 31-day months then five 30-day months', () => {
    for (let jm = 1; jm <= 6; jm += 1) expect(jalaliMonthLength(1404, jm)).toBe(31);
    for (let jm = 7; jm <= 11; jm += 1) expect(jalaliMonthLength(1404, jm)).toBe(30);
  });
});

describe('ICU oracle cross-check', () => {
  it('agrees with Intl for every day from 2019-01-01 to 2035-12-31', () => {
    const start = Date.UTC(2019, 0, 1);
    const end = Date.UTC(2035, 11, 31);
    for (let time = start; time <= end; time += 86_400_000) {
      const date = new Date(time);
      const iso = date.toISOString().slice(0, 10);
      const expected = intlJalali(iso);
      expect(isoToJalali(iso)).toEqual(expected);
      expect(jalaliToIso(expected)).toBe(iso);
    }
  });
});

describe('parsing and formatting', () => {
  it('parses and formats YYYY/MM/DD', () => {
    expect(parseJalaliDate('1405/07/27')).toEqual({ jy: 1405, jm: 7, jd: 27 });
    expect(parseJalaliDate('1405-07-27')).toEqual({ jy: 1405, jm: 7, jd: 27 });
    expect(formatJalaliDate({ jy: 1405, jm: 7, jd: 27 })).toBe('1405/07/27');
    expect(formatJalaliDate({ jy: 1403, jm: 12, jd: 30 }, '-')).toBe('1403-12-30');
  });

  it('rejects invalid Jalali dates', () => {
    expect(() => parseJalaliDate('1404/12/30')).toThrow(RangeError);
    expect(() => parseJalaliDate('1404/13/01')).toThrow(RangeError);
    expect(() => parseJalaliDate('1404/00/10')).toThrow(RangeError);
    expect(() => parseJalaliDate('not-a-date')).toThrow(RangeError);
    expect(() => formatJalaliDate({ jy: 1405, jm: 6, jd: 31 })).not.toThrow();
    expect(() => formatJalaliDate({ jy: 1405, jm: 7, jd: 31 })).toThrow(RangeError);
  });

  it('exposes Persian month names', () => {
    expect(JALALI_MONTH_NAMES).toHaveLength(12);
    expect(jalaliMonthName(1)).toBe('فروردین');
    expect(jalaliMonthName(12)).toBe('اسفند');
    expect(() => jalaliMonthName(0)).toThrow(RangeError);
  });
});

describe('month and day arithmetic', () => {
  it('adds days across month and year boundaries', () => {
    expect(addJalaliDays({ jy: 1403, jm: 12, jd: 29 }, 1)).toEqual({ jy: 1403, jm: 12, jd: 30 });
    expect(addJalaliDays({ jy: 1403, jm: 12, jd: 30 }, 1)).toEqual({ jy: 1404, jm: 1, jd: 1 });
    expect(addJalaliDays({ jy: 1404, jm: 1, jd: 1 }, -1)).toEqual({ jy: 1403, jm: 12, jd: 30 });
    expect(addJalaliDays({ jy: 1405, jm: 1, jd: 1 }, 365)).toEqual({ jy: 1406, jm: 1, jd: 1 });
    expect(addJalaliDays({ jy: 1405, jm: 1, jd: 1 }, 364)).toEqual({ jy: 1405, jm: 12, jd: 29 });
  });

  it('computes start/end of month and ranges', () => {
    const date = { jy: 1405, jm: 12, jd: 14 };
    expect(startOfJalaliMonth(date)).toEqual({ jy: 1405, jm: 12, jd: 1 });
    expect(endOfJalaliMonth(date)).toEqual({ jy: 1405, jm: 12, jd: 29 });
    expect(jalaliMonthRange(1405, 12)).toEqual({ start: '2027-02-20', end: '2027-03-20' });
    expect(jalaliYearRange(1403)).toEqual({ start: '2024-03-20', end: '2025-03-20' });
  });

  it('counts days and compares dates', () => {
    expect(daysBetweenJalali({ jy: 1404, jm: 1, jd: 1 }, { jy: 1405, jm: 1, jd: 1 })).toBe(365);
    expect(daysBetweenJalali({ jy: 1403, jm: 1, jd: 1 }, { jy: 1404, jm: 1, jd: 1 })).toBe(366);
    expect(compareJalaliDates({ jy: 1405, jm: 1, jd: 1 }, { jy: 1405, jm: 1, jd: 2 })).toBe(-1);
    expect(compareJalaliDates({ jy: 1405, jm: 1, jd: 2 }, { jy: 1405, jm: 1, jd: 2 })).toBe(0);
  });
});
