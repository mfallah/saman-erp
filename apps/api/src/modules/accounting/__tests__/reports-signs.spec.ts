/** Report signs derive from `normal_balance`, never from `account_type` (B-04). */
import { describe, expect, it } from 'vitest';
import { signedBalanceOf, signedMovementOf } from '../reports/accounting-reports.repository';

describe('report sign derivation', () => {
  it('presents a contra-asset with a credit balance as negative', () => {
    expect(
      signedBalanceOf({ accountType: 'asset', normalBalance: 'credit', closingDebit: 0n, closingCredit: 200_000n }),
    ).toBe(-200_000n);
  });

  it('presents contra-revenue as a reduction of revenue', () => {
    expect(
      signedBalanceOf({ accountType: 'income', normalBalance: 'debit', closingDebit: 300_000n, closingCredit: 0n }),
    ).toBe(-300_000n);
  });

  it('keeps normal asset and liability signs positive', () => {
    expect(signedBalanceOf({ accountType: 'asset', normalBalance: 'debit', closingDebit: 500n, closingCredit: 0n })).toBe(500n);
    expect(signedBalanceOf({ accountType: 'liability', normalBalance: 'credit', closingDebit: 0n, closingCredit: 700n })).toBe(700n);
  });

  it('derives period movement signs for the P&L', () => {
    expect(signedMovementOf({ accountType: 'income', normalBalance: 'credit', periodDebit: 0n, periodCredit: 1_000n })).toBe(1_000n);
    expect(signedMovementOf({ accountType: 'expense', normalBalance: 'debit', periodDebit: 250n, periodCredit: 0n })).toBe(250n);
    expect(signedMovementOf({ accountType: 'expense', normalBalance: 'debit', periodDebit: 0n, periodCredit: 250n })).toBe(-250n);
  });
});
