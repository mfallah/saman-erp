/**
 * Append-only partner call log (`erp.channel_api_calls`, partitioned).
 * Only identifiers/hashes are persisted: no headers, no raw PII (H-10).
 */
import type { Db } from '../../../common/contracts';
import type { JsonValue } from '../domain/pii';
import { asDate, asNumber, asRecord, asString } from '../infrastructure/sql';

export interface ApiCallLogEntry {
  readonly organizationId: string;
  readonly channelAccountId: string;
  readonly operation: string;
  readonly method: string;
  /** Path only â€” never a query string that might carry a token. */
  readonly endpoint: string;
  readonly httpStatus: number | null;
  readonly success: boolean;
  readonly durationMs: number;
  readonly requestPayload: JsonValue;
  readonly responsePayload: JsonValue;
  readonly errorCode: string | null;
  readonly syncJobId: string | null;
  readonly traceId: string | null;
}

export interface ApiCallLogPort {
  record(entry: ApiCallLogEntry): Promise<void>;
  list(input: {
    organizationId: string;
    channelAccountId?: string;
    limit: number;
  }): Promise<readonly ApiCallLogRow[]>;
}

export interface ApiCallLogRow {
  readonly id: string;
  readonly operation: string;
  readonly method: string;
  readonly endpoint: string;
  readonly httpStatus: number | null;
  readonly success: boolean;
  readonly durationMs: number;
  readonly errorCode: string | null;
  readonly createdAt: Date | null;
}

interface RawRow {
  id: unknown;
  operation: unknown;
  method: unknown;
  endpoint: unknown;
  http_status: unknown;
  success: unknown;
  duration_ms: unknown;
  error_code: unknown;
  created_at: unknown;
}

export class SqlChannelApiCallRepository implements ApiCallLogPort {
  constructor(private readonly db: Db) {}

  async record(entry: ApiCallLogEntry): Promise<void> {
    await this.db`
      insert into erp.channel_api_calls (
        organization_id, channel_account_id, operation, method, endpoint,
        http_status, success, duration_ms, request_payload_redacted,
        response_payload_redacted, error_code, sync_job_id, trace_id
      ) values (
        ${entry.organizationId}::bigint, ${entry.channelAccountId}::bigint,
        ${entry.operation}, ${entry.method}, ${entry.endpoint},
        ${entry.httpStatus}, ${entry.success}, ${entry.durationMs},
        ${JSON.stringify(entry.requestPayload)}::jsonb,
        ${JSON.stringify(entry.responsePayload)}::jsonb,
        ${entry.errorCode}, ${entry.syncJobId}::bigint, ${entry.traceId}
      )`;
  }

  async list(input: {
    organizationId: string;
    channelAccountId?: string;
    limit: number;
  }): Promise<readonly ApiCallLogRow[]> {
    const rows =
      input.channelAccountId === undefined
        ? await this.db<RawRow[]>`
            select id::text, operation, method, endpoint, http_status, success,
                   duration_ms, error_code, created_at
            from erp.channel_api_calls
            where organization_id = ${input.organizationId}::bigint
            order by created_at desc
            limit ${input.limit}`
        : await this.db<RawRow[]>`
            select id::text, operation, method, endpoint, http_status, success,
                   duration_ms, error_code, created_at
            from erp.channel_api_calls
            where organization_id = ${input.organizationId}::bigint
              and channel_account_id = ${input.channelAccountId}::bigint
            order by created_at desc
            limit ${input.limit}`;
    return rows.map((row) => ({
      id: asString(row.id),
      operation: asString(row.operation),
      method: asString(row.method),
      endpoint: asString(row.endpoint),
      httpStatus: row.http_status === null ? null : asNumber(row.http_status),
      success: row.success === true,
      durationMs: asNumber(row.duration_ms),
      errorCode: row.error_code === null ? null : asString(row.error_code),
      createdAt: asDate(row.created_at),
    }));
  }

  /** For archive tests/diagnostics; never exposes payloads to the API. */
  async payload(rowId: string): Promise<JsonValue> {
    const rows = await this.db<{ payload: unknown }[]>`
      select request_payload_redacted as payload
      from erp.channel_api_calls where id = ${rowId}::bigint`;
    return asRecord(rows[0]?.payload) as JsonValue;
  }
}
