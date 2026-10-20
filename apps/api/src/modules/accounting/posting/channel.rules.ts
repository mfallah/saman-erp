/** Channel fee & settlement posting rules — matrix rows #15–#17 (B-03). */
import { AppError } from '@saman/shared';
import { ACCOUNTS, channelAccounts } from './accounts';
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

/** #15 commission/fee accrual at sale time: expense (+recoverable VAT) / fee payable. */
export function channelFeeAccrued(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const commission = optionalMoney(payload, 'commissionAmount');
  const fee = optionalMoney(payload, 'feeAmount');
  const feeVat = optionalMoney(payload, 'feeVatAmount');
  const recoverable = flag(payload, 'feeVatRecoverable');
  const accounts = channelAccounts(ctx.channelCode ?? optionalText(payload, 'channelCode'));
  const total = commission + fee;
  if (total <= 0n) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'feeAmount', rule: 'positive' }],
      message: 'مبلغ کارمزد کانال باید بزرگ‌تر از صفر باشد.',
    });
  }
  const vat = recoverable ? feeVat : 0n;
  return buildDraft(
    {
      eventType: 'channel.fee.accrued',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'شناسایی کارمزد کانال فروش',
      sourceType: 'channel_account',
      ...(optionalId(payload, 'channelAccountId') === undefined
        ? {}
        : { sourceId: optionalId(payload, 'channelAccountId') }),
    },
    [
      debit(accounts.feeExpense, total, 'کارمزد و کمیسیون کانال'),
      ...leg('debit', ACCOUNTS.vatReceivable, vat, 'مالیات کارمزد قابل بازیافت'),
      credit(ACCOUNTS.channelFeePayable, total + vat, 'کارمزد پرداختنی کانال'),
    ],
  );
}

/**
 * #16 settlement confirmed — **never** credits sales revenue.
 *
 * Channel revenue was recognised at invoice; the settlement only clears the
 * channel receivable against the money received and the fee/return/VAT legs.
 * `net = gross − commission − fee − returns − tax` is validated here as well, so
 * a corrupt settlement document cannot silently create a variance.
 */
export function settlementConfirmed(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const gross = money(payload, 'grossSalesAmount');
  const commission = optionalMoney(payload, 'commissionAmount');
  const fee = optionalMoney(payload, 'feeAmount');
  const returns = optionalMoney(payload, 'returnAmount');
  const tax = optionalMoney(payload, 'taxAmount');
  const net = money(payload, 'netPayableAmount');
  const variance = optionalMoney(payload, 'varianceAmount');
  const paidToBank = flag(payload, 'paidToBank');
  const accounts = channelAccounts(ctx.channelCode ?? optionalText(payload, 'channelCode'));
  const settlementAccount = paidToBank
    ? (optionalText(payload, 'bankAccountCode') ?? ACCOUNTS.bank)
    : ACCOUNTS.settlementClearing;

  const expectedNet = gross - commission - fee - returns - tax;
  if (expectedNet !== net) {
    throw new AppError('RULE_VIOLATION', {
      details: [
        {
          rule: 'settlement_net_mismatch',
          params: {
            expected: expectedNet.toString(),
            actual: net.toString(),
            gross: gross.toString(),
          },
        },
      ],
      message: 'مبلغ خالص قابل پرداخت تسویه با فرمول تسویه برابر نیست.',
    });
  }

  const legs: PostingLegDraft[] = [
    debit(settlementAccount, net, 'وجه دریافتی تسویه کانال'),
    debit(ACCOUNTS.channelFeePayable, commission + fee, 'تسویه کارمزد شناسایی‌شده'),
    ...leg('debit', ACCOUNTS.salesReturns, returns, 'برگشت فروش در صورت تسویه'),
    ...leg('debit', ACCOUNTS.vatPayable, tax, 'مالیات فروش در صورت تسویه'),
    ...leg('debit', ACCOUNTS.settlementVariance, variance > 0n ? variance : 0n, 'مغایرت نامساعد تسویه'),
    ...leg('credit', ACCOUNTS.settlementVariance, variance < 0n ? -variance : 0n, 'مغایرت مساعد تسویه'),
    withPartner(
      credit(accounts.receivable, gross, 'تسویه دریافتنی از کانال'),
      'channel',
      optionalId(payload, 'channelAccountId'),
    ),
  ];

  return buildDraft(
    {
      eventType: 'settlement.confirmed',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: `تسویه کانال ${optionalText(payload, 'settlementNo') ?? ''}`.trim(),
      sourceType: 'channel_settlement',
      ...(optionalId(payload, 'settlementId') === undefined ? {} : { sourceId: optionalId(payload, 'settlementId') }),
    },
    legs,
  );
}

/** #17 residual settlement variance written explicitly. */
export function settlementVarianceRecorded(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const variance = money(payload, 'varianceAmount');
  const accounts = channelAccounts(ctx.channelCode ?? optionalText(payload, 'channelCode'));
  const channelId = optionalId(payload, 'channelAccountId');
  const legs: PostingLegDraft[] =
    variance > 0n
      ? [
          debit(ACCOUNTS.settlementVariance, variance, 'مغایرت تسویه'),
          withPartner(credit(accounts.receivable, variance, 'کاهش دریافتنی کانال'), 'channel', channelId),
        ]
      : [
          withPartner(debit(accounts.receivable, -variance, 'افزایش دریافتنی کانال'), 'channel', channelId),
          credit(ACCOUNTS.settlementVariance, -variance, 'اصلاح مغایرت تسویه'),
        ];
  return buildDraft(
    {
      eventType: 'settlement.variance.recorded',
      entryType: 'adjustment',
      entryDate: ctx.entryDate,
      descriptionFa: 'ثبت مغایرت تسویه کانال',
      sourceType: 'channel_settlement',
      ...(optionalId(payload, 'settlementId') === undefined ? {} : { sourceId: optionalId(payload, 'settlementId') }),
    },
    legs,
  );
}
