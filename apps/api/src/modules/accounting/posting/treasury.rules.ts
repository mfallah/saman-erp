/**
 * Treasury posting rules — matrix rows #25–#37, #39–#41.
 *
 * Cheque rules branch on `direction` and, for bounces, on `afterClear`, which is
 * the exact defect R1-accounting B-13 called out (a post-clear bounce must
 * reverse the bank, not a zero cheque-receivable account).
 */
import { AppError } from '@saman/shared';
import { ACCOUNTS, methodAccount } from './accounts';
import {
  buildDraft,
  credit,
  debit,
  flag,
  money,
  optionalId,
  optionalMoney,
  optionalText,
  withPartner,
} from './types';
import type { EventPayload, PostingContext } from '../events';
import type { PostingDraft, PostingLegDraft } from './types';

function party(payload: EventPayload): { type: 'customer' | 'supplier' | 'shareholder' | 'other'; id: bigint | undefined } {
  const id = optionalId(payload, 'partyId');
  const explicit = optionalText(payload, 'partyType');
  switch (explicit) {
    case 'customer':
      return { type: 'customer', id };
    case 'supplier':
      return { type: 'supplier', id };
    case 'shareholder':
      return { type: 'shareholder', id };
    default:
      return { type: 'other', id };
  }
}

/** #25 cash receipt recorded inside a shift. */
export function cashReceiptRecorded(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const cashAccount = optionalText(payload, 'cashAccountCode') ?? ACCOUNTS.cash;
  const p = party(payload);
  return buildDraft(
    {
      eventType: 'cash.receipt.recorded',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'دریافت نقدی صندوق',
      sourceType: 'cash_transaction',
      ...(optionalId(payload, 'cashTransactionId') === undefined
        ? {}
        : { sourceId: optionalId(payload, 'cashTransactionId') }),
    },
    [
      debit(cashAccount, amount, 'افزایش صندوق'),
      withPartner(credit(ACCOUNTS.accountsReceivable, amount, 'دریافتنی مشتری'), p.type, p.id),
    ],
  );
}

/** #26/#27 cash session close: positive difference = over, negative = short. */
export function cashSessionClosed(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const variance = money(payload, 'differenceAmount');
  const cashAccount = optionalText(payload, 'cashAccountCode') ?? ACCOUNTS.cash;
  if (variance === 0n) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'differenceAmount', rule: 'non_zero' }],
      message: 'مغایرت صندوق صفر است و سندی برای ثبت وجود ندارد.',
    });
  }
  const legs: PostingLegDraft[] =
    variance > 0n
      ? [
          debit(cashAccount, variance, 'اضافه صندوق'),
          credit(ACCOUNTS.cashOver, variance, 'اضافه صندوق (درآمد)'),
        ]
      : [
          debit(ACCOUNTS.cashShort, -variance, 'کسری صندوق'),
          credit(cashAccount, -variance, 'کاهش صندوق'),
        ];
  return buildDraft(
    {
      eventType: 'cash.session.closed',
      entryType: 'adjustment',
      entryDate: ctx.entryDate,
      descriptionFa: variance > 0n ? 'بستن شیفت صندوق با اضافه' : 'بستن شیفت صندوق با کسری',
      sourceType: 'cash_session',
      ...(optionalId(payload, 'cashSessionId') === undefined ? {} : { sourceId: optionalId(payload, 'cashSessionId') }),
    },
    legs,
  );
}

/** #28 cheque received from a customer: cheque on hand / AR. */
export function chequeReceived(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const p = party(payload);
  return buildDraft(
    {
      eventType: 'cheque.received',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'دریافت چک از مشتری',
      sourceType: 'cheque',
      ...(optionalId(payload, 'chequeId') === undefined ? {} : { sourceId: optionalId(payload, 'chequeId') }),
    },
    [
      debit(ACCOUNTS.chequeOnHand, amount, 'چک‌های دریافتنی نزد صندوق'),
      withPartner(credit(ACCOUNTS.accountsReceivable, amount, 'تسویه دریافتنی'), p.type, p.id),
    ],
  );
}

/** #29 cheque deposited: cheques in collection / cheques on hand. */
export function chequeDeposited(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  return buildDraft(
    {
      eventType: 'cheque.deposited',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'سپرده چک به بانک (در جریان وصول)',
      sourceType: 'cheque',
      ...(optionalId(payload, 'chequeId') === undefined ? {} : { sourceId: optionalId(payload, 'chequeId') }),
    },
    [
      debit(ACCOUNTS.chequeInCollection, amount, 'چک‌های در جریان وصول'),
      credit(ACCOUNTS.chequeOnHand, amount, 'کاهش چک نزد صندوق'),
    ],
  );
}

/** #30/#35 cheque cleared: received → bank; issued → cheques payable / bank. */
export function chequeCleared(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const direction = optionalText(payload, 'direction') ?? 'received';
  const bankAccount = optionalText(payload, 'bankAccountCode') ?? ACCOUNTS.bank;
  const legs: PostingLegDraft[] =
    direction === 'issued'
      ? [
          debit(ACCOUNTS.chequesPayable, amount, 'تهاتر چک پرداختنی'),
          credit(bankAccount, amount, 'برداشت از بانک'),
        ]
      : [
          debit(bankAccount, amount, 'وصول چک در بانک'),
          credit(ACCOUNTS.chequeInCollection, amount, 'کاهش چک در جریان وصول'),
        ];
  return buildDraft(
    {
      eventType: direction === 'issued' ? 'cheque.issued.cleared' : 'cheque.cleared',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: direction === 'issued' ? 'وصول چک پرداختنی' : 'وصول چک دریافتی',
      sourceType: 'cheque',
      ...(optionalId(payload, 'chequeId') === undefined ? {} : { sourceId: optionalId(payload, 'chequeId') }),
    },
    legs,
  );
}

/**
 * #31/#32 bounced cheque. Before clearing the cheque asset is released back to
 * AR; **after clearing** the bank must be reversed (plus bank charges).
 */
export function chequeBounced(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const afterClear = flag(payload, 'afterClear');
  const bankCharges = optionalMoney(payload, 'bankChargesAmount');
  const direction = optionalText(payload, 'direction') ?? 'received';
  const p = party(payload);
  const legs: PostingLegDraft[] = [];

  if (afterClear) {
    legs.push(withPartner(debit(ACCOUNTS.accountsReceivable, amount, 'برگشت چک و بدهی مشتری'), p.type, p.id));
    if (bankCharges > 0n) legs.push(debit(ACCOUNTS.bankCharges, bankCharges, 'کارمزد برگشت چک'));
    legs.push(credit(ACCOUNTS.bank, amount + bankCharges, 'برگشت وجه از بانک'));
  } else if (direction === 'issued') {
    legs.push(withPartner(debit(ACCOUNTS.accountsPayable, amount, 'بازگشت بدهی تأمین‌کننده'), p.type, p.id));
    legs.push(credit(ACCOUNTS.chequesPayable, amount, 'ابطال چک پرداختنی'));
  } else {
    legs.push(withPartner(debit(ACCOUNTS.accountsReceivable, amount, 'بدهی مشتری بابت چک برگشتی'), p.type, p.id));
    legs.push(
      credit(ACCOUNTS.chequeInCollection, amount, 'خروج چک در جریان وصول'),
    );
  }

  return buildDraft(
    {
      eventType: 'cheque.bounced',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: afterClear ? 'برگشت چک پس از وصول' : 'برگشت چک قبل از وصول',
      sourceType: 'cheque',
      ...(optionalId(payload, 'chequeId') === undefined ? {} : { sourceId: optionalId(payload, 'chequeId') }),
    },
    legs,
  );
}

/** #33 cheque endorsed to a third party: AP / cheques on hand (+ guarantee memo). */
export function chequeEndorsed(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const p = party(payload);
  return buildDraft(
    {
      eventType: 'cheque.endorsed',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: `ظهرنویسی چک به ${optionalText(payload, 'endorsedTo') ?? 'شخص ثالث'}`,
      sourceType: 'cheque',
      ...(optionalId(payload, 'chequeId') === undefined ? {} : { sourceId: optionalId(payload, 'chequeId') }),
    },
    [
      withPartner(debit(ACCOUNTS.accountsPayable, amount, 'تسویه بدهی با ظهرنویسی'), p.type, p.id),
      credit(ACCOUNTS.chequeOnHand, amount, 'خروج چک نزد صندوق'),
    ],
  );
}

/** #34 issued cheque: AP / cheques payable. */
export function chequeIssued(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const p = party(payload);
  return buildDraft(
    {
      eventType: 'cheque.issued',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'صدور چک پرداختنی',
      sourceType: 'cheque',
      ...(optionalId(payload, 'chequeId') === undefined ? {} : { sourceId: optionalId(payload, 'chequeId') }),
    },
    [
      withPartner(debit(ACCOUNTS.accountsPayable, amount, 'تسویه بدهی با چک'), p.type, p.id),
      credit(ACCOUNTS.chequesPayable, amount, 'چک‌های پرداختنی'),
    ],
  );
}

/** #36 customer advance received: bank / customer advance. */
export function paymentAdvanceReceived(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const account =
    optionalText(payload, 'bankAccountCode') ??
    methodAccount(optionalText(payload, 'method') ?? 'bank');
  const p = party(payload);
  return buildDraft(
    {
      eventType: 'payment.advance.received',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'دریافت علی‌الحساب / پیش‌دریافت',
      sourceType: 'payment',
      ...(optionalId(payload, 'paymentId') === undefined ? {} : { sourceId: optionalId(payload, 'paymentId') }),
    },
    [
      debit(account, amount, 'دریافت وجه'),
      withPartner(credit(ACCOUNTS.customerAdvance, amount, 'پیش‌دریافت مشتری'), p.type, p.id),
    ],
  );
}

/** #37 allocation of an advance/prepayment to invoices. */
export function paymentAllocated(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const direction = optionalText(payload, 'direction') ?? 'inbound';
  const p = party(payload);
  const legs: PostingLegDraft[] =
    direction === 'outbound'
      ? [
          withPartner(debit(ACCOUNTS.accountsPayable, amount, 'تسویه بدهی با پیش‌پرداخت'), 'supplier', p.id),
          credit(ACCOUNTS.supplierPrepayment, amount, 'مصرف پیش‌پرداخت'),
        ]
      : [
          debit(ACCOUNTS.customerAdvance, amount, 'مصرف پیش‌دریافت'),
          withPartner(credit(ACCOUNTS.accountsReceivable, amount, 'کاهش دریافتنی'), 'customer', p.id),
        ];
  return buildDraft(
    {
      eventType: 'payment.allocated',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'تخصیص پرداخت به اسناد',
      sourceType: 'payment',
      ...(optionalId(payload, 'paymentId') === undefined ? {} : { sourceId: optionalId(payload, 'paymentId') }),
    },
    legs,
  );
}

/** #39 dividend payment: dividends payable / bank. */
export function dividendPaid(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const account = optionalText(payload, 'bankAccountCode') ?? ACCOUNTS.bank;
  return buildDraft(
    {
      eventType: 'dividend.paid',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'پرداخت سود سهام',
      sourceType: 'profit_distribution',
      ...(optionalId(payload, 'distributionId') === undefined
        ? {}
        : { sourceId: optionalId(payload, 'distributionId') }),
    },
    [
      debit(ACCOUNTS.dividendsPayable, amount, 'تسویه سود سهام پرداختنی'),
      credit(account, amount, 'پرداخت وجه'),
    ],
  );
}

/** #40 VAT payment to the tax authority. */
export function taxVatPayment(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const account = optionalText(payload, 'bankAccountCode') ?? ACCOUNTS.bank;
  return buildDraft(
    {
      eventType: 'tax.vat.payment',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'پرداخت مالیات بر ارزش افزوده',
      sourceType: 'tax_document',
      ...(optionalId(payload, 'taxDocumentId') === undefined ? {} : { sourceId: optionalId(payload, 'taxDocumentId') }),
    },
    [debit(ACCOUNTS.vatPayable, amount, 'تسویه مالیات پرداختنی'), credit(account, amount, 'پرداخت به سازمان امور مالیاتی')],
  );
}

/** #41 VAT refund received. */
export function taxVatRefund(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const account = optionalText(payload, 'bankAccountCode') ?? ACCOUNTS.bank;
  return buildDraft(
    {
      eventType: 'tax.vat.refund',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'دریافت استرداد مالیات بر ارزش افزوده',
      sourceType: 'tax_document',
      ...(optionalId(payload, 'taxDocumentId') === undefined ? {} : { sourceId: optionalId(payload, 'taxDocumentId') }),
    },
    [debit(account, amount, 'دریافت وجه'), credit(ACCOUNTS.vatReceivable, amount, 'کاهش اعتبار مالیاتی')],
  );
}
