/**
 * Accounting event vocabulary (`DATA-MODEL §6.10.2`, 49 rows) and the typed
 * payload contract consumed by the posting engine.
 *
 * Money is transported as integer strings inside outbox payloads and is parsed
 * to `bigint` at the posting boundary (`money` accessor). The event list is the
 * single source shared by the emitting modules (treasury/partners/sales) and the
 * posting engine, so a typo can never create an unposted event silently.
 */

export const ACCOUNTING_EVENTS = [
  'sales.invoice.issued',
  'inventory.issue.posted',
  'sales.cash_sale',
  'sales.discount.applied',
  'sales.payment.received',
  'sales.return.received',
  'sales.refund.paid',
  'purchase.receipt.posted',
  'purchase.invoice.received',
  'purchase.invoice.variance',
  'purchase.return.issued',
  'purchase.payment.paid',
  'purchase.prepayment.paid',
  'channel.fee.accrued',
  'settlement.confirmed',
  'settlement.variance.recorded',
  'shipping.cost.incurred',
  'shipping.recharged',
  'inventory.adjustment.posted',
  'inventory.transfer.dispatched',
  'inventory.transfer.received',
  'inventory.valuation.posted',
  'cash.receipt.recorded',
  'cash.session.closed',
  'cheque.received',
  'cheque.deposited',
  'cheque.cleared',
  'cheque.bounced',
  'cheque.endorsed',
  'cheque.issued',
  'cheque.issued.cleared',
  'payment.advance.received',
  'payment.allocated',
  'profit.distribution.approved',
  'dividend.paid',
  'tax.vat.payment',
  'tax.vat.refund',
  'expense.recognised',
  'expense.paid',
  'bad_debt.allowance',
  'bad_debt.writeoff',
  'closing.income_summary',
  'closing.retained_earnings',
  'opening.balances.imported',
  'fx.revaluation',
] as const;

export type AccountingEventType = (typeof ACCOUNTING_EVENTS)[number];

/** Raw outbox payload; every reader goes through the typed accessors below. */
export type EventPayload = Readonly<Record<string, unknown>>;

export interface PostingContext {
  /** Legal accounting date (ISO `YYYY-MM-DD`); drives period derivation. */
  readonly entryDate: string;
  /** Source document public id, for traceability. */
  readonly sourcePublicId?: string;
  /** Channel code used by account resolvers (`carexy|digikala|snapp|tapsi|pos`). */
  readonly channelCode?: string;
  /** Immutable posting-rule-set version applied to this entry. */
  readonly ruleSetId?: bigint;
}

export function isAccountingEvent(type: string): type is AccountingEventType {
  return (ACCOUNTING_EVENTS as readonly string[]).includes(type);
}
