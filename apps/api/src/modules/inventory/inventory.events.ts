/**
 * Inventory domain events (`ARCHITECTURE.md` §7, outbox) and the accounting
 * event names emitted in the same transaction (`DATA-MODEL` §6.10.2).
 *
 * Money is transported as integer strings (`ADR-0013`); quantities as
 * `numeric(18,4)` strings. Accounting consumes the event rows and posts journals.
 */
export const INVENTORY_EVENTS = {
  receiptPosted: 'inventory.receipt.posted',
  issuePosted: 'inventory.issue.posted',
  adjustmentPosted: 'inventory.adjustment.posted',
  transferDispatched: 'inventory.transfer.dispatched',
  transferReceived: 'inventory.transfer.received',
  valuationPosted: 'inventory.valuation.posted',
  reservationCreated: 'inventory.reservation.created',
  reservationConsumed: 'inventory.reservation.consumed',
  reservationReleased: 'inventory.reservation.released',
  reservationExpired: 'inventory.reservation.expired',
  countPosted: 'inventory.count.posted',
  integrityDriftDetected: 'inventory.integrity.drift_detected',
} as const;

export type InventoryEventType = (typeof INVENTORY_EVENTS)[keyof typeof INVENTORY_EVENTS];

/** Accounting event names this module emits (must match `accounting/events.ts`). */
export const INVENTORY_ACCOUNTING_EVENTS = {
  issuePosted: 'inventory.issue.posted',
  adjustmentPosted: 'inventory.adjustment.posted',
  transferDispatched: 'inventory.transfer.dispatched',
  transferReceived: 'inventory.transfer.received',
  valuationPosted: 'inventory.valuation.posted',
} as const;

export interface LedgerMovementPayload {
  readonly transactionId: string;
  readonly transactionType: string;
  readonly warehouseId: string;
  readonly locationId: string;
  readonly variantId: string;
  /** Signed `numeric(18,4)` string. */
  readonly quantity: string;
  /** Integer IRR string per unit. */
  readonly unitCostAmount: string;
  /** Integer IRR string line total. */
  readonly totalCostAmount: string;
  readonly businessDate: string;
  readonly referenceType: string;
  readonly referenceId: string | null;
  readonly lotId: string | null;
  readonly journalEntryId: string | null;
}

export interface ReservationPayload {
  readonly reservationId: string;
  readonly reservationNo: string;
  readonly referenceType: string;
  readonly referenceId: string;
  readonly warehouseId: string;
  readonly locationId: string;
  readonly variantId: string;
  readonly quantity: string;
  readonly status: string;
  readonly expiresAt: string | null;
}

export interface AdjustmentPayload {
  readonly adjustmentId: string;
  readonly adjustmentNo: string;
  readonly warehouseId: string;
  readonly reasonCode: string;
  readonly status: string;
  readonly ledgerIds: readonly string[];
}

export interface TransferPayload {
  readonly transferId: string;
  readonly transferNo: string;
  readonly fromWarehouseId: string;
  readonly toWarehouseId: string;
  readonly status: string;
  readonly ledgerIds: readonly string[];
}

export interface ValuationPayload {
  readonly runId: string;
  readonly warehouseId: string | null;
  readonly valuationDate: string;
  readonly valuationMethod: string;
  readonly totalQuantity: string;
  readonly totalValueAmount: string;
  readonly glInventoryAmount: string;
  readonly costLayerCount: number;
  readonly status: string;
}

export interface CountPayload {
  readonly countId: string;
  readonly countNo: string;
  readonly warehouseId: string;
  readonly status: string;
  readonly adjustmentId: string | null;
  readonly varianceLines: number;
}
