/** Sales posting rules — matrix rows #1, #3, #4, #5, #6, #7, #8, #19. */
import { AppError } from '@saman/shared';
import { ACCOUNTS, channelAccounts, methodAccount } from './accounts';
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
  text,
  withPartner,
} from './types';
import type { PostingContext, EventPayload } from '../events';
import type { PostingDraft, PostingLegDraft } from './types';

function roundingLegs(rounding: bigint): PostingLegDraft[] {
  if (rounding === 0n) return [];
  return rounding > 0n
    ? [credit(ACCOUNTS.roundingDifference, rounding, 'تفاوت گرد کردن سند')]
    : [debit(ACCOUNTS.roundingDifference, -rounding, 'تفاوت گرد کردن سند')];
}

/** #1 credit sale: AR gross / revenue net / output VAT / shipping; no COGS. */
export function salesInvoiceIssued(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const net = money(payload, 'netAmount');
  const discount = optionalMoney(payload, 'discountAmount');
  const tax = optionalMoney(payload, 'taxAmount');
  const shipping = optionalMoney(payload, 'shippingAmount');
  const gross = money(payload, 'grossAmount');
  const rounding = optionalMoney(payload, 'roundingAmount');
  const customerId = optionalId(payload, 'customerId');
  const accounts = channelAccounts(ctx.channelCode ?? optionalText(payload, 'channelCode'));

  const expectedGross = net - discount + tax + shipping + rounding;
  if (expectedGross !== gross) {
    throw new AppError('JOURNAL_UNBALANCED', {
      details: [
        {
          rule: 'invoice_gross_mismatch',
          params: { expected: expectedGross.toString(), actual: gross.toString() },
        },
      ],
      message: 'مبلغ ناخالص فاکتور با جمع خالص، تخفیف، مالیات و حمل برابر نیست.',
    });
  }

  const legs: PostingLegDraft[] = [
    withPartner(debit(ACCOUNTS.accountsReceivable, gross, 'حساب دریافتنی مشتری'), 'customer', customerId),
    ...leg('debit', ACCOUNTS.salesDiscounts, discount, 'تخفیف فروش'),
    credit(accounts.sales, net, 'درآمد فروش'),
    ...leg('credit', ACCOUNTS.vatPayable, tax, 'مالیات بر ارزش افزوده پرداختنی'),
    ...leg('credit', ACCOUNTS.shippingRevenue, shipping, 'درآمد حمل و ارسال'),
    ...roundingLegs(rounding),
  ];

  return buildDraft(
    {
      eventType: 'sales.invoice.issued',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: `فروش نقدی/اعتباری فاکتور ${optionalText(payload, 'invoiceNo') ?? ''}`.trim(),
      sourceType: 'customer_invoice',
      ...(optionalId(payload, 'invoiceId') === undefined ? {} : { sourceId: optionalId(payload, 'invoiceId') }),
      ...(ctx.sourcePublicId === undefined ? {} : { sourcePublicId: ctx.sourcePublicId }),
      ...(ctx.ruleSetId === undefined ? {} : { ruleSetId: ctx.ruleSetId }),
    },
    legs,
  );
}

/** #3 cash sale: cash/clearing + COGS / revenue + VAT + inventory. */
export function salesCashSale(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const net = money(payload, 'netAmount');
  const discount = optionalMoney(payload, 'discountAmount');
  const tax = optionalMoney(payload, 'taxAmount');
  const shipping = optionalMoney(payload, 'shippingAmount');
  const gross = money(payload, 'grossAmount');
  const rounding = optionalMoney(payload, 'roundingAmount');
  const cogsAmount = money(payload, 'cogsAmount');
  const paid = optionalMoney(payload, 'paidAmount') || gross;
  const method = optionalText(payload, 'method') ?? 'cash';
  const accounts = channelAccounts(ctx.channelCode ?? optionalText(payload, 'channelCode'));
  const cashAccount = optionalText(payload, 'cashAccountCode') ?? methodAccount(method, {
    bankAccountCode: optionalText(payload, 'bankAccountCode'),
    cashAccountCode: optionalText(payload, 'cashAccountCode'),
  });

  const expectedGross = net - discount + tax + shipping + rounding;
  if (expectedGross !== gross) {
    throw new AppError('JOURNAL_UNBALANCED', {
      details: [{ rule: 'invoice_gross_mismatch', params: { expected: expectedGross.toString() } }],
    });
  }
  const unpaid = gross - paid;

  const legs: PostingLegDraft[] = [
    debit(cashAccount, paid, 'دریافت نقدی فروش'),
    ...leg('debit', ACCOUNTS.accountsReceivable, unpaid > 0n ? unpaid : 0n, 'باقیمانده دریافتنی'),
    ...leg('credit', ACCOUNTS.customerCredit, unpaid < 0n ? -unpaid : 0n, 'اعتبار مشتری'),
    ...leg('debit', ACCOUNTS.salesDiscounts, discount, 'تخفیف فروش'),
    debit(ACCOUNTS.cogs, cogsAmount, 'بهای تمام‌شده کالای فروش‌رفته'),
    credit(accounts.sales, net, 'درآمد فروش نقدی'),
    ...leg('credit', ACCOUNTS.vatPayable, tax, 'مالیات بر ارزش افزوده'),
    ...leg('credit', ACCOUNTS.shippingRevenue, shipping, 'درآمد حمل'),
    credit(ACCOUNTS.inventory, cogsAmount, 'خروج موجودی کالا'),
    ...roundingLegs(rounding),
  ];

  return buildDraft(
    {
      eventType: 'sales.cash_sale',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: `فروش نقدی ${optionalText(payload, 'invoiceNo') ?? ''}`.trim(),
      sourceType: 'customer_invoice',
      ...(optionalId(payload, 'invoiceId') === undefined ? {} : { sourceId: optionalId(payload, 'invoiceId') }),
      ...(ctx.sourcePublicId === undefined ? {} : { sourcePublicId: ctx.sourcePublicId }),
    },
    legs,
  );
}

/** #4 header discount applied after issue: discount (contra) / AR. */
export function salesDiscountApplied(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const customerId = optionalId(payload, 'customerId');
  return buildDraft(
    {
      eventType: 'sales.discount.applied',
      entryType: 'adjustment',
      entryDate: ctx.entryDate,
      descriptionFa: 'ثبت تخفیف سند فروش',
      sourceType: 'customer_invoice',
      ...(optionalId(payload, 'invoiceId') === undefined ? {} : { sourceId: optionalId(payload, 'invoiceId') }),
    },
    [
      debit(ACCOUNTS.salesDiscounts, amount, 'تخفیف فروش'),
      withPartner(credit(ACCOUNTS.accountsReceivable, amount, 'کاهش دریافتنی'), 'customer', customerId),
    ],
  );
}

/** #5 customer collection: bank/cash/cheque on hand / AR (+ unapplied credit). */
export function salesPaymentReceived(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const unapplied = optionalMoney(payload, 'unappliedAmount');
  if (unapplied < 0n || unapplied > amount) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'unappliedAmount', rule: 'between_zero_and_amount' }],
      message: 'مبلغ تخصیص‌نیافته پرداخت معتبر نیست.',
    });
  }
  const customerId = optionalId(payload, 'customerId');
  const method = optionalText(payload, 'method') ?? 'bank';
  const account =
    optionalText(payload, 'bankAccountCode') ??
    optionalText(payload, 'cashAccountCode') ??
    methodAccount(method);

  return buildDraft(
    {
      eventType: 'sales.payment.received',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'دریافت وجه از مشتری',
      sourceType: 'payment',
      ...(optionalId(payload, 'paymentId') === undefined ? {} : { sourceId: optionalId(payload, 'paymentId') }),
    },
    [
      debit(account, amount, 'دریافت وجه'),
      withPartner(credit(ACCOUNTS.accountsReceivable, amount - unapplied, 'تسویه دریافتنی'), 'customer', customerId),
      ...leg('credit', ACCOUNTS.customerCredit, unapplied, 'اعتبار/علی‌الحساب مشتری'),
    ],
  );
}

/** #6/#7 sales return: restock restores layers, scrap books a damage loss. */
export function salesReturnReceived(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const net = money(payload, 'netAmount');
  const tax = optionalMoney(payload, 'taxAmount');
  const gross = money(payload, 'grossAmount');
  const cost = money(payload, 'restockCostAmount');
  const condition = optionalText(payload, 'condition') ?? 'restock';
  const customerId = optionalId(payload, 'customerId');

  if (net + tax !== gross) {
    throw new AppError('JOURNAL_UNBALANCED', {
      details: [{ rule: 'return_gross_mismatch', params: { net: net.toString(), tax: tax.toString() } }],
    });
  }

  const legs: PostingLegDraft[] = [
    debit(ACCOUNTS.salesReturns, net, 'برگشت از فروش'),
    ...leg('debit', ACCOUNTS.vatPayable, tax, 'برگشت مالیات بر ارزش افزوده'),
  ];
  if (condition === 'scrap' || condition === 'damaged') {
    legs.push(debit(ACCOUNTS.damage, cost, 'زیان دمیج کالای برگشتی'));
    legs.push(withPartner(credit(ACCOUNTS.accountsReceivable, gross, 'بستانکاری مشتری'), 'customer', customerId));
    legs.push(credit(ACCOUNTS.inventory, cost, 'خروج موجودی کالای برگشتی'));
  } else {
    legs.push(debit(ACCOUNTS.inventory, cost, 'بازگشت موجودی کالا'));
    legs.push(withPartner(credit(ACCOUNTS.accountsReceivable, gross, 'بستانکاری مشتری'), 'customer', customerId));
    legs.push(credit(ACCOUNTS.cogs, cost, 'برگشت بهای تمام‌شده'));
  }

  return buildDraft(
    {
      eventType: 'sales.return.received',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'برگشت از فروش و صدور اعتبارنامه',
      sourceType: 'customer_return',
      ...(optionalId(payload, 'returnId') === undefined ? {} : { sourceId: optionalId(payload, 'returnId') }),
    },
    legs,
  );
}

/** #8 refund: reduce customer credit/AR and pay out. */
export function salesRefundPaid(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const fromCredit = flag(payload, 'fromCustomerCredit');
  const method = optionalText(payload, 'method') ?? 'bank';
  const account = optionalText(payload, 'bankAccountCode') ?? optionalText(payload, 'cashAccountCode') ?? methodAccount(method);
  const customerId = optionalId(payload, 'customerId');

  return buildDraft(
    {
      eventType: 'sales.refund.paid',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'پرداخت وجه برگشت به مشتری',
      sourceType: 'refund',
      ...(optionalId(payload, 'refundId') === undefined ? {} : { sourceId: optionalId(payload, 'refundId') }),
    },
    [
      withPartner(
        debit(fromCredit ? ACCOUNTS.customerCredit : ACCOUNTS.accountsReceivable, amount, 'بازپرداخت به مشتری'),
        'customer',
        customerId,
      ),
      credit(account, amount, 'پرداخت وجه'),
    ],
  );
}

/** #19 shipping recharged to the customer (part of a sales invoice). */
export function shippingRecharged(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const net = money(payload, 'netAmount');
  const tax = optionalMoney(payload, 'taxAmount');
  const gross = money(payload, 'grossAmount');
  const customerId = optionalId(payload, 'customerId');
  if (net + tax !== gross) {
    throw new AppError('JOURNAL_UNBALANCED', { details: [{ rule: 'shipping_gross_mismatch' }] });
  }
  return buildDraft(
    {
      eventType: 'shipping.recharged',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'بازپرداخت هزینه حمل از مشتری',
      sourceType: 'shipment',
    },
    [
      withPartner(debit(ACCOUNTS.accountsReceivable, gross, 'دریافتنی حمل'), 'customer', customerId),
      credit(ACCOUNTS.shippingRevenue, net, 'درآمد حمل'),
      ...leg('credit', ACCOUNTS.vatPayable, tax, 'مالیات حمل'),
    ],
  );
}
