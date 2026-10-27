/**
 * Service-level inventory invariants.
 *
 * These tests deliberately use a small fake repository: the real SQL paths are
 * exercised by `scripts/verify-inventory-invariants.mjs` against PostgreSQL.
 */
import 'reflect-metadata';

import { describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '../../../common/contracts';
import type { BalanceRow, LedgerRow, ReservationRow } from '../inventory.repository';
import type { InventoryRepository } from '../inventory.repository';
import {
  businessDateInTimeZone,
  InventoryService,
  movementPayloadHash,
} from '../inventory.service';

const ctx: TenantContext = {
  requestId: 'test-request',
  orgId: 1n,
  orgPublicId: '00000000-0000-0000-0000-000000000001',
  actorId: 7n,
  actorPublicId: '00000000-0000-0000-0000-000000000007',
  permissions: [],
  branchIds: null,
  warehouseIds: null,
};

const balance: BalanceRow = {
  internalId: '10',
  id: '10000000-0000-0000-0000-000000000010',
  warehouseId: '20000000-0000-0000-0000-000000000001',
  warehouseInternalId: '1',
  locationId: '30000000-0000-0000-0000-000000000002',
  locationInternalId: '2',
  variantId: '40000000-0000-0000-0000-000000000003',
  variantInternalId: '3',
  sku: 'SKU-1',
  productId: '50000000-0000-0000-0000-000000000004',
  onHand: '5.0000',
  reserved: '0.0000',
  safetyBuffer: '0.0000',
  damaged: '0.0000',
  inTransit: '0.0000',
  lastTransactionId: null,
  lastCountedAt: null,
  version: 1,
  updatedAt: '2026-10-27T10:00:00.000Z',
};

const existingMovement: LedgerRow = {
  internalId: '55',
  id: '60000000-0000-0000-0000-000000000055',
  warehouseId: balance.warehouseId,
  warehouseInternalId: balance.warehouseInternalId,
  locationId: balance.locationId,
  locationInternalId: balance.locationInternalId,
  variantId: balance.variantId,
  variantInternalId: balance.variantInternalId,
  transactionType: 'adjustment_in',
  quantity: '1.0000',
  unitCostAmount: '100',
  totalCostAmount: '100',
  currency: 'IRR',
  lotId: null,
  referenceType: 'manual',
  referenceId: null,
  referencePublicId: null,
  reversalOfId: null,
  idempotencyKey: 'retry-key',
  businessDate: '2026-10-27',
  periodId: '9',
  journalEntryId: null,
  costState: 'averaged',
  createdAt: '2026-10-27T10:00:00.000Z',
  createdBy: '7',
};

const movementInput = {
  warehouseId: balance.warehouseId,
  locationId: balance.locationId,
  variantId: balance.variantId,
  type: 'adjustment_in' as const,
  quantity: '1',
  unitCostAmount: 100n,
  referenceType: 'manual',
  idempotencyKey: 'retry-key',
};

function makeService(repo: Partial<InventoryRepository>, catalog: Record<string, unknown> = {}) {
  return new InventoryService(
    {} as never,
    repo as InventoryRepository,
    catalog as never,
    { record: vi.fn() } as never,
    { emit: vi.fn() } as never,
  );
}

describe('postMovement idempotency (retry-safe)', () => {
  it('returns the transaction and balance of the stored movement for the same payload', async () => {
    const repo = {
      lockMovementIdempotencyKey: vi.fn(async () => undefined),
      findTransactionByIdempotencyKey: vi.fn(async () => existingMovement),
      findMovementRequestHash: vi.fn(async () => movementPayloadHash(movementInput)),
      findBalanceByIdentity: vi.fn(async () => balance),
      insertTransaction: vi.fn(),
    };
    const service = makeService(repo);

    const result = await service.postMovement({} as never, ctx, movementInput);

    expect(result.transaction.id).toBe(existingMovement.id);
    expect(result.balance.id).toBe(balance.id);
    expect(result.unitCostAmount).toBe(100n);
    expect(result.totalCostAmount).toBe(100n);
    expect(repo.insertTransaction).not.toHaveBeenCalled();
    expect(repo.lockMovementIdempotencyKey).toHaveBeenCalledWith({}, ctx.orgId, 'retry-key');
  });

  it('rejects a different payload that reuses the same idempotency key', async () => {
    const repo = {
      lockMovementIdempotencyKey: vi.fn(async () => undefined),
      findTransactionByIdempotencyKey: vi.fn(async () => existingMovement),
      findMovementRequestHash: vi.fn(async () => movementPayloadHash(movementInput)),
      findBalanceByIdentity: vi.fn(async () => balance),
    };
    const service = makeService(repo);

    await expect(
      service.postMovement({} as never, ctx, { ...movementInput, quantity: '2' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('replays a legacy row without a hash but still rejects a changed quantity', async () => {
    const repo = {
      lockMovementIdempotencyKey: vi.fn(async () => undefined),
      findTransactionByIdempotencyKey: vi.fn(async () => existingMovement),
      findMovementRequestHash: vi.fn(async () => null),
      findBalanceByIdentity: vi.fn(async () => balance),
    };
    const service = makeService(repo);

    const replay = await service.postMovement({} as never, ctx, movementInput);
    expect(replay.transaction.id).toBe(existingMovement.id);
    await expect(
      service.postMovement({} as never, ctx, { ...movementInput, quantity: '2' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('reserveForReference concurrency', () => {
  it('locks once and never oversells when two allocators race for the last unit', async () => {
    const shared: BalanceRow = { ...balance };
    let arrivals = 0;
    let releaseArrivals: () => void = () => undefined;
    const bothArrived = new Promise<void>((resolve) => {
      releaseArrivals = resolve;
    });

    // One mutex per balance row, held until the winner writes the balance.
    let lockTail: Promise<void> = Promise.resolve();
    let releaseLock: (() => void) | null = null;

    const repo = {
      availabilityCandidates: vi.fn(async () => {
        arrivals += 1;
        if (arrivals === 2) releaseArrivals();
        await bothArrived;
        // Both transactions read the pre-lock snapshot of 5 available units.
        return [
          {
            warehouseInternalId: shared.warehouseInternalId,
            locationInternalId: shared.locationInternalId,
            variantInternalId: shared.variantInternalId,
            available: '5.0000',
          },
        ];
      }),
      lockBalances: vi.fn(async () => {
        const previous = lockTail;
        let release: () => void = () => undefined;
        lockTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        releaseLock = release;
        return [{ ...shared }];
      }),
      availableForKeys: vi.fn(async () => [
        {
          warehouseInternalId: shared.warehouseInternalId,
          locationInternalId: shared.locationInternalId,
          variantInternalId: shared.variantInternalId,
          available: (
            Number(shared.onHand) -
            Number(shared.reserved) -
            Number(shared.safetyBuffer) -
            Number(shared.damaged)
          ).toFixed(4),
        },
      ]),
      insertReservation: vi.fn(async (_tx, input) => {
        const reservation: ReservationRow = {
          internalId: '99',
          id: '70000000-0000-0000-0000-000000000099',
          reservationNo: input.reservationNo,
          warehouseId: shared.warehouseId,
          warehouseInternalId: input.warehouseInternalId.toString(),
          locationId: shared.locationId,
          locationInternalId: input.locationInternalId.toString(),
          variantId: shared.variantId,
          variantInternalId: input.variantInternalId.toString(),
          quantity: input.quantity,
          consumedQuantity: '0.0000',
          releasedQuantity: '0.0000',
          consumedTransactionId: null,
          referenceType: input.referenceType,
          referenceId: null,
          referencePublicId: null,
          status: 'active',
          expiresAt: input.expiresAt,
          createdAt: '2026-10-27T10:00:00.000Z',
        };
        return reservation;
      }),
      updateBalance: vi.fn(async (_tx, _id, patch) => {
        shared.reserved = patch.reserved;
        releaseLock?.();
        releaseLock = null;
      }),
    };
    const service = makeService(repo, {
      findVariants: vi.fn(async () => [
        {
          id: shared.variantId,
          internalId: BigInt(shared.variantInternalId),
          costMethod: 'moving_average',
        },
      ]),
    });

    const request = () =>
      service.reserveForReference({} as never, ctx, {
        referenceType: 'manual',
        referenceInternalId: 1n,
        referencePublicId: null,
        lines: [{ variantId: shared.variantId, quantity: '5' }],
        ttlMinutes: 30,
        reason: 'test',
      });

    const results = await Promise.allSettled([request(), request()]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(shared.reserved).toBe('5.0000');
    expect(repo.insertReservation).toHaveBeenCalledTimes(1);
    expect(repo.lockBalances).toHaveBeenCalledTimes(2);
    expect(repo.updateBalance).toHaveBeenCalledTimes(1);
    expect(repo.insertReservation.mock.calls[0]?.[1].reservationNo).toMatch(/^RSV-[0-9A-F]{32}$/);
    expect(repo.insertReservation.mock.calls[0]?.[1].reservationNo).toHaveLength(36);
  });
});

describe('organization business date', () => {
  it('rolls the day at the configured timezone midnight, not at UTC midnight', () => {
    const instant = new Date('2026-10-26T21:00:00.000Z');
    expect(businessDateInTimeZone(instant, 'Asia/Tehran')).toBe('2026-10-27');
    expect(businessDateInTimeZone(instant, 'UTC')).toBe('2026-10-26');
  });

  it('falls back to Asia/Tehran for an invalid IANA identifier', () => {
    const instant = new Date('2026-10-26T21:00:00.000Z');
    expect(businessDateInTimeZone(instant, 'Not/AZone')).toBe('2026-10-27');
  });
});
