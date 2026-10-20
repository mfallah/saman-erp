import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Sql } from 'postgres';

/** postgres.js client typed for parametrised queries (the contracts Db alias has no custom types). */
type SqlClient = Sql<Record<string, unknown>>;

import {
  AUDIT,
  type AuditEvent,
  type AuditPort,
  type Db,
} from '../contracts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function hashUserAgent(userAgent: string | undefined): string | null {
  if (userAgent === undefined || userAgent === '') return null;
  return createHash('sha256').update(userAgent, 'utf8').digest('hex');
}

/**
 * Append-only audit writer (`SECURITY.md`, `DATA-MODEL.md` `audit_logs`).
 * MUST be called inside the caller's transaction so a failed write never leaves a
 * successful business change unaudited (`ARCHITECTURE.md` §6).
 */
@Injectable()
export class AuditWriter implements AuditPort {
  async record(tx: Db, event: AuditEvent): Promise<void> {
    const entityId = typeof event.entityId === 'bigint' ? event.entityId : null;
    const entityPublicId =
      typeof event.entityId === 'string' && isUuid(event.entityId) ? event.entityId : null;
    const requestId = isUuid(event.requestId) ? event.requestId : null;
    const actorId = event.actorId ?? null;
    const severity = event.meta?.['severity'];

    const sql = tx as unknown as SqlClient;

    await sql`
      insert into erp.audit_logs (
        organization_id,
        actor_user_id,
        actor_type,
        entity_type,
        entity_public_id,
        entity_id,
        action,
        old_data,
        new_data,
        ip_address,
        user_agent_hash,
        request_id,
        severity
      ) values (
        ${event.orgId},
        ${actorId},
        ${actorId === null ? 'system' : 'user'},
        ${event.entityType},
        ${entityPublicId},
        ${entityId},
        ${event.action},
        ${event.before === undefined ? null : JSON.stringify(event.before)}::jsonb,
        ${event.after === undefined ? null : JSON.stringify(event.after)}::jsonb,
        ${event.ip ?? null},
        ${hashUserAgent(event.userAgent)},
        ${requestId},
        ${typeof severity === 'string' && ['info', 'warning', 'critical'].includes(severity) ? severity : 'info'}
      )
    `;
  }
}

export { AUDIT };
