/**
 * Sales order state machine and line arithmetic (`API.md` §4.7, `DATA-MODEL` §2.9).
 *
 * Canonical order statuses: `draft → submitted → confirmed → allocated → picking
 * → packed → shipped → delivered → closed`, with `cancelled` and `on_hold`
 * branches. Money is `bigint` IRR; quantities are `numeric(18,4)` decimal
 * strings; every amount is computed once and stored (`R1-A B-12`).
 *
 * This module is pure so the FSM and the arithmetic are unit-tested without a
 * database (the sales test matrix).
 */
import { AppError, applyRate, multiplyByQuantity, roundHalfUp, splitProportionally } from '@saman/shared';

import { compareQuantity, parseQuantity } from '../../inventory/engines/quantity.engine';

export const SALES_ORDER_STATUSES = [
  'draft',
  'submitted',
  'confirmed',
  'allocated',
  'picking',
  'packed',
  'shipped',
  'delivered',
  'closed',
  'cancelled',
  'on_hold',
] as const;
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number];

/** Statuses that block inventory/fulfillment actions. */
export const TERMINAL_ORDER_STATUSES: readonly SalesOrderStatus[] = ['closed', 'cancelled'];

/** Allowed transitions. `on_hold` is reachable from any pre-shipment state. */
const TRANSITIONS: Readonly<Record<SalesOrderStatus, readonly SalesOrderStatus[]>> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['confirmed', 'cancelled', 'on_hold'],
  confirmed: ['allocated', 'on_hold', 'cancelled'],
  allocated: ['picking', 'confirmed', 'on_hold', 'cancelled'],
  picking: ['packed', 'allocated', 'cancelled'],
  packed: ['shipped', 'picking', 'cancelled'],
  shipped: ['delivered'],
  delivered: ['closed'],
  closed: [],
  cancelled: [],
  on_hold: ['submitted', 'confirmed', 'allocated', 'picking', 'cancelled'],
};

export function isTerminalStatus(status: SalesOrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

export function canTransition(from: SalesOrderStatus, to: SalesOrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function nextStatuses(from: SalesOrderStatus): readonly SalesOrderStatus[] {
  return TRANSITIONS[from];
}

/** Orders may only be edited while still draft/submitted. */
export function isEditable(status: SalesOrderStatus): boolean {
  return status === 'draft' || status === 'submitted';
}

/** Reservations must exist from confirmation until shipment (or cancellation). */
export function holdsReservation(status: SalesOrderStatus): boolean {
  return ['confirmed', 'allocated', 'picking', 'packed', 'on_hold'].includes(status);
}

export function assertTransition(
  from: string,
  to: SalesOrderStatus,
  action: string,
): void {
  if (!SALES_ORDER_STATUSES.includes(from as SalesOrderStatus)) {
    throw new AppError('DOCUMENT_STATE_INVALID', {
      details: [{ rule: 'unknown_status', params: { status: from } }],
    });
  }
  if (!canTransition(from as SalesOrderStatus, to)) {
    throw new AppError('DOCUMENT_STATE_INVALID', {
      message: 'وضعیت فعلی سفارش اجازهٔ این تغییر را نمی‌دهد.',
      messageKey: 'sales.invalid_transition',
      details: [{ rule: 'invalid_transition', params: { from, to, action } }],
    });
  }
}

/** Action → target status table used by the controller service actions. */
export const ORDER_ACTIONS: Readonly<Record<string, SalesOrderStatus>> = {
  submit: 'submitted',
  confirm: 'confirmed',
  allocate: 'allocated',
  start_picking: 'picking',
  pack: 'packed',
  ship: 'shipped',
  deliver: 'delivered',
  close: 'closed',
  cancel: 'cancelled',
  hold: 'on_hold',
  release: 'confirmed',
};

// ------------------------------------------------------------- line arithmetic

export interface OrderLineInput {
  readonly quantity: string;
  /** Integer IRR unit price. */
  readonly unitPriceAmount: bigint;
  /** Integer IRR line discount (already validated ≤ net). */
  readonly discountAmount?: bigint | undefined;
  /** Fraction string (`numeric(9,6)`), e.g. `"0.09"` for 9% VAT. */
  readonly taxPercent?: string | undefined;
}

export interface ComputedLine {
  readonly quantity: string;
  readonly unitPriceAmount: bigint;
  readonly discountAmount: bigint;
  readonly netAmount: bigint;
  readonly taxPercent: string;
  readonly taxAmount: bigint;
  readonly grossAmount: bigint;
  /** Header-level discount share, filled by `computeOrderTotals` (largest remainder). */
  readonly allocatedHeaderDiscountAmount: bigint;
}

/**
 * Computes one line: `net = ROUND_HALF_UP(qty × unitPrice) − discount`,
 * `tax = ROUND_HALF_UP(net × taxPercent)`, `gross = net + tax`.
 * Discount above the line value is rejected (no negative net, `ck_..._net`).
 */
export function computeLine(input: OrderLineInput): ComputedLine {
  if (compareQuantity(input.quantity, '0') <= 0) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'quantity', rule: 'quantity_positive' }],
    });
  }
  const base = multiplyByQuantity(input.unitPriceAmount, input.quantity);
  const discount = input.discountAmount ?? 0n;
  if (discount < 0n) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'discountAmount', rule: 'discount_non_negative' }],
    });
  }
  if (discount > base) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'discountAmount', rule: 'discount_exceeds_line' }],
    });
  }
  const net = base - discount;
  const taxPercent = input.taxPercent ?? '0';
  const tax = applyRate(net, taxPercent);
  return {
    quantity: input.quantity,
    unitPriceAmount: input.unitPriceAmount,
    discountAmount: discount,
    netAmount: net,
    taxPercent,
    taxAmount: tax,
    grossAmount: net + tax,
    allocatedHeaderDiscountAmount: 0n,
  };
}

export interface OrderTotalsInput {
  readonly lines: readonly OrderLineInput[];
  /** Order-level discount, distributed over lines by largest remainder. */
  readonly headerDiscountAmount?: bigint | undefined;
  readonly shippingAmount?: bigint | undefined;
}

export interface ComputedOrder {
  readonly lines: readonly ComputedLine[];
  readonly subtotalAmount: bigint;
  readonly discountAmount: bigint;
  readonly taxAmount: bigint;
  readonly shippingAmount: bigint;
  readonly grandTotalAmount: bigint;
  readonly roundingAmount: bigint;
}

/**
 * Header totals: `subtotal = Σ net`, `tax = Σ tax`,
 * `grand = subtotal − discount + tax + shipping` (the DB CHECK mirrors this).
 * A header discount is distributed with the largest-remainder method and the
 * residual (≤ line count rials) goes to the rounding account (`5-2-14-001`).
 */
export function computeOrderTotals(input: OrderTotalsInput): ComputedOrder {
  if (input.lines.length === 0) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'lines', rule: 'order_requires_lines' }],
    });
  }
  const computed = input.lines.map((line) => computeLine(line));
  const subtotal = computed.reduce((total, line) => total + line.netAmount, 0n);
  const taxTotal = computed.reduce((total, line) => total + line.taxAmount, 0n);
  const headerDiscount = input.headerDiscountAmount ?? 0n;
  if (headerDiscount < 0n || headerDiscount > subtotal) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'discountAmount', rule: 'header_discount_invalid' }],
    });
  }
  let allocated: bigint[] = computed.map(() => 0n);
  let rounding = 0n;
  if (headerDiscount > 0n) {
    allocated = splitProportionally(
      headerDiscount,
      computed.map((line) => line.netAmount),
    );
    const distributed = allocated.reduce((total, value) => total + value, 0n);
    rounding = headerDiscount - distributed;
  }
  const lines = computed.map((line, index) => ({
    ...line,
    allocatedHeaderDiscountAmount: allocated[index] ?? 0n,
  }));
  const shipping = input.shippingAmount ?? 0n;
  const grandTotal = subtotal - headerDiscount + taxTotal + shipping;
  return {
    lines,
    subtotalAmount: subtotal,
    discountAmount: headerDiscount,
    taxAmount: taxTotal,
    shippingAmount: shipping,
    grandTotalAmount: grandTotal,
    roundingAmount: rounding,
  };
}

/** Amends a line quantity/price on a draft order and recomputes the totals. */
export function amendLine(
  input: OrderTotalsInput,
  lineIndex: number,
  patch: Partial<OrderLineInput>,
): ComputedOrder {
  const lines = input.lines.map((line, index) => (index === lineIndex ? { ...line, ...patch } : line));
  return computeOrderTotals({ ...input, lines });
}

/**
 * Credit note amounts for a return line derived from the original invoice line
 * (`R1-A B-11`): VAT is reversed proportionally to the returned quantity.
 */
export function computeReturnLineCredit(input: {
  originalNetAmount: bigint;
  originalQuantity: string;
  returnedQuantity: string;
  taxPercent: string;
}): { netAmount: bigint; taxAmount: bigint; grossAmount: bigint } {
  if (compareQuantity(input.returnedQuantity, input.originalQuantity) > 0) {
    throw new AppError('RULE_VIOLATION', {
      message: 'مقدار مرجوعی بیش از مقدار فاکتور اصلی است.',
      messageKey: 'sales.return_quantity_exceeded',
      details: [{ rule: 'return_quantity_exceeded' }],
    });
  }
  const quantity = parseQuantity(input.returnedQuantity);
  const original = parseQuantity(input.originalQuantity);
  const net = roundHalfUp(input.originalNetAmount * quantity, original);
  const tax = applyRate(net, input.taxPercent);
  return { netAmount: net, taxAmount: tax, grossAmount: net + tax };
}

/** Refund must not exceed the paid amount of the order (`refund_exceeds_paid`). */
export function assertRefundWithinPaid(refundAmount: bigint, paidAmount: bigint, alreadyRefunded: bigint): void {
  if (refundAmount <= 0n) {
    throw new AppError('VALIDATION_ERROR', { details: [{ field: 'amount', rule: 'amount_positive' }] });
  }
  if (refundAmount + alreadyRefunded > paidAmount) {
    throw new AppError('RULE_VIOLATION', {
      message: 'مبلغ بازگشتی از مبلغ پرداخت‌شدهٔ سفارش بیشتر است.',
      messageKey: 'sales.refund_exceeds_paid',
      details: [
        {
          rule: 'refund_exceeds_paid',
          params: { refundAmount: refundAmount.toString(), paidAmount: paidAmount.toString() },
        },
      ],
    });
  }
}
