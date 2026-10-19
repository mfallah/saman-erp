/**
 * Lifecycle status vocabularies (`DATA-MODEL.md` §1.6 and per-table `CHECK` lists).
 *
 * Single source of truth for `varchar + CHECK` columns and API filters: seeds and
 * runtime writes must use these exact tokens. The database is authoritative for
 * enforcement; this module keeps TypeScript, Zod and seed code aligned with it.
 */

/** `document_status`: draft → pending_approval → approved → posted → voided. */
export const DOCUMENT_STATUSES = ['draft', 'pending_approval', 'approved', 'posted', 'voided'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Sales/purchase order state machine. */
export const ORDER_STATUSES = [
  'draft',
  'pending',
  'confirmed',
  'allocated',
  'picking',
  'packed',
  'shipped',
  'delivered',
  'completed',
  'cancelled',
  'returned',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** `payment_status` used on invoices/orders. */
export const PAYMENT_STATUSES = ['unpaid', 'partially_paid', 'paid', 'refunded', 'overpaid'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** `fulfillment_status`: derived order fulfillment projection. */
export const FULFILLMENT_STATUSES = [
  'unfulfilled',
  'allocated',
  'picking',
  'packed',
  'partially_shipped',
  'shipped',
  'delivered',
  'cancelled',
] as const;
export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

/** Channel sync state (`sync_status`). */
export const SYNC_STATUSES = ['pending', 'syncing', 'synced', 'failed', 'skipped'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** Async job state (`job_status`). */
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Pick wave status: planned → released → picking → picked → packed | cancelled. */
export const PICK_WAVE_STATUSES = ['planned', 'released', 'picking', 'picked', 'packed', 'cancelled'] as const;
export type PickWaveStatus = (typeof PICK_WAVE_STATUSES)[number];

/** Pick task status. */
export const PICK_TASK_STATUSES = [
  'pending',
  'in_progress',
  'picked',
  'short',
  'exception',
  'cancelled',
] as const;
export type PickTaskStatus = (typeof PICK_TASK_STATUSES)[number];

/** Putaway task status. */
export const PUTAWAY_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
export type PutawayStatus = (typeof PUTAWAY_STATUSES)[number];

/** Packing task status. */
export const PACKING_TASK_STATUSES = ['pending', 'in_progress', 'packed', 'exception', 'cancelled'] as const;
export type PackingTaskStatus = (typeof PACKING_TASK_STATUSES)[number];

/** Shipment status. */
export const SHIPMENT_STATUSES = [
  'pending',
  'label_ready',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'failed',
  'returned',
  'cancelled',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** Package (parcel) status. */
export const PACKAGE_STATUSES = [
  'packed',
  'sealed',
  'label_printed',
  'handed_over',
  'delivered',
  'returned',
] as const;
export type PackageStatus = (typeof PACKAGE_STATUSES)[number];

/** Journal entry type (`entry_type`). */
export const JOURNAL_ENTRY_TYPES = ['normal', 'opening', 'adjustment', 'reversal', 'closing', 'auto'] as const;
export type JournalEntryType = (typeof JOURNAL_ENTRY_TYPES)[number];

/** Journal entry status follows `document_status`. */
export const JOURNAL_STATUSES = DOCUMENT_STATUSES;
export type JournalStatus = DocumentStatus;

/** Fiscal year status. */
export const FISCAL_YEAR_STATUSES = ['open', 'closing', 'closed'] as const;
export type FiscalYearStatus = (typeof FISCAL_YEAR_STATUSES)[number];

/** Accounting period status; `closed`/`locked` reject posting. */
export const ACCOUNTING_PERIOD_STATUSES = ['open', 'closing', 'closed', 'locked'] as const;
export type AccountingPeriodStatus = (typeof ACCOUNTING_PERIOD_STATUSES)[number];

/** Inventory reservation status. */
export const RESERVATION_STATUSES = ['active', 'consumed', 'released', 'expired'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** Stock adjustment status. */
export const STOCK_ADJUSTMENT_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'applied',
  'rejected',
  'voided',
] as const;
export type StockAdjustmentStatus = (typeof STOCK_ADJUSTMENT_STATUSES)[number];

/** Cycle/stock count status. */
export const STOCK_COUNT_STATUSES = [
  'draft',
  'counting',
  'pending_approval',
  'approved',
  'applied',
  'cancelled',
] as const;
export type StockCountStatus = (typeof STOCK_COUNT_STATUSES)[number];

/** Inter-warehouse transfer status. */
export const STOCK_TRANSFER_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'dispatched',
  'partially_received',
  'received',
  'cancelled',
] as const;
export type StockTransferStatus = (typeof STOCK_TRANSFER_STATUSES)[number];

/** Purchase order status. */
export const PURCHASE_ORDER_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'partially_received',
  'received',
  'closed',
  'cancelled',
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

/** Goods receipt status. */
export const GOODS_RECEIPT_STATUSES = ['draft', 'pending_approval', 'posted', 'cancelled'] as const;
export type GoodsReceiptStatus = (typeof GOODS_RECEIPT_STATUSES)[number];

/** Supplier invoice status. */
export const SUPPLIER_INVOICE_STATUSES = [
  'draft',
  'open',
  'partially_paid',
  'paid',
  'voided',
  'disputed',
] as const;
export type SupplierInvoiceStatus = (typeof SUPPLIER_INVOICE_STATUSES)[number];

/** Customer invoice status. */
export const CUSTOMER_INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'voided'] as const;
export type CustomerInvoiceStatus = (typeof CUSTOMER_INVOICE_STATUSES)[number];

/** Customer return (RMA) status. */
export const CUSTOMER_RETURN_STATUSES = [
  'requested',
  'approved',
  'rejected',
  'received',
  'inspected',
  'completed',
  'cancelled',
] as const;
export type CustomerReturnStatus = (typeof CUSTOMER_RETURN_STATUSES)[number];

/** Refund status. */
export const REFUND_STATUSES = [
  'pending',
  'pending_approval',
  'approved',
  'paid',
  'rejected',
  'voided',
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** Treasury payment status. */
export const TREASURY_PAYMENT_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'posted',
  'cancelled',
] as const;
export type TreasuryPaymentStatus = (typeof TREASURY_PAYMENT_STATUSES)[number];

/** Cheque status. */
export const CHEQUE_STATUSES = [
  'received',
  'in_custody',
  'deposited',
  'cleared',
  'bounced',
  'endorsed',
  'returned',
  'cancelled',
] as const;
export type ChequeStatus = (typeof CHEQUE_STATUSES)[number];

/** Maker-checker approval request status. */
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'expired'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Approval workflow definition status. */
export const APPROVAL_WORKFLOW_STATUSES = ['draft', 'approved', 'active', 'closed'] as const;
export type ApprovalWorkflowStatus = (typeof APPROVAL_WORKFLOW_STATUSES)[number];

/** Transactional outbox event status. */
export const OUTBOX_STATUSES = ['pending', 'processing', 'processed', 'failed'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/** Bulk import job status. */
export const IMPORT_JOB_STATUSES = [
  'queued',
  'validating',
  'importing',
  'completed',
  'failed',
  'cancelled',
] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

/** Export/report job status. */
export const EXPORT_JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'expired'] as const;
export type ExportJobStatus = (typeof EXPORT_JOB_STATUSES)[number];

/** Inventory valuation run status. */
export const VALUATION_RUN_STATUSES = ['running', 'completed', 'failed', 'posted'] as const;
export type ValuationRunStatus = (typeof VALUATION_RUN_STATUSES)[number];

/** Pricing calculation run status. */
export const PRICE_RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;
export type PriceRunStatus = (typeof PRICE_RUN_STATUSES)[number];

/** Channel settlement status. */
export const SETTLEMENT_STATUSES = [
  'received',
  'reconciling',
  'confirmed',
  'disputed',
  'paid',
  'closed',
] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/** Bank statement line match status. */
export const RECONCILIATION_STATUSES = ['matched', 'unmatched', 'ignored'] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

/** Every vocabulary exported by this module, keyed by its canonical name. */
export const STATUS_VOCABULARIES = {
  document: DOCUMENT_STATUSES,
  order: ORDER_STATUSES,
  payment: PAYMENT_STATUSES,
  fulfillment: FULFILLMENT_STATUSES,
  sync: SYNC_STATUSES,
  job: JOB_STATUSES,
  pickWave: PICK_WAVE_STATUSES,
  pickTask: PICK_TASK_STATUSES,
  putaway: PUTAWAY_STATUSES,
  packingTask: PACKING_TASK_STATUSES,
  shipment: SHIPMENT_STATUSES,
  package: PACKAGE_STATUSES,
  journalEntryType: JOURNAL_ENTRY_TYPES,
  journal: JOURNAL_STATUSES,
  fiscalYear: FISCAL_YEAR_STATUSES,
  accountingPeriod: ACCOUNTING_PERIOD_STATUSES,
  reservation: RESERVATION_STATUSES,
  stockAdjustment: STOCK_ADJUSTMENT_STATUSES,
  stockCount: STOCK_COUNT_STATUSES,
  stockTransfer: STOCK_TRANSFER_STATUSES,
  purchaseOrder: PURCHASE_ORDER_STATUSES,
  goodsReceipt: GOODS_RECEIPT_STATUSES,
  supplierInvoice: SUPPLIER_INVOICE_STATUSES,
  customerInvoice: CUSTOMER_INVOICE_STATUSES,
  customerReturn: CUSTOMER_RETURN_STATUSES,
  refund: REFUND_STATUSES,
  treasuryPayment: TREASURY_PAYMENT_STATUSES,
  cheque: CHEQUE_STATUSES,
  approval: APPROVAL_STATUSES,
  approvalWorkflow: APPROVAL_WORKFLOW_STATUSES,
  outbox: OUTBOX_STATUSES,
  importJob: IMPORT_JOB_STATUSES,
  exportJob: EXPORT_JOB_STATUSES,
  valuationRun: VALUATION_RUN_STATUSES,
  priceRun: PRICE_RUN_STATUSES,
  settlement: SETTLEMENT_STATUSES,
  reconciliation: RECONCILIATION_STATUSES,
} as const;

/** Narrows a string to a vocabulary member at runtime. */
export function isInVocabulary<T extends readonly string[]>(
  vocabulary: T,
  value: string,
): value is T[number] {
  return (vocabulary as readonly string[]).includes(value);
}
