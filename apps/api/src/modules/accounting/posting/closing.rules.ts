/**
 * Year-end closing rules (`DATA-MODEL §6.10.3`, R1-accounting B-08) and the
 * profit-appropriation / opening-balance entries.
 *
 * Pure functions: the closing service loads balances, calls these, and persists
 * the three journals (income summary → retained earnings → legal reserve) plus
 * the next-year opening entry.
 */
import { AppError, applyRate } from '@saman/shared';
import { ACCOUNTS } from './accounts';
import {
  balanceLines,
  buildDraft,
  credit,
  debit,
  money,
  optionalMoney,
  text,
} from './types';
import type { EventPayload, PostingContext } from '../events';
import type { PostingDraft, PostingLegDraft } from './types';

export interface NormalizedBalance {
  readonly accountCode: string;
  readonly normalBalance: 'debit' | 'credit';
  readonly debitTotal: bigint;
  readonly creditTotal: bigint;
}

export interface ClosingInput {
  /** Revenue accounts (`4-*`) with their period debit/credit totals. */
  readonly revenueBalances: readonly NormalizedBalance[];
  /** Expense accounts (`5-*`). */
  readonly expenseBalances: readonly NormalizedBalance[];
  /** Registered capital (`3-1-01-001`) for the legal-reserve cap. */
  readonly registeredCapital: bigint;
  /** Legal reserve already appropriated in previous years. */
  readonly existingLegalReserve?: bigint;
  /** Fraction, e.g. `0.05`. */
  readonly legalReservePercent?: string;
  /** Fraction of capital that caps the reserve, e.g. `0.10`. */
  readonly legalReserveCapPercent?: string;
}

export interface ClosingComputation {
  readonly incomeSummaryLegs: readonly PostingLegDraft[];
  readonly retainedEarningsLegs: readonly PostingLegDraft[];
  readonly revenueTotal: bigint;
  readonly expenseTotal: bigint;
  /** Signed: positive profit, negative loss. */
  readonly netProfit: bigint;
  readonly legalReserve: bigint;
  readonly retainedAmount: bigint;
}

/** Signed amount of a balance on its own normal side. */
export function signedBalance(balance: NormalizedBalance): bigint {
  return balance.normalBalance === 'debit'
    ? balance.debitTotal - balance.creditTotal
    : balance.creditTotal - balance.debitTotal;
}

/**
 * Builds the closing run: close revenue/expense to the income-summary account
 * (`3-2-04-001`), then transfer the result to retained earnings and appropriate
 * the legal reserve (5% of profit until 10% of registered capital).
 */
export function computeClosing(input: ClosingInput): ClosingComputation {
  const incomeSummaryLegs: PostingLegDraft[] = [];
  let revenueTotal = 0n;
  let expenseTotal = 0n;

  for (const balance of input.revenueBalances) {
    const net = signedBalance(balance);
    if (net === 0n) continue;
    revenueTotal += balance.normalBalance === 'credit' ? net : -net;
    // position > 0 means a credit balance (income) that must be debited to close;
    // a contra-revenue debit balance is closed with a credit instead.
    const creditPosition = balance.normalBalance === 'credit' ? net : -net;
    incomeSummaryLegs.push(...(creditPosition > 0n
      ? [debit(balance.accountCode, creditPosition, 'بستن حساب درآمد')]
      : [credit(balance.accountCode, -creditPosition, 'بستن حساب برگشتی درآمد')]));
    incomeSummaryLegs.push(...(creditPosition > 0n
      ? [credit(ACCOUNTS.currentPeriodProfit, creditPosition, 'انتقال به سود و زیان')]
      : [debit(ACCOUNTS.currentPeriodProfit, -creditPosition, 'انتقال به سود و زیان')]));
  }
  for (const balance of input.expenseBalances) {
    const net = signedBalance(balance);
    if (net === 0n) continue;
    expenseTotal += balance.normalBalance === 'debit' ? net : -net;
    const debitPosition = balance.normalBalance === 'debit' ? net : -net;
    incomeSummaryLegs.push(...(debitPosition > 0n
      ? [credit(balance.accountCode, debitPosition, 'بستن حساب هزینه')]
      : [debit(balance.accountCode, -debitPosition, 'بستن حساب برگشتی هزینه')]));
    incomeSummaryLegs.push(...(debitPosition > 0n
      ? [debit(ACCOUNTS.currentPeriodProfit, debitPosition, 'انتقال به سود و زیان')]
      : [credit(ACCOUNTS.currentPeriodProfit, -debitPosition, 'انتقال به سود و زیان')]));
  }

  const netProfit = revenueTotal - expenseTotal;
  const reservePercent = input.legalReservePercent ?? '0.05';
  const capPercent = input.legalReserveCapPercent ?? '0.10';
  const existingReserve = input.existingLegalReserve ?? 0n;

  let legalReserve = 0n;
  let retainedAmount = netProfit;
  if (netProfit > 0n) {
    const cap = applyRate(input.registeredCapital, capPercent);
    const remainingCap = cap - existingReserve;
    const candidate = applyRate(netProfit, reservePercent);
    legalReserve = remainingCap <= 0n ? 0n : candidate < remainingCap ? candidate : remainingCap;
    if (legalReserve > netProfit) legalReserve = netProfit;
    retainedAmount = netProfit - legalReserve;
  } else if (netProfit < 0n) {
    legalReserve = 0n;
    retainedAmount = netProfit;
  }

  const retainedEarningsLegs: PostingLegDraft[] = [];
  if (netProfit > 0n) {
    retainedEarningsLegs.push(debit(ACCOUNTS.currentPeriodProfit, netProfit, 'انتقال سود دوره'));
    if (legalReserve > 0n) retainedEarningsLegs.push(credit(ACCOUNTS.legalReserve, legalReserve, 'اندوخته قانونی'));
    if (retainedAmount > 0n) retainedEarningsLegs.push(credit(ACCOUNTS.retainedEarnings, retainedAmount, 'سود انباشته'));
  } else if (netProfit < 0n) {
    retainedEarningsLegs.push(credit(ACCOUNTS.currentPeriodProfit, -netProfit, 'انتقال زیان دوره'));
    retainedEarningsLegs.push(debit(ACCOUNTS.retainedEarnings, -netProfit, 'زیان انباشته'));
  }

  return { incomeSummaryLegs, retainedEarningsLegs, revenueTotal, expenseTotal, netProfit, legalReserve, retainedAmount };
}

/** #46 `closing.income_summary` draft from the computation. */
export function closingIncomeSummary(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const balances = balanceLines(payload, 'balances');
  const legs: PostingLegDraft[] = [];
  for (const line of balances) {
    if (line.amount === 0n) continue;
    const isIncome = line.accountCode.startsWith('4-');
    if (isIncome) {
      legs.push(debit(line.accountCode, line.amount, 'بستن درآمد'));
      legs.push(credit(ACCOUNTS.currentPeriodProfit, line.amount, 'سود و زیان دوره'));
    } else {
      legs.push(credit(line.accountCode, line.amount, 'بستن هزینه'));
      legs.push(debit(ACCOUNTS.currentPeriodProfit, line.amount, 'سود و زیان دوره'));
    }
  }
  return buildDraft(
    {
      eventType: 'closing.income_summary',
      entryType: 'closing',
      entryDate: ctx.entryDate,
      descriptionFa: 'سند بستن حساب‌های درآمد و هزینه',
      sourceType: 'closing_run',
      ...(ctx.ruleSetId === undefined ? {} : { ruleSetId: ctx.ruleSetId }),
    },
    legs,
  );
}

/** #47 `closing.retained_earnings` draft (legal reserve appropriated here). */
export function closingRetainedEarnings(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const netProfit = money(payload, 'netProfitAmount');
  const legalReserve = optionalMoney(payload, 'legalReserveAmount');
  const retained = optionalMoney(payload, 'retainedAmount');
  const legs: PostingLegDraft[] = [];
  if (netProfit > 0n) {
    legs.push(debit(ACCOUNTS.currentPeriodProfit, netProfit, 'بستن سود دوره'));
    if (legalReserve > 0n) legs.push(credit(ACCOUNTS.legalReserve, legalReserve, 'اندوخته قانونی'));
    if (retained > 0n) legs.push(credit(ACCOUNTS.retainedEarnings, retained, 'سود انباشته'));
  } else if (netProfit < 0n) {
    legs.push(credit(ACCOUNTS.currentPeriodProfit, -netProfit, 'بستن زیان دوره'));
    legs.push(debit(ACCOUNTS.retainedEarnings, -netProfit, 'زیان انباشته'));
  } else {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'netProfitAmount', rule: 'non_zero' }],
      message: 'سود یا زیان دوره برای بستن صفر است.',
    });
  }
  return buildDraft(
    {
      eventType: 'closing.retained_earnings',
      entryType: 'closing',
      entryDate: ctx.entryDate,
      descriptionFa: 'سند انتقال سود و زیان به سود انباشته و اندوخته قانونی',
      sourceType: 'closing_run',
    },
    legs,
  );
}

/**
 * #38 profit distribution/appropriation **after** the closing run: retained
 * earnings → dividends payable + legal reserve (optional, usually already
 * appropriated at closing) + withholding tax payable.
 */
export function profitDistributionApproved(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const totalProfit = money(payload, 'totalProfitAmount');
  const dividends = money(payload, 'dividendsAmount');
  const reserve = optionalMoney(payload, 'legalReserveAmount');
  const withholding = optionalMoney(payload, 'withholdingAmount');
  const retainedAfter = optionalMoney(payload, 'retainedAmount');
  if (totalProfit <= 0n) {
    throw new AppError('RULE_VIOLATION', {
      details: [{ field: 'totalProfitAmount', rule: 'positive_retained_earnings' }],
      message: 'توزیع سود تنها با سود انباشته مثبت امکان‌پذیر است.',
    });
  }
  if (dividends + reserve + withholding + retainedAfter !== totalProfit) {
    throw new AppError('JOURNAL_UNBALANCED', {
      details: [
        {
          rule: 'profit_distribution_mismatch',
          params: { totalProfit: totalProfit.toString() },
        },
      ],
      message: 'جمع سود سهام، اندوخته و مالیات تکلیفی با سود قابل توزیع برابر نیست.',
    });
  }
  const legs: PostingLegDraft[] = [
    debit(ACCOUNTS.retainedEarnings, totalProfit, 'توزیع سود انباشته'),
    credit(ACCOUNTS.dividendsPayable, dividends, 'سود سهام پرداختنی'),
    ...(reserve > 0n ? [credit(ACCOUNTS.legalReserve, reserve, 'اندوخته قانونی')] : []),
    ...(withholding > 0n ? [credit(ACCOUNTS.withholdingTaxPayable, withholding, 'مالیات تکلیفی سود سهام')] : []),
    ...(retainedAfter > 0n ? [credit(ACCOUNTS.retainedEarnings, retainedAfter, 'سود انباشته باقیمانده')] : []),
  ];
  return buildDraft(
    {
      eventType: 'profit.distribution.approved',
      entryType: 'adjustment',
      entryDate: ctx.entryDate,
      descriptionFa: 'سند توزیع سود سهامداران',
      sourceType: 'profit_distribution',
    },
    legs,
  );
}

/** #48 opening balances imported for the next fiscal year. */
export function openingBalancesImported(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const debitBalances = balanceLines(payload, 'debitBalances');
  const creditBalances = balanceLines(payload, 'creditBalances');
  const legs: PostingLegDraft[] = [];
  let debitTotal = 0n;
  let creditTotal = 0n;
  for (const line of debitBalances) {
    if (line.amount === 0n) continue;
    legs.push(debit(line.accountCode, line.amount, 'مانده افتتاحیه بدهکار'));
    debitTotal += line.amount;
  }
  for (const line of creditBalances) {
    if (line.amount === 0n) continue;
    legs.push(credit(line.accountCode, line.amount, 'مانده افتتاحیه بستانکار'));
    creditTotal += line.amount;
  }
  if (debitTotal > creditTotal) {
    legs.push(credit(ACCOUNTS.registeredCapital, debitTotal - creditTotal, 'سرمایه افتتاحیه (مانده جبرانی)'));
  } else if (creditTotal > debitTotal) {
    legs.push(debit(ACCOUNTS.registeredCapital, creditTotal - debitTotal, 'سرمایه افتتاحیه (مانده جبرانی)'));
  }
  if (legs.length === 0) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'debitBalances', rule: 'at_least_one' }],
      message: 'مانده افتتاحیه‌ای برای ثبت وجود ندارد.',
    });
  }
  return buildDraft(
    {
      eventType: 'opening.balances.imported',
      entryType: 'opening',
      entryDate: ctx.entryDate,
      descriptionFa: text(payload, 'descriptionFa'),
      sourceType: 'opening_balance_import',
    },
    legs,
  );
}
