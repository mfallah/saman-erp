/**
 * Sales engine tests: state machine + money arithmetic (`API.md` §4.7, `ADR-0013`).
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '@saman/shared';

import {
  amendLine,
  assertRefundWithinPaid,
  assertTransition,
  canTransition,
  computeLine,
  computeOrderTotals,
  computeReturnLineCredit,
  holdsReservation,
  isEditable,
  nextStatuses,
} from '../engines/order.engine';

describe('sales order state machine', () => {
  it('allows the documented happy path only', () => {
    expect(canTransition('draft', 'submitted')).toBe(true);
    expect(canTransition('submitted', 'confirmed')).toBe(true);
    expect(canTransition('confirmed', 'allocated')).toBe(true);
    expect(canTransition('allocated', 'picking')).toBe(true);
    expect(canTransition('picking', 'packed')).toBe(true);
    expect(canTransition('packed', 'shipped')).toBe(true);
    expect(canTransition('shipped', 'delivered')).toBe(true);
    expect(canTransition('delivered', 'closed')).toBe(true);
  });

  it('rejects illegal jumps and edits after confirmation', () => {
    expect(() => assertTransition('draft', 'shipped', 'ship')).toThrow(AppError);
    expect(() => assertTransition('closed', 'allocated', 'allocate')).toThrow(AppError);
    expect(isEditable('draft')).toBe(true);
    expect(isEditable('confirmed')).toBe(false);
    expect(holdsReservation('allocated')).toBe(true);
    expect(holdsReservation('shipped')).toBe(false);
  });

  it('exposes next statuses and the cancel/hold branches', () => {
    expect(nextStatuses('draft')).toContain('cancelled');
    expect(canTransition('confirmed', 'on_hold')).toBe(true);
    expect(canTransition('on_hold', 'allocated')).toBe(true);
  });
});

describe('order line & header arithmetic', () => {
  it('computes net/tax/gross per line', () => {
    const line = computeLine({ quantity: '3', unitPriceAmount: 1_000_000n, discountAmount: 500_000n, taxPercent: '0.09' });
    expect(line.netAmount).toBe(2_500_000n);
    expect(line.taxAmount).toBe(225_000n);
    expect(line.grossAmount).toBe(2_725_000n);
  });

  it('rejects a discount larger than the line value', () => {
    expect(() => computeLine({ quantity: '1', unitPriceAmount: 100n, discountAmount: 200n })).toThrow(AppError);
  });

  it('keeps the header total identity: grand = subtotal − discount + tax + shipping', () => {
    const totals = computeOrderTotals({
      lines: [
        { quantity: '2', unitPriceAmount: 1_000_000n, taxPercent: '0.09' },
        { quantity: '1', unitPriceAmount: 500_000n, taxPercent: '0.09' },
      ],
      headerDiscountAmount: 100_000n,
      shippingAmount: 50_000n,
    });
    expect(totals.subtotalAmount).toBe(2_500_000n);
    expect(totals.taxAmount).toBe(225_000n);
    expect(totals.discountAmount).toBe(100_000n);
    expect(totals.grandTotalAmount).toBe(2_500_000n - 100_000n + 225_000n + 50_000n);
  });

  it('distributes a header discount by largest remainder without losing rials', () => {
    const totals = computeOrderTotals({
      lines: [
        { quantity: '1', unitPriceAmount: 100n },
        { quantity: '1', unitPriceAmount: 100n },
        { quantity: '1', unitPriceAmount: 100n },
      ],
      headerDiscountAmount: 100n,
    });
    const allocated = totals.lines.reduce((total, line) => total + line.allocatedHeaderDiscountAmount, 0n);
    expect(allocated).toBe(100n);
  });

  it('amends a draft line and recomputes', () => {
    const original = {
      lines: [{ quantity: '1', unitPriceAmount: 1_000n }],
      shippingAmount: 0n,
    };
    const amended = amendLine(original, 0, { quantity: '2' });
    expect(amended.grandTotalAmount).toBe(2_000n);
  });
});

describe('returns & refunds', () => {
  it('computes the VAT credit note proportionally', () => {
    const credit = computeReturnLineCredit({
      originalNetAmount: 1_000_000n,
      originalQuantity: '4',
      returnedQuantity: '1',
      taxPercent: '0.09',
    });
    expect(credit.netAmount).toBe(250_000n);
    expect(credit.taxAmount).toBe(22_500n);
    expect(credit.grossAmount).toBe(272_500n);
  });

  it('rejects returning more than the original quantity', () => {
    expect(() =>
      computeReturnLineCredit({ originalNetAmount: 100n, originalQuantity: '1', returnedQuantity: '2', taxPercent: '0.09' }),
    ).toThrow(AppError);
  });

  it('caps refunds at the paid amount', () => {
    expect(() => assertRefundWithinPaid(1_000_000n, 5_000_000n, 0n)).not.toThrow();
    expect(() => assertRefundWithinPaid(5_000_000n, 1_000_000n, 0n)).toThrow(AppError);
    expect(() => assertRefundWithinPaid(0n, 1_000_000n, 0n)).toThrow(AppError);
  });
});
