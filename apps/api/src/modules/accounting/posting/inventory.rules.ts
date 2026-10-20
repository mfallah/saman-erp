/** Inventory posting rules — matrix rows #2, #20, #21, #22, #23, #24. */
import { AppError } from '@saman/shared';
import { ACCOUNTS, adjustmentLossAccount } from './accounts';
import { buildDraft, credit, debit, money, optionalId, optionalText } from './types';
import type { EventPayload, PostingContext } from '../events';
import type { PostingDraft, PostingLegDraft } from './types';

/** #2 COGS at **stock issue**, never at invoice (B-01). */
export function inventoryIssuePosted(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const cost = money(payload, 'totalCostAmount');
  if (cost <= 0n) {
    throw new AppError('RULE_VIOLATION', {
      details: [{ field: 'totalCostAmount', rule: 'positive_cost' }],
      message: 'بهای خروج موجودی باید بزرگ‌تر از صفر باشد.',
    });
  }
  return buildDraft(
    {
      eventType: 'inventory.issue.posted',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'خروج موجودی و شناسایی بهای تمام‌شده',
      sourceType: 'inventory_transaction',
      ...(optionalId(payload, 'issueId') === undefined ? {} : { sourceId: optionalId(payload, 'issueId') }),
    },
    [
      debit(ACCOUNTS.cogs, cost, 'بهای تمام‌شده کالای فروش‌رفته'),
      credit(ACCOUNTS.inventory, cost, 'خروج موجودی کالا'),
    ],
  );
}

/**
 * #20/#21 stock adjustment at valuation cost. Loss kinds debit their dedicated
 * expense account; a gain flips sides to the count-gain income account (H-05).
 */
export function inventoryAdjustmentPosted(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const cost = money(payload, 'totalCostAmount');
  const kind = optionalText(payload, 'kind') ?? 'count_shortage';
  if (cost < 0n) {
    throw new AppError('VALIDATION_ERROR', { details: [{ field: 'totalCostAmount', rule: 'non_negative' }] });
  }
  if (cost === 0n) {
    throw new AppError('RULE_VIOLATION', {
      details: [{ field: 'totalCostAmount', rule: 'zero_cost_relief_rejected' }],
      message: 'خروج موجودی با بهای صفر مجاز نیست.',
    });
  }
  const isGain = kind === 'count_gain' || kind === 'gain';
  const legs: PostingLegDraft[] = isGain
    ? [
        debit(ACCOUNTS.inventory, cost, 'افزایش موجودی'),
        credit(ACCOUNTS.countGainIncome, cost, 'اضافه شمارش انبار'),
      ]
    : [
        debit(adjustmentLossAccount(kind), cost, 'زیان/کسری موجودی'),
        credit(ACCOUNTS.inventory, cost, 'کاهش موجودی'),
      ];
  return buildDraft(
    {
      eventType: 'inventory.adjustment.posted',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: `تعدیل موجودی (${kind})`,
      sourceType: 'stock_adjustment',
      ...(optionalId(payload, 'adjustmentId') === undefined ? {} : { sourceId: optionalId(payload, 'adjustmentId') }),
    },
    legs,
  );
}

/** #22 transfer dispatch: in-transit asset / source inventory. */
export function inventoryTransferDispatched(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const cost = money(payload, 'totalCostAmount');
  const sourceAccount = optionalText(payload, 'sourceInventoryAccountCode') ?? ACCOUNTS.inventory;
  return buildDraft(
    {
      eventType: 'inventory.transfer.dispatched',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'ارسال بین انبارها (کالای در راه)',
      sourceType: 'inventory_transfer',
      ...(optionalId(payload, 'transferId') === undefined ? {} : { sourceId: optionalId(payload, 'transferId') }),
    },
    [
      debit(ACCOUNTS.goodsInTransit, cost, 'کالای در راه'),
      credit(sourceAccount, cost, 'خروج از انبار مبدأ'),
    ],
  );
}

/** #23 transfer receive: destination inventory / in-transit. */
export function inventoryTransferReceived(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const cost = money(payload, 'totalCostAmount');
  const destinationAccount = optionalText(payload, 'destinationInventoryAccountCode') ?? ACCOUNTS.inventory;
  return buildDraft(
    {
      eventType: 'inventory.transfer.received',
      entryType: 'auto',
      entryDate: ctx.entryDate,
      descriptionFa: 'دریافت بین انبارها',
      sourceType: 'inventory_transfer',
      ...(optionalId(payload, 'transferId') === undefined ? {} : { sourceId: optionalId(payload, 'transferId') }),
    },
    [
      debit(destinationAccount, cost, 'ورود به انبار مقصد'),
      credit(ACCOUNTS.goodsInTransit, cost, 'کاهش کالای در راه'),
    ],
  );
}

/**
 * #24 valuation true-up: positive variance increases inventory (other income),
 * negative variance is a shortage expense. Method changes and year-end only.
 */
export function inventoryValuationPosted(payload: EventPayload, ctx: PostingContext): PostingDraft {
  const variance = money(payload, 'varianceAmount');
  if (variance === 0n) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'varianceAmount', rule: 'non_zero' }],
      message: 'مغایرت ارزش‌گذاری باید غیرصفر باشد.',
    });
  }
  const legs: PostingLegDraft[] =
    variance > 0n
      ? [
          debit(ACCOUNTS.inventory, variance, 'افزایش ارزش موجودی'),
          credit(ACCOUNTS.otherIncome, variance, 'درآمد اصلاح ارزش‌گذاری'),
        ]
      : [
          debit(ACCOUNTS.countShortage, -variance, 'کاهش ارزش موجودی'),
          credit(ACCOUNTS.inventory, -variance, 'اصلاح ارزش موجودی'),
        ];
  return buildDraft(
    {
      eventType: 'inventory.valuation.posted',
      entryType: 'adjustment',
      entryDate: ctx.entryDate,
      descriptionFa: 'ثبت اصلاح ارزش‌گذاری موجودی',
      sourceType: 'inventory_valuation_run',
      ...(optionalId(payload, 'valuationRunId') === undefined ? {} : { sourceId: optionalId(payload, 'valuationRunId') }),
    },
    legs,
  );
}
