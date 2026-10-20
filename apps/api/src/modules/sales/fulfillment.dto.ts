/** Fulfillment DTOs (packing → shipment → dispatch → delivery). */
import { z } from 'zod';

export const PublicId = z.string().uuid({ message: 'invalid_uuid' });

export const QuantityString = z.string().regex(/^\d+(\.\d{1,4})?$/, { message: 'quantity_decimal' });
export const MoneyString = z.string().regex(/^-?\d+$/, { message: 'money_integer_string' });

export const CreatePackingTaskBody = z.object({
  orderId: PublicId,
  stationId: PublicId.optional(),
});
export type CreatePackingTaskBody = z.infer<typeof CreatePackingTaskBody>;

export const PackingScanBody = z.object({
  barcode: z.string().trim().min(1).max(100),
  quantity: QuantityString,
  clientScanId: z.string().trim().max(80).optional(),
});
export type PackingScanBody = z.infer<typeof PackingScanBody>;

export const CompletePackingBody = z.object({
  packageNo: z.string().trim().max(50).optional(),
  packageType: z.enum(['box', 'envelope', 'pallet']).optional(),
  weightGrams: z.number().int().min(0).max(1_000_000).optional(),
  carrierId: PublicId.optional(),
});
export type CompletePackingBody = z.infer<typeof CompletePackingBody>;

export const DispatchShipmentBody = z.object({
  carrierId: PublicId.optional(),
  trackingCode: z.string().trim().max(100).optional(),
  shippingCostAmount: MoneyString.optional(),
  weightGrams: z.number().int().min(0).max(1_000_000).optional(),
});
export type DispatchShipmentBody = z.infer<typeof DispatchShipmentBody>;

export const DeliverShipmentBody = z.object({
  deliveredAt: z.string().datetime().optional(),
});
export type DeliverShipmentBody = z.infer<typeof DeliverShipmentBody>;

export const ShipmentListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(['draft', 'packed', 'dispatched', 'in_transit', 'delivered', 'returned', 'cancelled']).optional(),
});
export type ShipmentListQuery = z.infer<typeof ShipmentListQuery>;

export function parseWith<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const error = new Error(first?.message ?? 'invalid_input') as Error & { code?: string; details?: unknown };
    error.code = 'VALIDATION_ERROR';
    error.details = parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), rule: issue.message }));
    throw error;
  }
  return parsed.data;
}
