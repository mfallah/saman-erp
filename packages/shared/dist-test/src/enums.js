"use strict";
/**
 * Lifecycle status vocabularies (`DATA-MODEL.md` §1.6 and per-table `CHECK` lists).
 *
 * Single source of truth for `varchar + CHECK` columns and API filters: seeds and
 * runtime writes must use these exact tokens. The database is authoritative for
 * enforcement; this module keeps TypeScript, Zod and seed code aligned with it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.STATUS_VOCABULARIES = exports.RECONCILIATION_STATUSES = exports.SETTLEMENT_STATUSES = exports.PRICE_RUN_STATUSES = exports.VALUATION_RUN_STATUSES = exports.EXPORT_JOB_STATUSES = exports.IMPORT_JOB_STATUSES = exports.OUTBOX_STATUSES = exports.APPROVAL_WORKFLOW_STATUSES = exports.APPROVAL_STATUSES = exports.CHEQUE_STATUSES = exports.TREASURY_PAYMENT_STATUSES = exports.REFUND_STATUSES = exports.CUSTOMER_RETURN_STATUSES = exports.CUSTOMER_INVOICE_STATUSES = exports.SUPPLIER_INVOICE_STATUSES = exports.GOODS_RECEIPT_STATUSES = exports.PURCHASE_ORDER_STATUSES = exports.STOCK_TRANSFER_STATUSES = exports.STOCK_COUNT_STATUSES = exports.STOCK_ADJUSTMENT_STATUSES = exports.RESERVATION_STATUSES = exports.ACCOUNTING_PERIOD_STATUSES = exports.FISCAL_YEAR_STATUSES = exports.JOURNAL_STATUSES = exports.JOURNAL_ENTRY_TYPES = exports.PACKAGE_STATUSES = exports.SHIPMENT_STATUSES = exports.PACKING_TASK_STATUSES = exports.PUTAWAY_STATUSES = exports.PICK_TASK_STATUSES = exports.PICK_WAVE_STATUSES = exports.JOB_STATUSES = exports.SYNC_STATUSES = exports.FULFILLMENT_STATUSES = exports.PAYMENT_STATUSES = exports.ORDER_STATUSES = exports.DOCUMENT_STATUSES = void 0;
exports.isInVocabulary = isInVocabulary;
/** `document_status`: draft → pending_approval → approved → posted → voided. */
exports.DOCUMENT_STATUSES = ['draft', 'pending_approval', 'approved', 'posted', 'voided'];
/** Sales/purchase order state machine. */
exports.ORDER_STATUSES = [
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
];
/** `payment_status` used on invoices/orders. */
exports.PAYMENT_STATUSES = ['unpaid', 'partially_paid', 'paid', 'refunded', 'overpaid'];
/** `fulfillment_status`: derived order fulfillment projection. */
exports.FULFILLMENT_STATUSES = [
    'unfulfilled',
    'allocated',
    'picking',
    'packed',
    'partially_shipped',
    'shipped',
    'delivered',
    'cancelled',
];
/** Channel sync state (`sync_status`). */
exports.SYNC_STATUSES = ['pending', 'syncing', 'synced', 'failed', 'skipped'];
/** Async job state (`job_status`). */
exports.JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'];
/** Pick wave status: planned → released → picking → picked → packed | cancelled. */
exports.PICK_WAVE_STATUSES = ['planned', 'released', 'picking', 'picked', 'packed', 'cancelled'];
/** Pick task status. */
exports.PICK_TASK_STATUSES = [
    'pending',
    'in_progress',
    'picked',
    'short',
    'exception',
    'cancelled',
];
/** Putaway task status. */
exports.PUTAWAY_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'];
/** Packing task status. */
exports.PACKING_TASK_STATUSES = ['pending', 'in_progress', 'packed', 'exception', 'cancelled'];
/** Shipment status. */
exports.SHIPMENT_STATUSES = [
    'pending',
    'label_ready',
    'picked_up',
    'in_transit',
    'out_for_delivery',
    'delivered',
    'failed',
    'returned',
    'cancelled',
];
/** Package (parcel) status. */
exports.PACKAGE_STATUSES = [
    'packed',
    'sealed',
    'label_printed',
    'handed_over',
    'delivered',
    'returned',
];
/** Journal entry type (`entry_type`). */
exports.JOURNAL_ENTRY_TYPES = ['normal', 'opening', 'adjustment', 'reversal', 'closing', 'auto'];
/** Journal entry status follows `document_status`. */
exports.JOURNAL_STATUSES = exports.DOCUMENT_STATUSES;
/** Fiscal year status. */
exports.FISCAL_YEAR_STATUSES = ['open', 'closing', 'closed'];
/** Accounting period status; `closed`/`locked` reject posting. */
exports.ACCOUNTING_PERIOD_STATUSES = ['open', 'closing', 'closed', 'locked'];
/** Inventory reservation status. */
exports.RESERVATION_STATUSES = ['active', 'consumed', 'released', 'expired'];
/** Stock adjustment status. */
exports.STOCK_ADJUSTMENT_STATUSES = [
    'draft',
    'pending_approval',
    'approved',
    'applied',
    'rejected',
    'voided',
];
/** Cycle/stock count status. */
exports.STOCK_COUNT_STATUSES = [
    'draft',
    'counting',
    'pending_approval',
    'approved',
    'applied',
    'cancelled',
];
/** Inter-warehouse transfer status. */
exports.STOCK_TRANSFER_STATUSES = [
    'draft',
    'pending_approval',
    'approved',
    'dispatched',
    'partially_received',
    'received',
    'cancelled',
];
/** Purchase order status. */
exports.PURCHASE_ORDER_STATUSES = [
    'draft',
    'pending_approval',
    'approved',
    'partially_received',
    'received',
    'closed',
    'cancelled',
];
/** Goods receipt status. */
exports.GOODS_RECEIPT_STATUSES = ['draft', 'pending_approval', 'posted', 'cancelled'];
/** Supplier invoice status. */
exports.SUPPLIER_INVOICE_STATUSES = [
    'draft',
    'open',
    'partially_paid',
    'paid',
    'voided',
    'disputed',
];
/** Customer invoice status. */
exports.CUSTOMER_INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'voided'];
/** Customer return (RMA) status. */
exports.CUSTOMER_RETURN_STATUSES = [
    'requested',
    'approved',
    'rejected',
    'received',
    'inspected',
    'completed',
    'cancelled',
];
/** Refund status. */
exports.REFUND_STATUSES = [
    'pending',
    'pending_approval',
    'approved',
    'paid',
    'rejected',
    'voided',
];
/** Treasury payment status. */
exports.TREASURY_PAYMENT_STATUSES = [
    'draft',
    'pending_approval',
    'approved',
    'posted',
    'cancelled',
];
/** Cheque status. */
exports.CHEQUE_STATUSES = [
    'received',
    'in_custody',
    'deposited',
    'cleared',
    'bounced',
    'endorsed',
    'returned',
    'cancelled',
];
/** Maker-checker approval request status. */
exports.APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'expired'];
/** Approval workflow definition status. */
exports.APPROVAL_WORKFLOW_STATUSES = ['draft', 'approved', 'active', 'closed'];
/** Transactional outbox event status. */
exports.OUTBOX_STATUSES = ['pending', 'processing', 'processed', 'failed'];
/** Bulk import job status. */
exports.IMPORT_JOB_STATUSES = [
    'queued',
    'validating',
    'importing',
    'completed',
    'failed',
    'cancelled',
];
/** Export/report job status. */
exports.EXPORT_JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'expired'];
/** Inventory valuation run status. */
exports.VALUATION_RUN_STATUSES = ['running', 'completed', 'failed', 'posted'];
/** Pricing calculation run status. */
exports.PRICE_RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled'];
/** Channel settlement status. */
exports.SETTLEMENT_STATUSES = [
    'received',
    'reconciling',
    'confirmed',
    'disputed',
    'paid',
    'closed',
];
/** Bank statement line match status. */
exports.RECONCILIATION_STATUSES = ['matched', 'unmatched', 'ignored'];
/** Every vocabulary exported by this module, keyed by its canonical name. */
exports.STATUS_VOCABULARIES = {
    document: exports.DOCUMENT_STATUSES,
    order: exports.ORDER_STATUSES,
    payment: exports.PAYMENT_STATUSES,
    fulfillment: exports.FULFILLMENT_STATUSES,
    sync: exports.SYNC_STATUSES,
    job: exports.JOB_STATUSES,
    pickWave: exports.PICK_WAVE_STATUSES,
    pickTask: exports.PICK_TASK_STATUSES,
    putaway: exports.PUTAWAY_STATUSES,
    packingTask: exports.PACKING_TASK_STATUSES,
    shipment: exports.SHIPMENT_STATUSES,
    package: exports.PACKAGE_STATUSES,
    journalEntryType: exports.JOURNAL_ENTRY_TYPES,
    journal: exports.JOURNAL_STATUSES,
    fiscalYear: exports.FISCAL_YEAR_STATUSES,
    accountingPeriod: exports.ACCOUNTING_PERIOD_STATUSES,
    reservation: exports.RESERVATION_STATUSES,
    stockAdjustment: exports.STOCK_ADJUSTMENT_STATUSES,
    stockCount: exports.STOCK_COUNT_STATUSES,
    stockTransfer: exports.STOCK_TRANSFER_STATUSES,
    purchaseOrder: exports.PURCHASE_ORDER_STATUSES,
    goodsReceipt: exports.GOODS_RECEIPT_STATUSES,
    supplierInvoice: exports.SUPPLIER_INVOICE_STATUSES,
    customerInvoice: exports.CUSTOMER_INVOICE_STATUSES,
    customerReturn: exports.CUSTOMER_RETURN_STATUSES,
    refund: exports.REFUND_STATUSES,
    treasuryPayment: exports.TREASURY_PAYMENT_STATUSES,
    cheque: exports.CHEQUE_STATUSES,
    approval: exports.APPROVAL_STATUSES,
    approvalWorkflow: exports.APPROVAL_WORKFLOW_STATUSES,
    outbox: exports.OUTBOX_STATUSES,
    importJob: exports.IMPORT_JOB_STATUSES,
    exportJob: exports.EXPORT_JOB_STATUSES,
    valuationRun: exports.VALUATION_RUN_STATUSES,
    priceRun: exports.PRICE_RUN_STATUSES,
    settlement: exports.SETTLEMENT_STATUSES,
    reconciliation: exports.RECONCILIATION_STATUSES,
};
/** Narrows a string to a vocabulary member at runtime. */
function isInVocabulary(vocabulary, value) {
    return vocabulary.includes(value);
}
