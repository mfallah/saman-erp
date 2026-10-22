/**
 * Inventory request contracts (`API.md` §4.4). Quantities and money are strings
 * (`ADR-0013`); ids are public UUIDs.
 */
import { CursorPaginationQuery, MoneyString, OffsetPaginationQuery, QuantityString, appErrorFromZod } from '@saman/shared';
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

const BooleanQuery = z.enum(['true', 'false', '1', '0']).transform((value) => value === 'true' || value === '1');

export const PositiveQuantity = QuantityString.refine((value) => Number(value) > 0, {
  message: 'quantity_must_be_positive',
});

export const BalanceListQuery = CursorPaginationQuery.extend({
  warehouseId: PublicId.optional(),
  variantId: PublicId.optional(),
  productId: PublicId.optional(),
  locationId: PublicId.optional(),
  includeZero: BooleanQuery.optional(),
  safetyBufferBelow: QuantityString.optional(),
  updatedAtGte: z.string().datetime().optional(),
});
export type BalanceListQuery = z.infer<typeof BalanceListQuery>;

export const AvailabilityQuery = z.object({
  variantIds: z
    .string()
    .min(1)
    .transform((value) => value.split(',').map((item) => item.trim()).filter((item) => item.length > 0))
    .refine((ids) => ids.length > 0 && ids.length <= 100, { message: 'invalid_variant_id_list' }),
  warehouseIds: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? undefined : value.split(',').map((item) => item.trim()).filter((item) => item.length > 0))),
  channelCode: z.string().max(40).optional(),
});
export type AvailabilityQuery = z.infer<typeof AvailabilityQuery>;

export const LedgerListQuery = CursorPaginationQuery.extend({
  warehouseId: PublicId.optional(),
  variantId: PublicId.optional(),
  type: z.string().max(40).optional(),
  referenceType: z.string().max(50).optional(),
  referenceId: PublicId.optional(),
  createdFrom: z.string().datetime().optional(),
  createdTo: z.string().datetime().optional(),
});
export type LedgerListQuery = z.infer<typeof LedgerListQuery>;

export const ReservationListQuery = CursorPaginationQuery.extend({
  status: z.enum(['active', 'consumed', 'released', 'expired']).optional(),
  variantId: PublicId.optional(),
  warehouseId: PublicId.optional(),
  sourceType: z.string().max(40).optional(),
  sourceId: PublicId.optional(),
  expiresBefore: z.string().datetime().optional(),
});
export type ReservationListQuery = z.infer<typeof ReservationListQuery>;

export const CreateReservationBody = z.object({
  warehouseId: PublicId.optional(),
  lines: z
    .array(z.object({ variantId: PublicId, quantity: PositiveQuantity }))
    .min(1)
    .max(200),
  reason: z.string().trim().min(2).max(300),
  ttlMinutes: z.number().int().min(1).max(10_080).optional(),
});
export type CreateReservationBody = z.infer<typeof CreateReservationBody>;

export const ReleaseReservationBody = z.object({ reason: z.string().trim().max(300).optional() });
export const ConsumeReservationBody = z.object({
  referenceType: z.string().trim().min(2).max(40),
  referenceId: PublicId,
});

export const AdjustmentListQuery = OffsetPaginationQuery.extend({
  status: z.enum(['draft', 'pending_approval', 'approved', 'applied', 'rejected', 'voided']).optional(),
  type: z.string().max(40).optional(),
  warehouseId: PublicId.optional(),
});
export type AdjustmentListQuery = z.infer<typeof AdjustmentListQuery>;

export const AdjustmentLineInput = z.object({
  variantId: PublicId,
  locationId: PublicId.optional(),
  quantity: PositiveQuantity,
  unitCost: MoneyString.optional(),
});

export const CreateAdjustmentBody = z.object({
  warehouseId: PublicId,
  type: z.enum(['increase', 'decrease', 'writeoff', 'damage', 'correction']),
  reason: z.string().trim().min(2).max(300),
  lines: z.array(AdjustmentLineInput).min(1).max(500),
  attachmentFileIds: z.array(PublicId).max(20).optional(),
});
export type CreateAdjustmentBody = z.infer<typeof CreateAdjustmentBody>;

export const ApproveBody = z.object({
  stepUpToken: z.string().trim().max(200).optional(),
  note: z.string().trim().max(300).optional(),
});
export const VoidBody = z.object({ reason: z.string().trim().min(2).max(300) });

export const TransferListQuery = CursorPaginationQuery.extend({
  status: z
    .enum(['draft', 'pending_approval', 'approved', 'dispatched', 'partially_received', 'received', 'cancelled'])
    .optional(),
  fromWarehouseId: PublicId.optional(),
  toWarehouseId: PublicId.optional(),
  createdAtGte: z.string().datetime().optional(),
});
export type TransferListQuery = z.infer<typeof TransferListQuery>;

export const CreateTransferBody = z.object({
  fromWarehouseId: PublicId,
  toWarehouseId: PublicId,
  lines: z
    .array(
      z.object({
        variantId: PublicId,
        fromLocationId: PublicId,
        toLocationId: PublicId.optional(),
        quantity: PositiveQuantity,
      }),
    )
    .min(1)
    .max(500),
  reason: z.string().trim().min(2).max(300),
  expectedAt: z.string().datetime().optional(),
});
export type CreateTransferBody = z.infer<typeof CreateTransferBody>;

export const ReceiveTransferBody = z.object({
  lines: z
    .array(
      z.object({
        lineId: PublicId,
        receivedQuantity: PositiveQuantity,
        toLocationId: PublicId,
      }),
    )
    .min(1)
    .max(500),
});
export type ReceiveTransferBody = z.infer<typeof ReceiveTransferBody>;

export const CancelBody = z.object({ reason: z.string().trim().min(2).max(300) });
export const TransferCancelBody = CancelBody;

export const CountListQuery = CursorPaginationQuery.extend({
  status: z.enum(['draft', 'counting', 'pending_approval', 'approved', 'applied', 'cancelled']).optional(),
  type: z.enum(['spot', 'cycle', 'full', 'zone']).optional(),
  warehouseId: PublicId.optional(),
});
export type CountListQuery = z.infer<typeof CountListQuery>;

export const CreateCountBody = z.object({
  warehouseId: PublicId,
  type: z.enum(['spot', 'cycle', 'full']),
  scope: z.object({
    locationIds: z.array(PublicId).max(500).optional(),
    categoryIds: z.array(PublicId).max(100).optional(),
    variantIds: z.array(PublicId).max(1000).optional(),
  }),
  blind: z.boolean().optional(),
  scheduledAt: z.string().datetime().optional(),
});
export type CreateCountBody = z.infer<typeof CreateCountBody>;

export const CountScanBody = z.object({
  eventId: PublicId.optional(),
  variantId: PublicId,
  locationId: PublicId.optional(),
  countedQuantity: QuantityString.refine((value) => Number(value) >= 0, { message: 'quantity_must_be_non_negative' }),
  lotId: PublicId.optional(),
  serial: z.string().max(150).optional(),
});

export const ValuationQuery = z.object({
  warehouseId: PublicId.optional(),
  categoryId: PublicId.optional(),
  variantId: PublicId.optional(),
  asOf: z.string().date().optional(),
});
export type ValuationQuery = z.infer<typeof ValuationQuery>;

export const ValuationLayersQuery = CursorPaginationQuery.extend({
  variantId: PublicId.optional(),
  warehouseId: PublicId.optional(),
  expiryBefore: z.string().date().optional(),
});
export type ValuationLayersQuery = z.infer<typeof ValuationLayersQuery>;

export const IntegrityCheckQuery = z.object({
  warehouseId: PublicId.optional(),
  since: z.string().datetime().optional(),
});
export type IntegrityCheckQuery = z.infer<typeof IntegrityCheckQuery>;
