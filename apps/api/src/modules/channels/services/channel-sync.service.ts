/**
 * Channel sync orchestration (ADR-0006 / API.md §8.5).
 *
 * - Trigger validates capability, debounces stock pushes and mirrors each unit
 *   of work in `channel_sync_jobs`.
 * - The worker calls `runJob`; retries use exponential backoff + jitter and
 *   terminally failed jobs land in `erp.integration_dead_letters`.
 * - Orders are ingested as canonical events (sales owns order creation); the
 *   natural key `channel:order:{id}` and the outbox write share one transaction.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';

import { AppError } from '@saman/shared';
import { DB, type Db } from '../../../common/contracts';
import {
  IntegrationError,
  type CanonicalOrder,
  type InventoryUpdate,
  type PriceUpdate,
} from '../domain/channel.types';
import { hashNaturalKey } from '../infrastructure/backoff';
import { backoffDelayMs, shouldDeadLetter } from '../infrastructure/backoff';
import { debounceKey } from '../infrastructure/backoff';
import { maxDecimalZero, subtractDecimal, unitsToDecimal, decimalToUnits } from '../domain/decimal';
import { withTransaction, asNumber, asString } from '../infrastructure/sql';
import type { AppLogger } from '../ports/logger.port';
import { LOGGER } from '../ports/logger.port';
import { CHANNEL_PRICE_SOURCE, type ChannelPriceSourcePort } from '../ports/channel-price.port';
import type { ChannelAccountService } from './channel-accounts.service';
import {
  SqlChannelSyncRepository,
  type SyncJobRow,
  type SyncJobType,
} from '../repositories/channel-sync.repository';
import {
  SqlChannelMappingRepository,
  type ChannelMappingRepositoryPort,
} from '../repositories/channel-mapping.repository';
import {
  SqlOutboxWriter,
  type OutboxWriterPort,
} from '../repositories/channel-webhook.repository';

export const SYNC_TRIGGER_TYPES = [
  'inventory_push',
  'price_push',
  'order_pull',
  'full_reconcile',
  'product_push',
  'settlement_pull',
] as const;
export type SyncTriggerType = (typeof SYNC_TRIGGER_TYPES)[number];

export interface SyncScope {
  readonly variantIds?: readonly string[];
  readonly from?: Date;
  readonly to?: Date;
}

export interface SyncJobResult {
  readonly jobId: string;
  readonly jobType: SyncJobType;
  readonly status: 'succeeded' | 'failed' | 'dead';
  readonly summary: Record<string, unknown>;
}

interface InventoryRow {
  variantId: string;
  externalVariantId: string;
  externalProductId: string | null;
  available: string;
  safety: string;
}

interface PriceRow {
  variantId: string;
  externalVariantId: string;
}

@Injectable()
export class ChannelSyncService {
  private readonly sync: SqlChannelSyncRepository;
  private readonly mappings: ChannelMappingRepositoryPort;
  private readonly outbox: OutboxWriterPort = new SqlOutboxWriter();
  private readonly now: () => Date;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly accounts: ChannelAccountService,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Optional()
    @Inject(CHANNEL_PRICE_SOURCE)
    private readonly priceSource?: ChannelPriceSourcePort,
  ) {
    this.sync = new SqlChannelSyncRepository(db);
    this.mappings = new SqlChannelMappingRepository(db);
    this.now = () => new Date();
  }

  async trigger(input: {
    organizationId: string;
    accountId: string;
    type: SyncTriggerType;
    scope?: SyncScope;
  }): Promise<{ jobId: string; status: string }> {
    const jobType = this.toJobType(input.type);
    const resolved = await this.accounts.resolveForSync(input.organizationId, input.accountId);
    const capability = this.capabilityFor(input.type);
    if (!resolved.adapter.supports(capability)) {
      throw new IntegrationError('NOT_IMPLEMENTED', {
        messageFa: 'این عملیات برای کانال انتخابی پشتیبانی نمی‌شود.',
        details: { channel: resolved.adapter.code, capability },
      });
    }

    const debounceSeconds = this.numberSetting(resolved.row.settings, 'stockDebounceSeconds', 3);
    const operationKey =
      input.type === 'inventory_push'
        ? debounceKey(`stock:${input.accountId}`, debounceSeconds * 1000, this.now().getTime())
        : input.type === 'price_push'
          ? debounceKey(`price:${input.accountId}`, debounceSeconds * 1000, this.now().getTime())
          : input.type === 'order_pull'
            ? `orders:${input.accountId}`
            : `reconcile:${input.accountId}:${this.now().toISOString().slice(0, 10)}`;

    const job = await this.sync.enqueue({
      organizationId: input.organizationId,
      accountId: input.accountId,
      jobType,
      operationKey,
      ...(input.scope?.from === undefined ? {} : {}),
    });
    this.logger.info(
      { jobId: job.id, accountId: input.accountId, jobType, operationKey },
      'channel sync job queued',
    );
    return { jobId: job.id, status: job.status };
  }

  /** Executes a mirrored job exactly once (re-running a succeeded job is a no-op). */
  async runJob(jobId: string, workerId = 'worker'): Promise<SyncJobResult> {
    const job = await this.sync.getJob(jobId);
    if (job === null) throw new AppError('NOT_FOUND', { message: 'کار همگام‌سازی یافت نشد.' });
    if (job.status === 'succeeded') {
      return { jobId, jobType: job.jobType, status: 'succeeded', summary: { skipped: true } };
    }
    await this.sync.markRunning(job.id, workerId);
    const resolved = await this.accounts.resolveForSync(job.organizationId, job.accountId);

    try {
      let summary: Record<string, unknown>;
      switch (job.jobType) {
        case 'push_inventory':
          summary = await this.pushInventory(resolved, job);
          break;
        case 'push_price':
          summary = await this.pushPrices(resolved, job);
          break;
        case 'pull_orders':
          summary = await this.pullOrders(resolved, job);
          break;
        case 'full_reconcile':
          summary = await this.reconcile(resolved, job);
          break;
        default:
          throw new IntegrationError('NOT_IMPLEMENTED', {
            messageFa: 'این نوع کار همگام‌سازی پیاده‌سازی نشده است.',
            details: { jobType: job.jobType },
          });
      }
      await this.sync.markSucceeded(job.id, summary as unknown as import('../domain/pii').JsonValue);
      return { jobId: job.id, jobType: job.jobType, status: 'succeeded', summary };
    } catch (error) {
      const integration =
        error instanceof IntegrationError
          ? error
          : new IntegrationError('UPSTREAM_UNAVAILABLE', {
              messageFa: 'همگام‌سازی با خطا مواجه شد.',
              retryable: true,
              cause: error,
            });
      const attempts = job.attempts + 1;
      const dead = shouldDeadLetter(attempts, job.maxAttempts) || !integration.retryable;
      if (dead) {
        await this.sync.deadLetter({
          organizationId: job.organizationId,
          integration: resolved.adapter.code,
          operation: job.jobType,
          ...(job.entityType === null ? {} : { entityType: job.entityType }),
          ...(job.entityId === null ? {} : { entityId: job.entityId }),
          payload: { jobId: job.id, operationKey: job.operationKey },
          errorCode: integration.code,
          errorMessage: integration.messageFa,
          retryCount: attempts,
        });
        await this.sync.markDead(job.id, integration.code, integration.messageFa);
      } else {
        await this.sync.markFailed(
          job.id,
          integration.code,
          integration.messageFa,
          new Date(this.now().getTime() + backoffDelayMs({ attempts })),
        );
      }
      this.logger[dead ? 'error' : 'warn'](
        { jobId: job.id, jobType: job.jobType, code: integration.code, attempts, dead },
        'channel sync job failed',
      );
      return {
        jobId: job.id,
        jobType: job.jobType,
        status: dead ? 'dead' : 'failed',
        summary: { errorCode: integration.code, messageFa: integration.messageFa, attempts },
      };
    }
  }

  private async pushInventory(
    resolved: Awaited<ReturnType<ChannelAccountService['resolveForSync']>>,
    job: SyncJobRow,
  ): Promise<Record<string, unknown>> {
    const rows = await this.loadInventoryRows(resolved.row.id, resolved.row.organizationId);
    if (rows.length === 0) return { pushed: 0, failed: 0, skipped: 'no_mappings' };

    const batchSize = this.numberSetting(resolved.row.settings, 'stockBatchSize', 100);
    const items: InventoryUpdate[] = [];
    for (const row of rows.slice(0, Math.max(1, batchSize))) {
      const available = maxDecimalZero(
        subtractDecimal(subtractDecimal(row.available, row.safety), resolved.row.stockSafetyQty),
      );
      items.push({
        externalVariantId: row.externalVariantId,
        ...(row.externalProductId === null ? {} : { externalProductId: row.externalProductId }),
        available,
      });
    }

    const result = await resolved.adapter.pushInventory(resolved.account, items);
    for (const item of items) {
      if (result.failed.some((failure) => failure.externalId === item.externalVariantId)) continue;
      const row = rows.find((candidate) => candidate.externalVariantId === item.externalVariantId);
      if (row !== undefined) {
        await this.db`
          update erp.channel_inventory_mappings
          set last_pushed_qty = ${item.available}::numeric, last_pushed_at = now(), last_push_error = null
          where channel_account_id = ${resolved.row.id}::bigint
            and product_variant_id = ${row.variantId}::bigint`;
      }
    }
    for (const failure of result.failed) {
      await this.db`
        update erp.channel_product_mappings
        set sync_status = 'failed', last_error = ${`${failure.code}: ${failure.messageFa}`.slice(0, 500)}
        where channel_account_id = ${resolved.row.id}::bigint
          and external_variant_id = ${failure.externalId}`;
    }
    if (result.failed.length > 0 && result.succeeded === 0) {
      const retryable = result.failed.some((failure) => failure.retryable);
      throw new IntegrationError(retryable ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_INVALID_RESPONSE', {
        messageFa: 'ارسال موجودی به کانال ناموفق بود.',
        retryable,
      });
    }
    return {
      pushed: result.succeeded,
      failed: result.failed.length,
      failures: result.failed.map((failure) => ({
        externalId: failure.externalId,
        code: failure.code,
      })),
      jobId: job.id,
    };
  }

  private async pushPrices(
    resolved: Awaited<ReturnType<ChannelAccountService['resolveForSync']>>,
    job: SyncJobRow,
  ): Promise<Record<string, unknown>> {
    if (this.priceSource === undefined) {
      throw new IntegrationError('NOT_IMPLEMENTED', {
        messageFa: 'منبع قیمت کانال به ماژول کانال‌ها متصل نشده است.',
        details: { port: 'CHANNEL_PRICE_SOURCE' },
      });
    }
    const mappings = await this.db<{ product_variant_id: unknown; external_variant_id: unknown }[]>`
      select product_variant_id, external_variant_id
      from erp.channel_product_mappings
      where channel_account_id = ${resolved.row.id}::bigint
        and is_published = true
        and external_variant_id is not null
      limit 500`;
    const items: PriceUpdate[] = [];
    for (const row of mappings) {
      const variantId = asString(row.product_variant_id);
      const externalVariantId = asString(row.external_variant_id);
      const price = await this.priceSource.getPublishedPrice(resolved.row.id, variantId);
      if (price === null) continue;
      items.push({ externalVariantId, value: price });
    }
    if (items.length === 0) return { pushed: 0, skipped: 'no_prices', jobId: job.id };
    const result = await resolved.adapter.pushPrices(resolved.account, items);
    return {
      pushed: result.succeeded,
      failed: result.failed.length,
      failures: result.failed.map((failure) => ({ externalId: failure.externalId, code: failure.code })),
      jobId: job.id,
    };
  }

  private async pullOrders(
    resolved: Awaited<ReturnType<ChannelAccountService['resolveForSync']>>,
    job: SyncJobRow,
  ): Promise<Record<string, unknown>> {
    const cursor = await this.sync.getCursor(resolved.row.id, 'orders');
    const since = cursor?.cursorAt ?? new Date(this.now().getTime() - 24 * 60 * 60 * 1000);
    let received = 0;
    let duplicates = 0;
    let latestMs: number | null = null;

    for await (const order of resolved.adapter.pullOrders(resolved.account, since)) {
      const canonical = this.canonicalOrderPayload(order);
      const requestHash = hashNaturalKey(JSON.stringify(canonical));
      const outcome = await this.ingestOrder(resolved, order, canonical, requestHash);
      if (outcome.inserted) received += 1;
      else duplicates += 1;
      if (latestMs === null || order.placedAt.getTime() > latestMs) {
        latestMs = order.placedAt.getTime();
      }
    }
    const latest = latestMs === null ? null : new Date(latestMs);

    if (latest !== null) {
      await this.sync.setCursor({
        accountId: resolved.row.id,
        stream: 'orders',
        cursorValue: latest.toISOString(),
        cursorAt: latest,
      });
    }
    return { received, duplicates, since: since.toISOString(), jobId: job.id };
  }

  private async ingestOrder(
    resolved: Awaited<ReturnType<ChannelAccountService['resolveForSync']>>,
    order: CanonicalOrder,
    canonical: Record<string, unknown>,
    requestHash: string,
  ): Promise<{ inserted: boolean }> {
    return withTransaction(this.db, async (tx) => {
      const key = `channel:order:${order.externalOrderId}`;
      const scope = `channels.order_pull:${resolved.row.id}`;
      // Serialize per natural key; the physical unique index includes nullable
      // actor_user_id, so NULL alone would not dedupe.
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${resolved.row.organizationId}|${scope}|${key}`}, 0))`;
      const existing = await tx<{ request_hash: string }[]>`
        select request_hash from erp.idempotency_keys
        where organization_id = ${resolved.row.organizationId}::bigint
          and scope = ${scope}
          and key = ${key}
        order by id desc
        limit 1`;
      if (existing[0] !== undefined) {
        if (existing[0].request_hash !== requestHash) {
          this.logger.warn(
            { accountId: resolved.row.id, externalOrderId: order.externalOrderId },
            'duplicate channel order with a different payload (mutated replay)',
          );
        }
        return { inserted: false };
      }
      await tx`
        insert into erp.idempotency_keys (
          organization_id, key, scope, request_hash, expires_at
        ) values (
          ${resolved.row.organizationId}::bigint, ${key}, ${scope},
          ${requestHash}, now() + interval '7 days'
        )`;
      await this.outbox.emit(tx, {
        organizationId: resolved.row.organizationId,
        type: 'channel.order.received',
        aggregateType: 'channel_account',
        aggregateId: resolved.row.id,
        payload: {
          ...canonical,
          channelAccountId: resolved.row.id,
          channelCode: resolved.adapter.code,
          externalOrderId: order.externalOrderId,
          grandTotal: order.totals.grandTotal,
          lineCount: order.lines.length,
        },
      } as Parameters<OutboxWriterPort['emit']>[1]);
      return { inserted: true };
    });
  }

  private async reconcile(
    resolved: Awaited<ReturnType<ChannelAccountService['resolveForSync']>>,
    job: SyncJobRow,
  ): Promise<Record<string, unknown>> {
    if (resolved.adapter.pullInventory === undefined) {
      throw new IntegrationError('NOT_IMPLEMENTED', {
        messageFa: 'مغایرت‌گیری موجودی برای این کانال پیاده‌سازی نشده است.',
      });
    }
    const refs = await this.db<
      { product_variant_id: unknown; external_variant_id: unknown; external_product_id: unknown }[]
    >`
      select product_variant_id, external_variant_id, external_product_id
      from erp.channel_product_mappings
      where channel_account_id = ${resolved.row.id}::bigint
        and external_variant_id is not null
      limit 1000`;
    const local = await this.loadInventoryRows(resolved.row.id, resolved.row.organizationId);
    const localByVariant = new Map(local.map((row) => [row.variantId, row]));
    let checked = 0;
    let drifted = 0;
    for await (const external of resolved.adapter.pullInventory(
      resolved.account,
      refs.map((row) => ({
        variantId: asString(row.product_variant_id),
        externalVariantId: asString(row.external_variant_id),
        ...(row.external_product_id === null
          ? {}
          : { externalProductId: asString(row.external_product_id) }),
      })),
    )) {
      const row = localByVariant.get(external.variantId);
      if (row === undefined) continue;
      checked += 1;
      const available = maxDecimalZero(subtractDecimal(row.available, row.safety));
      if (decimalToUnits(available) !== decimalToUnits(external.available)) drifted += 1;
    }
    return { checked, drifted, jobId: job.id, mode: 'report_only' };
  }

  private async loadInventoryRows(accountId: string, organizationId: string): Promise<InventoryRow[]> {
    const rows = await this.db<
      {
        variant_id: unknown;
        external_variant_id: unknown;
        external_product_id: unknown;
        available_qty: unknown;
        safety_qty: unknown;
      }[]
    >`
      select m.product_variant_id as variant_id,
             m.external_variant_id,
             m.external_product_id,
             sum(i.available_qty)::text as available_qty,
             sum(i.safety_qty)::text as safety_qty
      from erp.channel_product_mappings m
      join erp.channel_inventory_mappings i
        on i.channel_account_id = m.channel_account_id
       and i.product_variant_id = m.product_variant_id
      join erp.channel_accounts a on a.id = m.channel_account_id
      where a.organization_id = ${organizationId}::bigint
        and m.channel_account_id = ${accountId}::bigint
        and m.external_variant_id is not null
        and i.sync_enabled = true
      group by m.product_variant_id, m.external_variant_id, m.external_product_id`;
    return rows.map((row) => ({
      variantId: asString(row.variant_id),
      externalVariantId: asString(row.external_variant_id),
      externalProductId: row.external_product_id === null ? null : asString(row.external_product_id),
      available: asString(row.available_qty) || '0',
      safety: asString(row.safety_qty) || '0',
    }));
  }

  private canonicalOrderPayload(order: CanonicalOrder): Record<string, unknown> {
    return {
      externalOrderId: order.externalOrderId,
      externalStatus: order.externalStatus,
      placedAt: order.placedAt.toISOString(),
      currency: order.currency,
      lines: order.lines.map((line) => ({
        externalLineId: line.externalLineId,
        externalSku: line.externalSku,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discount: line.discount,
      })),
      totals: order.totals,
      customerRefHash: order.customerRefHash,
      shippingRefHash: order.shippingRefHash,
      rawPayloadHash: order.rawPayloadHash,
    };
  }

  private toJobType(type: SyncTriggerType): SyncJobType {
    switch (type) {
      case 'inventory_push':
        return 'push_inventory';
      case 'price_push':
        return 'push_price';
      case 'order_pull':
        return 'pull_orders';
      case 'full_reconcile':
        return 'full_reconcile';
      case 'product_push':
      case 'settlement_pull':
        throw new IntegrationError('NOT_IMPLEMENTED', {
          messageFa: 'این نوع همگام‌سازی در نسخهٔ فعلی فعال نیست.',
          details: { type },
        });
    }
  }

  private capabilityFor(type: SyncTriggerType): 'stock.push' | 'price.push' | 'order.pull' {
    switch (type) {
      case 'inventory_push':
      case 'full_reconcile':
        return 'stock.push';
      case 'price_push':
        return 'price.push';
      default:
        return 'order.pull';
    }
  }

  private numberSetting(
    settings: Readonly<Record<string, unknown>>,
    key: string,
    fallback: number,
  ): number {
    const value = settings[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }
}

export { unitsToDecimal, asNumber };
