/** Expense, shipping-cost, bad-debt and FX posting rules — matrix #18, #42–#45, #49. */
import { AppError } from '@saman/shared';
import { ACCOUNTS, isExpenseAccountCode, methodAccount } from './accounts';
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

/** #18 shipping cost paid by us (outbound expense, inbound capitalisable path). */
export function shippingCostIncurred(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const capitalise = flag(payload, 'capitaliseToInventory');
  const paidByBank = flag(payload, 'paidByBank');
  const expenseAccount = optionalText(payload, 'expenseAccountCode') ?? ACCOUNTS.shippingExpense;
  const supplierId = optionalId(payload, 'supplierId');
  const creditAccount = paidByBank
    ? (optionalText(payload, 'bankAccountCode') ?? ACCOUNTS.bank)
    : ACCOUNTS.accountsPayable;

  const debitLegs: PostingLegDraft[] = capitalise
    ? [debit(ACCOUNTS.inventory, amount, 'هزینه حمل سرمایه‌ای‌شده در موجودی')]
    : [debit(expenseAccount, amount, 'هزینه حمل و نقل')];

  return buildDraft(
    {
      eventType: 'shipping.cost.incurred',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'هزینه حمل و ارسال',
      sourceType: 'shipment',
      ...(optionalId(payload, 'shipmentId') === undefined ? {} : { sourceId: optionalId(payload, 'shipmentId') }),
    },
    [...debitLegs, withPartner(credit(creditAccount, amount, 'بدهی/پرداخت هزینه حمل'), 'supplier', supplierId)],
  );
}

/** #42 expense recognised: category account (+ recoverable VAT) / AP or bank. */
export function expenseRecognised(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const vat = optionalMoney(payload, 'taxAmount');
  const recoverable = flag(payload, 'taxRecoverable');
  const accountCode = optionalText(payload, 'accountCode') ?? ACCOUNTS.otherExpense;
  if (!isExpenseAccountCode(accountCode)) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'accountCode', rule: 'expense_l4_account' }],
      message: 'حساب هزینه باید یکی از حساب‌های تفصیلی هزینه باشد.',
    });
  }
  const vatAmount = recoverable ? vat : 0n;
  const creditAccount = flag(payload, 'paidByBank')
    ? (optionalText(payload, 'bankAccountCode') ?? ACCOUNTS.bank)
    : ACCOUNTS.accountsPayable;
  const supplierId = optionalId(payload, 'supplierId');

  return buildDraft(
    {
      eventType: 'expense.recognised',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: optionalText(payload, 'descriptionFa') ?? 'شناسایی هزینه عملیاتی',
      sourceType: 'expense',
      ...(optionalId(payload, 'expenseId') === undefined ? {} : { sourceId: optionalId(payload, 'expenseId') }),
    },
    [
      debit(accountCode, amount, 'هزینه'),
      ...leg('debit', ACCOUNTS.vatReceivable, vatAmount, 'مالیات هزینه قابل بازیافت'),
      withPartner(credit(creditAccount, amount + vatAmount, 'بدهی هزینه'), 'supplier', supplierId),
    ],
  );
}

/** #43 expense paid: AP / bank. */
export function expensePaid(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const account = optionalText(payload, 'bankAccountCode') ?? methodAccount(optionalText(payload, 'method') ?? 'bank');
  const supplierId = optionalId(payload, 'supplierId');
  return buildDraft(
    {
      eventType: 'expense.paid',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'پرداخت هزینه',
      sourceType: 'expense',
      ...(optionalId(payload, 'expenseId') === undefined ? {} : { sourceId: optionalId(payload, 'expenseId') }),
    },
    [
      withPartner(debit(ACCOUNTS.accountsPayable, amount, 'تسویه بدهی هزینه'), 'supplier', supplierId),
      credit(account, amount, 'پرداخت وجه'),
    ],
  );
}

/** #44 bad-debt allowance: expense / contra-asset allowance. */
export function badDebtAllowance(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  return buildDraft(
    {
      eventType: 'bad_debt.allowance',
      entryType: 'adjustment',
      entryDate: ctx.entryDate,
      descriptionFa: 'ذخیره مطالبات مشکوک‌الوصول',
      sourceType: 'customer',
    },
    [debit(ACCOUNTS.badDebtExpense, amount, 'هزینه مطالبات مشکوک‌الوصول'), credit(ACCOUNTS.allowanceDoubtful, amount, 'ذخیره مطالبات')],
  );
}

/** #45 direct write-off against the allowance (approval gated in the service). */
export function badDebtWriteoff(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const amount = money(payload, 'amount');
  const customerId = optionalId(payload, 'customerId');
  return buildDraft(
    {
      eventType: 'bad_debt.writeoff',
      entryType: 'adjustment',
      entryDate: ctx.entryDate,
      descriptionFa: 'مصرف ذخیره مطالبات مشکوک‌الوصول',
      sourceType: 'customer',
    },
    [
      debit(ACCOUNTS.allowanceDoubtful, amount, 'مصرف ذخیره'),
      withPartner(credit(ACCOUNTS.accountsReceivable, amount, 'حذف دریافتنی'), 'customer', customerId),
    ],
  );
}

/** #49 FX revaluation (v1 single-currency, schema/rule ready for multi-currency). */
export function fxRevaluation(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const delta = money(payload, 'varianceAmount');
  const assetAccount = optionalText(payload, 'assetAccountCode') ?? ACCOUNTS.bank;
  const legs: PostingLegDraft[] =
    delta > 0n
      ? [
          debit(assetAccount, delta, 'افزایش ارزش ارزی دارایی'),
          credit(ACCOUNTS.otherIncome, delta, 'درآمد تسعیر ارز'),
        ]
      : [
          debit(ACCOUNTS.bankCharges, -delta, 'زیان تسعیر ارز'),
          credit(assetAccount, -delta, 'کاهش ارزش ارزی دارایی'),
        ];
  return buildDraft(
    {
      eventType: 'fx.revaluation',
      entryType: 'adjustment',
      entryDate: ctx.entryDate,
      descriptionFa: 'تسعیر ارز دارایی/بدهی',
      sourceType: 'fx_rate',
    },
    legs,
  );
}
