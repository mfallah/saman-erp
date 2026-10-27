/** Channel pricing policy stored in `erp.channel_accounts.settings.pricing`. */
export const PRICING_SETTINGS_KEY = 'pricing';

/** Legacy calculation mode kept for the `/pricing/rules` endpoints. */
export const PRICING_MODES = ['margin', 'cost_plus_fees'] as const;
export type PricingMode = (typeof PRICING_MODES)[number];

/**
 * Cost lookup. `moving_average` is the policy-facing name; `avg_cost`/`manual`
 * are the legacy values still accepted by the old rule-based endpoint.
 */
export const COST_SOURCES = ['last_purchase', 'moving_average', 'avg_cost', 'manual'] as const;
export type CostSource = (typeof COST_SOURCES)[number];

export const COMMISSION_MODES = ['product', 'fixed', 'percent'] as const;
export type CommissionMode = (typeof COMMISSION_MODES)[number];

export const ROUNDING_STEPS = ['none', '1000', '500'] as const;
export type RoundingStep = (typeof ROUNDING_STEPS)[number];

export const POLICY_COST_SOURCES = ['last_purchase', 'moving_average'] as const;

export interface PricingPolicy {
  /** Legacy mode (margin/cost_plus_fees) kept for the old pricing-rule screen. */
  readonly mode: PricingMode;
  readonly costSource: CostSource;
  readonly marginPercent: number;
  readonly processingFee: number;
  readonly shippingFee: number;
  readonly commissionMode: CommissionMode;
  readonly commissionPercent: number;
  readonly fixedCommission: number;
  readonly vatPercent: number;
  readonly rounding: RoundingStep;
  readonly autoApply: boolean;
  readonly autoPush: boolean;
  readonly updatedAt: string | null;
}

/** Write shape: the server stamps `updatedAt` and defaults optional fields. */
export type PricingPolicyInput = Omit<
  PricingPolicy,
  'mode' | 'commissionMode' | 'autoApply' | 'autoPush' | 'fixedCommission' | 'updatedAt'
> & {
  readonly mode?: PricingMode;
  readonly commissionMode?: CommissionMode;
  readonly autoApply?: boolean;
  readonly autoPush?: boolean;
  readonly fixedCommission?: number;
  readonly updatedAt?: string | null;
};

export interface PriceBreakdown {
  readonly cost: string;
  readonly marginPercent: number;
  readonly marginAmount: string;
  readonly commissionPercent: number;
  readonly commissionAmount: string;
  readonly processingFee: string;
  readonly shippingFee: string;
  readonly fixedCommission: string;
  readonly vatPercent: number;
  readonly vatAmount: string;
  readonly preVatPrice: string;
  readonly preRoundingPrice: string;
  readonly roundingAdjustment: string;
}

export interface PriceCalculation {
  readonly accountId: string;
  readonly variantId: string;
  readonly sku: string | null;
  readonly productName: string | null;
  readonly mode: PricingMode;
  readonly cost: string;
  readonly marginAmount: string;
  readonly commissionPercent: number;
  readonly commissionAmount: string;
  readonly processingFee: string;
  readonly shippingFee: string;
  readonly vatAmount: string;
  readonly finalPrice: string;
  readonly breakdown: PriceBreakdown;
}

export interface ChannelPricingPolicyRow {
  readonly accountId: string;
  readonly accountName: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly channelCode: string;
  readonly isActive: boolean;
  readonly policy: PricingPolicy;
}

/** One row per active channel account (GET /pricing/channels). */
export interface ChannelPricingAccountView {
  readonly accountId: string;
  readonly channelCode: string;
  readonly channelName: string;
  readonly accountName: string;
  readonly policy: PricingPolicy;
  readonly lastAppliedAt: string | null;
  readonly lastPushStatus: string | null;
  readonly mappedVariants: number;
}

export interface PricingApplyResult {
  readonly accountId: string;
  readonly applied: number;
  readonly pushed: number;
  readonly missingCommission?: number;
  readonly pushError?: string;
  readonly skipped?: string;
}
