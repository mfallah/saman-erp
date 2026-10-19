/**
 * Jalali (Persian) calendar helpers (ADR-0014).
 *
 * The API always transports Gregorian civil dates (`YYYY-MM-DD`) and UTC
 * timestamps; Jalali is presentation only. Conversion uses the platform ICU
 * Persian calendar via `Intl.DateTimeFormat('fa-IR-u-ca-persian')`, so leap-year
 * and month-length rules are handled by ICU instead of hand-written tables.
 */
import { toLatinDigits, toPersianDigits } from './money';

export interface JalaliParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export const JALALI_MONTHS_FA: readonly string[] = [
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

export const JALALI_WEEKDAYS_FA: readonly string[] = [
  'یکشنبه',
  'دوشنبه',
  'سه‌شنبه',
  'چهارشنبه',
  'پنجشنبه',
  'جمعه',
  'شنبه',
];

/** Calendar formatter that yields ASCII numeric parts (used for conversion). */
const partsFormatter = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  timeZone: 'UTC',
});

/** Persian-calendar display formatters. */
const dayFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'UTC',
});

const longFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'long',
  timeZone: 'UTC',
});

const dateTimeFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const instantFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const relativeFormatter = new Intl.RelativeTimeFormat('fa', { numeric: 'auto' });

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Returns a `Date` at 12:00 UTC for a `YYYY-MM-DD` civil date (TZ-safe). */
export function parseISODate(value: string): Date {
  const normalized = toLatinDigits(value.trim());
  if (!ISO_DATE_RE.test(normalized)) {
    throw new RangeError(`تاریخ ISO نامعتبر است: ${value}`);
  }
  const date = new Date(`${normalized}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`تاریخ ISO نامعتبر است: ${value}`);
  }
  return date;
}

function isoFromDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Converts a `YYYY-MM-DD` (UTC civil) date to Jalali parts. */
export function toJalaliParts(value: string | Date): JalaliParts {
  const date = typeof value === 'string' ? parseISODate(value) : value;
  const parts = partsFormatter.formatToParts(date);
  const get = (type: string): number => {
    const found = parts.find((part) => part.type === type);
    return found === undefined ? Number.NaN : Number(toLatinDigits(found.value));
  };
  return { year: get('year'), month: get('month'), day: get('day') };
}

function compareJalali(a: JalaliParts, b: JalaliParts): number {
  if (a.year !== b.year) {
    return a.year - b.year;
  }
  if (a.month !== b.month) {
    return a.month - b.month;
  }
  return a.day - b.day;
}

const DAY_MS = 86_400_000;
const MAX_YEAR_SCAN_DAYS = 800;

/**
 * Converts Jalali parts to a Gregorian `YYYY-MM-DD` string. A nearby March date
 * is found from the year, then refined day by day using ICU — correct for the
 * supported year range (1300–1500) without hand-written leap tables.
 */
export function jalaliToISO(year: number, month: number, day: number): string {
  const target: JalaliParts = { year, month, day };
  const estimate = new Date(Date.UTC(year + 621, 2, 1, 12, 0, 0));
  let cursor = estimate;
  for (let step = 0; step < MAX_YEAR_SCAN_DAYS; step += 1) {
    const current = toJalaliParts(isoFromDate(cursor));
    const diff = compareJalali(current, target);
    if (diff === 0) {
      return isoFromDate(cursor);
    }
    cursor = new Date(cursor.getTime() + (diff < 0 ? DAY_MS : -DAY_MS));
  }
  throw new RangeError(`تبدیل تاریخ شمسی نامعتبر است: ${year}/${month}/${day}`);
}

/** Validates Jalali month/day ranges (ICU is authoritative for leap years). */
export function isValidJalali(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || year < 1200 || year > 1700) {
    return false;
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return false;
  }
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return false;
  }
  try {
    const iso = jalaliToISO(year, month, day);
    const roundTrip = toJalaliParts(iso);
    return roundTrip.year === year && roundTrip.month === month && roundTrip.day === day;
  } catch {
    return false;
  }
}

/** Formats a civil date as `۱۴۰۵/۰۴/۲۷` (Jalali). */
export function formatJalali(value: string | Date): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return instantFormatter.format(new Date(value));
  }
  const date = typeof value === 'string' ? parseISODate(value) : value;
  return dayFormatter.format(date);
}

/** Formats a civil date as `شنبه ۲۷ تیر ۱۴۰۵`. */
export function formatJalaliLong(value: string | Date): string {
  const date = typeof value === 'string' ? parseISODate(value) : value;
  return longFormatter.format(date);
}

/** Formats a UTC timestamp instant as a Jalali date-time in the local zone. */
export function formatJalaliDateTime(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return dateTimeFormatter.format(date);
}

/** Formats a date for editable Jalali inputs: `1405/04/27` with Persian digits. */
export function formatJalaliInput(value: string | Date): string {
  const date = typeof value === 'string' ? parseISODate(value) : value;
  const parts = toJalaliParts(date);
  const padded = [parts.year, parts.month, parts.day]
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, '0')))
    .join('/');
  return toPersianDigits(padded);
}

/**
 * Parses user Jalali input (`1405/4/27`, `۱۴۰۵-۰۴-۲۷`) to a Gregorian
 * `YYYY-MM-DD` string. Throws `RangeError` for invalid calendar dates.
 */
export function parseJalaliInput(input: string): string {
  const normalized = toLatinDigits(input.trim())
    .replace(/[.\u066b]/g, '/')
    .replace(/-/g, '/')
    .replace(/\s+/g, '');
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(normalized);
  if (!match) {
    throw new RangeError('قالب تاریخ باید به شکل ۱۴۰۵/۰۴/۲۷ باشد.');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidJalali(year, month, day)) {
    throw new RangeError('تاریخ شمسی واردشده معتبر نیست.');
  }
  return jalaliToISO(year, month, day);
}

/** Today's civil date in the browser timezone as `YYYY-MM-DD`. */
export function todayISO(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Adds (or subtracts) whole days to a civil date. */
export function addDaysISO(value: string, days: number): string {
  const date = parseISODate(value);
  return isoFromDate(new Date(date.getTime() + days * DAY_MS));
}

export interface DateRangeISO {
  readonly from: string;
  readonly to: string;
}

/** Inclusive range of the last `days` days, ending today. */
export function lastNDaysISO(days: number): DateRangeISO {
  const to = todayISO();
  return { from: addDaysISO(to, -(Math.max(days, 1) - 1)), to };
}

/** ISO date of the first day of the current Jalali month. */
export function currentJalaliMonthStartISO(): string {
  const parts = toJalaliParts(todayISO());
  return jalaliToISO(parts.year, parts.month, 1);
}

/** ISO date of the last day of the current Jalali month. */
export function currentJalaliMonthEndISO(): string {
  const parts = toJalaliParts(todayISO());
  const nextMonth = parts.month === 12 ? 1 : parts.month + 1;
  const nextYear = parts.month === 12 ? parts.year + 1 : parts.year;
  return addDaysISO(jalaliToISO(nextYear, nextMonth, 1), -1);
}

/** Persian relative time such as `۳ دقیقه پیش` for an ISO timestamp. */
export function relativeTimeFa(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const absolute = Math.abs(diffSeconds);
  if (absolute < 60) {
    return relativeFormatter.format(diffSeconds, 'second');
  }
  if (absolute < 3_600) {
    return relativeFormatter.format(Math.round(diffSeconds / 60), 'minute');
  }
  if (absolute < 86_400) {
    return relativeFormatter.format(Math.round(diffSeconds / 3_600), 'hour');
  }
  if (absolute < 2_592_000) {
    return relativeFormatter.format(Math.round(diffSeconds / 86_400), 'day');
  }
  if (absolute < 31_536_000) {
    return relativeFormatter.format(Math.round(diffSeconds / 2_592_000), 'month');
  }
  return relativeFormatter.format(Math.round(diffSeconds / 31_536_000), 'year');
}

/** Jalali year of a civil date, useful for fiscal-year selectors. */
export function jalaliYear(value: string | Date = todayISO()): number {
  return toJalaliParts(value).year;
}
