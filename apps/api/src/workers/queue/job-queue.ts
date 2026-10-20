/**
 * Durable queue mirror in `erp.job_runs`.
 *
 * The supported topology uses BullMQ on Redis (ADR-0010). BullMQ is not a
 * dependency of this workspace snapshot, so the worker ships a DB-backed queue
 * with the same contract (`add`/`claim`/`complete`/`fail`) as the fallback; when
 * `bullmq` is installed, its adapter can be bound behind this port without
 * touching processors. Redis lost jobs are recoverable because the outbox/job
 * row remains unprocessed.
 */
import type { Db } from '../../common/contracts';
import { asDate, asNumber, asString } from '../../modules/channels/infrastructure/sql';
import type { QueueName } from '../job-payloads';

export interface QueuedJob {
  readonly id: string;
  readonly queue: QueueName;
  readonly jobType: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface JobQueuePort {
  add(input: {
    queue: QueueName;
    jobType: string;
    payload: Record<string, unknown>;
    scheduledAt?: Date;
    maxAttempts?: number;
    priority?: number;
  }): Promise<string>;
  claim(queue: QueueName, workerId: string, limit: number): Promise<readonly QueuedJob[]>;
  complete(id: string, result: Record<string, unknown>): Promise<void>;
  fail(id: string, errorCode: string, errorMessage: string, nextRunAt: Date): Promise<void>;
}

interface RawJob {
  id: unknown;
  queue: unknown;
  job_type: unknown;
  payload: unknown;
  attempts: unknown;
  max_attempts: unknown;
}

function mapJob(row: RawJob): QueuedJob {
  return {
    id: asString(row.id),
    queue: asString(row.queue) as QueueName,
    jobType: asString(row.job_type),
    payload:
      typeof row.payload === 'object' && row.payload !== null
        ? (row.payload as Record<string, unknown>)
        : {},
    attempts: asNumber(row.attempts),
    maxAttempts: asNumber(row.max_attempts),
  };
}

export class DatabaseJobQueue implements JobQueuePort {
  constructor(private readonly db: Db) {}

  async add(input: {
    queue: QueueName;
    jobType: string;
    payload: Record<string, unknown>;
    scheduledAt?: Date;
    maxAttempts?: number;
    priority?: number;
  }): Promise<string> {
    const rows = await this.db<{ id: string }[]>`
      insert into erp.job_runs (
        organization_id, queue, job_type, status, priority, max_attempts,
        scheduled_at, payload
      ) values (
        ${typeof input.payload['organizationId'] === 'string' ? input.payload['organizationId'] : null}::bigint,
        ${input.queue}, ${input.jobType}, 'queued', ${input.priority ?? 0},
        ${input.maxAttempts ?? 10}, ${input.scheduledAt ?? new Date()},
        ${JSON.stringify(input.payload)}::jsonb
      ) returning id::text`;
    const row = rows[0];
    if (row === undefined) throw new Error('job_enqueue_failed');
    return asString(row.id);
  }

  async claim(queue: QueueName, workerId: string, limit: number): Promise<readonly QueuedJob[]> {
    const rows = await this.db<RawJob[]>`
      with candidates as (
        select id from erp.job_runs
        where queue = ${queue}
          and attempts < max_attempts
          and (
            (status = 'queued' and scheduled_at <= now())
            or (status = 'running' and started_at < now() - interval '15 minutes')
          )
        order by priority desc, scheduled_at asc, id asc
        limit ${limit}
        for update skip locked
      )
      update erp.job_runs j
      set status = 'running', attempts = j.attempts + 1,
          started_at = coalesce(j.started_at, now()), worker_id = ${workerId}
      from candidates c
      where j.id = c.id
      returning j.id, j.queue, j.job_type, j.payload, j.attempts, j.max_attempts`;
    return rows.map(mapJob);
  }

  async complete(id: string, result: Record<string, unknown>): Promise<void> {
    await this.db`
      update erp.job_runs
      set status = 'succeeded', finished_at = now(),
          duration_ms = extract(epoch from (now() - started_at)) * 1000,
          progress_percent = 100, result = ${JSON.stringify(result)}::jsonb
      where id = ${id}::bigint`;
  }

  async fail(
    id: string,
    errorCode: string,
    errorMessage: string,
    nextRunAt: Date,
  ): Promise<void> {
    await this.db`
      update erp.job_runs
      set status = case when attempts >= max_attempts then 'dead' else 'failed' end,
          error_code = ${errorCode}, error_message = ${errorMessage.slice(0, 2000)},
          scheduled_at = ${nextRunAt}, finished_at = now()
      where id = ${id}::bigint`;
  }

  async get(id: string): Promise<{ status: string; attempts: number; maxAttempts: number } | null> {
    const rows = await this.db<{ status: unknown; attempts: unknown; max_attempts: unknown }[]>`
      select status, attempts, max_attempts from erp.job_runs where id = ${id}::bigint`;
    const row = rows[0];
    return row === undefined
      ? null
      : {
          status: asString(row.status),
          attempts: asNumber(row.attempts),
          maxAttempts: asNumber(row.max_attempts),
        };
  }
}

export { asDate };
