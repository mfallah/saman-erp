/** Channel settlement repository (`erp.channel_settlements`, `channel_settlement_lines`). */
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../common/contracts';
import type { Db } from '../../common/contracts';
import type { SqlSession } from '../accounting/persistence/sql-support';
import { conflict, notFound } from '../accounting/persistence/sql-support';

export interface SettlementRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly settlementNo: string;
  readonly channelAccountId: bigint;
  readonly externalSettlementId: string | null;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly grossSalesAmount: bigint;
  readonly commissionAmount: bigint;
  readonly feeAmount: bigint;
  readonly returnAmount: bigint;
  readonly taxAmount: bigint;
  readonly netPayableAmount: bigint;
  readonly status: string;
  readonly journalEntryId: bigint | null;
  readonly paymentId: bigint | null;
}

export interface SettlementLineRecord {
  readonly id: bigint;
  readonly lineType: string;
  readonly amount: bigint;
  readonly salesOrderId: bigint | null;
  readonly externalReference: string | null;
}

const SETTLEMENT_COLUMNS = `id::text as id, public_id::text as public_id, settlement_no,
  channel_account_id::text as channel_account_id, external_settlement_id,
  period_start_date::text as period_start_date, period_end_date::text as period_end_date,
  gross_sales_amount::text as gross_sales_amount, commission_amount::text as commission_amount,
  fee_amount::text as fee_amount, return_amount::text as return_amount,
  tax_amount::text as tax_amount, net_payable_amount::text as net_payable_amount,
  status, journal_entry_id::text as journal_entry_id, payment_id::text as payment_id`;

type Row = {
  id: string; public_id: string; settlement_no: string; channel_account_id: string;
  external_settlement_id: string | null; period_start_date: string; period_end_date: string;
  gross_sales_amount: string; commission_amount: string; fee_amount: string;
  return_amount: string; tax_amount: string; net_payable_amount: string; status: string;
  journal_entry_id: string | null; payment_id: string | null;
};

function toSettlement(row: Row): SettlementRecord {
  return {
    id: BigInt(row.id),
    publicId: row.public_id,
    settlementNo: row.settlement_no,
    channelAccountId: BigInt(row.channel_account_id),
    externalSettlementId: row.external_settlement_id,
    periodStart: row.period_start_date,
    periodEnd: row.period_end_date,
    grossSalesAmount: BigInt(row.gross_sales_amount),
    commissionAmount: BigInt(row.commission_amount),
    feeAmount: BigInt(row.fee_amount),
    returnAmount: BigInt(row.return_amount),
    taxAmount: BigInt(row.tax_amount),
    netPayableAmount: BigInt(row.net_payable_amount),
    status: row.status,
    journalEntryId: row.journal_entry_id === null ? null : BigInt(row.journal_entry_id),
    paymentId: row.payment_id === null ? null : BigInt(row.payment_id),
  };
}

@Injectable()
export class SettlementsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(
    orgId: bigint,
    filter: { readonly channelAccountId?: bigint; readonly status?: string; readonly periodId?: bigint; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly SettlementRecord[]> {
    const rows = await this.db<Row[]>`
      select ${this.db.unsafe(SETTLEMENT_COLUMNS)}
        from erp.channel_settlements
       where organization_id = ${orgId.toString()}
         and (${filter.channelAccountId === undefined ? null : filter.channelAccountId.toString()}::bigint is null or channel_account_id = ${filter.channelAccountId === undefined ? null : filter.channelAccountId.toString()}::bigint)
         and (${filter.status ?? null}::text is null or status = ${filter.status ?? null})
       order by period_end_date desc, id desc
       limit ${filter.limit ?? 50} offset ${filter.offset ?? 0}`;
    return rows.map(toSettlement);
  }

  async find(orgId: bigint, id: bigint, tx?: SqlSession): Promise<SettlementRecord | undefined> {
    const client = tx ?? this.db;
    const rows = await client<Row[]>`
      select ${client.unsafe(SETTLEMENT_COLUMNS)}
        from erp.channel_settlements
       where organization_id = ${orgId.toString()} and id = ${id.toString()}`;
    const row = rows[0];
    return row === undefined ? undefined : toSettlement(row);
  }

  async insert(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly channelAccountId: bigint;
      readonly settlementNo: string;
      readonly externalSettlementId?: string;
      readonly periodStart: string;
      readonly periodEnd: string;
      readonly grossSalesAmount: bigint;
      readonly commissionAmount: bigint;
      readonly feeAmount: bigint;
      readonly returnAmount: bigint;
      readonly taxAmount: bigint;
      readonly netPayableAmount: bigint;
      readonly createdBy: bigint | null;
    },
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.channel_settlements
        (organization_id, channel_account_id, settlement_no, external_settlement_id,
         period_start_date, period_end_date, gross_sales_amount, commission_amount, fee_amount,
         return_amount, tax_amount, net_payable_amount, status, created_by)
      values
        (${input.orgId.toString()}, ${input.channelAccountId.toString()}, ${input.settlementNo},
         ${input.externalSettlementId ?? null}, ${input.periodStart}, ${input.periodEnd},
         ${input.grossSalesAmount.toString()}, ${input.commissionAmount.toString()},
         ${input.feeAmount.toString()}, ${input.returnAmount.toString()},
         ${input.taxAmount.toString()}, ${input.netPayableAmount.toString()}, 'received',
         ${input.createdBy === null ? null : input.createdBy.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ثبت تسویه کانال انجام نشد.');
    return BigInt(id);
  }

  async insertLines(
    tx: SqlSession,
    settlementId: bigint,
    lines: readonly {
      readonly lineType: string;
      readonly amount: bigint;
      readonly salesOrderId?: bigint;
      readonly externalReference?: string;
      readonly note?: string;
    }[],
  ): Promise<void> {
    for (const line of lines) {
      await tx`
        insert into erp.channel_settlement_lines
          (settlement_id, sales_order_id, line_type, external_reference, amount, note)
        values
          (${settlementId.toString()},
           ${line.salesOrderId === undefined ? null : line.salesOrderId.toString()}::bigint,
           ${line.lineType}, ${line.externalReference ?? null}, ${line.amount.toString()}, ${line.note ?? null})`;
    }
  }

  async lines(settlementId: bigint): Promise<readonly SettlementLineRecord[]> {
    const rows = await this.db<{
      id: string; line_type: string; amount: string; sales_order_id: string | null; external_reference: string | null;
    }[]>`
      select id::text as id, line_type, amount::text as amount,
             sales_order_id::text as sales_order_id, external_reference
        from erp.channel_settlement_lines where settlement_id = ${settlementId.toString()}
       order by id`;
    return rows.map((row) => ({
      id: BigInt(row.id),
      lineType: row.line_type,
      amount: BigInt(row.amount),
      salesOrderId: row.sales_order_id === null ? null : BigInt(row.sales_order_id),
      externalReference: row.external_reference,
    }));
  }

  /** Channel code used by the accounting account resolver. */
  async channelCodeOf(tx: SqlSession, orgId: bigint, channelAccountId: bigint): Promise<string | undefined> {
    const rows = await tx<{ code: string }[]>`
      select ch.code from erp.channel_accounts ca
        join erp.sales_channels ch on ch.id = ca.channel_id
       where ca.organization_id = ${orgId.toString()} and ca.id = ${channelAccountId.toString()}`;
    return rows[0]?.code;
  }

  async setStatus(tx: SqlSession, id: bigint, from: readonly string[], to: string): Promise<void> {
    const rows = await tx<{ id: string }[]>`
      update erp.channel_settlements set status = ${to}, version = version + 1
       where id = ${id.toString()} and status = any(${[...from]})
      returning id::text as id`;
    if (rows.length === 0) throw conflict('وضعیت تسویه اجازه این تغییر را نمی‌دهد.');
  }

  async attachJournal(tx: SqlSession, id: bigint, journalEntryId: bigint): Promise<void> {
    await tx`
      update erp.channel_settlements set journal_entry_id = ${journalEntryId.toString()}::bigint, version = version + 1
       where id = ${id.toString()}`;
  }

  async attachPayment(tx: SqlSession, id: bigint, paymentId: bigint): Promise<void> {
    await tx`
      update erp.channel_settlements
         set payment_id = ${paymentId.toString()}::bigint, status = 'paid', version = version + 1
       where id = ${id.toString()}`;
  }
}
