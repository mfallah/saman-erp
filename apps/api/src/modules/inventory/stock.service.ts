/**
 * Stock workspace service (`GET /inventory/stock`, `POST /inventory/stock/adjust`).
 *
 * Reads are an organization-scoped aggregate over variants/balances with the
 * mapped channel listings inlined as JSON. Writes delegate the stock truth to
 * `InventoryService.quickAdjust` (the ledger primitive owns balances/cost/audit)
 * and then queue a stock push per active channel mapping — the push is never
 * part of the stock transaction, so a channel outage cannot roll back stock.
 */
import { Inject, Injectable } from '@nestjs/common';

import { DB, type TenantContext } from '../../common/contracts';
import { CatalogLookupService } from '../catalog/product.service';
import { ChannelSyncService } from '../channels/services/channel-sync.service';
import type { Db } from './inventory.pg-support';
import { InventoryRepository, type StockChannelTarget, type StockHistoryRow } from './inventory.repository';
import { InventoryService } from './inventory.service';
import { normalizeQuantity } from './engines/quantity.engine';

export interface StockChannelView {
  readonly accountId: string;
  readonly channelCode: string;
  readonly channelName: string;
  readonly externalProductId: string | null;
  readonly externalVariantId: string | null;
  readonly externalId: string | null;
}

function channelView(target: {
  accountId: string;
  channelCode: string;
  channelName: string;
  externalProductId: string | null;
  externalVariantId: string | null;
}): StockChannelView {
  return {
    accountId: target.accountId,
    channelCode: target.channelCode,
    channelName: target.channelName,
    externalProductId: target.externalProductId,
    externalVariantId: target.externalVariantId,
    externalId: target.externalVariantId ?? target.externalProductId,
  };
}

@Injectable()
export class InventoryStockService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: InventoryRepository,
    private readonly inventory: InventoryService,
    private readonly catalog: CatalogLookupService,
    private readonly sync: ChannelSyncService,
  ) {}

  async list(
    ctx: TenantContext,
    query: { page: number; perPage: number; search?: string | undefined; q?: string | undefined },
  ): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const search = query.search ?? query.q ?? null;
    const result = await this.repo.listStock(this.db, {
      orgId: ctx.orgId,
      search,
      limit: query.perPage,
      offset: (query.page - 1) * query.perPage,
    });
    return {
      total: result.total,
      items: result.items.map((row) => {
        const channels = (row.channels ?? []).map(channelView);
        return {
          id: row.variantId,
          variantId: row.variantId,
          productId: row.productId,
          productName: row.productName,
          sku: row.sku,
          onHand: normalizeQuantity(row.onHand),
          reserved: normalizeQuantity(row.reserved),
          channels,
          // Contract alias: channel listings aggregated from the mappings.
          channelAccounts: channels,
        };
      }),
    };
  }

  async adjust(
    ctx: TenantContext,
    input: {
      variantId: string;
      quantityDelta: number;
      reason?: string | undefined;
      warehouseId?: string | undefined;
    },
  ): Promise<Record<string, unknown>> {
    const adjusted = await this.inventory.quickAdjust(ctx, input);
    const targets = await this.repo.listStockChannelTargets(
      this.db,
      ctx.orgId,
      adjusted.variantInternalId,
    );
    const queuedAccounts: string[] = [];
    const queuedChannels: StockChannelView[] = [];
    for (const target of targets) {
      const jobId = await this.queuePush(ctx, target);
      if (jobId === null) continue;
      queuedAccounts.push(target.accountId);
      queuedChannels.push(channelView(target));
    }
    return {
      adjustmentId: adjusted.adjustmentId,
      variantId: adjusted.variantId,
      warehouseId: adjusted.warehouseId,
      onHand: adjusted.onHand,
      queuedAccounts,
      // Alias kept for the stock screen; same accounts, channel-labelled.
      queuedChannels,
    };
  }

  async history(
    ctx: TenantContext,
    variantId: string,
    query: { page: number; perPage: number },
  ): Promise<{ items: StockHistoryRow[]; total: number }> {
    const variant = await this.catalog.requireVariant(ctx, variantId);
    return this.repo.stockHistory(this.db, {
      orgId: ctx.orgId,
      variantInternalId: variant.internalId,
      limit: query.perPage,
      offset: (query.page - 1) * query.perPage,
    });
  }

  /**
   * Enqueues one `inventory_push` job and runs it after the response. A mapping
   * whose adapter lacks or rejects the capability is skipped: the stock change is
   * already committed and must not be reported as failed.
   */
  private async queuePush(ctx: TenantContext, target: StockChannelTarget): Promise<string | null> {
    try {
      const job = await this.sync.trigger({
        organizationId: ctx.orgId.toString(),
        accountId: target.accountInternalId,
        type: 'inventory_push',
        force: true,
      });
      setImmediate(() => {
        void this.sync.runJob(job.jobId).catch(() => undefined);
      });
      return job.jobId;
    } catch {
      return null;
    }
  }
}
