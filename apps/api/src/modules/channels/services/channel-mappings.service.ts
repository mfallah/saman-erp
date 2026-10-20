/**
 * Channel mapping application service: product/variant, order, inventory,
 * category and attribute mappings. External-id uniqueness is database-enforced.
 */
import { Inject, Injectable } from '@nestjs/common';

import { AppError } from '@saman/shared';
import { DB, type Db } from '../../../common/contracts';
import {
  MappingConflictError,
  SqlChannelMappingRepository,
  type ProductMappingRow,
} from '../repositories/channel-mapping.repository';
import { asNumber, asString } from '../infrastructure/sql';

export interface ProductMappingInput {
  readonly organizationId: string;
  readonly accountId: string;
  readonly variantId: string;
  readonly externalProductId: string;
  readonly externalVariantId: string;
  readonly externalSku?: string;
}

@Injectable()
export class ChannelMappingService {
  private readonly mappings: SqlChannelMappingRepository;

  constructor(@Inject(DB) private readonly db: Db) {
    this.mappings = new SqlChannelMappingRepository(db);
  }

  async createProductMapping(input: ProductMappingInput): Promise<ProductMappingRow> {
    try {
      return await this.mappings.upsertProductMapping({
        accountId: input.accountId,
        variantId: input.variantId,
        externalProductId: input.externalProductId,
        externalVariantId: input.externalVariantId,
        ...(input.externalSku === undefined ? {} : { externalSku: input.externalSku }),
      });
    } catch (error) {
      if (error instanceof MappingConflictError) {
        throw new AppError('CONFLICT', {
          message: 'این شناسهٔ بیرونی قبلاً به تنوع دیگری نگاشت شده است.',
          details: [{ field: 'externalVariantId', code: 'external_id_taken' }],
        });
      }
      throw error;
    }
  }

  async updateProductMapping(input: {
    organizationId: string;
    mappingId: string;
    externalProductId?: string;
    externalVariantId?: string;
    status?: string;
  }): Promise<void> {
    const result = await this.db`
      update erp.channel_product_mappings m
      set external_product_id = coalesce(${input.externalProductId ?? null}, m.external_product_id),
          external_variant_id = coalesce(${input.externalVariantId ?? null}, m.external_variant_id),
          sync_status = coalesce(${input.status ?? null}, m.sync_status),
          updated_at = now()
      from erp.channel_accounts a
      where m.id = ${input.mappingId}::bigint
        and a.id = m.channel_account_id
        and a.organization_id = ${input.organizationId}::bigint`;
    void result;
  }

  async deleteProductMapping(organizationId: string, mappingId: string): Promise<void> {
    await this.db`
      delete from erp.channel_product_mappings m
      using erp.channel_accounts a
      where m.id = ${mappingId}::bigint
        and a.id = m.channel_account_id
        and a.organization_id = ${organizationId}::bigint`;
  }

  async listProductMappings(
    organizationId: string,
    accountId: string,
    limit = 200,
  ): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.db<{ payload: unknown }[]>`
      select to_jsonb(m) as payload
      from erp.channel_product_mappings m
      join erp.channel_accounts a on a.id = m.channel_account_id
      where a.organization_id = ${organizationId}::bigint
        and a.id = ${accountId}::bigint
      order by m.id desc
      limit ${limit}`;
    return rows.map((row) =>
      typeof row.payload === 'object' && row.payload !== null
        ? (row.payload as Record<string, unknown>)
        : {},
    );
  }

  /** Called by the sales module after it creates the canonical order. */
  async linkCanonicalOrder(input: {
    accountId: string;
    salesOrderId: string;
    externalOrderId: string;
    externalStatus?: string;
    externalCreatedAt?: Date;
  }): Promise<void> {
    try {
      await this.mappings.linkOrder(input);
    } catch (error) {
      if (error instanceof MappingConflictError) {
        throw new AppError('CONFLICT', {
          message: 'این سفارش بیرونی قبلاً به سفارش دیگری نگاشت شده است.',
          details: [{ field: 'externalOrderId', code: 'external_order_taken' }],
        });
      }
      throw error;
    }
  }

  async listOrderMappings(
    organizationId: string,
    accountId: string,
    limit = 200,
  ): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.db<{ payload: unknown }[]>`
      select to_jsonb(m) as payload
      from erp.channel_order_mappings m
      join erp.channel_accounts a on a.id = m.channel_account_id
      where a.organization_id = ${organizationId}::bigint
        and a.id = ${accountId}::bigint
      order by m.id desc
      limit ${limit}`;
    return rows.map((row) =>
      typeof row.payload === 'object' && row.payload !== null
        ? (row.payload as Record<string, unknown>)
        : {},
    );
  }

  /** Inventory mapping upsert (bounded batches of 500 per API.md §4.10). */
  async upsertInventoryMappings(input: {
    organizationId: string;
    accountId: string;
    items: readonly {
      variantId: string;
      warehouseId: string;
      availableQty?: string;
      safetyQty?: string;
    }[];
  }): Promise<number> {
    if (input.items.length > 500) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'حداکثر ۵۰۰ نگاشت در هر درخواست مجاز است.',
      });
    }
    let affected = 0;
    for (const item of input.items) {
      await this.db`
        insert into erp.channel_inventory_mappings (
          channel_account_id, product_variant_id, warehouse_id, available_qty, safety_qty
        ) values (
          ${input.accountId}::bigint, ${item.variantId}::bigint, ${item.warehouseId}::bigint,
          ${item.availableQty ?? '0'}::numeric, ${item.safetyQty ?? '0'}::numeric
        )
        on conflict (channel_account_id, product_variant_id, warehouse_id) where deleted_at is null do update set
          available_qty = excluded.available_qty,
          safety_qty = excluded.safety_qty,
          sync_enabled = true,
          updated_at = now()`;
      affected += 1;
    }
    return affected;
  }

  async upsertCategoryMappings(input: {
    accountId: string;
    items: readonly { categoryId: string; externalCategoryId: string; externalCategoryName?: string }[];
  }): Promise<number> {
    for (const item of input.items) {
      await this.db`
        insert into erp.channel_category_mappings (
          channel_account_id, category_id, external_category_id, external_category_name
        ) values (
          ${input.accountId}::bigint, ${item.categoryId}::bigint, ${item.externalCategoryId},
          ${item.externalCategoryName ?? null}
        )
        on conflict (channel_account_id, category_id) where deleted_at is null do update set
          external_category_id = excluded.external_category_id,
          external_category_name = excluded.external_category_name,
          is_active = true`;
    }
    return input.items.length;
  }

  async upsertAttributeMappings(input: {
    accountId: string;
    items: readonly {
      attributeId: string;
      externalAttributeKey: string;
      valueMap?: Readonly<Record<string, string>>;
    }[];
  }): Promise<number> {
    for (const item of input.items) {
      await this.db`
        insert into erp.channel_attribute_mappings (
          channel_account_id, attribute_id, external_attribute_id, mapping_json, is_active
        ) values (
          ${input.accountId}::bigint, ${item.attributeId}::bigint, ${item.externalAttributeKey},
          ${JSON.stringify(item.valueMap ?? {})}::jsonb, true
        )
        on conflict (channel_account_id, attribute_id) where deleted_at is null do update set
          external_attribute_id = excluded.external_attribute_id,
          mapping_json = excluded.mapping_json,
          is_active = true`;
    }
    return input.items.length;
  }

  async inventoryAvailable(accountId: string, variantId: string, warehouseId: string): Promise<string> {
    const rows = await this.db<{ available_qty: unknown }[]>`
      select available_qty from erp.channel_inventory_mappings
      where channel_account_id = ${accountId}::bigint
        and product_variant_id = ${variantId}::bigint
        and warehouse_id = ${warehouseId}::bigint
      limit 1`;
    return rows[0] === undefined ? '0' : asString(rows[0].available_qty);
  }

  async markPushed(input: {
    accountId: string;
    variantId: string;
    warehouseId: string;
    qty: string;
  }): Promise<void> {
    await this.db`
      update erp.channel_inventory_mappings
      set last_pushed_qty = ${input.qty}::numeric, last_pushed_at = now(), last_push_error = null
      where channel_account_id = ${input.accountId}::bigint
        and product_variant_id = ${input.variantId}::bigint
        and warehouse_id = ${input.warehouseId}::bigint`;
    void asNumber;
  }
}
