/**
 * Outbox persistence with `FOR UPDATE SKIP LOCKED` batches + `LISTEN/NOTIFY`
 * hint (ADR-0010). Claiming increments `attempts` exactly once per execution so
 * a crashed worker can reclaim stale `processing` rows.
 */
import type { Db } from '../../common/contracts';
import type { JsonValue } from '../../modules/channels/domain/pii';
import { asDate, asNumber, asRecord, asString } from '../../modules/channels/infrastructure/sql';

export interface OutboxEventRow {
  readonly id: string;
  readonly organizationId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly availableAt: Date | null;
}

export interface OutboxStorePort {
  claimBatch(limit: number, workerId: string): Promise<readonly OutboxEventRow[]>;
  markProcessed(id: string): Promise<void>;
  markFailed(id: string, nextAvailableAt: Date, error: string): Promise<void>;
  deadLetter(event: OutboxEventRow, error: string): Promise<void>;
  oldestLagSeconds(): Promise<number>;
  notifyChannel(): Promise<void>;
  listen?(onNotify: () => void): Promise<{ unlisten(): Promise<void> }>;
}

interface RawRow {
  id: unknown;
  organization_id: unknown;
  event_type: unknown;
  event_version: unknown;
  aggregate_type: unknown;
  aggregate_id: unknown;
  payload: unknown;
  attempts: unknown;
  max_attempts: unknown;
  available_at: unknown;
}

function mapRow(row: RawRow): OutboxEventRow {
  return {
    id: asString(row.id),
    organizationId: asString(row.organization_id),
    eventType: asString(row.event_type),
    eventVersion: asNumber(row.event_version),
    aggregateType: asString(row.aggregate_type),
    aggregateId: asString(row.aggregate_id),
    payload: asRecord(row.payload),
    attempts: asNumber(row.attempts),
    maxAttempts: asNumber(row.max_attempts),
    availableAt: asDate(row.available_at),
  };
}

export class SqlOutboxStore implements OutboxStorePort {
  constructor(private readonly db: Db) {}

  async claimBatch(limit: number, workerId: string): Promise<readonly OutboxEventRow[]> {
    // Partitioned table: the id-only locking CTE keeps the lock set small.
    const rows = await this.db<RawRow[]>`
      with candidates as (
        select id
        from erp.outbox_events
        where attempts < max_attempts
          and (
            (status in ('pending', 'failed') and available_at <= now())
            or (status = 'processing' and locked_at < now() - interval '5 minutes')
          )
        order by available_at asc, id asc
        limit ${limit}
        for update skip locked
      )
      update erp.outbox_events e
      set status = 'processing',
          attempts = e.attempts + 1,
          locked_by = ${workerId},
          locked_at = now()
      from candidates c
      where e.id = c.id
      returning e.id, e.organization_id, e.event_type, e.event_version,
                e.aggregate_type, e.aggregate_id, e.payload, e.attempts,
                e.max_attempts, e.available_at`;
    return rows.map(mapRow);
  }

  async markProcessed(id: string): Promise<void> {
    await this.db`
      update erp.outbox_events
      set status = 'processed', processed_at = now(), locked_at = null, locked_by = null
      where id = ${id}::bigint`;
  }

  async markFailed(id: string, nextAvailableAt: Date, error: string): Promise<void> {
    await this.db`
      update erp.outbox_events
      set status = 'failed', available_at = ${nextAvailableAt},
          last_error = ${error.slice(0, 2000)}, locked_at = null, locked_by = null
      where id = ${id}::bigint`;
  }

  async deadLetter(event: OutboxEventRow, error: string): Promise<void> {
    await this.db`
      insert into erp.integration_dead_letters (
        organization_id, integration, operation, entity_type, entity_id,
        payload, error_code, error_message, retry_count, first_failed_at, last_failed_at, status
      ) values (
        ${event.organizationId}::bigint, 'outbox', ${event.eventType},
        ${event.aggregateType}, ${event.aggregateId}::bigint,
        ${JSON.stringify(event.payload)}::jsonb, 'OUTBOX_DISPATCH_FAILED',
        ${error.slice(0, 2000)}, ${event.attempts}, now(), now(), 'open'
      )`;
    await this.db`
      update erp.outbox_events
      set status = 'failed', attempts = max_attempts,
          last_error = ${error.slice(0, 2000)}, locked_at = null, locked_by = null
      where id = ${event.id}::bigint`;
  }

  async oldestLagSeconds(): Promise<number> {
    const rows = await this.db<{ lag: unknown }[]>`
      select extract(epoch from (now() - min(available_at)))::float8 as lag
      from erp.outbox_events
      where status in ('pending', 'failed') and attempts < max_attempts`;
    return rows[0] === undefined ? 0 : Math.max(0, asNumber(rows[0].lag));
  }

  async notifyChannel(): Promise<void> {
    await this.db`select pg_notify('saman_outbox', ${'wake'})`;
  }

  async listen(onNotify: () => void): Promise<{ unlisten(): Promise<void> }> {
    const request = this.db.listen('saman_outbox', () => onNotify());
    return {
      unlisten: async () => {
        const meta = await request;
        await meta.unlisten();
      },
    };
  }
}

export { type JsonValue };
