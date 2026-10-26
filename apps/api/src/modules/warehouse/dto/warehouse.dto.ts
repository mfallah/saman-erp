/** Warehouse request contracts (`API.md` §4.5). */
import { QuantityString, appErrorFromZod } from '@saman/shared';
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

export const PositiveQuantity = QuantityString.refine((value) => Number(value) > 0, {
  message: 'quantity_must_be_positive',
});

export const WarehouseListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(25),
  status: z.enum(['active', 'inactive']).optional(),
  branchId: PublicId.optional(),
  q: z.string().trim().min(2).max(100).optional(),
});
export type WarehouseListQuery = z.infer<typeof WarehouseListQuery>;

export const CreateWarehouseBody = z.object({
  name: z.string().trim().min(1).max(200),
  code: z.string().trim().min(1).max(50).regex(/^[A-Z0-9][A-Z0-9_-]*$/i),
  branchId: PublicId.optional(),
  address: z.string().trim().max(1000).optional(),
  city: z.string().trim().max(100).optional(),
  type: z.enum(['main', 'transit', 'return']).optional(),
  settings: z.record(z.unknown()).optional(),
});
export type CreateWarehouseBody = z.infer<typeof CreateWarehouseBody>;

export const UpdateWarehouseBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    address: z.string().trim().max(1000).optional(),
    city: z.string().trim().max(100).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    settings: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'empty_update' });
export type UpdateWarehouseBody = z.infer<typeof UpdateWarehouseBody>;

export const LocationListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().max(2048).optional(),
  code: z.string().trim().max(100).optional(),
  zoneId: PublicId.optional(),
  type: z.string().trim().max(30).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  hasStock: z.enum(['true', 'false']).optional(),
  q: z.string().trim().min(2).max(100).optional(),
});
export type LocationListQuery = z.infer<typeof LocationListQuery>;

export const LocationNodeInput = z.object({
  parentId: PublicId.nullish(),
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().max(150).optional(),
  type: z.enum(['zone', 'aisle', 'rack', 'shelf', 'bin', 'location']),
  capacity: QuantityString.optional(),
  barcode: z.string().trim().max(80).optional(),
  abcClass: z.enum(['A', 'B', 'C']).optional(),
  pickPriority: z.number().int().min(0).max(1_000_000).optional(),
  isPickFace: z.boolean().optional(),
  locationType: z.enum(['bin', 'staging', 'receiving', 'shipping', 'quarantine', 'scrap', 'transit']).optional(),
});
export type LocationNodeInput = z.infer<typeof LocationNodeInput>;

export const BulkCreateLocationsBody = z.object({ items: z.array(LocationNodeInput).min(1).max(500) });
export type BulkCreateLocationsBody = z.infer<typeof BulkCreateLocationsBody>;

export const UpdateLocationBody = z
  .object({
    capacity: QuantityString.optional(),
    status: z.enum(['active', 'inactive']).optional(),
    barcode: z.string().trim().max(80).optional(),
    pickPriority: z.number().int().min(0).max(1_000_000).optional(),
    isPickable: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'empty_update' });
export type UpdateLocationBody = z.infer<typeof UpdateLocationBody>;

export const MoveLocationBody = z.object({ parentId: PublicId.nullish() });
export const LocationLookupQuery = z.object({ code: z.string().trim().min(1).max(100) });

export const LocationRuleInput = z.object({
  categoryId: PublicId.optional(),
  productId: PublicId.optional(),
  variantId: PublicId.optional(),
  allow: z.boolean(),
  maxQuantity: QuantityString.optional(),
});

export const ReplaceLocationRulesBody = z.object({ rules: z.array(LocationRuleInput).max(100) });

export const PutawaySuggestionQuery = z.object({
  warehouseId: PublicId,
  variantId: PublicId,
  quantity: PositiveQuantity,
  lotId: PublicId.optional(),
});
export type PutawaySuggestionQuery = z.infer<typeof PutawaySuggestionQuery>;

export const CreatePickWaveBody = z.object({
  warehouseId: PublicId,
  orderIds: z.array(PublicId).min(1).max(50),
  strategy: z.enum(['fifo', 'fefo', 'nearest', 'fewest_picks']).default('fewest_picks'),
  priority: z.number().int().min(0).max(1000).optional(),
});
export type CreatePickWaveBody = z.infer<typeof CreatePickWaveBody>;

export const WaveListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(2048).optional(),
  status: z.enum(['planned', 'released', 'picking', 'picked', 'packed', 'cancelled']).optional(),
  warehouseId: PublicId.optional(),
});
export type WaveListQuery = z.infer<typeof WaveListQuery>;

export const ReleaseWaveBody = z.object({ assigneeIds: z.array(PublicId).max(50).optional() });
export type ReleaseWaveBody = z.infer<typeof ReleaseWaveBody>;
export const WaveCancelBody = z.object({ reason: z.string().trim().min(2).max(300) });

export const PickTaskListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(2048).optional(),
  status: z.enum(['pending', 'in_progress', 'picked', 'short', 'exception', 'cancelled']).optional(),
  waveId: PublicId.optional(),
  assigneeId: PublicId.optional(),
  deviceId: PublicId.optional(),
  locationId: PublicId.optional(),
});
export type PickTaskListQuery = z.infer<typeof PickTaskListQuery>;

export const AssignTaskBody = z.object({ assigneeUserId: PublicId, deviceId: PublicId.optional() });
export type AssignTaskBody = z.infer<typeof AssignTaskBody>;

/** `PATCH warehouse/pick-tasks/:id/assign`; omitting `userId` releases the task. */
export const PickTaskAssignBody = z.object({ userId: PublicId.optional() }).strict();
export type PickTaskAssignBody = z.infer<typeof PickTaskAssignBody>;

export const PickScanBody = z.object({
  eventId: PublicId.optional(),
  barcode: z.string().trim().min(1).max(100),
  locationCode: z.string().trim().max(100).optional(),
  quantity: PositiveQuantity,
  lotId: PublicId.optional(),
  serial: z.string().max(150).optional(),
  scanSource: z.enum(['scanner', 'camera', 'manual', 'offline_replay']).optional(),
});
export type PickScanBody = z.infer<typeof PickScanBody>;

export const ShortPickBody = z.object({
  lines: z.array(z.object({ lineId: PublicId, pickedQuantity: QuantityString, reason: z.string().max(300) })).min(1),
});
export const TaskCancelBody = z.object({ reason: z.string().trim().min(2).max(300) });
