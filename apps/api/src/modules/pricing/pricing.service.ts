import { Inject, Injectable, Optional } from '@nestjs/common';
import { AppError, formatMoney, parseMoney, roundHalfUp } from '@saman/shared';

import {
  AUDIT,
  DB,
  TENANT,
  type AuditPort,
  type Db,
  type TenantAccessor,
} from '../../common/contracts';
import {
  PRICING_SETTINGS_KEY,
  type ChannelPricingPolicyRow,
  type CostSource,
  type PriceCalculation,
  type PricingMode,
  type PricingPolicy,
  type PricingPolicyInput,
  type RoundingStep,
} from './pricing.types';

interface AccountRow {
  readonly id: string;
  readonly public_id: string;
  readonly name: string;
  readonly settings: unknown;
  readonly channel_id: string;
  readonly channel_name: string;
  readonly channel_code: string;
  readonly is_active: boolean;
}

interface VariantCostRow {
  readonly variant_id: string;
  readonly sku: string | null;
  readonly product_name: string | null;
  /** Optional variant-level cost fields; absent from the current schema, read defensively. */
  readonly variant_cost_price: string | null;
  readonly variant_last_purchase_price: string | null;
  readonly variant_avg_cost: string | null;
  readonly latest_cost: string | null;
  readonly last_purchase_cost: string | null;
  readonly avg_cost: string | null;
  readonly inventory_avg_cost: string | null;
  readonly standard_cost: string | null;
  readonly supplier_price: string | null;
}

const PERCENT_SCALE = 1_000_000n;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asMode(value: unknown, fallback: PricingMode): PricingMode {
  return value === 'margin' || value === 'cost_plus_fees' ? value : fallback;
}

function asCostSource(value: unknown): CostSource {
  return value === 'avg_cost' || value === 'manual' ? value : 'last_purchase';
}

function asRounding(value: unknown): RoundingStep {
  return value === '1000' || value === '500' ? value : 'none';
}

/** Converts a human percentage (9.5 = 9.5%) into millionths. */
function percentUnits(percent: number): bigint {
  return BigInt(Math.round(percent * 10_000));
}

function percentageOf(amount: bigint, percent: number): bigint {
  return roundHalfUp(amount * percentUnits(percent), PERCENT_SCALE);
}

function amount(value: number): bigint {
  return BigInt(Math.round(value));
}

function optionalMoney(value: string | null): bigint | null {
  if (value === null || value.trim() === '') return null;
  try {
    return parseMoney(value);
  } catch {
    return null;
  }
}

@Injectable()
export class PricingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TENANT) private readonly tenant: TenantAccessor,
    @Optional() @Inject(AUDIT) private readonly audit?: AuditPort,
  ) {}

  async getPolicy(accountId: string): Promise<PricingPolicy> {
    const account = await this.getAccount(accountId);
    return this.policyFrom(account.settings, account.channel_code);
  }

  async setPolicy(accountId: string, policy: PricingPolicyInput): Promise<PricingPolicy> {
    const ctx = this.tenant.get();
    const account = await this.getAccount(accountId);
    const before = this.policyFrom(account.settings, account.channel_code);
    const next: PricingPolicy = {
      ...policy,
      fixedCommission: policy.fixedCommission ?? 0,
      updatedAt: new Date().toISOString(),
    };
    const actorId = ctx.actorId === null ? null : ctx.actorId.toString();
    const rows = await this.db<{ id: string; settings: unknown }[]>`
      update erp.channel_accounts
      set settings = jsonb_set(
            coalesce(settings, '{}'::jsonb),
            '{pricing}',
            ${JSON.stringify(next)}::jsonb,
            true
          ),
          updated_at = now(),
          updated_by = ${actorId}
      where organization_id = ${ctx.orgId.toString()}
        and public_id::text = ${accountId}
        and deleted_at is null
      returning id::text as id, settings
    `;
    const updated = rows[0];
    if (updated === undefined) throw new AppError('NOT_FOUND', { message: 'حساب کانال یافت نشد.' });

    await this.audit?.record(this.db, {
      action: 'channel.pricing_policy.update',
      entityType: 'channel_account',
      entityId: updated.id,
      orgId: ctx.orgId,
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      ...(ctx.ip === undefined ? {} : { ip: ctx.ip }),
      ...(ctx.userAgent === undefined ? {} : { userAgent: ctx.userAgent }),
      before: { policy: before },
      after: { policy: next },
    });
    return this.policyFrom(updated.settings, account.channel_code);
  }

  async listPolicies(): Promise<readonly ChannelPricingPolicyRow[]> {
    return this.queryPolicies(null);
  }

  async listChannelPolicies(channelId: string): Promise<readonly ChannelPricingPolicyRow[]> {
    return this.queryPolicies(channelId);
  }

  private async queryPolicies(channelId: string | null): Promise<readonly ChannelPricingPolicyRow[]> {
    const orgId = this.tenant.get().orgId.toString();
    const rows = await this.db<AccountRow[]>`
      select a.id::text as id, a.public_id::text as public_id, a.name, a.settings,
             a.channel_id::text as channel_id, c.name as channel_name,
             c.code as channel_code, a.is_active
      from erp.channel_accounts a
      join erp.sales_channels c on c.id = a.channel_id
      where a.organization_id = ${orgId}
        and c.organization_id = ${orgId}
        and (${channelId}::text is null or c.public_id::text = ${channelId})
        and a.deleted_at is null
      order by c.id, a.id
    `;
    return rows.map((row) => ({
      accountId: row.public_id,
      accountName: row.name,
      channelId: row.channel_id,
      channelName: row.channel_name,
      channelCode: row.channel_code,
      isActive: row.is_active === true,
      policy: this.policyFrom(row.settings, row.channel_code),
    }));
  }

  async computeForVariant(input: {
    accountId: string;
    variantId: string;
    basePrice?: string | number;
  }): Promise<PriceCalculation> {
    const account = await this.getAccount(input.accountId);
    const policy = this.policyFrom(account.settings, account.channel_code);
    const rows = await this.loadVariantCosts([input.variantId], this.tenant.get().orgId);
    const row = rows[0];
    if (row === undefined) throw new AppError('NOT_FOUND', { message: 'تنوع کالا یافت نشد.' });
    return this.calculate(account, policy, row, this.baseCost(input.basePrice));
  }

  async computeBatch(
    accountId: string,
    variantIds: readonly string[],
  ): Promise<readonly PriceCalculation[]> {
    const uniqueIds = [...new Set(variantIds)];
    if (uniqueIds.length === 0) return [];
    if (uniqueIds.length > 500) {
      throw new AppError('VALIDATION_ERROR', { message: 'حداکثر ۵۰۰ تنوع در هر درخواست مجاز است.' });
    }
    const account = await this.getAccount(accountId);
    const policy = this.policyFrom(account.settings, account.channel_code);
    const rows = await this.loadVariantCosts(uniqueIds, this.tenant.get().orgId);
    const byVariant = new Map(rows.map((row) => [row.variant_id, row]));
    const results: PriceCalculation[] = [];
    for (const variantId of uniqueIds) {
      const row = byVariant.get(variantId);
      if (row === undefined) {
        throw new AppError('NOT_FOUND', { message: 'یکی از تنوع‌های کالا یافت نشد.' });
      }
      results.push(this.calculate(account, policy, row, null));
    }
    return results;
  }

  private async getAccount(accountId: string): Promise<AccountRow> {
    const orgId = this.tenant.get().orgId.toString();
    const rows = await this.db<AccountRow[]>`
      select a.id::text as id, a.public_id::text as public_id, a.name, a.settings,
             a.channel_id::text as channel_id, c.name as channel_name,
             c.code as channel_code, a.is_active
      from erp.channel_accounts a
      join erp.sales_channels c on c.id = a.channel_id
      where a.organization_id = ${orgId}
        and c.organization_id = ${orgId}
        and a.public_id::text = ${accountId}
        and a.deleted_at is null
      limit 1
    `;
    const row = rows[0];
    if (row === undefined) throw new AppError('NOT_FOUND', { message: 'حساب کانال یافت نشد.' });
    return row;
  }

  private async loadVariantCosts(
    variantIds: readonly string[],
    orgId: bigint,
  ): Promise<readonly VariantCostRow[]> {
    const organizationId = orgId.toString();
    return this.db<VariantCostRow[]>`
      select v.public_id::text as variant_id, v.sku, p.name as product_name,
        (to_jsonb(v) ->> 'cost_price') as variant_cost_price,
        (to_jsonb(v) ->> 'last_purchase_price') as variant_last_purchase_price,
        (to_jsonb(v) ->> 'avg_cost') as variant_avg_cost,
        (
          select h.cost_amount::text
          from erp.product_cost_history h
          where h.product_variant_id = v.id and h.deleted_at is null
          order by h.effective_from desc
          limit 1
        ) as latest_cost,
        (
          select h.cost_amount::text
          from erp.product_cost_history h
          where h.product_variant_id = v.id and h.deleted_at is null
          order by (h.source_type in ('purchase', 'receipt', 'goods_receipt')) desc,
                   h.effective_from desc
          limit 1
        ) as last_purchase_cost,
        (
          select h.avg_cost_amount::text
          from erp.product_cost_history h
          where h.product_variant_id = v.id and h.deleted_at is null and h.avg_cost_amount > 0
          order by h.effective_from desc
          limit 1
        ) as avg_cost,
        (
          select round(sum(i.total_value_amount)::numeric / nullif(sum(i.qty_on_hand), 0), 0)::text
          from erp.inventory_average_costs i
          where i.product_variant_id = v.id
            and i.organization_id = ${organizationId}
            and i.qty_on_hand > 0
        ) as inventory_avg_cost,
        (
          select h.cost_amount::text
          from erp.product_cost_history h
          where h.product_variant_id = v.id and h.deleted_at is null
            and h.cost_method in ('standard', 'manual')
          order by h.effective_from desc
          limit 1
        ) as standard_cost,
        (
          select ps.purchase_price_amount::text
          from erp.product_suppliers ps
          where ps.product_variant_id = v.id and ps.deleted_at is null
            and ps.purchase_price_amount > 0
          order by coalesce(ps.last_purchase_at, ps.updated_at) desc
          limit 1
        ) as supplier_price
      from erp.product_variants v
      join erp.products p on p.id = v.product_id
      where p.organization_id = ${organizationId}
        and p.deleted_at is null
        and v.deleted_at is null
        and v.public_id = any(${variantIds}::uuid[])
    `;
  }

  private policyFrom(settings: unknown, channelCode: string): PricingPolicy {
    const raw = asRecord(asRecord(settings)[PRICING_SETTINGS_KEY]);
    const defaultMode: PricingMode = channelCode === 'digikala' ? 'cost_plus_fees' : 'margin';
    return {
      mode: asMode(raw['mode'], defaultMode),
      costSource: asCostSource(raw['costSource']),
      marginPercent: numberValue(raw['marginPercent'], 0),
      commissionPercent: numberValue(raw['commissionPercent'], 0),
      processingFee: numberValue(raw['processingFee'], 0),
      shippingFee: numberValue(raw['shippingFee'], 0),
      fixedCommission: numberValue(raw['fixedCommission'], 0),
      vatPercent: numberValue(raw['vatPercent'], 0),
      rounding: asRounding(raw['rounding']),
      updatedAt: stringOrNull(raw['updatedAt']),
    };
  }

  private baseCost(basePrice: string | number | undefined): bigint | null {
    if (basePrice === undefined) return null;
    const cost =
      typeof basePrice === 'number' ? BigInt(Math.round(basePrice)) : parseMoney(basePrice.trim());
    if (cost < 0n) {
      throw new AppError('VALIDATION_ERROR', { message: 'بهای پایه نمی‌تواند منفی باشد.' });
    }
    return cost;
  }

  private costOf(policy: PricingPolicy, row: VariantCostRow, baseCost: bigint | null): bigint {
    if (baseCost !== null) return baseCost;
    if (policy.costSource === 'manual') {
      return (
        optionalMoney(row.variant_cost_price) ??
        optionalMoney(row.standard_cost) ??
        optionalMoney(row.latest_cost) ??
        0n
      );
    }
    if (policy.costSource === 'avg_cost') {
      const variantAverage = optionalMoney(row.variant_avg_cost);
      if (variantAverage !== null && variantAverage > 0n) return variantAverage;
      const historical = optionalMoney(row.avg_cost);
      if (historical !== null && historical > 0n) return historical;
      const inventory = optionalMoney(row.inventory_avg_cost);
      if (inventory !== null && inventory > 0n) return inventory;
      return optionalMoney(row.latest_cost) ?? 0n;
    }
    return (
      optionalMoney(row.variant_last_purchase_price) ??
      optionalMoney(row.last_purchase_cost) ??
      optionalMoney(row.supplier_price) ??
      optionalMoney(row.latest_cost) ??
      0n
    );
  }

  private calculate(
    account: AccountRow,
    policy: PricingPolicy,
    row: VariantCostRow,
    baseCost: bigint | null,
  ): PriceCalculation {
    const cost = this.costOf(policy, row, baseCost);
    const marginAmount = percentageOf(cost, policy.marginPercent);
    const processingFee = amount(policy.processingFee);
    const shippingFee = amount(policy.shippingFee);
    const fixedCommission = amount(policy.fixedCommission);

    let preVatPrice: bigint;
    if (policy.mode === 'margin') {
      preVatPrice = cost + marginAmount;
    } else {
      const denominator = PERCENT_SCALE - percentUnits(policy.commissionPercent);
      if (denominator <= 0n) {
        throw new AppError('VALIDATION_ERROR', { message: 'درصد کمیسیون باید کمتر از ۱۰۰ باشد.' });
      }
      const numerator =
        cost + processingFee + shippingFee + marginAmount + fixedCommission;
      preVatPrice = roundHalfUp(numerator * PERCENT_SCALE, denominator);
    }

    const commissionAmount =
      policy.mode === 'cost_plus_fees' ? percentageOf(preVatPrice, policy.commissionPercent) : 0n;
    const vatAmount = percentageOf(preVatPrice, policy.vatPercent);
    const preRoundingPrice = preVatPrice + vatAmount;
    const finalPrice = this.roundPrice(preRoundingPrice, policy.rounding);
    const roundingAdjustment = finalPrice - preRoundingPrice;

    return {
      accountId: account.public_id,
      variantId: row.variant_id,
      sku: row.sku,
      productName: row.product_name,
      mode: policy.mode,
      cost: formatMoney(cost),
      marginAmount: formatMoney(marginAmount),
      commissionPercent: policy.commissionPercent,
      commissionAmount: formatMoney(commissionAmount),
      processingFee: formatMoney(processingFee),
      shippingFee: formatMoney(shippingFee),
      vatAmount: formatMoney(vatAmount),
      finalPrice: formatMoney(finalPrice),
      breakdown: {
        cost: formatMoney(cost),
        marginPercent: policy.marginPercent,
        marginAmount: formatMoney(marginAmount),
        commissionPercent: policy.commissionPercent,
        commissionAmount: formatMoney(commissionAmount),
        processingFee: formatMoney(processingFee),
        shippingFee: formatMoney(shippingFee),
        fixedCommission: formatMoney(fixedCommission),
        vatPercent: policy.vatPercent,
        vatAmount: formatMoney(vatAmount),
        preVatPrice: formatMoney(preVatPrice),
        preRoundingPrice: formatMoney(preRoundingPrice),
        roundingAdjustment: formatMoney(roundingAdjustment),
      },
    };
  }

  private roundPrice(value: bigint, rounding: RoundingStep): bigint {
    if (rounding === 'none') return value;
    const step = rounding === '1000' ? 1000n : 500n;
    return roundHalfUp(value, step) * step;
  }
}
