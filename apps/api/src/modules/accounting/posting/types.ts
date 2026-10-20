/**
 * Posting draft primitives.
 *
 * Posting rules are **pure functions**: event payload + context → draft with
 * concrete account *codes* and `bigint` amounts. Persistence (id → code
 * resolution, numbering, balances) lives in `posting.service.ts`. This split is
 * what makes the whole Dr/Cr matrix unit-testable without a database
 * (`R1-accounting` B-10 / `DATA-MODEL §6.10.1`).
 */
import { AppError } from '@saman/shared';
import type { JournalEntryType } from '@saman/shared';
import type { AccountingEventType, EventPayload, PostingContext } from '../events';

export const PARTNER_TYPES = ['customer', 'supplier', 'shareholder', 'employee', 'channel', 'other'] as const;
export type PartnerType = (typeof PARTNER_TYPES)[number];

export interface PostingLegDraft {
  readonly accountCode: string;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly descriptionFa?: string;
  readonly partnerType?: PartnerType;
  readonly partnerId?: bigint;
}

export interface PostingDraft {
  readonly eventType: AccountingEventType;
  readonly entryType: JournalEntryType;
  readonly entryDate: string;
  readonly descriptionFa: string;
  readonly sourceType: string;
  readonly sourceId?: bigint;
  readonly sourcePublicId?: string;
  readonly ruleSetId?: bigint;
  readonly legs: readonly PostingLegDraft[];
}

/** Debit leg helper; zero amounts are dropped by `leg()` when `amount` is 0. */
export function debit(accountCode: string, amount: bigint, descriptionFa?: string): PostingLegDraft {
  return { accountCode, debit: amount, credit: 0n, ...(descriptionFa === undefined ? {} : { descriptionFa }) };
}

export function credit(accountCode: string, amount: bigint, descriptionFa?: string): PostingLegDraft {
  return { accountCode, debit: 0n, credit: amount, ...(descriptionFa === undefined ? {} : { descriptionFa }) };
}

export function leg(
  side: 'debit' | 'credit',
  accountCode: string,
  amount: bigint,
  descriptionFa?: string,
): PostingLegDraft[] {
  if (amount === 0n) return [];
  return [side === 'debit' ? debit(accountCode, amount, descriptionFa) : credit(accountCode, amount, descriptionFa)];
}

export function withPartner(
  draftLeg: PostingLegDraft,
  partnerType: PartnerType,
  partnerId: bigint | undefined,
): PostingLegDraft {
  return {
    ...draftLeg,
    partnerType,
    ...(partnerId === undefined ? {} : { partnerId }),
  };
}

export interface DraftTotals {
  readonly debit: bigint;
  readonly credit: bigint;
}

export function draftTotals(legs: readonly PostingLegDraft[]): DraftTotals {
  let debitTotal = 0n;
  let creditTotal = 0n;
  for (const line of legs) {
    debitTotal += line.debit;
    creditTotal += line.credit;
  }
  return { debit: debitTotal, credit: creditTotal };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Structural + balance validation applied to every draft before persistence and
 * re-applied by `assertDraft` in tests (`Σ debit = Σ credit > 0`, ≥ 2 legs,
 * one side per leg, no negative amounts, no empty account code).
 */
export function assertDraft(draft: PostingDraft): void {
  if (draft.legs.length < 2) {
    throw new AppError('JOURNAL_UNBALANCED', {
      details: [{ rule: 'min_two_lines', params: { legs: draft.legs.length } }],
    });
  }
  if (!ISO_DATE.test(draft.entryDate)) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'entryDate', rule: 'iso_date' }],
      message: 'تاریخ سند حسابداری معتبر نیست.',
    });
  }
  for (const line of draft.legs) {
    if (line.accountCode.trim().length === 0) {
      throw new AppError('VALIDATION_ERROR', { details: [{ field: 'accountCode', rule: 'required' }] });
    }
    if (line.debit < 0n || line.credit < 0n) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'amount', rule: 'non_negative', params: { accountCode: line.accountCode } }],
      });
    }
    const oneSide = (line.debit > 0n) !== (line.credit > 0n);
    if (!oneSide) {
      throw new AppError('JOURNAL_UNBALANCED', {
        details: [{ rule: 'one_side_per_line', params: { accountCode: line.accountCode } }],
      });
    }
  }
  const totals = draftTotals(draft.legs);
  if (totals.debit !== totals.credit || totals.debit === 0n) {
    throw new AppError('JOURNAL_UNBALANCED', {
      details: [
        {
          rule: 'debit_credit_equal',
          params: { debit: totals.debit.toString(), credit: totals.credit.toString(), event: draft.eventType },
        },
      ],
    });
  }
}

/** Draft factory keeps `assertDraft` impossible to forget in rules. */
export function buildDraft(
  meta: Omit<PostingDraft, 'legs'>,
  legs: readonly PostingLegDraft[],
  options: { readonly assert?: boolean } = {},
): PostingDraft {
  const draft: PostingDraft = { ...meta, legs: legs.filter((line) => line.debit !== 0n || line.credit !== 0n) };
  if (options.assert !== false) assertDraft(draft);
  return draft;
}

/* ------------------------------------------------------------------ */
/* Typed payload accessors (no `any`, every failure is a Persian error) */
/* ------------------------------------------------------------------ */

function invalid(field: string, rule: string): AppError {
  return new AppError('VALIDATION_ERROR', {
    details: [{ field, rule }],
    message: 'داده‌های رویداد حسابداری معتبر نیست.',
  });
}

const MONEY = /^-?\d+$/;

/** Reads an integer money value; accepts `bigint` or integer string. */
export function money(payload: EventPayload, field: string): bigint {
  const value = payload[field];
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && MONEY.test(value.trim())) return BigInt(value.trim());
  throw invalid(field, 'money_integer');
}

export function optionalMoney(payload: EventPayload, field: string): bigint {
  return payload[field] === undefined || payload[field] === null ? 0n : money(payload, field);
}

export function text(payload: EventPayload, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.trim().length === 0) throw invalid(field, 'non_empty_string');
  return value.trim();
}

export function optionalText(payload: EventPayload, field: string): string | undefined {
  const value = payload[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(field, 'string');
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function flag(payload: EventPayload, field: string): boolean {
  const value = payload[field];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return false;
}

export function optionalId(payload: EventPayload, field: string): bigint | undefined {
  if (payload[field] === undefined || payload[field] === null) return undefined;
  return money(payload, field);
}

export interface BalanceLine {
  readonly accountCode: string;
  readonly amount: bigint;
}

/** Parses `[{ accountCode, amount }]` arrays used by closing/opening entries. */
export function balanceLines(payload: EventPayload, field: string): readonly BalanceLine[] {
  const value = payload[field];
  if (!Array.isArray(value)) throw invalid(field, 'array');
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null) throw invalid(`${field}[${index}]`, 'object');
    const record = item as Record<string, unknown>;
    const code = record['accountCode'];
    const amount = record['amount'];
    if (typeof code !== 'string') throw invalid(`${field}[${index}].accountCode`, 'string');
    if (typeof amount !== 'string' && typeof amount !== 'bigint') {
      throw invalid(`${field}[${index}].amount`, 'money_integer');
    }
    const parsed = typeof amount === 'bigint' ? amount : BigInt(amount);
    return { accountCode: code, amount: parsed };
  });
}

/** Context defaults used by callers that only have a date. */
export function context(entryDate: string, extra: Omit<PostingContext, 'entryDate'> = {}): PostingContext {
  return { entryDate, ...extra };
}
