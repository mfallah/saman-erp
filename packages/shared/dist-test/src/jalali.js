"use strict";
/**
 * Jalali (Solar Hijri) calendar conversion and arithmetic (`ADR-0014`).
 *
 * Storage stays Gregorian (`timestamptz` / `date`); conversions happen at the
 * edges (UI, imports, reports). The algorithm is pure integer arithmetic in the
 * `jalaali` family (Borkowski/Khayyam cycle), independent of any SQL extension,
 * and is unit tested against known year boundaries and leap years.
 *
 * Reference: `jalaali-js` algorithm, re-implemented with strict validation.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.JALALI_MONTH_NAMES_EN = exports.JALALI_MONTH_NAMES = void 0;
exports.jalaliMonthName = jalaliMonthName;
exports.jalaliMonthNameEn = jalaliMonthNameEn;
exports.isValidGregorianDate = isValidGregorianDate;
exports.isJalaliLeapYear = isJalaliLeapYear;
exports.jalaliMonthLength = jalaliMonthLength;
exports.isValidJalaliDate = isValidJalaliDate;
exports.gregorianToJalali = gregorianToJalali;
exports.jalaliToGregorian = jalaliToGregorian;
exports.parseJalaliDate = parseJalaliDate;
exports.formatJalaliDate = formatJalaliDate;
exports.addJalaliDays = addJalaliDays;
exports.startOfJalaliMonth = startOfJalaliMonth;
exports.endOfJalaliMonth = endOfJalaliMonth;
exports.jalaliToIso = jalaliToIso;
exports.parseGregorianIsoDate = parseGregorianIsoDate;
exports.isoToJalali = isoToJalali;
exports.jalaliMonthRange = jalaliMonthRange;
exports.jalaliYearRange = jalaliYearRange;
exports.daysBetweenJalali = daysBetweenJalali;
exports.compareJalaliDates = compareJalaliDates;
/** Persian month names, Farvardin (1) to Esfand (12). */
exports.JALALI_MONTH_NAMES = [
    'فروردین',
    'اردیبهشت',
    'خرداد',
    'تیر',
    'مرداد',
    'شهریور',
    'مهر',
    'آبان',
    'آذر',
    'دی',
    'بهمن',
    'اسفند',
];
/** English month names (logs / i18n keys, 1-indexed via `jalaliMonthNameEn`). */
exports.JALALI_MONTH_NAMES_EN = [
    'Farvardin',
    'Ordibehesht',
    'Khordad',
    'Tir',
    'Mordad',
    'Shahrivar',
    'Mehr',
    'Aban',
    'Azar',
    'Dey',
    'Bahman',
    'Esfand',
];
/** Returns the Persian month name for a 1-based month number. */
function jalaliMonthName(month) {
    assertMonth(month);
    return exports.JALALI_MONTH_NAMES[month - 1];
}
/** Returns the English month name for a 1-based month number. */
function jalaliMonthNameEn(month) {
    assertMonth(month);
    return exports.JALALI_MONTH_NAMES_EN[month - 1];
}
const BREAKS = [
    -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394,
    2456, 3178,
];
const DAYS_IN_MONTH_31 = [1, 2, 3, 4, 5, 6];
const DAYS_IN_MONTH_30 = [7, 8, 9, 10, 11];
function div(a, b) {
    return Math.trunc(a / b);
}
function mod(a, b) {
    return a - Math.trunc(a / b) * b;
}
function assertMonth(month) {
    if (!Number.isInteger(month) || month < 1 || month > 12) {
        throw new RangeError(`invalid_jalali_month:${month}`);
    }
}
function jalCal(jy, withoutLeap = false) {
    if (!Number.isInteger(jy)) {
        throw new RangeError(`invalid_jalali_year:${jy}`);
    }
    const first = BREAKS[0];
    const last = BREAKS[BREAKS.length - 1];
    if (jy < first || jy >= last) {
        throw new RangeError(`invalid_jalali_year:${jy}`);
    }
    const gy = jy + 621;
    let leapJ = -14;
    let jp = first;
    let jump = 0;
    for (let i = 1; i < BREAKS.length; i += 1) {
        const jm = BREAKS[i];
        jump = jm - jp;
        if (jy < jm)
            break;
        leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
        jp = jm;
    }
    const n = jy - jp;
    leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
    if (mod(jump, 33) === 4 && jump - n === 4) {
        leapJ += 1;
    }
    const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
    const march = 20 + leapJ - leapG;
    let leap = 0;
    if (!withoutLeap) {
        let adjusted = n;
        if (jump - adjusted < 6) {
            adjusted = adjusted - jump + div(jump + 4, 33) * 33;
        }
        leap = mod(mod(adjusted + 1, 33) - 1, 4);
        if (leap === -1) {
            leap = 4;
        }
    }
    return { leap, gy, march };
}
function g2d(gy, gm, gd) {
    let day = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
    day = day - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
    return day;
}
function d2g(jdn) {
    let j = 4 * jdn + 139361631;
    j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
    const i = div(mod(j, 1461), 4) * 5 + 308;
    const gd = div(mod(i, 153), 5) + 1;
    const gm = mod(div(i, 153), 12) + 1;
    const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
    return { gy, gm, gd };
}
function j2d(jy, jm, jd) {
    const r = jalCal(jy, true);
    return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}
function d2j(jdn) {
    const gy = d2g(jdn).gy;
    let jy = gy - 621;
    // The Gregorian year containing the day can fall one Jalali year before/after
    // (Farvardin 1 is around March 20), so settle the year by comparing to its start.
    for (let guard = 0; guard < 3; guard += 1) {
        const dayOfYear = jdn - j2d(jy, 1, 1);
        if (dayOfYear >= 0 && dayOfYear <= 365) {
            if (dayOfYear <= 185) {
                return { jy, jm: 1 + div(dayOfYear, 31), jd: mod(dayOfYear, 31) + 1 };
            }
            const k = dayOfYear - 186;
            return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
        }
        jy = dayOfYear < 0 ? jy - 1 : jy + 1;
    }
    throw new RangeError('jalali_conversion_out_of_range');
}
function isGregorianLeapYear(gy) {
    return (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
}
function gregorianMonthLength(gy, gm) {
    switch (gm) {
        case 2:
            return isGregorianLeapYear(gy) ? 29 : 28;
        case 4:
        case 6:
        case 9:
        case 11:
            return 30;
        default:
            return 31;
    }
}
/** Returns true for a valid Gregorian civil date. */
function isValidGregorianDate(gy, gm, gd) {
    if (!Number.isInteger(gy) || !Number.isInteger(gm) || !Number.isInteger(gd))
        return false;
    if (gy < 1 || gm < 1 || gm > 12 || gd < 1)
        return false;
    return gd <= gregorianMonthLength(gy, gm);
}
/** Returns true when the Jalali year has 366 days. */
function isJalaliLeapYear(jy) {
    return jalCal(jy, false).leap === 0;
}
/** Number of days in a Jalali month (1..12). */
function jalaliMonthLength(jy, jm) {
    assertMonth(jm);
    jalCal(jy, false);
    if (DAYS_IN_MONTH_31.includes(jm))
        return 31;
    if (DAYS_IN_MONTH_30.includes(jm))
        return 30;
    return isJalaliLeapYear(jy) ? 30 : 29;
}
/** Returns true for a valid Jalali civil date. */
function isValidJalaliDate(jy, jm, jd) {
    if (!Number.isInteger(jy) || !Number.isInteger(jm) || !Number.isInteger(jd))
        return false;
    if (jm < 1 || jm > 12 || jd < 1)
        return false;
    try {
        return jd <= jalaliMonthLength(jy, jm);
    }
    catch {
        return false;
    }
}
/** Word day-number fields as `{ jy, jm, jd }`. */
const JALALI_DATE_PATTERN = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/;
const GREGORIAN_ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Converts a Gregorian civil date to Jalali. */
function gregorianToJalali(gy, gm, gd) {
    if (!isValidGregorianDate(gy, gm, gd)) {
        throw new RangeError(`invalid_gregorian_date:${gy}-${gm}-${gd}`);
    }
    return d2j(g2d(gy, gm, gd));
}
/** Converts a Jalali civil date to Gregorian. */
function jalaliToGregorian(jy, jm, jd) {
    if (!isValidJalaliDate(jy, jm, jd)) {
        throw new RangeError(`invalid_jalali_date:${jy}-${jm}-${jd}`);
    }
    return d2g(j2d(jy, jm, jd));
}
/** Parses `YYYY/MM/DD` (or `YYYY-MM-DD`) into a validated Jalali date. */
function parseJalaliDate(value) {
    const match = JALALI_DATE_PATTERN.exec(value.trim());
    if (match === null) {
        throw new RangeError(`invalid_jalali_date_string:${JSON.stringify(value)}`);
    }
    const jy = Number(match[1]);
    const jm = Number(match[2]);
    const jd = Number(match[3]);
    if (!isValidJalaliDate(jy, jm, jd)) {
        throw new RangeError(`invalid_jalali_date_string:${JSON.stringify(value)}`);
    }
    return { jy, jm, jd };
}
/** Formats a Jalali date as `YYYY/MM/DD` (separator configurable). */
function formatJalaliDate(date, separator = '/') {
    assertMonth(date.jm);
    if (!isValidJalaliDate(date.jy, date.jm, date.jd)) {
        throw new RangeError(`invalid_jalali_date:${date.jy}-${date.jm}-${date.jd}`);
    }
    const y = String(date.jy).padStart(4, '0');
    const m = String(date.jm).padStart(2, '0');
    const d = String(date.jd).padStart(2, '0');
    return [y, m, d].join(separator);
}
/** Adds a number of days to a Jalali date (negative values subtract). */
function addJalaliDays(date, days) {
    if (!Number.isInteger(days)) {
        throw new RangeError(`invalid_day_count:${days}`);
    }
    if (!isValidJalaliDate(date.jy, date.jm, date.jd)) {
        throw new RangeError(`invalid_jalali_date:${date.jy}-${date.jm}-${date.jd}`);
    }
    return d2j(j2d(date.jy, date.jm, date.jd) + days);
}
/** First day of the Jalali month containing `date`. */
function startOfJalaliMonth(date) {
    return { jy: date.jy, jm: date.jm, jd: 1 };
}
/** Last day of the Jalali month containing `date`. */
function endOfJalaliMonth(date) {
    return { jy: date.jy, jm: date.jm, jd: jalaliMonthLength(date.jy, date.jm) };
}
/** Converts a Jalali date to a Gregorian ISO `YYYY-MM-DD` date. */
function jalaliToIso(date) {
    const g = jalaliToGregorian(date.jy, date.jm, date.jd);
    return `${String(g.gy).padStart(4, '0')}-${String(g.gm).padStart(2, '0')}-${String(g.gd).padStart(2, '0')}`;
}
/** Parses a Gregorian ISO `YYYY-MM-DD` date into a validated Gregorian date. */
function parseGregorianIsoDate(value) {
    const match = GREGORIAN_ISO_PATTERN.exec(value.trim());
    if (match === null) {
        throw new RangeError(`invalid_gregorian_date_string:${JSON.stringify(value)}`);
    }
    const gy = Number(match[1]);
    const gm = Number(match[2]);
    const gd = Number(match[3]);
    if (!isValidGregorianDate(gy, gm, gd)) {
        throw new RangeError(`invalid_gregorian_date_string:${JSON.stringify(value)}`);
    }
    return { gy, gm, gd };
}
/** Parses a Gregorian ISO date and converts it to Jalali. */
function isoToJalali(value) {
    const g = parseGregorianIsoDate(value);
    return gregorianToJalali(g.gy, g.gm, g.gd);
}
/**
 * Gregorian ISO date range for a whole Jalali month.
 * Used to translate report ranges (`calendar=jalali`) into SQL bounds.
 */
function jalaliMonthRange(jy, jm) {
    const monthLength = jalaliMonthLength(jy, jm);
    return {
        start: jalaliToIso({ jy, jm, jd: 1 }),
        end: jalaliToIso({ jy, jm, jd: monthLength }),
    };
}
/** Gregorian ISO date range for a whole Jalali fiscal year (`fiscal year start` = Farvardin 1). */
function jalaliYearRange(jy) {
    const last = isJalaliLeapYear(jy) ? 30 : 29;
    return {
        start: jalaliToIso({ jy, jm: 1, jd: 1 }),
        end: jalaliToIso({ jy, jm: 12, jd: last }),
    };
}
/** Number of days between two Jalali dates (`to - from`). */
function daysBetweenJalali(from, to) {
    const start = j2d(from.jy, from.jm, from.jd);
    const end = j2d(to.jy, to.jm, to.jd);
    return end - start;
}
/** Compares two Jalali dates: -1 when `left < right`, 1 when greater, 0 when equal. */
function compareJalaliDates(left, right) {
    const l = j2d(left.jy, left.jm, left.jd);
    const r = j2d(right.jy, right.jm, right.jd);
    if (l < r)
        return -1;
    if (l > r)
        return 1;
    return 0;
}
