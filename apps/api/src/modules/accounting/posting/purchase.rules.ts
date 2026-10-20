/** Purchase posting rules — matrix rows #9–#14 (GRNI, 3-way match, variance). */
import { AppError } from '@saman/shared';
import { ACCOUNTS, methodAccount } from './accounts';
import {
  buildDraft,
  credit,
  debit,
  flag,
  leg,
  money,
  optionalId,
  optionalMoney,
  optionalText,
  withPartner,
} from './types';
import type { EventPayload, PostingContext } from '../events';
import type { PostingDraft, PostingLegDraft } from './types';

/**
 * #9 goods receipt without invoice: inventory (+ input VAT only when a tax
 * invoice exists at receipt) / **GRNI**. AP is never credited here.
 */
export function purchaseReceiptPosted(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const netLandedCost = money(payload, 'netLandedCostAmount');
  const inputVat = optionalMoney(payload, 'inputVatAmount');
  const hasTaxInvoice = flag(payload, 'taxInvoiceExists');
  const vat = hasTaxInvoice ? inputVat : 0n;
  const supplierId = optionalId(payload, 'supplierId');

  return buildDraft(
    {
      eventType: 'purchase.receipt.posted',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'رسید کالا و ثبت بدهی GRNI',
      sourceType: 'goods_receipt',
      ...(optionalId(payload, 'receiptId') === undefined ? {} : { sourceId: optionalId(payload, 'receiptId') }),
    },
    [
      debit(ACCOUNTS.inventory, netLandedCost, 'ورود موجودی به بهای تمام‌شده'),
      ...leg('debit', ACCOUNTS.vatReceivable, vat, 'مالیات بر ارزش افزوده دریافتنی'),
      withPartner(credit(ACCOUNTS.grni, netLandedCost + vat, 'کالای دریافت‌شده بدون فاکتور'), 'supplier', supplierId),
    ],
  );
}

/**
 * #10 supplier invoice after 3-way match:
 * Dr GRNI + Dr input VAT + Dr/Cr price variance / Cr AP.
 */
export function purchaseInvoiceReceived(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const grni = money(payload, 'grniAmount');
  const inputVat = optionalMoney(payload, 'inputVatAmount');
  const variance = optionalMoney(payload, 'priceVarianceAmount');
  const ap = money(payload, 'apAmount');
  const supplierId = optionalId(payload, 'supplierId');

  const expectedAp = grni + inputVat + variance;
  if (expectedAp !== ap) {
    throw new AppError('JOURNAL_UNBALANCED', {
      details: [
        {
          rule: 'supplier_invoice_ap_mismatch',
          params: { expected: expectedAp.toString(), actual: ap.toString() },
        },
      ],
      message: 'مبلغ فاکتور تأمین‌کننده با GRNI، مالیات و مغایرت قیمت برابر نیست.',
    });
  }

  return buildDraft(
    {
      eventType: 'purchase.invoice.received',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'ثبت فاکتور تأمین‌کننده و تسویه GRNI',
      sourceType: 'supplier_invoice',
      ...(optionalId(payload, 'supplierInvoiceId') === undefined
        ? {}
        : { sourceId: optionalId(payload, 'supplierInvoiceId') }),
    },
    [
      debit(ACCOUNTS.grni, grni, 'تسویه کالای دریافت‌شده بدون فاکتور'),
      ...leg('debit', ACCOUNTS.vatReceivable, inputVat, 'مالیات بر ارزش افزوده خرید'),
      ...leg('debit', ACCOUNTS.settlementVariance, variance > 0n ? variance : 0n, 'مغایرت نامساعد قیمت خرید'),
      ...leg('credit', ACCOUNTS.settlementVariance, variance < 0n ? -variance : 0n, 'مغایرت مساعد قیمت خرید'),
      withPartner(credit(ACCOUNTS.accountsPayable, ap, 'حساب پرداختنی تأمین‌کننده'), 'supplier', supplierId),
    ],
  );
}

/** #11 explicit variance settlement (unfavourable debit / favourable credit). */
export function purchaseInvoiceVariance(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const variance = money(payload, 'varianceAmount');
  if (variance === 0n) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'varianceAmount', rule: 'non_zero' }],
      message: 'مبلغ مغایرت باید غیرصفر باشد.',
    });
  }
  const supplierId = optionalId(payload, 'supplierId');
  const legs: PostingLegDraft[] =
    variance > 0n
      ? [
          debit(ACCOUNTS.settlementVariance, variance, 'مغایرت نامساعد'),
          withPartner(credit(ACCOUNTS.accountsPayable, variance, 'افزایش بدهی'), 'supplier', supplierId),
        ]
      : [
          withPartner(debit(ACCOUNTS.accountsPayable, -variance, 'کاهش بدهی'), 'supplier', supplierId),
          credit(ACCOUNTS.settlementVariance, -variance, 'مغایرت مساعد'),
        ];
  return buildDraft(
    {
      eventType: 'purchase.invoice.variance',
      entryType: 'adjustment',
      entryDate: ctx.entryDate,
      descriptionFa: 'ثبت مغایرت فاکتور خرید',
      sourceType: 'supplier_invoice',
      ...(optionalId(payload, 'supplierInvoiceId') === undefined
        ? {}
        : { sourceId: optionalId(payload, 'supplierInvoiceId') }),
    },
    legs,
  );
}

/** #12 purchase return / supplier credit note: AP / inventory + input VAT reversal. */
export function purchaseReturnIssued(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const ap = money(payload, 'apAmount');
  const inventory = money(payload, 'inventoryAmount');
  const vat = optionalMoney(payload, 'inputVatAmount');
  const variance = optionalMoney(payload, 'priceVarianceAmount');
  const supplierId = optionalId(payload, 'supplierId');

  if (inventory + vat + (variance > 0n ? variance : 0n) !== ap) {
    throw new AppError('JOURNAL_UNBALANCED', {
      details: [{ rule: 'purchase_return_mismatch', params: { ap: ap.toString() } }],
      message: 'مبلغ برگشت خرید با موجودی، مالیات و مغایرت برابر نیست.',
    });
  }

  return buildDraft(
    {
      eventType: 'purchase.return.issued',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'برگشت خرید به تأمین‌کننده',
      sourceType: 'purchase_return',
      ...(optionalId(payload, 'returnId') === undefined ? {} : { sourceId: optionalId(payload, 'returnId') }),
    },
    [
      withPartner(debit(ACCOUNTS.accountsPayable, ap, 'کاهش بدهی تأمین‌کننده'), 'supplier', supplierId),
      credit(ACCOUNTS.inventory, inventory, 'خروج موجودی برگشتی'),
      ...leg('credit', ACCOUNTS.vatReceivable, vat, 'برگشت مالیات خرید'),
      ...leg('credit', ACCOUNTS.settlementVariance, variance > 0n ? variance : 0n, 'برگشت مغایرت قیمت'),
      ...leg('debit', ACCOUNTS.settlementVariance, variance < 0n ? -variance : 0n, 'اصلاح مغایرت مساعد'),
    ],
  );
}

/** #13 supplier payment: AP / bank or gateway clearing. */
export function purchasePaymentPaid(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const supplierId = optionalId(payload, 'supplierId');
  const method = optionalText(payload, 'method') ?? 'bank';
  const account =
    optionalText(payload, 'bankAccountCode') ??
    optionalText(payload, 'cashAccountCode') ??
    methodAccount(method);
  return buildDraft(
    {
      eventType: 'purchase.payment.paid',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'پرداخت به تأمین‌کننده',
      sourceType: 'payment',
      ...(optionalId(payload, 'paymentId') === undefined ? {} : { sourceId: optionalId(payload, 'paymentId') }),
    },
    [
      withPartner(debit(ACCOUNTS.accountsPayable, amount, 'تسویه بدهی تأمین‌کننده'), 'supplier', supplierId),
      credit(account, amount, 'پرداخت وجه'),
    ],
  );
}

/** #14 supplier prepayment: prepayment asset / bank. */
export function purchasePrepaymentPaid(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const supplierId = optionalId(payload, 'supplierId');
  const account = optionalText(payload, 'bankAccountCode') ?? methodAccount(optionalText(payload, 'method') ?? 'bank');
  return buildDraft(
    {
      eventType: 'purchase.prepayment.paid',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'پیش‌پرداخت به تأمین‌کننده',
      sourceType: 'payment',
      ...(optionalId(payload, 'paymentId') === undefined ? {} : { sourceId: optionalId(payload, 'paymentId') }),
    },
    [
      withPartner(debit(ACCOUNTS.supplierPrepayment, amount, 'پیش‌پرداخت تأمین‌کننده'), 'supplier', supplierId),
      credit(account, amount, 'پرداخت وجه'),
    ],
  );
}
