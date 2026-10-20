/** Year-end closing run: income summary → retained earnings → legal reserve. */
import { describe, expect, it } from 'vitest';
import { computeClosing, signedBalance } from '../posting/closing.rules';
import { assertDraft, draftTotals } from '../posting/types';
import { buildDraft } from '../posting/types';
import { ACCOUNTS } from '../posting/accounts';

const revenue = (accountCode: string, amount: bigint) => ({
  accountCode,
  normalBalance: 'credit' as const,
  debitTotal: 0n,
  creditTotal: amount,
});
const expense = (accountCode: string, amount: bigint) => ({
  accountCode,
  normalBalance: 'debit' as const,
  debitTotal: amount,
  creditTotal: 0n,
});

describe('closing computation', () => {
  it('closes revenue/expense to the income summary and appropriates 5% reserve', () => {
    const result = computeClosing({
      revenueBalances: [revenue('4-1-01-001', 10_000_000n)],
      expenseBalances: [expense('5-1-01-001', 6_000_000n)],
      registeredCapital: 100_000_000n,
    });
    expect(result.revenueTotal).toBe(10_000_000n);
    expect(result.expenseTotal).toBe(6_000_000n);
    expect(result.netProfit).toBe(4_000_000n);
    expect(result.legalReserve).toBe(200_000n);
    expect(result.retainedAmount).toBe(3_800_000n);

    const summary = buildDraft(
      {
        eventType: 'closing.income_summary',
        entryType: 'closing',
        entryDate: '2026-03-20',
        descriptionFa: 'بستن',
        sourceType: 'closing_run',
      },
      result.incomeSummaryLegs,
    );
    assertDraft(summary);
    const totals = draftTotals(summary.legs);
    expect(totals.debit).toBe(totals.credit);
    expect(totals.debit).toBe(10_000_000n + 6_000_000n);
  });

  it('caps the reserve at 10% of registered capital', () => {
    const result = computeClosing({
      revenueBalances: [revenue('4-1-01-001', 100_000_000n)],
      expenseBalances: [],
      registeredCapital: 20_000_000n,
      existingLegalReserve: 1_900_000n,
    });
    expect(result.legalReserve).toBe(100_000n);
    expect(result.retainedAmount).toBe(99_900_000n);
  });

  it('never appropriates a reserve when the cap is already reached', () => {
    const result = computeClosing({
      revenueBalances: [revenue('4-1-01-001', 5_000_000n)],
      expenseBalances: [],
      registeredCapital: 10_000_000n,
      existingLegalReserve: 1_000_000n,
    });
    expect(result.legalReserve).toBe(0n);
    expect(result.retainedAmount).toBe(5_000_000n);
  });

  it('allocates a loss to retained earnings with no reserve', () => {
    const result = computeClosing({
      revenueBalances: [revenue('4-1-01-001', 2_000_000n)],
      expenseBalances: [expense('5-2-01-001', 5_000_000n)],
      registeredCapital: 50_000_000n,
    });
    expect(result.netProfit).toBe(-3_000_000n);
    expect(result.legalReserve).toBe(0n);
    const retained = buildDraft(
      {
        eventType: 'closing.retained_earnings',
        entryType: 'closing',
        entryDate: '2026-03-20',
        descriptionFa: 'زیان',
        sourceType: 'closing_run',
      },
      result.retainedEarningsLegs,
    );
    assertDraft(retained);
    const totals = draftTotals(retained.legs);
    expect(totals.debit).toBe(totals.credit);
    expect(retained.legs.some((leg) => leg.accountCode === ACCOUNTS.retainedEarnings && leg.debit === 3_000_000n)).toBe(true);
  });

  it('handles contra-revenue balances with the correct closing side', () => {
    const returns = {
      accountCode: '4-1-02-001',
      normalBalance: 'debit' as const,
      debitTotal: 500_000n,
      creditTotal: 0n,
    };
    const result = computeClosing({
      revenueBalances: [revenue('4-1-01-001', 5_000_000n), returns],
      expenseBalances: [],
      registeredCapital: 50_000_000n,
    });
    expect(signedBalance(returns)).toBe(500_000n);
    expect(result.netProfit).toBe(4_500_000n);
    const summary = buildDraft(
      {
        eventType: 'closing.income_summary',
        entryType: 'closing',
        entryDate: '2026-03-20',
        descriptionFa: 'بستن با برگشتی',
        sourceType: 'closing_run',
      },
      result.incomeSummaryLegs,
    );
    assertDraft(summary);
    expect(summary.legs.some((leg) => leg.accountCode === '4-1-02-001' && leg.credit === 500_000n)).toBe(true);
  });
});
