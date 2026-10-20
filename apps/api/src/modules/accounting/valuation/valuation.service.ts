import { asDb } from '../persistence/sql-support';
import type { SqlSession } from '../persistence/sql-support';
/**
 * Inventory valuation runs (FIFO cost layers / moving average) with GL
 * reconciliation (`R1-accounting` B-07/H-02, ADR-0007 §6).
 *
 * The run never mutates layers: it snapshots value, compares it to the GL
 * inventory control account, and only an explicit `post` creates the true-up
 * journal (`inventory.valuation.posted`).
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@saman/shared';
import { AUDIT, DB, EVENT_BUS } from '../../../common/contracts';
import type { AuditPort, Db, EventPort, TenantContext } from '../../../common/contracts';
import { ACCOUNTS } from '../posting/accounts';
import { PostingService } from '../posting/posting.service';
import { FiscalCalendarRepository } from '../periods/fiscal-calendar.repository';
import { reconcileWithGl, summariseValuation } from './fifo';
import type { VariantValuationRow } from './fifo';
import { ValuationRepository } from './valuation.repository';
import type { ValuationRunRecord } from './valuation.repository';

export interface RunValuationInput {
  readonly method: 'fifo' | 'weighted_average' | 'moving_average';
  readonly periodId: bigint;
  readonly warehouseIds?: readonly bigint[];
  readonly asOf?: string;
}

@Injectable()
export class ValuationService {
  constructor(
    private readonly repo: ValuationRepository,
    private readonly calendar: FiscalCalendarRepository,
    private readonly posting: PostingService,
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  listRuns(
    ctx: TenantContext,
    filter: { readonly method?: string; readonly status?: string; readonly warehouseId?: bigint },
  ): Promise<readonly ValuationRunRecord[]> {
    return this.repo.listRuns(ctx.orgId, filter);
  }

  async getRun(ctx: TenantContext, id: bigint): Promise<ValuationRunRecord> {
    const run = await this.repo.findRun(ctx.orgId, id);
    if (run === undefined) throw new AppError('NOT_FOUND', { message: 'اجرای ارزش‌گذاری یافت نشد.' });
    return run;
  }

  runLines(ctx: TenantContext, id: bigint): Promise<readonly VariantValuationRow[]> {
    return this.repo.runLines(id);
  }

  /** Creates a snapshot run; a non-zero variance keeps it `running` for posting. */
  async run(ctx: TenantContext, input: RunValuationInput): Promise<ValuationRunRecord> {
    const method = input.method === 'weighted_average' ? 'moving_average' : input.method;
    return this.db.begin(async (tx) => {
      const period = await this.calendar.findPeriod(input.periodId);
      if (period === undefined) throw new AppError('NOT_FOUND', { message: 'دوره مالی یافت نشد.' });
      const valuationDate = input.asOf ?? period.endDate;

      const rows = method === 'fifo'
        ? await this.repo.layerTotals(tx, ctx.orgId, {
            ...(input.warehouseIds === undefined ? {} : { warehouseIds: input.warehouseIds }),
            asOf: valuationDate,
          })
        : await this.averageRows(ctx, tx, input, valuationDate);

      const summary = summariseValuation(rows);
      const glValue = await this.repo.glInventoryBalance(tx, ctx.orgId, ACCOUNTS.inventory, input.periodId);
      const reconciliation = reconcileWithGl(summary.totalValue, glValue);

      const runId = await this.repo.createRun(tx, {
        orgId: ctx.orgId,
        method,
        valuationDate,
        warehouseId: input.warehouseIds !== undefined && input.warehouseIds.length === 1
          ? (input.warehouseIds[0] ?? null)
          : null,
        totalQuantity: summary.totalQuantity,
        totalValue: summary.totalValue,
        glValue,
        costLayerCount: summary.lineCount,
        status: reconciliation.reconciles ? 'completed' : 'running',
        createdBy: ctx.actorId,
      });
      await this.repo.insertRunLines(tx, runId, rows);

      await this.audit.record(asDb(tx), {
        action: 'accounting.valuation.run',
        entityType: 'inventory_valuation_run',
        entityId: runId,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: {
          method,
          valuationDate,
          totalValue: summary.totalValue.toString(),
          glValue: glValue.toString(),
          variance: reconciliation.variance.toString(),
        },
      });
      await this.events.emit(asDb(tx), {
        orgId: ctx.orgId,
        type: 'accounting.valuation.completed',
        aggregateType: 'inventory_valuation_run',
        aggregateId: runId,
        payload: {
          method,
          totalValue: summary.totalValue.toString(),
          variance: reconciliation.variance.toString(),
        },
      });

      const created = await this.repo.findRun(ctx.orgId, runId);
      if (created === undefined) throw new AppError('NOT_FOUND', { message: 'اجرای ارزش‌گذاری یافت نشد.' });
      return created;
    });
  }

  /** Posts the true-up journal for an unreconciled run (method change/year-end). */
  async post(ctx: TenantContext, runId: bigint): Promise<{ run: ValuationRunRecord; journalEntryId: bigint }> {
    return this.db.begin(async (tx) => {
      const run = await this.repo.findRun(ctx.orgId, runId);
      if (run === undefined) throw new AppError('NOT_FOUND', { message: 'اجرای ارزش‌گذاری یافت نشد.' });
      if (run.status === 'posted') {
        throw new AppError('DOCUMENT_STATE_INVALID', { message: 'این اجرای ارزش‌گذاری قبلاً ثبت شده است.' });
      }
      if (run.status === 'failed') {
        throw new AppError('DOCUMENT_STATE_INVALID', { message: 'اجرای ناموفق قابل ثبت نیست.' });
      }
      if (run.varianceAmount === 0n) {
        throw new AppError('RULE_VIOLATION', {
          details: [{ rule: 'no_valuation_variance' }],
          message: 'مغایرتی میان ارزش موجودی و حساب کل وجود ندارد.',
        });
      }

      const posted = await this.posting.postEvent(tx, ctx, {
        eventType: 'inventory.valuation.posted',
        payload: {
          varianceAmount: run.varianceAmount.toString(),
          valuationRunId: runId.toString(),
        },
        context: {
          entryDate: run.valuationDate,
          ...(run.warehouseId === null ? {} : {}),
        },
        sourceId: runId,
      });
      await this.repo.markPosted(tx, runId, posted.journalId);
      await this.audit.record(asDb(tx), {
        action: 'accounting.valuation.post',
        entityType: 'inventory_valuation_run',
        entityId: runId,
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        after: { journalEntryId: posted.journalId.toString(), variance: run.varianceAmount.toString() },
      });
      const updated = await this.repo.findRun(ctx.orgId, runId);
      if (updated === undefined) throw new AppError('NOT_FOUND', { message: 'اجرای ارزش‌گذاری یافت نشد.' });
      return { run: updated, journalEntryId: posted.journalId };
    });
  }

  /** Nightly reconciliation: Σ layers vs GL inventory account for a date range. */
  async reconcile(ctx: TenantContext, periodId: bigint): Promise<{ ledgerValue: bigint; glValue: bigint; variance: bigint; reconciles: boolean }> {
    return this.db.begin(async (tx) => {
      const rows = await this.repo.layerTotals(tx, ctx.orgId, {});
      const summary = summariseValuation(rows);
      const glValue = await this.repo.glInventoryBalance(tx, ctx.orgId, ACCOUNTS.inventory, periodId);
      const result = reconcileWithGl(summary.totalValue, glValue);
      return { ledgerValue: summary.totalValue, glValue, ...result };
    });
  }

  private async averageRows(
    ctx: TenantContext,
    tx: SqlSession,
    input: RunValuationInput,
    valuationDate: string,
  ): Promise<readonly VariantValuationRow[]> {
    void valuationDate;
    const rows = await this.repo.layerTotals(tx, ctx.orgId, {
      ...(input.warehouseIds === undefined ? {} : { warehouseIds: input.warehouseIds }),
    });
    const result: VariantValuationRow[] = [];
    for (const row of rows) {
      const state = await this.repo.averageState(tx, row.warehouseId, row.productVariantId);
      result.push({
        warehouseId: row.warehouseId,
        productVariantId: row.productVariantId,
        quantity: state.totalValueAmount === 0n && state.qtyOnHand === '0' ? row.quantity : state.qtyOnHand,
        unitCostAmount: state.avgCostAmount === 0n ? row.unitCostAmount : state.avgCostAmount,
        valueAmount: state.totalValueAmount === 0n ? row.valueAmount : state.totalValueAmount,
      });
    }
    return result;
  }
}
