/** Profit distribution repository (`erp.profit_distribution_runs` / lines). */
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../common/contracts';
import type { Db } from '../../common/contracts';
import type { SqlSession } from '../accounting/persistence/sql-support';
import { conflict, notFound } from '../accounting/persistence/sql-support';

export interface ProfitRunRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly runNo: string;
  readonly fiscalYearId: bigint;
  readonly runDate: string;
  readonly totalProfitAmount: bigint;
  readonly distributedAmount: bigint;
  readonly status: string;
  readonly journalEntryId: bigint | null;
  readonly note: string | null;
}

export interface ProfitLineRecord {
  readonly id: bigint;
  readonly shareholderId: bigint;
  readonly ownershipPercent: string;
  readonly shareAmount: bigint;
  readonly paidAmount: bigint;
  readonly status: string;
}

const RUN_COLUMNS = `id::text as id, public_id::text as public_id, run_no, fiscal_year_id::text as fiscal_year_id,
  run_date::text as run_date, total_profit_amount::text as total_profit_amount,
  distributed_amount::text as distributed_amount, status, journal_entry_id::text as journal_entry_id, notes`;

type RunRow = {
  id: string; public_id: string; run_no: string; fiscal_year_id: string; run_date: string;
  total_profit_amount: string; distributed_amount: string; status: string;
  journal_entry_id: string | null; notes: string | null;
};

function toRun(row: RunRow): ProfitRunRecord {
  return {
    id: BigInt(row.id),
    publicId: row.public_id,
    runNo: row.run_no,
    fiscalYearId: BigInt(row.fiscal_year_id),
    runDate: row.run_date,
    totalProfitAmount: BigInt(row.total_profit_amount),
    distributedAmount: BigInt(row.distributed_amount),
    status: row.status,
    journalEntryId: row.journal_entry_id === null ? null : BigInt(row.journal_entry_id),
    note: row.notes,
  };
}

@Injectable()
export class ProfitRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Retained earnings balance (`3-2-01-001`) available for distribution. */
  async retainedBalance(tx: SqlSession, orgId: bigint, fiscalYearId: bigint): Promise<bigint> {
    const rows = await tx<{ balance: string }[]>`
      select coalesce(sum(b.closing_credit_amount - b.closing_debit_amount), 0)::text as balance
        from erp.account_balances b
        join erp.chart_of_accounts a on a.id = b.account_id
       where b.organization_id = ${orgId.toString()}
         and b.fiscal_year_id = ${fiscalYearId.toString()}
         and a.code = '3-2-01-001'`;
    return BigInt(rows[0]?.balance ?? '0');
  }

  /** Active ownership shares effective at the fiscal-year end. */
  async activeShares(
    tx: SqlSession,
    orgId: bigint,
    effectiveAt: string,
  ): Promise<readonly { shareholderId: bigint; ownershipPercent: string }[]> {
    const rows = await tx<{ id: string; ownership_percent: string }[]>`
      select id::text as id, ownership_percent::text as ownership_percent
        from erp.shareholders
       where organization_id = ${orgId.toString()}
         and deleted_at is null and is_active
         and ownership_percent > 0
         and (${effectiveAt}::date is null or true)
       order by code`;
    return rows.map((row) => ({
      shareholderId: BigInt(row.id),
      ownershipPercent: row.ownership_percent,
    }));
  }

  async findRun(orgId: bigint, id: bigint, tx?: SqlSession): Promise<ProfitRunRecord | undefined> {
    const client = tx ?? this.db;
    const rows = await client<RunRow[]>`
      select ${client.unsafe(RUN_COLUMNS)}
        from erp.profit_distribution_runs
       where organization_id = ${orgId.toString()} and id = ${id.toString()}`;
    const row = rows[0];
    return row === undefined ? undefined : toRun(row);
  }

  async findByYear(orgId: bigint, fiscalYearId: bigint): Promise<ProfitRunRecord | undefined> {
    const rows = await this.db<RunRow[]>`
      select ${this.db.unsafe(RUN_COLUMNS)}
        from erp.profit_distribution_runs
       where organization_id = ${orgId.toString()} and fiscal_year_id = ${fiscalYearId.toString()}
         and status <> 'cancelled'`;
    const row = rows[0];
    return row === undefined ? undefined : toRun(row);
  }

  async listRuns(orgId: bigint): Promise<readonly ProfitRunRecord[]> {
    const rows = await this.db<RunRow[]>`
      select ${this.db.unsafe(RUN_COLUMNS)}
        from erp.profit_distribution_runs
       where organization_id = ${orgId.toString()}
       order by run_date desc, id desc`;
    return rows.map(toRun);
  }

  async insertRun(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly fiscalYearId: bigint;
      readonly runNo: string;
      readonly runDate: string;
      readonly totalProfit: bigint;
      readonly distributed: bigint;
      readonly status: string;
      readonly note?: string;
      readonly createdBy: bigint | null;
    },
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.profit_distribution_runs
        (organization_id, fiscal_year_id, run_no, run_date, total_profit_amount,
         distributed_amount, status, notes, created_by)
      values
        (${input.orgId.toString()}, ${input.fiscalYearId.toString()}, ${input.runNo},
         ${input.runDate}, ${input.totalProfit.toString()}, ${input.distributed.toString()},
         ${input.status}, ${input.note ?? null},
         ${input.createdBy === null ? null : input.createdBy.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ایجاد اجرای توزیع سود انجام نشد.');
    return BigInt(id);
  }

  async insertLines(
    tx: SqlSession,
    runId: bigint,
    lines: readonly {
      readonly shareholderId: bigint;
      readonly ownershipPercent: string;
      readonly shareAmount: bigint;
    }[],
  ): Promise<void> {
    for (const line of lines) {
      await tx`
        insert into erp.profit_distribution_lines
          (run_id, shareholder_id, ownership_percent_snapshot, share_amount, paid_amount, status)
        values
          (${runId.toString()}, ${line.shareholderId.toString()}, ${line.ownershipPercent},
           ${line.shareAmount.toString()}, 0, 'pending')`;
    }
  }

  async lines(runId: bigint): Promise<readonly ProfitLineRecord[]> {
    const rows = await this.db<{
      id: string; shareholder_id: string; ownership_percent_snapshot: string;
      share_amount: string; paid_amount: string; status: string;
    }[]>`
      select id::text as id, shareholder_id::text as shareholder_id,
             ownership_percent_snapshot::text as ownership_percent_snapshot,
             share_amount::text as share_amount, paid_amount::text as paid_amount, status
        from erp.profit_distribution_lines where run_id = ${runId.toString()} order by id`;
    return rows.map((row) => ({
      id: BigInt(row.id),
      shareholderId: BigInt(row.shareholder_id),
      ownershipPercent: row.ownership_percent_snapshot,
      shareAmount: BigInt(row.share_amount),
      paidAmount: BigInt(row.paid_amount),
      status: row.status,
    }));
  }

  async setStatus(
    tx: SqlSession,
    id: bigint,
    from: readonly string[],
    to: string,
    extra: { readonly journalEntryId?: bigint } = {},
  ): Promise<void> {
    const rows = await tx<{ id: string }[]>`
      update erp.profit_distribution_runs
         set status = ${to},
             journal_entry_id = coalesce(${extra.journalEntryId === undefined ? null : extra.journalEntryId.toString()}::bigint, journal_entry_id),
             version = version + 1
       where id = ${id.toString()} and status = any(${[...from]})
      returning id::text as id`;
    if (rows.length === 0) throw conflict('وضعیت توزیع سود اجازه این تغییر را نمی‌دهد.');
  }

  async markLinesApproved(tx: SqlSession, runId: bigint): Promise<void> {
    await tx`
      update erp.profit_distribution_lines set status = 'approved'
       where run_id = ${runId.toString()} and status = 'pending'`;
  }

  async markLinesPaid(tx: SqlSession, runId: bigint, paymentId: bigint): Promise<void> {
    await tx`
      update erp.profit_distribution_lines
         set status = 'paid', paid_amount = share_amount, payment_id = ${paymentId.toString()}::bigint
       where run_id = ${runId.toString()} and status = 'approved'`;
  }

  async assertExists(orgId: bigint, id: bigint): Promise<ProfitRunRecord> {
    const run = await this.findRun(orgId, id);
    if (run === undefined) throw notFound('اجرای توزیع سود');
    return run;
  }
}
