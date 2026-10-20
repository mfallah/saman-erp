/** `erp.sms_messages` persistence (one row per recipient, no full body in logs). */
import type { Db } from '../../../common/contracts';
import { asDate, asNumber, asString } from './sms.sql';

export interface SmsMessageRecord {
  readonly organizationId: string;
  readonly userId: string | null;
  readonly templateId: string | null;
  readonly mobile: string;
  readonly message: string;
  readonly provider: 'limo_sms' | 'mock';
  readonly providerMessageId: string | null;
  readonly purpose: string;
  readonly status: 'queued' | 'sent' | 'delivered' | 'failed' | 'rejected';
  readonly costAmount: number | null;
  readonly attempts: number;
  readonly lastError: string | null;
}

export interface SmsMessageRow {
  readonly id: string;
  readonly mobile: string;
  readonly status: string;
  readonly provider: string;
  readonly providerMessageId: string | null;
  readonly costAmount: number | null;
  readonly sentAt: Date | null;
  readonly createdAt: Date | null;
}

export interface SmsRepositoryPort {
  insert(record: SmsMessageRecord): Promise<string>;
  updateStatus(input: {
    id: string;
    status: 'sent' | 'delivered' | 'failed' | 'rejected';
    providerMessageId?: string | null;
    costAmount?: number | null;
    error?: string | null;
  }): Promise<void>;
  findById(organizationId: string, id: string): Promise<SmsMessageRow | null>;
  list(organizationId: string, limit: number): Promise<readonly SmsMessageRow[]>;
}

interface RawRow {
  id: unknown;
  mobile: unknown;
  status: unknown;
  provider: unknown;
  provider_message_id: unknown;
  cost_amount: unknown;
  sent_at: unknown;
  created_at: unknown;
}

function mapRow(row: RawRow): SmsMessageRow {
  return {
    id: asString(row.id),
    mobile: asString(row.mobile),
    status: asString(row.status),
    provider: asString(row.provider),
    providerMessageId:
      row.provider_message_id === null ? null : asString(row.provider_message_id),
    costAmount: row.cost_amount === null ? null : asNumber(row.cost_amount),
    sentAt: asDate(row.sent_at),
    createdAt: asDate(row.created_at),
  };
}

export class SqlSmsRepository implements SmsRepositoryPort {
  constructor(private readonly db: Db) {}

  async insert(record: SmsMessageRecord): Promise<string> {
    const rows = await this.db<{ id: string }[]>`
      insert into erp.sms_messages (
        organization_id, user_id, template_id, mobile, message, provider,
        provider_message_id, purpose, status, cost_amount, attempts, last_error,
        sent_at
      ) values (
        ${record.organizationId}::bigint, ${record.userId}::bigint, ${record.templateId}::bigint,
        ${record.mobile}, ${record.message}, ${record.provider},
        ${record.providerMessageId}, ${record.purpose}, ${record.status},
        ${record.costAmount}, ${record.attempts}, ${record.lastError},
        ${record.status === 'sent' ? new Date() : null}
      ) returning id::text`;
    const row = rows[0];
    if (row === undefined) throw new Error('sms_message_insert_failed');
    return asString(row.id);
  }

  async updateStatus(input: {
    id: string;
    status: 'sent' | 'delivered' | 'failed' | 'rejected';
    providerMessageId?: string | null;
    costAmount?: number | null;
    error?: string | null;
  }): Promise<void> {
    await this.db`
      update erp.sms_messages
      set status = ${input.status},
          provider_message_id = coalesce(${input.providerMessageId ?? null}, provider_message_id),
          cost_amount = coalesce(${input.costAmount ?? null}::bigint, cost_amount),
          attempts = attempts + 1,
          last_error = ${input.error === undefined || input.error === null ? null : input.error.slice(0, 500)},
          sent_at = case when ${input.status} = 'sent' then now() else sent_at end,
          delivered_at = case when ${input.status} = 'delivered' then now() else delivered_at end
      where id = ${input.id}::bigint`;
  }

  async findById(organizationId: string, id: string): Promise<SmsMessageRow | null> {
    const rows = await this.db<RawRow[]>`
      select id, mobile, status, provider, provider_message_id, cost_amount, sent_at, created_at
      from erp.sms_messages
      where organization_id = ${organizationId}::bigint and id = ${id}::bigint`;
    return rows[0] === undefined ? null : mapRow(rows[0]);
  }

  async list(organizationId: string, limit: number): Promise<readonly SmsMessageRow[]> {
    const rows = await this.db<RawRow[]>`
      select id, mobile, status, provider, provider_message_id, cost_amount, sent_at, created_at
      from erp.sms_messages
      where organization_id = ${organizationId}::bigint
      order by created_at desc limit ${limit}`;
    return rows.map(mapRow);
  }
}
