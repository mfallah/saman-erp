/**
 * Inbound webhook archive + replay store (R1-security H-10 / M-03).
 *
 * The archive stores a PII-minimised payload (`ids/hashes`, never headers and
 * never the raw body). Replay protection is the database unique index on
 * `(channel_account_id, external_event_id)`.
 */
import type { Db } from '../../../common/contracts';
import type { JsonValue } from '../domain/pii';
import { asDate, asNumber, asRecord, asString, withTransaction } from '../infrastructure/sql';

export interface ArchiveWebhookInput {
  readonly organizationId: string;
  readonly accountId: string;
  readonly externalEventId: string;
  readonly eventType: string;
  readonly payload: JsonValue;
  readonly rawBodySha256: string;
}

export type ArchiveWebhookResult =
  | { readonly duplicate: false; readonly id: string }
  | { readonly duplicate: true; readonly id: string | null; readonly payloadMismatch: boolean };

export interface WebhookEventRow {
  readonly id: string;
  readonly externalEventId: string | null;
  readonly eventType: string;
  readonly status: string;
  readonly attempts: number;
  readonly receivedAt: Date | null;
  readonly payload: Record<string, unknown>;
}

export interface ChannelWebhookRepositoryPort {
  archive(input: ArchiveWebhookInput): Promise<ArchiveWebhookResult>;
  /** Archive + outbox event in one transaction (crash-safe receiver). */
  archiveAndEmit(
    input: ArchiveWebhookInput,
    event: {
      organizationId: string;
      type: string;
      aggregateType: string;
      aggregateId: string;
      payload: JsonValue;
    },
  ): Promise<ArchiveWebhookResult>;
  findById(id: string): Promise<WebhookEventRow | null>;
  markStatus(
    id: string,
    status: 'processing' | 'processed' | 'ignored' | 'failed',
    error?: string,
  ): Promise<void>;
  list(input: {
    organizationId: string;
    accountId?: string;
    limit: number;
  }): Promise<readonly WebhookEventRow[]>;
  lastEventAt(channelCode: string): Promise<Date | null>;
}

interface RawWebhookRow {
  id: unknown;
  external_event_id: unknown;
  event_type: unknown;
  status: unknown;
  attempts: unknown;
  received_at: unknown;
  payload: unknown;
}

function mapEvent(row: RawWebhookRow): WebhookEventRow {
  return {
    id: asString(row.id),
    externalEventId: row.external_event_id === null ? null : asString(row.external_event_id),
    eventType: asString(row.event_type),
    status: asString(row.status),
    attempts: asNumber(row.attempts),
    receivedAt: asDate(row.received_at),
    payload: asRecord(row.payload),
  };
}

export class SqlChannelWebhookRepository implements ChannelWebhookRepositoryPort {
  private readonly outbox: OutboxWriterPort;

  constructor(
    private readonly db: Db,
    outbox?: OutboxWriterPort,
  ) {
    this.outbox = outbox ?? new SqlOutboxWriter();
  }

  async archive(input: ArchiveWebhookInput): Promise<ArchiveWebhookResult> {
    return withTransaction(this.db, async (tx) => this.insertEvent(tx, input));
  }

  async archiveAndEmit(
    input: ArchiveWebhookInput,
    event: {
      organizationId: string;
      type: string;
      aggregateType: string;
      aggregateId: string;
      payload: JsonValue;
    },
  ): Promise<ArchiveWebhookResult> {
    return withTransaction(this.db, async (tx) => {
      const result = await this.insertEvent(tx, input);
      if (!result.duplicate) {
        await this.outbox.emit(tx, {
          organizationId: event.organizationId,
          type: event.type,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          payload: event.payload,
        });
      }
      return result;
    });
  }

  private async insertEvent(tx: Db, input: ArchiveWebhookInput): Promise<ArchiveWebhookResult> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.channel_webhook_events (
        organization_id, channel_account_id, external_event_id, event_type,
        headers, payload, signature_valid, status
      ) values (
        ${input.organizationId}::bigint, ${input.accountId}::bigint,
        ${input.externalEventId}, ${input.eventType},
        '{}'::jsonb,
        ${JSON.stringify({ ...(input.payload as Record<string, JsonValue>), rawBodySha256: input.rawBodySha256 })}::jsonb,
        true, 'received'
      )
      on conflict (channel_account_id, external_event_id) do nothing
      returning id::text`;

    const inserted = rows[0];
    if (inserted !== undefined) return { duplicate: false, id: asString(inserted.id) };

    const existing = await tx<{ id: unknown; payload: unknown }[]>`
      select id, payload from erp.channel_webhook_events
      where channel_account_id = ${input.accountId}::bigint
        and external_event_id = ${input.externalEventId}
      limit 1`;
    const row = existing[0];
    const existingHash = asRecord(row?.payload)['rawBodySha256'];
    return {
      duplicate: true,
      id: row === undefined ? null : asString(row.id),
      payloadMismatch: typeof existingHash === 'string' && existingHash !== input.rawBodySha256,
    };
  }

  async findById(id: string): Promise<WebhookEventRow | null> {
    const rows = await this.db<RawWebhookRow[]>`
      select id, external_event_id, event_type, status, attempts, received_at, payload
      from erp.channel_webhook_events where id = ${id}::bigint`;
    return rows[0] === undefined ? null : mapEvent(rows[0]);
  }

  async markStatus(
    id: string,
    status: 'processing' | 'processed' | 'ignored' | 'failed',
    error?: string,
  ): Promise<void> {
    await this.db`
      update erp.channel_webhook_events
      set status = ${status},
          attempts = attempts + 1,
          processed_at = case when ${status} in ('processed', 'ignored') then now() else processed_at end,
          last_error = ${error === undefined ? null : error.slice(0, 2000)}
      where id = ${id}::bigint`;
  }

  async list(input: {
    organizationId: string;
    accountId?: string;
    limit: number;
  }): Promise<readonly WebhookEventRow[]> {
    const rows =
      input.accountId === undefined
        ? await this.db<RawWebhookRow[]>`
            select id, external_event_id, event_type, status, attempts, received_at, payload
            from erp.channel_webhook_events
            where organization_id = ${input.organizationId}::bigint
            order by received_at desc limit ${input.limit}`
        : await this.db<RawWebhookRow[]>`
            select id, external_event_id, event_type, status, attempts, received_at, payload
            from erp.channel_webhook_events
            where organization_id = ${input.organizationId}::bigint
              and channel_account_id = ${input.accountId}::bigint
            order by received_at desc limit ${input.limit}`;
    return rows.map(mapEvent);
  }

  async lastEventAt(channelCode: string): Promise<Date | null> {
    const rows = await this.db<{ received_at: unknown }[]>`
      select e.received_at
      from erp.channel_webhook_events e
      join erp.channel_accounts a on a.id = e.channel_account_id
      join erp.sales_channels c on c.id = a.channel_id
      where c.code = ${channelCode}
      order by e.received_at desc
      limit 1`;
    return rows[0] === undefined ? null : asDate(rows[0].received_at);
  }
}

/**
 * Outbox writer used by the webhook receiver: archive + event happen in one
 * transaction. When the platform `EVENT_BUS` provider exists, the service uses
 * that port instead of this fallback.
 */
export interface OutboxWriterPort {
  emit(
    tx: Db,
    event: {
      organizationId: string;
      type: string;
      aggregateType: string;
      aggregateId: string;
      payload: JsonValue;
      dedupeKey?: string;
    },
  ): Promise<void>;
}

export class SqlOutboxWriter implements OutboxWriterPort {
  async emit(
    tx: Db,
    event: {
      organizationId: string;
      type: string;
      aggregateType: string;
      aggregateId: string;
      payload: JsonValue;
      dedupeKey?: string;
    },
  ): Promise<void> {
    const inserted = await tx<{ id: string }[]>`
      insert into erp.outbox_events (
        organization_id, event_type, aggregate_type, aggregate_id, payload, status, available_at
      ) values (
        ${event.organizationId}::bigint, ${event.type}, ${event.aggregateType},
        ${event.aggregateId}::bigint, ${JSON.stringify(event.payload)}::jsonb, 'pending', now()
      )
      on conflict do nothing
      returning id::text`;
    if (inserted[0] !== undefined) {
      await tx`select pg_notify('saman_outbox', ${event.type})`;
    }
  }
}
