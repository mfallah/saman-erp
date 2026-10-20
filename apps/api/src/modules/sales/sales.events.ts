/**
 * Sales domain + accounting events (`ARCHITECTURE.md` §7, `DATA-MODEL` §6.10.2).
 */
export const SALES_EVENTS = {
  customerCreated: 'sales.customer.created',
  customerUpdated: 'sales.customer.updated',
  customerDeleted: 'sales.customer.deleted',
  orderCreated: 'sales.order.created',
  orderSubmitted: 'sales.order.submitted',
  orderConfirmed: 'sales.order.confirmed',
  orderAllocated: 'sales.order.allocated',
  orderDeallocated: 'sales.order.deallocated',
  orderOnHold: 'sales.order.on_hold',
  orderReleased: 'sales.order.released',
  orderCancelled: 'sales.order.cancelled',
  orderPacked: 'sales.order.packed',
  orderShipped: 'sales.order.shipped',
  orderDelivered: 'sales.order.delivered',
  orderClosed: 'sales.order.closed',
  invoiceIssued: 'sales.invoice.issued',
  invoiceVoided: 'sales.invoice.voided',
  returnCreated: 'sales.return.created',
  returnReceived: 'sales.return.received',
  returnClosed: 'sales.return.closed',
  refundRequested: 'sales.refund.requested',
  refundApproved: 'sales.refund.approved',
  refundPaid: 'sales.refund.paid',
} as const;

export type SalesEventType = (typeof SALES_EVENTS)[keyof typeof SALES_EVENTS];

/** Accounting event names emitted by sales (must match `accounting/events.ts`). */
export const SALES_ACCOUNTING_EVENTS = {
  invoiceIssued: 'sales.invoice.issued',
  cashSale: 'sales.cash_sale',
  discountApplied: 'sales.discount.applied',
  paymentReceived: 'sales.payment.received',
  returnReceived: 'sales.return.received',
  refundPaid: 'sales.refund.paid',
  shippingRecharged: 'shipping.recharged',
} as const;

export interface OrderEventPayload {
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly status: string;
  readonly customerId: string;
  readonly channelCode: string | null;
  readonly grandTotalAmount: string;
  readonly currency: string;
}

export interface InvoicePayload {
  readonly invoiceId: string;
  readonly invoiceNo: string | null;
  readonly orderId: string | null;
  readonly customerId: string;
  readonly documentKind: string;
  readonly netAmount: string;
  readonly taxAmount: string;
  readonly grandTotalAmount: string;
  readonly issueDate: string;
  readonly originalInvoiceId: string | null;
}

export interface ReturnPayload {
  readonly returnId: string;
  readonly returnNo: string;
  readonly orderId: string;
  readonly status: string;
  readonly resolution: string;
  readonly lines: readonly { returnLineId: string; variantId: string; quantity: string; netAmount: string; taxAmount: string; grossAmount: string }[];
}

export interface RefundPayload {
  readonly refundId: string;
  readonly refundNo: string;
  readonly returnId: string | null;
  readonly customerId: string;
  readonly amount: string;
  readonly method: string;
  readonly status: string;
}
