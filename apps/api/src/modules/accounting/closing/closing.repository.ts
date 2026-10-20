import type { SqlSession } from '../persistence/sql-support';
/** Closing-run repository (`erp.closing_runs` + P&L / capital balance reads). */
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../../common/contracts';
import type { Db } from '../../../common/contracts';
import { conflict, notFound } from '../persistence/sql-support';
import type { NormalizedBalance } from '../posting/closing.rules';

export interface ClosingRunRecord {
  readonly id: bigint;
  readonly fiscalYearId: bigint;
  readonly runNo: string;
  readonly status: string;
  readonly netProfitAmount: bigint;
  readonly legalReservePercent: string;
  readonly legalReserveCapPercent: string;
  readonly legalReserveAmount: bigint;
  readonly retainedAmount: bigint;
  readonly incomeSummaryEntryId: bigint | null;
  readonly retainedEarningsEntryId: bigint | null;
  readonly legalReserveEntryId: bigint | null;
  readonly postedAt: string | null;
}

interface RunRow {
  id: string;
  fiscal_year_id: string;
  run_no: string;
  status: string;
  net_profit_amount: string;
  legal_reserve_percent: string;
  legal_reserve_cap_percent: string;
  legal_reserve_amount: string;
  retained_amount: string;
  income_summary_entry_id: string | null;
  retained_earnings_entry_id: string | null;
  legal_reserve_entry_id: string | null;
  posted_at: string | null;
}

function toRun(row: RunRow): ClosingRunRecord {
  return {
    id: BigInt(row.id),
    fiscalYearId: BigInt(row.fiscal_year_id),
    runNo: row.run_no,
    status: row.status,
    netProfitAmount: BigInt(row.net_profit_amount),
    legalReservePercent: row.legal_reserve_percent,
    legalReserveCapPercent: row.legal_reserve_cap_percent,
    legalReserveAmount: BigInt(row.legal_reserve_amount),
    retainedAmount: BigInt(row.retained_amount),
    incomeSummaryEntryId: row.income_summary_entry_id === null ? null : BigInt(row.income_summary_entry_id),
    retainedEarningsEntryId:
      row.retained_earnings_entry_id === null ? null : BigInt(row.retained_earnings_entry_id),
    legalReserveEntryId: row.legal_reserve_entry_id === null ? null : BigInt(row.legal_reserve_entry_id),
    postedAt: row.posted_at,
  };
}

@Injectable()
export class ClosingRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** P&L balances (income + expense) for the fiscal year. */
  async pnlBalances(tx: SqlSession, orgId: bigint, fiscalYearId: bigint): Promise<{
    readonly revenue: readonly NormalizedBalance[];
    readonly expenses: readonly NormalizedBalance[];
  }> {
    const rows = await tx<{
      code: string;
      account_type: string;
      normal_balance: string;
      debit: string;
      credit: string;
    }[]>`
      select a.code, a.account_type, a.normal_balance,
             sum(b.closing_debit_amount)::text as debit,
             sum(b.closing_credit_amount)::text as credit
        from erp.account_balances b
        join erp.chart_of_accounts a on a.id = b.account_id
       where b.organization_id = ${orgId.toString()}
         and b.fiscal_year_id = ${fiscalYearId.toString()}
         and a.account_type in ('income','expense')
       group by a.code, a.account_type, a.normal_balance
       having sum(b.closing_debit_amount) <> 0 or sum(b.closing_credit_amount) <> 0
       order by a.code`;
    const revenue: NormalizedBalance[] = [];
    const expenses: NormalizedBalance[] = [];
    for (const row of rows) {
      const balance: NormalizedBalance = {
        accountCode: row.code,
        normalBalance: row.normal_balance === 'debit' ? 'debit' : 'credit',
        debitTotal: BigInt(row.debit),
        creditTotal: BigInt(row.credit),
      };
      if (row.account_type === 'income') revenue.push(balance);
      else expenses.push(balance);
    }
    return { revenue, expenses };
  }

  /** Closing balance of a single account code (capital / reserve / retained). */
  async accountClosingBalance(
    tx: SqlSession,
    orgId: bigint,
    fiscalYearId: bigint,
    accountCode: string,
  ): Promise<{ readonly debit: bigint; readonly credit: bigint }> {
    const rows = await tx<{ debit: string; credit: string }[]>`
      select coalesce(sum(b.closing_debit_amount), 0)::text as debit,
             coalesce(sum(b.closing_credit_amount), 0)::text as credit
        from erp.account_balances b
        join erp.chart_of_accounts a on a.id = b.account_id
       where b.organization_id = ${orgId.toString()}
         and b.fiscal_year_id = ${fiscalYearId.toString()}
         and a.code = ${accountCode}`;
    const row = rows[0];
    return { debit: BigInt(row?.debit ?? '0'), credit: BigInt(row?.credit ?? '0') };
  }

  /** Balance-sheet closing balances used to build next-year opening entries. */
  async balanceSheetBalances(
    tx: SqlSession,
    orgId: bigint,
    fiscalYearId: bigint,
  ): Promise<readonly { accountCode: string; debit: bigint; credit: bigint }[]> {
    const rows = await tx<{ code: string; debit: string; credit: string }[]>`
      select a.code, sum(b.closing_debit_amount)::text as debit, sum(b.closing_credit_amount)::text as credit
        from erp.account_balances b
        join erp.chart_of_accounts a on a.id = b.account_id
       where b.organization_id = ${orgId.toString()}
         and b.fiscal_year_id = ${fiscalYearId.toString()}
         and a.account_type in ('asset','liability','equity')
       group by a.code
      having sum(b.closing_debit_amount) <> sum(b.closing_credit_amount)
       order by a.code`;
    return rows.map((row) => ({ accountCode: row.code, debit: BigInt(row.debit), credit: BigInt(row.credit) }));
  }

  async findRun(orgId: bigint, fiscalYearId: bigint, tx?: SqlSession): Promise<ClosingRunRecord | undefined> {
    const client = tx ?? this.db;
    const rows = await client<RunRow[]>`
      select id::text as id, fiscal_year_id::text as fiscal_year_id, run_no, status,
             net_profit_amount::text as net_profit_amount,
             legal_reserve_percent::text as legal_reserve_percent,
             legal_reserve_cap_percent::text as legal_reserve_cap_percent,
             legal_reserve_amount::text as legal_reserve_amount,
             retained_amount::text as retained_amount,
             income_summary_entry_id::text as income_summary_entry_id,
             retained_earnings_entry_id::text as retained_earnings_entry_id,
             legal_reserve_entry_id::text as legal_reserve_entry_id,
             posted_at::text as posted_at
        from erp.closing_runs
       where organization_id = ${orgId.toString()} and fiscal_year_id = ${fiscalYearId.toString()}`;
    const row = rows[0];
    return row === undefined ? undefined : toRun(row);
  }

  async createRun(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly fiscalYearId: bigint;
      readonly runNo: string;
      readonly netProfit: bigint;
      readonly legalReservePercent: string;
      readonly legalReserveCapPercent: string;
      readonly legalReserve: bigint;
      readonly retained: bigint;
      readonly createdBy: bigint | null;
    },
  ): Promise<ClosingRunRecord> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.closing_runs
        (organization_id, fiscal_year_id, run_no, status, net_profit_amount, legal_reserve_percent,
         legal_reserve_cap_percent, legal_reserve_amount, retained_amount, computed_at, created_by)
      values
        (${input.orgId.toString()}, ${input.fiscalYearId.toString()}, ${input.runNo}, 'computed',
         ${input.netProfit.toString()}, ${input.legalReservePercent}, ${input.legalReserveCapPercent},
         ${input.legalReserve.toString()}, ${input.retained.toString()}, now(),
         ${input.createdBy === null ? null : input.createdBy.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ایجاد اجرای بستن سال مالی انجام نشد.');
    const run = await this.findRun(input.orgId, input.fiscalYearId, tx);
    if (run === undefined) throw notFound('اجرای بستن سال مالی');
    return run;
  }

  async markPosted(
    tx: SqlSession,
    runId: bigint,
    entries: {
      readonly incomeSummaryEntryId: bigint;
      readonly retainedEarningsEntryId: bigint;
      readonly legalReserveEntryId: bigint | null;
    },
    actorId: bigint | null,
  ): Promise<void> {
    await tx`
      update erp.closing_runs
         set status = 'posted',
             income_summary_entry_id = ${entries.incomeSummaryEntryId.toString()}::bigint,
             retained_earnings_entry_id = ${entries.retainedEarningsEntryId.toString()}::bigint,
             legal_reserve_entry_id = ${entries.legalReserveEntryId === null ? null : entries.legalReserveEntryId.toString()}::bigint,
             posted_at = now(),
             posted_by = ${actorId === null ? null : actorId.toString()}::bigint
       where id = ${runId.toString()}`;
  }

  async listRuns(orgId: bigint): Promise<readonly ClosingRunRecord[]> {
    const rows = await this.db<RunRow[]>`
      select id::text as id, fiscal_year_id::text as fiscal_year_id, run_no, status,
             net_profit_amount::text as net_profit_amount,
             legal_reserve_percent::text as legal_reserve_percent,
             legal_reserve_cap_percent::text as legal_reserve_cap_percent,
             legal_reserve_amount::text as legal_reserve_amount,
             retained_amount::text as retained_amount,
             income_summary_entry_id::text as income_summary_entry_id,
             retained_earnings_entry_id::text as retained_earnings_entry_id,
             legal_reserve_entry_id::text as legal_reserve_entry_id,
             posted_at::text as posted_at
        from erp.closing_runs
       where organization_id = ${orgId.toString()}
       order by created_at desc`;
    return rows.map(toRun);
  }
}
