/** Invoice arithmetic & rounding (`R1-accounting` B-12, ADR-0013). */
import { describe, expect, it } from 'vitest';
import {
  allocateHeaderDiscount,
  computeInvoiceTotals,
  computeLineAmounts,
} from '../posting/invoice-arithmetic';

describe('invoice line arithmetic', () => {
  it('rounds fractional quantities half-up to whole rials', () => {
    expect(computeLineAmounts({ quantity: '1.3333', unitPrice: 100n })).toEqual({
      netAmount: 133n,
      taxAmount: 0n,
      grossAmount: 133n,
    });
    expect(computeLineAmounts({ quantity: '1.5', unitPrice: 100n }).netAmount).toBe(150n);
    expect(computeLineAmounts({ quantity: '0.3333', unitPrice: 1000n }).netAmount).toBe(333n);
  });

  it('computes 9% and 10% VAT with half-up rounding', () => {
    expect(computeLineAmounts({ quantity: '1', unitPrice: 1_000n, taxRate: '0.09' }).taxAmount).toBe(90n);
    expect(computeLineAmounts({ quantity: '1', unitPrice: 1_005n, taxRate: '0.10' }).taxAmount).toBe(101n);
    expect(computeLineAmounts({ quantity: '1', unitPrice: 1_000n, taxRate: '0' }).taxAmount).toBe(0n);
  });

  it('supports tax-inclusive unit prices without double counting', () => {
    const line = computeLineAmounts({ quantity: '1', unitPrice: 1_100n, taxRate: '0.10', taxInclusive: true });
    expect(line.netAmount).toBe(1_000n);
    expect(line.taxAmount).toBe(100n);
    expect(line.grossAmount).toBe(1_100n);
  });

  it('rejects a line discount larger than the line value', () => {
    expect(() => computeLineAmounts({ quantity: '1', unitPrice: 100n, lineDiscount: 101n })).toThrow();
  });

  it('rejects an invalid quantity string', () => {
    expect(() => computeLineAmounts({ quantity: 'abc', unitPrice: 100n })).toThrow();
  });
});

describe('invoice header totals', () => {
  const lines = [
    { quantity: '2', unitPrice: 100_000n, taxRate: '0.10' },
    { quantity: '1', unitPrice: 250_000n, taxRate: '0.10' },
    { quantity: '3', unitPrice: 33_333n, taxRate: '0.10' },
  ];

  it('sums stored line amounts and never adds tax twice', () => {
    const totals = computeInvoiceTotals(lines);
    expect(totals.subtotal).toBe(200_000n + 250_000n + 99_999n);
    expect(totals.taxTotal).toBe(
      computeLineAmounts(lines[0]!).taxAmount +
        computeLineAmounts(lines[1]!).taxAmount +
        computeLineAmounts(lines[2]!).taxAmount,
    );
    expect(totals.grandTotal).toBe(totals.subtotal + totals.taxTotal);
  });

  it('distributes a header discount by largest remainder, summing exactly', () => {
    const nets = [100n, 100n, 100n];
    const shares = allocateHeaderDiscount(nets, 90n);
    expect(shares.reduce((total, value) => total + value, 0n)).toBe(90n);
    expect(shares).toEqual([30n, 30n, 30n]);
  });

  it('allocates a seven-line remainder without losing a rial', () => {
    const nets = [10n, 10n, 10n, 10n, 10n, 10n, 30n];
    const shares = allocateHeaderDiscount(nets, 90n);
    expect(shares.reduce((total, value) => total + value, 0n)).toBe(90n);
  });

  it('rounds the payable to the document step and reports the residual', () => {
    const totals = computeInvoiceTotals([{ quantity: '1', unitPrice: 1_234n }], { roundTo: 1_000n });
    expect(totals.grandTotal).toBe(1_000n);
    expect(totals.roundingAdjustment).toBe(-234n);
  });

  it('rejects a header discount above the subtotal', () => {
    expect(() =>
      computeInvoiceTotals([{ quantity: '1', unitPrice: 100n }], { headerDiscount: 101n }),
    ).toThrow();
  });
});
