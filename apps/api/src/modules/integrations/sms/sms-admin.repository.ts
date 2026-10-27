/**
 * Admin read/write SQL for SMS templates and the outbound message log
 * (`erp.sms_templates`, `erp.sms_messages`). Every query is tenant-scoped.
 */
import type { Db } from '../../../common/contracts';

export interface SmsTemplateView {
  readonly id: string;
  readonly code: string;
  readonly nameFa: string | null;
  readonly body: string | null;
  readonly variables: readonly string[];
  readonly isActive: boolean;
  readonly purpose: string;
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
}

export interface SmsMessageView {
  readonly id: string;
  readonly to: string;
  readonly body: string;
  readonly status: string;
  readonly provider: string;
  readonly providerMessageId: string | null;
  readonly error: string | null;
  readonly purpose: string | null;
  readonly createdAt: Date | null;
  readonly templateCode: string | null;
}

export interface SmsStatusCount {
  readonly status: string;
  readonly count: number;
}

export interface SmsMessageFilter {
  readonly status?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit: number;
}

export interface TemplateWriteInput {
  readonly code: string;
  readonly nameFa: string;
  readonly body: string;
  readonly variables: readonly string[];
  readonly isActive: boolean;
  readonly purpose: string;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : asString(value);
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && value.length > 0) return new Date(value);
  return null;
}

/** jsonb may come back as `string[]`, a JSON string or `null`. */
function asVariables(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

interface TemplateRawRow {
  id: unknown;
  code: unknown;
  name_fa: unknown;
  body: unknown;
  variables: unknown;
  is_active: unknown;
  purpose: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function mapTemplate(row: TemplateRawRow): SmsTemplateView {
  return {
    id: asString(row.id),
    code: asString(row.code),
    nameFa: asNullableString(row.name_fa),
    body: asNullableString(row.body),
    variables: asVariables(row.variables),
    isActive: row.is_active === true,
    purpose: asString(row.purpose),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

interface MessageRawRow {
  id: unknown;
  mobile: unknown;
  message: unknown;
  status: unknown;
  provider: unknown;
  provider_message_id: unknown;
  last_error: unknown;
  purpose: unknown;
  created_at: unknown;
  template_code: unknown;
}

function mapMessage(row: MessageRawRow): SmsMessageView {
  return {
    id: asString(row.id),
    to: asString(row.mobile),
    body: asString(row.message),
    status: asString(row.status),
    provider: asString(row.provider),
    providerMessageId: asNullableString(row.provider_message_id),
    error: asNullableString(row.last_error),
    purpose: asNullableString(row.purpose),
    createdAt: asDate(row.created_at),
    templateCode: asNullableString(row.template_code),
  };
}

export class SqlSmsAdminRepository {
  constructor(private readonly db: Db) {}

  async listTemplates(organizationId: bigint): Promise<readonly SmsTemplateView[]> {
    const rows = await this.db<TemplateRawRow[]>`
      select t.public_id::text as id, t.code, t.name_fa, t.body, t.variables, t.is_active,
             t.purpose, t.created_at, t.updated_at
      from erp.sms_templates t
      where t.organization_id = ${organizationId.toString()} and t.deleted_at is null
      order by t.is_active desc, t.code
    `;
    return rows.map(mapTemplate);
  }

  async findTemplate(
    organizationId: bigint,
    publicId: string,
  ): Promise<SmsTemplateView | null> {
    const rows = await this.db<TemplateRawRow[]>`
      select t.public_id::text as id, t.code, t.name_fa, t.body, t.variables, t.is_active,
             t.purpose, t.created_at, t.updated_at
      from erp.sms_templates t
      where t.organization_id = ${organizationId.toString()}
        and t.public_id = ${publicId}::uuid
        and t.deleted_at is null
      limit 1
    `;
    return rows[0] === undefined ? null : mapTemplate(rows[0]);
  }

  /** `null` when the code is already taken by another live template (unique index). */
  async insertTemplate(
    organizationId: bigint,
    actorId: bigint | null,
    input: TemplateWriteInput,
  ): Promise<SmsTemplateView | null> {
    try {
      const rows = await this.db<TemplateRawRow[]>`
        insert into erp.sms_templates (
          organization_id, code, name_fa, provider, body, variables, purpose, is_active,
          created_by, updated_by
        ) values (
          ${organizationId.toString()}, ${input.code}, ${input.nameFa}, 'limo_sms', ${input.body},
          ${JSON.stringify(input.variables)}::jsonb, ${input.purpose}, ${input.isActive},
          ${actorId === null ? null : actorId.toString()}, ${actorId === null ? null : actorId.toString()}
        )
        returning public_id::text as id, code, name_fa, body, variables, is_active, purpose,
                  created_at, updated_at
      `;
      return rows[0] === undefined ? null : mapTemplate(rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  /** `null` when the target does not exist (or the new code collides). */
  async updateTemplate(
    organizationId: bigint,
    actorId: bigint | null,
    publicId: string,
    patch: Partial<TemplateWriteInput>,
  ): Promise<SmsTemplateView | null> {
    try {
      const rows = await this.db<TemplateRawRow[]>`
        update erp.sms_templates set
          code = coalesce(${patch.code ?? null}, code),
          name_fa = coalesce(${patch.nameFa ?? null}, name_fa),
          body = coalesce(${patch.body ?? null}, body),
          variables = coalesce(${patch.variables === undefined ? null : JSON.stringify(patch.variables)}::jsonb, variables),
          is_active = coalesce(${patch.isActive ?? null}::boolean, is_active),
          purpose = coalesce(${patch.purpose ?? null}, purpose),
          updated_at = now(),
          updated_by = ${actorId === null ? null : actorId.toString()}
        where organization_id = ${organizationId.toString()}
          and public_id = ${publicId}::uuid
          and deleted_at is null
        returning public_id::text as id, code, name_fa, body, variables, is_active, purpose,
                  created_at, updated_at
      `;
      return rows[0] === undefined ? null : mapTemplate(rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  /** Soft delete keeps historical `sms_messages.template_id` references intact. */
  async softDeleteTemplate(
    organizationId: bigint,
    actorId: bigint | null,
    publicId: string,
  ): Promise<boolean> {
    const rows = await this.db<{ id: string }[]>`
      update erp.sms_templates
      set deleted_at = now(), is_active = false, updated_at = now(), updated_by = ${actorId === null ? null : actorId.toString()}
      where organization_id = ${organizationId.toString()}
        and public_id = ${publicId}::uuid
        and deleted_at is null
      returning id::text as id
    `;
    return rows.length > 0;
  }

  async listMessages(
    organizationId: bigint,
    filter: SmsMessageFilter,
  ): Promise<readonly SmsMessageView[]> {
    const rows = await this.db<MessageRawRow[]>`
      select m.public_id::text as id, m.mobile, m.message, m.status, m.provider,
             m.provider_message_id, m.last_error, m.purpose, m.created_at,
             t.code as template_code
      from erp.sms_messages m
      left join erp.sms_templates t on t.id = m.template_id
      where m.organization_id = ${organizationId.toString()}
        and (${filter.status ?? null}::text is null or m.status = ${filter.status ?? null})
        and (${filter.from ?? null}::timestamptz is null or m.created_at >= ${filter.from ?? null}::timestamptz)
        and (${filter.to ?? null}::timestamptz is null or m.created_at <= ${filter.to ?? null}::timestamptz)
      order by m.created_at desc, m.id desc
      limit ${filter.limit}
    `;
    return rows.map(mapMessage);
  }

  async findMessage(
    organizationId: bigint,
    publicId: string,
  ): Promise<SmsMessageView | null> {
    const rows = await this.db<MessageRawRow[]>`
      select m.public_id::text as id, m.mobile, m.message, m.status, m.provider,
             m.provider_message_id, m.last_error, m.purpose, m.created_at,
             t.code as template_code
      from erp.sms_messages m
      left join erp.sms_templates t on t.id = m.template_id
      where m.organization_id = ${organizationId.toString()} and m.public_id = ${publicId}::uuid
      limit 1
    `;
    return rows[0] === undefined ? null : mapMessage(rows[0]);
  }

  async statusCountsSince(
    organizationId: bigint,
    since: Date,
  ): Promise<readonly SmsStatusCount[]> {
    const rows = await this.db<{ status: string; count: number }[]>`
      select status, count(*)::int as count
      from erp.sms_messages
      where organization_id = ${organizationId.toString()} and created_at >= ${since}
      group by status
      order by status
    `;
    return rows.map((row) => ({ status: asString(row.status), count: Number(row.count ?? 0) }));
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}
