/**
 * Profit distribution run: only from a **closed** year's retained earnings, with
 * legal reserve/withholding handled by the pure policy module and the journal
 * posted in the same transaction (`R1-accounting` H-09, API §4.13).
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@saman/shared';
import { AUDIT, DB, EVENT_BUS } from '../../common/contracts';
import type { AuditPort, Db, EventPort, TenantContext } from '../../common/contracts';
import { PostingService } from '../accounting/posting/posting.service';
import { JournalService } from '../accounting/journal/journal.service';
import { FiscalCalendarRepository } from '../accounting/periods/fiscal-calendar.repository';
import { ClosingRepository } from '../accounting/closing/closing.repository';
import { asDb, notFound, validation } from '../treasury/persistence/sql-support';
import type { SqlSession } from '../accounting/persistence/sql-support';
import { computeDistribution } from './profit-distribution';
import { ProfitRepository } from './profit.repository';
import type { ProfitLineRecord, ProfitRunRecord } from './profit.repository';

export interface RunDistributionInput {
  readonly fiscalYearId: bigint;
  readonly policy: 'share_percent' | 'custom';
  readonly customShares?: readonly { readonly shareholderId: bigint; readonly ownershipPercent: string }[];
  readonly note?: string;
}

@Injectable()
export class ProfitDistributionService {
  constructor(
    private readonly repo: ProfitRepository,
    private readonly calendar: FiscalCalendarRepository,
    private readonly closing: ClosingRepository,
    private readonly posting: PostingService,
    private readonly journals: JournalService,
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  listRuns(ctx: TenantContext): Promise<readonly ProfitRunRecord[]> {
    return this.repo.listRuns(ctx.orgId);
  }

  async getRun(ctx: TenantContext, id: bigint): Promise<{ run: ProfitRunRecord; lines: readonly ProfitLineRecord[] }> {
    const run = await this.repo.assertExists(ctx.orgId, id);
    return { run, lines: await this.repo.lines(id) };
  }

  async run(ctx: TenantContext, input: RunDistributionInput): Promise<ProfitRunRecord> {
    return this.db.begin(async (tx) => {
      const year = await this.calendar.findYear(ctx.orgId, input.fiscalYearId, tx);
      if (year === undefined) throw notFound('سال مالی');
      const closingRun = await this.closing.findRun(ctx.orgId, input.fiscalYearId, tx);
      const retained = await this.repo.retainedBalance(tx, ctx.orgId, input.fiscalYearId);
      if (year.status !== 'closed') {
        throw new AppError('FISCAL_YEAR_CLOSED', {
          details: [{ rule: 'year_must_be_closed_before_distribution', params: { status: year.status } }],
          message: 'توزیع سود تنها پس از بستن سال مالی امکان‌پذیر است.',
        });
      }
      if (closingRun === undefined || closingRun.status !== 'posted') {
        throw new AppError('RULE_VIOLATION', {
          details: [{ rule: 'closing_run_required' }],
          message: 'اجرای بستن سال مالی باید ثبت شده باشد.',
        });
      }
      if (retained <= 0n) {
        throw new AppError('RULE_VIOLATION', {
          details: [{ rule: 'no_distributable_retained_earnings' }],
          message: 'سود انباشته قابل توزیع وجود ندارد.',
        });
      }
      const existing = await this.repo.findByYear(ctx.orgId, input.fiscalYearId);
      if (existing !== undefined) {
        throw new AppError('CONFLICT', { message: 'برای این سال مالی قبلاً اجرای توزیع سود ثبت شده است.' });
      }

      const shares = input.customShares ?? (await this.repo.activeShares(tx, ctx.orgId, year.endDate));
      const registeredCapital = await this.capitalBalance(tx, ctx);
      const computation = computeDistribution({
        distributableProfit: retained,
        shares,
        policy: {
          legalReservePercent: '0.05',
          legalReserveCapPercent: '0.10',
          registeredCapital,
          existingLegalReserve: closingRun.legalReserveAmount,
          withholdingPercent: '0',
        },
      });

      const runNo = `PD-${year.code}`;
      const runDate = new Date().toISOString().slice(0, 10);
      const runId = await this.repo.insertRun(tx, {
        orgId: ctx.orgId,
        fiscalYearId: input.fiscalYearId,
        runNo,
        runDate,
        totalProfit: computation.distributableProfit,
        distributed: computation.dividendsTotal,
        status: 'draft',
        ...(input.note === undefined ? {} : { note: input.note }),
        createdBy: ctx.actorId,
      });
      await this.repo.insertLines(
        tx,
        runId,
        computation.lines.map((line) => ({
          shareholderId: line.shareholderId,
          ownershipPercent: line.ownershipPercent,
          shareAmount: line.shareAmount,
        })),
      );
      await this.audit.record(asDb(tx), {
        action: 'profit.distribution.run',
        entityType: 'profit_distribution',
        entityId: runId,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: {
          fiscalYearId: input.fiscalYearId.toString(),
          retained: retained.toString(),
          legalReserve: computation.legalReserve.toString(),
          dividends: computation.dividendsTotal.toString(),
          lines: computation.lines.length,
        },
      });
      const run = await this.repo.assertExists(ctx.orgId, runId);
      return run;
    });
  }

  async approve(ctx: TenantContext, id: bigint, note?: string): Promise<ProfitRunRecord> {
    await this.db.begin(async (tx) => {
      await this.repo.setStatus(tx, id, ['draft', 'pending_approval'], 'approved');
      await this.repo.markLinesApproved(tx, id);
      await this.audit.record(asDb(tx), {
        action: 'profit.distribution.approve',
        entityType: 'profit_distribution',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { note: note ?? null },
      });
    });
    return this.repo.assertExists(ctx.orgId, id);
  }

  /** Posts: Dr retained earnings / Cr dividends payable (+ reserve/withholding). */
  async post(ctx: TenantContext, id: bigint): Promise<{ run: ProfitRunRecord; journalEntryId: bigint }> {
    return this.db.begin(async (tx) => {
      const run = await this.repo.assertExists(ctx.orgId, id);
      if (run.status !== 'approved') {
        throw new AppError('DOCUMENT_STATE_INVALID', { message: 'توزیع سود باید ابتدا تأیید شود.' });
      }
      const lines = await this.repo.lines(id);
      const dividends = lines.reduce((total, line) => total + line.shareAmount, 0n);
      const posted = await this.posting.postEvent(tx, ctx, {
        eventType: 'profit.distribution.approved',
        payload: {
          totalProfitAmount: run.totalProfitAmount.toString(),
          dividendsAmount: dividends.toString(),
          legalReserveAmount: '0',
          withholdingAmount: '0',
          retainedAmount: (run.totalProfitAmount - dividends).toString(),
        },
        context: { entryDate: run.runDate },
        sourceId: id,
      });
      await this.repo.setStatus(tx, id, ['approved'], 'posted', { journalEntryId: posted.journalId });
      await this.audit.record(asDb(tx), {
        action: 'profit.distribution.post',
        entityType: 'profit_distribution',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { journalEntryId: posted.journalId.toString(), dividends: dividends.toString() },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'partners.profit_distribution.posted',
        aggregateType: 'profit_distribution',
        aggregateId: id,
        payload: { dividends: dividends.toString(), journalEntryId: posted.journalId.toString() },
      });
      return { run: await this.repo.assertExists(ctx.orgId, id), journalEntryId: posted.journalId };
    });
  }

  /** Reversal creates a mirrored journal; the run is marked cancelled. */
  async reverse(ctx: TenantContext, id: bigint, reason: string): Promise<ProfitRunRecord> {
    const run = await this.repo.assertExists(ctx.orgId, id);
    if (run.journalEntryId === null) {
      throw new AppError('DOCUMENT_STATE_INVALID', { message: 'این توزیع سود سند ثبت‌شده ندارد.' });
    }
    await this.journals.reverse(ctx, run.journalEntryId, { reason });
    await this.db.begin(async (tx) => {
      await this.repo.setStatus(tx, id, ['posted'], 'cancelled');
      await this.audit.record(asDb(tx), {
        action: 'profit.distribution.reverse',
        entityType: 'profit_distribution',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { reason, journalEntryId: run.journalEntryId?.toString() ?? null },
      });
    });
    return this.repo.assertExists(ctx.orgId, id);
  }

  /** Marks distribution lines paid when the dividend payment is executed. */
  async markPaid(ctx: TenantContext, id: bigint, paymentId: bigint): Promise<void> {
    await this.db.begin(async (tx) => {
      await this.repo.markLinesPaid(tx, id, paymentId);
      await this.audit.record(asDb(tx), {
        action: 'profit.distribution.paid',
        entityType: 'profit_distribution',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { paymentId: paymentId.toString() },
      });
    });
  }

  private async capitalBalance(tx: SqlSession, ctx: TenantContext): Promise<bigint> {
    const rows = await tx<{ balance: string }[]>`
      select coalesce(sum(closing_credit_amount - closing_debit_amount), 0)::text as balance
        from erp.account_balances b join erp.chart_of_accounts a on a.id = b.account_id
       where b.organization_id = ${ctx.orgId.toString()} and a.code = '3-1-01-001'`;
    const value = BigInt(rows[0]?.balance ?? '0');
    if (value < 0n) throw validation('مانده سرمایه ثبت‌شده معتبر نیست.', 'capital', 'negative');
    return value;
  }
}
