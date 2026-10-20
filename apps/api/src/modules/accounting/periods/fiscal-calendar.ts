/**
 * Fiscal calendar (ADR-0014): Jalali monthly periods generated from the fiscal
 * year range, plus the explicit 13th adjustment period (`R1-accounting` B-09).
 *
 * Pure functions: the service persists the generated rows inside the fiscal-year
 * transaction. Storage stays Gregorian (`date`), labels are Jalali.
 */
import { AppError, isoToJalali, jalaliMonthName, jalaliMonthRange } from '@saman/shared';

export interface GeneratedPeriod {
  readonly periodNo: number;
  readonly nameFa: string;
  /** Inclusive Gregorian ISO start. */
  readonly startDate: string;
  /** Inclusive Gregorian ISO end. */
  readonly endDate: string;
}

const MAX_MONTHLY_PERIODS = 12;

function maxIso(left: string, right: string): string {
  return left >= right ? left : right;
}

function minIso(left: string, right: string): string {
  return left <= right ? left : right;
}

/**
 * Generates one period per Jalali month, clipped to `[startIso, endIso]`.
 * A standard Jalali fiscal year yields 12 periods; a longer range is rejected
 * (use the adjustment period for the extra days).
 */
export function generateMonthlyPeriods(startIso: string, endIso: string): readonly GeneratedPeriod[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startIso) || !/^\d{4}-\d{2}-\d{2}$/.test(endIso)) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'startDate', rule: 'iso_date' }],
      message: 'بازه سال مالی معتبر نیست.',
    });
  }
  if (endIso <= startIso) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'endDate', rule: 'after_start' }],
      message: 'تاریخ پایان سال مالی باید بعد از تاریخ شروع باشد.',
    });
  }

  const start = isoToJalali(startIso);
  const end = isoToJalali(endIso);
  const periods: GeneratedPeriod[] = [];
  let year = start.jy;
  let month = start.jm;

  while (periods.length <= MAX_MONTHLY_PERIODS) {
    const range = jalaliMonthRange(year, month);
    const periodStart = maxIso(range.start, startIso);
    const periodEnd = minIso(range.end, endIso);
    if (periodStart <= periodEnd) {
      periods.push({
        periodNo: periods.length + 1,
        nameFa: `${jalaliMonthName(month)} ${year}`,
        startDate: periodStart,
        endDate: periodEnd,
      });
    }
    if (periodEnd >= endIso) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  if (periods.length > MAX_MONTHLY_PERIODS) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'endDate', rule: 'max_twelve_periods' }],
      message: 'سال مالی نمی‌تواند بیش از ۱۲ دوره ماهانه داشته باشد.',
    });
  }
  const last = periods[periods.length - 1];
  if (!last || last.endDate !== endIso) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'endDate', rule: 'periods_must_cover_range' }],
      message: 'دوره‌های تولیدشده کل بازه سال مالی را پوشش نمی‌دهند.',
    });
  }
  return periods;
}

/**
 * Period 13 (adjustment) covers the fiscal-year end day only. It is created
 * explicitly, never as part of the monthly generation, and is closed after audit
 * adjustments (`period_no=13 AND entry_type='adjustment'`).
 */
export function buildAdjustmentPeriod(fiscalYearEndIso: string): GeneratedPeriod {
  return {
    periodNo: 13,
    nameFa: 'دوره تعدیلات پایان سال',
    startDate: fiscalYearEndIso,
    endDate: fiscalYearEndIso,
  };
}

export interface DatedPeriod {
  readonly id: bigint;
  readonly periodNo: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: string;
}

/** Resolves the period that owns a legal entry date. */
export function findPeriodForDate<T extends { readonly startDate: string; readonly endDate: string }>(
  periods: readonly T[],
  entryDate: string,
): T | undefined {
  return periods.find((period) => period.startDate <= entryDate && entryDate <= period.endDate);
}

export const POSTING_BLOCKED_PERIOD_STATUSES: readonly string[] = ['closed', 'locked'];

export function isPostingBlocked(status: string): boolean {
  return POSTING_BLOCKED_PERIOD_STATUSES.includes(status);
}

/** Period 13 accepts only `adjustment` entries (B-09). */
export function assertPeriodAcceptsEntryType(periodNo: number, entryType: string): void {
  if (periodNo === 13 && entryType !== 'adjustment') {
    throw new AppError('RULE_VIOLATION', {
      details: [{ rule: 'period_13_adjustment_only', params: { entryType } }],
      message: 'در دوره ۱۳ تنها سند تعدیل قابل ثبت است.',
    });
  }
}
