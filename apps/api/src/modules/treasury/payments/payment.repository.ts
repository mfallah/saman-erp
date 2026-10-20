/** Treasury payment repository (`erp.payments`, `erp.payment_allocations`, methods). */
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../../common/contracts';
import type { Db } from '../../../common/contracts';
import type { SqlSession } from '../../accounting/persistence/sql-support';
import { conflict, notFound } from '../../accounting/persistence/sql-support';

export interface PaymentRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly paymentNo: string;
  readonly direction: string;
  readonly methodCode: string;
  readonly amount: bigint;
  readonly unappliedAmount: bigint;
  readonly paymentDate: string;
  readonly status: string;
  readonly customerId: bigint | null;
  readonly supplierId: bigint | null;
  readonly partnerId: bigint | null;
  readonly purchaseOrderId: bigint | null;
  readonly refundId: bigint | null;
  readonly bankAccountId: bigint | null;
  readonly cashAccountId: bigint | null;
  readonly chequeId: bigint | null;
  readonly clearingAccountId: bigint | null;
  readonly journalEntryId: bigint | null;
  readonly description: string | null;
  readonly version: number;
}

export interface AllocationRecord {
  readonly id: bigint;
  readonly documentType: string;
  readonly documentId: bigint;
  readonly amount: bigint;
}

interface PaymentRow {
  id: string;
  public_id: string;
  payment_no: string;
  direction: string;
  method_code: string;
  amount: string;
  unapplied_amount: string;
  payment_date: string;
  status: string;
  customer_id: string | null;
  supplier_id: string | null;
  partner_id: string | null;
  purchase_order_id: string | null;
  refund_id: string | null;
  bank_account_id: string | null;
  cash_account_id: string | null;
  cheque_id: string | null;
  clearing_account_id: string | null;
  journal_entry_id: string | null;
  description: string | null;
  version: number;
}

function toPayment(row: PaymentRow): PaymentRecord {
  return {
    id: BigInt(row.id),
    publicId: row.public_id,
    paymentNo: row.payment_no,
    direction: row.direction,
    methodCode: row.method_code,
    amount: BigInt(row.amount),
    unappliedAmount: BigInt(row.unapplied_amount),
    paymentDate: row.payment_date,
    status: row.status,
    customerId: row.customer_id === null ? null : BigInt(row.customer_id),
    supplierId: row.supplier_id === null ? null : BigInt(row.supplier_id),
    partnerId: row.partner_id === null ? null : BigInt(row.partner_id),
    purchaseOrderId: row.purchase_order_id === null ? null : BigInt(row.purchase_order_id),
    refundId: row.refund_id === null ? null : BigInt(row.refund_id),
    bankAccountId: row.bank_account_id === null ? null : BigInt(row.bank_account_id),
    cashAccountId: row.cash_account_id === null ? null : BigInt(row.cash_account_id),
    chequeId: row.cheque_id === null ? null : BigInt(row.cheque_id),
    clearingAccountId: row.clearing_account_id === null ? null : BigInt(row.clearing_account_id),
    journalEntryId: row.journal_entry_id === null ? null : BigInt(row.journal_entry_id),
    description: row.description,
    version: row.version,
  };
}

const PAYMENT_COLUMNS = `p.id::text as id, p.public_id::text as public_id, p.payment_no, p.direction,
  m.code as method_code, p.amount::text as amount, p.unapplied_amount::text as unapplied_amount,
  p.payment_date::text as payment_date, p.status, p.customer_id::text as customer_id,
  p.supplier_id::text as supplier_id, p.partner_id::text as partner_id,
  p.purchase_order_id::text as purchase_order_id, p.refund_id::text as refund_id,
  p.bank_account_id::text as bank_account_id, p.cash_account_id::text as cash_account_id,
  p.cheque_id::text as cheque_id, p.clearing_account_id::text as clearing_account_id,
  p.journal_entry_id::text as journal_entry_id, p.description, p.version`;

@Injectable()
export class PaymentRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async nextPaymentNo(tx: SqlSession, orgId: bigint, fiscalYearId: bigint, prefix: string): Promise<string> {
    const rows = await tx<{ next_value: string; prefix: string }[]>`
      select next_value::text as next_value, prefix from erp.numbering_sequences
       where organization_id = ${orgId.toString()} and document_type = 'PAY'
         and fiscal_year_id = ${fiscalYearId.toString()}
       for update`;
    const row = rows[0];
    let next = 1n;
    let effectivePrefix = prefix;
    if (row === undefined) {
      await tx`
        insert into erp.numbering_sequences (organization_id, document_type, fiscal_year_id, prefix, next_value)
        values (${orgId.toString()}, 'PAY', ${fiscalYearId.toString()}, ${prefix}, 2)`;
    } else {
      next = BigInt(row.next_value);
      effectivePrefix = row.prefix;
      await tx`
        update erp.numbering_sequences set next_value = ${(next + 1n).toString()}, updated_at = now()
         where organization_id = ${orgId.toString()} and document_type = 'PAY'
           and fiscal_year_id = ${fiscalYearId.toString()}`;
    }
    return `${effectivePrefix}-${next.toString().padStart(6, '0')}`;
  }

  async methodId(tx: SqlSession, orgId: bigint, code: string): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      select id::text as id from erp.payment_methods
       where organization_id = ${orgId.toString()} and code = ${code} and is_active`;
    const row = rows[0];
    if (row === undefined) throw notFound('روش پرداخت');
    return BigInt(row.id);
  }

  async glAccountOfBank(tx: SqlSession, orgId: bigint, bankAccountId: bigint): Promise<string> {
    const rows = await tx<{ code: string }[]>`
      select a.code from erp.bank_accounts b
        join erp.chart_of_accounts a on a.id = b.gl_account_id
       where b.organization_id = ${orgId.toString()} and b.id = ${bankAccountId.toString()}`;
    const row = rows[0];
    if (row === undefined) throw notFound('حساب بانکی');
    return row.code;
  }

  async glAccountOfCash(tx: SqlSession, orgId: bigint, cashAccountId: bigint): Promise<string> {
    const rows = await tx<{ code: string }[]>`
      select a.code from erp.cash_accounts c
        join erp.chart_of_accounts a on a.id = c.gl_account_id
       where c.organization_id = ${orgId.toString()} and c.id = ${cashAccountId.toString()}`;
    const row = rows[0];
    if (row === undefined) throw notFound('صندوق');
    return row.code;
  }

  async insert(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly paymentNo: string;
      readonly direction: string;
      readonly methodId: bigint;
      readonly amount: bigint;
      readonly unappliedAmount: bigint;
      readonly paymentDate: string;
      readonly customerId?: bigint;
      readonly supplierId?: bigint;
      readonly partnerId?: bigint;
      readonly bankAccountId?: bigint;
      readonly cashAccountId?: bigint;
      readonly chequeId?: bigint;
      readonly salesOrderId?: bigint;
      readonly purchaseOrderId?: bigint;
      readonly clearingAccountId?: bigint;
      readonly description?: string;
      readonly referenceNo?: string;
      readonly createdBy: bigint | null;
    },
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.payments
        (organization_id, payment_no, direction, method_id, amount, unapplied_amount, payment_date,
         business_date, customer_id, supplier_id, partner_id, bank_account_id, cash_account_id,
         cheque_id, sales_order_id, purchase_order_id, clearing_account_id, description,
         reference_no, status, created_by)
      values
        (${input.orgId.toString()}, ${input.paymentNo}, ${input.direction}, ${input.methodId.toString()},
         ${input.amount.toString()}, ${input.unappliedAmount.toString()}, ${input.paymentDate},
         ${input.paymentDate},
         ${input.customerId === undefined ? null : input.customerId.toString()}::bigint,
         ${input.supplierId === undefined ? null : input.supplierId.toString()}::bigint,
         ${input.partnerId === undefined ? null : input.partnerId.toString()}::bigint,
         ${input.bankAccountId === undefined ? null : input.bankAccountId.toString()}::bigint,
         ${input.cashAccountId === undefined ? null : input.cashAccountId.toString()}::bigint,
         ${input.chequeId === undefined ? null : input.chequeId.toString()}::bigint,
         ${input.salesOrderId === undefined ? null : input.salesOrderId.toString()}::bigint,
         ${input.purchaseOrderId === undefined ? null : input.purchaseOrderId.toString()}::bigint,
         ${input.clearingAccountId === undefined ? null : input.clearingAccountId.toString()}::bigint,
         ${input.description ?? null}, ${input.referenceNo ?? null}, 'pending',
         ${input.createdBy === null ? null : input.createdBy.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ایجاد پرداخت انجام نشد.');
    return BigInt(id);
  }

  async find(orgId: bigint, id: bigint, tx?: SqlSession): Promise<PaymentRecord | undefined> {
    const client = tx ?? this.db;
    const rows = await client<PaymentRow[]>`
      select ${client.unsafe(PAYMENT_COLUMNS)}
        from erp.payments p join erp.payment_methods m on m.id = p.method_id
       where p.organization_id = ${orgId.toString()} and p.id = ${id.toString()}`;
    const row = rows[0];
    return row === undefined ? undefined : toPayment(row);
  }

  async list(
    orgId: bigint,
    filter: { readonly direction?: string; readonly status?: string; readonly customerId?: bigint; readonly supplierId?: bigint; readonly dateFrom?: string; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly PaymentRecord[]> {
    const rows = await this.db<PaymentRow[]>`
      select ${this.db.unsafe(PAYMENT_COLUMNS)}
        from erp.payments p join erp.payment_methods m on m.id = p.method_id
       where p.organization_id = ${orgId.toString()}
         and (${filter.direction ?? null}::text is null or p.direction = ${filter.direction ?? null})
         and (${filter.status ?? null}::text is null or p.status = ${filter.status ?? null})
         and (${filter.customerId === undefined ? null : filter.customerId.toString()}::bigint is null or p.customer_id = ${filter.customerId === undefined ? null : filter.customerId.toString()}::bigint)
         and (${filter.supplierId === undefined ? null : filter.supplierId.toString()}::bigint is null or p.supplier_id = ${filter.supplierId === undefined ? null : filter.supplierId.toString()}::bigint)
         and (${filter.dateFrom ?? null}::date is null or p.payment_date >= ${filter.dateFrom ?? null}::date)
       order by p.payment_date desc, p.id desc
       limit ${filter.limit ?? 50} offset ${filter.offset ?? 0}`;
    return rows.map(toPayment);
  }

  async setStatus(
    tx: SqlSession,
    id: bigint,
    from: readonly string[],
    to: string,
    actorId: bigint | null,
  ): Promise<void> {
    const rows = await tx<{ id: string }[]>`
      update erp.payments
         set status = ${to}, executed_by = ${actorId === null ? null : actorId.toString()}::bigint,
             executed_at = case when ${to} = 'cleared' then now() else executed_at end,
             version = version + 1
       where id = ${id.toString()} and status = any(${[...from]})
      returning id::text as id`;
    if (rows.length === 0) throw conflict('وضعیت پرداخت اجازه این تغییر را نمی‌دهد.');
  }

  async attachJournal(tx: SqlSession, id: bigint, journalEntryId: bigint): Promise<void> {
    await tx`
      update erp.payments set journal_entry_id = ${journalEntryId.toString()}::bigint, version = version + 1
       where id = ${id.toString()}`;
  }

  async allocations(paymentId: bigint, tx?: SqlSession): Promise<readonly AllocationRecord[]> {
    const client = tx ?? this.db;
    const rows = await client<{ id: string; document_type: string; document_id: string; amount: string }[]>`
      select id::text as id, document_type, document_id::text as document_id, amount::text as amount
        from erp.payment_allocations where payment_id = ${paymentId.toString()} order by id`;
    return rows.map((row) => ({
      id: BigInt(row.id),
      documentType: row.document_type,
      documentId: BigInt(row.document_id),
      amount: BigInt(row.amount),
    }));
  }

  async insertAllocation(
    tx: SqlSession,
    input: {
      readonly paymentId: bigint;
      readonly orgId: bigint;
      readonly documentType: string;
      readonly documentId: bigint;
      readonly amount: bigint;
    },
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.payment_allocations
        (payment_id, organization_id, document_type, document_id, amount)
      values
        (${input.paymentId.toString()}, ${input.orgId.toString()}, ${input.documentType},
         ${input.documentId.toString()}, ${input.amount.toString()})
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('تخصیص پرداخت انجام نشد.');
    return BigInt(id);
  }

  async deleteAllocation(tx: SqlSession, paymentId: bigint, allocationId: bigint): Promise<bigint> {
    const rows = await tx<{ amount: string }[]>`
      delete from erp.payment_allocations
       where id = ${allocationId.toString()} and payment_id = ${paymentId.toString()}
      returning amount::text as amount`;
    const row = rows[0];
    if (row === undefined) throw notFound('تخصیص پرداخت');
    return BigInt(row.amount);
  }

  async setUnapplied(tx: SqlSession, paymentId: bigint, unapplied: bigint): Promise<void> {
    await tx`
      update erp.payments set unapplied_amount = ${unapplied.toString()}, version = version + 1
       where id = ${paymentId.toString()}`;
  }
}
