/**
 * Pricing rules CRUD (`erp.pricing_rules`): markup/commission/fee rules per
 * price list, optionally scoped to a category, variant or brand.
 *
 * The rules are the pricing policy layer the owner edits; the channel applies
 * them through `POST /channel-accounts/:id/pricing/apply`.
 */
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { TENANT, type Db, type TenantAccessor, type TenantContext } from '../../common/contracts';
import { DB } from '../../common/contracts';
import { CurrentTenant } from '../../common/decorators/current-context.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { apiData } from '../../common/interceptors/response.interceptor';
import { parseWith } from './pricing.dto';

type Raw = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

const RuleBody = z.object({
  code: z.string().trim().min(2).max(60),
  name: z.string().trim().min(2).max(150),
  priceListId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  variantId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  priority: z.coerce.number().int().min(0).max(10000).default(0),
  markupPercent: z.coerce.number().min(-100).max(1000).default(0),
  fixedMarkupAmount: z.coerce.number().int().min(0).default(0),
  commissionPercent: z.coerce.number().min(0).lt(100).default(0),
  fixedFeeAmount: z.coerce.number().int().min(0).default(0),
  taxPercent: z.coerce.number().min(0).max(100).default(0),
  shippingFeeAmount: z.coerce.number().int().min(0).default(0),
  minimumMarginPercent: z.coerce.number().min(0).max(1000).default(0),
  roundingIncrement: z.coerce.number().int().min(0).max(1_000_000).default(1000),
  isActive: z.boolean().default(true),
});

function ruleView(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row['id']),
    code: row['code'],
    name: row['name'],
    priceListId: row['price_list_id'],
    priceListName: row['price_list_name'],
    categoryId: row['category_id'],
    variantId: row['variant_id'],
    brandId: row['brand_id'],
    priority: Number(row['rule_priority'] ?? 0),
    markupPercent: row['markup_percent'],
    fixedMarkupAmount: row['fixed_markup_amount'],
    commissionPercent: row['commission_percent'],
    fixedFeeAmount: row['fixed_fee_amount'],
    taxPercent: row['tax_percent'],
    shippingFeeAmount: row['shipping_fee_amount'],
    minimumMarginPercent: row['minimum_margin_percent'],
    roundingIncrement: row['rounding_increment'],
    isActive: row['is_active'],
    createdAt: row['created_at'],
  };
}

@ApiTags('pricing')
@ApiBearerAuth()
@Controller()
export class PricingRulesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TENANT) private readonly tenant: TenantAccessor,
    private readonly moduleRef: ModuleRef,
  ) {}

  private get sql(): Raw {
    return this.db as unknown as Raw;
  }


  /** Best-effort recompute + push for every account that uses this price list. */
  private async applyToAccounts(ctx: TenantContext, priceListId: string): Promise<void> {
    try {
      const accounts = await this.sql`
        select a.public_id::text as id, a.id::text as internal_id
        from erp.channel_accounts a
        join erp.price_lists l on l.id = ${priceListId}::bigint
        where a.organization_id = ${ctx.orgId} and a.deleted_at is null and a.is_active = true
          and (a.price_list_id = l.id or a.id = l.channel_account_id)
      `;
      const { PricingService } = await import('./pricing.service');
      const { ChannelSyncService } = await import('../channels/services/channel-sync.service');
      const pricing = this.moduleRef.get(PricingService, { strict: false });
      const sync = this.moduleRef.get(ChannelSyncService, { strict: false });
      for (const account of accounts) {
        await pricing.applyToAccount({ accountId: String(account['id']) });
        const job = await sync.trigger({
          organizationId: ctx.orgId.toString(),
          accountId: String(account['internal_id']),
          type: 'price_push',
          force: true,
        });
        setImmediate(() => {
          void sync.runJob(job.jobId).catch(() => undefined);
        });
      }
    } catch {
      // Recompute is best-effort; a failure must not reject the rule save.
    }
  }

  private async baseListId(ctx: TenantContext, publicId?: string): Promise<string> {
    if (publicId !== undefined) {
      const rows = await this.sql`
        select id::text as id from erp.price_lists
        where public_id = ${publicId} and organization_id = ${ctx.orgId} and deleted_at is null limit 1
      `;
      if (rows.length > 0) return String(rows[0]!['id']);
    }
    const base = await this.sql`
      select id::text as id from erp.price_lists
      where organization_id = ${ctx.orgId} and deleted_at is null and is_active = true
      order by priority, id limit 1
    `;
    if (base.length === 0) {
      const created = await this.sql`
        insert into erp.price_lists (organization_id, code, name, list_type, currency, rounding_mode, priority, is_active)
        values (${ctx.orgId}, 'BASE', 'لیست قیمت پایه', 'retail', 'IRR', 'none', 0, true)
        returning id::text as id
      `;
      return String(created[0]!['id']);
    }
    return String(base[0]!['id']);
  }

  @Get('pricing/lists')
  @Permissions('pricing.rule.read')
  @ApiOperation({ summary: 'Price lists available for rules' })
  async lists(@CurrentTenant() ctx: TenantContext) {
    const rows = await this.sql`
      select l.public_id::text as id, l.code, l.name, l.list_type, l.currency, l.is_active,
             a.name as channel_name
      from erp.price_lists l
      left join erp.channel_accounts a on a.id = l.channel_account_id
      where l.organization_id = ${ctx.orgId} and l.deleted_at is null
      order by l.priority, l.id
    `;
    return apiData(rows.map((row) => ({
      id: String(row['id']),
      code: row['code'],
      name: row['name'],
      listType: row['list_type'],
      currency: row['currency'],
      isActive: row['is_active'],
      channelName: row['channel_name'],
    })));
  }

  @Get('pricing/rules')
  @Permissions('pricing.rule.read')
  @ApiOperation({ summary: 'List pricing rules' })
  async list(@CurrentTenant() ctx: TenantContext) {
    const rows = await this.sql`
      select r.public_id::text as id, r.code, r.name, r.rule_priority,
             l.public_id::text as price_list_id, l.name as price_list_name,
             c.public_id::text as category_id, v.public_id::text as variant_id, b.public_id::text as brand_id,
             r.markup_percent::text, r.fixed_markup_amount::text, r.commission_percent::text,
             r.fixed_fee_amount::text, r.tax_percent::text, r.shipping_fee_amount::text,
             r.minimum_margin_percent::text, r.rounding_increment::text, r.is_active, r.created_at::text
      from erp.pricing_rules r
      join erp.price_lists l on l.id = r.price_list_id
      left join erp.product_categories c on c.id = r.category_id
      left join erp.product_variants v on v.id = r.product_variant_id
      left join erp.brands b on b.id = r.brand_id
      where r.organization_id = ${ctx.orgId} and r.deleted_at is null
      order by r.rule_priority desc, r.id desc
    `;
    return apiData(rows.map(ruleView));
  }

  @Post('pricing/rules')
  @Permissions('pricing.rule.create')
  @ApiOperation({ summary: 'Create a pricing rule' })
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    const input = parseWith(RuleBody, body);
    const listId = await this.baseListId(ctx, input.priceListId);
    const rows = await this.sql`
      insert into erp.pricing_rules
        (organization_id, price_list_id, code, name, category_id, product_variant_id, brand_id,
         rule_priority, markup_percent, fixed_markup_amount, commission_percent, fixed_fee_amount,
         tax_percent, shipping_fee_amount, minimum_margin_percent, rounding_increment, is_active, created_by)
      values
        (${ctx.orgId}, ${listId}::bigint, ${input.code}, ${input.name},
         (select id from erp.product_categories where public_id = ${input.categoryId ?? null} limit 1),
         (select id from erp.product_variants where public_id = ${input.variantId ?? null} limit 1),
         (select id from erp.brands where public_id = ${input.brandId ?? null} limit 1),
         ${input.priority}, ${input.markupPercent}, ${input.fixedMarkupAmount}, ${input.commissionPercent},
         ${input.fixedFeeAmount}, ${input.taxPercent}, ${input.shippingFeeAmount},
         ${input.minimumMarginPercent}, ${input.roundingIncrement}, ${input.isActive}, ${ctx.actorId})
      returning public_id::text as id
    `;
    const createdRuleId = String(rows[0]!['id']);
    setImmediate(() => void this.applyToAccounts(ctx, listId));
    return apiData({ id: createdRuleId });
  }

  @Put('pricing/rules/:id')
  @Permissions('pricing.rule.update')
  @ApiOperation({ summary: 'Update a pricing rule' })
  async update(@CurrentTenant() ctx: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    const input = parseWith(RuleBody, body);
    const listId = await this.baseListId(ctx, input.priceListId);
    const rows = await this.sql`
      update erp.pricing_rules r
      set code = ${input.code}, name = ${input.name}, price_list_id = ${listId}::bigint,
          category_id = (select id from erp.product_categories where public_id = ${input.categoryId ?? null} limit 1),
          product_variant_id = (select id from erp.product_variants where public_id = ${input.variantId ?? null} limit 1),
          brand_id = (select id from erp.brands where public_id = ${input.brandId ?? null} limit 1),
          rule_priority = ${input.priority}, markup_percent = ${input.markupPercent},
          fixed_markup_amount = ${input.fixedMarkupAmount}, commission_percent = ${input.commissionPercent},
          fixed_fee_amount = ${input.fixedFeeAmount}, tax_percent = ${input.taxPercent},
          shipping_fee_amount = ${input.shippingFeeAmount}, minimum_margin_percent = ${input.minimumMarginPercent},
          rounding_increment = ${input.roundingIncrement}, is_active = ${input.isActive},
          updated_at = now(), updated_by = ${ctx.actorId}
      where r.public_id = ${id} and r.organization_id = ${ctx.orgId} and r.deleted_at is null
      returning r.public_id::text as id
    `;
    if (rows.length === 0) {
      throw new BadRequestException({ code: 'NOT_FOUND', message: 'rule not found' });
    }
    setImmediate(() => void this.applyToAccounts(ctx, listId));
    return apiData({ id: String(rows[0]!['id']) });
  }

  @Delete('pricing/rules/:id')
  @HttpCode(200)
  @Permissions('pricing.rule.delete')
  @ApiOperation({ summary: 'Soft-delete a pricing rule' })
  async remove(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    await this.sql`
      update erp.pricing_rules set deleted_at = now(), updated_at = now(), updated_by = ${ctx.actorId}
      where public_id = ${id} and organization_id = ${ctx.orgId} and deleted_at is null
    `;
    const listRow = await this.sql`select price_list_id::text as id from erp.pricing_rules where public_id = ${id} limit 1`;
    if (listRow[0] !== undefined) setImmediate(() => void this.applyToAccounts(ctx, String(listRow[0]!['id'])));
    return apiData({ id, deleted: true });
  }
}
