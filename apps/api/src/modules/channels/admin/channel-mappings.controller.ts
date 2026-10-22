/**
 * Manual cross-channel product merge.
 *
 * Product import creates one local variant per external product. This admin API
 * lets an operator re-point those imported mappings at a canonical ERP variant,
 * and unlink a channel product when it should stop syncing.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppError } from '@saman/shared';

import { DB, type Db, type TenantContext } from '../../../common/contracts';
import { CurrentTenant } from '../../../common/decorators/current-context.decorator';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { apiData } from '../../../common/interceptors/response.interceptor';
import { isUniqueViolation } from '../infrastructure/sql';

type Row = Record<string, unknown>;
type Raw = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_EXTERNAL_ID_LENGTH = 150;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function requiredUuid(value: unknown, field: string): string {
  const parsed = text(value);
  if (!UUID_PATTERN.test(parsed)) {
    throw new AppError('VALIDATION_ERROR', {
      message: `${field} must be a UUID`,
      details: [{ field, rule: 'uuid' }],
    });
  }
  return parsed;
}

function externalId(value: unknown, field: string): string {
  const parsed = text(value);
  if (parsed.length === 0 || parsed.length > MAX_EXTERNAL_ID_LENGTH) {
    throw new AppError('VALIDATION_ERROR', {
      message: `${field} must be between 1 and ${MAX_EXTERNAL_ID_LENGTH} characters`,
      details: [{ field, rule: 'length' }],
    });
  }
  return parsed;
}

function optionalExternalId(value: unknown, field: string): string | null {
  const parsed = text(value);
  if (parsed.length === 0) return null;
  if (parsed.length > MAX_EXTERNAL_ID_LENGTH) {
    throw new AppError('VALIDATION_ERROR', {
      message: `${field} must be at most ${MAX_EXTERNAL_ID_LENGTH} characters`,
      details: [{ field, rule: 'length' }],
    });
  }
  return parsed;
}

function mappingView(row: Row): Record<string, unknown> {
  const variantId = nullableText(row['variant_id']);
  return {
    id: String(row['id']),
    accountId: String(row['account_id']),
    accountName: row['account_name'] ?? null,
    channelCode: row['channel_code'] ?? null,
    channelName: row['channel_name'] ?? null,
    externalProductId: row['external_product_id'] ?? null,
    externalVariantId: row['external_variant_id'] ?? null,
    externalSku: row['external_sku'] ?? null,
    syncStatus: row['sync_status'] ?? 'pending',
    lastSyncedAt: row['last_synced_at'] ?? null,
    isPublished: row['is_published'] === true,
    variantId,
    variantSku: row['variant_sku'] ?? null,
    variantTitle: row['variant_title'] ?? null,
    productId: nullableText(row['product_id']),
    productName: row['product_name'] ?? null,
    isMapped: variantId !== null,
  };
}

@ApiTags('channels')
@ApiBearerAuth()
@Controller()
export class ChannelMappingsAdminController {
  constructor(@Inject(DB) private readonly db: Db) {}

  private get sql(): Raw {
    return this.db as unknown as Raw;
  }

  private async accountInternalId(ctx: TenantContext, publicId: string): Promise<string | null> {
    const rows = await this.sql`
      select id::text as id from erp.channel_accounts
      where public_id = ${publicId}
        and organization_id = ${ctx.orgId}
        and deleted_at is null
      limit 1
    `;
    return rows.length === 0 ? null : String(rows[0]!['id']);
  }

  private async variantInternalId(ctx: TenantContext, publicId: string): Promise<string | null> {
    const rows = await this.sql`
      select v.id::text as id
      from erp.product_variants v
      join erp.products p on p.id = v.product_id
      where v.public_id = ${publicId}
        and v.deleted_at is null
        and p.deleted_at is null
        and p.organization_id = ${ctx.orgId}
      limit 1
    `;
    return rows.length === 0 ? null : String(rows[0]!['id']);
  }

  @Get('channel-mappings')
  @Permissions('channel.mapping.read')
  @ApiOperation({
    summary: 'Imported channel products with their canonical-variant mapping state',
  })
  async list(@CurrentTenant() ctx: TenantContext, @Query() query: Record<string, unknown>) {
    const accountPublicId = text(query['accountId']);
    const variantPublicId = text(query['variantId']);
    const accountId =
      accountPublicId === '' ? null : await this.accountInternalId(ctx, requiredUuid(accountPublicId, 'accountId'));
    if (accountPublicId !== '' && accountId === null) {
      throw new AppError('NOT_FOUND', { message: 'channel account not found' });
    }
    const variantId =
      variantPublicId === '' ? null : await this.variantInternalId(ctx, requiredUuid(variantPublicId, 'variantId'));
    if (variantPublicId !== '' && variantId === null) {
      throw new AppError('NOT_FOUND', { message: 'product variant not found' });
    }

    const searchText = text(query['search']).slice(0, 200);
    const search = searchText === '' ? null : `%${searchText}%`;
    const rawUnmapped = query['unmapped'];
    const unmapped = rawUnmapped === true || rawUnmapped === 'true' || rawUnmapped === '1';

    // In the product-detail merge dialog `unmapped` is scoped to the target
    // canonical variant. Without `variantId`, only broken links (missing or
    // soft-deleted variant) count as unmapped.
    const rows = await this.sql`
      select m.public_id::text as id,
             a.public_id::text as account_id,
             a.name as account_name,
             c.code as channel_code,
             c.name as channel_name,
             m.external_product_id,
             m.external_variant_id,
             m.external_sku,
             m.sync_status,
             m.last_synced_at,
             m.is_published,
             v.public_id::text as variant_id,
             v.sku as variant_sku,
             v.title as variant_title,
             p.public_id::text as product_id,
             p.name as product_name
      from erp.channel_product_mappings m
      join erp.channel_accounts a on a.id = m.channel_account_id
      join erp.sales_channels c on c.id = a.channel_id
      left join erp.product_variants v on v.id = m.product_variant_id and v.deleted_at is null
      left join erp.products p on p.id = v.product_id and p.organization_id = ${ctx.orgId} and p.deleted_at is null
      where a.organization_id = ${ctx.orgId}
        and a.deleted_at is null
        and m.deleted_at is null
        and (${accountId}::bigint is null or m.channel_account_id = ${accountId}::bigint)
        and (
          ${unmapped}::boolean = false
          or v.id is null
          or (${variantId}::bigint is not null and m.product_variant_id <> ${variantId}::bigint)
        )
        and (
          ${search}::text is null
          or m.external_product_id ilike ${search}
          or m.external_variant_id ilike ${search}
          or m.external_sku ilike ${search}
          or a.name ilike ${search}
          or v.sku ilike ${search}
          or v.title ilike ${search}
          or p.name ilike ${search}
        )
      order by m.last_synced_at desc nulls last, m.id desc
      limit 500
    `;
    return apiData(rows.map(mappingView));
  }

  @Get('variants/:variantId/channel-mappings')
  @Permissions('channel.mapping.read')
  @ApiOperation({ summary: 'Every channel mapping linked to a canonical product variant' })
  async ofVariant(@CurrentTenant() ctx: TenantContext, @Param('variantId') publicVariantId: string) {
    const variant = await this.variantInternalId(ctx, requiredUuid(publicVariantId, 'variantId'));
    if (variant === null) {
      throw new AppError('NOT_FOUND', { message: 'product variant not found' });
    }

    const rows = await this.sql`
      select m.public_id::text as id,
             a.public_id::text as account_id,
             a.name as account_name,
             c.code as channel_code,
             c.name as channel_name,
             m.external_product_id,
             m.external_variant_id,
             m.external_sku,
             m.sync_status,
             m.last_synced_at,
             m.is_published,
             v.public_id::text as variant_id,
             v.sku as variant_sku,
             v.title as variant_title,
             p.public_id::text as product_id,
             p.name as product_name
      from erp.channel_product_mappings m
      join erp.channel_accounts a on a.id = m.channel_account_id
      join erp.sales_channels c on c.id = a.channel_id
      join erp.product_variants v on v.id = m.product_variant_id and v.deleted_at is null
      join erp.products p on p.id = v.product_id and p.organization_id = ${ctx.orgId} and p.deleted_at is null
      where m.product_variant_id = ${variant}::bigint
        and m.deleted_at is null
        and a.organization_id = ${ctx.orgId}
        and a.deleted_at is null
      order by c.code, a.name, m.id
    `;
    return apiData(rows.map(mappingView));
  }

  @Post('channel-mappings/link')
  @Permissions('channel.mapping.create')
  @ApiOperation({ summary: 'Link (or re-link) an imported channel product to a canonical variant' })
  async link(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    const payload = (body ?? {}) as Record<string, unknown>;
    const accountPublicId = requiredUuid(payload['accountId'], 'accountId');
    const variantPublicId = requiredUuid(payload['variantId'], 'variantId');
    const externalProductId = externalId(payload['externalProductId'], 'externalProductId');
    const externalVariantId = optionalExternalId(payload['externalVariantId'], 'externalVariantId');

    const accountId = await this.accountInternalId(ctx, accountPublicId);
    if (accountId === null) {
      throw new AppError('NOT_FOUND', { message: 'channel account not found' });
    }
    const variant = await this.variantInternalId(ctx, variantPublicId);
    if (variant === null) {
      throw new AppError('NOT_FOUND', { message: 'product variant not found' });
    }

    const existing = await this.sql`
      select id::text as id
      from erp.channel_product_mappings
      where channel_account_id = ${accountId}::bigint
        and external_product_id = ${externalProductId}
        and deleted_at is null
      order by id desc
      limit 1
    `;

    try {
      if (existing[0] !== undefined) {
        const rows = await this.sql`
          update erp.channel_product_mappings m
          set product_variant_id = ${variant}::bigint,
              external_variant_id = coalesce(${externalVariantId}::text, m.external_variant_id),
              sync_status = 'pending',
              updated_by = ${ctx.actorId}
          where m.id = ${String(existing[0]['id'])}::bigint
            and m.deleted_at is null
          returning m.public_id::text as id
        `;
        if (rows[0] === undefined) {
          throw new AppError('NOT_FOUND', { message: 'channel mapping not found' });
        }
        return apiData({
          id: String(rows[0]['id']),
          accountId: accountPublicId,
          variantId: variantPublicId,
          externalProductId,
          externalVariantId,
        });
      }

      const rows = await this.sql`
        insert into erp.channel_product_mappings (
          channel_account_id, product_variant_id, external_product_id, external_variant_id,
          sync_status, is_published, created_by, updated_by
        ) values (
          ${accountId}::bigint, ${variant}::bigint, ${externalProductId}, ${externalVariantId},
          'pending', false, ${ctx.actorId}, ${ctx.actorId}
        )
        returning public_id::text as id
      `;
      const row = rows[0];
      if (row === undefined) {
        throw new AppError('INTERNAL', { message: 'channel mapping could not be created' });
      }
      return apiData({
        id: String(row['id']),
        accountId: accountPublicId,
        variantId: variantPublicId,
        externalProductId,
        externalVariantId,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError('CONFLICT', {
          message: 'این تنوع قبلاً به محصول دیگری در همین حساب کانال متصل شده است.',
          details: [{ field: 'variantId', rule: 'mapping_conflict' }],
        });
      }
      throw error;
    }
  }

  @Delete('channel-mappings/:mappingId')
  @Permissions('channel.mapping.delete')
  @HttpCode(204)
  @ApiOperation({ summary: 'Unlink an external product from its canonical variant' })
  async unlink(@CurrentTenant() ctx: TenantContext, @Param('mappingId') mappingId: string) {
    const publicId = requiredUuid(mappingId, 'mappingId');
    const rows = await this.sql`
      delete from erp.channel_product_mappings m
      using erp.channel_accounts a
      where m.public_id = ${publicId}
        and a.id = m.channel_account_id
        and a.organization_id = ${ctx.orgId}
      returning m.id
    `;
    if (rows.length === 0) {
      throw new AppError('NOT_FOUND', { message: 'channel mapping not found' });
    }
  }
}
