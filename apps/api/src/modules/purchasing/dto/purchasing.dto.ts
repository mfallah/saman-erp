/**
 * Purchasing request contracts.
 *
 * Quantities are `numeric(18,4)` decimal strings and money is bigint IRR, both as
 * strings (`ADR-0013`). For browser ergonomics the numeric fields also accept a JS
 * number and normalize to the canonical string form, so the SPA can post form values
 * without a second formatting layer.
 */
import { MoneyString, OffsetPaginationQuery, QuantityString, appErrorFromZod } from '@saman/shared';
import { z, type ZodTypeAny } from 'zod';

export const PublicId = z.string().uuid({ message: 'invalid_uuid' });
export const IdParam = z.object({ id: PublicId });

export function parseWith<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw appErrorFromZod(result.error);
  }
  return result.data as z.infer<S>;
}

/** `numeric(18,4)` quantity transported as a canonical decimal string. */
const QuantityInput = z
  .union([QuantityString, z.number().finite().min(0).max(1_000_000_000)])
  .transform((value) => (typeof value === 'number' ? value.toFixed(4) : value));

/** Unit cost in whole IRR (money is never fractional, `ADR-0013`). */
const UnitCostInput = z
  .union([MoneyString, z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)])
  .transform((value) => (typeof value === 'number' ? value.toString() : value));

export const SupplierListQuery = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type SupplierListQuery = z.infer<typeof SupplierListQuery>;

export const CreateSupplierBody = z.object({
  name: z.string().trim().min(2).max(250),
  phone: z.string().trim().min(3).max(30).optional(),
  code: z
    .string()
    .trim()
    .min(2)
    .max(50)
    .regex(/^[A-Za-z0-9._-]+$/, { message: 'invalid_supplier_code' })
    .optional(),
});
export type CreateSupplierBody = z.infer<typeof CreateSupplierBody>;

export const ReceiptListQuery = OffsetPaginationQuery.extend({
  q: z.string().trim().min(1).max(120).optional(),
  supplierId: PublicId.optional(),
  warehouseId: PublicId.optional(),
});
export type ReceiptListQuery = z.infer<typeof ReceiptListQuery>;

/** `GET /inventory/receipts/:receiptId/labels.svg?copies=1`. */
export const ReceiptLabelsParam = z.object({ receiptId: PublicId });
export type ReceiptLabelsParam = z.infer<typeof ReceiptLabelsParam>;

export const ReceiptLabelsQuery = z.object({
  /** Extra copies of every label; capped so a sheet request stays bounded. */
  copies: z.coerce.number().int().min(1).max(20).default(1),
});
export type ReceiptLabelsQuery = z.infer<typeof ReceiptLabelsQuery>;

/** ISO datetime with offset, or a plain `YYYY-MM-DD` (date-only = start of that day). */
const ReceivedAtInput = z.union([
  z.string().datetime({ offset: true }),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'invalid_datetime' }),
]);

export const CreateReceiptLineBody = z.object({
  variantId: PublicId,
  quantity: QuantityInput,
  /** Unit cost in IRR; defaults to the variant's latest recorded cost when omitted. */
  unitCost: UnitCostInput.optional(),
  /** Serial numbers received for this line; the count must match the quantity. */
  serials: z.array(z.string().trim().min(1).max(150)).max(2000).optional(),
  /**
   * Optional per-line placement. When either id is present this line's inbound
   * movement lands there instead of the receipt-level warehouse/location; the
   * location must belong to the chosen (or receipt-level) warehouse. Omitted =
   * the receipt-level placement, exactly as before.
   */
  warehouseId: PublicId.optional(),
  locationId: PublicId.optional(),
});
export type CreateReceiptLineBody = z.infer<typeof CreateReceiptLineBody>;

/**
 * Label preview for an unsaved receipt (`POST /goods-receipts/labels/preview`).
 * Same line shape the receipt accepts, minus the cost: labels only need the
 * variant, the unit count and the optional serials.
 */
export const ReceiptLabelPreviewLineBody = z.object({
  variantId: PublicId,
  quantity: QuantityInput,
  serials: z.array(z.string().trim().min(1).max(150)).max(2000).optional(),
});
export type ReceiptLabelPreviewLineBody = z.infer<typeof ReceiptLabelPreviewLineBody>;

export const ReceiptLabelsPreviewBody = z.object({
  /** Warehouse the operator is receiving into; validated against the organization. */
  warehouseId: PublicId.optional(),
  lines: z.array(ReceiptLabelPreviewLineBody).min(1).max(200),
});
export type ReceiptLabelsPreviewBody = z.infer<typeof ReceiptLabelsPreviewBody>;

export const CreateReceiptBody = z
  .object({
    /** Existing supplier by id … */
    supplierId: PublicId.optional(),
    /** … or a supplier name that is matched first and created only when unknown. */
    supplierName: z.string().trim().min(2).max(250).optional(),
    warehouseId: PublicId.optional(),
    receivedAt: ReceivedAtInput.optional(),
    notes: z.string().trim().max(1000).optional(),
    lines: z.array(CreateReceiptLineBody).min(1).max(200),
  })
  .refine((value) => value.supplierId !== undefined || value.supplierName !== undefined, {
    message: 'supplier_required',
    path: ['supplierId'],
  });
export type CreateReceiptBody = z.infer<typeof CreateReceiptBody>;
