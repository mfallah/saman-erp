/**
 * Cheque service: registration + lifecycle transitions. Every transition asserts
 * the state machine, posts the matching journal (before/after-clear bounce aware)
 * and appends an immutable `cheque_events` row — all in one transaction.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@saman/shared';
import { AUDIT, DB, EVENT_BUS } from '../../../common/contracts';
import type { AuditPort, Db, EventPort, TenantContext } from '../../../common/contracts';
import type { PostingService } from '../../accounting/posting/posting.service';
import type { ChequeRepository } from './cheque.repository';
import type { ChequeRecord } from './cheque.repository';
import { accountingEventFor, assertChequeTransition, initialChequeStatus } from './cheque-fsm';
import type { ChequeDirection, ChequeStatus } from './cheque-fsm';
import { asDb, notFound, validation } from '../persistence/sql-support';

export interface CreateChequeInput {
  readonly direction: ChequeDirection;
  readonly partyType: 'customer' | 'supplier' | 'shareholder' | 'other';
  readonly partyId: bigint;
  readonly amount: bigint;
  readonly chequeNo: string;
  readonly dueDate: string;
  readonly issueDate?: string;
  readonly bankName?: string;
  readonly bankAccountId?: bigint;
  readonly cashAccountId?: bigint;
  readonly sayadId?: string;
}

@Injectable()
export class ChequeService {
  constructor(
    private readonly repo: ChequeRepository,
    private readonly posting: PostingService,
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  list(
    ctx: TenantContext,
    filter: { readonly status?: string; readonly direction?: string; readonly partnerId?: bigint; readonly dueFrom?: string; readonly bankAccountId?: bigint; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly ChequeRecord[]> {
    return this.repo.list(ctx.orgId, filter);
  }

  async get(ctx: TenantContext, id: bigint): Promise<ChequeRecord> {
    const cheque = await this.repo.find(ctx.orgId, id);
    if (cheque === undefined) throw notFound('چک');
    return cheque;
  }

  eventHistory(ctx: TenantContext, id: bigint): Promise<readonly Record<string, unknown>[]> {
    return this.repo.events(id);
  }

  /** Registers the cheque with its direction-dependent initial status. */
  async create(ctx: TenantContext, input: CreateChequeInput): Promise<ChequeRecord> {
    if (input.amount <= 0n) throw validation('مبلغ چک باید بزرگ‌تر از صفر باشد.', 'amount', 'positive');
    if (input.dueDate < (input.issueDate ?? input.dueDate)) {
      throw validation('تاریخ سررسید نمی‌تواند قبل از تاریخ صدور باشد.', 'dueDate', 'after_issue');
    }
    const status = initialChequeStatus(input.direction);
    return this.db.begin(async (tx) => {
      const id = await this.repo.insert(tx, {
        orgId: ctx.orgId,
        chequeNo: input.chequeNo,
        direction: input.direction,
        status,
        partnerType: input.partyType,
        partnerId: input.partyId,
        amount: input.amount,
        dueDate: input.dueDate,
        ...(input.issueDate === undefined ? {} : { issueDate: input.issueDate }),
        ...(input.bankName === undefined ? {} : { bankName: input.bankName }),
        ...(input.bankAccountId === undefined ? {} : { bankAccountId: input.bankAccountId }),
        ...(input.cashAccountId === undefined ? {} : { cashAccountId: input.cashAccountId }),
        ...(input.sayadId === undefined ? {} : { sayadId: input.sayadId }),
        createdBy: ctx.actorId,
      });

      const eventType = input.direction === 'issued' ? 'cheque.issued' : 'cheque.received';
      const posted = await this.posting.postEvent(tx, ctx, {
        eventType,
        payload: {
          amount: input.amount.toString(),
          chequeId: id.toString(),
          direction: input.direction,
          partyType: input.partyType,
          partyId: input.partyId.toString(),
        },
        context: { entryDate: input.issueDate ?? input.dueDate },
        sourceId: id,
      });
      await this.repo.setJournal(tx, id, posted.journalId);
      await this.repo.appendEvent(tx, {
        chequeId: id,
        eventType: input.direction === 'issued' ? 'issued' : 'received',
        eventDate: input.issueDate ?? input.dueDate,
        amount: input.amount,
        journalEntryId: posted.journalId,
        createdBy: ctx.actorId,
      });
      await this.audit.record(asDb(tx), {
        action: 'cheque.register',
        entityType: 'cheque',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { direction: input.direction, amount: input.amount.toString(), status, journalEntryId: posted.journalId.toString() },
      });
      const created = await this.repo.find(ctx.orgId, id, tx);
      if (created === undefined) throw notFound('چک');
      return created;
    });
  }

  deposit(
    ctx: TenantContext,
    id: bigint,
    input: { readonly bankAccountId: bigint; readonly depositedAt?: string },
  ): Promise<ChequeRecord> {
    return this.transition(ctx, id, 'deposited', {
      bankAccountId: input.bankAccountId,
      date: input.depositedAt,
    });
  }

  clear(
    ctx: TenantContext,
    id: bigint,
    input: { readonly clearedAt?: string; readonly bankReference?: string } = {},
  ): Promise<ChequeRecord> {
    return this.transition(ctx, id, 'cleared', {
      date: input.clearedAt,
      ...(input.bankReference === undefined ? {} : { bankReference: input.bankReference }),
    });
  }

  bounce(
    ctx: TenantContext,
    id: bigint,
    input: { readonly bouncedAt?: string; readonly reason: string; readonly bankChargesAmount?: bigint },
  ): Promise<ChequeRecord> {
    return this.transition(ctx, id, 'bounced', {
      date: input.bouncedAt,
      bounceReason: input.reason,
      ...(input.bankChargesAmount === undefined ? {} : { bankChargesAmount: input.bankChargesAmount }),
    });
  }

  endorse(
    ctx: TenantContext,
    id: bigint,
    input: { readonly endorsedTo: string; readonly endorsedAt?: string },
  ): Promise<ChequeRecord> {
    return this.transition(ctx, id, 'endorsed', {
      date: input.endorsedAt,
      endorsedTo: input.endorsedTo,
    });
  }

  cancel(ctx: TenantContext, id: bigint, reason: string): Promise<ChequeRecord> {
    return this.transition(ctx, id, 'cancelled', { bounceReason: reason });
  }

  return(ctx: TenantContext, id: bigint, reason: string): Promise<ChequeRecord> {
    return this.transition(ctx, id, 'returned', { bounceReason: reason });
  }

  private async transition(
    ctx: TenantContext,
    id: bigint,
    to: ChequeStatus,
    options: {
      readonly date?: string;
      readonly bankAccountId?: bigint;
      readonly endorsedTo?: string;
      readonly bounceReason?: string;
      readonly bankReference?: string;
      readonly bankChargesAmount?: bigint;
    },
  ): Promise<ChequeRecord> {
    return this.db.begin(async (tx) => {
      const cheque = await this.repo.find(ctx.orgId, id, tx);
      if (cheque === undefined) throw notFound('چک');
      assertChequeTransition(cheque.direction, cheque.status, to);
      if (to === 'endorsed' && (options.endorsedTo ?? '').trim().length === 0) {
        throw new AppError('VALIDATION_ERROR', {
          details: [{ field: 'endorsedTo', rule: 'required' }],
          message: 'برای ظهرنویسی، نام شخص ظهرنویس الزامی است.',
        });
      }
      if (to === 'deposited' && options.bankAccountId === undefined) {
        throw new AppError('VALIDATION_ERROR', {
          details: [{ field: 'bankAccountId', rule: 'required' }],
          message: 'برای سپرده چک، حساب بانکی الزامی است.',
        });
      }

      const eventDate = options.date ?? new Date().toISOString().slice(0, 10);
      const accounting = accountingEventFor(cheque.direction, cheque.status, to);
      const posted = await this.posting.postEvent(tx, ctx, {
        eventType: accounting.eventType,
        payload: {
          amount: cheque.amount.toString(),
          afterClear: accounting.afterClear,
          direction: cheque.direction,
          chequeId: id.toString(),
          partyType: cheque.partnerType,
          partyId: cheque.partnerId.toString(),
          ...(options.endorsedTo === undefined ? {} : { endorsedTo: options.endorsedTo }),
          ...(options.bankChargesAmount === undefined
            ? {}
            : { bankChargesAmount: options.bankChargesAmount.toString() }),
        },
        context: { entryDate: eventDate },
        sourceId: id,
      });

      await this.repo.transition(tx, {
        id,
        from: cheque.status,
        to,
        date: eventDate,
        ...(options.bankAccountId === undefined ? {} : { bankAccountId: options.bankAccountId }),
        ...(options.endorsedTo === undefined ? {} : { endorsedTo: options.endorsedTo }),
        ...(options.endorsedTo === undefined ? {} : { endorsementDate: eventDate }),
        ...(options.bounceReason === undefined ? {} : { bounceReason: options.bounceReason }),
        journalEntryId: posted.journalId,
      });
      await this.repo.appendEvent(tx, {
        chequeId: id,
        eventType: to,
        eventDate,
        amount: cheque.amount,
        ...(options.bankReference === undefined ? {} : { bankReference: options.bankReference }),
        ...(options.bounceReason === undefined ? {} : { notes: options.bounceReason }),
        journalEntryId: posted.journalId,
        createdBy: ctx.actorId,
      });
      await this.audit.record(asDb(tx), {
        action: `cheque.${to}`,
        entityType: 'cheque',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        before: { status: cheque.status },
        after: { status: to, journalEntryId: posted.journalId.toString() },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: `treasury.cheque.${to}`,
        aggregateType: 'cheque',
        aggregateId: id,
        payload: { amount: cheque.amount.toString(), direction: cheque.direction, afterClear: accounting.afterClear },
      });
      const updated = await this.repo.find(ctx.orgId, id, tx);
      if (updated === undefined) throw notFound('چک');
      return updated;
    });
  }
}
