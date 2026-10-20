import { asDb } from '../persistence/sql-support';
import type { SqlSession } from '../persistence/sql-support';
/** Fiscal year / period application service (Jalali period generation, lock). */
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@saman/shared';
import { AUDIT, DB, EVENT_BUS } from '../../../common/contracts';
import type { AuditPort, Db, EventPort, TenantContext } from '../../../common/contracts';
import { assertPeriodAcceptsEntryType, buildAdjustmentPeriod, generateMonthlyPeriods, isPostingBlocked } from './fiscal-calendar';
import { FiscalCalendarRepository } from './fiscal-calendar.repository';
import type { FiscalYearRecord, PeriodRecord } from './fiscal-calendar.repository';

export interface CreateFiscalYearInput {
  readonly startDate: string;
  readonly endDate: string;
  readonly title: string;
  readonly code?: string;
  readonly periodType?: 'monthly';
}

@Injectable()
export class FiscalCalendarService {
  constructor(
    private readonly repo: FiscalCalendarRepository,
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  listYears(ctx: TenantContext, status?: string): Promise<readonly FiscalYearRecord[]> {
    return this.repo.listYears(ctx.orgId, status);
  }

  async getYear(ctx: TenantContext, id: bigint): Promise<{ year: FiscalYearRecord; periods: readonly PeriodRecord[] }> {
    const year = await this.repo.findYear(ctx.orgId, id);
    if (year === undefined) throw new AppError('NOT_FOUND', { message: 'سال مالی یافت نشد.' });
    const periods = await this.repo.listPeriods(id);
    return { year, periods };
  }

  listPeriods(ctx: TenantContext, fiscalYearId: bigint, status?: string): Promise<readonly PeriodRecord[]> {
    return this.repo.listPeriods(fiscalYearId, undefined, status);
  }

  /** Creates a fiscal year and its Jalali monthly periods in one transaction. */
  async createYear(
    ctx: TenantContext,
    input: CreateFiscalYearInput,
  ): Promise<{ year: FiscalYearRecord; periods: readonly PeriodRecord[] }> {
    const periods = generateMonthlyPeriods(input.startDate, input.endDate);
    const code = input.code ?? String(input.startDate.slice(0, 4));
    return this.db.begin(async (tx) => {
      await this.repo.assertNoOverlap(tx, ctx.orgId, input.startDate, input.endDate);
      const year = await this.repo.insertYear(tx, {
        orgId: ctx.orgId,
        code,
        title: input.title,
        startDate: input.startDate,
        endDate: input.endDate,
        createdBy: ctx.actorId,
      });
      const created = await this.repo.insertPeriods(tx, year.id, periods);
      await this.audit.record(asDb(tx), {
        action: 'accounting.fiscal_year.create',
        entityType: 'fiscal_year',
        entityId: year.id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { code: year.code, startDate: year.startDate, endDate: year.endDate, periods: created.length },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'accounting.fiscal_year.created',
        aggregateType: 'fiscal_year',
        aggregateId: year.id,
        payload: { code: year.code, periods: created.length },
      });
      return { year, periods: created };
    });
  }

  /** Period 13 (adjustments) is created explicitly, never generated. */
  async addAdjustmentPeriod(ctx: TenantContext, fiscalYearId: bigint): Promise<PeriodRecord> {
    return this.db.begin(async (tx) => {
      const year = await this.repo.lockYear(tx, ctx.orgId, fiscalYearId);
      const existing = await this.repo.listPeriods(fiscalYearId, tx);
      if (existing.some((period) => period.periodNo === 13)) {
        throw new AppError('CONFLICT', { message: 'دوره تعدیل برای این سال مالی وجود دارد.' });
      }
      const adjustment = buildAdjustmentPeriod(year.endDate);
      const [created] = await this.repo.insertPeriods(tx, fiscalYearId, [adjustment]);
      if (created === undefined) throw new AppError('CONFLICT', { message: 'ایجاد دوره تعدیل انجام نشد.' });
      await this.audit.record(asDb(tx), {
        action: 'accounting.period.create_adjustment',
        entityType: 'accounting_period',
        entityId: created.id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { fiscalYearId: fiscalYearId.toString(), periodNo: 13 },
      });
      return created;
    });
  }

  async closePeriod(ctx: TenantContext, periodId: bigint, note?: string): Promise<PeriodRecord> {
    const period = await this.repo.findPeriod(periodId);
    if (period === undefined) throw new AppError('NOT_FOUND', { message: 'دوره مالی یافت نشد.' });
    return this.db.begin(async (tx) => {
      const year = await this.repo.lockYear(tx, ctx.orgId, period.fiscalYearId);
      if (year.status === 'closed') {
        throw new AppError('FISCAL_YEAR_CLOSED', { message: 'سال مالی بسته شده است.' });
      }
      await this.repo.updatePeriodStatus(tx, periodId, 'closed', ctx.actorId);
      await this.audit.record(asDb(tx), {
        action: 'accounting.period.close',
        entityType: 'accounting_period',
        entityId: periodId,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        before: { status: period.status },
        after: { status: 'closed', note: note ?? null },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'accounting.period.closed',
        aggregateType: 'accounting_period',
        aggregateId: periodId,
        payload: { fiscalYearId: period.fiscalYearId.toString(), periodNo: period.periodNo },
      });
      const updated = await this.repo.findPeriod(periodId);
      if (updated === undefined) throw new AppError('NOT_FOUND', { message: 'دوره مالی یافت نشد.' });
      return updated;
    });
  }

  /** Reopen requires a reason of at least 30 characters (API §4.11) + audit. */
  async reopenPeriod(ctx: TenantContext, periodId: bigint, reason: string): Promise<PeriodRecord> {
    if (reason.trim().length < 30) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'reason', rule: 'min_length_30' }],
        message: 'دلیل بازگشایی دوره باید حداقل ۳۰ نویسه باشد.',
      });
    }
    const period = await this.repo.findPeriod(periodId);
    if (period === undefined) throw new AppError('NOT_FOUND', { message: 'دوره مالی یافت نشد.' });
    return this.db.begin(async (tx) => {
      const year = await this.repo.lockYear(tx, ctx.orgId, period.fiscalYearId);
      if (year.status === 'closed') {
        throw new AppError('FISCAL_YEAR_CLOSED', { message: 'برای بازگشایی دوره، ابتدا سال مالی باید بازگشایی شود.' });
      }
      await this.repo.updatePeriodStatus(tx, periodId, 'open', ctx.actorId);
      await this.audit.record(asDb(tx), {
        action: 'accounting.period.reopen',
        entityType: 'accounting_period',
        entityId: periodId,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        before: { status: period.status },
        after: { status: 'open', reason },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'accounting.period.reopened',
        aggregateType: 'accounting_period',
        aggregateId: periodId,
        payload: { reason },
      });
      const updated = await this.repo.findPeriod(periodId);
      if (updated === undefined) throw new AppError('NOT_FOUND', { message: 'دوره مالی یافت نشد.' });
      return updated;
    });
  }

  /**
   * Year close: blocked while any period is open or any journal is unposted.
   * The closing run itself is executed by `ClosingService` before this call.
   */
  async closeYear(ctx: TenantContext, fiscalYearId: bigint, note: string): Promise<FiscalYearRecord> {
    return this.db.begin(async (tx) => {
      const year = await this.repo.lockYear(tx, ctx.orgId, fiscalYearId);
      if (year.status === 'closed') {
        throw new AppError('FISCAL_YEAR_CLOSED', { message: 'سال مالی قبلاً بسته شده است.' });
      }
      const openPeriods = await this.repo.countOpenPeriods(tx, fiscalYearId);
      if (openPeriods > 0) {
        throw new AppError('RULE_VIOLATION', {
          details: [{ rule: 'open_periods', params: { count: openPeriods } }],
          message: 'پیش از بستن سال مالی، همه دوره‌ها باید بسته شوند.',
        });
      }
      const unposted = await this.repo.countUnpostedJournals(tx, fiscalYearId);
      if (unposted > 0) {
        throw new AppError('RULE_VIOLATION', {
          details: [{ rule: 'unposted_journals', params: { count: unposted } }],
          message: 'سند ثبت‌نشده در سال مالی وجود دارد.',
        });
      }
      if (year.closingRunId === null) {
        throw new AppError('RULE_VIOLATION', {
          details: [{ rule: 'closing_run_required' }],
          message: 'اجرای سند بستن سال مالی الزامی است.',
        });
      }
      await this.repo.updateYearStatus(tx, fiscalYearId, 'closed', ctx.actorId);
      await this.audit.record(asDb(tx), {
        action: 'accounting.fiscal_year.close',
        entityType: 'fiscal_year',
        entityId: fiscalYearId,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        before: { status: year.status },
        after: { status: 'closed', note },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'accounting.fiscal_year.closed',
        aggregateType: 'fiscal_year',
        aggregateId: fiscalYearId,
        payload: { code: year.code },
      });
      const updated = await this.repo.findYear(ctx.orgId, fiscalYearId, tx);
      if (updated === undefined) throw new AppError('NOT_FOUND', { message: 'سال مالی یافت نشد.' });
      return updated;
    });
  }

  /** Reopen a closed year: superadmin only (guard), reason mandatory, audited. */
  async reopenYear(ctx: TenantContext, fiscalYearId: bigint, reason: string): Promise<FiscalYearRecord> {
    if (reason.trim().length < 30) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'reason', rule: 'min_length_30' }],
        message: 'دلیل بازگشایی سال مالی باید حداقل ۳۰ نویسه باشد.',
      });
    }
    return this.db.begin(async (tx) => {
      const year = await this.repo.lockYear(tx, ctx.orgId, fiscalYearId);
      if (year.status !== 'closed') {
        throw new AppError('RULE_VIOLATION', {
          details: [{ rule: 'year_not_closed' }],
          message: 'تنها سال مالی بسته‌شده قابل بازگشایی است.',
        });
      }
      await this.repo.updateYearStatus(tx, fiscalYearId, 'open', ctx.actorId);
      const periods = await this.repo.listPeriods(fiscalYearId, tx);
      const last = periods[periods.length - 1];
      if (last !== undefined) {
        await this.repo.updatePeriodStatus(tx, last.id, 'open', ctx.actorId);
      }
      await this.audit.record(asDb(tx), {
        action: 'accounting.fiscal_year.reopen',
        entityType: 'fiscal_year',
        entityId: fiscalYearId,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        before: { status: year.status },
        after: { status: 'open', reason },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'accounting.fiscal_year.reopened',
        aggregateType: 'fiscal_year',
        aggregateId: fiscalYearId,
        payload: { reason },
      });
      const updated = await this.repo.findYear(ctx.orgId, fiscalYearId, tx);
      if (updated === undefined) throw new AppError('NOT_FOUND', { message: 'سال مالی یافت نشد.' });
      return updated;
    });
  }

  /** Posting guard shared by every money flow: rejects closed/locked periods. */
  async assertPostable(tx: SqlSession, orgId: bigint, entryDate: string, entryType: string): Promise<void> {
    const { period, year } = await this.repo.resolveAndLockPeriod(tx, orgId, entryDate);
    if (year.status === 'closed') {
      throw new AppError('FISCAL_YEAR_CLOSED', { message: 'سال مالی بسته شده است و ثبت سند مجاز نیست.' });
    }
    if (isPostingBlocked(period.status)) {
      throw new AppError('PERIOD_CLOSED', {
        details: [{ rule: 'period_closed', params: { periodId: period.id.toString(), status: period.status } }],
        message: 'دوره مالی مربوطه بسته شده است.',
      });
    }
    assertPeriodAcceptsEntryType(period.periodNo, entryType);
  }

  resolvePeriod(ctx: TenantContext, entryDate: string): Promise<{ period: PeriodRecord; year: FiscalYearRecord }> {
    return this.repo.resolveAndLockPeriod(this.db, ctx.orgId, entryDate);
  }
}
