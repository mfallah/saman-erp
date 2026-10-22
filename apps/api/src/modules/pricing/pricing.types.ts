/** Channel pricing policy stored in `erp.channel_accounts.settings.pricing`. */
export const PRICING_SETTINGS_KEY = 'pricing';

export const PRICING_MODES = ['margin', 'cost_plus_fees'] as const;
export type PricingMode = (typeof PRICING_MODES)[number];

export const COST_SOURCES = ['last_purchase', 'avg_cost', 'manual'] as const;
export type CostSource = (typeof COST_SOURCES)[number];

export const ROUNDING_STEPS = ['none', '1000', '500'] as const;
export type RoundingStep = (typeof ROUNDING_STEPS)[number];

export interface PricingPolicy {
  readonly mode: PricingMode;
  readonly costSource: CostSource;
  readonly marginPercent: number;
  readonly commissionPercent: number;
  readonly processingFee: number;
  readonly shippingFee: number;
  /** Optional fixed commission added to the Digikala gross-up numerator. */
  readonly fixedCommission: number;
  readonly vatPercent: number;
  readonly rounding: RoundingStep;
  readonly updatedAt: string | null;
}

/** Write shape: the server stamps `updatedAt` and defaults the optional fixed fee. */
export type PricingPolicyInput = Omit<PricingPolicy, 'fixedCommission' | 'updatedAt'> & {
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
