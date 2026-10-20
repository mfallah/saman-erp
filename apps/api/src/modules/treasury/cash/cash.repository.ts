/** Cash repository: boxes, sessions, transactions. */
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../../common/contracts';
import type { Db } from '../../../common/contracts';
import type { SqlSession } from '../persistence/sql-support';
import { conflict, notFound } from '../persistence/sql-support';

export interface CashBoxRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly code: string;
  readonly nameFa: string;
  readonly glAccountId: bigint;
  readonly currentBalanceAmount: bigint;
  readonly branchId: bigint | null;
  readonly isActive: boolean;
  readonly version: number;
}

export interface CashSessionRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly sessionNo: string;
  readonly cashAccountId: bigint;
  readonly openedAt: string;
  readonly openingFloatAmount: bigint;
  readonly closingCountedAmount: bigint | null;
  readonly expectedAmount: bigint | null;
  readonly differenceAmount: bigint | null;
  readonly status: string;
  readonly closedAt: string | null;
}

export interface CashTransactionRecord {
  readonly id: bigint;
  readonly cashAccountId: bigint;
  readonly direction: string;
  readonly amount: bigint;
  readonly transactionDate: string;
  readonly balanceAfterAmount: bigint;
  readonly referenceType: string | null;
  readonly description: string | null;
}

@Injectable()
export class CashRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listBoxes(orgId: bigint, filter: { readonly active?: boolean; readonly branchId?: bigint }): Promise<readonly CashBoxRecord[]> {
    const rows = await this.db<{
      id: string; public_id: string; code: string; name_fa: string; gl_account_id: string;
      current_balance_amount: string; branch_id: string | null; is_active: boolean; version: number;
    }[]>`
      select id::text as id, public_id::text as public_id, code, name_fa,
             gl_account_id::text as gl_account_id,
             current_balance_amount::text as current_balance_amount,
             branch_id::text as branch_id, is_active, version
        from erp.cash_accounts
       where organization_id = ${orgId.toString()}
         and (${filter.active ?? null}::boolean is null or is_active = ${filter.active ?? null})
         and (${filter.branchId === undefined ? null : filter.branchId.toString()}::bigint is null or branch_id = ${filter.branchId === undefined ? null : filter.branchId.toString()}::bigint)
       order by code`;
    return rows.map((row) => ({
      id: BigInt(row.id),
      publicId: row.public_id,
      code: row.code,
      nameFa: row.name_fa,
      glAccountId: BigInt(row.gl_account_id),
      currentBalanceAmount: BigInt(row.current_balance_amount),
      branchId: row.branch_id === null ? null : BigInt(row.branch_id),
      isActive: row.is_active,
      version: row.version,
    }));
  }

  async findBox(orgId: bigint, id: bigint, tx?: SqlSession): Promise<CashBoxRecord | undefined> {
    const boxes = await this.listBoxes(orgId, {});
    void tx;
    return boxes.find((box) => box.id === id);
  }

  async glAccountOfBox(tx: SqlSession, orgId: bigint, id: bigint): Promise<string> {
    const rows = await tx<{ code: string }[]>`
      select a.code from erp.cash_accounts c
        join erp.chart_of_accounts a on a.id = c.gl_account_id
       where c.organization_id = ${orgId.toString()} and c.id = ${id.toString()}`;
    const row = rows[0];
    if (row === undefined) throw notFound('صندوق');
    return row.code;
  }

  async insertBox(
    tx: SqlSession,
    input: { readonly orgId: bigint; readonly code: string; readonly nameFa: string; readonly branchId?: bigint; readonly glAccountId: bigint; readonly createdBy: bigint | null },
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.cash_accounts
        (organization_id, branch_id, code, name_fa, gl_account_id, current_balance_amount, is_active, created_by)
      values
        (${input.orgId.toString()},
         ${input.branchId === undefined ? null : input.branchId.toString()}::bigint,
         ${input.code}, ${input.nameFa}, ${input.glAccountId.toString()}, 0, true,
         ${input.createdBy === null ? null : input.createdBy.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ایجاد صندوق انجام نشد.');
    return BigInt(id);
  }

  async openSession(
    tx: SqlSession,
    input: { readonly cashAccountId: bigint; readonly sessionNo: string; readonly openingFloat: bigint; readonly openedBy: bigint | null },
  ): Promise<bigint> {
    const open = await tx<{ id: string }[]>`
      select id::text as id from erp.cash_sessions
       where cash_account_id = ${input.cashAccountId.toString()} and status in ('open','closing')`;
    if (open.length > 0) {
      throw conflict('برای این صندوق یک شیفت باز وجود دارد.');
    }
    const rows = await tx<{ id: string }[]>`
      insert into erp.cash_sessions
        (cash_account_id, session_no, opened_by, opening_float_amount, status)
      values
        (${input.cashAccountId.toString()}, ${input.sessionNo},
         ${input.openedBy === null ? null : input.openedBy.toString()}::bigint,
         ${input.openingFloat.toString()}, 'open')
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('باز کردن شیفت صندوق انجام نشد.');
    return BigInt(id);
  }

  async findSession(orgId: bigint, id: bigint, tx?: SqlSession): Promise<CashSessionRecord | undefined> {
    const client = tx ?? this.db;
    const rows = await client<{
      id: string; public_id: string; session_no: string; cash_account_id: string; opened_at: string;
      opening_float_amount: string; closing_counted_amount: string | null; expected_amount: string | null;
      difference_amount: string | null; status: string; closed_at: string | null;
    }[]>`
      select s.id::text as id, s.public_id::text as public_id, s.session_no,
             s.cash_account_id::text as cash_account_id, s.opened_at::text as opened_at,
             s.opening_float_amount::text as opening_float_amount,
             s.closing_counted_amount::text as closing_counted_amount,
             s.expected_amount::text as expected_amount,
             s.difference_amount::text as difference_amount, s.status, s.closed_at::text as closed_at
        from erp.cash_sessions s
        join erp.cash_accounts c on c.id = s.cash_account_id
       where c.organization_id = ${orgId.toString()} and s.id = ${id.toString()}`;
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: BigInt(row.id),
      publicId: row.public_id,
      sessionNo: row.session_no,
      cashAccountId: BigInt(row.cash_account_id),
      openedAt: row.opened_at,
      openingFloatAmount: BigInt(row.opening_float_amount),
      closingCountedAmount: row.closing_counted_amount === null ? null : BigInt(row.closing_counted_amount),
      expectedAmount: row.expected_amount === null ? null : BigInt(row.expected_amount),
      differenceAmount: row.difference_amount === null ? null : BigInt(row.difference_amount),
      status: row.status,
      closedAt: row.closed_at,
    };
  }

  async listSessions(
    orgId: bigint,
    filter: { readonly cashAccountId?: bigint; readonly status?: string; readonly openedFrom?: string },
  ): Promise<readonly CashSessionRecord[]> {
    const rows = await this.db<{
      id: string; public_id: string; session_no: string; cash_account_id: string; opened_at: string;
      opening_float_amount: string; closing_counted_amount: string | null; expected_amount: string | null;
      difference_amount: string | null; status: string; closed_at: string | null;
    }[]>`
      select s.id::text as id, s.public_id::text as public_id, s.session_no,
             s.cash_account_id::text as cash_account_id, s.opened_at::text as opened_at,
             s.opening_float_amount::text as opening_float_amount,
             s.closing_counted_amount::text as closing_counted_amount,
             s.expected_amount::text as expected_amount,
             s.difference_amount::text as difference_amount, s.status, s.closed_at::text as closed_at
        from erp.cash_sessions s
        join erp.cash_accounts c on c.id = s.cash_account_id
       where c.organization_id = ${orgId.toString()}
         and (${filter.cashAccountId === undefined ? null : filter.cashAccountId.toString()}::bigint is null or s.cash_account_id = ${filter.cashAccountId === undefined ? null : filter.cashAccountId.toString()}::bigint)
         and (${filter.status ?? null}::text is null or s.status = ${filter.status ?? null})
         and (${filter.openedFrom ?? null}::timestamptz is null or s.opened_at >= ${filter.openedFrom ?? null}::timestamptz)
       order by s.opened_at desc`;
    return rows.map((row) => ({
      id: BigInt(row.id),
      publicId: row.public_id,
      sessionNo: row.session_no,
      cashAccountId: BigInt(row.cash_account_id),
      openedAt: row.opened_at,
      openingFloatAmount: BigInt(row.opening_float_amount),
      closingCountedAmount: row.closing_counted_amount === null ? null : BigInt(row.closing_counted_amount),
      expectedAmount: row.expected_amount === null ? null : BigInt(row.expected_amount),
      differenceAmount: row.difference_amount === null ? null : BigInt(row.difference_amount),
      status: row.status,
      closedAt: row.closed_at,
    }));
  }

  /** Expected cash = opening float + Σ in − Σ out. */
  async expectedAmount(tx: SqlSession, sessionId: bigint): Promise<bigint> {
    const rows = await tx<{ expected: string }[]>`
      select (
        s.opening_float_amount
        + coalesce(sum(case when t.direction = 'in' then t.amount else -t.amount end), 0)
      )::text as expected
        from erp.cash_sessions s
        left join erp.cash_transactions t on t.cash_session_id = s.id
       where s.id = ${sessionId.toString()}
       group by s.opening_float_amount`;
    return BigInt(rows[0]?.expected ?? '0');
  }

  async closeSession(
    tx: SqlSession,
    input: { readonly id: bigint; readonly counted: bigint; readonly expected: bigint; readonly actorId: bigint | null; readonly notes?: string },
  ): Promise<void> {
    const difference = input.counted - input.expected;
    await tx`
      update erp.cash_sessions
         set status = 'closed', closed_at = now(),
             closed_by = ${input.actorId === null ? null : input.actorId.toString()}::bigint,
             closing_counted_amount = ${input.counted.toString()},
             expected_amount = ${input.expected.toString()},
             difference_amount = ${difference.toString()},
             notes = coalesce(${input.notes ?? null}, notes),
             version = version + 1
       where id = ${input.id.toString()} and status in ('open','closing')`;
  }

  async insertTransaction(
    tx: SqlSession,
    input: {
      readonly cashAccountId: bigint;
      readonly cashSessionId?: bigint;
      readonly direction: 'in' | 'out';
      readonly amount: bigint;
      readonly transactionDate: string;
      readonly referenceType?: string;
      readonly referenceId?: bigint;
      readonly description?: string;
      readonly createdBy: bigint | null;
    },
  ): Promise<{ readonly id: bigint; readonly balanceAfter: bigint }> {
    const balanceRows = await tx<{ balance: string }[]>`
      select current_balance_amount::text as balance from erp.cash_accounts
       where id = ${input.cashAccountId.toString()} for update`;
    const current = BigInt(balanceRows[0]?.balance ?? '0');
    const balanceAfter = input.direction === 'in' ? current + input.amount : current - input.amount;
    if (balanceAfter < 0n) {
      throw conflict('موجودی صندوق برای این پرداخت کافی نیست.');
    }
    const rows = await tx<{ id: string }[]>`
      insert into erp.cash_transactions
        (cash_account_id, cash_session_id, direction, amount, transaction_date, reference_type,
         reference_id, balance_after_amount, description, created_by)
      values
        (${input.cashAccountId.toString()},
         ${input.cashSessionId === undefined ? null : input.cashSessionId.toString()}::bigint,
         ${input.direction}, ${input.amount.toString()}, ${input.transactionDate},
         ${input.referenceType ?? null},
         ${input.referenceId === undefined ? null : input.referenceId.toString()}::bigint,
         ${balanceAfter.toString()}, ${input.description ?? null},
         ${input.createdBy === null ? null : input.createdBy.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ثبت تراکنش صندوق انجام نشد.');
    await tx`
      update erp.cash_accounts set current_balance_amount = ${balanceAfter.toString()}, version = version + 1
       where id = ${input.cashAccountId.toString()}`;
    return { id: BigInt(id), balanceAfter };
  }

  async listTransactions(
    orgId: bigint,
    filter: { readonly cashAccountId?: bigint; readonly sessionId?: bigint; readonly direction?: string; readonly dateFrom?: string },
  ): Promise<readonly CashTransactionRecord[]> {
    const rows = await this.db<{
      id: string; cash_account_id: string; direction: string; amount: string;
      transaction_date: string; balance_after_amount: string; reference_type: string | null; description: string | null;
    }[]>`
      select t.id::text as id, t.cash_account_id::text as cash_account_id, t.direction,
             t.amount::text as amount, t.transaction_date::text as transaction_date,
             t.balance_after_amount::text as balance_after_amount, t.reference_type, t.description
        from erp.cash_transactions t
        join erp.cash_accounts c on c.id = t.cash_account_id
       where c.organization_id = ${orgId.toString()}
         and (${filter.cashAccountId === undefined ? null : filter.cashAccountId.toString()}::bigint is null or t.cash_account_id = ${filter.cashAccountId === undefined ? null : filter.cashAccountId.toString()}::bigint)
         and (${filter.sessionId === undefined ? null : filter.sessionId.toString()}::bigint is null or t.cash_session_id = ${filter.sessionId === undefined ? null : filter.sessionId.toString()}::bigint)
         and (${filter.direction ?? null}::text is null or t.direction = ${filter.direction ?? null})
         and (${filter.dateFrom ?? null}::date is null or t.transaction_date >= ${filter.dateFrom ?? null}::date)
       order by t.transaction_date desc, t.id desc`;
    return rows.map((row) => ({
      id: BigInt(row.id),
      cashAccountId: BigInt(row.cash_account_id),
      direction: row.direction,
      amount: BigInt(row.amount),
      transactionDate: row.transaction_date,
      balanceAfterAmount: BigInt(row.balance_after_amount),
      referenceType: row.reference_type,
      description: row.description,
    }));
  }
}
