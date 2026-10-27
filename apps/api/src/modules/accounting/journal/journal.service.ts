import { asDb } from '../persistence/sql-support';
import type { SqlSession } from '../persistence/sql-support';
/** Journal application service: draft → validated → posted, reversal only (G5). */
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@saman/shared';
import { AUDIT, DB, EVENT_BUS } from '../../../common/contracts';
import type { AuditPort, Db, EventPort, TenantContext } from '../../../common/contracts';
import { ChartOfAccountsRepository } from '../coa/chart-of-accounts.repository';
import { FiscalCalendarRepository } from '../periods/fiscal-calendar.repository';
import { isPostingBlocked } from '../periods/fiscal-calendar';
import { JournalRepository } from './journal.repository';
import type { JournalFilter, JournalHeaderInput, JournalLineInput, JournalRecord } from './journal.repository';
import { normalisePagination } from '../persistence/sql-support';


export interface JournalLineDto {
  readonly accountId: bigint;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly description?: string;
  readonly partnerType?: string;
  readonly partnerId?: bigint;
  readonly taxRateId?: bigint;
}

export interface CreateJournalDto {
  readonly date: string;
  readonly description: string;
  readonly entryType?: string;
  readonly lines: readonly JournalLineDto[];
}

const JOURNAL_APPROVAL_THRESHOLD_SETTING = 'accounting.journal_approval_threshold';
const DEFAULT_APPROVAL_THRESHOLD = 100_000_000n;

@Injectable()
export class JournalService {
  constructor(
    private readonly repo: JournalRepository,
    private readonly coaRepo: ChartOfAccountsRepository,
    private readonly calendar: FiscalCalendarRepository,
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  list(ctx: TenantContext, filter: JournalFilter): Promise<readonly JournalRecord[]> {
    return this.repo.list(ctx.orgId, { ...filter, page: normalisePagination(filter.page ?? {}) });
  }

  /**
   * Accept the documented public uuid for account references (numeric ids remain
   * accepted for internal tooling/back-compat). Resolved before the domain sees it.
   */
  async resolveAccountId(ctx: TenantContext, ref: string | number): Promise<bigint> {
    const value = String(ref);
    if (/^\d+$/.test(value)) return BigInt(value);
    const internal = await this.coaRepo.idByPublicId(ctx.orgId, value);
    if (internal === null) throw new AppError('NOT_FOUND', { message: 'حساب حسابداری یافت نشد.' });
    return internal;
  }

  /** Resolve the API-facing public id to the internal key used by the journal aggregate. */
  async resolveId(ctx: TenantContext, publicId: string): Promise<bigint> {
    const internal = await this.repo.idByPublicId(ctx.orgId, publicId);
    if (internal === null) throw new AppError('NOT_FOUND', { message: 'سند حسابداری یافت نشد.' });
    return internal;
  }

  async get(ctx: TenantContext, id: bigint): Promise<JournalRecord> {
    const entry = await this.repo.findById(ctx.orgId, id);
    if (entry === undefined) throw new AppError('NOT_FOUND', { message: 'سند حسابداری یافت نشد.' });
    return entry;
  }

  /** Creates a manual draft; balance and period are validated on save. */
  async createDraft(ctx: TenantContext, dto: CreateJournalDto): Promise<JournalRecord> {
    const lines = await this.validateLines(ctx, dto.lines);
    const totals = this.totalsOf(lines);
    return this.db.begin(async (tx) => {
      const { period, year } = await this.calendar.resolveAndLockPeriod(tx, ctx.orgId, dto.date);
      if (year.status === 'closed') {
        throw new AppError('FISCAL_YEAR_CLOSED', { message: 'سال مالی بسته شده است.' });
      }
      if (isPostingBlocked(period.status)) {
        throw new AppError('PERIOD_CLOSED', { message: 'دوره مالی بسته شده است.' });
      }
      const entryType = dto.entryType ?? 'normal';
      if (period.periodNo === 13 && entryType !== 'adjustment') {
        throw new AppError('RULE_VIOLATION', {
          details: [{ rule: 'period_13_adjustment_only' }],
          message: 'در دوره ۱۳ تنها سند تعدیل قابل ثبت است.',
        });
      }
      const header: JournalHeaderInput = {
        orgId: ctx.orgId,
        fiscalYearId: period.fiscalYearId,
        periodId: period.id,
        entryDate: dto.date,
        entryType,
        description: dto.description,
        createdBy: ctx.actorId,
      };
      const id = await this.repo.insertEntry(tx, header, lines, totals, 'draft');
      await this.audit.record(asDb(tx), {
        action: 'accounting.journal.create',
        entityType: 'journal_entry',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { entryDate: dto.date, debit: totals.debit.toString(), credit: totals.credit.toString() },
      });
      const created = await this.repo.findById(ctx.orgId, id, tx);
      if (created === undefined) throw new AppError('NOT_FOUND', { message: 'سند حسابداری یافت نشد.' });
      return created;
    });
  }

  async updateDraft(
    ctx: TenantContext,
    id: bigint,
    input: { readonly description?: string; readonly date?: string; readonly lines?: readonly JournalLineDto[] },
    expectedVersion: number,
  ): Promise<JournalRecord> {
    const current = await this.get(ctx, id);
    if (current.status !== 'draft') {
      throw new AppError('DOCUMENT_STATE_INVALID', { message: 'تنها سند پیش‌نویس قابل ویرایش است.' });
    }
    return this.db.begin(async (tx) => {
      if (input.lines !== undefined) {
        const lines = await this.validateLines(ctx, input.lines);
        const totals = this.totalsOf(lines);
        await this.repo.replaceLines(tx, id, lines);
        await this.repo.updateTotals(tx, id, totals);
      }
      await this.repo.updateDraft(
        tx,
        id,
        {
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.date === undefined ? {} : { entryDate: input.date }),
        },
        expectedVersion,
      );
      await this.audit.record(asDb(tx), {
        action: 'accounting.journal.update',
        entityType: 'journal_entry',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        before: { description: current.description, lines: current.lines.length },
        after: { description: input.description ?? current.description },
      });
      const updated = await this.repo.findById(ctx.orgId, id, tx);
      if (updated === undefined) throw new AppError('NOT_FOUND', { message: 'سند حسابداری یافت نشد.' });
      return updated;
    });
  }

  async deleteDraft(ctx: TenantContext, id: bigint): Promise<void> {
    const current = await this.get(ctx, id);
    if (current.status !== 'draft') {
      throw new AppError('DOCUMENT_STATE_INVALID', { message: 'تنها سند پیش‌نویس قابل حذف است.' });
    }
    await this.db.begin(async (tx) => {
      await this.repo.deleteDraft(tx, id);
      await this.audit.record(asDb(tx), {
        action: 'accounting.journal.delete',
        entityType: 'journal_entry',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        before: { entryDate: current.entryDate, debit: current.totalDebitAmount.toString() },
      });
    });
  }

  async submit(ctx: TenantContext, id: bigint): Promise<JournalRecord> {
    const current = await this.get(ctx, id);
    if (current.status !== 'draft') {
      throw new AppError('DOCUMENT_STATE_INVALID', { message: 'سند در وضعیت پیش‌نویس نیست.' });
    }
    await this.db.begin(async (tx) => {
      await this.repo.setStatus(tx, id, ['draft'], 'pending_approval', ctx.actorId);
      await this.audit.record(asDb(tx), {
        action: 'accounting.journal.submit',
        entityType: 'journal_entry',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'accounting.journal.submitted',
        aggregateType: 'journal_entry',
        aggregateId: id,
        payload: { totalDebit: current.totalDebitAmount.toString() },
      });
    });
    return this.get(ctx, id);
  }

  /** Approve: separation of duties is enforced here and in the DB. */
  async approve(ctx: TenantContext, id: bigint, note?: string): Promise<JournalRecord> {
    const current = await this.get(ctx, id);
    if (current.status !== 'pending_approval') {
      throw new AppError('DOCUMENT_STATE_INVALID', { message: 'سند در وضعیت در انتظار تأیید نیست.' });
    }
    if (ctx.actorId !== null && current.createdBy !== null && ctx.actorId === current.createdBy) {
      throw new AppError('FORBIDDEN', { message: 'تأییدکننده سند نمی‌تواند ایجادکننده آن باشد.' });
    }
    await this.db.begin(async (tx) => {
      await this.repo.setStatus(tx, id, ['pending_approval'], 'approved', ctx.actorId);
      await this.audit.record(asDb(tx), {
        action: 'accounting.journal.approve',
        entityType: 'journal_entry',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { note: note ?? null },
      });
    });
    return this.get(ctx, id);
  }

  /**
   * Post: number + balances + immutability, all inside one transaction.
   *
   * TD-19: the effective period is derived from the **stored, server-validated**
   * `entry.entryDate` only. A caller-supplied posting date is deliberately
   * ignored for period resolution, so passing a date in an open period can never
   * bypass a closed period. The period row is locked `FOR UPDATE` inside this
   * transaction, so a concurrent close either wins (and this posting sees
   * `closed`/`locked`) or waits until this posting commits.
   */
  async post(ctx: TenantContext, id: bigint, _ignoredPostDate?: string): Promise<JournalRecord> {
    return this.db.begin(async (tx) => {
      const entry = await this.repo.findById(ctx.orgId, id, tx);
      if (entry === undefined) throw new AppError('NOT_FOUND', { message: 'سند حسابداری یافت نشد.' });
      if (entry.status === 'posted') {
        throw new AppError('DOCUMENT_STATE_INVALID', { message: 'سند قبلاً ثبت شده است.' });
      }
      if (entry.status === 'voided') {
        throw new AppError('DOCUMENT_STATE_INVALID', { message: 'سند ابطال‌شده قابل ثبت نیست.' });
      }
      if (entry.lines.length < 2) {
        throw new AppError('JOURNAL_UNBALANCED', {
          details: [{ rule: 'min_two_lines' }],
          message: 'سند حسابداری باید حداقل دو سطر داشته باشد.',
        });
      }
      const totals = this.totalsOf(entry.lines.map((line) => ({
        accountId: line.accountId,
        debit: line.debitAmount,
        credit: line.creditAmount,
      })));
      if (totals.debit !== totals.credit || totals.debit === 0n) {
        throw new AppError('JOURNAL_UNBALANCED', {
          details: [{ rule: 'debit_credit_equal' }],
          message: 'جمع بدهکار و بستانکار سند برابر نیست.',
        });
      }

      const threshold = await this.approvalThreshold(tx, ctx.orgId);
      if (totals.debit >= threshold && entry.status !== 'approved') {
        throw new AppError('APPROVAL_REQUIRED', {
          details: [{ rule: 'journal_above_threshold', params: { threshold: threshold.toString() } }],
          message: 'سند با مبلغ بالاتر از حد مجاز نیازمند تأیید است.',
        });
      }

      // Period resolution is derived from the persisted entry date, never from
      // the request body. The period row is locked for the rest of this tx.
      const { period, year } = await this.calendar.resolveAndLockPeriod(tx, ctx.orgId, entry.entryDate);
      if (year.status === 'closed') {
        throw new AppError('FISCAL_YEAR_CLOSED', { message: 'سال مالی بسته شده است.' });
      }
      if (isPostingBlocked(period.status)) {
        throw new AppError('PERIOD_CLOSED', {
          details: [{ rule: 'period_closed', params: { periodNo: period.periodNo } }],
          message: 'دوره مالی بسته شده است.',
        });
      }
      if (period.id !== entry.periodId) {
        await this.repo.assignPeriod(tx, id, period.id, period.fiscalYearId);
      }

      const entryNo = await this.repo.allocateEntryNo(tx, ctx.orgId, period.fiscalYearId, 'JV', 'JV');
      await this.repo.setEntryNo(tx, id, entryNo);
      await this.repo.updateTotals(tx, id, totals);
      await this.repo.setStatus(tx, id, ['draft', 'pending_approval', 'approved'], 'posted', ctx.actorId);
      await this.repo.applyBalances(tx, {
        orgId: ctx.orgId,
        fiscalYearId: period.fiscalYearId,
        periodId: period.id,
        lines: entry.lines.map((line) => ({
          accountId: line.accountId,
          debit: line.debitAmount,
          credit: line.creditAmount,
        })),
      });
      await this.audit.record(asDb(tx), {
        action: 'accounting.journal.post',
        entityType: 'journal_entry',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        before: { status: entry.status },
        after: { status: 'posted', entryNo, debit: totals.debit.toString() },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'accounting.journal.posted',
        aggregateType: 'journal_entry',
        aggregateId: id,
        payload: {
          entryNo,
          entryDate: entry.entryDate,
          totalDebit: totals.debit.toString(),
          sourceType: entry.sourceType,
          sourceId: entry.sourceId === null ? null : entry.sourceId.toString(),
        },
      });
      const posted = await this.repo.findById(ctx.orgId, id, tx);
      if (posted === undefined) throw new AppError('NOT_FOUND', { message: 'سند حسابداری یافت نشد.' });
      return posted;
    });
  }

  /**
   * Reversal service: posted entries are immutable, so a correction creates a
   * mirrored entry linked by `reversal_of_id` (`R1-accounting` H-11).
   */
  async reverse(
    ctx: TenantContext,
    id: bigint,
    input: { readonly reason: string; readonly reversalDate?: string },
  ): Promise<JournalRecord> {
    const original = await this.get(ctx, id);
    if (original.status !== 'posted') {
      throw new AppError('DOCUMENT_STATE_INVALID', { message: 'تنها سند ثبت‌شده قابل برگشت است.' });
    }
    if (original.reversalOfId !== null) {
      throw new AppError('DOCUMENT_STATE_INVALID', { message: 'سند برگشتی قابل برگشت مجدد نیست.' });
    }
    const reversalDate = input.reversalDate ?? original.entryDate;
    return this.db.begin(async (tx) => {
      const { period, year } = await this.calendar.resolveAndLockPeriod(tx, ctx.orgId, reversalDate);
      if (year.status === 'closed' || isPostingBlocked(period.status)) {
        throw new AppError('PERIOD_CLOSED', { message: 'دوره مالی برای تاریخ برگشت بسته است.' });
      }
      const lines: JournalLineInput[] = original.lines.map((line) => ({
        accountId: line.accountId,
        debitAmount: line.creditAmount,
        creditAmount: line.debitAmount,
        ...(line.description === null ? {} : { description: `برگشت: ${line.description}` }),
        ...(line.partnerType === null ? {} : { partnerType: line.partnerType }),
        ...(line.partnerId === null ? {} : { partnerId: line.partnerId }),
      }));
      const totals = this.totalsOf(lines);
      const reversalId = await this.repo.insertEntry(
        tx,
        {
          orgId: ctx.orgId,
          fiscalYearId: period.fiscalYearId,
          periodId: period.id,
          entryDate: reversalDate,
          entryType: 'reversal',
          description: `برگشت سند ${original.entryNo ?? original.id.toString()} - ${input.reason}`,
          sourceType: original.sourceType ?? 'journal_entry',
          ...(original.sourceId === null ? {} : { sourceId: original.sourceId }),
          createdBy: ctx.actorId,
        },
        lines,
        totals,
        'draft',
      );
      await tx`
        update erp.journal_entries set reversal_of_id = ${id.toString()}::bigint
         where id = ${reversalId.toString()}`;
      const entryNo = await this.repo.allocateEntryNo(tx, ctx.orgId, period.fiscalYearId, 'JV', 'JV');
      await this.repo.setEntryNo(tx, reversalId, entryNo);
      await this.repo.setStatus(tx, reversalId, ['draft'], 'posted', ctx.actorId);
      await this.repo.applyBalances(tx, {
        orgId: ctx.orgId,
        fiscalYearId: period.fiscalYearId,
        periodId: period.id,
        lines: lines.map((line) => ({ accountId: line.accountId, debit: line.debitAmount, credit: line.creditAmount })),
      });
      await tx`
        insert into erp.accounting_document_links
          (organization_id, document_type_code, source_type, source_id, journal_entry_id, link_role)
        values (${ctx.orgId.toString()}, 'JV', ${original.sourceType ?? 'journal_entry'},
                ${original.sourceId === null ? id.toString() : original.sourceId.toString()},
                ${reversalId.toString()}, 'reversal')`;
      await this.audit.record(asDb(tx), {
        action: 'accounting.journal.reverse',
        entityType: 'journal_entry',
        entityId: reversalId,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { reversalOf: id.toString(), reason: input.reason, entryNo },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'accounting.journal.reversed',
        aggregateType: 'journal_entry',
        aggregateId: reversalId,
        payload: { reversalOf: id.toString(), reason: input.reason },
      });
      const created = await this.repo.findById(ctx.orgId, reversalId, tx);
      if (created === undefined) throw new AppError('NOT_FOUND', { message: 'سند برگشتی یافت نشد.' });
      return created;
    });
  }

  /** Validates accounts exist, are postable and each line uses exactly one side. */
  private async validateLines(ctx: TenantContext, lines: readonly JournalLineDto[]): Promise<readonly JournalLineInput[]> {
    if (lines.length < 2) {
      throw new AppError('JOURNAL_UNBALANCED', {
        details: [{ rule: 'min_two_lines' }],
        message: 'سند حسابداری باید حداقل دو سطر داشته باشد.',
      });
    }
    const accounts = await this.coaRepo.findByIds(
      this.db,
      ctx.orgId,
      [...new Set(lines.map((line) => line.accountId.toString()))].map((value) => BigInt(value)),
    );
    for (const line of lines) {
      if ((line.debit > 0n) === (line.credit > 0n)) {
        throw new AppError('JOURNAL_UNBALANCED', {
          details: [{ rule: 'one_side_per_line', params: { accountId: line.accountId.toString() } }],
          message: 'هر سطر باید تنها یک طرف بدهکار یا بستانکار داشته باشد.',
        });
      }
      if (line.debit < 0n || line.credit < 0n) {
        throw new AppError('VALIDATION_ERROR', {
          details: [{ field: 'amount', rule: 'non_negative' }],
          message: 'مبلغ سطر نمی‌تواند منفی باشد.',
        });
      }
    }
    const totals = this.totalsOf(lines);
    if (totals.debit !== totals.credit || totals.debit === 0n) {
      throw new AppError('JOURNAL_UNBALANCED', {
        details: [
          {
            rule: 'debit_credit_equal',
            params: { debit: totals.debit.toString(), credit: totals.credit.toString() },
          },
        ],
        message: 'جمع بدهکار و بستانکار سند برابر نیست.',
      });
    }
    if (accounts.length !== new Set(lines.map((line) => line.accountId.toString())).size) {
      throw new AppError('NOT_FOUND', { message: 'یکی از حساب‌های سند یافت نشد.' });
    }
    const byId = new Map(accounts.map((account) => [account.id.toString(), account]));
    const result: JournalLineInput[] = [];
    for (const line of lines) {
      const account = byId.get(line.accountId.toString());
      if (account === undefined) throw new AppError('NOT_FOUND', { message: 'حساب سند یافت نشد.' });
      if (!account.isPostable) {
        throw new AppError('RULE_VIOLATION', {
          details: [{ rule: 'account_not_postable', params: { code: account.code } }],
          message: 'ثبت سند روی حساب غیرقابل‌ثبت مجاز نیست.',
        });
      }
      result.push({
        accountId: line.accountId,
        debitAmount: line.debit,
        creditAmount: line.credit,
        ...(line.description === undefined ? {} : { description: line.description }),
        ...(line.partnerType === undefined ? {} : { partnerType: line.partnerType }),
        ...(line.partnerId === undefined ? {} : { partnerId: line.partnerId }),
        ...(line.taxRateId === undefined ? {} : { taxRateId: line.taxRateId }),
      });
    }
    return result;
  }

  /** Sums either persisted lines (`debitAmount`) or draft pairs (`debit`). */
  private totalsOf(
    lines: readonly (JournalLineInput | { readonly debit: bigint; readonly credit: bigint })[],
  ): { debit: bigint; credit: bigint } {
    let debit = 0n;
    let credit = 0n;
    for (const line of lines) {
      if ('debit' in line) {
        debit += line.debit;
        credit += line.credit;
      } else {
        debit += line.debitAmount;
        credit += line.creditAmount;
      }
    }
    return { debit, credit };
  }

  private async approvalThreshold(tx: SqlSession, orgId: bigint): Promise<bigint> {
    const rows = await tx<{ value: string }[]>`
      select value_json #>> '{}' as value
        from erp.system_settings
       where organization_id = ${orgId.toString()}
         and key = ${JOURNAL_APPROVAL_THRESHOLD_SETTING}
       limit 1`;
    const raw = rows[0]?.value;
    if (raw === undefined) return DEFAULT_APPROVAL_THRESHOLD;
    try {
      return BigInt(raw);
    } catch {
      return DEFAULT_APPROVAL_THRESHOLD;
    }
  }
}
