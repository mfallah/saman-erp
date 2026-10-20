/** Financial reports application service (posted data only). */
import { Injectable } from '@nestjs/common';
import { AppError } from '@saman/shared';
import type { TenantContext } from '../../../common/contracts';
import type { JournalRepository } from '../journal/journal.repository';
import { ACCOUNTS } from '../posting/accounts';
import { signedBalanceOf } from './accounting-reports.repository';
import type { BalanceRow, CashFlowRow, JournalBookRow, LedgerLineRow , AccountingReportsRepository} from './accounting-reports.repository';

export interface TrialBalanceRow {
  readonly accountCode: string;
  readonly nameFa: string;
  readonly accountType: string;
  readonly normalBalance: string;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly balance: bigint;
}

export interface ProfitAndLoss {
  readonly revenue: readonly TrialBalanceRow[];
  readonly expenses: readonly TrialBalanceRow[];
  readonly revenueTotal: bigint;
  readonly expenseTotal: bigint;
  readonly netProfit: bigint;
}

export interface BalanceSheet {
  readonly assets: readonly TrialBalanceRow[];
  readonly liabilities: readonly TrialBalanceRow[];
  readonly equity: readonly TrialBalanceRow[];
  readonly assetsTotal: bigint;
  readonly liabilitiesTotal: bigint;
  readonly equityTotal: bigint;
  readonly balanced: boolean;
}

@Injectable()
export class AccountingReportsService {
  constructor(
    private readonly journalRepo: JournalRepository,
    private readonly repo: AccountingReportsRepository,
  ) {}

  /**
   * Trial balance in trial-balance presentation: every account shows its movement
   * on its **normal** side, so contra balances reduce the group instead of
   * flipping it. Total debit must equal total credit.
   */
  async trialBalance(
    ctx: TenantContext,
    filter: { readonly fiscalYearId?: bigint; readonly periodId?: bigint },
  ): Promise<{ readonly rows: readonly TrialBalanceRow[]; readonly totalDebit: bigint; readonly totalCredit: bigint; readonly balanced: boolean }> {
    const balances = await this.journalRepo.balances(ctx.orgId, filter);
    const rows: TrialBalanceRow[] = [];
    let totalDebit = 0n;
    let totalCredit = 0n;
    for (const row of balances) {
      const signed = signedBalanceOf(row);
      const debit = row.normalBalance === 'debit'
        ? (signed > 0n ? signed : 0n)
        : (signed < 0n ? -signed : 0n);
      const credit = row.normalBalance === 'credit'
        ? (signed > 0n ? signed : 0n)
        : (signed < 0n ? -signed : 0n);
      if (debit === 0n && credit === 0n) continue;
      rows.push({
        accountCode: row.accountCode,
        nameFa: row.nameFa,
        accountType: row.accountType,
        normalBalance: row.normalBalance,
        debit,
        credit,
        balance: signed,
      });
      totalDebit += debit;
      totalCredit += credit;
    }
    return { rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
  }

  /** Income statement: revenue and expense groups with contra-aware signed totals. */
  async profitAndLoss(
    ctx: TenantContext,
    filter: { readonly fiscalYearId: bigint; readonly periodId?: bigint },
  ): Promise<ProfitAndLoss> {
    const { rows } = await this.trialBalance(ctx, filter);
    const revenue: TrialBalanceRow[] = [];
    const expenses: TrialBalanceRow[] = [];
    let revenueTotal = 0n;
    let expenseTotal = 0n;
    for (const row of rows) {
      if (row.accountType === 'income') {
        revenue.push(row);
        revenueTotal += row.balance;
      } else if (row.accountType === 'expense') {
        expenses.push(row);
        expenseTotal += row.balance;
      }
    }
    return { revenue, expenses, revenueTotal, expenseTotal, netProfit: revenueTotal - expenseTotal };
  }

  async balanceSheet(
    ctx: TenantContext,
    filter: { readonly fiscalYearId: bigint; readonly periodId?: bigint },
  ): Promise<BalanceSheet> {
    const { rows } = await this.trialBalance(ctx, filter);
    const assets = rows.filter((row) => row.accountType === 'asset');
    const liabilities = rows.filter((row) => row.accountType === 'liability');
    const equity = rows.filter((row) => row.accountType === 'equity');
    const sum = (list: readonly TrialBalanceRow[]): bigint =>
      list.reduce((acc, row) => acc + row.balance, 0n);
    const assetsTotal = sum(assets);
    const liabilitiesTotal = sum(liabilities);
    const equityTotal = sum(equity);
    return {
      assets,
      liabilities,
      equity,
      assetsTotal,
      liabilitiesTotal,
      equityTotal,
      balanced: assetsTotal === liabilitiesTotal + equityTotal,
    };
  }

  journalBook(
    ctx: TenantContext,
    filter: { readonly fiscalYearId?: bigint; readonly dateFrom?: string; readonly dateTo?: string; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly JournalBookRow[]> {
    return this.repo.journalBook(ctx.orgId, filter);
  }

  ledger(
    ctx: TenantContext,
    filter: { readonly accountId?: bigint; readonly dateFrom?: string; readonly dateTo?: string; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly LedgerLineRow[]> {
    return this.repo.ledger(ctx.orgId, filter);
  }

  subLedger(
    ctx: TenantContext,
    filter: { readonly partyType: string; readonly partyId?: bigint; readonly dateFrom?: string },
  ) {
    return this.repo.subLedger(ctx.orgId, filter);
  }

  cashFlow(
    ctx: TenantContext,
    filter: { readonly dateFrom?: string; readonly dateTo?: string },
  ): Promise<readonly CashFlowRow[]> {
    return this.repo.cashFlow(ctx.orgId, {
      accountCodes: [ACCOUNTS.bank, ACCOUNTS.cash, ACCOUNTS.gatewayClearing, ACCOUNTS.posClearing],
      ...filter,
    });
  }

  /** Account balance endpoint (`GET /accounting/accounts/{id}/balance`). */
  async accountBalance(
    ctx: TenantContext,
    accountId: bigint,
    filter: { readonly fiscalYearId?: bigint; readonly periodId?: bigint },
  ): Promise<{ readonly debit: bigint; readonly credit: bigint; readonly balance: bigint }> {
    const rows = await this.journalRepo.balances(ctx.orgId, { ...filter, accountId });
    const row: BalanceRow | undefined = rows[0];
    if (row === undefined) return { debit: 0n, credit: 0n, balance: 0n };
    return {
      debit: row.closingDebit,
      credit: row.closingCredit,
      balance: signedBalanceOf(row),
    };
  }

  /** Assertion used by period/year close checklist and tests. */
  async assertTrialBalance(ctx: TenantContext, fiscalYearId: bigint): Promise<void> {
    const trial = await this.trialBalance(ctx, { fiscalYearId });
    if (!trial.balanced) {
      throw new AppError('RULE_VIOLATION', {
        details: [
          {
            rule: 'trial_balance_unbalanced',
            params: { debit: trial.totalDebit.toString(), credit: trial.totalCredit.toString() },
          },
        ],
        message: 'تراز آزمایشی متوازن نیست.',
      });
    }
  }
}
