import type { SqlSession } from '../persistence/sql-support';
/** Journal repository — owns `erp.journal_entries`, `journal_lines`, `account_balances`. */
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../../common/contracts';
import type { Db } from '../../../common/contracts';
import { conflict, moneyParam, notFound, normalisePagination } from '../persistence/sql-support';
import type { Pagination } from '../persistence/sql-support';

export interface JournalLineRecord {
  readonly id: bigint;
  readonly lineNo: number;
  readonly accountId: bigint;
  readonly accountCode: string;
  readonly debitAmount: bigint;
  readonly creditAmount: bigint;
  readonly description: string | null;
  readonly partnerType: string | null;
  readonly partnerId: bigint | null;
}

export interface JournalRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly organizationId: bigint;
  readonly entryNo: string | null;
  readonly entryDate: string;
  readonly entryType: string;
  readonly status: string;
  readonly description: string;
  readonly fiscalYearId: bigint;
  readonly periodId: bigint;
  readonly totalDebitAmount: bigint;
  readonly totalCreditAmount: bigint;
  readonly sourceType: string | null;
  readonly sourceId: bigint | null;
  readonly reversalOfId: bigint | null;
  readonly postingRuleSetId: bigint | null;
  readonly postedAt: string | null;
  readonly createdBy: bigint | null;
  readonly version: number;
  readonly lines: readonly JournalLineRecord[];
}

export interface JournalLineInput {
  readonly accountId: bigint;
  readonly debitAmount: bigint;
  readonly creditAmount: bigint;
  readonly description?: string;
  readonly partnerType?: string;
  readonly partnerId?: bigint;
  readonly taxRateId?: bigint;
}

export interface JournalHeaderInput {
  readonly orgId: bigint;
  readonly fiscalYearId: bigint;
  readonly periodId: bigint;
  readonly entryDate: string;
  readonly entryType: string;
  readonly description: string;
  readonly sourceType?: string;
  readonly sourceId?: bigint;
  readonly sourcePublicId?: string;
  readonly sourceEventUuid?: string;
  readonly postingRuleSetId?: bigint;
  /** Pre-allocated number, required when inserting a posted entry directly. */
  readonly entryNo?: string;
  readonly createdBy: bigint | null;
}

export interface JournalFilter {
  readonly status?: string;
  readonly entryType?: string;
  readonly fiscalYearId?: bigint;
  readonly periodId?: bigint;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly sourceType?: string;
  readonly sourceId?: bigint;
  readonly page?: { readonly limit?: number; readonly offset?: number };
}

interface JournalRow {
  id: string;
  public_id: string;
  organization_id: string;
  entry_no: string | null;
  entry_date: string;
  entry_type: string;
  status: string;
  description: string;
  fiscal_year_id: string;
  period_id: string;
  total_debit_amount: string;
  total_credit_amount: string;
  source_type: string | null;
  source_id: string | null;
  reversal_of_id: string | null;
  posting_rule_set_id: string | null;
  posted_at: string | null;
  created_by: string | null;
  version: number;
}

interface LineRow {
  id: string;
  line_no: number;
  account_id: string;
  account_code: string;
  debit_amount: string;
  credit_amount: string;
  description: string | null;
  partner_type: string | null;
  partner_id: string | null;
}

const JOURNAL_COLUMNS = `e.id::text as id, e.public_id::text as public_id, e.organization_id::text as organization_id,
  e.entry_no, e.entry_date::text as entry_date, e.entry_type, e.status, e.description,
  e.fiscal_year_id::text as fiscal_year_id, e.period_id::text as period_id,
  e.total_debit_amount::text as total_debit_amount, e.total_credit_amount::text as total_credit_amount,
  e.source_type, e.source_id::text as source_id, e.reversal_of_id::text as reversal_of_id,
  e.posting_rule_set_id::text as posting_rule_set_id, e.posted_at::text as posted_at,
  e.created_by::text as created_by, e.version`;

const LINE_COLUMNS = `l.id::text as id, l.line_no, l.account_id::text as account_id, a.code as account_code,
  l.debit_amount::text as debit_amount, l.credit_amount::text as credit_amount, l.description,
  l.partner_type, l.partner_id::text as partner_id`;

function toLine(row: LineRow): JournalLineRecord {
  return {
    id: BigInt(row.id),
    lineNo: row.line_no,
    accountId: BigInt(row.account_id),
    accountCode: row.account_code,
    debitAmount: BigInt(row.debit_amount),
    creditAmount: BigInt(row.credit_amount),
    description: row.description,
    partnerType: row.partner_type,
    partnerId: row.partner_id === null ? null : BigInt(row.partner_id),
  };
}

@Injectable()
export class JournalRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(orgId: bigint, filter: JournalFilter = {}): Promise<readonly JournalRecord[]> {
    const page = normalisePagination(filter.page ?? {});
    const rows = await this.db<JournalRow[]>`
      select ${this.db.unsafe(JOURNAL_COLUMNS)}
        from erp.journal_entries e
       where e.organization_id = ${orgId.toString()}
         and (${filter.status ?? null}::text is null or e.status = ${filter.status ?? null})
         and (${filter.entryType ?? null}::text is null or e.entry_type = ${filter.entryType ?? null})
         and (${filter.fiscalYearId === undefined ? null : filter.fiscalYearId.toString()}::bigint is null or e.fiscal_year_id = ${filter.fiscalYearId === undefined ? null : filter.fiscalYearId.toString()}::bigint)
         and (${filter.periodId === undefined ? null : filter.periodId.toString()}::bigint is null or e.period_id = ${filter.periodId === undefined ? null : filter.periodId.toString()}::bigint)
         and (${filter.dateFrom ?? null}::date is null or e.entry_date >= ${filter.dateFrom ?? null}::date)
         and (${filter.dateTo ?? null}::date is null or e.entry_date <= ${filter.dateTo ?? null}::date)
         and (${filter.sourceType ?? null}::text is null or e.source_type = ${filter.sourceType ?? null})
         and (${filter.sourceId === undefined ? null : filter.sourceId.toString()}::bigint is null or e.source_id = ${filter.sourceId === undefined ? null : filter.sourceId.toString()}::bigint)
       order by e.entry_date desc, e.id desc
       limit ${page.limit} offset ${page.offset}`;
    return Promise.all(rows.map(async (row) => this.toRecord(row)));
  }

  async idByPublicId(orgId: bigint, publicId: string, tx?: SqlSession): Promise<bigint | null> {
    const db = tx ?? this.db;
    const rows = await db<{ id: string }[]>`
      select id::text as id from erp.journal_entries
       where organization_id = ${orgId.toString()} and public_id = ${publicId}::uuid
       limit 1`;
    const row = rows[0];
    return row === undefined ? null : BigInt(row.id);
  }

  async findById(orgId: bigint, id: bigint, tx?: SqlSession): Promise<JournalRecord | undefined> {
    const client = tx ?? this.db;
    const rows = await client<JournalRow[]>`
      select ${client.unsafe(JOURNAL_COLUMNS)}
        from erp.journal_entries e
       where e.organization_id = ${orgId.toString()} and e.id = ${id.toString()}`;
    const row = rows[0];
    return row === undefined ? undefined : this.toRecord(row);
  }

  async findBySourceEvent(tx: SqlSession, orgId: bigint, sourceEventUuid: string): Promise<JournalRecord | undefined> {
    const rows = await tx<JournalRow[]>`
      select ${tx.unsafe(JOURNAL_COLUMNS)}
        from erp.journal_entries e
       where e.organization_id = ${orgId.toString()} and e.source_event_uuid = ${sourceEventUuid}::uuid`;
    const row = rows[0];
    return row === undefined ? undefined : this.toRecord(row);
  }

  private async loadLines(client: SqlSession, entryId: bigint): Promise<readonly JournalLineRecord[]> {
    const rows = await client<LineRow[]>`
      select ${client.unsafe(LINE_COLUMNS)}
        from erp.journal_lines l
        join erp.chart_of_accounts a on a.id = l.account_id
       where l.journal_entry_id = ${entryId.toString()}
       order by l.line_no`;
    return rows.map(toLine);
  }

  private async toRecord(row: JournalRow): Promise<JournalRecord> {
    const lines = await this.loadLines(this.db, BigInt(row.id));
    return {
      id: BigInt(row.id),
      publicId: row.public_id,
      organizationId: BigInt(row.organization_id),
      entryNo: row.entry_no,
      entryDate: row.entry_date,
      entryType: row.entry_type,
      status: row.status,
      description: row.description,
      fiscalYearId: BigInt(row.fiscal_year_id),
      periodId: BigInt(row.period_id),
      totalDebitAmount: BigInt(row.total_debit_amount),
      totalCreditAmount: BigInt(row.total_credit_amount),
      sourceType: row.source_type,
      sourceId: row.source_id === null ? null : BigInt(row.source_id),
      reversalOfId: row.reversal_of_id === null ? null : BigInt(row.reversal_of_id),
      postingRuleSetId: row.posting_rule_set_id === null ? null : BigInt(row.posting_rule_set_id),
      postedAt: row.posted_at,
      createdBy: row.created_by === null ? null : BigInt(row.created_by),
      version: row.version,
      lines,
    };
  }

  async insertEntry(
    tx: SqlSession,
    header: JournalHeaderInput,
    lines: readonly JournalLineInput[],
    totals: { readonly debit: bigint; readonly credit: bigint },
    status: string,
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.journal_entries
        (organization_id, fiscal_year_id, period_id, entry_no, entry_date, business_date, entry_type, source_type,
         source_id, source_public_id, source_event_uuid, description, status, total_debit_amount,
         total_credit_amount, posting_rule_set_id, created_by)
      values
        (${header.orgId.toString()}, ${header.fiscalYearId.toString()}, ${header.periodId.toString()},
         ${header.entryNo ?? null},
         ${header.entryDate}, ${header.entryDate}, ${header.entryType}, ${header.sourceType ?? null},
         ${header.sourceId === undefined ? null : header.sourceId.toString()}::bigint,
         ${header.sourcePublicId ?? null}::uuid,
         ${header.sourceEventUuid ?? null}::uuid,
         ${header.description}, ${status}, ${moneyParam(totals.debit)}, ${moneyParam(totals.credit)},
         ${header.postingRuleSetId === undefined ? null : header.postingRuleSetId.toString()}::bigint,
         ${header.createdBy === null ? null : header.createdBy.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ایجاد سند حسابداری انجام نشد.');
    const entryId = BigInt(id);
    let lineNo = 1;
    for (const line of lines) {
      await tx`
        insert into erp.journal_lines
          (journal_entry_id, line_no, account_id, debit_amount, credit_amount, description,
           partner_type, partner_id, tax_rate_id)
        values
          (${entryId.toString()}, ${lineNo}, ${line.accountId.toString()},
           ${moneyParam(line.debitAmount)}, ${moneyParam(line.creditAmount)},
           ${line.description ?? null}, ${line.partnerType ?? null},
           ${line.partnerId === undefined ? null : line.partnerId.toString()}::bigint,
           ${line.taxRateId === undefined ? null : line.taxRateId.toString()}::bigint)`;
      lineNo += 1;
    }
    return entryId;
  }

  async replaceLines(tx: SqlSession, entryId: bigint, lines: readonly JournalLineInput[]): Promise<void> {
    await tx`delete from erp.journal_lines where journal_entry_id = ${entryId.toString()}`;
    let lineNo = 1;
    for (const line of lines) {
      await tx`
        insert into erp.journal_lines
          (journal_entry_id, line_no, account_id, debit_amount, credit_amount, description, partner_type, partner_id)
        values
          (${entryId.toString()}, ${lineNo}, ${line.accountId.toString()},
           ${moneyParam(line.debitAmount)}, ${moneyParam(line.creditAmount)},
           ${line.description ?? null}, ${line.partnerType ?? null},
           ${line.partnerId === undefined ? null : line.partnerId.toString()}::bigint)`;
      lineNo += 1;
    }
  }

  async updateTotals(tx: SqlSession, entryId: bigint, totals: { readonly debit: bigint; readonly credit: bigint }): Promise<void> {
    await tx`
      update erp.journal_entries
         set total_debit_amount = ${moneyParam(totals.debit)},
             total_credit_amount = ${moneyParam(totals.credit)},
             version = version + 1
       where id = ${entryId.toString()}`;
  }

  /**
   * Re-points a draft at the period that owns its (server-validated) entry date.
   * Posting derives the period from the stored date, so a draft edited after
   * creation cannot keep a stale `period_id` (TD-19).
   */
  async assignPeriod(tx: SqlSession, entryId: bigint, periodId: bigint, fiscalYearId: bigint): Promise<void> {
    await tx`
      update erp.journal_entries
         set period_id = ${periodId.toString()},
             fiscal_year_id = ${fiscalYearId.toString()},
             version = version + 1
       where id = ${entryId.toString()}`;
  }

  async updateDraft(
    tx: SqlSession,
    entryId: bigint,
    input: { readonly description?: string; readonly entryDate?: string },
    expectedVersion: number,
  ): Promise<void> {
    const rows = await tx<{ id: string }[]>`
      update erp.journal_entries
         set description = coalesce(${input.description ?? null}, description),
             entry_date = coalesce(${input.entryDate ?? null}::date, entry_date),
             business_date = coalesce(${input.entryDate ?? null}::date, business_date),
             version = version + 1
       where id = ${entryId.toString()} and status = 'draft' and version = ${expectedVersion}
      returning id::text as id`;
    if (rows.length === 0) {
      throw conflict('سند قابل ویرایش نیست یا نسخه آن تغییر کرده است.');
    }
  }

  async setStatus(
    tx: SqlSession,
    entryId: bigint,
    from: readonly string[],
    to: string,
    actorId: bigint | null,
  ): Promise<void> {
    const rows = await tx<{ id: string }[]>`
      update erp.journal_entries
         set status = ${to},
             posted_at = case when ${to} = 'posted' then now() else posted_at end,
             posted_by = case when ${to} = 'posted' then ${actorId === null ? null : actorId.toString()}::bigint else posted_by end,
             version = version + 1
       where id = ${entryId.toString()} and status = any(${[...from]})
      returning id::text as id`;
    if (rows.length === 0) {
      throw conflict('وضعیت سند اجازه این تغییر را نمی‌دهد.');
    }
  }

  async deleteDraft(tx: SqlSession, entryId: bigint): Promise<void> {
    const rows = await tx<{ id: string }[]>`
      delete from erp.journal_entries
       where id = ${entryId.toString()} and status = 'draft'
      returning id::text as id`;
    if (rows.length === 0) {
      throw conflict('تنها سند پیش‌نویس قابل حذف است.');
    }
    await tx`delete from erp.journal_lines where journal_entry_id = ${entryId.toString()}`;
  }

  /** Gap-free number allocation (`numbering_sequences … FOR UPDATE`). */
  async allocateEntryNo(
    tx: SqlSession,
    orgId: bigint,
    fiscalYearId: bigint,
    documentType: string,
    prefix: string,
  ): Promise<string> {
    const rows = await tx<{ next_value: string; prefix: string }[]>`
      select next_value::text as next_value, prefix
        from erp.numbering_sequences
       where organization_id = ${orgId.toString()}
         and document_type = ${documentType}
         and fiscal_year_id = ${fiscalYearId.toString()}
       for update`;
    let nextValue: bigint;
    let effectivePrefix = prefix;
    const row = rows[0];
    if (row === undefined) {
      await tx`
        insert into erp.numbering_sequences
          (organization_id, document_type, fiscal_year_id, prefix, next_value)
        values (${orgId.toString()}, ${documentType}, ${fiscalYearId.toString()}, ${prefix}, 2)`;
      nextValue = 1n;
    } else {
      effectivePrefix = row.prefix;
      nextValue = BigInt(row.next_value);
      await tx`
        update erp.numbering_sequences
           set next_value = ${(nextValue + 1n).toString()}, updated_at = now()
         where organization_id = ${orgId.toString()}
           and document_type = ${documentType}
           and fiscal_year_id = ${fiscalYearId.toString()}`;
    }
    const serial = nextValue.toString().padStart(6, '0');
    const yearRows = await tx<{ code: string }[]>`
      select code from erp.fiscal_years where id = ${fiscalYearId.toString()}`;
    const yearCode = yearRows[0]?.code ?? '';
    return `${effectivePrefix}-${yearCode}-${serial}`;
  }

  async setEntryNo(tx: SqlSession, entryId: bigint, entryNo: string): Promise<void> {
    await tx`
      update erp.journal_entries set entry_no = ${entryNo}, version = version + 1
       where id = ${entryId.toString()}`;
  }

  /**
   * Applies posted lines to `account_balances` in the fixed lock order
   * (`period → account_id asc`, `R1-datamodel` M-10) to avoid deadlocks.
   */
  async applyBalances(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly fiscalYearId: bigint;
      readonly periodId: bigint;
      readonly lines: readonly { readonly accountId: bigint; readonly debit: bigint; readonly credit: bigint }[];
      readonly lastJournalLineId?: bigint;
    },
  ): Promise<void> {
    const aggregate = new Map<string, { accountId: bigint; debit: bigint; credit: bigint }>();
    for (const line of input.lines) {
      const key = line.accountId.toString();
      const current = aggregate.get(key) ?? { accountId: line.accountId, debit: 0n, credit: 0n };
      aggregate.set(key, {
        accountId: line.accountId,
        debit: current.debit + line.debit,
        credit: current.credit + line.credit,
      });
    }
    const ordered = [...aggregate.values()].sort((left, right) => (left.accountId < right.accountId ? -1 : left.accountId > right.accountId ? 1 : 0));
    if (ordered.length === 0) return;

    const accountIds = ordered.map((row) => row.accountId.toString());
    await tx`
      select id from erp.account_balances
       where period_id = ${input.periodId.toString()}
         and account_id = any(${accountIds}::bigint[])
       order by account_id
       for update`;

    for (const row of ordered) {
      const existing = await tx<{ id: string; period_debit_amount: string; period_credit_amount: string; opening_debit_amount: string; opening_credit_amount: string }[]>`
        select id::text as id, period_debit_amount::text as period_debit_amount,
               period_credit_amount::text as period_credit_amount,
               opening_debit_amount::text as opening_debit_amount,
               opening_credit_amount::text as opening_credit_amount
          from erp.account_balances
         where period_id = ${input.periodId.toString()}
           and account_id = ${row.accountId.toString()}`;
      const current = existing[0];
      const periodDebit = BigInt(current?.period_debit_amount ?? '0') + row.debit;
      const periodCredit = BigInt(current?.period_credit_amount ?? '0') + row.credit;
      const openingDebit = BigInt(current?.opening_debit_amount ?? '0');
      const openingCredit = BigInt(current?.opening_credit_amount ?? '0');
      const closingDebit = openingDebit + periodDebit;
      const closingCredit = openingCredit + periodCredit;
      if (current === undefined) {
        await tx`
          insert into erp.account_balances
            (organization_id, fiscal_year_id, period_id, account_id,
             opening_debit_amount, opening_credit_amount, period_debit_amount, period_credit_amount,
             closing_debit_amount, closing_credit_amount, last_journal_line_id)
          values
            (${input.orgId.toString()}, ${input.fiscalYearId.toString()}, ${input.periodId.toString()},
             ${row.accountId.toString()}, 0, 0, ${moneyParam(periodDebit)}, ${moneyParam(periodCredit)},
             ${moneyParam(closingDebit)}, ${moneyParam(closingCredit)},
             ${input.lastJournalLineId === undefined ? null : input.lastJournalLineId.toString()}::bigint)`;
      } else {
        await tx`
          update erp.account_balances
             set period_debit_amount = ${moneyParam(periodDebit)},
                 period_credit_amount = ${moneyParam(periodCredit)},
                 closing_debit_amount = ${moneyParam(closingDebit)},
                 closing_credit_amount = ${moneyParam(closingCredit)},
                 last_journal_line_id = ${input.lastJournalLineId === undefined ? null : input.lastJournalLineId.toString()}::bigint,
                 updated_at = now()
           where id = ${current.id}`;
      }
    }
  }

  async assertExists(orgId: bigint, id: bigint): Promise<void> {
    const entry = await this.findById(orgId, id);
    if (entry === undefined) throw notFound('سند حسابداری');
  }

  /** Account balance rows for trial balance / P&L / balance sheet read models. */
  async balances(
    orgId: bigint,
    filter: { readonly fiscalYearId?: bigint; readonly periodId?: bigint; readonly accountId?: bigint },
  ): Promise<readonly {
    accountId: bigint;
    accountCode: string;
    nameFa: string;
    accountType: string;
    normalBalance: string;
    openingDebit: bigint;
    openingCredit: bigint;
    periodDebit: bigint;
    periodCredit: bigint;
    closingDebit: bigint;
    closingCredit: bigint;
  }[]> {
    const rows = await this.db<{
      account_id: string;
      code: string;
      name_fa: string;
      account_type: string;
      normal_balance: string;
      opening_debit: string;
      opening_credit: string;
      period_debit: string;
      period_credit: string;
      closing_debit: string;
      closing_credit: string;
    }[]>`
      select b.account_id::text as account_id, a.code, a.name_fa, a.account_type, a.normal_balance,
             sum(b.opening_debit_amount)::text as opening_debit,
             sum(b.opening_credit_amount)::text as opening_credit,
             sum(b.period_debit_amount)::text as period_debit,
             sum(b.period_credit_amount)::text as period_credit,
             sum(b.closing_debit_amount)::text as closing_debit,
             sum(b.closing_credit_amount)::text as closing_credit
        from erp.account_balances b
        join erp.chart_of_accounts a on a.id = b.account_id
       where b.organization_id = ${orgId.toString()}
         and (${filter.fiscalYearId === undefined ? null : filter.fiscalYearId.toString()}::bigint is null or b.fiscal_year_id = ${filter.fiscalYearId === undefined ? null : filter.fiscalYearId.toString()}::bigint)
         and (${filter.periodId === undefined ? null : filter.periodId.toString()}::bigint is null or b.period_id = ${filter.periodId === undefined ? null : filter.periodId.toString()}::bigint)
         and (${filter.accountId === undefined ? null : filter.accountId.toString()}::bigint is null or b.account_id = ${filter.accountId === undefined ? null : filter.accountId.toString()}::bigint)
       group by b.account_id, a.code, a.name_fa, a.account_type, a.normal_balance
       order by a.code`;
    return rows.map((row) => ({
      accountId: BigInt(row.account_id),
      accountCode: row.code,
      nameFa: row.name_fa,
      accountType: row.account_type,
      normalBalance: row.normal_balance,
      openingDebit: BigInt(row.opening_debit),
      openingCredit: BigInt(row.opening_credit),
      periodDebit: BigInt(row.period_debit),
      periodCredit: BigInt(row.period_credit),
      closingDebit: BigInt(row.closing_debit),
      closingCredit: BigInt(row.closing_credit),
    }));
  }
}
