/**
 * Event → posting rule dispatch (`DATA-MODEL §6.10.2`, 49 events).
 *
 * The dispatcher is pure and synchronous: tests call it directly per event. The
 * persistence layer (`posting.service.ts`) resolves account ids, allocates the
 * journal number, updates balances and emits the outbox event in one transaction.
 */
import { AppError } from '@saman/shared';
import { isAccountingEvent } from '../events';
import { salesCashSale, salesDiscountApplied, salesInvoiceIssued, salesPaymentReceived, salesRefundPaid, salesReturnReceived, shippingRecharged } from './sales.rules';
import { purchaseInvoiceReceived, purchaseInvoiceVariance, purchasePaymentPaid, purchasePrepaymentPaid, purchaseReceiptPosted, purchaseReturnIssued } from './purchase.rules';
import { channelFeeAccrued, settlementConfirmed, settlementVarianceRecorded } from './channel.rules';
import { inventoryAdjustmentPosted, inventoryIssuePosted, inventoryTransferDispatched, inventoryTransferReceived, inventoryValuationPosted } from './inventory.rules';
import { cashReceiptRecorded, cashSessionClosed, chequeBounced, chequeCleared, chequeDeposited, chequeEndorsed, chequeIssued, chequeReceived, dividendPaid, paymentAdvanceReceived, paymentAllocated, taxVatPayment, taxVatRefund } from './treasury.rules';
import { badDebtAllowance, badDebtWriteoff, expensePaid, expenseRecognised, fxRevaluation, shippingCostIncurred } from './expense.rules';
import { closingIncomeSummary, closingRetainedEarnings, openingBalancesImported, profitDistributionApproved } from './closing.rules';
import { optionalText } from './types';
import type { AccountingEventType, EventPayload, PostingContext } from '../events';
import type { PostingDraft } from './types';

export type PostingBuilder = (payload: EventPayload, ctx: PostingContext) => PostingDraft;

const BUILDERS: Readonly<Record<AccountingEventType, PostingBuilder>> = {
  'sales.invoice.issued': salesInvoiceIssued,
  'inventory.issue.posted': inventoryIssuePosted,
  'sales.cash_sale': salesCashSale,
  'sales.discount.applied': salesDiscountApplied,
  'sales.payment.received': salesPaymentReceived,
  'sales.return.received': salesReturnReceived,
  'sales.refund.paid': salesRefundPaid,
  'purchase.receipt.posted': purchaseReceiptPosted,
  'purchase.invoice.received': purchaseInvoiceReceived,
  'purchase.invoice.variance': purchaseInvoiceVariance,
  'purchase.return.issued': purchaseReturnIssued,
  'purchase.payment.paid': purchasePaymentPaid,
  'purchase.prepayment.paid': purchasePrepaymentPaid,
  'channel.fee.accrued': channelFeeAccrued,
  'settlement.confirmed': settlementConfirmed,
  'settlement.variance.recorded': settlementVarianceRecorded,
  'shipping.cost.incurred': shippingCostIncurred,
  'shipping.recharged': shippingRecharged,
  'inventory.adjustment.posted': inventoryAdjustmentPosted,
  'inventory.transfer.dispatched': inventoryTransferDispatched,
  'inventory.transfer.received': inventoryTransferReceived,
  'inventory.valuation.posted': inventoryValuationPosted,
  'cash.receipt.recorded': cashReceiptRecorded,
  'cash.session.closed': cashSessionClosed,
  'cheque.received': chequeReceived,
  'cheque.deposited': chequeDeposited,
  'cheque.cleared': chequeCleared,
  'cheque.bounced': chequeBounced,
  'cheque.endorsed': chequeEndorsed,
  'cheque.issued': chequeIssued,
  'cheque.issued.cleared': (payload, ctx) =>
    chequeCleared({ ...payload, direction: 'issued' }, ctx),
  'payment.advance.received': paymentAdvanceReceived,
  'payment.allocated': paymentAllocated,
  'profit.distribution.approved': profitDistributionApproved,
  'dividend.paid': dividendPaid,
  'tax.vat.payment': taxVatPayment,
  'tax.vat.refund': taxVatRefund,
  'expense.recognised': expenseRecognised,
  'expense.paid': expensePaid,
  'bad_debt.allowance': badDebtAllowance,
  'bad_debt.writeoff': badDebtWriteoff,
  'closing.income_summary': closingIncomeSummary,
  'closing.retained_earnings': closingRetainedEarnings,
  'opening.balances.imported': openingBalancesImported,
  'fx.revaluation': fxRevaluation,
};

/**
 * Builds the posting draft for an event. The draft `eventType` always equals the
 * dispatched event, even when a builder shares logic across directions (e.g.
 * `cheque.cleared` for an issued cheque).
 */
export function buildPostingDraft(
  eventType: string,
  payload: EventPayload,
  ctx: PostingContext,
): PostingDraft {
  if (!isAccountingEvent(eventType)) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'eventType', rule: 'unknown_accounting_event', params: { eventType } }],
      message: 'نوع رویداد حسابداری پشتیبانی نمی‌شود.',
    });
  }
  const builder = BUILDERS[eventType];
  const draft = builder(payload, ctx);
  if (draft.eventType === eventType) return draft;
  return { ...draft, eventType };
}

/** Channel code helper shared by callers that embed it in the payload. */
export function channelCodeOf(payload: EventPayload, ctx: PostingContext): string | undefined {
  return ctx.channelCode ?? optionalText(payload, 'channelCode');
}

export { BUILDERS };
export * from './types';
export * from './accounts';
export * from './invoice-arithmetic';
export * from './closing.rules';
