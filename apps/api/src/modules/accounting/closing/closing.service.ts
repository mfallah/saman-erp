import { asDb } from '../persistence/sql-support';
import type { SqlSession } from '../persistence/sql-support';
/**
 * Closing service (`DATA-MODEL §6.10.3`, R1-accounting B-08).
 *
 * One transaction: guard → close periods except the last → post income summary →
 * post retained earnings + legal reserve → write the run → link it to the fiscal
 * year → generate next-year opening entries. Profit distribution is only allowed
 * afterwards and only against retained earnings.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@saman/shared';
import { AUDIT, DB, EVENT_BUS } from '../../../common/contracts';
import type { AuditPort, Db, EventPort, TenantContext } from '../../../common/contracts';
import { ACCOUNTS } from '../posting/accounts';
import { computeClosing } from '../posting/closing.rules';
import { buildDraft, credit, debit } from '../posting/types';
import type { PostingDraft } from '../posting/types';
import { PostingService } from '../posting/posting.service';
import { FiscalCalendarRepository } from '../periods/fiscal-calendar.repository';
import { ClosingRepository } from './closing.repository';
import type { ClosingRunRecord } from './closing.repository';

export interface ClosingRunResult {
  readonly run: ClosingRunRecord;
  readonly netProfit: bigint;
  readonly legalReserve: bigint;
  readonly retainedAmount: bigint;
  readonly incomeSummaryJournalId: bigint;
  readonly retainedEarningsJournalId: bigint;
  readonly openingEntryId: bigint | null;
}

@Injectable()
export class ClosingService {
  constructor(
    private readonly repo: ClosingRepository,
    private readonly calendar: FiscalCalendarRepository,
    private readonly posting: PostingService,
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  getRun(ctx: TenantContext, fiscalYearId: bigint): Promise<ClosingRunRecord | undefined> {
    return this.repo.findRun(ctx.orgId, fiscalYearId);
  }

  listRuns(ctx: TenantContext): Promise<readonly ClosingRunRecord[]> {
    return this.repo.listRuns(ctx.orgId);
  }

  async run(ctx: TenantContext, fiscalYearId: bigint, note?: string): Promise<ClosingRunResult> {
    return this.db.begin(async (tx) => {
      const year = await this.calendar.lockYear(tx, ctx.orgId, fiscalYearId);
      if (year.status === 'closed') {
        throw new AppError('FISCAL_YEAR_CLOSED', { message: 'سال مالی بسته شده است.' });
      }
      const existing = await this.repo.findRun(ctx.orgId, fiscalYearId, tx);
      if (existing !== undefined && existing.status === 'posted') {
        throw new AppError('CONFLICT', { message: 'اجرای بستن این سال مالی قبلاً ثبت شده است.' });
      }
      const unposted = await this.calendar.countUnpostedJournals(tx, fiscalYearId);
      if (unposted > 0) {
        throw new AppError('RULE_VIOLATION', {
          details: [{ rule: 'unposted_journals', params: { count: unposted } }],
          message: 'سند ثبت‌نشده در سال مالی وجود دارد؛ ابتدا آن‌ها را ثبت کنید.',
        });
      }

      const periods = await this.calendar.listPeriods(fiscalYearId, tx);
      const open = periods.filter((period) => period.status === 'open');
      if (open.length === 0) {
        throw new AppError('RULE_VIOLATION', {
          details: [{ rule: 'no_open_period_for_closing' }],
          message: 'دوره باز برای ثبت سند بستن وجود ندارد.',
        });
      }
      const lastPeriod = periods[periods.length - 1];
      if (lastPeriod === undefined) throw new AppError('NOT_FOUND', { message: 'دوره مالی یافت نشد.' });
      // close every period except the last; closing entries post into the last one
      for (const period of open) {
        if (period.id === lastPeriod.id) continue;
        await this.calendar.updatePeriodStatus(tx, period.id, 'closed', ctx.actorId);
      }

      const { revenue, expenses } = await this.repo.pnlBalances(tx, ctx.orgId, fiscalYearId);
      if (revenue.length === 0 && expenses.length === 0) {
        throw new AppError('RULE_VIOLATION', {
          details: [{ rule: 'no_pnl_balances' }],
          message: 'حساب درآمد یا هزینه‌ای برای بستن وجود ندارد.',
        });
      }
      const capital = await this.repo.accountClosingBalance(tx, ctx.orgId, fiscalYearId, ACCOUNTS.registeredCapital);
      const registeredCapital = capital.credit - capital.debit;
      const reserveBalance = await this.repo.accountClosingBalance(tx, ctx.orgId, fiscalYearId, ACCOUNTS.legalReserve);
      const existingReserve = reserveBalance.credit - reserveBalance.debit;

      const computation = computeClosing({
        revenueBalances: revenue,
        expenseBalances: expenses,
        registeredCapital,
        existingLegalReserve: existingReserve < 0n ? 0n : existingReserve,
        legalReservePercent: '0.05',
        legalReserveCapPercent: '0.10',
      });

      const runNo = `FY-${year.code}-CLOSE`;
      const runRecord = await this.repo.createRun(tx, {
        orgId: ctx.orgId,
        fiscalYearId,
        runNo,
        netProfit: computation.netProfit,
        legalReservePercent: '0.05',
        legalReserveCapPercent: '0.10',
        legalReserve: computation.legalReserve,
        retained: computation.retainedAmount,
        createdBy: ctx.actorId,
      });

      const summaryDraft: PostingDraft = buildDraft(
        {
          eventType: 'closing.income_summary',
          entryType: 'closing',
          entryDate: lastPeriod.endDate,
          descriptionFa: `سند بستن درآمد و هزینه سال ${year.code}`,
          sourceType: 'closing_run',
          sourceId: runRecord.id,
        },
        computation.incomeSummaryLegs,
      );
      const summary = await this.posting.postDraft(tx, ctx, summaryDraft);

      const retainedLegs = computation.netProfit === 0n ? [] : computation.retainedEarningsLegs;
      let retainedJournalId = 0n;
      if (retainedLegs.length > 0) {
        const retainedDraft: PostingDraft = buildDraft(
          {
            eventType: 'closing.retained_earnings',
            entryType: 'closing',
            entryDate: lastPeriod.endDate,
            descriptionFa: `انتقال سود/زیان و اندوخته قانونی سال ${year.code}`,
            sourceType: 'closing_run',
            sourceId: runRecord.id,
          },
          retainedLegs,
        );
        const retained = await this.posting.postDraft(tx, ctx, retainedDraft);
        retainedJournalId = retained.journalId;
      } else {
        // zero-result year: no retained entry, keep the run consistent
        retainedJournalId = summary.journalId;
      }

      await this.repo.markPosted(
        tx,
        runRecord.id,
        {
          incomeSummaryEntryId: summary.journalId,
          retainedEarningsEntryId: retainedJournalId,
          legalReserveEntryId: retainedJournalId,
        },
        ctx.actorId,
      );
      await this.calendar.setClosingRun(tx, fiscalYearId, runRecord.id);

      const openingEntryId = await this.generateOpeningEntriesTx(tx, ctx, fiscalYearId);

      await this.audit.record(asDb(tx), {
        action: 'accounting.closing.run',
        entityType: 'closing_run',
        entityId: runRecord.id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: {
          fiscalYearId: fiscalYearId.toString(),
          netProfit: computation.netProfit.toString(),
          legalReserve: computation.legalReserve.toString(),
          retained: computation.retainedAmount.toString(),
          note: note ?? null,
        },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'accounting.fiscal_year.closing_posted',
        aggregateType: 'closing_run',
        aggregateId: runRecord.id,
        payload: {
          fiscalYearId: fiscalYearId.toString(),
          netProfit: computation.netProfit.toString(),
          legalReserve: computation.legalReserve.toString(),
        },
      });

      const postedRun = await this.repo.findRun(ctx.orgId, fiscalYearId, tx);
      if (postedRun === undefined) throw new AppError('NOT_FOUND', { message: 'اجرای بستن یافت نشد.' });
      return {
        run: postedRun,
        netProfit: computation.netProfit,
        legalReserve: computation.legalReserve,
        retainedAmount: computation.retainedAmount,
        incomeSummaryJournalId: summary.journalId,
        retainedEarningsJournalId: retainedJournalId,
        openingEntryId,
      };
    });
  }

  /**
   * Generates the next fiscal year's opening entry from the balance-sheet closing
   * balances. Idempotent per fiscal year (`fiscal_years.opening_entry_id`).
   */
  async generateOpeningEntries(ctx: TenantContext, fiscalYearId: bigint): Promise<bigint | null> {
    return this.db.begin(async (tx) => this.generateOpeningEntriesTx(tx, ctx, fiscalYearId));
  }

  private async generateOpeningEntriesTx(tx: SqlSession, ctx: TenantContext, fiscalYearId: bigint): Promise<bigint | null> {
    const years = await this.calendar.listYears(ctx.orgId);
    const current = years.find((year) => year.id === fiscalYearId);
    if (current === undefined) return null;
    const next = years.find((year) => year.startDate > current.startDate && year.status === 'open');
    if (next === undefined) return null;

    const nextRows = await tx<{ opening_entry_id: string | null }[]>`
      select opening_entry_id::text as opening_entry_id from erp.fiscal_years where id = ${next.id.toString()}`;
    if (nextRows[0]?.opening_entry_id !== null && nextRows[0]?.opening_entry_id !== undefined) {
      return BigInt(nextRows[0].opening_entry_id);
    }

    const balances = await this.repo.balanceSheetBalances(tx, ctx.orgId, fiscalYearId);
    if (balances.length === 0) return null;
    const legs = balances.flatMap((row) => {
      const net = row.debit - row.credit;
      if (net === 0n) return [];
      return net > 0n
        ? [debit(row.accountCode, net, 'مانده افتتاحیه')]
        : [credit(row.accountCode, -net, 'مانده افتتاحیه')];
    });
    if (legs.length === 0) return null;

    const draft: PostingDraft = buildDraft(
      {
        eventType: 'opening.balances.imported',
        entryType: 'opening',
        entryDate: next.startDate,
        descriptionFa: `سند افتتاحیه سال ${next.code}`,
        sourceType: 'fiscal_year',
        sourceId: next.id,
      },
      legs,
    );
    const posted = await this.posting.postDraft(tx, ctx, draft);
    await tx`
      update erp.fiscal_years set opening_entry_id = ${posted.journalId.toString()}::bigint, version = version + 1
       where id = ${next.id.toString()}`;
    await this.audit.record(asDb(tx), {
      action: 'accounting.opening_entries.generate',
      entityType: 'fiscal_year',
      entityId: next.id,
      orgId: ctx.orgId,
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      after: { journalEntryId: posted.journalId.toString(), sourceYear: current.code },
    });
    return posted.journalId;
  }
}
