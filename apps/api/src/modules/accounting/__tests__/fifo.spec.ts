/** FIFO cost layers & moving average (`R1-accounting` B-07). */
import { describe, expect, it } from 'vitest';
import { applyAverageInbound, assertLayerIntegrity, consumeAverage, consumeFifo } from '../valuation/fifo';
import { applyRate, roundHalfUp } from '@saman/shared';
import { formatQty, parseQty } from '../valuation/quantity';
import type { CostLayer } from '../valuation/fifo';

const layer = (id: bigint, receivedAt: string, qty: string, unitCost: bigint): CostLayer => ({
  id,
  receivedAt,
  qtyRemaining: qty,
  unitCostAmount: unitCost,
  costRemainingAmount: roundHalfUp(unitCost * parseQty(qty), 10_000n),
});

describe('FIFO consumption', () => {
  it('consumes the oldest layer first', () => {
    const layers = [layer(3n, '2026-03-01', '5', 200n), layer(1n, '2026-01-01', '10', 100n), layer(2n, '2026-02-01', '10', 150n)];
    const result = consumeFifo(layers, '12');
    expect(result.consumptions.map((row) => row.layerId)).toEqual([1n, 2n]);
    expect(result.consumptions[0]?.quantity).toBe('10');
    expect(result.consumptions[1]?.quantity).toBe('2');
    expect(result.totalCost).toBe(10n * 100n + 2n * 150n);
    expect(result.shortfallQuantity).toBe('0');
  });

  it('closes a depleted layer with its exact remaining cost (no residual)', () => {
    const layers = [layer(1n, '2026-01-01', '3', 333n), layer(2n, '2026-01-02', '1', 1000n)];
    const partial = consumeFifo(layers, '1');
    expect(partial.totalCost).toBe(333n);
    const rest = consumeFifo(layers, '2');
    expect(rest.totalCost).toBe(2n * 333n);
    const all = consumeFifo(layers, '4');
    expect(all.totalCost).toBe(999n + 1000n);
  });

  it('is deterministic when timestamps tie (orders by id)', () => {
    const sameTime = [
      { id: 2n, receivedAt: '2026-01-01T00:00:00Z', qtyRemaining: '1', unitCostAmount: 50n, costRemainingAmount: 50n },
      { id: 1n, receivedAt: '2026-01-01T00:00:00Z', qtyRemaining: '1', unitCostAmount: 10n, costRemainingAmount: 10n },
    ];
    expect(consumeFifo(sameTime, '2').consumptions[0]?.layerId).toBe(1n);
  });

  it('rejects an issue larger than the layers available', () => {
    expect(() => consumeFifo([layer(1n, '2026-01-01', '1', 100n)], '2')).toThrow();
  });

  it('rejects a non-positive issue quantity', () => {
    expect(() => consumeFifo([layer(1n, '2026-01-01', '1', 100n)], '0')).toThrow();
  });
});

describe('moving average', () => {
  it('recomputes the average cost on inbound', () => {
    const state = applyAverageInbound(
      { qtyOnHand: '10', avgCostAmount: 100n, totalValueAmount: 1000n },
      '10',
      2000n,
    );
    expect(state.qtyOnHand).toBe('20');
    expect(state.totalValueAmount).toBe(3000n);
    expect(state.avgCostAmount).toBe(150n);
  });

  it('clears the residual value when the stock is depleted', () => {
    const state = { qtyOnHand: '3', avgCostAmount: 333n, totalValueAmount: 1000n };
    const consumed = consumeAverage(state, '3');
    expect(consumed.costAmount).toBe(1000n);
    expect(consumed.next.totalValueAmount).toBe(0n);
    expect(consumed.next.avgCostAmount).toBe(0n);
  });

  it('rejects consuming more than on hand', () => {
    expect(() => consumeAverage({ qtyOnHand: '1', avgCostAmount: 10n, totalValueAmount: 10n }, '2')).toThrow();
  });
});

describe('layer integrity & quantity helpers', () => {
  it('rejects a depleted layer with residual cost', () => {
    expect(() =>
      assertLayerIntegrity({ id: 1n, receivedAt: '2026-01-01', qtyRemaining: '0', unitCostAmount: 100n, costRemainingAmount: 5n }),
    ).toThrow();
  });

  it('round-trips scaled quantities exactly', () => {
    expect(formatQty(parseQty('1.3333'))).toBe('1.3333');
    expect(parseQty('0.0001')).toBe(1n);
    expect(applyRate(1_000n, '0.1')).toBe(100n);
  });
});
