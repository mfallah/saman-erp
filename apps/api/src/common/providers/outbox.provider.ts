import { Injectable } from '@nestjs/common';
import type { Sql } from 'postgres';

/** postgres.js client typed for parametrised queries (the contracts Db alias has no custom types). */
type SqlClient = Sql<Record<string, unknown>>;

import {
  EVENT_BUS,
  type Db,
  type DomainEvent,
  type EventPort,
} from '../contracts';

const INTERNAL_ID_PATTERN = /^\d+$/;

function toInternalId(aggregateId: string | bigint): bigint {
  if (typeof aggregateId === 'bigint') return aggregateId;
  if (INTERNAL_ID_PATTERN.test(aggregateId)) return BigInt(aggregateId);
  throw new RangeError(
    'outbox: aggregateId must be the internal bigint id; public UUIDs are not routable by the dispatcher',
  );
}

/**
 * Transactional outbox writer (`ARCHITECTURE.md` §7, `ADR-0010`).
 * MUST be called inside the caller's transaction; the worker dispatches later.
 * `dedupeKey` is preserved in `headers` for consumer-side idempotency.
 */
@Injectable()
export class OutboxWriter implements EventPort {
  async emit(tx: Db, event: DomainEvent): Promise<void> {
    const aggregateId = toInternalId(event.aggregateId);
    const headers: Record<string, unknown> = {};
    if (event.dedupeKey !== undefined) {
      headers['dedupeKey'] = event.dedupeKey;
    }
    const availableAt = event.availableAt ?? new Date();

    const sql = tx as unknown as SqlClient;

    await sql`
      insert into erp.outbox_events (
        organization_id,
        event_type,
        event_version,
        aggregate_type,
        aggregate_id,
        payload,
        headers,
        available_at
      ) values (
        ${event.orgId},
        ${event.type},
        1,
        ${event.aggregateType},
        ${aggregateId},
        ${JSON.stringify(event.payload)}::jsonb,
        ${JSON.stringify(headers)}::jsonb,
        ${availableAt}
      )
    `;
  }
}

export { EVENT_BUS };
