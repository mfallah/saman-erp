import { appErrorFromZod } from '@saman/shared';
import { z, type ZodTypeAny } from 'zod';

import { COMMISSION_MODES, COST_SOURCES, POLICY_COST_SOURCES, PRICING_MODES, ROUNDING_STEPS } from './pricing.types';

const MoneyNumber = z.coerce.number().int().min(0).max(1_000_000_000_000);
const PercentNumber = z.coerce.number().min(0).max(1000);

export const PricingPolicyBody = z.object({
  mode: z.enum(PRICING_MODES).default('margin'),
  costSource: z.enum(COST_SOURCES).default('last_purchase'),
  marginPercent: PercentNumber.default(0),
  commissionPercent: z.coerce.number().min(0).lt(100).default(0),
  processingFee: MoneyNumber.default(0),
  shippingFee: MoneyNumber.default(0),
  fixedCommission: MoneyNumber.optional().default(0),
  vatPercent: z.coerce.number().min(0).max(100).default(0),
  rounding: z.enum(ROUNDING_STEPS).default('none'),
});
export type PricingPolicyBody = z.infer<typeof PricingPolicyBody>;

/**
 * Channel-account policy written to `channel_accounts.settings.pricing`.
 * This is the single source of truth for the new `/pricing/channels` API.
 */
export const ChannelPolicyBody = z.object({
  costSource: z.enum(POLICY_COST_SOURCES).default('last_purchase'),
  marginPercent: z.coerce.number().min(0).max(1000).default(0),
  processingFee: MoneyNumber.default(0),
  shippingFee: MoneyNumber.default(0),
  commissionMode: z.enum(COMMISSION_MODES).default('percent'),
  commissionPercent: z.coerce.number().min(0).lt(100).default(0),
  fixedCommission: MoneyNumber.optional().default(0),
  vatPercent: z.coerce.number().min(0).max(100).default(0),
  rounding: z.enum(ROUNDING_STEPS).default('none'),
  autoApply: z.coerce.boolean().default(false),
  autoPush: z.coerce.boolean().default(true),
});
export type ChannelPolicyBody = z.infer<typeof ChannelPolicyBody>;

export const PublicId = z.string().uuid({ message: 'invalid_uuid' });

export const ChannelPricingParam = z.object({ channelId: PublicId });
export const AccountPricingParam = z.object({ accountId: PublicId });

export const PreviewQuery = z.object({
  variantId: PublicId,
  accountId: PublicId,
});

export const PreviewBatchBody = z.object({
  accountId: PublicId,
  variantIds: z.array(PublicId).min(1).max(500),
});
export type PreviewBatchBody = z.infer<typeof PreviewBatchBody>;

export function parseWith<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw appErrorFromZod(result.error);
  return result.data as z.infer<S>;
}
