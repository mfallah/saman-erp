/** Cheque repository (`erp.cheques`, `erp.cheque_events`). */
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../../common/contracts';
import type { Db } from '../../../common/contracts';
import type { SqlSession } from '../persistence/sql-support';
import { conflict, notFound } from '../persistence/sql-support';
import type { ChequeDirection, ChequeStatus } from './cheque-fsm';

export interface ChequeRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly chequeNo: string;
  readonly direction: ChequeDirection;
  readonly status: ChequeStatus;
  readonly partnerType: string;
  readonly partnerId: bigint;
  readonly amount: bigint;
  readonly issueDate: string | null;
  readonly dueDate: string;
  readonly bankName: string | null;
  readonly bankAccountId: bigint | null;
  readonly cashAccountId: bigint | null;
  readonly sayadId: string | null;
  readonly endorsedTo: string | null;
  readonly endorsementDate: string | null;
  readonly depositDate: string | null;
  readonly clearedDate: string | null;
  readonly bouncedDate: string | null;
  readonly journalEntryId: bigint | null;
  readonly version: number;
}

interface ChequeRow {
  id: string;
  public_id: string;
  cheque_no: string;
  direction: string;
  status: string;
  partner_type: string;
  partner_id: string;
  amount: string;
  issue_date: string | null;
  due_date: string;
  bank_name: string | null;
  bank_account_id: string | null;
  cash_account_id: string | null;
  sayad_id: string | null;
  endorsed_to: string | null;
  endorsement_date: string | null;
  deposit_date: string | null;
  cleared_date: string | null;
  bounced_date: string | null;
  journal_entry_id: string | null;
  version: number;
}

function toCheque(row: ChequeRow): ChequeRecord {
  return {
    id: BigInt(row.id),
    publicId: row.public_id,
    chequeNo: row.cheque_no,
    direction: row.direction === 'issued' ? 'issued' : 'received',
    status: row.status as ChequeStatus,
    partnerType: row.partner_type,
    partnerId: BigInt(row.partner_id),
    amount: BigInt(row.amount),
    issueDate: row.issue_date,
    dueDate: row.due_date,
    bankName: row.bank_name,
    bankAccountId: row.bank_account_id === null ? null : BigInt(row.bank_account_id),
    cashAccountId: row.cash_account_id === null ? null : BigInt(row.cash_account_id),
    sayadId: row.sayad_id,
    endorsedTo: row.endorsed_to,
    endorsementDate: row.endorsement_date,
    depositDate: row.deposit_date,
    clearedDate: row.cleared_date,
    bouncedDate: row.bounced_date,
    journalEntryId: row.journal_entry_id === null ? null : BigInt(row.journal_entry_id),
    version: row.version,
  };
}

const CHEQUE_COLUMNS = `id::text as id, public_id::text as public_id, cheque_no, direction, status,
  partner_type, partner_id::text as partner_id, amount::text as amount, issue_date::text as issue_date,
  due_date::text as due_date, bank_name, bank_account_id::text as bank_account_id,
  cash_account_id::text as cash_account_id, sayad_id, endorsed_to,
  endorsement_date::text as endorsement_date, deposit_date::text as deposit_date,
  cleared_date::text as cleared_date, bounced_date::text as bounced_date,
  journal_entry_id::text as journal_entry_id, version`;

@Injectable()
export class ChequeRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async insert(
    tx: SqlSession,
    input: {
      readonly orgId: bigint;
      readonly chequeNo: string;
      readonly direction: ChequeDirection;
      readonly status: ChequeStatus;
      readonly partnerType: string;
      readonly partnerId: bigint;
      readonly amount: bigint;
      readonly dueDate: string;
      readonly issueDate?: string;
      readonly bankName?: string;
      readonly bankAccountId?: bigint;
      readonly cashAccountId?: bigint;
      readonly sayadId?: string;
      readonly createdBy: bigint | null;
    },
  ): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.cheques
        (organization_id, cheque_no, direction, status, partner_type, partner_id, amount,
         issue_date, due_date, bank_name, bank_account_id, cash_account_id, sayad_id,
         next_action_date, created_by)
      values
        (${input.orgId.toString()}, ${input.chequeNo}, ${input.direction}, ${input.status},
         ${input.partnerType}, ${input.partnerId.toString()}, ${input.amount.toString()},
         ${input.issueDate ?? null}, ${input.dueDate}, ${input.bankName ?? null},
         ${input.bankAccountId === undefined ? null : input.bankAccountId.toString()}::bigint,
         ${input.cashAccountId === undefined ? null : input.cashAccountId.toString()}::bigint,
         ${input.sayadId ?? null}, ${input.dueDate},
         ${input.createdBy === null ? null : input.createdBy.toString()}::bigint)
      returning id::text as id`;
    const id = rows[0]?.id;
    if (id === undefined) throw conflict('ثبت چک انجام نشد.');
    return BigInt(id);
  }

  async find(orgId: bigint, id: bigint, tx?: SqlSession): Promise<ChequeRecord | undefined> {
    const client = tx ?? this.db;
    const rows = await client<ChequeRow[]>`
      select ${client.unsafe(CHEQUE_COLUMNS)}
        from erp.cheques where organization_id = ${orgId.toString()} and id = ${id.toString()}`;
    const row = rows[0];
    return row === undefined ? undefined : toCheque(row);
  }

  async list(
    orgId: bigint,
    filter: {
      readonly status?: string;
      readonly direction?: string;
      readonly partnerId?: bigint;
      readonly dueFrom?: string;
      readonly bankAccountId?: bigint;
      readonly limit?: number;
      readonly offset?: number;
    },
  ): Promise<readonly ChequeRecord[]> {
    const rows = await this.db<ChequeRow[]>`
      select ${this.db.unsafe(CHEQUE_COLUMNS)}
        from erp.cheques
       where organization_id = ${orgId.toString()}
         and (${filter.status ?? null}::text is null or status = ${filter.status ?? null})
         and (${filter.direction ?? null}::text is null or direction = ${filter.direction ?? null})
         and (${filter.partnerId === undefined ? null : filter.partnerId.toString()}::bigint is null or partner_id = ${filter.partnerId === undefined ? null : filter.partnerId.toString()}::bigint)
         and (${filter.dueFrom ?? null}::date is null or due_date >= ${filter.dueFrom ?? null}::date)
         and (${filter.bankAccountId === undefined ? null : filter.bankAccountId.toString()}::bigint is null or bank_account_id = ${filter.bankAccountId === undefined ? null : filter.bankAccountId.toString()}::bigint)
       order by due_date, id
       limit ${filter.limit ?? 50} offset ${filter.offset ?? 0}`;
    return rows.map(toCheque);
  }

  async transition(
    tx: SqlSession,
    input: {
      readonly id: bigint;
      readonly from: ChequeStatus;
      readonly to: ChequeStatus;
      readonly bankAccountId?: bigint;
      readonly endorsedTo?: string;
      readonly endorsementDate?: string;
      readonly date: string;
      readonly bounceReason?: string;
      readonly journalEntryId?: bigint;
    },
  ): Promise<void> {
    const rows = await tx<{ id: string }[]>`
      update erp.cheques
         set status = ${input.to},
             bank_account_id = coalesce(${input.bankAccountId === undefined ? null : input.bankAccountId.toString()}::bigint, bank_account_id),
             endorsed_to = coalesce(${input.endorsedTo ?? null}, endorsed_to),
             endorsement_date = coalesce(${input.endorsementDate ?? null}::date, endorsement_date),
             deposit_date = case when ${input.to} = 'deposited' then ${input.date}::date else deposit_date end,
             cleared_date = case when ${input.to} = 'cleared' then ${input.date}::date else cleared_date end,
             bounced_date = case when ${input.to} = 'bounced' then ${input.date}::date else bounced_date end,
             bounce_reason = coalesce(${input.bounceReason ?? null}, bounce_reason),
             journal_entry_id = coalesce(${input.journalEntryId === undefined ? null : input.journalEntryId.toString()}::bigint, journal_entry_id),
             next_action_date = case when ${input.to} in ('cleared','bounced','returned','cancelled') then null else next_action_date end,
             version = version + 1
       where id = ${input.id.toString()} and status = ${input.from}
      returning id::text as id`;
    if (rows.length === 0) {
      throw conflict('وضعیت چک تغییر کرده است؛ صفحه را دوباره بارگذاری کنید.');
    }
  }

  async appendEvent(
    tx: SqlSession,
    input: {
      readonly chequeId: bigint;
      readonly eventType: string;
      readonly eventDate: string;
      readonly amount?: bigint;
      readonly bankReference?: string;
      readonly notes?: string;
      readonly journalEntryId?: bigint;
      readonly createdBy: bigint | null;
    },
  ): Promise<void> {
    await tx`
      insert into erp.cheque_events
        (cheque_id, event_type, event_date, amount, bank_reference, notes, journal_entry_id, created_by)
      values
        (${input.chequeId.toString()}, ${input.eventType}, ${input.eventDate},
         ${input.amount === undefined ? null : input.amount.toString()}::bigint,
         ${input.bankReference ?? null}, ${input.notes ?? null},
         ${input.journalEntryId === undefined ? null : input.journalEntryId.toString()}::bigint,
         ${input.createdBy === null ? null : input.createdBy.toString()}::bigint)`;
  }

  async events(chequeId: bigint): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.db<{
      event_type: string;
      event_date: string;
      amount: string | null;
      bank_reference: string | null;
      notes: string | null;
      journal_entry_id: string | null;
    }[]>`
      select event_type, event_date::text as event_date, amount::text as amount,
             bank_reference, notes, journal_entry_id::text as journal_entry_id
        from erp.cheque_events where cheque_id = ${chequeId.toString()}
       order by event_date, id`;
    return rows.map((row) => ({
      eventType: row.event_type,
      eventDate: row.event_date,
      amount: row.amount,
      bankReference: row.bank_reference,
      notes: row.notes,
      journalEntryId: row.journal_entry_id,
    }));
  }

  async setJournal(tx: SqlSession, id: bigint, journalEntryId: bigint): Promise<void> {
    await tx`
      update erp.cheques set journal_entry_id = ${journalEntryId.toString()}::bigint, version = version + 1
       where id = ${id.toString()}`;
  }
}
