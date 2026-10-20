/** Settlement net formula and line reconciliation (B-03/M-12). */
import { describe, expect, it } from 'vitest';
import {
  assertNoRevenueReRecognition,
  assertSettlementNet,
  expectedNetPayable,
  reconcileSettlement,
} from '../settlement';

const amounts = {
  grossSalesAmount: 10_000_000n,
  commissionAmount: 900_000n,
  feeAmount: 100_000n,
  returnAmount: 500_000n,
  taxAmount: 950_000n,
  netPayableAmount: 7_550_000n,
};

describe('settlement arithmetic', () => {
  it('derives the net payable from the documented formula', () => {
    expect(expectedNetPayable(amounts)).toBe(7_550_000n);
    expect(() => assertSettlementNet(amounts)).not.toThrow();
  });

  it('rejects a net payable that breaks the formula', () => {
    expect(() => assertSettlementNet({ ...amounts, netPayableAmount: 8_000_000n })).toThrow();
  });

  it('reconciles the header against settlement lines', () => {
    const result = reconcileSettlement(amounts, [
      { lineType: 'sale', amount: 10_000_000n },
      { lineType: 'commission', amount: 900_000n },
      { lineType: 'fee', amount: 100_000n },
      { lineType: 'return', amount: 500_000n },
      { lineType: 'tax', amount: 950_000n },
    ]);
    expect(result.withinTolerance).toBe(true);
    expect(result.netDifference).toBe(0n);
    expect(result.varianceAmount).toBe(0n);
  });

  it('flags a discrepancy outside tolerance and records the variance', () => {
    const result = reconcileSettlement(amounts, [
      { lineType: 'sale', amount: 10_000_000n },
      { lineType: 'commission', amount: 950_000n },
    ]);
    expect(result.withinTolerance).toBe(false);
    expect(result.varianceAmount).not.toBe(0n);
  });

  it('accepts a small difference inside the explicit tolerance', () => {
    const result = reconcileSettlement(
      { ...amounts, netPayableAmount: 7_550_000n },
      [
        { lineType: 'sale', amount: 10_000_000n },
        { lineType: 'commission', amount: 900_000n },
        { lineType: 'fee', amount: 100_000n },
        { lineType: 'return', amount: 500_000n },
        { lineType: 'tax', amount: 949_000n },
      ],
      2_000n,
    );
    expect(result.withinTolerance).toBe(true);
  });

  it('refuses revenue re-recognition in a settlement journal', () => {
    expect(() => assertNoRevenueReRecognition(['1-1-08-001', '2-1-10-001'])).not.toThrow();
    expect(() => assertNoRevenueReRecognition(['1-1-08-001', '4-1-01-002'])).toThrow();
  });
});
