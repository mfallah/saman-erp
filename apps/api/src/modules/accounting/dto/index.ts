/**
 * Accounting DTOs (Zod). Money is an integer string (`MoneyString`) and is
 * converted to `bigint` at the controller edge; the domain never sees a number.
 */
import { z } from 'zod';
import { appErrorFromZod, parseMoney } from '@saman/shared';
import type { ZodType } from 'zod';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'iso_date' });
const Money = z.string().regex(/^-?\d+$/, { message: 'money_integer_string' });
const Id = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]);

export const AccountTypeSchema = z.enum(['asset', 'liability', 'equity', 'income', 'expense']);

export const CreateAccountSchema = z.object({
  code: z.string().min(1).max(60),
  nameFa: z.string().min(1).max(250),
  nameEn: z.string().max(250).optional(),
  parentId: Id.optional(),
  type: AccountTypeSchema,
  level: z.number().int().min(1).max(6),
  isPostable: z.boolean(),
  currency: z.string().length(3).optional(),
});
export type CreateAccountBody = z.infer<typeof CreateAccountSchema>;

export const UpdateAccountSchema = z.object({
  nameFa: z.string().min(1).max(250).optional(),
  nameEn: z.string().max(250).optional(),
  isActive: z.boolean().optional(),
});

export const AccountFilterSchema = z.object({
  level: z.coerce.number().int().min(1).max(6).optional(),
  parentId: Id.optional(),
  type: AccountTypeSchema.optional(),
  active: z.coerce.boolean().optional(),
  code: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const JournalLineSchema = z.object({
  accountId: Id,
  debit: Money,
  credit: Money,
  description: z.string().max(500).optional(),
  partnerType: z.enum(['customer', 'supplier', 'shareholder', 'employee', 'channel', 'other']).optional(),
  partnerId: Id.optional(),
  taxRateId: Id.optional(),
});

export const CreateJournalSchema = z.object({
  date: IsoDate,
  description: z.string().min(1).max(1000),
  entryType: z.enum(['normal', 'opening', 'adjustment', 'reversal', 'closing', 'auto']).optional(),
  lines: z.array(JournalLineSchema).min(2).max(200),
});

export const UpdateJournalSchema = z.object({
  date: IsoDate.optional(),
  description: z.string().min(1).max(1000).optional(),
  lines: z.array(JournalLineSchema).min(2).max(200).optional(),
});

export const AppendJournalLineSchema = JournalLineSchema;

export const JournalFilterSchema = z.object({
  status: z.string().optional(),
  type: z.string().optional(),
  fiscalYearId: Id.optional(),
  periodId: Id.optional(),
  dateFrom: IsoDate.optional(),
  dateTo: IsoDate.optional(),
  sourceType: z.string().optional(),
  sourceId: Id.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const CreateFiscalYearSchema = z.object({
  startDate: IsoDate,
  endDate: IsoDate,
  title: z.string().min(1).max(100),
  code: z.string().min(1).max(20).optional(),
});

export const ReopenSchema = z.object({
  reason: z.string().min(30).max(1000),
  stepUpToken: z.string().optional(),
});

export const CloseSchema = z.object({
  note: z.string().max(1000).optional(),
  stepUpToken: z.string().optional(),
});

export const ReverseJournalSchema = z.object({
  reason: z.string().min(3).max(500),
  reversalDate: IsoDate.optional(),
});

export const BalanceQuerySchema = z.object({
  fiscalYearId: Id.optional(),
  periodId: Id.optional(),
  accountId: Id.optional(),
  level: z.coerce.number().int().min(1).max(6).optional(),
});

export const LedgerQuerySchema = z.object({
  accountId: Id.optional(),
  dateFrom: IsoDate.optional(),
  dateTo: IsoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const SubLedgerQuerySchema = z.object({
  partyType: z.enum(['customer', 'supplier', 'shareholder', 'employee', 'channel', 'other']),
  partyId: Id.optional(),
  dateFrom: IsoDate.optional(),
});

export const JournalBookQuerySchema = z.object({
  fiscalYearId: Id.optional(),
  dateFrom: IsoDate.optional(),
  dateTo: IsoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const CreateTaxRateSchema = z.object({
  code: z.string().min(1).max(40),
  nameFa: z.string().min(1).max(150),
  type: z.enum(['vat', 'withholding', 'income', 'excise', 'duty', 'exempt']),
  /** JSON field name per API §4.11; value is a **fraction** (0.10 = 10%). */
  rate: z.string().regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/, { message: 'rate_fraction_0_1' }),
  glAccountId: Id,
  validFrom: IsoDate,
  validTo: IsoDate.optional(),
  isDefault: z.boolean().optional(),
  isRecoverable: z.boolean().optional(),
});

export const UpdateTaxRateSchema = z.object({
  rate: z.string().regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/).optional(),
  validTo: IsoDate.optional(),
  active: z.boolean().optional(),
});

export const CreateTaxDocumentSchema = z.object({
  type: z.enum([
    'sales_vat',
    'sales_return_vat',
    'credit_note',
    'purchase_vat',
    'purchase_return_vat',
    'vat_return',
    'withholding',
    'export_summary',
  ]),
  documentKind: z.enum(['original', 'credit_note', 'debit_note']).optional(),
  taxableAmount: Money,
  rate: z.string().optional(),
  taxRateId: Id.optional(),
  customerInvoiceId: Id.optional(),
  supplierInvoiceId: Id.optional(),
  originalDocumentId: Id.optional(),
  partyType: z.enum(['customer', 'supplier', 'partner']).optional(),
  partyId: Id.optional(),
  issueDate: IsoDate,
});

export const StartValuationSchema = z.object({
  method: z.enum(['fifo', 'weighted_average', 'moving_average']),
  periodId: Id,
  warehouseIds: z.array(Id).max(100).optional(),
  asOf: IsoDate.optional(),
});

export const ValuationFilterSchema = z.object({
  method: z.string().optional(),
  status: z.string().optional(),
  periodId: Id.optional(),
  warehouseId: Id.optional(),
});

/** Parses a DTO or converts the Zod failure into a contract `VALIDATION_ERROR`. */
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

export function optionalBigInt(value: string | number | undefined): bigint | undefined {
  return value === undefined ? undefined : toBigInt(value);
}
