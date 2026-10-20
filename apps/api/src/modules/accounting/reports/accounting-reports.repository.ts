/**
 * Financial report read models (trial balance, journal book, ledger, P&L, balance
 * sheet, cash-flow summary). Reports read posted rows only and never run inside a
 * write transaction (`ARCHITECTURE §6`).
 *
 * Signs are derived from `normal_balance`, never from `account_type`, so contra
 * accounts (returns, discounts, accumulated depreciation) present correctly
 * (`R1-accounting` B-04).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../../common/contracts';
import type { Db } from '../../../common/contracts';

export interface BalanceRow {
  readonly accountId: bigint;
  readonly accountCode: string;
  readonly nameFa: string;
  readonly accountType: string;
  readonly normalBalance: string;
  readonly openingDebit: bigint;
  readonly openingCredit: bigint;
  readonly periodDebit: bigint;
  readonly periodCredit: bigint;
  readonly closingDebit: bigint;
  readonly closingCredit: bigint;
}

/**
 * Signed balance **in the direction of its group** (asset/expense = debit,
 * liability/equity/income = credit). Contra accounts therefore present as a
 * negative amount inside their group instead of inflating it (B-04).
 */
export function signedBalanceOf(row: {
  readonly accountType?: string;
  readonly normalBalance: string;
  readonly closingDebit: bigint;
  readonly closingCredit: bigint;
}): bigint {
  const debitGroup = row.accountType === undefined
    ? row.normalBalance === 'debit'
    : row.accountType === 'asset' || row.accountType === 'expense';
  return debitGroup ? row.closingDebit - row.closingCredit : row.closingCredit - row.closingDebit;
}

/** Signed period movement, same group-direction rule (P&L / cash-flow). */
export function signedMovementOf(row: {
  readonly accountType?: string;
  readonly normalBalance: string;
  readonly periodDebit: bigint;
  readonly periodCredit: bigint;
}): bigint {
  const debitGroup = row.accountType === undefined
    ? row.normalBalance === 'debit'
    : row.accountType === 'asset' || row.accountType === 'expense';
  return debitGroup ? row.periodDebit - row.periodCredit : row.periodCredit - row.periodDebit;
}

export interface JournalBookRow {
  readonly journalId: bigint;
  readonly entryNo: string | null;
  readonly entryDate: string;
  readonly entryType: string;
  readonly description: string;
  readonly sourceType: string | null;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly lineCount: number;
}

export interface LedgerLineRow {
  readonly journalId: bigint;
  readonly entryNo: string | null;
  readonly entryDate: string;
  readonly accountId: bigint;
  readonly accountCode: string;
  readonly description: string | null;
  readonly journalDescription: string;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly partnerType: string | null;
  readonly partnerId: bigint | null;
}

export interface CashFlowRow {
  readonly bucket: string;
  readonly inflow: bigint;
  readonly outflow: bigint;
}

@Injectable()
export class AccountingReportsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async journalBook(
    orgId: bigint,
    filter: { readonly fiscalYearId?: bigint; readonly dateFrom?: string; readonly dateTo?: string; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly JournalBookRow[]> {
    const rows = await this.db<{
      id: string;
      entry_no: string | null;
      entry_date: string;
      entry_type: string;
      description: string;
      source_type: string | null;
      debit: string;
      credit: string;
      line_count: string;
    }[]>`
      select e.id::text as id, e.entry_no, e.entry_date::text as entry_date, e.entry_type,
             e.description, e.source_type,
             e.total_debit_amount::text as debit, e.total_credit_amount::text as credit,
             (select count(*)::text from erp.journal_lines l where l.journal_entry_id = e.id) as line_count
        from erp.journal_entries e
       where e.organization_id = ${orgId.toString()}
         and e.status = 'posted'
         and (${filter.fiscalYearId === undefined ? null : filter.fiscalYearId.toString()}::bigint is null or e.fiscal_year_id = ${filter.fiscalYearId === undefined ? null : filter.fiscalYearId.toString()}::bigint)
         and (${filter.dateFrom ?? null}::date is null or e.entry_date >= ${filter.dateFrom ?? null}::date)
         and (${filter.dateTo ?? null}::date is null or e.entry_date <= ${filter.dateTo ?? null}::date)
       order by e.entry_date, e.id
       limit ${filter.limit ?? 200} offset ${filter.offset ?? 0}`;
    return rows.map((row) => ({
      journalId: BigInt(row.id),
      entryNo: row.entry_no,
      entryDate: row.entry_date,
      entryType: row.entry_type,
      description: row.description,
      sourceType: row.source_type,
      debit: BigInt(row.debit),
      credit: BigInt(row.credit),
      lineCount: Number(row.line_count),
    }));
  }

  async ledger(
    orgId: bigint,
    filter: { readonly accountId?: bigint; readonly dateFrom?: string; readonly dateTo?: string; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly LedgerLineRow[]> {
    const rows = await this.db<{
      journal_id: string;
      entry_no: string | null;
      entry_date: string;
      account_id: string;
      code: string;
      description: string | null;
      journal_description: string;
      debit: string;
      credit: string;
      partner_type: string | null;
      partner_id: string | null;
    }[]>`
      select e.id::text as journal_id, e.entry_no, e.entry_date::text as entry_date,
             l.account_id::text as account_id, a.code, l.description,
             e.description as journal_description,
             l.debit_amount::text as debit, l.credit_amount::text as credit,
             l.partner_type, l.partner_id::text as partner_id
        from erp.journal_lines l
        join erp.journal_entries e on e.id = l.journal_entry_id
        join erp.chart_of_accounts a on a.id = l.account_id
       where e.organization_id = ${orgId.toString()}
         and e.status = 'posted'
         and (${filter.accountId === undefined ? null : filter.accountId.toString()}::bigint is null or l.account_id = ${filter.accountId === undefined ? null : filter.accountId.toString()}::bigint)
         and (${filter.dateFrom ?? null}::date is null or e.entry_date >= ${filter.dateFrom ?? null}::date)
         and (${filter.dateTo ?? null}::date is null or e.entry_date <= ${filter.dateTo ?? null}::date)
       order by e.entry_date, e.id, l.line_no
       limit ${filter.limit ?? 200} offset ${filter.offset ?? 0}`;
    return rows.map((row) => ({
      journalId: BigInt(row.journal_id),
      entryNo: row.entry_no,
      entryDate: row.entry_date,
      accountId: BigInt(row.account_id),
      accountCode: row.code,
      description: row.description,
      journalDescription: row.journal_description,
      debit: BigInt(row.debit),
      credit: BigInt(row.credit),
      partnerType: row.partner_type,
      partnerId: row.partner_id === null ? null : BigInt(row.partner_id),
    }));
  }

  /** Sub-ledger by party (AR/AP control reconciliation, API §4.11). */
  async subLedger(
    orgId: bigint,
    filter: { readonly partyType: string; readonly partyId?: bigint; readonly dateFrom?: string },
  ): Promise<readonly { partnerId: bigint | null; partnerType: string; debit: bigint; credit: bigint }[]> {
    const rows = await this.db<{ partner_id: string | null; partner_type: string; debit: string; credit: string }[]>`
      select l.partner_id::text as partner_id, l.partner_type,
             sum(l.debit_amount)::text as debit, sum(l.credit_amount)::text as credit
        from erp.journal_lines l
        join erp.journal_entries e on e.id = l.journal_entry_id
       where e.organization_id = ${orgId.toString()}
         and e.status = 'posted'
         and l.partner_type = ${filter.partyType}
         and (${filter.partyId === undefined ? null : filter.partyId.toString()}::bigint is null or l.partner_id = ${filter.partyId === undefined ? null : filter.partyId.toString()}::bigint)
         and (${filter.dateFrom ?? null}::date is null or e.entry_date >= ${filter.dateFrom ?? null}::date)
       group by l.partner_id, l.partner_type
       order by l.partner_id`;
    return rows.map((row) => ({
      partnerId: row.partner_id === null ? null : BigInt(row.partner_id),
      partnerType: row.partner_type,
      debit: BigInt(row.debit),
      credit: BigInt(row.credit),
    }));
  }

  /** Cash-flow summary buckets from bank/cash account movements. */
  async cashFlow(
    orgId: bigint,
    filter: { readonly accountCodes: readonly string[]; readonly dateFrom?: string; readonly dateTo?: string },
  ): Promise<readonly CashFlowRow[]> {
    if (filter.accountCodes.length === 0) return [];
    const rows = await this.db<{ bucket: string; inflow: string; outflow: string }[]>`
      select coalesce(e.source_type, e.entry_type) as bucket,
             coalesce(sum(l.debit_amount), 0)::text as inflow,
             coalesce(sum(l.credit_amount), 0)::text as outflow
        from erp.journal_lines l
        join erp.journal_entries e on e.id = l.journal_entry_id
        join erp.chart_of_accounts a on a.id = l.account_id
       where e.organization_id = ${orgId.toString()}
         and e.status = 'posted'
         and a.code = any(${[...filter.accountCodes]})
         and (${filter.dateFrom ?? null}::date is null or e.entry_date >= ${filter.dateFrom ?? null}::date)
         and (${filter.dateTo ?? null}::date is null or e.entry_date <= ${filter.dateTo ?? null}::date)
       group by coalesce(e.source_type, e.entry_type)
       order by bucket`;
    return rows.map((row) => ({
      bucket: row.bucket,
      inflow: BigInt(row.inflow),
      outflow: BigInt(row.outflow),
    }));
  }
}
