/**
 * Durable sync-job mirror + cursors + dead letters (`erp.channel_sync_jobs`,
 * `channel_sync_cursors`, `erp.integration_dead_letters`).
 */
import type { Db } from '../../../common/contracts';
import type { JsonValue } from '../domain/pii';
import { asDate, asNumber, asRecord, asString, withTransaction } from '../infrastructure/sql';

export const SYNC_JOB_TYPES = [
  'push_inventory',
  'push_price',
  'pull_orders',
  'push_order_status',
  'push_shipment',
  'pull_categories',
  'pull_attributes',
  'fulfill_order',
  'full_reconcile',
  'product_import',
  'token_refresh',
  'health_check',
] as const;
export type SyncJobType = (typeof SYNC_JOB_TYPES)[number];

export interface SyncJobRow {
  readonly id: string;
  readonly organizationId: string;
  readonly accountId: string;
  readonly jobType: SyncJobType;
  readonly status: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly operationKey: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly responseSummary: Record<string, unknown>;
}

export interface SyncCursorRow {
  readonly stream: string;
  readonly cursorValue: string | null;
  readonly cursorAt: Date | null;
}

export interface ChannelSyncRepositoryPort {
  enqueue(input: {
    organizationId: string;
    accountId: string;
    jobType: SyncJobType;
    operationKey?: string;
    entityType?: string;
    entityId?: string;
    maxAttempts?: number;
    nextRunAt?: Date;
  }): Promise<SyncJobRow>;
  markRunning(id: string, workerId: string): Promise<void>;
  markSucceeded(id: string, summary: JsonValue): Promise<void>;
  markFailed(id: string, errorCode: string, errorMessage: string, nextRunAt: Date): Promise<void>;
  markDead(id: string, errorCode: string, errorMessage: string): Promise<void>;
  getJob(id: string): Promise<SyncJobRow | null>;
  getCursor(accountId: string, stream: string): Promise<SyncCursorRow | null>;
  setCursor(input: {
    accountId: string;
    stream: string;
    cursorValue: string | null;
    cursorAt: Date | null;
  }): Promise<void>;
  deadLetter(input: {
    organizationId: string;
    integration: string;
    operation: string;
    entityType?: string;
    entityId?: string;
    payload: JsonValue;
    errorCode: string;
    errorMessage: string;
    retryCount: number;
  }): Promise<void>;
}

interface RawJobRow {
  id: unknown;
  organization_id: unknown;
  channel_account_id: unknown;
  job_type: unknown;
  status: unknown;
  attempts: unknown;
  max_attempts: unknown;
  operation_key: unknown;
  entity_type: unknown;
  entity_id: unknown;
  response_summary: unknown;
}

function mapJob(row: RawJobRow): SyncJobRow {
  return {
    id: asString(row.id),
    organizationId: asString(row.organization_id),
    accountId: asString(row.channel_account_id),
    jobType: asString(row.job_type) as SyncJobType,
    status: asString(row.status),
    attempts: asNumber(row.attempts),
    maxAttempts: asNumber(row.max_attempts),
    operationKey: row.operation_key === null ? null : asString(row.operation_key),
    entityType: row.entity_type === null ? null : asString(row.entity_type),
    entityId: row.entity_id === null ? null : asString(row.entity_id),
    responseSummary: asRecord(row.response_summary),
  };
}

export class SqlChannelSyncRepository implements ChannelSyncRepositoryPort {
  constructor(private readonly db: Db) {}

  async enqueue(input: {
    organizationId: string;
    accountId: string;
    jobType: SyncJobType;
    operationKey?: string;
    entityType?: string;
    entityId?: string;
    maxAttempts?: number;
    nextRunAt?: Date;
  }): Promise<SyncJobRow> {
    // The DDL has no unique index on (channel_account_id, operation_key), so
    // debounce idempotency is enforced with an advisory lock + live-job lookup.
    return withTransaction(this.db, async (tx) => {
      if (input.operationKey !== undefined && input.operationKey.length > 0) {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`sync|${input.accountId}|${input.operationKey}`}, 0))`;
        const existing = await tx<RawJobRow[]>`
          select id, organization_id, channel_account_id, job_type, status, attempts,
                 max_attempts, operation_key, entity_type, entity_id, response_summary
          from erp.channel_sync_jobs
          where channel_account_id = ${input.accountId}::bigint
            and operation_key = ${input.operationKey}
            and status in ('queued', 'running', 'succeeded')
          order by id desc
          limit 1`;
        if (existing[0] !== undefined) return mapJob(existing[0]);
      }
      const rows = await tx<RawJobRow[]>`
        insert into erp.channel_sync_jobs (
          organization_id, channel_account_id, job_type, entity_type, entity_id,
          operation_key, status, max_attempts, next_run_at, created_at
        ) values (
          ${input.organizationId}::bigint, ${input.accountId}::bigint, ${input.jobType},
          ${input.entityType ?? null}, ${input.entityId ?? null}::bigint,
          ${input.operationKey ?? null}, 'queued', ${input.maxAttempts ?? 10},
          ${input.nextRunAt ?? new Date()}, now()
        )
        returning id, organization_id, channel_account_id, job_type, status, attempts,
                  max_attempts, operation_key, entity_type, entity_id, response_summary`;
      const row = rows[0];
      if (row === undefined) throw new Error('channel_sync_enqueue_failed');
      return mapJob(row);
    });
  }

  async markRunning(id: string, workerId: string): Promise<void> {
    await this.db`
      update erp.channel_sync_jobs
      set status = 'running', locked_at = now(), locked_by = ${workerId},
          started_at = coalesce(started_at, now()), attempts = attempts + 1
      where id = ${id}::bigint and status in ('queued', 'failed')`;
  }

  async markSucceeded(id: string, summary: JsonValue): Promise<void> {
    await this.db`
      update erp.channel_sync_jobs
      set status = 'succeeded', finished_at = now(), last_error = null,
          response_summary = ${JSON.stringify(summary)}::jsonb
      where id = ${id}::bigint`;
  }

  async markFailed(
    id: string,
    errorCode: string,
    errorMessage: string,
    nextRunAt: Date,
  ): Promise<void> {
    await this.db`
      update erp.channel_sync_jobs
      set status = 'failed', last_error = ${`${errorCode}: ${errorMessage}`.slice(0, 1000)},
          next_run_at = ${nextRunAt}, locked_at = null, locked_by = null,
          finished_at = now()
      where id = ${id}::bigint`;
  }

  async markDead(id: string, errorCode: string, errorMessage: string): Promise<void> {
    await this.db`
      update erp.channel_sync_jobs
      set status = 'dead', attempts = max_attempts,
          last_error = ${`${errorCode}: ${errorMessage}`.slice(0, 1000)},
          locked_at = null, locked_by = null, finished_at = now()
      where id = ${id}::bigint`;
  }

  async getJob(id: string): Promise<SyncJobRow | null> {
    const rows = await this.db<RawJobRow[]>`
      select id, organization_id, channel_account_id, job_type, status, attempts,
             max_attempts, operation_key, entity_type, entity_id, response_summary
      from erp.channel_sync_jobs where id = ${id}::bigint`;
    return rows[0] === undefined ? null : mapJob(rows[0]);
  }

  async getCursor(accountId: string, stream: string): Promise<SyncCursorRow | null> {
    const rows = await this.db<
      { stream: unknown; cursor_value: unknown; cursor_at: unknown }[]
    >`
      select stream, cursor_value, cursor_at
      from erp.channel_sync_cursors
      where channel_account_id = ${accountId}::bigint and stream = ${stream}
      limit 1`;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      stream: asString(row.stream),
      cursorValue: row.cursor_value === null ? null : asString(row.cursor_value),
      cursorAt: asDate(row.cursor_at),
    };
  }

  async setCursor(input: {
    accountId: string;
    stream: string;
    cursorValue: string | null;
    cursorAt: Date | null;
  }): Promise<void> {
    await this.db`
      insert into erp.channel_sync_cursors (
        channel_account_id, stream, cursor_value, cursor_at, last_success_at
      ) values (
        ${input.accountId}::bigint, ${input.stream}, ${input.cursorValue},
        ${input.cursorAt}, now()
      )
      on conflict (channel_account_id, stream) do update set
        cursor_value = excluded.cursor_value,
        cursor_at = excluded.cursor_at,
        last_success_at = now(),
        last_error = null`;
  }

  async deadLetter(input: {
    organizationId: string;
    integration: string;
    operation: string;
    entityType?: string;
    entityId?: string;
    payload: JsonValue;
    errorCode: string;
    errorMessage: string;
    retryCount: number;
  }): Promise<void> {
    await this.db`
      insert into erp.integration_dead_letters (
        organization_id, integration, operation, entity_type, entity_id,
        payload, error_code, error_message, retry_count, first_failed_at, last_failed_at, status
      ) values (
        ${input.organizationId}::bigint, ${input.integration}, ${input.operation},
        ${input.entityType ?? null}, ${input.entityId ?? null}::bigint,
        ${JSON.stringify(input.payload)}::jsonb, ${input.errorCode},
        ${input.errorMessage.slice(0, 2000)}, ${input.retryCount}, now(), now(), 'open'
      )`;
  }
}
