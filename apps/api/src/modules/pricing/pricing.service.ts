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
  type CommissionMode,
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

function asRecord(value: unknown, depth = 0): Record<string, unknown> {
  if (typeof value === 'string' && depth < 3) {
    try {
      const parsed: unknown = JSON.parse(value);
      // Repair the historical double-encoded shape: settings.pricing was stored
      // as a JSON *string* of the policy object, so unwrap more than one level.
      return asRecord(parsed, depth + 1);
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
  return value === 'moving_average' || value === 'avg_cost' || value === 'manual'
    ? value
    : 'last_purchase';
}

function asCommissionMode(value: unknown, fallback: CommissionMode): CommissionMode {
  return value === 'product' || value === 'fixed' || value === 'percent' ? value : fallback;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
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


  /**
   * Computes the channel price for the given variants (default: every mapped
   * variant of the account), stores it in the account's channel price list and
   * returns the list id so the caller can queue a price push.
   */
  async applyToAccount(input: {
    accountId: string;
    variantIds?: readonly string[];
    basePrice?: string;
  }): Promise<{ priceListId: string; accountInternalId: string; applied: readonly { variantId: string; price: string }[] }> {
    const ctx = this.tenant.get();
    const sql = this.db as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;
    const account = await this.getAccount(input.accountId);
    const orgId = ctx.orgId;
    const priceListId = await this.ensurePriceList(account);

    let variants: readonly string[] = input.variantIds ?? [];
    if (variants.length === 0) {
      variants = await this.mappedVariantIds(account.id);
    }

    const applied: { variantId: string; price: string }[] = [];
    for (const variantId of variants.slice(0, 500)) {
      const calculation = await this.computeForVariant({
        accountId: input.accountId,
        variantId,
        ...(input.basePrice === undefined ? {} : { basePrice: input.basePrice }),
      });
      // Active pricing rule for this variant/category/list overrides the account policy.
      const ruleRows = await sql`
        select r.markup_percent::text, r.fixed_markup_amount::text, r.commission_percent::text,
               r.fixed_fee_amount::text, r.tax_percent::text, r.shipping_fee_amount::text,
               r.rounding_increment::text
        from erp.pricing_rules r
        join erp.product_variants v on v.public_id = ${variantId}
        join erp.products p on p.id = v.product_id
        where r.organization_id = ${orgId} and r.price_list_id = ${priceListId}::bigint
          and r.deleted_at is null and r.is_active = true
          and (r.effective_to is null or r.effective_to > now())
          and (r.product_variant_id is null or r.product_variant_id = v.id)
          and (r.category_id is null or r.category_id = p.category_id)
        order by (r.product_variant_id is not null) desc, (r.category_id is not null) desc, r.rule_priority desc, r.id desc
        limit 1
      `;
      const rule = ruleRows[0];
      let price: string;
      if (rule === undefined) {
        price = String(calculation.finalPrice);
      } else {
        const cost = Number(String(calculation.cost).replace(/[^0-9.-]/g, '')) || 0;
        const markup = Number(rule['markup_percent'] ?? 0);
        const fixedMarkup = Number(rule['fixed_markup_amount'] ?? 0);
        const commission = Number(rule['commission_percent'] ?? 0);
        const fixedFee = Number(rule['fixed_fee_amount'] ?? 0);
        const tax = Number(rule['tax_percent'] ?? 0);
        const shipping = Number(rule['shipping_fee_amount'] ?? 0);
        const rounding = Number(rule['rounding_increment'] ?? 0);
        let value = cost * (1 + markup / 100) + fixedMarkup + fixedFee + shipping;
        if (commission > 0 && commission < 100) value = value / (1 - commission / 100);
        value = value * (1 + tax / 100);
        if (rounding > 0) value = Math.ceil(value / rounding) * rounding;
        price = String(Math.max(0, Math.round(value)));
      }
      await sql`
        insert into erp.price_list_items
          (price_list_id, product_variant_id, price_amount, min_qty, effective_from, is_active, created_by)
        select ${priceListId}::bigint, v.id, ${price}::bigint, 1, now(), true, ${ctx.actorId}
        from erp.product_variants v
        where v.public_id = ${variantId}
      `;
      applied.push({ variantId, price });
    }
    return { priceListId, accountInternalId: account.id, applied };
  }

  /**
   * Applies the single account policy to every mapped variant of the account
   * and upserts the results into that account's price list. This is the path
   * served by `POST /pricing/channels/:accountId/apply`; the legacy
   * `applyToAccount` above keeps the old pricing-rule overrides alive.
   */
  async applyPolicyToAccount(accountId: string): Promise<{
    accountInternalId: string;
    priceListId: string;
    applied: number;
    missingCommission: number;
  }> {
    const ctx = this.tenant.get();
    const account = await this.getAccount(accountId);
    const policy = this.policyFrom(account.settings, account.channel_code);
    const priceListId = await this.ensurePriceList(account);
    const variantIds = await this.mappedVariantIds(account.id);

    const computed: { variantId: string; price: bigint }[] = [];
    let missingCommission = 0;
    for (let offset = 0; offset < variantIds.length; offset += 500) {
      const chunk = variantIds.slice(offset, offset + 500);
      const costs = await this.loadVariantCosts(chunk, ctx.orgId);
      const commissions =
        account.channel_code === 'digikala' && policy.commissionMode === 'product'
          ? await this.loadCommissionRates(account.id, chunk)
          : new Map<string, number>();
      for (const row of costs) {
        const cost = this.costOf(policy, row, null);
        let commissionPercent = policy.commissionPercent;
        if (account.channel_code === 'digikala' && policy.commissionMode === 'product') {
          const perProduct = commissions.get(row.variant_id);
          if (perProduct === undefined) missingCommission += 1;
          else commissionPercent = perProduct;
        }
        const price = this.policyPrice(account.channel_code, policy, cost, commissionPercent);
        computed.push({ variantId: row.variant_id, price });
      }
    }

    await this.writePolicyPrices(
      priceListId,
      computed,
      ctx.actorId === null ? null : ctx.actorId.toString(),
    );
    return {
      accountInternalId: account.id,
      priceListId,
      applied: computed.length,
      missingCommission,
    };
  }

  private async ensurePriceList(account: AccountRow): Promise<string> {
    const ctx = this.tenant.get();
    const sql = this.db as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;
    let listRows = await sql`
      select l.id::text as id
      from erp.price_lists l
      left join erp.channel_accounts a on a.price_list_id = l.id
      where l.organization_id = ${ctx.orgId}
        and l.deleted_at is null
        and l.is_active = true
        and (l.channel_account_id = ${account.id}::bigint or a.id = ${account.id}::bigint)
      order by l.priority desc, l.id
      limit 1
    `;
    if (listRows.length === 0) {
      listRows = await sql`
        insert into erp.price_lists
          (organization_id, code, name, list_type, currency, channel_account_id, rounding_mode, priority, is_active, created_by)
        values
          (${ctx.orgId}, ${`CH-${account.public_id.slice(0, 8)}`}, ${`قیمت ${account.name}`.slice(0, 120)}, 'channel', 'IRR', ${account.id}::bigint, 'none', 100, true, ${ctx.actorId})
        returning id::text as id
      `;
      await sql`
        update erp.channel_accounts set price_list_id = ${String(listRows[0]!['id'])}::bigint where id = ${account.id}::bigint
      `;
    }
    return String(listRows[0]!['id']);
  }

  private async mappedVariantIds(accountInternalId: string): Promise<string[]> {
    const rows = await this.db<{ id: string }[]>`
      select v.public_id::text as id
      from erp.channel_product_mappings m
      join erp.product_variants v on v.id = m.product_variant_id
      join erp.products p on p.id = v.product_id
      where m.channel_account_id = ${accountInternalId}::bigint
        and m.deleted_at is null
        and v.deleted_at is null
        and p.deleted_at is null
      group by v.public_id
    `;
    return rows.map((row) => String(row['id']));
  }

  /**
   * Commission is read per product from `erp.channel_product_costs` (written by
   * the Digikala import). The table may not exist on older databases, and its
   * account column is named `account_id` (migration plan) or
   * `channel_account_id`; both shapes are tolerated.
   */
  private commissionShape: 'account_id' | 'channel_account_id' | 'missing' | undefined;

  private async loadCommissionRates(
    accountInternalId: string,
    variantIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (variantIds.length === 0) return new Map();
    if (this.commissionShape === undefined) {
      const table = await this.db<{ reg: string | null }[]>`
        select to_regclass('erp.channel_product_costs')::text as reg
      `;
      if (table[0]?.reg === null || table[0]?.reg === undefined) {
        this.commissionShape = 'missing';
      } else {
        const columns = await this.db<{ column_name: string }[]>`
          select column_name
          from information_schema.columns
          where table_schema = 'erp'
            and table_name = 'channel_product_costs'
            and column_name in ('account_id', 'channel_account_id')
        `;
        this.commissionShape = columns.some((column) => column.column_name === 'account_id')
          ? 'account_id'
          : 'channel_account_id';
      }
    }
    if (this.commissionShape === 'missing') return new Map();
    const rows =
      this.commissionShape === 'account_id'
        ? await this.db<{ variant_id: string; commission_percent: string }[]>`
            select v.public_id::text as variant_id, c.commission_percent::text
            from erp.channel_product_costs c
            join erp.product_variants v on v.id = c.product_variant_id
            where c.account_id = ${accountInternalId}::bigint
              and v.public_id = any(${variantIds}::uuid[])
          `
        : await this.db<{ variant_id: string; commission_percent: string }[]>`
            select v.public_id::text as variant_id, c.commission_percent::text
            from erp.channel_product_costs c
            join erp.product_variants v on v.id = c.product_variant_id
            where c.channel_account_id = ${accountInternalId}::bigint
              and v.public_id = any(${variantIds}::uuid[])
          `;
    const rates = new Map<string, number>();
    for (const row of rows) {
      const rate = Number(row.commission_percent);
      if (Number.isFinite(rate) && rate >= 0 && rate < 100) rates.set(row.variant_id, rate);
    }
    return rates;
  }

  /** The exact per-channel formula used by the policy apply endpoint. */
  private policyPrice(
    channelCode: string,
    policy: PricingPolicy,
    cost: bigint,
    commissionPercent: number,
  ): bigint {
    const marginFactor = PERCENT_SCALE + percentUnits(policy.marginPercent);
    const processingFee = amount(policy.processingFee);
    const shippingFee = amount(policy.shippingFee);

    if (channelCode !== 'digikala') {
      // Carexy and every other channel: cost * (1 + margin) + processing + shipping.
      return roundHalfUp(cost * marginFactor, PERCENT_SCALE) + processingFee + shippingFee;
    }

    // Digikala: (cost + fees) * (1 + margin) / (1 - commission), then VAT, then rounding.
    const withMargin = roundHalfUp(
      (cost + processingFee + shippingFee) * marginFactor,
      PERCENT_SCALE,
    );
    let preVat: bigint;
    if (policy.commissionMode === 'fixed') {
      // commission = fixedCommission / price  =>  price = gross + fixedCommission
      preVat = withMargin + amount(policy.fixedCommission);
    } else {
      const denominator = PERCENT_SCALE - percentUnits(commissionPercent);
      if (denominator <= 0n) {
        throw new AppError('VALIDATION_ERROR', { message: 'درصد کمیسیون باید کمتر از ۱۰۰ باشد.' });
      }
      preVat = roundHalfUp(withMargin * PERCENT_SCALE, denominator);
    }
    const withVat = roundHalfUp(
      preVat * (PERCENT_SCALE + percentUnits(policy.vatPercent)),
      PERCENT_SCALE,
    );
    return this.roundPrice(withVat, policy.rounding);
  }

  /** Updates the current active item, then inserts one for variants without it. */
  private async writePolicyPrices(
    priceListId: string,
    computed: readonly { variantId: string; price: bigint }[],
    actorId: string | null,
  ): Promise<void> {
    for (let offset = 0; offset < computed.length; offset += 500) {
      const chunk = computed.slice(offset, offset + 500);
      const ids = chunk.map((row) => row.variantId);
      const prices = chunk.map((row) => String(row.price));
      await this.db`
        update erp.price_list_items i
        set price_amount = data.price::bigint,
            is_active = true,
            updated_at = now(),
            updated_by = ${actorId}
        from unnest(${ids}::uuid[], ${prices}::text[]) as data(variant_public_id, price)
        join erp.product_variants v on v.public_id = data.variant_public_id
        where i.price_list_id = ${priceListId}::bigint
          and i.product_variant_id = v.id
          and i.deleted_at is null
          and i.is_active = true
      `;
      await this.db`
        insert into erp.price_list_items
          (price_list_id, product_variant_id, price_amount, min_qty, effective_from, is_active, created_by)
        select ${priceListId}::bigint, v.id, data.price::bigint, 1, now(), true, ${actorId}
        from unnest(${ids}::uuid[], ${prices}::text[]) as data(variant_public_id, price)
        join erp.product_variants v on v.public_id = data.variant_public_id
        where not exists (
          select 1
          from erp.price_list_items existing
          where existing.price_list_id = ${priceListId}::bigint
            and existing.product_variant_id = v.id
            and existing.deleted_at is null
            and existing.is_active = true
        )
      `;
    }
  }

  async getPolicy(accountId: string): Promise<PricingPolicy> {
    const account = await this.getAccount(accountId);
    return this.policyFrom(account.settings, account.channel_code);
  }

  /** Exposes policy normalisation to callers that already loaded account rows. */
  policyFromAccount(settings: unknown, channelCode: string): PricingPolicy {
    return this.policyFrom(settings, channelCode);
  }

  async setPolicy(accountId: string, policy: PricingPolicyInput): Promise<PricingPolicy> {
    const ctx = this.tenant.get();
    const account = await this.getAccount(accountId);
    const before = this.policyFrom(account.settings, account.channel_code);
    const next: PricingPolicy = {
      mode: policy.mode ?? before.mode,
      costSource: policy.costSource ?? before.costSource,
      marginPercent: policy.marginPercent ?? before.marginPercent,
      processingFee: policy.processingFee ?? before.processingFee,
      shippingFee: policy.shippingFee ?? before.shippingFee,
      commissionMode: policy.commissionMode ?? before.commissionMode,
      commissionPercent: policy.commissionPercent ?? before.commissionPercent,
      fixedCommission: policy.fixedCommission ?? before.fixedCommission,
      vatPercent: policy.vatPercent ?? before.vatPercent,
      rounding: policy.rounding ?? before.rounding,
      autoApply: policy.autoApply ?? before.autoApply,
      autoPush: policy.autoPush ?? before.autoPush,
      updatedAt: new Date().toISOString(),
    };
    const actorId = ctx.actorId === null ? null : ctx.actorId.toString();
    // Plain JSON value: postgres.js serialises it as one jsonb object. Never
    // stringify first: that stored a jsonb *string* and double-encoded the value.
    const payload: Record<string, string | number | boolean | null> = {
      mode: next.mode,
      costSource: next.costSource,
      marginPercent: next.marginPercent,
      processingFee: next.processingFee,
      shippingFee: next.shippingFee,
      commissionMode: next.commissionMode,
      commissionPercent: next.commissionPercent,
      fixedCommission: next.fixedCommission,
      vatPercent: next.vatPercent,
      rounding: next.rounding,
      autoApply: next.autoApply,
      autoPush: next.autoPush,
      updatedAt: next.updatedAt,
    };
    const rows = await this.db<{ id: string; settings: unknown }[]>`
      update erp.channel_accounts
      set settings = jsonb_set(
            case
              when jsonb_typeof(coalesce(settings, '{}'::jsonb)) = 'object'
                then coalesce(settings, '{}'::jsonb)
              -- settings itself was stored as a JSON string: unwrap it so other keys survive.
              when jsonb_typeof(coalesce(settings, '{}'::jsonb)) = 'string'
                then (settings #>> '{}')::jsonb
              else '{}'::jsonb
            end,
            '{pricing}',
            ${this.db.json(payload)}::jsonb,
            true
          ),
          updated_at = now(),
          updated_by = ${actorId}
      where organization_id = ${ctx.orgId.toString()}
        and (public_id::text = ${accountId} or id::text = ${accountId})
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
        and (a.public_id::text = ${accountId} or a.id::text = ${accountId})
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
      commissionMode: asCommissionMode(
        raw['commissionMode'],
        channelCode === 'digikala' ? 'product' : 'percent',
      ),
      commissionPercent: numberValue(raw['commissionPercent'], 0),
      processingFee: numberValue(raw['processingFee'], 0),
      shippingFee: numberValue(raw['shippingFee'], 0),
      fixedCommission: numberValue(raw['fixedCommission'], 0),
      vatPercent: numberValue(raw['vatPercent'], 0),
      rounding: asRounding(raw['rounding']),
      autoApply: asBoolean(raw['autoApply']),
      // Pushing is the point of the policy; a policy that never pushed unless
      // the owner flipped a hidden switch confused the old screens.
      autoPush: raw['autoPush'] === undefined ? true : asBoolean(raw['autoPush']),
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
    if (policy.costSource === 'moving_average' || policy.costSource === 'avg_cost') {
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
      optionalMoney(row.inventory_avg_cost) ??
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
