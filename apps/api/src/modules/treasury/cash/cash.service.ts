/** Cash boxes, shift sessions (open/close + variance) and cash transactions. */
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@saman/shared';
import { AUDIT, DB, EVENT_BUS } from '../../../common/contracts';
import type { AuditPort, Db, EventPort, TenantContext } from '../../../common/contracts';
import type { PostingService } from '../../accounting/posting/posting.service';
import type { CashRepository } from './cash.repository';
import type { CashBoxRecord, CashSessionRecord, CashTransactionRecord } from './cash.repository';
import { asDb, notFound, validation } from '../persistence/sql-support';

export interface CashTransactionInput {
  readonly cashBoxId: bigint;
  readonly sessionId?: bigint;
  readonly type: 'receipt' | 'payment';
  readonly amount: bigint;
  readonly date: string;
  readonly partyType?: 'customer' | 'supplier' | 'shareholder' | 'other';
  readonly partyId?: bigint;
  readonly description?: string;
}

@Injectable()
export class CashService {
  constructor(
    private readonly repo: CashRepository,
    private readonly posting: PostingService,
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  listBoxes(ctx: TenantContext, filter: { readonly active?: boolean; readonly branchId?: bigint }): Promise<readonly CashBoxRecord[]> {
    return this.repo.listBoxes(ctx.orgId, filter);
  }

  async createBox(
    ctx: TenantContext,
    input: { readonly code: string; readonly nameFa: string; readonly branchId?: bigint; readonly glAccountId: bigint },
  ): Promise<CashBoxRecord> {
    return this.db.begin(async (tx) => {
      const id = await this.repo.insertBox(tx, {
        orgId: ctx.orgId,
        code: input.code,
        nameFa: input.nameFa,
        ...(input.branchId === undefined ? {} : { branchId: input.branchId }),
        glAccountId: input.glAccountId,
        createdBy: ctx.actorId,
      });
      await this.audit.record(asDb(tx), {
        action: 'cash.create',
        entityType: 'cash_account',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { code: input.code, nameFa: input.nameFa },
      });
      const box = await this.repo.findBox(ctx.orgId, id, tx);
      if (box === undefined) throw notFound('صندوق');
      return box;
    });
  }

  listSessions(
    ctx: TenantContext,
    filter: { readonly cashAccountId?: bigint; readonly status?: string; readonly openedFrom?: string },
  ): Promise<readonly CashSessionRecord[]> {
    return this.repo.listSessions(ctx.orgId, filter);
  }

  async getSession(ctx: TenantContext, id: bigint): Promise<CashSessionRecord> {
    const session = await this.repo.findSession(ctx.orgId, id);
    if (session === undefined) throw notFound('شیفت صندوق');
    return session;
  }

  async openSession(
    ctx: TenantContext,
    input: { readonly cashBoxId: bigint; readonly openingBalance: bigint },
  ): Promise<CashSessionRecord> {
    if (input.openingBalance < 0n) throw validation('موجودی اولیه صندوق نمی‌تواند منفی باشد.', 'openingBalance', 'non_negative');
    return this.db.begin(async (tx) => {
      const box = await this.repo.findBox(ctx.orgId, input.cashBoxId, tx);
      if (box === undefined) throw notFound('صندوق');
      const sessionNo = `${box.code}-${Date.now()}`;
      const id = await this.repo.openSession(tx, {
        cashAccountId: input.cashBoxId,
        sessionNo,
        openingFloat: input.openingBalance,
        openedBy: ctx.actorId,
      });
      await this.audit.record(asDb(tx), {
        action: 'cash.session.open',
        entityType: 'cash_session',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { sessionNo, openingBalance: input.openingBalance.toString() },
      });
      const session = await this.repo.findSession(ctx.orgId, id, tx);
      if (session === undefined) throw notFound('شیفت صندوق');
      return session;
    });
  }

  /**
   * Closes the shift: expected vs counted, variance posts `cash.session.closed`
   * (cash-over income / cash-short expense) in the same transaction.
   */
  async closeSession(
    ctx: TenantContext,
    id: bigint,
    input: { readonly countedBalance: bigint; readonly note?: string },
  ): Promise<{ session: CashSessionRecord; journalEntryId: bigint | null }> {
    return this.db.begin(async (tx) => {
      const session = await this.repo.findSession(ctx.orgId, id, tx);
      if (session === undefined) throw notFound('شیفت صندوق');
      if (!['open', 'closing'].includes(session.status)) {
        throw new AppError('DOCUMENT_STATE_INVALID', { message: 'این شیفت صندوق باز نیست.' });
      }
      if (input.countedBalance < 0n) {
        throw validation('مبلغ شمارش‌شده نمی‌تواند منفی باشد.', 'countedBalance', 'non_negative');
      }
      const expected = await this.repo.expectedAmount(tx, id);
      const difference = input.countedBalance - expected;
      const cashAccountCode = await this.repo.glAccountOfBox(tx, ctx.orgId, session.cashAccountId);

      let journalEntryId: bigint | null = null;
      if (difference !== 0n) {
        const posted = await this.posting.postEvent(tx, ctx, {
          eventType: 'cash.session.closed',
          payload: {
            differenceAmount: difference.toString(),
            cashAccountCode,
            cashSessionId: id.toString(),
          },
          context: { entryDate: new Date().toISOString().slice(0, 10) },
          sourceId: id,
        });
        journalEntryId = posted.journalId;
      }
      await this.repo.closeSession(tx, {
        id,
        counted: input.countedBalance,
        expected,
        actorId: ctx.actorId,
        ...(input.note === undefined ? {} : { notes: input.note }),
      });
      await this.audit.record(asDb(tx), {
        action: 'cash.session.close',
        entityType: 'cash_session',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: {
          expected: expected.toString(),
          counted: input.countedBalance.toString(),
          difference: difference.toString(),
          note: input.note ?? null,
        },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'treasury.cash_session.closed',
        aggregateType: 'cash_session',
        aggregateId: id,
        payload: { difference: difference.toString() },
      });
      const updated = await this.repo.findSession(ctx.orgId, id, tx);
      if (updated === undefined) throw notFound('شیفت صندوق');
      return { session: updated, journalEntryId };
    });
  }

  /** Records a cash receipt/payment with its journal and box balance movement. */
  async createTransaction(
    ctx: TenantContext,
    input: CashTransactionInput,
  ): Promise<{ transaction: CashTransactionRecord; journalEntryId: bigint; balanceAfter: bigint }> {
    if (input.amount <= 0n) throw validation('مبلغ تراکنش باید بزرگ‌تر از صفر باشد.', 'amount', 'positive');
    return this.db.begin(async (tx) => {
      const cashAccountCode = await this.repo.glAccountOfBox(tx, ctx.orgId, input.cashBoxId);
      const direction = input.type === 'receipt' ? 'in' : 'out';
      const inserted = await this.repo.insertTransaction(tx, {
        cashAccountId: input.cashBoxId,
        ...(input.sessionId === undefined ? {} : { cashSessionId: input.sessionId }),
        direction,
        amount: input.amount,
        transactionDate: input.date,
        referenceType: input.type === 'receipt' ? 'payment' : 'expense',
        ...(input.description === undefined ? {} : { description: input.description }),
        createdBy: ctx.actorId,
      });

      const eventType = input.type === 'receipt' ? 'cash.receipt.recorded' : 'purchase.payment.paid';
      const posted = await this.posting.postEvent(tx, ctx, {
        eventType,
        payload: {
          amount: input.amount.toString(),
          cashAccountCode,
          method: 'cash',
          ...(input.partyType === undefined ? {} : { partyType: input.partyType }),
          ...(input.partyId === undefined ? {} : { partyId: input.partyId.toString() }),
        },
        context: { entryDate: input.date },
        sourceId: inserted.id,
      });
      await this.audit.record(asDb(tx), {
        action: 'cash.transaction.create',
        entityType: 'cash_transaction',
        entityId: inserted.id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { type: input.type, amount: input.amount.toString(), journalEntryId: posted.journalId.toString() },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'treasury.cash_transaction.created',
        aggregateType: 'cash_transaction',
        aggregateId: inserted.id,
        payload: { amount: input.amount.toString(), direction },
      });
      const transactions = await this.repo.listTransactions(ctx.orgId, { cashAccountId: input.cashBoxId });
      const transaction = transactions.find((row) => row.id === inserted.id);
      if (transaction === undefined) throw notFound('تراکنش صندوق');
      return { transaction, journalEntryId: posted.journalId, balanceAfter: inserted.balanceAfter };
    });
  }

  listTransactions(
    ctx: TenantContext,
    filter: { readonly cashAccountId?: bigint; readonly sessionId?: bigint; readonly direction?: string; readonly dateFrom?: string },
  ): Promise<readonly CashTransactionRecord[]> {
    return this.repo.listTransactions(ctx.orgId, filter);
  }
}
