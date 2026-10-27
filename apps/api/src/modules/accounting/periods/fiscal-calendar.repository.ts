import type { SqlSession } from '../persistence/sql-support';
/** Fiscal year & period repository (owns `erp.fiscal_years` / `accounting_periods`). */
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../../common/contracts';
import type { Db } from '../../../common/contracts';
import { conflict, notFound } from '../persistence/sql-support';

export interface FiscalYearRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly organizationId: bigint;
  readonly code: string;
  readonly title: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: string;
  readonly closedAt: string | null;
  readonly closingRunId: bigint | null;
  readonly version: number;
}

export interface PeriodRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly fiscalYearId: bigint;
  readonly periodNo: number;
  readonly nameFa: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: string;
  readonly closedAt: string | null;
}

interface YearRow {
  id: string;
  public_id: string;
  organization_id: string;
  code: string;
  title: string;
  start_date: string;
  end_date: string;
  status: string;
  closed_at: string | null;
  closing_run_id: string | null;
  version: number;
}

interface PeriodRow {
  id: string;
  public_id: string;
  fiscal_year_id: string;
  period_no: number;
  name_fa: string;
  start_date: string;
  end_date: string;
  status: string;
  closed_at: string | null;
}

function toYear(row: YearRow): FiscalYearRecord {
  return {
    id: BigInt(row.id),
    publicId: row.public_id,
    organizationId: BigInt(row.organization_id),
    code: row.code,
    title: row.title,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    closedAt: row.closed_at,
    closingRunId: row.closing_run_id === null ? null : BigInt(row.closing_run_id),
    version: row.version,
  };
}

function toPeriod(row: PeriodRow): PeriodRecord {
  return {
    id: BigInt(row.id),
    publicId: row.public_id,
    fiscalYearId: BigInt(row.fiscal_year_id),
    periodNo: row.period_no,
    nameFa: row.name_fa,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    closedAt: row.closed_at,
  };
}

const YEAR_COLUMNS = `id::text as id, public_id::text as public_id, organization_id::text as organization_id,
  code, title, start_date::text as start_date, end_date::text as end_date, status,
  closed_at::text as closed_at, closing_run_id::text as closing_run_id, version`;
const PERIOD_COLUMNS = `id::text as id, public_id::text as public_id, fiscal_year_id::text as fiscal_year_id,
  period_no, name_fa, start_date::text as start_date, end_date::text as end_date, status, closed_at::text as closed_at`;

@Injectable()
export class FiscalCalendarRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listYears(orgId: bigint, status?: string): Promise<readonly FiscalYearRecord[]> {
    const rows = await this.db<YearRow[]>`
      select ${this.db.unsafe(YEAR_COLUMNS)}
        from erp.fiscal_years
       where organization_id = ${orgId.toString()}
         and (${status ?? null}::text is null or status = ${status ?? null})
       order by start_date desc`;
    return rows.map(toYear);
  }

  async findYear(orgId: bigint, id: bigint, tx?: SqlSession): Promise<FiscalYearRecord | undefined> {
    const client = tx ?? this.db;
    const rows = await client<YearRow[]>`
      select ${client.unsafe(YEAR_COLUMNS)}
        from erp.fiscal_years
       where organization_id = ${orgId.toString()} and id = ${id.toString()}`;
    const row = rows[0];
    return row === undefined ? undefined : toYear(row);
  }

  /** Locks the year row for close/reopen (fixed lock order: year → period). */
  async lockYear(tx: SqlSession, orgId: bigint, id: bigint): Promise<FiscalYearRecord> {
    const rows = await tx<YearRow[]>`
      select ${tx.unsafe(YEAR_COLUMNS)}
        from erp.fiscal_years
       where organization_id = ${orgId.toString()} and id = ${id.toString()}
       for update`;
    const row = rows[0];
    if (row === undefined) throw notFound('سال مالی');
    return toYear(row);
  }

  async insertYear(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly code: string;
      readonly title: string;
      readonly startDate: string;
      readonly endDate: string;
      readonly createdBy: bigint | null;
    },
  ): Promise<FiscalYearRecord> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.fiscal_years
        (organization_id, code, title, start_date, end_date, status, created_by)
      values
        (${input.orgId.toString()}, ${input.code}, ${input.title}, ${input.startDate}, ${input.endDate}, 'open',
         ${input.createdBy === null ? null : input.createdBy.toString()})
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ایجاد سال مالی انجام نشد.');
    const year = await this.findYear(input.orgId, BigInt(id), tx);
    if (year === undefined) throw notFound('سال مالی');
    return year;
  }

  async assertNoOverlap(tx: SqlSession, orgId: bigint, startDate: string, endDate: string): Promise<void> {
    const rows = await tx<{ count: string }[]>`
      select count(*)::text as count
        from erp.fiscal_years
       where organization_id = ${orgId.toString()}
         and daterange(start_date, end_date, '[]') && daterange(${startDate}::date, ${endDate}::date, '[]')`;
    if (Number(rows[0]?.count ?? '0') > 0) {
      throw conflict('بازه سال مالی با سال مالی دیگری همپوشانی دارد.');
    }
  }

  async insertPeriods(
    tx: SqlSession,
    fiscalYearId: bigint,
    periods: readonly { readonly periodNo: number; readonly nameFa: string; readonly startDate: string; readonly endDate: string }[],
  ): Promise<readonly PeriodRecord[]> {
    const created: PeriodRecord[] = [];
    for (const period of periods) {
      const rows = await tx<PeriodRow[]>`
        insert into erp.accounting_periods
          (fiscal_year_id, period_no, name_fa, start_date, end_date, status)
        values
          (${fiscalYearId.toString()}, ${period.periodNo}, ${period.nameFa}, ${period.startDate}, ${period.endDate}, 'open')
        returning ${tx.unsafe(PERIOD_COLUMNS)}`;
      const row = rows[0];
      if (row !== undefined) created.push(toPeriod(row));
    }
    return created;
  }

  async listPeriods(fiscalYearId: bigint, tx?: SqlSession, status?: string): Promise<readonly PeriodRecord[]> {
    const client = tx ?? this.db;
    const rows = await client<PeriodRow[]>`
      select ${client.unsafe(PERIOD_COLUMNS)}
        from erp.accounting_periods
       where fiscal_year_id = ${fiscalYearId.toString()}
         and (${status ?? null}::text is null or status = ${status ?? null})
       order by period_no`;
    return rows.map(toPeriod);
  }

  async findPeriod(id: bigint): Promise<PeriodRecord | undefined> {
    const rows = await this.db<PeriodRow[]>`
      select ${this.db.unsafe(PERIOD_COLUMNS)}
        from erp.accounting_periods where id = ${id.toString()}`;
    const row = rows[0];
    return row === undefined ? undefined : toPeriod(row);
  }

  /**
   * Resolves the period owning a legal date and locks **the period row**
   * (`FOR UPDATE OF p`) while posting (ARCHITECTURE §6, TD-19). The year is read
   * without a lock: closing takes year → period, so lock order is preserved
   * without a second lock and without a deadlock.
   *
   * Posting MUST pass the server-stored entry date here, never a caller-supplied
   * posting date; a concurrent close then blocks on this row until the posting
   * transaction commits or rolls back.
   */
  async resolveAndLockPeriod(
    tx: SqlSession,
    orgId: bigint,
    entryDate: string,
  ): Promise<{ readonly period: PeriodRecord; readonly year: FiscalYearRecord }> {
    const rows = await tx<PeriodRow[]>`
      select p.id::text as id, p.public_id::text as public_id, p.fiscal_year_id::text as fiscal_year_id,
             p.period_no, p.name_fa, p.start_date::text as start_date, p.end_date::text as end_date,
             p.status, p.closed_at::text as closed_at
        from erp.accounting_periods p
        join erp.fiscal_years y on y.id = p.fiscal_year_id
       where y.organization_id = ${orgId.toString()}
         and ${entryDate}::date between p.start_date and p.end_date
         and ${entryDate}::date between y.start_date and y.end_date
       order by p.period_no
       limit 1
       for update of p`;
    const row = rows[0];
    if (row === undefined) throw notFound('دوره مالی برای تاریخ سند');
    const period = toPeriod(row);
    const year = await this.findYear(orgId, period.fiscalYearId, tx);
    if (year === undefined) throw notFound('سال مالی');
    return { period, year };
  }

  async updatePeriodStatus(
    tx: SqlSession,
    id: bigint,
    status: string,
    actorId: bigint | null,
  ): Promise<void> {
    await tx`
      update erp.accounting_periods
         set status = ${status},
             closed_at = case when ${status} in ('closed','locked') then now() else null end,
             closed_by = case when ${status} in ('closed','locked') then ${actorId === null ? null : actorId.toString()}::bigint else null end,
             version = version + 1
       where id = ${id.toString()}`;
  }

  async updateYearStatus(
    tx: SqlSession,
    id: bigint,
    status: string,
    actorId: bigint | null,
  ): Promise<void> {
    await tx`
      update erp.fiscal_years
         set status = ${status},
             closed_at = case when ${status} = 'closed' then now() else null end,
             closed_by = case when ${status} = 'closed' then ${actorId === null ? null : actorId.toString()}::bigint else null end,
             version = version + 1
       where id = ${id.toString()}`;
  }

  async setClosingRun(tx: SqlSession, yearId: bigint, closingRunId: bigint): Promise<void> {
    await tx`
      update erp.fiscal_years
         set closing_run_id = ${closingRunId.toString()}::bigint, status = 'closing', version = version + 1
       where id = ${yearId.toString()}`;
  }

  async countUnpostedJournals(tx: SqlSession, fiscalYearId: bigint): Promise<number> {
    const rows = await tx<{ count: string }[]>`
      select count(*)::text as count
        from erp.journal_entries
       where fiscal_year_id = ${fiscalYearId.toString()} and status <> 'posted' and status <> 'voided'`;
    return Number(rows[0]?.count ?? '0');
  }

  async countOpenPeriods(tx: SqlSession, fiscalYearId: bigint): Promise<number> {
    const rows = await tx<{ count: string }[]>`
      select count(*)::text as count
        from erp.accounting_periods
       where fiscal_year_id = ${fiscalYearId.toString()} and status = 'open'`;
    return Number(rows[0]?.count ?? '0');
  }
}
