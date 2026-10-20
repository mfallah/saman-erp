/** Payment allocation caps: Σ allocations ≤ amount, unapplied invariant (B-14). */
import { describe, expect, it } from 'vitest';
import {
  allocatedTotal,
  applyAllocations,
  assertAllocationsWithinPayment,
  unappliedAmount,
} from '../payments/allocation';

const state = (amount: bigint, allocations: { documentType: string; documentId: bigint; amount: bigint }[] = []) => ({
  paymentAmount: amount,
  allocations,
});

describe('payment allocation caps', () => {
  it('tracks the allocated total and the unapplied remainder', () => {
    const payment = state(500_000n, [
      { documentType: 'customer_invoice', documentId: 1n, amount: 300_000n },
    ]);
    expect(allocatedTotal(payment)).toBe(300_000n);
    expect(unappliedAmount(payment)).toBe(200_000n);
  });

  it('accepts an allocation equal to the remaining amount', () => {
    expect(() =>
      assertAllocationsWithinPayment(state(100n), [
        { documentType: 'customer_invoice', documentId: 1n, amount: 100n },
      ]),
    ).not.toThrow();
  });

  it('rejects an allocation that exceeds the payment', () => {
    expect(() =>
      assertAllocationsWithinPayment(state(100n, [{ documentType: 'customer_invoice', documentId: 1n, amount: 90n }]), [
        { documentType: 'customer_invoice', documentId: 2n, amount: 20n },
      ]),
    ).toThrow();
  });

  it('rejects a duplicate allocation to the same document', () => {
    expect(() =>
      assertAllocationsWithinPayment(state(100n, [{ documentType: 'customer_invoice', documentId: 1n, amount: 10n }]), [
        { documentType: 'customer_invoice', documentId: 1n, amount: 10n },
      ]),
    ).toThrow();
  });

  it('rejects non-positive amounts and unknown document types', () => {
    expect(() =>
      assertAllocationsWithinPayment(state(100n), [
        { documentType: 'customer_invoice', documentId: 1n, amount: 0n },
      ]),
    ).toThrow();
    expect(() =>
      assertAllocationsWithinPayment(state(100n), [
        { documentType: 'unknown_doc' as unknown as 'customer_invoice', documentId: 1n, amount: 10n },
      ]),
    ).toThrow();
  });

  it('supports advances allocated across orders, invoices and prepayments', () => {
    const payment = state(1_000_000n);
    const applied = applyAllocations(payment, [
      { documentType: 'sales_order', documentId: 10n, amount: 400_000n },
      { documentType: 'customer_invoice', documentId: 11n, amount: 350_000n },
      { documentType: 'customer_credit', documentId: 12n, amount: 150_000n },
    ]);
    expect(applied.unapplied).toBe(100_000n);
    expect(applied.allocations).toHaveLength(3);
  });

  it('keeps allocated + unapplied = amount after every allocation', () => {
    const payment = state(250_000n, [{ documentType: 'supplier_invoice', documentId: 1n, amount: 100_000n }]);
    const result = applyAllocations(payment, [
      { documentType: 'supplier_prepayment', documentId: 2n, amount: 50_000n },
    ]);
    expect(allocatedTotal({ ...payment, allocations: [...payment.allocations, ...result.allocations] }) + result.unapplied).toBe(250_000n);
  });
});
