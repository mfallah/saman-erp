/** Bank accounts, statement import and reconciliation service. */
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@saman/shared';
import { AUDIT, DB, EVENT_BUS } from '../../../common/contracts';
import type { AuditPort, Db, EventPort, TenantContext } from '../../../common/contracts';
import { BankRepository } from './bank.repository';
import type { BankAccountRecord, StatementLineRecord } from './bank.repository';
import { asDb, notFound, validation } from '../persistence/sql-support';

export interface ImportStatementInput {
  readonly bankAccountId: bigint;
  readonly statementNo: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly openingBalance: bigint;
  readonly closingBalance: bigint;
  readonly source: 'csv' | 'excel' | 'api' | 'manual';
  readonly fileId?: bigint;
  readonly lines: readonly {
    readonly lineNo: number;
    readonly valueDate: string;
    readonly direction: 'debit' | 'credit';
    readonly amount: bigint;
    readonly description?: string;
    readonly bankReference?: string;
  }[];
}

export interface MatchInput {
  readonly statementLineId: bigint;
  readonly paymentId?: bigint;
  readonly bankTransactionId?: bigint;
  readonly journalLineId?: bigint;
  readonly amount?: bigint;
  readonly notes?: string;
}

const RECONCILIATION_TOLERANCE = 1_000n;

@Injectable()
export class BankService {
  constructor(
    private readonly repo: BankRepository,
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  listAccounts(ctx: TenantContext, filter: { readonly active?: boolean; readonly bankName?: string }): Promise<readonly BankAccountRecord[]> {
    return this.repo.listAccounts(ctx.orgId, filter);
  }

  async getAccount(ctx: TenantContext, id: bigint): Promise<BankAccountRecord> {
    const account = await this.repo.findAccount(ctx.orgId, id);
    if (account === undefined) throw notFound('حساب بانکی');
    return account;
  }

  async createAccount(
    ctx: TenantContext,
    input: {
      readonly code: string;
      readonly bankName: string;
      readonly accountNo: string;
      readonly iban?: string;
      readonly glAccountId: bigint;
      readonly branchId?: bigint;
      readonly openingBalance?: bigint;
    },
  ): Promise<BankAccountRecord> {
    if ((input.iban ?? '').trim().length > 0 && !/^IR\d{24}$/.test((input.iban ?? '').trim())) {
      throw validation('شناسه شبا معتبر نیست.', 'iban', 'iran_iban');
    }
    return this.db.begin(async (tx) => {
      const id = await this.repo.insertAccount(tx, {
        orgId: ctx.orgId,
        code: input.code,
        bankName: input.bankName,
        accountNo: input.accountNo,
        ...(input.iban === undefined ? {} : { iban: input.iban }),
        glAccountId: input.glAccountId,
        ...(input.branchId === undefined ? {} : { branchId: input.branchId }),
        openingBalance: input.openingBalance ?? 0n,
        createdBy: ctx.actorId,
      });
      await this.audit.record(asDb(tx), {
        action: 'bank.account.create',
        entityType: 'bank_account',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { code: input.code, bankName: input.bankName },
      });
      const created = await this.repo.findAccount(ctx.orgId, id);
      if (created === undefined) throw notFound('حساب بانکی');
      return created;
    });
  }

  async updateAccount(
    ctx: TenantContext,
    id: bigint,
    input: { readonly bankName?: string; readonly glAccountId?: bigint; readonly isActive?: boolean },
    version: number,
  ): Promise<void> {
    await this.db.begin(async (tx) => {
      await this.repo.updateAccount(tx, ctx.orgId, id, input, version);
      await this.audit.record(asDb(tx), {
        action: 'bank.account.update',
        entityType: 'bank_account',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { ...input },
      });
    });
  }

  async deleteAccount(ctx: TenantContext, id: bigint): Promise<void> {
    await this.db.begin(async (tx) => {
      await this.repo.deleteAccount(tx, ctx.orgId, id);
      await this.audit.record(asDb(tx), {
        action: 'bank.account.delete',
        entityType: 'bank_account',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
      });
    });
  }

  /** Imports a parsed statement (header + lines) and stages it for matching. */
  async importStatement(ctx: TenantContext, input: ImportStatementInput): Promise<{ statementId: bigint; lineCount: number }> {
    if (input.lines.length === 0) throw validation('فایل صورت حساب هیچ سطری ندارد.', 'lines', 'required');
    if (input.periodEnd < input.periodStart) {
      throw validation('بازه صورت حساب معتبر نیست.', 'periodEnd', 'after_start');
    }
    return this.db.begin(async (tx) => {
      const statementId = await this.repo.insertStatement(tx, {
        orgId: ctx.orgId,
        bankAccountId: input.bankAccountId,
        statementNo: input.statementNo,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        openingBalance: input.openingBalance,
        closingBalance: input.closingBalance,
        source: input.source,
        ...(input.fileId === undefined ? {} : { fileId: input.fileId }),
        lineCount: input.lines.length,
        importedBy: ctx.actorId,
      });
      await this.repo.insertStatementLines(tx, statementId, input.lines);
      await this.audit.record(asDb(tx), {
        action: 'bank.statement.import',
        entityType: 'bank_statement',
        entityId: statementId,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { statementNo: input.statementNo, lineCount: input.lines.length },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'treasury.bank_statement.imported',
        aggregateType: 'bank_statement',
        aggregateId: statementId,
        payload: { lineCount: input.lines.length },
      });
      return { statementId, lineCount: input.lines.length };
    });
  }

  statementLines(ctx: TenantContext, statementId: bigint, matchStatus?: string): Promise<readonly StatementLineRecord[]> {
    void ctx;
    return this.repo.statementLines(statementId, { ...(matchStatus === undefined ? {} : { matchStatus }) });
  }

  async getStatement(ctx: TenantContext, statementId: bigint) {
    const statement = await this.repo.findStatement(ctx.orgId, statementId);
    if (statement === undefined) throw notFound('صورت حساب بانکی');
    return statement;
  }

  /** Starts a reconciliation from a statement and the current book balance. */
  async createReconciliation(ctx: TenantContext, input: { readonly bankAccountId: bigint; readonly statementId: bigint }): Promise<bigint> {
    return this.db.begin(async (tx) => {
      const statement = await this.repo.findStatement(ctx.orgId, input.statementId, tx);
      if (statement === undefined) throw notFound('صورت حساب بانکی');
      if (statement.bankAccountId !== input.bankAccountId) {
        throw validation('صورت حساب به این حساب بانکی تعلق ندارد.', 'statementId', 'account_mismatch');
      }
      if (statement.reconciliationId !== null) {
        throw new AppError('CONFLICT', { message: 'برای این صورت حساب قبلاً مغایرت‌گیری شروع شده است.' });
      }
      const bookClosing = await this.repo.bookBalance(tx, ctx.orgId, input.bankAccountId);
      const reconciliationNo = `REC-${input.statementId.toString()}-${Date.now()}`;
      const id = await this.repo.insertReconciliation(tx, {
        orgId: ctx.orgId,
        bankAccountId: input.bankAccountId,
        statementId: input.statementId,
        reconciliationNo,
        periodStart: statement.periodStart,
        periodEnd: statement.periodEnd,
        statementOpening: statement.openingBalance,
        statementClosing: statement.closingBalance,
        bookOpening: bookClosing,
        bookClosing,
        createdBy: ctx.actorId,
      });
      await this.audit.record(asDb(tx), {
        action: 'reconciliation.create',
        entityType: 'bank_reconciliation',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { statementId: input.statementId.toString(), bookClosing: bookClosing.toString() },
      });
      return id;
    });
  }

  async getReconciliation(ctx: TenantContext, id: bigint) {
    const reconciliation = await this.repo.findReconciliation(ctx.orgId, id);
    if (reconciliation === undefined) throw notFound('مغایرت‌گیری بانکی');
    return reconciliation;
  }

  /** Matches statement lines to payments/journal lines with an amount tolerance. */
  async match(ctx: TenantContext, id: bigint, items: readonly MatchInput[]): Promise<{ matched: number }> {
    return this.db.begin(async (tx) => {
      const reconciliation = await this.repo.findReconciliation(ctx.orgId, id);
      if (reconciliation === undefined) throw notFound('مغایرت‌گیری بانکی');
      if (reconciliation.status === 'completed') {
        throw new AppError('DOCUMENT_STATE_INVALID', { message: 'مغایرت‌گیری تکمیل‌شده قابل تغییر نیست.' });
      }
      for (const item of items) {
        const difference = item.amount === undefined ? 0n : item.amount - reconciliation.statementClosing;
        if (item.paymentId === undefined && item.bankTransactionId === undefined && item.journalLineId === undefined) {
          throw validation('هر تطبیق باید به یک پرداخت، تراکنش بانکی یا سطر سند متصل شود.', 'paymentId', 'required');
        }
        await this.repo.match(tx, {
          reconciliationId: id,
          statementLineId: item.statementLineId,
          ...(item.bankTransactionId === undefined ? {} : { bankTransactionId: item.bankTransactionId }),
          ...(item.paymentId === undefined ? {} : { paymentId: item.paymentId }),
          ...(item.journalLineId === undefined ? {} : { journalLineId: item.journalLineId }),
          difference,
          ...(item.notes === undefined ? {} : { notes: item.notes }),
        });
      }
      await this.audit.record(asDb(tx), {
        action: 'reconciliation.match',
        entityType: 'bank_reconciliation',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { matched: items.length },
      });
      return { matched: items.length };
    });
  }

  async unmatch(ctx: TenantContext, id: bigint, matchId: bigint): Promise<void> {
    await this.db.begin(async (tx) => {
      await this.repo.unmatch(tx, id, matchId);
      await this.audit.record(asDb(tx), {
        action: 'reconciliation.unmatch',
        entityType: 'bank_reconciliation',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
      });
    });
  }

  /** Completes only when the remaining difference is within tolerance. */
  async complete(
    ctx: TenantContext,
    id: bigint,
    input: { readonly note: string; readonly tolerance?: bigint },
  ): Promise<void> {
    return this.db.begin(async (tx) => {
      const reconciliation = await this.repo.findReconciliation(ctx.orgId, id);
      if (reconciliation === undefined) throw notFound('مغایرت‌گیری بانکی');
      await this.repo.completeReconciliation(tx, id, {
        difference: reconciliation.difference,
        actorId: ctx.actorId,
        note: input.note,
        tolerance: input.tolerance ?? RECONCILIATION_TOLERANCE,
      });
      await this.audit.record(asDb(tx), {
        action: 'reconciliation.complete',
        entityType: 'bank_reconciliation',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { difference: reconciliation.difference.toString(), note: input.note },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'treasury.reconciliation.completed',
        aggregateType: 'bank_reconciliation',
        aggregateId: id,
        payload: { difference: reconciliation.difference.toString() },
      });
    });
  }
}
