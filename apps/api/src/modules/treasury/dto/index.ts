/** Treasury DTOs (Zod) — money is an integer string. */
import { z } from 'zod';
import { appErrorFromZod, parseMoney } from '@saman/shared';
import type { ZodType } from 'zod';

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'iso_date' });
export const Money = z.string().regex(/^-?\d+$/, { message: 'money_integer_string' });
export const Id = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]);

export const AllocationSchema = z.object({
  documentType: z.enum([
    'customer_invoice',
    'supplier_invoice',
    'refund',
    'expense',
    'journal_entry',
    'profit_distribution',
    'sales_order',
    'purchase_order',
    'customer_credit',
    'supplier_prepayment',
    'partner_capital',
  ]),
  documentId: Id,
  amount: Money,
});

export const CreatePaymentSchema = z.object({
  direction: z.enum(['inbound', 'outbound']),
  method: z.enum(['cash', 'pos', 'gateway', 'cash_on_delivery', 'bank_transfer', 'cheque', 'credit', 'other']),
  amount: Money,
  date: IsoDate,
  customerId: Id.optional(),
  supplierId: Id.optional(),
  partnerId: Id.optional(),
  bankAccountId: Id.optional(),
  cashBoxId: Id.optional(),
  chequeId: Id.optional(),
  salesOrderId: Id.optional(),
  purchaseOrderId: Id.optional(),
  expenseId: Id.optional(),
  refundId: Id.optional(),
  descriptionFa: z.string().max(1000).optional(),
  reference: z.string().max(150).optional(),
  allocations: z.array(AllocationSchema).max(100).optional(),
});

export const AllocatePaymentSchema = z.object({
  items: z.array(AllocationSchema).min(1).max(100),
});

export const CreateChequeSchema = z.object({
  direction: z.enum(['received', 'issued']),
  partyType: z.enum(['customer', 'supplier', 'shareholder', 'other']),
  partyId: Id,
  amount: Money,
  chequeNumber: z.string().min(1).max(60),
  dueDate: IsoDate,
  issueDate: IsoDate.optional(),
  bankName: z.string().max(150).optional(),
  bankAccountId: Id.optional(),
  cashBoxId: Id.optional(),
  sayadId: z.string().max(40).optional(),
});

export const CreateCashBoxSchema = z.object({
  code: z.string().min(1).max(40),
  nameFa: z.string().min(1).max(150),
  branchId: Id.optional(),
  glAccountId: Id,
});

export const OpenCashSessionSchema = z.object({
  cashBoxId: Id,
  openingBalance: Money,
});

export const CloseCashSessionSchema = z.object({
  countedBalance: Money,
  note: z.string().max(1000).optional(),
  varianceAccountId: Id.optional(),
});

export const CreateCashTransactionSchema = z.object({
  cashBoxId: Id,
  sessionId: Id.optional(),
  type: z.enum(['receipt', 'payment']),
  amount: Money,
  date: IsoDate,
  partyType: z.enum(['customer', 'supplier', 'shareholder', 'other']).optional(),
  partyId: Id.optional(),
  descriptionFa: z.string().max(1000).optional(),
});

export const CreateBankAccountSchema = z.object({
  nameFa: z.string().min(1).max(150),
  code: z.string().min(1).max(40).optional(),
  bankName: z.string().min(1).max(150),
  accountNumber: z.string().min(1).max(60),
  iban: z.string().max(34).optional(),
  glAccountId: Id,
  branchId: Id.optional(),
  openingBalance: Money.optional(),
});

export const ImportStatementSchema = z.object({
  statementNo: z.string().min(1).max(80),
  from: IsoDate,
  to: IsoDate,
  openingBalance: Money,
  closingBalance: Money,
  format: z.enum(['csv', 'xlsx']).optional(),
  fileId: Id.optional(),
  lines: z
    .array(
      z.object({
        lineNo: z.number().int().positive(),
        valueDate: IsoDate,
        direction: z.enum(['debit', 'credit']),
        amount: Money,
        description: z.string().max(500).optional(),
        bankReference: z.string().max(150).optional(),
      }),
    )
    .min(1),
});

export const CreateReconciliationSchema = z.object({
  bankAccountId: Id,
  statementId: Id,
});

export const MatchSchema = z.object({
  items: z
    .array(
      z.object({
        statementLineId: Id,
        paymentId: Id.optional(),
        bankTransactionId: Id.optional(),
        journalLineId: Id.optional(),
        amount: Money.optional(),
        notes: z.string().max(300).optional(),
      }),
    )
    .min(1),
});

export const CompleteReconciliationSchema = z.object({
  note: z.string().min(1).max(1000),
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
