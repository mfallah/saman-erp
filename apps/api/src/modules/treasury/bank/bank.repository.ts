/** Bank repository: accounts, statement imports, reconciliations. */
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../../common/contracts';
import type { Db } from '../../../common/contracts';
import type { SqlSession } from '../persistence/sql-support';
import { conflict, notFound } from '../persistence/sql-support';

export interface BankAccountRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly code: string;
  readonly bankName: string;
  readonly accountNo: string;
  readonly iban: string | null;
  readonly glAccountId: bigint;
  readonly openingBalanceAmount: bigint;
  readonly currentBalanceAmount: bigint;
  readonly isActive: boolean;
  readonly version: number;
}

export interface StatementLineRecord {
  readonly id: bigint;
  readonly lineNo: number;
  readonly valueDate: string;
  readonly direction: string;
  readonly amount: bigint;
  readonly description: string | null;
  readonly bankReference: string | null;
  readonly matchStatus: string;
  readonly matchedBankTransactionId: bigint | null;
}

@Injectable()
export class BankRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listAccounts(orgId: bigint, filter: { readonly active?: boolean; readonly bankName?: string }): Promise<readonly BankAccountRecord[]> {
    const rows = await this.db<{
      id: string; public_id: string; code: string; bank_name: string; account_no: string; iban: string | null;
      gl_account_id: string; opening_balance_amount: string; current_balance_amount: string;
      is_active: boolean; version: number;
    }[]>`
      select id::text as id, public_id::text as public_id, code, bank_name, account_no, iban,
             gl_account_id::text as gl_account_id,
             opening_balance_amount::text as opening_balance_amount,
             current_balance_amount::text as current_balance_amount, is_active, version
        from erp.bank_accounts
       where organization_id = ${orgId.toString()} and deleted_at is null
         and (${filter.active ?? null}::boolean is null or is_active = ${filter.active ?? null})
         and (${filter.bankName ?? null}::text is null or bank_name = ${filter.bankName ?? null})
       order by code`;
    return rows.map((row) => ({
      id: BigInt(row.id),
      publicId: row.public_id,
      code: row.code,
      bankName: row.bank_name,
      accountNo: row.account_no,
      iban: row.iban,
      glAccountId: BigInt(row.gl_account_id),
      openingBalanceAmount: BigInt(row.opening_balance_amount),
      currentBalanceAmount: BigInt(row.current_balance_amount),
      isActive: row.is_active,
      version: row.version,
    }));
  }

  async findAccount(orgId: bigint, id: bigint): Promise<BankAccountRecord | undefined> {
    const rows = await this.listAccounts(orgId, {});
    return rows.find((row) => row.id === id);
  }

  async insertAccount(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly code: string;
      readonly bankName: string;
      readonly accountNo: string;
      readonly iban?: string;
      readonly glAccountId: bigint;
      readonly branchId?: bigint;
      readonly openingBalance: bigint;
      readonly createdBy: bigint | null;
    },
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.bank_accounts
        (organization_id, code, bank_name, account_no, iban, gl_account_id, branch_id,
         opening_balance_amount, current_balance_amount, is_active, created_by)
      values
        (${input.orgId.toString()}, ${input.code}, ${input.bankName}, ${input.accountNo},
         ${input.iban ?? null}, ${input.glAccountId.toString()},
         ${input.branchId === undefined ? null : input.branchId.toString()}::bigint,
         ${input.openingBalance.toString()}, ${input.openingBalance.toString()}, true,
         ${input.createdBy === null ? null : input.createdBy.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ایجاد حساب بانکی انجام نشد.');
    return BigInt(id);
  }

  async updateAccount(
    tx: SqlSession,
    orgId: bigint,
    id: bigint,
    input: { readonly bankName?: string; readonly glAccountId?: bigint; readonly isActive?: boolean },
    expectedVersion: number,
  ): Promise<void> {
    const rows = await tx<{ id: string }[]>`
      update erp.bank_accounts
         set bank_name = coalesce(${input.bankName ?? null}, bank_name),
             gl_account_id = coalesce(${input.glAccountId === undefined ? null : input.glAccountId.toString()}::bigint, gl_account_id),
             is_active = coalesce(${input.isActive ?? null}, is_active),
             version = version + 1
       where organization_id = ${orgId.toString()} and id = ${id.toString()} and version = ${expectedVersion}
      returning id::text as id`;
    if (rows.length === 0) throw conflict('نسخه حساب بانکی تغییر کرده است.');
  }

  async deleteAccount(tx: SqlSession, orgId: bigint, id: bigint): Promise<void> {
    const rows = await tx<{ id: string }[]>`
      update erp.bank_accounts set deleted_at = now(), is_active = false, version = version + 1
       where organization_id = ${orgId.toString()} and id = ${id.toString()} and deleted_at is null
      returning id::text as id`;
    if (rows.length === 0) throw notFound('حساب بانکی');
  }

  async insertStatement(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly bankAccountId: bigint;
      readonly statementNo: string;
      readonly periodStart: string;
      readonly periodEnd: string;
      readonly openingBalance: bigint;
      readonly closingBalance: bigint;
      readonly source: string;
      readonly fileId?: bigint;
      readonly lineCount: number;
      readonly importedBy: bigint | null;
    },
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.bank_statements
        (organization_id, bank_account_id, statement_no, period_start_date, period_end_date,
         opening_balance_amount, closing_balance_amount, source, file_id, status, line_count,
         imported_by)
      values
        (${input.orgId.toString()}, ${input.bankAccountId.toString()}, ${input.statementNo},
         ${input.periodStart}, ${input.periodEnd}, ${input.openingBalance.toString()},
         ${input.closingBalance.toString()}, ${input.source},
         ${input.fileId === undefined ? null : input.fileId.toString()}::bigint,
         'parsed', ${input.lineCount},
         ${input.importedBy === null ? null : input.importedBy.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ایجاد صورت حساب بانکی انجام نشد.');
    return BigInt(id);
  }

  async insertStatementLines(
    tx: SqlSession,
    statementId: bigint,
    lines: readonly {
      readonly lineNo: number;
      readonly valueDate: string;
      readonly direction: 'debit' | 'credit';
      readonly amount: bigint;
      readonly description?: string;
      readonly bankReference?: string;
    }[],
  ): Promise<void> {
    for (const line of lines) {
      await tx`
        insert into erp.bank_statement_lines
          (statement_id, line_no, value_date, direction, amount, description, bank_reference, match_status)
        values
          (${statementId.toString()}, ${line.lineNo}, ${line.valueDate}, ${line.direction},
           ${line.amount.toString()}, ${line.description ?? null}, ${line.bankReference ?? null}, 'unmatched')`;
    }
  }

  async statementLines(statementId: bigint, filter: { readonly matchStatus?: string } = {}): Promise<readonly StatementLineRecord[]> {
    const rows = await this.db<{
      id: string; line_no: number; value_date: string; direction: string; amount: string;
      description: string | null; bank_reference: string | null; match_status: string;
      matched_bank_transaction_id: string | null;
    }[]>`
      select id::text as id, line_no, value_date::text as value_date, direction,
             amount::text as amount, description, bank_reference, match_status,
             matched_bank_transaction_id::text as matched_bank_transaction_id
        from erp.bank_statement_lines
       where statement_id = ${statementId.toString()}
         and (${filter.matchStatus ?? null}::text is null or match_status = ${filter.matchStatus ?? null})
       order by line_no`;
    return rows.map((row) => ({
      id: BigInt(row.id),
      lineNo: row.line_no,
      valueDate: row.value_date,
      direction: row.direction,
      amount: BigInt(row.amount),
      description: row.description,
      bankReference: row.bank_reference,
      matchStatus: row.match_status,
      matchedBankTransactionId:
        row.matched_bank_transaction_id === null ? null : BigInt(row.matched_bank_transaction_id),
    }));
  }

  async findStatement(orgId: bigint, id: bigint, tx?: SqlSession): Promise<{
    readonly id: bigint;
    readonly bankAccountId: bigint;
    readonly statementNo: string;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly openingBalance: bigint;
    readonly closingBalance: bigint;
    readonly status: string;
    readonly lineCount: number;
    readonly reconciliationId: bigint | null;
  } | undefined> {
    const rows = await this.db<{
      id: string; bank_account_id: string; statement_no: string; period_start_date: string;
      period_end_date: string; opening_balance_amount: string; closing_balance_amount: string;
      status: string; line_count: number; reconciliation_id: string | null;
    }[]>`
      select id::text as id, bank_account_id::text as bank_account_id, statement_no,
             period_start_date::text as period_start_date, period_end_date::text as period_end_date,
             opening_balance_amount::text as opening_balance_amount,
             closing_balance_amount::text as closing_balance_amount, status, line_count,
             reconciliation_id::text as reconciliation_id
        from erp.bank_statements
       where organization_id = ${orgId.toString()} and id = ${id.toString()}`;
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: BigInt(row.id),
      bankAccountId: BigInt(row.bank_account_id),
      statementNo: row.statement_no,
      periodStart: row.period_start_date,
      periodEnd: row.period_end_date,
      openingBalance: BigInt(row.opening_balance_amount),
      closingBalance: BigInt(row.closing_balance_amount),
      status: row.status,
      lineCount: row.line_count,
      reconciliationId: row.reconciliation_id === null ? null : BigInt(row.reconciliation_id),
    };
  }

  async insertReconciliation(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly bankAccountId: bigint;
      readonly statementId: bigint;
      readonly reconciliationNo: string;
      readonly periodStart: string;
      readonly periodEnd: string;
      readonly statementOpening: bigint;
      readonly statementClosing: bigint;
      readonly bookOpening: bigint;
      readonly bookClosing: bigint;
      readonly createdBy: bigint | null;
    },
  ): Promise<bigint> {
    const difference = input.statementClosing - input.bookClosing;
    const rows = await tx<{ id: string }[]>`
      insert into erp.bank_reconciliations
        (organization_id, bank_account_id, reconciliation_no, period_start_date, period_end_date,
         statement_opening_balance_amount, statement_closing_balance_amount,
         book_opening_balance_amount, book_closing_balance_amount, difference_amount, status,
         created_by)
      values
        (${input.orgId.toString()}, ${input.bankAccountId.toString()}, ${input.reconciliationNo},
         ${input.periodStart}, ${input.periodEnd}, ${input.statementOpening.toString()},
         ${input.statementClosing.toString()}, ${input.bookOpening.toString()},
         ${input.bookClosing.toString()}, ${difference.toString()}, 'in_progress',
         ${input.createdBy === null ? null : input.createdBy.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ایجاد مغایرت‌گیری بانکی انجام نشد.');
    await tx`
      update erp.bank_statements set reconciliation_id = ${id}::bigint, status = 'reconciling'
       where id = ${input.statementId.toString()}`;
    return BigInt(id);
  }

  async match(
    tx: SqlSession,
    input: {
      readonly reconciliationId: bigint;
      readonly statementLineId: bigint;
      readonly bankTransactionId?: bigint;
      readonly paymentId?: bigint;
      readonly journalLineId?: bigint;
      readonly difference: bigint;
      readonly notes?: string;
    },
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.bank_reconciliation_lines
        (reconciliation_id, bank_transaction_id, match_type, matched_payment_id, matched_journal_line_id,
         difference_amount, notes)
      values
        (${input.reconciliationId.toString()},
         ${input.bankTransactionId === undefined ? null : input.bankTransactionId.toString()}::bigint,
         'manual',
         ${input.paymentId === undefined ? null : input.paymentId.toString()}::bigint,
         ${input.journalLineId === undefined ? null : input.journalLineId.toString()}::bigint,
         ${input.difference.toString()}, ${input.notes ?? null})
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ثبت تطبیق انجام نشد.');
    await tx`
      update erp.bank_statement_lines
         set match_status = 'manual',
             matched_bank_transaction_id = ${input.bankTransactionId === undefined ? null : input.bankTransactionId.toString()}::bigint,
             matched_at = now()
       where id = ${input.statementLineId.toString()}`;
    return BigInt(id);
  }

  async unmatch(tx: SqlSession, reconciliationId: bigint, matchId: bigint): Promise<void> {
    const rows = await tx<{ bank_transaction_id: string | null }[]>`
      delete from erp.bank_reconciliation_lines
       where id = ${matchId.toString()} and reconciliation_id = ${reconciliationId.toString()}
      returning bank_transaction_id::text as bank_transaction_id`;
    const row = rows[0];
    if (row === undefined) throw notFound('تطبیق بانکی');
    await tx`
      update erp.bank_statement_lines set match_status = 'unmatched', matched_at = null, matched_by = null
       where matched_bank_transaction_id = ${row.bank_transaction_id}::bigint`;
  }

  async completeReconciliation(
    tx: SqlSession,
    id: bigint,
    input: { readonly difference: bigint; readonly actorId: bigint | null; readonly note: string; readonly tolerance: bigint },
  ): Promise<void> {
    if (input.difference > input.tolerance || input.difference < -input.tolerance) {
      throw conflict('اختلاف مغایرت‌گیری بیش از حد مجاز است و نیاز به توضیح دارد.');
    }
    await tx`
      update erp.bank_reconciliations
         set status = 'completed', completed_at = now(),
             completed_by = ${input.actorId === null ? null : input.actorId.toString()}::bigint,
             notes = ${input.note}, version = version + 1
       where id = ${id.toString()}`;
    await tx`
      update erp.bank_statements s set status = 'reconciled'
        from erp.bank_reconciliations r
       where r.id = ${id.toString()} and s.reconciliation_id = r.id`;
  }

  async findReconciliation(orgId: bigint, id: bigint): Promise<{
    readonly id: bigint;
    readonly bankAccountId: bigint;
    readonly status: string;
    readonly difference: bigint;
    readonly statementClosing: bigint;
    readonly bookClosing: bigint;
    readonly periodStart: string;
    readonly periodEnd: string;
  } | undefined> {
    const rows = await this.db<{
      id: string; bank_account_id: string; status: string; difference_amount: string;
      statement_closing_balance_amount: string; book_closing_balance_amount: string;
      period_start_date: string; period_end_date: string;
    }[]>`
      select id::text as id, bank_account_id::text as bank_account_id, status,
             difference_amount::text as difference_amount,
             statement_closing_balance_amount::text as statement_closing_balance_amount,
             book_closing_balance_amount::text as book_closing_balance_amount,
             period_start_date::text as period_start_date, period_end_date::text as period_end_date
        from erp.bank_reconciliations
       where organization_id = ${orgId.toString()} and id = ${id.toString()}`;
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: BigInt(row.id),
      bankAccountId: BigInt(row.bank_account_id),
      status: row.status,
      difference: BigInt(row.difference_amount),
      statementClosing: BigInt(row.statement_closing_balance_amount),
      bookClosing: BigInt(row.book_closing_balance_amount),
      periodStart: row.period_start_date,
      periodEnd: row.period_end_date,
    };
  }

  /** Book balance of the GL account mapped to the bank account. */
  async bookBalance(tx: SqlSession, orgId: bigint, bankAccountId: bigint): Promise<bigint> {
    const rows = await tx<{ balance: string }[]>`
      select coalesce(sum(b.closing_debit_amount - b.closing_credit_amount), 0)::text as balance
        from erp.bank_accounts ba
        join erp.account_balances b on b.account_id = ba.gl_account_id
       where ba.organization_id = ${orgId.toString()} and ba.id = ${bankAccountId.toString()}`;
    return BigInt(rows[0]?.balance ?? '0');
  }
}
