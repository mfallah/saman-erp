/**
 * Outbound webhook subscriptions + delivery attempts (API.md §6.2, H-04).
 */
import type { Db } from '../../../common/contracts';
import type { JsonValue } from '../domain/pii';
import { asDate, asNumber, asRecord, asString } from '../infrastructure/sql';

export interface OutboundSubscriptionRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly endpointUrl: string;
  readonly eventFilters: readonly string[];
  readonly signingSecretCiphertext: string | null;
  readonly signingKeyVersion: number;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly isActive: boolean;
}

export interface DeliveryRow {
  readonly id: string;
  readonly attemptNo: number;
  readonly status: string;
}

export interface OutboundWebhookRepositoryPort {
  listActive(organizationId: string, eventType: string): Promise<readonly OutboundSubscriptionRow[]>;
  create(input: {
    organizationId: string;
    code: string;
    name: string;
    endpointUrl: string;
    eventFilters: readonly string[];
    signingSecretCiphertext: string;
  }): Promise<OutboundSubscriptionRow>;
  update(input: {
    organizationId: string;
    id: string;
    endpointUrl?: string;
    eventFilters?: readonly string[];
    isActive?: boolean;
  }): Promise<OutboundSubscriptionRow>;
  deactivate(id: string): Promise<void>;
  recordAttempt(input: {
    subscriptionId: string;
    eventType: string;
    entityType: string | null;
    entityId: string | null;
    eventUuid: string;
    attemptNo: number;
    status: 'pending' | 'delivered' | 'failed' | 'dead' | 'cancelled';
    httpStatus: number | null;
    responseSnippet: string | null;
    durationMs: number;
    nextRetryAt: Date | null;
    errorMessage: string | null;
    requestPayload: JsonValue;
  }): Promise<DeliveryRow>;
  listDeliveries(input: {
    organizationId: string;
    subscriptionId?: string;
    limit: number;
  }): Promise<readonly Record<string, unknown>[]>;
}

interface RawSubRow {
  id: unknown;
  code: unknown;
  name: unknown;
  endpoint_url: unknown;
  event_filters: unknown;
  signing_secret_ciphertext: unknown;
  signing_key_version: unknown;
  max_attempts: unknown;
  timeout_ms: unknown;
  is_active: unknown;
}

function mapSub(row: RawSubRow): OutboundSubscriptionRow {
  const filters = Array.isArray(row.event_filters) ? row.event_filters : [];
  return {
    id: asString(row.id),
    code: asString(row.code),
    name: asString(row.name),
    endpointUrl: asString(row.endpoint_url),
    eventFilters: filters.filter((item): item is string => typeof item === 'string'),
    signingSecretCiphertext:
      row.signing_secret_ciphertext === null ? null : asString(row.signing_secret_ciphertext),
    signingKeyVersion: asNumber(row.signing_key_version),
    maxAttempts: asNumber(row.max_attempts),
    timeoutMs: asNumber(row.timeout_ms),
    isActive: row.is_active === true,
  };
}

const SUB_COLUMNS = `id, code, name, endpoint_url, event_filters, signing_secret_ciphertext,
  signing_key_version, max_attempts, timeout_ms, is_active`;

export class SqlOutboundWebhookRepository implements OutboundWebhookRepositoryPort {
  constructor(private readonly db: Db) {}

  async listActive(
    organizationId: string,
    eventType: string,
  ): Promise<readonly OutboundSubscriptionRow[]> {
    const rows = await this.db<RawSubRow[]>`
      select id, code, name, endpoint_url, event_filters, signing_secret_ciphertext,
             signing_key_version, max_attempts, timeout_ms, is_active
      from erp.webhook_subscriptions
      where organization_id = ${organizationId}::bigint
        and is_active = true
        and (event_filters @> ${JSON.stringify([eventType])}::jsonb or event_filters = '[]'::jsonb)`;
    return rows.map(mapSub);
  }

  async create(input: {
    organizationId: string;
    code: string;
    name: string;
    endpointUrl: string;
    eventFilters: readonly string[];
    signingSecretCiphertext: string;
  }): Promise<OutboundSubscriptionRow> {
    const rows = await this.db<RawSubRow[]>`
      insert into erp.webhook_subscriptions (
        organization_id, code, name, endpoint_url, event_filters,
        signing_secret_ciphertext, is_active
      ) values (
        ${input.organizationId}::bigint, ${input.code}, ${input.name}, ${input.endpointUrl},
        ${JSON.stringify(input.eventFilters)}::jsonb, ${input.signingSecretCiphertext}, true
      )
      returning id, code, name, endpoint_url, event_filters, signing_secret_ciphertext,
                signing_key_version, max_attempts, timeout_ms, is_active`;
    const row = rows[0];
    if (row === undefined) throw new Error('webhook_subscription_create_failed');
    return mapSub(row);
  }

  async update(input: {
    organizationId: string;
    id: string;
    endpointUrl?: string;
    eventFilters?: readonly string[];
    isActive?: boolean;
  }): Promise<OutboundSubscriptionRow> {
    const rows = await this.db<RawSubRow[]>`
      update erp.webhook_subscriptions set
        endpoint_url = coalesce(${input.endpointUrl ?? null}, endpoint_url),
        event_filters = coalesce(${input.eventFilters === undefined ? null : JSON.stringify(input.eventFilters)}::jsonb, event_filters),
        is_active = coalesce(${input.isActive ?? null}::boolean, is_active),
        updated_at = now()
      where organization_id = ${input.organizationId}::bigint and id = ${input.id}::bigint
      returning id, code, name, endpoint_url, event_filters, signing_secret_ciphertext,
                signing_key_version, max_attempts, timeout_ms, is_active`;
    const row = rows[0];
    if (row === undefined) throw new Error('webhook_subscription_not_found');
    return mapSub(row);
  }

  async deactivate(id: string): Promise<void> {
    await this.db`
      update erp.webhook_subscriptions set is_active = false, updated_at = now()
      where id = ${id}::bigint`;
  }

  async recordAttempt(input: {
    subscriptionId: string;
    eventType: string;
    entityType: string | null;
    entityId: string | null;
    eventUuid: string;
    attemptNo: number;
    status: 'pending' | 'delivered' | 'failed' | 'dead' | 'cancelled';
    httpStatus: number | null;
    responseSnippet: string | null;
    durationMs: number;
    nextRetryAt: Date | null;
    errorMessage: string | null;
    requestPayload: JsonValue;
  }): Promise<DeliveryRow> {
    const rows = await this.db<{ id: unknown; attempt_no: unknown; status: unknown }[]>`
      insert into erp.webhook_deliveries (
        subscription_id, event_type, entity_type, entity_id, event_uuid, attempt_no,
        status, http_status, response_snippet, duration_ms, next_retry_at,
        delivered_at, error_message, request_payload
      ) values (
        ${input.subscriptionId}::bigint, ${input.eventType}, ${input.entityType},
        ${input.entityId}::bigint, ${input.eventUuid}::uuid, ${input.attemptNo},
        ${input.status}, ${input.httpStatus},
        ${input.responseSnippet === null ? null : input.responseSnippet.slice(0, 500)},
        ${input.durationMs}, ${input.nextRetryAt},
        ${input.status === 'delivered' ? new Date() : null}, ${input.errorMessage},
        ${JSON.stringify(input.requestPayload)}::jsonb
      )
      on conflict (subscription_id, event_uuid, attempt_no) do update set
        status = excluded.status, http_status = excluded.http_status,
        response_snippet = excluded.response_snippet, duration_ms = excluded.duration_ms,
        next_retry_at = excluded.next_retry_at, delivered_at = excluded.delivered_at,
        error_message = excluded.error_message
      returning id, attempt_no, status`;
    const row = rows[0];
    if (row === undefined) throw new Error('webhook_delivery_insert_failed');
    return {
      id: asString(row.id),
      attemptNo: asNumber(row.attempt_no),
      status: asString(row.status),
    };
  }

  async listDeliveries(input: {
    organizationId: string;
    subscriptionId?: string;
    limit: number;
  }): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.db<{ payload: unknown }[]>`
      select to_jsonb(d) as payload
      from erp.webhook_deliveries d
      join erp.webhook_subscriptions s on s.id = d.subscription_id
      where s.organization_id = ${input.organizationId}::bigint
        and (${input.subscriptionId ?? null}::bigint is null or d.subscription_id = ${input.subscriptionId ?? null}::bigint)
      order by d.created_at desc
      limit ${input.limit}`;
    return rows.map((row) => asRecord(row.payload));
  }
}

export { asDate };
