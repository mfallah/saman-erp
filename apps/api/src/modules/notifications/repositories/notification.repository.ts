/**
 * Notifications persistence: inbox (`erp.notifications`), preferences
 * (`erp.notification_preferences`) and templates.
 *
 * Data-model note: there is no dedicated `notification_templates` table; the
 * API's event→channel template is stored in `erp.sms_templates` with
 * `code = "<eventType>:<channel>"` and the channel kept in `variables` (reported
 * as an integration gap in the delivery report).
 */
import type { Db } from '../../../common/contracts';
import { asBool, asDate, asNumber, asRecord, asString } from './notification.sql';
import type { NotificationChannel, PreferenceRow, QuietHours } from '../domain/notification.policy';

export interface NotificationRecord {
  readonly organizationId: string;
  readonly userId: string;
  readonly eventType: string;
  readonly title: string;
  readonly body: string | null;
  readonly data: Record<string, unknown>;
  readonly channel: NotificationChannel;
  readonly priority: 'low' | 'normal' | 'high' | 'critical';
  readonly expiresAt: Date | null;
}

export interface NotificationRow {
  readonly id: string;
  readonly eventType: string;
  readonly title: string;
  readonly body: string | null;
  readonly data: Record<string, unknown>;
  readonly channel: string;
  readonly priority: string;
  readonly readAt: Date | null;
  readonly dismissedAt: Date | null;
  readonly createdAt: Date | null;
}

export interface NotificationTemplateRow {
  readonly id: string;
  readonly eventType: string;
  readonly channel: string;
  readonly subjectFa: string | null;
  readonly bodyFa: string;
  readonly variables: readonly string[];
  readonly isActive: boolean;
}

export interface NotificationRepositoryPort {
  insert(record: NotificationRecord): Promise<string>;
  list(input: {
    userId: string;
    unreadOnly: boolean;
    type?: string;
    limit: number;
  }): Promise<readonly NotificationRow[]>;
  findById(userId: string, id: string): Promise<NotificationRow | null>;
  markRead(userId: string, id: string): Promise<boolean>;
  markAllRead(userId: string): Promise<number>;
  dismiss(userId: string, id: string): Promise<boolean>;
  preferences(userId: string): Promise<readonly (PreferenceRow & { quietHours: QuietHours | null })[]>;
  upsertPreference(input: {
    userId: string;
    eventType: string;
    channel: string;
    enabled: boolean;
    quietHours?: QuietHours | null;
  }): Promise<void>;
  findTemplate(
    organizationId: string,
    eventType: string,
    channel: string,
  ): Promise<NotificationTemplateRow | null>;
  listTemplates(organizationId: string): Promise<readonly NotificationTemplateRow[]>;
  upsertTemplate(input: {
    organizationId: string;
    eventType: string;
    channel: NotificationChannel;
    subjectFa: string | null;
    bodyFa: string;
    variables: readonly string[];
    isActive: boolean;
  }): Promise<NotificationTemplateRow>;
  deleteTemplate(id: string): Promise<void>;
}

interface RawNotification {
  id: unknown;
  type: unknown;
  title: unknown;
  body: unknown;
  data: unknown;
  channel: unknown;
  priority: unknown;
  read_at: unknown;
  dismissed_at: unknown;
  created_at: unknown;
}

function mapNotification(row: RawNotification): NotificationRow {
  return {
    id: asString(row.id),
    eventType: asString(row.type),
    title: asString(row.title),
    body: row.body === null ? null : asString(row.body),
    data: asRecord(row.data),
    channel: asString(row.channel),
    priority: asString(row.priority),
    readAt: asDate(row.read_at),
    dismissedAt: asDate(row.dismissed_at),
    createdAt: asDate(row.created_at),
  };
}

export class SqlNotificationRepository implements NotificationRepositoryPort {
  constructor(private readonly db: Db) {}

  async insert(record: NotificationRecord): Promise<string> {
    const rows = await this.db<{ id: string }[]>`
      insert into erp.notifications (
        organization_id, user_id, type, title, body, data, channel, priority, expires_at
      ) values (
        ${record.organizationId}::bigint, ${record.userId}::bigint, ${record.eventType},
        ${record.title}, ${record.body}, ${JSON.stringify(record.data)}::jsonb,
        ${record.channel}, ${record.priority}, ${record.expiresAt}
      ) returning id::text`;
    const row = rows[0];
    if (row === undefined) throw new Error('notification_insert_failed');
    return asString(row.id);
  }

  async list(input: {
    userId: string;
    unreadOnly: boolean;
    type?: string;
    limit: number;
  }): Promise<readonly NotificationRow[]> {
    const rows = await this.db<RawNotification[]>`
      select id, type, title, body, data, channel, priority, read_at, dismissed_at, created_at
      from erp.notifications
      where user_id = ${input.userId}::bigint
        and dismissed_at is null
        and (${input.unreadOnly} = false or read_at is null)
        and (${input.type ?? null}::text is null or type = ${input.type ?? null})
      order by created_at desc
      limit ${input.limit}`;
    return rows.map(mapNotification);
  }

  async findById(userId: string, id: string): Promise<NotificationRow | null> {
    const rows = await this.db<RawNotification[]>`
      select id, type, title, body, data, channel, priority, read_at, dismissed_at, created_at
      from erp.notifications
      where id = ${id}::bigint and user_id = ${userId}::bigint`;
    return rows[0] === undefined ? null : mapNotification(rows[0]);
  }

  async markRead(userId: string, id: string): Promise<boolean> {
    const rows = await this.db<{ id: string }[]>`
      update erp.notifications
      set read_at = coalesce(read_at, now())
      where id = ${id}::bigint and user_id = ${userId}::bigint and dismissed_at is null
      returning id::text`;
    return rows.length > 0;
  }

  async markAllRead(userId: string): Promise<number> {
    const rows = await this.db<{ id: string }[]>`
      update erp.notifications
      set read_at = now()
      where user_id = ${userId}::bigint and read_at is null and dismissed_at is null
      returning id::text`;
    return rows.length;
  }

  async dismiss(userId: string, id: string): Promise<boolean> {
    const rows = await this.db<{ id: string }[]>`
      update erp.notifications
      set dismissed_at = now()
      where id = ${id}::bigint and user_id = ${userId}::bigint
      returning id::text`;
    return rows.length > 0;
  }

  async preferences(
    userId: string,
  ): Promise<readonly (PreferenceRow & { quietHours: QuietHours | null })[]> {
    const rows = await this.db<
      { event_type: unknown; channel: unknown; enabled: unknown; quiet_hours: unknown }[]
    >`
      select event_type, channel, enabled, quiet_hours
      from erp.notification_preferences
      where user_id = ${userId}::bigint`;
    return rows.map((row) => {
      const quiet = asRecord(row.quiet_hours);
      const from = quiet['from'];
      const to = quiet['to'];
      return {
        eventType: asString(row.event_type),
        channel: asString(row.channel),
        enabled: asBool(row.enabled),
        quietHours:
          typeof from === 'string' && typeof to === 'string' ? { from, to } : null,
      };
    });
  }

  async upsertPreference(input: {
    userId: string;
    eventType: string;
    channel: string;
    enabled: boolean;
    quietHours?: QuietHours | null;
  }): Promise<void> {
    await this.db`
      insert into erp.notification_preferences (user_id, event_type, channel, enabled, quiet_hours)
      values (
        ${input.userId}::bigint, ${input.eventType}, ${input.channel}, ${input.enabled},
        ${JSON.stringify(input.quietHours ?? {})}::jsonb
      )
      on conflict (user_id, event_type, channel) do update set
        enabled = excluded.enabled,
        quiet_hours = excluded.quiet_hours`;
  }

  async findTemplate(
    organizationId: string,
    eventType: string,
    channel: string,
  ): Promise<NotificationTemplateRow | null> {
    const rows = await this.db<RawTemplate[]>`
      select id, code, channel, event_type, subject_fa, body_fa, variables, is_active
      from erp.notification_templates
      where organization_id = ${organizationId}::bigint
        and event_type = ${eventType}
        and channel = ${channel}
        and is_active = true
        and deleted_at is null
      limit 1`;
    return rows[0] === undefined ? null : mapTemplate(rows[0]);
  }

  async listTemplates(organizationId: string): Promise<readonly NotificationTemplateRow[]> {
    const rows = await this.db<RawTemplate[]>`
      select id, code, channel, event_type, subject_fa, body_fa, variables, is_active
      from erp.notification_templates
      where organization_id = ${organizationId}::bigint and deleted_at is null
      order by event_type, channel`;
    return rows.map(mapTemplate);
  }

  async upsertTemplate(input: {
    organizationId: string;
    eventType: string;
    channel: NotificationChannel;
    subjectFa: string | null;
    bodyFa: string;
    variables: readonly string[];
    isActive: boolean;
  }): Promise<NotificationTemplateRow> {
    const rows = await this.db<RawTemplate[]>`
      insert into erp.notification_templates (
        organization_id, code, channel, event_type, subject_fa, body_fa,
        body_template, variables, is_active
      ) values (
        ${input.organizationId}::bigint, ${input.eventType}, ${input.channel},
        ${input.eventType}, ${input.subjectFa}, ${input.bodyFa},
        ${input.bodyFa}, ${JSON.stringify(input.variables)}::jsonb, ${input.isActive}
      )
      on conflict (organization_id, code, channel) where deleted_at is null do update set
        event_type = excluded.event_type,
        subject_fa = excluded.subject_fa,
        body_fa = excluded.body_fa,
        body_template = excluded.body_template,
        variables = excluded.variables,
        is_active = excluded.is_active
      returning id, code, channel, event_type, subject_fa, body_fa, variables, is_active`;
    const row = rows[0];
    if (row === undefined) throw new Error('notification_template_upsert_failed');
    return mapTemplate(row);
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.db`
      update erp.notification_templates
      set is_active = false, deleted_at = now()
      where id = ${id}::bigint`;
  }
}

interface RawTemplate {
  id: unknown;
  code: unknown;
  channel: unknown;
  event_type: unknown;
  subject_fa: unknown;
  body_fa: unknown;
  variables: unknown;
  is_active: unknown;
}

function mapTemplate(row: RawTemplate): NotificationTemplateRow {
  const variables = Array.isArray(row.variables)
    ? row.variables.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    id: asString(row.id),
    eventType: asString(row.event_type),
    channel: asString(row.channel),
    subjectFa: row.subject_fa === null ? null : asString(row.subject_fa),
    bodyFa: asString(row.body_fa),
    variables,
    isActive: row.is_active === true,
  };
}

export { asNumber };
