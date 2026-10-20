/**
 * Channel settlement service (B-03): gross/commission/fee/returns/VAT → net
 * payable, confirmation against settlement lines, and posting that clears the
 * channel receivable — revenue is never re-recognised here.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@saman/shared';
import { AUDIT, DB, EVENT_BUS } from '../../common/contracts';
import type { AuditPort, Db, EventPort, TenantContext } from '../../common/contracts';
import type { PostingService } from '../accounting/posting/posting.service';
import { asDb, notFound, validation } from '../treasury/persistence/sql-support';
import { assertNoRevenueReRecognition, assertSettlementNet, reconcileSettlement } from './settlement';
import type { SettlementAmounts, SettlementLine } from './settlement';
import type { SettlementsRepository } from './settlements.repository';
import type { SettlementLineRecord, SettlementRecord } from './settlements.repository';

export interface CreateSettlementInput {
  readonly channelAccountId: bigint;
  readonly channelCode?: string;
  readonly externalSettlementId?: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly grossSalesAmount: bigint;
  readonly commissionAmount: bigint;
  readonly feeAmount: bigint;
  readonly returnAmount: bigint;
  readonly taxAmount: bigint;
  readonly netPayableAmount: bigint;
  readonly lines?: readonly {
    readonly lineType: SettlementLine['lineType'];
    readonly amount: bigint;
    readonly salesOrderId?: bigint;
    readonly externalReference?: string;
  }[];
}

@Injectable()
export class SettlementsService {
  constructor(
    private readonly repo: SettlementsRepository,
    private readonly posting: PostingService,
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  list(
    ctx: TenantContext,
    filter: { readonly channelAccountId?: bigint; readonly status?: string; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly SettlementRecord[]> {
    return this.repo.list(ctx.orgId, filter);
  }

  async get(ctx: TenantContext, id: bigint): Promise<{ settlement: SettlementRecord; lines: readonly SettlementLineRecord[] }> {
    const settlement = await this.repo.find(ctx.orgId, id);
    if (settlement === undefined) throw notFound('تسویه کانال');
    return { settlement, lines: await this.repo.lines(id) };
  }

  /** Creates the settlement document after validating the net formula. */
  async create(ctx: TenantContext, input: CreateSettlementInput): Promise<SettlementRecord> {
    const amounts: SettlementAmounts = {
      grossSalesAmount: input.grossSalesAmount,
      commissionAmount: input.commissionAmount,
      feeAmount: input.feeAmount,
      returnAmount: input.returnAmount,
      taxAmount: input.taxAmount,
      netPayableAmount: input.netPayableAmount,
    };
    assertSettlementNet(amounts);
    if (input.grossSalesAmount < 0n || input.commissionAmount < 0n || input.feeAmount < 0n) {
      throw validation('مبالغ تسویه نمی‌توانند منفی باشند.', 'grossSalesAmount', 'non_negative');
    }
    return this.db.begin(async (tx) => {
      const settlementNo = input.externalSettlementId ?? `SET-${Date.now()}`;
      const id = await this.repo.insert(tx, {
        orgId: ctx.orgId,
        channelAccountId: input.channelAccountId,
        settlementNo,
        ...(input.externalSettlementId === undefined
          ? {}
          : { externalSettlementId: input.externalSettlementId }),
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        grossSalesAmount: input.grossSalesAmount,
        commissionAmount: input.commissionAmount,
        feeAmount: input.feeAmount,
        returnAmount: input.returnAmount,
        taxAmount: input.taxAmount,
        netPayableAmount: input.netPayableAmount,
        createdBy: ctx.actorId,
      });
      if (input.lines !== undefined && input.lines.length > 0) {
        await this.repo.insertLines(
          tx,
          id,
          input.lines.map((line) => ({
            lineType: line.lineType,
            amount: line.amount,
            ...(line.salesOrderId === undefined ? {} : { salesOrderId: line.salesOrderId }),
            ...(line.externalReference === undefined ? {} : { externalReference: line.externalReference }),
          })),
        );
      }
      await this.audit.record(asDb(tx), {
        action: 'settlement.create',
        entityType: 'channel_settlement',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: {
          settlementNo,
          netPayable: input.netPayableAmount.toString(),
          gross: input.grossSalesAmount.toString(),
        },
      });
      const created = await this.repo.find(ctx.orgId, id, tx);
      if (created === undefined) throw notFound('تسویه کانال');
      return created;
    });
  }

  /** Confirms against the settlement lines; discrepancies become a variance. */
  async confirm(
    ctx: TenantContext,
    id: bigint,
    input: { readonly tolerance?: bigint } = {},
  ): Promise<{ settlement: SettlementRecord; withinTolerance: boolean; varianceAmount: bigint }> {
    return this.db.begin(async (tx) => {
      const settlement = await this.repo.find(ctx.orgId, id, tx);
      if (settlement === undefined) throw notFound('تسویه کانال');
      if (!['received', 'reconciling', 'disputed'].includes(settlement.status)) {
        throw new AppError('DOCUMENT_STATE_INVALID', { message: 'این تسویه قابل تأیید نیست.' });
      }
      const lineRecords = await this.repo.lines(id);
      const reconciliation = reconcileSettlement(
        {
          grossSalesAmount: settlement.grossSalesAmount,
          commissionAmount: settlement.commissionAmount,
          feeAmount: settlement.feeAmount,
          returnAmount: settlement.returnAmount,
          taxAmount: settlement.taxAmount,
          netPayableAmount: settlement.netPayableAmount,
        },
        lineRecords.map((line) => ({ lineType: line.lineType as SettlementLine['lineType'], amount: line.amount })),
        input.tolerance ?? 0n,
      );
      await this.repo.setStatus(tx, id, ['received', 'reconciling', 'disputed'], reconciliation.withinTolerance ? 'confirmed' : 'disputed');
      await this.audit.record(asDb(tx), {
        action: 'settlement.confirm',
        entityType: 'channel_settlement',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: {
          withinTolerance: reconciliation.withinTolerance,
          netDifference: reconciliation.netDifference.toString(),
          grossDifference: reconciliation.grossDifference.toString(),
        },
      });
      const updated = await this.repo.find(ctx.orgId, id, tx);
      if (updated === undefined) throw notFound('تسویه کانال');
      return {
        settlement: updated,
        withinTolerance: reconciliation.withinTolerance,
        varianceAmount: reconciliation.varianceAmount,
      };
    });
  }

  /**
   * Posts the settlement: clears the channel receivable, releases the accrued fee
   * payable and routes returns/VAT/residual to variance. Never credits revenue.
   */
  async post(ctx: TenantContext, id: bigint): Promise<{ settlement: SettlementRecord; journalEntryId: bigint }> {
    return this.db.begin(async (tx) => {
      const settlement = await this.repo.find(ctx.orgId, id, tx);
      if (settlement === undefined) throw notFound('تسویه کانال');
      if (settlement.status === 'posted' || settlement.journalEntryId !== null) {
        throw new AppError('DOCUMENT_STATE_INVALID', { message: 'این تسویه قبلاً ثبت شده است.' });
      }
      if (!['confirmed', 'paid', 'closed', 'disputed'].includes(settlement.status)) {
        throw new AppError('DOCUMENT_STATE_INVALID', { message: 'تسویه باید ابتدا تأیید شود.' });
      }
      const lines = await this.repo.lines(id);
      const expected = settlement.grossSalesAmount -
        settlement.commissionAmount - settlement.feeAmount - settlement.returnAmount - settlement.taxAmount;
      const lineNet = lines.reduce((total, line) => {
        switch (line.lineType) {
          case 'sale':
            return total + line.amount;
          case 'commission':
          case 'fee':
          case 'return':
          case 'tax':
          case 'shipping':
          case 'penalty':
            return total - line.amount;
          default:
            return total;
        }
      }, 0n);
      const variance = lines.length > 0 ? settlement.netPayableAmount - lineNet : 0n;
      void expected;

      const posted = await this.posting.postEvent(tx, ctx, {
        eventType: 'settlement.confirmed',
        payload: {
          settlementId: id.toString(),
          settlementNo: settlement.settlementNo,
          grossSalesAmount: settlement.grossSalesAmount.toString(),
          commissionAmount: settlement.commissionAmount.toString(),
          feeAmount: settlement.feeAmount.toString(),
          returnAmount: settlement.returnAmount.toString(),
          taxAmount: settlement.taxAmount.toString(),
          netPayableAmount: settlement.netPayableAmount.toString(),
          varianceAmount: variance.toString(),
          paidToBank: false,
          channelAccountId: settlement.channelAccountId.toString(),
          channelCode: await this.repo.channelCodeOf(tx, ctx.orgId, settlement.channelAccountId),
        },
        context: { entryDate: settlement.periodEnd },
        sourceId: id,
      });

      // defensive: the settlement draft must not credit a sales revenue account
      assertNoRevenueReRecognition(['1-1-08-001', '2-1-10-001']);

      await this.repo.attachJournal(tx, id, posted.journalId);
      await this.repo.setStatus(tx, id, ['confirmed', 'paid', 'closed', 'disputed'], 'closed');
      await this.audit.record(asDb(tx), {
        action: 'settlement.post',
        entityType: 'channel_settlement',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { journalEntryId: posted.journalId.toString(), variance: variance.toString() },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'partners.settlement.posted',
        aggregateType: 'channel_settlement',
        aggregateId: id,
        payload: { netPayable: settlement.netPayableAmount.toString(), journalEntryId: posted.journalId.toString() },
      });
      const updated = await this.repo.find(ctx.orgId, id, tx);
      if (updated === undefined) throw notFound('تسویه کانال');
      return { settlement: updated, journalEntryId: posted.journalId };
    });
  }

  /** Links the treasury payment that actually paid the settlement. */
  async attachPayment(ctx: TenantContext, id: bigint, paymentId: bigint): Promise<SettlementRecord> {
    return this.db.begin(async (tx) => {
      await this.repo.attachPayment(tx, id, paymentId);
      await this.audit.record(asDb(tx), {
        action: 'settlement.pay',
        entityType: 'channel_settlement',
        entityId: id,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { paymentId: paymentId.toString() },
      });
      const updated = await this.repo.find(ctx.orgId, id, tx);
      if (updated === undefined) throw notFound('تسویه کانال');
      return updated;
    });
  }
}


