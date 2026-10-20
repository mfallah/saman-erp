/**
 * Append-only inventory ledger rules (`ADR-0007` §1–§4).
 *
 * The ledger is the source of truth: one signed row per movement, never updated
 * except void metadata. This engine owns the invariants that must hold before a
 * row is written — the transaction type ⇄ sign matrix, the cost-bearing rule and
 * the balance projection deltas — so the repository can stay dumb SQL.
 */
import { AppError } from '@saman/shared';

import {
  absQuantity,
  addQuantity,
  compareQuantity,
  formatQuantity,
  isNegativeQuantity,
  isPositiveQuantity,
  parseQuantity,
  subQuantity,
} from './quantity.engine';

/** `inventory_transactions.transaction_type` vocabulary (`DATA-MODEL` §2.6). */
export const INVENTORY_TRANSACTION_TYPES = [
  'receipt',
  'sale_issue',
  'reservation_consume',
  'adjustment_in',
  'adjustment_out',
  'transfer_out',
  'transfer_in',
  'return_in',
  'damage_out',
  'scrap_out',
  'count_correction_in',
  'count_correction_out',
  'opening_balance',
] as const;
export type InventoryTransactionType = (typeof INVENTORY_TRANSACTION_TYPES)[number];

/** Positive (into location) vs negative (out of location) movements. */
export const INBOUND_TYPES: readonly InventoryTransactionType[] = [
  'receipt',
  'adjustment_in',
  'transfer_in',
  'return_in',
  'count_correction_in',
  'opening_balance',
];

export const OUTBOUND_TYPES: readonly InventoryTransactionType[] = [
  'sale_issue',
  'reservation_consume',
  'adjustment_out',
  'transfer_out',
  'damage_out',
  'scrap_out',
  'count_correction_out',
];

/** Types that MUST carry a valuation cost (`R1-A M-07`: zero-cost relief rejected). */
export const COST_BEARING_TYPES: readonly InventoryTransactionType[] = [
  'sale_issue',
  'adjustment_out',
  'transfer_out',
  'damage_out',
  'scrap_out',
  'count_correction_out',
  'adjustment_in',
  'transfer_in',
  'return_in',
  'count_correction_in',
  'receipt',
  'opening_balance',
];

/** Damaged stock is tracked separately, never silently mixed into on-hand. */
export const DAMAGE_TYPES: readonly InventoryTransactionType[] = ['damage_out', 'scrap_out'];

export function isInboundType(type: InventoryTransactionType): boolean {
  return INBOUND_TYPES.includes(type);
}

export function isOutboundType(type: InventoryTransactionType): boolean {
  return OUTBOUND_TYPES.includes(type);
}

export function isCostBearingType(type: InventoryTransactionType): boolean {
  return COST_BEARING_TYPES.includes(type);
}

/** Signed ledger quantity for a movement: inbound positive, outbound negative. */
export function signedQuantity(type: InventoryTransactionType, quantity: string): string {
  const magnitude = absQuantity(quantity);
  return isInboundType(type) ? magnitude : `-${magnitude.replace(/^-/, '')}`;
}

/**
 * Validates the type⇄sign direction matrix and the non-zero rule (no cost rules).
 * The balance projection uses this directly; the ledger write uses
 * `assertValidMovement` which additionally enforces costing.
 */
export function assertMovementDirection(type: InventoryTransactionType, quantity: string): string {
  if (parseQuantity(quantity) === 0n) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'quantity', rule: 'quantity_non_zero' }],
    });
  }
  if (isNegativeQuantity(quantity)) {
    throw new AppError('RULE_VIOLATION', {
      message: 'جهت حرکت انبار با نوع تراکنش سازگار نیست.',
      messageKey: 'inventory.movement_sign_invalid',
      details: [{ rule: 'movement_sign_invalid', params: { type } }],
    });
  }
  return signedQuantity(type, quantity);
}

/**
 * Validates a movement against the type⇄sign matrix (`R1-D M-11`) and the
 * non-zero quantity rule. Returns the canonical signed quantity.
 */
export function assertValidMovement(input: {
  type: InventoryTransactionType;
  quantity: string;
  unitCostAmount?: bigint | null;
}): string {
  const signed = assertMovementDirection(input.type, input.quantity);
  if (isCostBearingType(input.type)) {
    if (input.unitCostAmount === undefined || input.unitCostAmount === null) {
      throw new AppError('RULE_VIOLATION', {
        message: 'ثبت بهای تمام‌شده برای این نوع تراکنش الزامی است.',
        messageKey: 'inventory.cost_required',
        details: [{ rule: 'cost_required', params: { type: input.type } }],
      });
    }
    if (input.unitCostAmount < 0n) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'unitCostAmount', rule: 'cost_non_negative' }],
      });
    }
    if (isOutboundType(input.type) && input.unitCostAmount === 0n) {
      throw new AppError('RULE_VIOLATION', {
        message: 'خروج کالا با بهای صفر مجاز نیست.',
        messageKey: 'inventory.zero_cost_relief',
        details: [{ rule: 'zero_cost_relief', params: { type: input.type } }],
      });
    }
  }
  return signed;
}

/** `available = on_hand − reserved − safety_buffer − damaged` (`ADR-0007` §4). */
export interface BalanceState {
  readonly onHand: string;
  readonly reserved: string;
  readonly safetyBuffer: string;
  readonly damaged: string;
}

export function availableQuantity(balance: BalanceState): string {
  return subQuantity(
    subQuantity(subQuantity(balance.onHand, balance.reserved), balance.safetyBuffer),
    balance.damaged,
  );
}

/**
 * Asserts the availability invariant: `reserved + safety_buffer + damaged <= on_hand`
 * (the DB enforces it with a CHECK; this is the service-side failure with a
 * Persian message, `R1-A B-06`).
 */
export function assertAvailabilityInvariant(balance: BalanceState): void {
  if (isNegativeQuantity(availableQuantity(balance))) {
    throw new AppError('RULE_VIOLATION', {
      message: 'موجودی قابل‌استفاده منفی است؛ موجودی رزرو/بافر/آسیب‌دیده را بررسی کنید.',
      messageKey: 'inventory.negative_availability',
      details: [{ rule: 'negative_availability' }],
    });
  }
}

export interface BalanceDelta {
  readonly onHand: string;
  readonly reserved: string;
  readonly damaged: string;
  readonly inTransit: string;
}

/**
 * Applies a movement to the balance projection. Damage out reduces on-hand and
 * increases the damaged counter so the loss stays visible to valuation/claims.
 */
export function applyMovementToBalance(
  balance: BalanceState & { readonly inTransit: string; readonly damaged: string },
  input: { type: InventoryTransactionType; quantity: string },
): BalanceDelta {
  const signed = assertMovementDirection(input.type, input.quantity);
  const magnitude = absQuantity(signed);
  let onHand = addQuantity(balance.onHand, signed);
  let damaged = balance.damaged;
  const inTransit = balance.inTransit;
  if (DAMAGE_TYPES.includes(input.type)) {
    damaged = addQuantity(balance.damaged, magnitude);
  }
  // `transfer_out` parks the quantity in transit on the source balance; the
  // destination receive clears it (service-side, because the row lives on the
  // source location and is not the row being credited).
  if (input.type === 'transfer_out') {
    // handled by the service on the source balance after this projection update
  }
  if (compareQuantity(onHand, '0') < 0) {
    throw new AppError('INSUFFICIENT_STOCK', {
      message: 'موجودی انبار برای این حرکت کافی نیست.',
      details: [
        {
          rule: 'negative_stock',
          params: { onHand: balance.onHand, requested: magnitude },
        },
      ],
    });
  }
  const next: BalanceState & { inTransit: string; damaged: string } = {
    onHand: formatQuantity(parseQuantity(onHand)),
    reserved: balance.reserved,
    safetyBuffer: balance.safetyBuffer,
    damaged,
    inTransit,
  };
  assertAvailabilityInvariant(next);
  return { onHand: next.onHand, reserved: next.reserved, damaged: next.damaged, inTransit: next.inTransit };
}

/** Applies a reservation delta; rejects over-reservation before touching the DB. */
export function applyReservationDelta(balance: BalanceState, reservedDelta: string): string {
  const next = addQuantity(balance.reserved, reservedDelta);
  if (isNegativeQuantity(next)) {
    throw new AppError('RULE_VIOLATION', {
      message: 'آزادسازی رزرو بیشتر از مقدار رزروشده مجاز نیست.',
      messageKey: 'inventory.reservation_over_release',
      details: [{ rule: 'reservation_over_release' }],
    });
  }
  assertAvailabilityInvariant({ ...balance, reserved: next });
  return formatQuantity(parseQuantity(next));
}

/** Rule-violation helper for insufficient stock with per-line details. */
export function insufficientStock(
  failures: readonly { lineIndex: number; variantId: string; requested: string; available: string }[],
): AppError {
  return new AppError('INSUFFICIENT_STOCK', {
    message: 'موجودی کافی برای این اقلام وجود ندارد.',
    details: failures.map((failure) => ({
      field: `lines[${failure.lineIndex}].quantity`,
      rule: 'insufficient_stock',
      params: {
        variantId: failure.variantId,
        requested: failure.requested,
        available: failure.available,
      },
    })),
  });
}

/** Ledger row shape used by consistency/reconciliation helpers. */
export interface LedgerSumRow {
  readonly warehouseId: string;
  readonly locationId: string;
  readonly variantId: string;
  readonly quantitySum: string;
}

/** Nightly ledger-vs-balance reconciliation (`ADR-0007` consequences). */
export function reconcileLedgerAgainstBalances(
  ledger: readonly LedgerSumRow[],
  balances: readonly {
    warehouseId: string;
    locationId: string;
    variantId: string;
    onHand: string;
  }[],
): { warehouseId: string; locationId: string; variantId: string; expected: string; actual: string }[] {
  const actualByKey = new Map(
    balances.map((balance) => [
      `${balance.warehouseId}:${balance.locationId}:${balance.variantId}`,
      balance.onHand,
    ]),
  );
  const drifts: { warehouseId: string; locationId: string; variantId: string; expected: string; actual: string }[] = [];
  for (const row of ledger) {
    const key = `${row.warehouseId}:${row.locationId}:${row.variantId}`;
    const actual = actualByKey.get(key) ?? '0.0000';
    if (compareQuantity(row.quantitySum, actual) !== 0) {
      drifts.push({
        warehouseId: row.warehouseId,
        locationId: row.locationId,
        variantId: row.variantId,
        expected: row.quantitySum,
        actual,
      });
    }
  }
  return drifts;
}

/** True when the ledger quantity is within tolerance of the balance (batching). */
export function withinTolerance(left: string, right: string, tolerance: string): boolean {
  const difference = absQuantity(subQuantity(left, right));
  return compareQuantity(difference, tolerance) <= 0;
}

export function isDamageType(type: InventoryTransactionType): boolean {
  return DAMAGE_TYPES.includes(type);
}

export function isPositiveQuantityString(value: string): boolean {
  return isPositiveQuantity(value);
}
