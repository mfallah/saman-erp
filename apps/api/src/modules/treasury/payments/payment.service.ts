/**
 * Treasury payment service: draft → submit → approve → execute, with allocation
 * caps and the journal posted in the same transaction (`API.md §4.12`).
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@saman/shared';
import { AUDIT, DB, EVENT_BUS } from '../../../common/contracts';
import type { AuditPort, Db, EventPort, TenantContext } from '../../../common/contracts';
import type { PostingService } from '../../accounting/posting/posting.service';
import { ACCOUNTS } from '../../accounting/posting/accounts';
import type { FiscalCalendarRepository } from '../../accounting/periods/fiscal-calendar.repository';
import type { AccountingEventType } from '../../accounting/events';
import type { PaymentRepository } from './payment.repository';
import type { AllocationRecord, PaymentRecord } from './payment.repository';
import { applyAllocations, assertAllocationsWithinPayment, unappliedAmount } from './allocation';
import type { AllocationRequest } from './allocation';
import { asDb, notFound, validation } from '../persistence/sql-support';

export interface CreatePaymentInput {
  readonly direction: 'inbound' | 'outbound';
  readonly method: 'cash' | 'pos' | 'gateway' | 'cash_on_delivery' | 'bank_transfer' | 'cheque' | 'credit' | 'other';
  readonly amount: bigint;
  readonly paymentDate: string;
  readonly customerId?: bigint;
  readonly supplierId?: bigint;
  readonly partnerId?: bigint;
  readonly bankAccountId?: bigint;
  readonly cashAccountId?: bigint;
  readonly chequeId?: bigint;
  readonly salesOrderId?: bigint;
  readonly purchaseOrderId?: bigint;
  readonly expenseId?: bigint;
  readonly refundId?: bigint;
  readonly description?: string;
  readonly referenceNo?: string;
  readonly allocations?: readonly AllocationRequest[];
}

const PAYMENT_PREFIX = 'PAY';

@Injectable()
export class PaymentService {
  constructor(
    private readonly repo: PaymentRepository,
    private readonly posting: PostingService,
    private readonly calendar: FiscalCalendarRepository,
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  list(
    ctx: TenantContext,
    filter: { readonly direction?: string; readonly status?: string; readonly customerId?: bigint; readonly supplierId?: bigint; readonly dateFrom?: string; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly PaymentRecord[]> {
    return this.repo.list(ctx.orgId, filter);
  }

  async get(ctx: TenantContext, id: bigint): Promise<PaymentRecord> {
    const payment = await this.repo.find(ctx.orgId, id);
    if (payment === undefined) throw notFound('پرداخت');
    return payment;
  }

  allocations(ctx: TenantContext, id: bigint): Promise<readonly AllocationRecord[]> {
    return this.repo.allocations(id);
  }

  /** Creates the draft; the document number is allocated at execution only. */
  async create(ctx: TenantContext, input: CreatePaymentInput): Promise<PaymentRecord> {
    if (input.amount <= 0n) throw validation('مبلغ پرداخت باید بزرگ‌تر از صفر باشد.', 'amount', 'positive');
    const parties = [input.customerId, input.supplierId, input.partnerId].filter((value) => value !== undefined);
    if (parties.length > 1) throw validation('پرداخت تنها می‌تواند یک طرف حساب داشته باشد.', 'partyId', 'single_party');
    if (input.method !== 'gateway' && input.method !== 'cash_on_delivery' && input.method !== 'credit') {
      if (input.bankAccountId === undefined && input.cashAccountId === undefined && input.chequeId === undefined) {
        throw validation('برای این روش پرداخت، حساب بانکی یا صندوق الزامی است.', 'bankAccountId', 'required');
      }
    }
    return this.db.begin(async (tx) => {
      const methodId = await this.repo.methodId(tx, ctx.orgId, input.method);
      const fiscal = await this.calendar.resolveAndLockPeriod(tx, ctx.orgId, input.paymentDate);
      const paymentNo = `DRAFT-${Date.now()}`;
      const id = await this.repo.insert(tx, {
        orgId: ctx.orgId,
        paymentNo,
        direction: input.direction,
        methodId,
        amount: input.amount,
        unappliedAmount: input.amount,
        paymentDate: input.paymentDate,
        ...(input.customerId === undefined ? {} : { customerId: input.customerId }),
        ...(input.supplierId === undefined ? {} : { supplierId: input.supplierId }),
        ...(input.partnerId === undefined ? {} : { partnerId: input.partnerId }),
        ...(input.bankAccountId === undefined ? {} : { bankAccountId: input.bankAccountId }),
        ...(input.cashAccountId === undefined ? {} : { cashAccountId: input.cashAccountId }),
        ...(input.chequeId === undefined ? {} : { chequeId: input.chequeId }),
        ...(input.salesOrderId === undefined ? {} : { salesOrderId: input.salesOrderId }),
        ...(input.purchaseOrderId === undefined ? {} : { purchaseOrderId: input.purchaseOrderId }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.referenceNo === undefined ? {} : { referenceNo: input.referenceNo }),
        createdBy: ctx.actorId,
      });
      void fiscal;
      await this.audit.record(asDb(tx), {
        action: 'payment.create',
        entityType: 'payment',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { amount: input.amount.toString(), direction: input.direction, method: input.method },
      });
      const created = await this.repo.find(ctx.orgId, id, tx);
      if (created === undefined) throw notFound('پرداخت');
      return created;
    });
  }

  async submit(ctx: TenantContext, id: bigint): Promise<PaymentRecord> {
    return this.transition(ctx, id, ['pending'], 'pending_approval', 'payment.submit');
  }

  async approve(ctx: TenantContext, id: bigint, note?: string): Promise<PaymentRecord> {
    const payment = await this.get(ctx, id);
    await this.db.begin(async (tx) => {
      await this.repo.setStatus(tx, id, ['pending_approval'], 'confirmed', ctx.actorId);
      await this.audit.record(asDb(tx), {
        action: 'payment.approve',
        entityType: 'payment',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { note: note ?? null, amount: payment.amount.toString() },
      });
    });
    return this.get(ctx, id);
  }

  /**
   * Executes the payment: allocates the number, posts the accounting journal and
   * records the bank/cash movement in one transaction.
   */
  async execute(
    ctx: TenantContext,
    id: bigint,
    input: { readonly executedAt?: string; readonly reference?: string } = {},
  ): Promise<{ payment: PaymentRecord; journalEntryId: bigint }> {
    return this.db.begin(async (tx) => {
      const payment = await this.repo.find(ctx.orgId, id, tx);
      if (payment === undefined) throw notFound('پرداخت');
      if (!['pending', 'confirmed', 'pending_approval'].includes(payment.status)) {
        throw new AppError('DOCUMENT_STATE_INVALID', { message: 'این پرداخت قابل اجرا نیست.' });
      }
      const period = await this.calendar.resolveAndLockPeriod(tx, ctx.orgId, input.executedAt ?? payment.paymentDate);
      const paymentNo = await this.repo.nextPaymentNo(tx, ctx.orgId, period.year.id, PAYMENT_PREFIX);
      await tx`update erp.payments set payment_no = ${paymentNo} where id = ${id.toString()}`;

      const bankAccountCode = payment.bankAccountId === null
        ? undefined
        : await this.repo.glAccountOfBank(tx, ctx.orgId, payment.bankAccountId);
      const cashAccountCode = payment.cashAccountId === null
        ? undefined
        : await this.repo.glAccountOfCash(tx, ctx.orgId, payment.cashAccountId);

      const plan = this.executionPlan(payment, {
        ...(bankAccountCode === undefined ? {} : { bankAccountCode }),
        ...(cashAccountCode === undefined ? {} : { cashAccountCode }),
      });

      const posted = await this.posting.postEvent(tx, ctx, {
        eventType: plan.eventType,
        payload: plan.payload,
        context: { entryDate: input.executedAt ?? payment.paymentDate },
        sourceId: id,
      });
      await this.repo.setStatus(tx, id, ['pending', 'pending_approval', 'confirmed'], 'cleared', ctx.actorId);
      await this.repo.attachJournal(tx, id, posted.journalId);
      await this.audit.record(asDb(tx), {
        action: 'payment.execute',
        entityType: 'payment',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: {
          paymentNo,
          journalEntryId: posted.journalId.toString(),
          reference: input.reference ?? null,
          amount: payment.amount.toString(),
        },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'treasury.payment.executed',
        aggregateType: 'payment',
        aggregateId: id,
        payload: { paymentNo, amount: payment.amount.toString(), direction: payment.direction },
      });
      const updated = await this.repo.find(ctx.orgId, id, tx);
      if (updated === undefined) throw notFound('پرداخت');
      return { payment: updated, journalEntryId: posted.journalId };
    });
  }

  /**
   * Allocates a payment/advance to documents. Σ allocations may never exceed the
   * payment amount; the remainder stays as `unapplied_amount` (B-14).
   */
  async allocate(
    ctx: TenantContext,
    id: bigint,
    items: readonly AllocationRequest[],
  ): Promise<readonly AllocationRecord[]> {
    return this.db.begin(async (tx) => {
      const payment = await this.repo.find(ctx.orgId, id, tx);
      if (payment === undefined) throw notFound('پرداخت');
      if (payment.status === 'voided') {
        throw new AppError('DOCUMENT_STATE_INVALID', { message: 'پرداخت ابطال‌شده قابل تخصیص نیست.' });
      }
      const existing = await this.repo.allocations(id, tx);
      const state = {
        paymentAmount: payment.amount,
        allocations: existing.map((row) => ({
          documentType: row.documentType,
          documentId: row.documentId,
          amount: row.amount,
        })),
      };
      const applied = applyAllocations(state, items);
      for (const item of applied.allocations) {
        await this.repo.insertAllocation(tx, {
          paymentId: id,
          orgId: ctx.orgId,
          documentType: item.documentType,
          documentId: item.documentId,
          amount: item.amount,
        });
      }
      const total = items.reduce((sum, item) => sum + item.amount, 0n);
      await this.repo.setUnapplied(tx, id, applied.unapplied);
      if (payment.status === 'cleared') {
        await this.posting.postEvent(tx, ctx, {
          eventType: 'payment.allocated',
          payload: {
            amount: total.toString(),
            direction: payment.direction,
            ...(payment.customerId === null ? {} : { partyType: 'customer', partyId: payment.customerId.toString() }),
            ...(payment.supplierId === null ? {} : { partyType: 'supplier', partyId: payment.supplierId.toString() }),
          },
          context: { entryDate: payment.paymentDate },
          sourceId: id,
        });
      }
      await this.audit.record(asDb(tx), {
        action: 'payment.allocate',
        entityType: 'payment',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: {
          total: total.toString(),
          unapplied: applied.unapplied.toString(),
          documents: items.map((item) => ({ type: item.documentType, id: item.documentId.toString(), amount: item.amount.toString() })),
        },
      });
      return this.repo.allocations(id, tx);
    });
  }

  async deallocate(ctx: TenantContext, id: bigint, allocationId: bigint): Promise<void> {
    return this.db.begin(async (tx) => {
      const amount = await this.repo.deleteAllocation(tx, id, allocationId);
      const payment = await this.repo.find(ctx.orgId, id, tx);
      if (payment === undefined) throw notFound('پرداخت');
      await this.repo.setUnapplied(tx, id, payment.unappliedAmount + amount);
      await this.audit.record(asDb(tx), {
        action: 'payment.deallocate',
        entityType: 'payment',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        before: { allocationId: allocationId.toString(), amount: amount.toString() },
      });
    });
  }

  async void(ctx: TenantContext, id: bigint, reason: string): Promise<PaymentRecord> {
    return this.db.begin(async (tx) => {
      const payment = await this.repo.find(ctx.orgId, id, tx);
      if (payment === undefined) throw notFound('پرداخت');
      if (payment.status === 'cleared') {
        throw new AppError('DOCUMENT_STATE_INVALID', {
          message: 'پرداخت اجراشده قابل ابطال نیست؛ باید سند برگشتی ثبت شود.',
        });
      }
      await this.repo.setStatus(tx, id, ['pending', 'pending_approval', 'confirmed'], 'voided', ctx.actorId);
      await this.audit.record(asDb(tx), {
        action: 'payment.void',
        entityType: 'payment',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { reason },
      });
      const updated = await this.repo.find(ctx.orgId, id, tx);
      if (updated === undefined) throw notFound('پرداخت');
      return updated;
    });
  }

  private async transition(
    ctx: TenantContext,
    id: bigint,
    from: readonly string[],
    to: string,
    action: string,
  ): Promise<PaymentRecord> {
    await this.get(ctx, id);
    await this.db.begin(async (tx) => {
      await this.repo.setStatus(tx, id, from, to, ctx.actorId);
      await this.audit.record(asDb(tx), {
        action,
        entityType: 'payment',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { status: to },
      });
    });
    return this.get(ctx, id);
  }

  /**
   * Chooses the accounting event for an execution. Cash sales/refunds/advances and
   * prepayments each have their own rule; revenue is never recognised here.
   */
  private executionPlan(
    payment: PaymentRecord,
    accounts: { readonly bankAccountCode?: string; readonly cashAccountCode?: string },
  ): { readonly eventType: AccountingEventType; readonly payload: Record<string, unknown> } {
    const amount = payment.amount.toString();
    const party = {
      ...(payment.customerId === null ? {} : { partyType: 'customer', partyId: payment.customerId.toString() }),
      ...(payment.supplierId === null ? {} : { partyType: 'supplier', partyId: payment.supplierId.toString() }),
      ...(payment.partnerId === null ? {} : { partyType: 'shareholder', partyId: payment.partnerId.toString() }),
    };
    const accountPath = {
      ...(accounts.bankAccountCode === undefined ? {} : { bankAccountCode: accounts.bankAccountCode }),
      ...(accounts.cashAccountCode === undefined ? {} : { cashAccountCode: accounts.cashAccountCode }),
      method: payment.methodCode,
    };

    if (payment.direction === 'outbound') {
      if (payment.partnerId !== null) {
        return { eventType: 'dividend.paid', payload: { amount, ...accountPath } };
      }
      if (payment.purchaseOrderId !== null) {
        return {
          eventType: 'purchase.prepayment.paid',
          payload: {
            amount,
            ...accountPath,
            ...(payment.supplierId === null ? {} : { partyType: 'supplier', partyId: payment.supplierId.toString() }),
          },
        };
      }
      if (payment.refundId !== null) {
        return {
          eventType: 'sales.refund.paid',
          payload: {
            amount,
            ...accountPath,
            ...(payment.customerId === null ? {} : { customerId: payment.customerId.toString() }),
          },
        };
      }
      return {
        eventType: 'purchase.payment.paid',
        payload: {
          amount,
          ...accountPath,
          ...(payment.supplierId === null ? {} : { partyType: 'supplier', partyId: payment.supplierId.toString() }),
        },
      };
    }

    // inbound
    if (payment.unappliedAmount === payment.amount && payment.customerId !== null) {
      return {
        eventType: 'payment.advance.received',
        payload: { amount, ...accountPath, ...party },
      };
    }
    if (payment.methodCode === 'cheque' && payment.chequeId !== null) {
      return {
        eventType: 'sales.payment.received',
        payload: {
          amount,
          method: 'cheque',
          unappliedAmount: payment.unappliedAmount.toString(),
          ...(payment.customerId === null ? {} : { customerId: payment.customerId.toString() }),
        },
      };
    }
    return {
      eventType: 'sales.payment.received',
      payload: {
        amount,
        ...accountPath,
        unappliedAmount: payment.unappliedAmount.toString(),
        ...(payment.customerId === null ? {} : { customerId: payment.customerId.toString() }),
      },
    };
  }

  /** Small helper for callers that need the clearing account of a method. */
  clearingAccountFor(method: string): string {
    return method === 'gateway' ? ACCOUNTS.gatewayClearing : ACCOUNTS.posClearing;
  }
}
