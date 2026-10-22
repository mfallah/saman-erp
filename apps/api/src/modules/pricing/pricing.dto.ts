import { appErrorFromZod } from '@saman/shared';
import { z, type ZodTypeAny } from 'zod';

import { COST_SOURCES, PRICING_MODES, ROUNDING_STEPS } from './pricing.types';

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
