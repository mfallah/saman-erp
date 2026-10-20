/**
 * External-id mappings and natural-key idempotency (ADR-0006 §3).
 *
 * Uniqueness is enforced by the database; this repository translates unique
 * violations into a typed conflict rather than leaking driver errors.
 */
import type { Db } from '../../../common/contracts';
import { isUniqueViolation, withTransaction } from '../infrastructure/sql';
import { asString } from '../infrastructure/sql';

export class MappingConflictError extends Error {
  constructor(readonly externalId: string) {
    super('mapping_conflict');
    this.name = 'MappingConflictError';
  }
}

export interface ProductMappingRow {
  readonly id: string;
  readonly externalProductId: string | null;
  readonly externalVariantId: string | null;
  readonly externalSku: string | null;
  readonly syncStatus: string;
  readonly isPublished: boolean;
}

export interface OrderIntakeResult {
  readonly duplicate: boolean;
  readonly requestMismatch: boolean;
}

export interface ChannelMappingRepositoryPort {
  findProductMapping(accountId: string, variantId: string): Promise<ProductMappingRow | null>;
  findProductMappingByExternal(
    accountId: string,
    externalVariantId: string,
  ): Promise<ProductMappingRow | null>;
  upsertProductMapping(input: {
    accountId: string;
    variantId: string;
    externalProductId: string;
    externalVariantId: string;
    externalSku?: string;
    isPublished?: boolean;
  }): Promise<ProductMappingRow>;
  recordOrderIntake(input: {
    organizationId: string;
    accountId: string;
    externalOrderId: string;
    requestHash: string;
  }): Promise<OrderIntakeResult>;
  linkOrder(input: {
    accountId: string;
    salesOrderId: string;
    externalOrderId: string;
    externalStatus?: string;
    externalCreatedAt?: Date;
  }): Promise<void>;
}

interface RawMappingRow {
  id: unknown;
  external_product_id: unknown;
  external_variant_id: unknown;
  external_sku: unknown;
  sync_status: unknown;
  is_published: unknown;
}

function mapMapping(row: RawMappingRow): ProductMappingRow {
  return {
    id: asString(row.id),
    externalProductId: row.external_product_id === null ? null : asString(row.external_product_id),
    externalVariantId: row.external_variant_id === null ? null : asString(row.external_variant_id),
    externalSku: row.external_sku === null ? null : asString(row.external_sku),
    syncStatus: asString(row.sync_status),
    isPublished: row.is_published === true,
  };
}

export class SqlChannelMappingRepository implements ChannelMappingRepositoryPort {
  constructor(private readonly db: Db) {}

  async findProductMapping(accountId: string, variantId: string): Promise<ProductMappingRow | null> {
    const rows = await this.db<RawMappingRow[]>`
      select id, external_product_id, external_variant_id, external_sku, sync_status, is_published
      from erp.channel_product_mappings
      where channel_account_id = ${accountId}::bigint
        and product_variant_id = ${variantId}::bigint
      limit 1`;
    return rows[0] === undefined ? null : mapMapping(rows[0]);
  }

  async findProductMappingByExternal(
    accountId: string,
    externalVariantId: string,
  ): Promise<ProductMappingRow | null> {
    const rows = await this.db<RawMappingRow[]>`
      select id, external_product_id, external_variant_id, external_sku, sync_status, is_published
      from erp.channel_product_mappings
      where channel_account_id = ${accountId}::bigint
        and external_variant_id = ${externalVariantId}
      limit 1`;
    return rows[0] === undefined ? null : mapMapping(rows[0]);
  }

  async upsertProductMapping(input: {
    accountId: string;
    variantId: string;
    externalProductId: string;
    externalVariantId: string;
    externalSku?: string;
    isPublished?: boolean;
  }): Promise<ProductMappingRow> {
    try {
      const rows = await this.db<RawMappingRow[]>`
        insert into erp.channel_product_mappings (
          channel_account_id, product_variant_id, external_product_id,
          external_variant_id, external_sku, sync_status, is_published, last_synced_at
        ) values (
          ${input.accountId}::bigint, ${input.variantId}::bigint, ${input.externalProductId},
          ${input.externalVariantId}, ${input.externalSku ?? null},
          'synced', ${input.isPublished ?? true}, now()
        )
        on conflict (channel_account_id, product_variant_id)
          where deleted_at is null
          do update set
          external_product_id = excluded.external_product_id,
          external_variant_id = excluded.external_variant_id,
          external_sku = excluded.external_sku,
          sync_status = 'synced',
          is_published = excluded.is_published,
          last_synced_at = now(),
          last_error = null
        returning id, external_product_id, external_variant_id, external_sku, sync_status, is_published`;
      const row = rows[0];
      if (row === undefined) throw new MappingConflictError(input.externalVariantId);
      return mapMapping(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new MappingConflictError(input.externalVariantId);
      throw error;
    }
  }

  /**
   * Two-layer idempotency (API.md §6.1): natural business key in
   * `idempotency_keys`. A different payload for the same key is reported as a
   * mismatch (archived/alerted by the caller) but remains a no-op.
   */
  async recordOrderIntake(input: {
    organizationId: string;
    accountId: string;
    externalOrderId: string;
    requestHash: string;
  }): Promise<OrderIntakeResult> {
    return withTransaction(this.db, async (tx) => {
      const key = `channel:order:${input.externalOrderId}`;
      const scope = `channels.order_pull:${input.accountId}`;
      // Serialize producers for the natural key: the physical unique index
      // includes nullable actor_user_id, so NULL would not dedupe on its own.
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${input.organizationId}|${scope}|${key}`}, 0))`;
      const existing = await tx<{ request_hash: string }[]>`
        select request_hash from erp.idempotency_keys
        where organization_id = ${input.organizationId}::bigint
          and scope = ${scope}
          and key = ${key}
        order by id desc
        limit 1`;
      if (existing[0] !== undefined) {
        return {
          duplicate: true,
          requestMismatch: existing[0].request_hash !== input.requestHash,
        };
      }
      await tx`
        insert into erp.idempotency_keys (
          organization_id, key, scope, request_hash, expires_at
        ) values (
          ${input.organizationId}::bigint, ${key}, ${scope},
          ${input.requestHash}, now() + interval '7 days'
        )`;
      return { duplicate: false, requestMismatch: false };
    });
  }

  async linkOrder(input: {
    accountId: string;
    salesOrderId: string;
    externalOrderId: string;
    externalStatus?: string;
    externalCreatedAt?: Date;
  }): Promise<void> {
    try {
      await this.db`
        insert into erp.channel_order_mappings (
          channel_account_id, sales_order_id, external_order_id, external_status,
          external_created_at, last_synced_at
        ) values (
          ${input.accountId}::bigint, ${input.salesOrderId}::bigint, ${input.externalOrderId},
          ${input.externalStatus ?? null}, ${input.externalCreatedAt ?? null}, now()
        )
        on conflict (channel_account_id, external_order_id) do update set
          external_status = excluded.external_status,
          last_synced_at = now()`;
    } catch (error) {
      if (isUniqueViolation(error)) throw new MappingConflictError(input.externalOrderId);
      throw error;
    }
  }
}
