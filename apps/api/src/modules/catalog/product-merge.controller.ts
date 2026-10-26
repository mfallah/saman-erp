/**
 * Manual product merge (`POST /products/:targetId/merge`).
 *
 * Catalog imports (Carexy, Digikala) can create a second local product for a
 * SKU that already exists in the ERP. An operator picks the canonical product
 * as the target and folds the duplicate into it: matching variants are merged
 * (channel mappings re-pointed, the duplicate variant soft-deleted) and
 * distinct variants move under the target. Inventory rows are never moved or
 * deleted — stock stays bound to the variant rows that own it.
 */
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppError } from '@saman/shared';
import { z } from 'zod';

import { DB, type TenantContext } from '../../common/contracts';
import { Audited } from '../../common/decorators/audited.decorator';
import { CurrentTenant } from '../../common/decorators/current-context.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { apiData } from '../../common/interceptors/response.interceptor';
import { notFound, type Db } from './pg-support';
import { PublicId, parseWith } from './dto/common';

const MergeParams = z.object({ targetId: PublicId });
const MergeBody = z.object({ sourceProductId: PublicId });
const CandidatesQuery = z.object({
  q: z.string().trim().max(100).optional(),
  excludeId: PublicId.optional(),
});

const CANDIDATE_LIMIT = 20;

interface MergeProductRow {
  readonly id: string;
  readonly public_id: string;
  readonly description: string | null;
  readonly category_id: string | null;
  readonly brand_id: string | null;
  readonly name_en: string | null;
}

interface VariantRow {
  readonly id: string;
  readonly sku: string;
}

interface CandidateRow {
  readonly id: string;
  readonly product_no: string;
  readonly name: string;
  readonly name_en: string | null;
  readonly status: string;
  readonly category_name: string | null;
  readonly sku: string | null;
  readonly variant_count: string;
  readonly updated_at: Date | string;
}

@ApiTags('catalog')
@ApiBearerAuth()
@Controller('products')
export class ProductMergeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Products the operator can pick as the duplicate. `excludeId` keeps the
   * current product out of its own merge picker.
   */
  @Get('merge/candidates')
  @Permissions('product.read')
  @ApiOperation({ summary: 'Search products for the manual merge picker' })
  async candidates(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(CandidatesQuery, query);
    const search = q.q === undefined || q.q === '' ? null : `%${q.q.replace(/[%_\\]/g, '\\$&')}%`;
    const excludeId = q.excludeId ?? null;
    const rows = await this.db<CandidateRow[]>`
      select p.public_id::text as id,
             p.product_no,
             p.name,
             p.name_en,
             p.status,
             c.name as category_name,
             (
               select v.sku from erp.product_variants v
               where v.product_id = p.id and v.deleted_at is null
               order by v.is_default desc, v.sort_order, v.id
               limit 1
             ) as sku,
             (
               select count(*) from erp.product_variants v
               where v.product_id = p.id and v.deleted_at is null
             )::text as variant_count,
             p.updated_at
      from erp.products p
      left join erp.product_categories c on c.id = p.category_id and c.deleted_at is null
      where p.organization_id = ${ctx.orgId}
        and p.deleted_at is null
        and (${excludeId}::uuid is null or p.public_id <> ${excludeId}::uuid)
        and (
          ${search}::text is null
          or p.name ilike ${search}
          or p.name_en ilike ${search}
          or p.product_no ilike ${search}
          or exists (
            select 1 from erp.product_variants v
            where v.product_id = p.id and v.deleted_at is null and v.sku ilike ${search}
          )
        )
      order by p.updated_at desc, p.id desc
      limit ${CANDIDATE_LIMIT}
    `;
    return apiData(
      rows.map((row) => ({
        id: row.id,
        productNo: row.product_no,
        nameFa: row.name,
        nameEn: row.name_en,
        status: row.status,
        categoryName: row.category_name,
        sku: row.sku,
        variantCount: Number(row.variant_count),
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      }))
    );
  }

  /** Folds the source duplicate into the target product in one transaction. */
  @Post(':targetId/merge')
  @HttpCode(200)
  @Permissions('product.update')
  @Audited('product.merge')
  @ApiOperation({ summary: 'Merge a duplicate product into this one (manual)' })
  async merge(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { targetId } = parseWith(MergeParams, params);
    const { sourceProductId } = parseWith(MergeBody, body);
    if (targetId === sourceProductId) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'محصول مبدأ و مقصد نمی‌توانند یکی باشند.',
        details: [{ field: 'sourceProductId', rule: 'same_product' }],
      });
    }
    return apiData(await this.mergeInTx(ctx, targetId, sourceProductId));
  }

  private async mergeInTx(
    ctx: TenantContext,
    targetPublicId: string,
    sourcePublicId: string
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const products = await tx<MergeProductRow[]>`
        select id::text as id,
               public_id::text as public_id,
               description,
               category_id::text as category_id,
               brand_id::text as brand_id,
               name_en
        from erp.products
        where organization_id = ${ctx.orgId}
          and public_id in (${targetPublicId}, ${sourcePublicId})
          and deleted_at is null
        for update
      `;
      const target = products.find((row) => row.public_id === targetPublicId);
      const source = products.find((row) => row.public_id === sourcePublicId);
      if (target === undefined) throw notFound('product');
      if (source === undefined) throw notFound('product');

      const sourceVariants = await tx<VariantRow[]>`
        select id::text as id, sku
        from erp.product_variants
        where product_id = ${source.id}::bigint
          and deleted_at is null
        order by id
      `;
      const targetVariants = await tx<VariantRow[]>`
        select id::text as id, sku
        from erp.product_variants
        where product_id = ${target.id}::bigint
          and deleted_at is null
      `;
      const targetBySku = new Map(targetVariants.map((variant) => [variant.sku, variant.id]));

      let movedVariants = 0;
      let mergedVariants = 0;
      let movedMappings = 0;
      let removedMappings = 0;

      for (const variant of sourceVariants) {
        const match = targetBySku.get(variant.sku);
        if (match === undefined) {
          await tx`
            update erp.product_variants
            set product_id = ${target.id}::bigint,
                is_default = case
                  when exists (
                    select 1 from erp.product_variants d
                    where d.product_id = ${target.id}::bigint
                      and d.deleted_at is null
                      and d.is_default
                  ) then false
                  else is_default
                end,
                updated_by = ${ctx.actorId}
            where id = ${variant.id}::bigint
          `;
          movedVariants += 1;
          continue;
        }

        const mapped = await tx<{ id: string }[]>`
          update erp.channel_product_mappings m
          set product_variant_id = ${match}::bigint,
              sync_status = 'pending',
              updated_by = ${ctx.actorId}
          where m.product_variant_id = ${variant.id}::bigint
            and m.deleted_at is null
            and not exists (
              select 1 from erp.channel_product_mappings t
              where t.channel_account_id = m.channel_account_id
                and t.product_variant_id = ${match}::bigint
                and t.deleted_at is null
            )
          returning m.id::text as id
        `;
        movedMappings += mapped.length;

        // A mapping that already exists on the target for the same channel
        // account cannot be re-pointed (partial unique index); retire it with
        // the duplicate variant so the channel keeps exactly one active link.
        const retired = await tx<{ id: string }[]>`
          update erp.channel_product_mappings
          set deleted_at = now(), updated_by = ${ctx.actorId}
          where product_variant_id = ${variant.id}::bigint
            and deleted_at is null
          returning id::text as id
        `;
        removedMappings += retired.length;

        await tx`
          update erp.product_variants
          set deleted_at = now(),
              is_active = false,
              updated_by = ${ctx.actorId}
          where id = ${variant.id}::bigint
        `;
        mergedVariants += 1;
      }

      // Fill only missing master data; never overwrite what the target owns.
      await tx`
        update erp.products
        set description = case
              when description is null or btrim(description) = '' then ${source.description}
              else description
            end,
            category_id = coalesce(category_id, ${source.category_id}::bigint),
            brand_id = coalesce(brand_id, ${source.brand_id}::bigint),
            name_en = case
              when name_en is null or btrim(name_en) = '' then ${source.name_en}
              else name_en
            end,
            updated_by = ${ctx.actorId}
        where id = ${target.id}::bigint
      `;

      await tx`
        update erp.products
        set deleted_at = now(),
            status = 'archived',
            updated_by = ${ctx.actorId}
        where id = ${source.id}::bigint
      `;

      // `movedVariants` = variants re-pointed to the target (no SKU match);
      // `mergedVariants` = duplicate-SKU variants folded and soft-deleted.
      return {
        targetId: targetPublicId,
        movedVariants,
        mergedVariants,
        movedMappings,
        removedMappings,
        archivedSourceId: sourcePublicId,
      };
    });
  }
}
