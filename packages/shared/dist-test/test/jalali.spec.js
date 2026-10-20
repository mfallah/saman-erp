"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const expect_1 = require("./expect");
const jalali_1 = require("../src/jalali");
const PERSIAN_DATE_FORMAT = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC',
});
/** Independent oracle: ICU Persian calendar (validates the pure algorithm). */
function intlJalali(iso) {
    const parts = PERSIAN_DATE_FORMAT.formatToParts(new Date(`${iso}T00:00:00Z`));
    const value = (type) => {
        const part = parts.find((candidate) => candidate.type === type);
        return part === undefined ? Number.NaN : Number(part.value);
    };
    return { jy: value('year'), jm: value('month'), jd: value('day') };
}
(0, node_test_1.describe)('known Jalali/Gregorian boundaries', () => {
    const cases = [
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
    (0, node_test_1.it)('converts known boundary dates in both directions', () => {
        for (const [jy, jm, jd, iso] of cases) {
            (0, expect_1.expect)((0, jalali_1.jalaliToIso)({ jy, jm, jd })).toBe(iso);
            (0, expect_1.expect)((0, jalali_1.isoToJalali)(iso)).toEqual({ jy, jm, jd });
            const gregorian = (0, jalali_1.jalaliToGregorian)(jy, jm, jd);
            (0, expect_1.expect)((0, jalali_1.gregorianToJalali)(gregorian.gy, gregorian.gm, gregorian.gd)).toEqual({ jy, jm, jd });
        }
    });
});
(0, node_test_1.describe)('leap years', () => {
    (0, node_test_1.it)('matches the Iranian 33-year cycle for 1390..1420', () => {
        const expectedLeapYears = [1391, 1395, 1399, 1403, 1408, 1412, 1416, 1420];
        for (let jy = 1390; jy <= 1420; jy += 1) {
            (0, expect_1.expect)((0, jalali_1.isJalaliLeapYear)(jy)).toBe(expectedLeapYears.includes(jy));
        }
    });
    (0, node_test_1.it)('uses 30 days for Esfand in leap years only', () => {
        (0, expect_1.expect)((0, jalali_1.jalaliMonthLength)(1403, 12)).toBe(30);
        (0, expect_1.expect)((0, jalali_1.jalaliMonthLength)(1404, 12)).toBe(29);
        (0, expect_1.expect)((0, jalali_1.jalaliMonthLength)(1405, 12)).toBe(29);
        (0, expect_1.expect)((0, jalali_1.jalaliMonthLength)(1408, 12)).toBe(30);
    });
    (0, node_test_1.it)('has six 31-day months then five 30-day months', () => {
        for (let jm = 1; jm <= 6; jm += 1)
            (0, expect_1.expect)((0, jalali_1.jalaliMonthLength)(1404, jm)).toBe(31);
        for (let jm = 7; jm <= 11; jm += 1)
            (0, expect_1.expect)((0, jalali_1.jalaliMonthLength)(1404, jm)).toBe(30);
    });
});
(0, node_test_1.describe)('ICU oracle cross-check', () => {
    (0, node_test_1.it)('agrees with Intl for every day from 2019-01-01 to 2035-12-31', () => {
        const start = Date.UTC(2019, 0, 1);
        const end = Date.UTC(2035, 11, 31);
        for (let time = start; time <= end; time += 86_400_000) {
            const date = new Date(time);
            const iso = date.toISOString().slice(0, 10);
            const expected = intlJalali(iso);
            (0, expect_1.expect)((0, jalali_1.isoToJalali)(iso)).toEqual(expected);
            (0, expect_1.expect)((0, jalali_1.jalaliToIso)(expected)).toBe(iso);
        }
    });
});
(0, node_test_1.describe)('parsing and formatting', () => {
    (0, node_test_1.it)('parses and formats YYYY/MM/DD', () => {
        (0, expect_1.expect)((0, jalali_1.parseJalaliDate)('1405/07/27')).toEqual({ jy: 1405, jm: 7, jd: 27 });
        (0, expect_1.expect)((0, jalali_1.parseJalaliDate)('1405-07-27')).toEqual({ jy: 1405, jm: 7, jd: 27 });
        (0, expect_1.expect)((0, jalali_1.formatJalaliDate)({ jy: 1405, jm: 7, jd: 27 })).toBe('1405/07/27');
        (0, expect_1.expect)((0, jalali_1.formatJalaliDate)({ jy: 1403, jm: 12, jd: 30 }, '-')).toBe('1403-12-30');
    });
    (0, node_test_1.it)('rejects invalid Jalali dates', () => {
        (0, expect_1.expect)(() => (0, jalali_1.parseJalaliDate)('1404/12/30')).toThrow(RangeError);
        (0, expect_1.expect)(() => (0, jalali_1.parseJalaliDate)('1404/13/01')).toThrow(RangeError);
        (0, expect_1.expect)(() => (0, jalali_1.parseJalaliDate)('1404/00/10')).toThrow(RangeError);
        (0, expect_1.expect)(() => (0, jalali_1.parseJalaliDate)('not-a-date')).toThrow(RangeError);
        (0, expect_1.expect)(() => (0, jalali_1.formatJalaliDate)({ jy: 1405, jm: 6, jd: 31 })).not.toThrow();
        (0, expect_1.expect)(() => (0, jalali_1.formatJalaliDate)({ jy: 1405, jm: 7, jd: 31 })).toThrow(RangeError);
    });
    (0, node_test_1.it)('exposes Persian month names', () => {
        (0, expect_1.expect)(jalali_1.JALALI_MONTH_NAMES).toHaveLength(12);
        (0, expect_1.expect)((0, jalali_1.jalaliMonthName)(1)).toBe('فروردین');
        (0, expect_1.expect)((0, jalali_1.jalaliMonthName)(12)).toBe('اسفند');
        (0, expect_1.expect)(() => (0, jalali_1.jalaliMonthName)(0)).toThrow(RangeError);
    });
});
(0, node_test_1.describe)('month and day arithmetic', () => {
    (0, node_test_1.it)('adds days across month and year boundaries', () => {
        (0, expect_1.expect)((0, jalali_1.addJalaliDays)({ jy: 1403, jm: 12, jd: 29 }, 1)).toEqual({ jy: 1403, jm: 12, jd: 30 });
        (0, expect_1.expect)((0, jalali_1.addJalaliDays)({ jy: 1403, jm: 12, jd: 30 }, 1)).toEqual({ jy: 1404, jm: 1, jd: 1 });
        (0, expect_1.expect)((0, jalali_1.addJalaliDays)({ jy: 1404, jm: 1, jd: 1 }, -1)).toEqual({ jy: 1403, jm: 12, jd: 30 });
        (0, expect_1.expect)((0, jalali_1.addJalaliDays)({ jy: 1405, jm: 1, jd: 1 }, 365)).toEqual({ jy: 1406, jm: 1, jd: 1 });
        (0, expect_1.expect)((0, jalali_1.addJalaliDays)({ jy: 1405, jm: 1, jd: 1 }, 364)).toEqual({ jy: 1405, jm: 12, jd: 29 });
    });
    (0, node_test_1.it)('computes start/end of month and ranges', () => {
        const date = { jy: 1405, jm: 12, jd: 14 };
        (0, expect_1.expect)((0, jalali_1.startOfJalaliMonth)(date)).toEqual({ jy: 1405, jm: 12, jd: 1 });
        (0, expect_1.expect)((0, jalali_1.endOfJalaliMonth)(date)).toEqual({ jy: 1405, jm: 12, jd: 29 });
        (0, expect_1.expect)((0, jalali_1.jalaliMonthRange)(1405, 12)).toEqual({ start: '2027-02-20', end: '2027-03-20' });
        (0, expect_1.expect)((0, jalali_1.jalaliYearRange)(1403)).toEqual({ start: '2024-03-20', end: '2025-03-20' });
    });
    (0, node_test_1.it)('counts days and compares dates', () => {
        (0, expect_1.expect)((0, jalali_1.daysBetweenJalali)({ jy: 1404, jm: 1, jd: 1 }, { jy: 1405, jm: 1, jd: 1 })).toBe(365);
        (0, expect_1.expect)((0, jalali_1.daysBetweenJalali)({ jy: 1403, jm: 1, jd: 1 }, { jy: 1404, jm: 1, jd: 1 })).toBe(366);
        (0, expect_1.expect)((0, jalali_1.compareJalaliDates)({ jy: 1405, jm: 1, jd: 1 }, { jy: 1405, jm: 1, jd: 2 })).toBe(-1);
        (0, expect_1.expect)((0, jalali_1.compareJalaliDates)({ jy: 1405, jm: 1, jd: 2 }, { jy: 1405, jm: 1, jd: 2 })).toBe(0);
    });
});
