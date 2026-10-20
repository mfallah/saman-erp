/** Partners DTOs (Zod) — money as integer strings, percentages as fractions. */
import { z } from 'zod';
import { appErrorFromZod, parseMoney } from '@saman/shared';
import type { ZodType } from 'zod';

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'iso_date' });
export const Money = z.string().regex(/^-?\d+$/, { message: 'money_integer_string' });
export const Id = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]);
export const Fraction = z.string().regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/, { message: 'fraction_0_1' });

export const CreatePartnerSchema = z.object({
  nameFa: z.string().min(1).max(250),
  code: z.string().min(1).max(50).optional(),
  type: z.enum(['shareholder', 'investor', 'channel', 'supplier', 'customer', 'other']),
  legalName: z.string().max(250).optional(),
  nationalId: z.string().max(20).optional(),
  economicCode: z.string().max(20).optional(),
  mobile: z.string().max(20).optional(),
  profitSharePercent: Fraction.optional(),
  glAccountId: Id.optional(),
});

export const PartnerTransactionSchema = z.object({
  type: z.enum([
    'capital_increase',
    'capital_decrease',
    'drawing',
    'loan',
    'repayment',
    'profit_share',
    'loss_share',
    'dividend_declared',
    'dividend_paid',
  ]),
  amount: Money,
  date: IsoDate,
  descriptionFa: z.string().max(1000).optional(),
  paymentId: Id.optional(),
});

export const CreateShareholderSchema = z.object({
  nameFa: z.string().min(1).max(250),
  code: z.string().min(1).max(40).optional(),
  shareholderType: z.enum(['person', 'company', 'fund']).optional(),
  partnerId: Id.optional(),
  sharePercent: Fraction,
  nationalId: z.string().max(20).optional(),
});

export const AdjustShareSchema = z.object({
  sharePercent: Fraction,
  effectiveDate: IsoDate,
  reason: z.string().min(3).max(300),
  stepUpToken: z.string().optional(),
});

export const CreatePartnerAccountSchema = z.object({
  type: z.enum(['capital', 'current', 'profit']),
  glAccountId: Id,
});

export const RunDistributionSchema = z.object({
  fiscalYearId: Id,
  policy: z.enum(['share_percent', 'custom']),
  customShares: z
    .array(z.object({ shareholderId: Id, ownershipPercent: Fraction }))
    .max(500)
    .optional(),
  note: z.string().max(1000).optional(),
});

export const CreateSettlementSchema = z.object({
  channelId: Id.optional(),
  accountId: Id,
  externalStatementId: z.string().max(150).optional(),
  periodFrom: IsoDate,
  periodTo: IsoDate,
  grossAmount: Money,
  commissionAmount: Money.optional(),
  feeAmount: Money.optional(),
  returnAmount: Money.optional(),
  taxAmount: Money.optional(),
  netAmount: Money,
  lines: z
    .array(
      z.object({
        lineType: z.enum(['sale', 'commission', 'fee', 'return', 'shipping', 'penalty', 'tax', 'adjustment']),
        amount: Money,
        salesOrderId: Id.optional(),
        externalReference: z.string().max(150).optional(),
      }),
    )
    .max(2000)
    .optional(),
});

export const ConfirmSettlementSchema = z.object({
  tolerance: Money.optional(),
});

export function parseDto<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw appErrorFromZod(result.error);
  return result.data;
}

export function toBigInt(value: string | number): bigint {
  return typeof value === 'number' ? BigInt(value) : BigInt(value);
}

export function toMoney(value: string): bigint {
  return parseMoney(value);
}
