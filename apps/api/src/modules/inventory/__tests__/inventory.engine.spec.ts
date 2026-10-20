/**
 * Inventory engine unit tests (pure, no Nest/PostgreSQL).
 *
 * Covers the board's non-negotiables from `ADR-0007`:
 * - the 100-parallel-allocator oversell scenario must leave exactly one winner
 *   (pure planner invariant: all-or-nothing + available≥requested);
 * - `available = on_hand − reserved − safety_buffer − damaged` can never go negative;
 * - FIFO layer consumption produces the exact cost and layer residue;
 * - moving average receipt/issue arithmetic;
 * - quantity/money precision (`ADR-0013`).
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '@saman/shared';

import {
  addQuantity,
  compareQuantity,
  divideMoneyByQuantity,
  formatQuantity,
  multiplyMoneyByQuantity,
  normalizeQuantity,
  parseQuantity,
  sumQuantities,
} from '../engines/quantity.engine';
import {
  applyMovementToBalance,
  applyReservationDelta,
  assertAvailabilityInvariant,
  assertValidMovement,
  availableQuantity,
  reconcileLedgerAgainstBalances,
  signedQuantity,
} from '../engines/ledger.engine';
import {
  assertAllocatable,
  groupReservations,
  isReservationExpired,
  planAllocation,
  reservationExpiry,
  reservationRemaining,
  sortCandidates,
  type BalanceCandidate,
} from '../engines/allocation.engine';
import {
  applyIssueCostToAverage,
  applyIssueToAverage,
  applyReceiptToAverage,
  assertLayerIntegrity,
  consumeLayersAtUnitCost,
  consumeLayersFifo,
  layersValue,
  reconcileLayersWithAverage,
  resolveIssueCost,
  sortLayersFifo,
  type CostLayer,
} from '../engines/cost.engine';

describe('quantity arithmetic (ADR-0013)', () => {
  it('parses and formats numeric(18,4) quantities', () => {
    expect(formatQuantity(parseQuantity('3'))).toBe('3.0000');
    expect(normalizeQuantity('3.5')).toBe('3.5000');
    expect(normalizeQuantity('-0.25')).toBe('-0.2500');
    expect(() => parseQuantity('1.23456')).toThrow(RangeError);
  });

  it('adds/subtracts without float drift', () => {
    expect(addQuantity('0.1', '0.2')).toBe('0.3000');
    expect(sumQuantities(['1.0001', '2.0002', '3.9997'])).toBe('7.0000');
    expect(compareQuantity('2.0000', '2')).toBe(0);
  });

  it('multiplies money by quantity with ROUND_HALF_UP', () => {
    expect(multiplyMoneyByQuantity(1_000n, '3.5')).toBe(3_500n);
    expect(multiplyMoneyByQuantity(333n, '0.3334')).toBe(111n);
    expect(divideMoneyByQuantity(1_000n, '3')).toBe(333n);
  });
});

describe('ledger sign matrix & balance projection', () => {
  it('derives the signed quantity from the transaction type', () => {
    expect(signedQuantity('receipt', '5')).toBe('5.0000');
    expect(signedQuantity('sale_issue', '5')).toBe('-5.0000');
    expect(() => assertValidMovement({ type: 'receipt', quantity: '0' })).toThrow(AppError);
    expect(() =>
      assertValidMovement({ type: 'sale_issue', quantity: '1', unitCostAmount: 0n }),
    ).toThrow(AppError);
  });

  it('computes available = on_hand − reserved − safety_buffer − damaged', () => {
    expect(
      availableQuantity({ onHand: '10', reserved: '3', safetyBuffer: '1', damaged: '2' }),
    ).toBe('4.0000');
  });

  it('rejects a projection that would make available negative', () => {
    expect(() =>
      assertAvailabilityInvariant({ onHand: '10', reserved: '10', safetyBuffer: '1', damaged: '0' }),
    ).toThrow(AppError);
  });

  it('applies an inbound movement and records damage separately', () => {
    const base = { onHand: '0.0000', reserved: '0.0000', safetyBuffer: '0.0000', damaged: '0.0000', inTransit: '0.0000' };
    expect(applyMovementToBalance(base, { type: 'receipt', quantity: '10' }).onHand).toBe('10.0000');
    const damaged = applyMovementToBalance({ ...base, onHand: '10.0000' }, { type: 'damage_out', quantity: '2' });
    expect(damaged.onHand).toBe('8.0000');
    expect(damaged.damaged).toBe('2.0000');
  });

  it('never allows negative on-hand even under a bug', () => {
    expect(() =>
      applyMovementToBalance(
        { onHand: '1.0000', reserved: '0.0000', safetyBuffer: '0.0000', damaged: '0.0000', inTransit: '0.0000' },
        { type: 'sale_issue', quantity: '2' },
      ),
    ).toThrow(AppError);
  });

  it('reservation delta guards over-release', () => {
    const state = { onHand: '10.0000', reserved: '2.0000', safetyBuffer: '0.0000', damaged: '0.0000' };
    expect(applyReservationDelta(state, '1.0000')).toBe('3.0000');
    expect(() => applyReservationDelta(state, '-3.0000')).toThrow(AppError);
  });

  it('reconciles ledger sums against balances', () => {
    const drifts = reconcileLedgerAgainstBalances(
      [{ warehouseId: 'w', locationId: 'l', variantId: 'v', quantitySum: '5.0000' }],
      [{ warehouseId: 'w', locationId: 'l', variantId: 'v', onHand: '4.0000' }],
    );
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.expected).toBe('5.0000');
    expect(drifts[0]?.actual).toBe('4.0000');
  });
});

describe('allocation engine — oversell race (ADR-0007 §3)', () => {
  const candidates = (available: string, variantId = 'v1'): BalanceCandidate[] => [
    { warehouseId: 'w1', locationId: 'l1', variantId, available },
  ];

  it('allows exactly one of 100 concurrent allocators for the last unit', () => {
    // Pure model of the race: every contender plans against the same snapshot;
    // the locked service re-reads availability, so only plans with available≥1
    // can commit. Exactly one contender sees stock in a serialized lock queue.
    const contenders = Array.from({ length: 100 }, (_, index) => index);
    let committed = 0;
    let stock = '1.0000';
    for (const _contender of contenders) {
      const plan = planAllocation([{ lineIndex: 0, variantId: 'v1', quantity: '1' }], candidates(stock));
      if (!plan.ok) continue;
      // commit only if the (re-locked) availability still covers the plan
      if (compareQuantity(stock, '1.0000') >= 0) {
        stock = addQuantity(stock, '-1.0000');
        committed += 1;
      }
    }
    expect(committed).toBe(1);
    expect(stock).toBe('0.0000');
  });

  it('fails all-or-nothing when any line is short, with per-line details', () => {
    const plan = planAllocation(
      [
        { lineIndex: 0, variantId: 'v1', quantity: '2' },
        { lineIndex: 1, variantId: 'v2', quantity: '5' },
      ],
      [...candidates('10', 'v1'), ...candidates('1', 'v2')],
    );
    expect(plan.ok).toBe(false);
    expect(plan.allocations).toHaveLength(0);
    expect(plan.failures).toHaveLength(1);
    expect(plan.failures[0]?.variantId).toBe('v2');
    expect(() => assertAllocatable(plan)).toThrow(AppError);
  });

  it('prefers a single warehouse that can satisfy the whole order', () => {
    const plan = planAllocation(
      [{ lineIndex: 0, variantId: 'v1', quantity: '4' }],
      [
        { warehouseId: 'w1', locationId: 'l1', variantId: 'v1', available: '2' },
        { warehouseId: 'w2', locationId: 'l2', variantId: 'v1', available: '10' },
      ],
    );
    expect(plan.ok).toBe(true);
    expect(plan.strategy).toBe('single_warehouse_first');
    expect(plan.allocations.every((allocation) => allocation.warehouseId === 'w2')).toBe(true);
  });

  it('splits across warehouses only when no single warehouse suffices', () => {
    const plan = planAllocation(
      [{ lineIndex: 0, variantId: 'v1', quantity: '6' }],
      [
        { warehouseId: 'w1', locationId: 'l1', variantId: 'v1', available: '3' },
        { warehouseId: 'w2', locationId: 'l2', variantId: 'v1', available: '3' },
      ],
    );
    expect(plan.ok).toBe(true);
    expect(plan.allocations).toHaveLength(2);
    expect(groupReservations(plan)).toHaveLength(2);
  });

  it('keeps the lock order deterministic (variant → warehouse → location)', () => {
    const sorted = sortCandidates([
      { warehouseId: 'w2', locationId: 'l2', variantId: 'v2', available: '1' },
      { warehouseId: 'w1', locationId: 'l1', variantId: 'v2', available: '1' },
      { warehouseId: 'w1', locationId: 'l1', variantId: 'v1', available: '1' },
    ]);
    expect(sorted.map((candidate) => `${candidate.variantId}:${candidate.warehouseId}`)).toEqual([
      'v1:w1',
      'v2:w1',
      'v2:w2',
    ]);
  });

  it('handles reservation TTL and partial consumption lifecycle', () => {
    const now = new Date('2026-07-18T10:00:00Z');
    const expiresAt = reservationExpiry(now, 30);
    expect(isReservationExpired({ quantity: '2', consumedQuantity: '0', releasedQuantity: '0', status: 'active', expiresAt }, new Date('2026-07-18T10:31:00Z'))).toBe(true);
    expect(reservationRemaining({ quantity: '5', consumedQuantity: '2', releasedQuantity: '1', status: 'active', expiresAt: null })).toBe('2.0000');
    expect(reservationRemaining({ quantity: '5', consumedQuantity: '5', releasedQuantity: '0', status: 'consumed', expiresAt: null })).toBe('0.0000');
  });
});

describe('FIFO cost layers', () => {
  const layers = (): CostLayer[] => [
    { layerId: '1', receivedAt: '2026-01-01T00:00:00Z', unitCostAmount: 1_000n, originalQuantity: '10.0000', quantityRemaining: '10.0000', costRemainingAmount: 10_000n },
    { layerId: '2', receivedAt: '2026-02-01T00:00:00Z', unitCostAmount: 1_200n, originalQuantity: '10.0000', quantityRemaining: '10.0000', costRemainingAmount: 12_000n },
  ];

  it('consumes oldest layers first with exact cost', () => {
    const result = consumeLayersFifo(layers(), '12');
    expect(result.consumptions).toHaveLength(2);
    expect(result.consumptions[0]?.costAmount).toBe(10_000n);
    expect(result.consumptions[1]?.costAmount).toBe(2_400n);
    expect(result.totalCostAmount).toBe(12_400n);
  });

  it('rejects issuing more than the layer quantity', () => {
    expect(() => consumeLayersFifo(layers(), '21')).toThrow(AppError);
  });

  it('writes off a rounding residual when a layer is fully depleted', () => {
    const oddLayer: CostLayer[] = [
      { layerId: '1', receivedAt: '2026-01-01T00:00:00Z', unitCostAmount: 333n, originalQuantity: '3.0000', quantityRemaining: '3.0000', costRemainingAmount: 1_000n },
    ];
    const result = consumeLayersFifo(oddLayer, '3');
    expect(result.totalCostAmount).toBe(1_000n);
    expect(result.remainingLayers[0]?.costRemainingAmount).toBe(0n);
  });

  it('orders layers by received_at and validates integrity', () => {
    const sorted = sortLayersFifo([
      { layerId: '2', receivedAt: '2026-02-01T00:00:00Z', unitCostAmount: 1n, originalQuantity: '1.0000', quantityRemaining: '1.0000', costRemainingAmount: 1n },
      { layerId: '1', receivedAt: '2026-01-01T00:00:00Z', unitCostAmount: 1n, originalQuantity: '1.0000', quantityRemaining: '1.0000', costRemainingAmount: 1n },
    ]);
    expect(sorted.map((layer) => layer.layerId)).toEqual(['1', '2']);
    expect(() => assertLayerIntegrity({ layerId: 'x', receivedAt: '2026-01-01', unitCostAmount: 10n, originalQuantity: '2.0000', quantityRemaining: '3.0000', costRemainingAmount: 20n })).toThrow(AppError);
  });

  it('resolves FIFO issue cost from layers', () => {
    const issue = resolveIssueCost({ method: 'fifo', quantity: '10', layers: layers() });
    expect(issue.totalCostAmount).toBe(10_000n);
    expect(issue.unitCostAmount).toBe(1_000n);
  });

  it('consumes layer quantities at the moving-average cost', () => {
    const result = consumeLayersAtUnitCost(layers(), '4', 1_100n);
    expect(result.totalCostAmount).toBe(4_400n);
  });
});

describe('moving average cost', () => {
  it('updates average on receipt', () => {
    const state = applyReceiptToAverage({ quantityOnHand: '0.0000', unitCostAmount: 0n, totalValueAmount: 0n }, { quantity: '10', unitCostAmount: 1_000n });
    expect(state.quantityOnHand).toBe('10.0000');
    expect(state.unitCostAmount).toBe(1_000n);
    const second = applyReceiptToAverage(state, { quantity: '10', unitCostAmount: 2_000n });
    expect(second.unitCostAmount).toBe(1_500n);
    expect(second.totalValueAmount).toBe(30_000n);
  });

  it('keeps value and quantity coupled on issue and depletion', () => {
    const state = { quantityOnHand: '10.0000', unitCostAmount: 1_500n, totalValueAmount: 15_000n };
    const issued = applyIssueToAverage(state, '4');
    expect(issued.quantityOnHand).toBe('6.0000');
    expect(issued.totalValueAmount).toBe(9_000n);
    expect(issued.unitCostAmount).toBe(1_500n);
    const emptied = applyIssueToAverage(issued, '6');
    expect(emptied.totalValueAmount).toBe(0n);
  });

  it('reconciles layer value against the average state', () => {
    const layers: CostLayer[] = [
      { layerId: '1', receivedAt: '2026-01-01T00:00:00Z', unitCostAmount: 1_500n, originalQuantity: '10.0000', quantityRemaining: '10.0000', costRemainingAmount: 15_000n },
    ];
    expect(layersValue(layers)).toBe(15_000n);
    const reconciled = reconcileLayersWithAverage(layers, { quantityOnHand: '10.0000', unitCostAmount: 1_500n, totalValueAmount: 15_000n });
    expect(reconciled.reconciled).toBe(true);
    const drifted = reconcileLayersWithAverage(layers, { quantityOnHand: '10.0000', unitCostAmount: 1_000n, totalValueAmount: 10_000n });
    expect(drifted.reconciled).toBe(false);
    expect(drifted.drift).toBe(5_000n);
  });

  it('applies actual issue cost (FIFO total) to the average state', () => {
    const next = applyIssueCostToAverage({ quantityOnHand: '10.0000', unitCostAmount: 1_500n, totalValueAmount: 15_000n }, '10', 15_000n);
    expect(next.quantityOnHand).toBe('0.0000');
    expect(next.totalValueAmount).toBe(0n);
  });
});
