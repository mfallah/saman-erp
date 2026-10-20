import { asDb } from '../persistence/sql-support';
import type { SqlSession } from '../persistence/sql-support';
/**
 * Posting service: turns an accounting event (or an already-computed draft) into
 * a **posted** journal inside the caller's transaction (`ARCHITECTURE §6`).
 *
 * - drafts come from the pure rules in this folder (no SQL in the rules);
 * - account codes resolve to seeded, postable accounts (never a wildcard);
 * - `source_event_uuid` makes posting exactly-once (duplicate event → no-op);
 * - balances, audit and the outbox event are written in the same transaction.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@saman/shared';
import { AUDIT, DB, EVENT_BUS } from '../../../common/contracts';
import type { AuditPort, Db, EventPort, TenantContext } from '../../../common/contracts';
import { ChartOfAccountsRepository } from '../coa/chart-of-accounts.repository';
import { JournalRepository } from '../journal/journal.repository';
import type { JournalLineInput } from '../journal/journal.repository';
import { FiscalCalendarRepository } from '../periods/fiscal-calendar.repository';
import { assertPeriodAcceptsEntryType, isPostingBlocked } from '../periods/fiscal-calendar';
import { buildPostingDraft, draftTotals } from './index';
import type { AccountingEventType, EventPayload, PostingContext } from '../events';
import type { PostingDraft } from './types';

export interface PostEventInput {
  readonly eventType: AccountingEventType;
  readonly payload: EventPayload;
  readonly context: PostingContext;
  /** Outbox event uuid; guarantees exactly-once posting. */
  readonly sourceEventUuid?: string;
  readonly sourceId?: bigint;
  readonly postingRuleSetId?: bigint;
}

export interface PersistDraftOptions {
  readonly sourceEventUuid?: string;
  readonly sourceId?: bigint;
  readonly postingRuleSetId?: bigint;
}

export interface PostEventResult {
  readonly journalId: bigint;
  readonly entryNo: string;
  readonly duplicate: boolean;
  readonly totalDebit: bigint;
}

const JOURNAL_DOCUMENT_TYPE = 'JV';

@Injectable()
export class PostingService {
  constructor(
    private readonly journalRepo: JournalRepository,
    private readonly coaRepo: ChartOfAccountsRepository,
    private readonly calendar: FiscalCalendarRepository,
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  /** Pure preview used by tests/ops tooling — no database access. */
  preview(eventType: string, payload: EventPayload, context: PostingContext): PostingDraft {
    return buildPostingDraft(eventType, payload, context);
  }

  /** Builds the draft from an event and persists it as a posted journal. */
  async postEvent(tx: SqlSession, ctx: TenantContext, input: PostEventInput): Promise<PostEventResult> {
    if (input.sourceEventUuid !== undefined) {
      const existing = await this.journalRepo.findBySourceEvent(tx, ctx.orgId, input.sourceEventUuid);
      if (existing !== undefined && existing.entryNo !== null) {
        return {
          journalId: existing.id,
          entryNo: existing.entryNo,
          duplicate: true,
          totalDebit: existing.totalDebitAmount,
        };
      }
    }
    const draft = buildPostingDraft(input.eventType, input.payload, input.context);
    return this.postDraft(tx, ctx, draft, {
      ...(input.sourceEventUuid === undefined ? {} : { sourceEventUuid: input.sourceEventUuid }),
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
      ...(input.postingRuleSetId === undefined ? {} : { postingRuleSetId: input.postingRuleSetId }),
    });
  }

  /**
   * Persists a fully computed draft (used by the closing run and any service that
   * already owns the Dr/Cr legs). Account codes must be seeded and postable.
   */
  async postDraft(
    tx: SqlSession,
    ctx: TenantContext,
    draft: PostingDraft,
    options: PersistDraftOptions = {},
  ): Promise<PostEventResult> {
    const duplicate = await this.findDuplicate(tx, ctx, options.sourceEventUuid);
    if (duplicate !== undefined) return duplicate;

    const codes = [...new Set(draft.legs.map((line) => line.accountCode))];
    const accounts = await this.coaRepo.findByCodes(tx, ctx.orgId, codes);
    const lines: JournalLineInput[] = [];
    const balanceLines: { accountId: bigint; debit: bigint; credit: bigint }[] = [];
    for (const line of draft.legs) {
      const account = accounts.get(line.accountCode);
      if (account === undefined) {
        throw new AppError('RULE_VIOLATION', {
          details: [{ rule: 'posting_account_missing', params: { accountCode: line.accountCode } }],
          message: 'حساب موردنیاز برای ثبت خودکار سند وجود ندارد.',
        });
      }
      if (!account.isPostable || !account.isActive) {
        throw new AppError('RULE_VIOLATION', {
          details: [{ rule: 'posting_account_not_postable', params: { accountCode: line.accountCode } }],
          message: 'حساب انتخاب‌شده برای ثبت خودکار سند قابل استفاده نیست.',
        });
      }
      lines.push({
        accountId: account.id,
        debitAmount: line.debit,
        creditAmount: line.credit,
        ...(line.descriptionFa === undefined ? {} : { description: line.descriptionFa }),
        ...(line.partnerType === undefined ? {} : { partnerType: line.partnerType }),
        ...(line.partnerId === undefined ? {} : { partnerId: line.partnerId }),
      });
      balanceLines.push({ accountId: account.id, debit: line.debit, credit: line.credit });
    }

    const { period, year } = await this.calendar.resolveAndLockPeriod(tx, ctx.orgId, draft.entryDate);
    if (year.status === 'closed') {
      throw new AppError('FISCAL_YEAR_CLOSED', { message: 'سال مالی بسته شده است و ثبت سند خودکار مجاز نیست.' });
    }
    if (isPostingBlocked(period.status)) {
      throw new AppError('PERIOD_CLOSED', {
        details: [{ rule: 'period_closed', params: { periodId: period.id.toString() } }],
        message: 'دوره مالی بسته شده است و ثبت سند خودکار مجاز نیست.',
      });
    }
    assertPeriodAcceptsEntryType(period.periodNo, draft.entryType);

    const totals = draftTotals(draft.legs);
    const entryNo = await this.journalRepo.allocateEntryNo(tx, ctx.orgId, year.id, JOURNAL_DOCUMENT_TYPE, 'JV');
    const sourceId = options.sourceId ?? draft.sourceId;
    const journalId = await this.journalRepo.insertEntry(
      tx,
      {
        orgId: ctx.orgId,
        fiscalYearId: year.id,
        periodId: period.id,
        entryDate: draft.entryDate,
        entryType: draft.entryType,
        description: draft.descriptionFa,
        sourceType: draft.sourceType,
        ...(sourceId === undefined ? {} : { sourceId }),
        ...(options.sourceEventUuid === undefined ? {} : { sourceEventUuid: options.sourceEventUuid }),
        ...(draft.ruleSetId === undefined && options.postingRuleSetId === undefined
          ? {}
          : { postingRuleSetId: draft.ruleSetId ?? options.postingRuleSetId }),
        entryNo,
        createdBy: ctx.actorId,
      },
      lines,
      totals,
      'posted',
    );

    await this.journalRepo.applyBalances(tx, {
      orgId: ctx.orgId,
      fiscalYearId: year.id,
      periodId: period.id,
      lines: balanceLines,
    });

    await this.audit.record(asDb(tx), {
      action: 'accounting.journal.auto_post',
      entityType: 'journal_entry',
      entityId: journalId,
      orgId: ctx.orgId,
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      after: {
        eventType: draft.eventType,
        entryNo,
        totalDebit: totals.debit.toString(),
        sourceType: draft.sourceType,
      },
      meta: { sourceEventUuid: options.sourceEventUuid ?? null },
    });
    await this.events.emit(asDb(tx), {
      orgId: ctx.orgId,
      type: 'accounting.journal.posted',
      aggregateType: 'journal_entry',
      aggregateId: journalId,
      payload: {
        entryNo,
        eventType: draft.eventType,
        entryDate: draft.entryDate,
        totalDebit: totals.debit.toString(),
      },
      ...(options.sourceEventUuid === undefined ? {} : { dedupeKey: `journal:${options.sourceEventUuid}` }),
    });

    return { journalId, entryNo, duplicate: false, totalDebit: totals.debit };
  }

  /** Convenience wrapper for callers outside a transaction (single event). */
  async postEventIsolated(ctx: TenantContext, input: PostEventInput): Promise<PostEventResult> {
    return this.db.begin(async (tx) => this.postEvent(tx, ctx, input));
  }

  private async findDuplicate(
    tx: SqlSession,
    ctx: TenantContext,
    sourceEventUuid: string | undefined,
  ): Promise<PostEventResult | undefined> {
    if (sourceEventUuid === undefined) return undefined;
    const existing = await this.journalRepo.findBySourceEvent(tx, ctx.orgId, sourceEventUuid);
    if (existing === undefined || existing.entryNo === null) return undefined;
    return {
      journalId: existing.id,
      entryNo: existing.entryNo,
      duplicate: true,
      totalDebit: existing.totalDebitAmount,
    };
  }
}
