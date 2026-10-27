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
import { ModuleRef } from '@nestjs/core';

import { AppError } from '@saman/shared';
import { DB, type Db } from '../../../common/contracts';
import { IntegrationError, type CanonicalOrder, type InventoryUpdate, type PriceUpdate } from '../domain/channel.types';
import { hashNaturalKey } from '../infrastructure/backoff';
import { backoffDelayMs, shouldDeadLetter } from '../infrastructure/backoff';
import { debounceKey } from '../infrastructure/backoff';
import { maxDecimalZero, subtractDecimal, unitsToDecimal, decimalToUnits } from '../domain/decimal';
import { withTransaction, asNumber, asRecord, asString, isUniqueViolation } from '../infrastructure/sql';
import type { AppLogger } from '../ports/logger.port';
import { LOGGER } from '../ports/logger.port';
import { CHANNEL_PRICE_SOURCE, type ChannelPriceSourcePort } from '../ports/channel-price.port';
import type { ExternalProduct } from '../ports/channel-adapter.port';
import { ChannelAccountService } from './channel-accounts.service';
import { SqlChannelSyncRepository, type SyncJobRow, type SyncJobType } from '../repositories/channel-sync.repository';
import { SqlChannelMappingRepository, type ChannelMappingRepositoryPort } from '../repositories/channel-mapping.repository';
import { SqlOutboxWriter, type OutboxWriterPort } from '../repositories/channel-webhook.repository';

export const SYNC_TRIGGER_TYPES = [
  'inventory_push',
  'price_push',
  'order_pull',
  'full_reconcile',
  'product_push',
  'product_import',
  'settlement_pull',
] as const;
export type SyncTriggerType = (typeof SYNC_TRIGGER_TYPES)[number];

export interface SyncScope {
  readonly variantIds?: readonly string[];
  readonly from?: Date;
  readonly to?: Date;
  /** Read-only run: the job reports counts and writes nothing. */
  readonly dryRun?: boolean;
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

/** Channel-supplied detail persisted on `erp.products` during import. */
interface ProductSpec {
  readonly description: string | null;
  readonly attributes: Record<string, string> | null;
  readonly categoryId: string | null;
  /** Absolute http(s) image URL, written to `products.image_url` when present. */
  readonly imageUrl: string | null;
}

/** Live commission lookup exposed by channel adapters that support it (Digikala). */
interface CommissionCapableAdapter {
  fetchProductCommission?: (
    account: unknown,
    productId: string,
  ) => Promise<{ percent: number | null; raw: Record<string, unknown> }>;
}

/** Outcome of importing one channel product. */
interface ImportOutcome {
  readonly outcome: 'imported' | 'updated' | 'skipped';
  /** Local variant id, when the row was created or refreshed. */
  readonly variantId: string | null;
}

/** How far back `backfill-orders` re-reads the channel. */
const ORDER_BACKFILL_DAYS = 7;
/** `sync-commissions` is bounded so one request cannot walk a whole catalogue. */
const COMMISSION_SYNC_LIMIT = 200;

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
    private readonly moduleRef: ModuleRef,
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
    /** Skip debounce coalescing (used by stock adjustments that must push now). */
    force?: boolean;
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
        ? input.force === true
          ? `stock:${input.accountId}:${this.now().getTime()}`
          : debounceKey(`stock:${input.accountId}`, debounceSeconds * 1000, this.now().getTime())
        : input.type === 'price_push'
          ? input.force === true
            ? `price:${input.accountId}:${this.now().getTime()}`
            : debounceKey(`price:${input.accountId}`, debounceSeconds * 1000, this.now().getTime())
          : input.type === 'order_pull'
            ? // `enqueue` coalesces against a *succeeded* job of the same key, so a
              // fixed key would make every later pull a no-op. A forced pull (the
              // auto-sync loop) therefore gets its own key.
              input.force === true
              ? `orders:${input.accountId}:${this.now().getTime()}`
              : `orders:${input.accountId}`
            : input.type === 'product_import' || input.type === 'product_push'
              ? `products:${input.scope?.dryRun === true ? 'dry:' : ''}${input.accountId}:${this.now().getTime()}`
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
        case 'product_import':
          summary = await this.importProducts(resolved, job);
          break;
        default:
          throw new IntegrationError('NOT_IMPLEMENTED', {
            messageFa: 'این نوع کار همگام‌سازی پیاده‌سازی نشده است.',
            details: { jobType: job.jobType },
          });
      }
      await this.sync.markSucceeded(job.id, summary as unknown as import('../domain/pii').JsonValue);
      // Pulled products get the account's pricing policy applied automatically
      // when `autoApply` is on (lazy lookup keeps pricing/channels acyclic).
      if (job.jobType === 'product_import' && job.operationKey?.startsWith('products:dry:') !== true) {
        await this.autoApplyPricing(job);
      }
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

  /**
   * Re-reads the last `days` of channel orders and re-emits `channel.order.received`
   * for them (admin repair). The order cursor and the per-order idempotency keys
   * of this account are cleared in one transaction, then a `pull_orders` job is
   * queued with a backfill operation key so the worker widens its window;
   * re-emitting is still idempotent because `sales` owns the natural key.
   */
  async backfillOrders(input: {
    organizationId: string;
    accountId: string;
    days?: number;
  }): Promise<{
    jobId: string;
    status: string;
    since: string;
    clearedCursors: number;
    clearedIdempotencyKeys: number;
  }> {
    const days = Math.min(30, Math.max(1, Math.trunc(input.days ?? ORDER_BACKFILL_DAYS)));
    const resolved = await this.accounts.resolveForSync(input.organizationId, input.accountId);
    if (!resolved.adapter.supports('order.pull')) {
      throw new IntegrationError('NOT_IMPLEMENTED', {
        messageFa: 'این کانال خواندن سفارش ندارد.',
        details: { channel: resolved.adapter.code, capability: 'order.pull' },
      });
    }
    const scope = `channels.order_pull:${resolved.row.id}`;
    const cleared = await withTransaction(this.db, async (tx) => {
      const cursors = await tx`
        delete from erp.channel_sync_cursors
        where channel_account_id = ${resolved.row.id}::bigint and stream = 'orders'
        returning id`;
      const keys = await tx`
        delete from erp.idempotency_keys
        where organization_id = ${resolved.row.organizationId}::bigint and scope = ${scope}
        returning id`;
      return { cursors: cursors.length, keys: keys.length };
    });

    const since = new Date(this.now().getTime() - days * 24 * 60 * 60 * 1000);
    const job = await this.sync.enqueue({
      organizationId: resolved.row.organizationId,
      accountId: resolved.row.id,
      jobType: 'pull_orders',
      // `pull_orders` reads the window from this prefix (see `pullOrders`).
      operationKey: `orders:backfill:${resolved.row.id}:${this.now().getTime()}`,
    });
    this.logger.info(
      {
        jobId: job.id,
        accountId: resolved.row.id,
        clearedCursors: cleared.cursors,
        clearedIdempotencyKeys: cleared.keys,
        since: since.toISOString(),
      },
      'channel order backfill queued',
    );
    return {
      jobId: job.id,
      status: job.status,
      since: since.toISOString(),
      clearedCursors: cleared.cursors,
      clearedIdempotencyKeys: cleared.keys,
    };
  }

  /**
   * Refreshes `erp.channel_product_costs` for the account's mapped variants
   * (bounded). Counts are returned so the admin UI can report progress.
   */
  async syncCommissions(input: {
    organizationId: string;
    accountId: string;
    limit?: number;
  }): Promise<{ scanned: number; updated: number; failed: number; withPercent: number; skipped: number }> {
    const resolved = await this.accounts.resolveForSync(input.organizationId, input.accountId);
    const adapter = resolved.adapter as unknown as CommissionCapableAdapter;
    if (typeof adapter.fetchProductCommission !== 'function') {
      throw new IntegrationError('NOT_IMPLEMENTED', {
        messageFa: 'نرخ کمیسیون برای این کانال قابل خواندن نیست.',
        details: { channel: resolved.adapter.code },
      });
    }
    const limit = Math.min(
      COMMISSION_SYNC_LIMIT,
      Math.max(1, Math.trunc(input.limit ?? COMMISSION_SYNC_LIMIT)),
    );
    const rows = await this.db<{ product_variant_id: unknown; external_product_id: unknown }[]>`
      select m.product_variant_id, m.external_product_id
      from erp.channel_product_mappings m
      where m.channel_account_id = ${resolved.row.id}::bigint
        and m.deleted_at is null
        and m.external_product_id ~ '^[0-9]+$'
      order by m.id
      limit ${limit}`;
    let scanned = 0;
    let updated = 0;
    let failed = 0;
    let withPercent = 0;
    let skipped = 0;
    const seen = new Set<string>();
    for (const row of rows) {
      const variantId = asString(row.product_variant_id);
      if (variantId.length === 0 || seen.has(variantId)) {
        skipped += 1;
        continue;
      }
      seen.add(variantId);
      scanned += 1;
      const result = await this.storeProductCommission(
        resolved,
        variantId,
        asString(row.external_product_id),
        adapter,
      );
      if (result.status === 'stored') updated += 1;
      else if (result.status === 'failed') failed += 1;
      else skipped += 1;
      if (result.percent !== null) withPercent += 1;
    }
    this.logger.info(
      { accountId: resolved.row.id, scanned, updated, failed, skipped, withPercent },
      'channel commissions refreshed',
    );
    return { scanned, updated, failed, withPercent, skipped };
  }

  /**
   * Applies the account's pricing policy after a successful product pull.
   * `ModuleRef` + dynamic import are intentional: the channels module must not
   * statically depend on the pricing module (pricing pushes through channels).
   */
  private async autoApplyPricing(job: SyncJobRow): Promise<void> {
    try {
      const { PricingPolicyService } = await import('../../pricing/pricing-policy.service');
      const policies = this.moduleRef.get(PricingPolicyService, { strict: false });
      await policies.applyForAccount(job.organizationId, job.accountId, { onlyIfAutoApply: true });
    } catch (error) {
      this.logger.warn(
        {
          jobId: job.id,
          accountId: job.accountId,
          error: error instanceof Error ? error.message : 'pricing_auto_apply_failed',
        },
        'automatic pricing apply after product pull failed',
      );
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
    if (result.failed.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[channel-push] ${resolved.adapter.code} failures: ` +
          result.failed.map((failure) => `${failure.externalId}:${failure.code}:${failure.messageFa}`).join(' | ').slice(0, 800),
      );
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
    // `backfill-orders` clears the cursor and queues a job with this prefix: the
    // window is then fixed at seven days instead of "since the last cursor".
    const backfill = job.operationKey?.startsWith('orders:backfill:') === true;
    const cursor = backfill ? null : await this.sync.getCursor(resolved.row.id, 'orders');
    const since = backfill
      ? new Date(this.now().getTime() - ORDER_BACKFILL_DAYS * 24 * 60 * 60 * 1000)
      : cursor?.cursorAt ?? new Date(this.now().getTime() - 24 * 60 * 60 * 1000);
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

  /**
   * First-sync catalogue import (Carexy/Digikala): reads the channel's product
   * list, deduplicates by external product id and upserts product → variant →
   * channel mapping. Counts are reported in the job summary.
   *
   * `dryRun` (trigger flag or account settings) reads everything and writes
   * nothing.
   */
  private async importProducts(
    resolved: Awaited<ReturnType<ChannelAccountService['resolveForSync']>>,
    job: SyncJobRow,
  ): Promise<Record<string, unknown>> {
    if (resolved.adapter.pullProducts === undefined) {
      throw new IntegrationError('NOT_IMPLEMENTED', {
        messageFa: 'ورود محصولات برای این کانال پیاده‌سازی نشده است.',
        details: { channel: resolved.adapter.code },
      });
    }

    const dryRun =
      resolved.row.settings['dryRun'] === true ||
      resolved.row.settings['dry_run'] === true ||
      job.operationKey?.startsWith('products:dry:') === true;

    // The pull is bounded per adapter call, but still deduplicate by external id
    // so a paging overlap or a product with several inventory rows counts once.
    const products = new Map<string, ExternalProduct>();
    for await (const item of resolved.adapter.pullProducts(resolved.account)) {
      const externalId = item.externalProductId.trim();
      if (externalId.length === 0) continue;
      if (!products.has(externalId)) products.set(externalId, item);
    }
    const samples = [...products.keys()].slice(0, 3);
    const baseUomId = await this.firstBaseUomId(resolved.row.organizationId);

    if (dryRun) {
      const known = await this.countMappedProducts(resolved.row.id, [...products.keys()]);
      return {
        mode: 'dry_run',
        found: products.size,
        wouldImport: products.size - known,
        wouldUpdate: known,
        imported: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        samples,
        ...(baseUomId === null ? { reason: 'no_base_uom' } : {}),
        jobId: job.id,
      };
    }

    if (baseUomId === null) {
      return {
        imported: 0,
        updated: 0,
        skipped: products.size,
        failed: 0,
        samples,
        reason: 'no_base_uom',
        jobId: job.id,
      };
    }

    const prefix = this.productPrefix(resolved.adapter.code);
    // Category find-or-create is per import run: one lookup per distinct name.
    const categoryCache = new Map<string, string | null>();
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    let commissions = 0;
    let commissionAttempts = 0;
    for (const [externalId, item] of products) {
      try {
        const result = await this.importProduct(
          resolved,
          item,
          externalId,
          baseUomId,
          prefix,
          categoryCache,
        );
        if (result.outcome === 'imported') imported += 1;
        else if (result.outcome === 'updated') updated += 1;
        else skipped += 1;
        // Commission is read from the channel for every imported/refreshed row
        // (bounded per run) so `channel_product_costs` fills up with the import.
        // A commission failure must never turn a successful product into a
        // failed import row, so it is isolated from the import try/catch above.
        if (result.variantId !== null && commissionAttempts < COMMISSION_SYNC_LIMIT) {
          commissionAttempts += 1;
          try {
            const stored = await this.storeProductCommission(
              resolved,
              result.variantId,
              externalId,
            );
            if (stored.status === 'stored') commissions += 1;
          } catch (error) {
            this.logger.warn(
              {
                accountId: resolved.row.id,
                externalProductId: externalId,
                error: error instanceof Error ? error.message : 'commission_store_failed',
              },
              'channel commission could not be stored',
            );
          }
        }
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : 'import_failed';
        await this.recordImportError(resolved.row.id, externalId, message);
        this.logger.warn(
          { accountId: resolved.row.id, externalProductId: externalId, error: message },
          'channel product import row failed',
        );
      }
    }
    return { imported, updated, skipped, failed, commissions, samples, jobId: job.id };
  }

  private async firstBaseUomId(organizationId: string): Promise<string | null> {
    const rows = await this.db<{ id: unknown }[]>`
      select id from erp.units_of_measure
      where organization_id = ${organizationId}::bigint
        and deleted_at is null
      order by is_base desc, id asc
      limit 1`;
    return rows[0] === undefined ? null : asString(rows[0].id);
  }

  private async countMappedProducts(
    accountId: string,
    externalIds: readonly string[],
  ): Promise<number> {
    if (externalIds.length === 0) return 0;
    const rows = await this.db<{ count: unknown }[]>`
      select count(*)::int as count
      from erp.channel_product_mappings
      where channel_account_id = ${accountId}::bigint
        and deleted_at is null
        and external_product_id in (
          select jsonb_array_elements_text(${JSON.stringify(externalIds)}::jsonb)
        )`;
    return rows[0] === undefined ? 0 : asNumber(rows[0].count);
  }

  private async importProduct(
    resolved: Awaited<ReturnType<ChannelAccountService['resolveForSync']>>,
    item: ExternalProduct,
    externalId: string,
    baseUomId: string,
    prefix: string,
    categoryCache: Map<string, string | null>,
  ): Promise<ImportOutcome> {
    const organizationId = resolved.row.organizationId;
    const accountId = resolved.row.id;
    const title = (item.title.trim() || externalId).slice(0, 300);
    const externalVariantId = (item.externalVariantId ?? externalId ?? '').trim().slice(0, 150) || null;
    const externalSku = (item.sku ?? '').trim().slice(0, 150) || null;
    const barcode = (item.barcode ?? '').trim().slice(0, 50) || null;
    const productNo = `${prefix}-${externalId}`.slice(0, 40);
    const sku = (externalSku ?? `${prefix}-${externalId}`).slice(0, 100);
    const spec: ProductSpec = {
      ...this.normalizedSpec(item),
      categoryId: await this.categoryIdFor(organizationId, item.categoryName, categoryCache),
    };

    // A mapping for this external product already exists: refresh it and the
    // local title/barcode/description/category without creating duplicates.
    const mapped = await this.db<{ id: unknown; product_variant_id: unknown }[]>`
      select id, product_variant_id
      from erp.channel_product_mappings
      where channel_account_id = ${accountId}::bigint
        and external_product_id = ${externalId}
        and deleted_at is null
      order by id desc
      limit 1`;
    if (mapped[0] !== undefined) {
      const variantId = asString(mapped[0].product_variant_id);
      await this.db`
        update erp.channel_product_mappings
        set external_variant_id = coalesce(${externalVariantId}::text, external_variant_id),
            external_sku = coalesce(${externalSku}::text, external_sku),
            sync_status = 'synced',
            last_synced_at = now(),
            last_error = null
        where id = ${asString(mapped[0].id)}::bigint`;
      await this.refreshProductText(organizationId, variantId, title, barcode, spec);
      return { outcome: 'updated', variantId };
    }

    const productId = await this.productIdFor(
      organizationId,
      accountId,
      externalId,
      productNo,
      title,
      baseUomId,
      spec,
    );
    if (productId === null) return { outcome: 'skipped', variantId: null };

    const variantId = await this.variantIdFor(
      productId,
      sku,
      externalId,
      title,
      barcode,
      spec.imageUrl,
    );
    if (variantId === null) return { outcome: 'skipped', variantId: null };

    const outcome = await this.upsertMapping(
      accountId,
      variantId,
      externalId,
      externalVariantId,
      externalSku,
    );
    return { outcome, variantId };
  }

  /**
   * Creates the product once per external id. `product_no` is derived from the
   * external id, so a re-run reuses its own row; a genuine collision (another
   * product already owns that number) falls back to a suffixed number.
   */
  private async productIdFor(
    organizationId: string,
    accountId: string,
    externalId: string,
    productNo: string,
    title: string,
    baseUomId: string,
    spec: ProductSpec,
  ): Promise<string | null> {
    const base = productNo.length > 35 ? productNo.slice(0, 35) : productNo;
    const attributesJson = this.attributesJson(spec.attributes);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const candidate = attempt === 1 ? productNo : `${base}-${attempt}`;
      const rows = await this.db<{ id: unknown }[]>`
        insert into erp.products (
          organization_id, product_no, name, base_uom_id, category_id, description,
          attributes_json, image_url
        )
        values (
          ${organizationId}::bigint, ${candidate}, ${title}, ${baseUomId}::bigint,
          ${spec.categoryId}::bigint, ${spec.description}, ${attributesJson}::jsonb,
          ${spec.imageUrl}::text
        )
        on conflict (organization_id, product_no) where deleted_at is null do nothing
        returning id`;
      if (rows[0] !== undefined) return asString(rows[0].id);

      const existing = await this.productByNumber(organizationId, accountId, externalId, candidate);
      if (existing === null) continue;
      if (!existing.takenByOther) {
        // Reused row: still enrich it with channel detail (never for a product
        // that another channel already owns).
        await this.applyProductSpec(organizationId, existing.id, spec);
        return existing.id;
      }
    }
    return null;
  }

  private async productByNumber(
    organizationId: string,
    accountId: string,
    externalId: string,
    productNo: string,
  ): Promise<{ id: string; takenByOther: boolean } | null> {
    const rows = await this.db<{ id: unknown; taken_by_other: unknown }[]>`
      select p.id,
             exists (
               select 1
               from erp.channel_product_mappings m
               join erp.product_variants v on v.id = m.product_variant_id
               where v.product_id = p.id
                 and m.channel_account_id = ${accountId}::bigint
                 and m.deleted_at is null
                 and m.external_product_id is distinct from ${externalId}
             ) as taken_by_other
      from erp.products p
      where p.organization_id = ${organizationId}::bigint
        and p.product_no = ${productNo}
        and p.deleted_at is null
      limit 1`;
    if (rows[0] === undefined) return null;
    return { id: asString(rows[0].id), takenByOther: rows[0].taken_by_other === true };
  }

  /** `sku` is globally unique: reuse this product's variant, else suffix the sku. */
  private async variantIdFor(
    productId: string,
    sku: string,
    externalId: string,
    title: string,
    barcode: string | null,
    imageUrl: string | null,
  ): Promise<string | null> {
    const suffixed = `${sku.slice(0, 80)}-${externalId}`.slice(0, 100);
    for (const candidate of [sku, suffixed]) {
      const inserted = await this.db<{ id: unknown; product_id: unknown }[]>`
        insert into erp.product_variants (product_id, sku, title, barcode, image_url)
        values (${productId}::bigint, ${candidate}, ${title}, ${barcode}, ${imageUrl}::text)
        on conflict (sku) do nothing
        returning id, product_id`;
      if (inserted[0] !== undefined) return asString(inserted[0].id);

      const owner = await this.db<{ id: unknown; product_id: unknown }[]>`
        select id, product_id from erp.product_variants where sku = ${candidate} limit 1`;
      const row = owner[0];
      if (row === undefined || asString(row.product_id) !== productId) continue;
      const variantId = asString(row.id);
      await this.db`
        update erp.product_variants
        set title = ${title},
            barcode = coalesce(${barcode}::text, barcode),
            image_url = coalesce(${imageUrl}::text, image_url),
            updated_at = now()
        where id = ${variantId}::bigint`;
      return variantId;
    }
    return null;
  }

  /**
   * Upserts by (channel_account_id, external_product_id). The DDL has no unique
   * index on that pair, so it is update-then-insert; the (account, variant)
   * unique index is handled on conflict.
   */
  private async upsertMapping(
    accountId: string,
    variantId: string,
    externalId: string,
    externalVariantId: string | null,
    externalSku: string | null,
  ): Promise<'imported' | 'updated'> {
    const byVariant = await this.db<{ id: unknown }[]>`
      update erp.channel_product_mappings
      set external_product_id = ${externalId},
          external_variant_id = ${externalVariantId},
          external_sku = ${externalSku},
          sync_status = 'synced',
          last_synced_at = now(),
          last_error = null
      where channel_account_id = ${accountId}::bigint
        and product_variant_id = ${variantId}::bigint
        and deleted_at is null
      returning id`;
    if (byVariant.length > 0) return 'updated';

    const byExternal = await this.db<{ id: unknown }[]>`
      update erp.channel_product_mappings
      set product_variant_id = ${variantId}::bigint,
          external_variant_id = ${externalVariantId},
          external_sku = ${externalSku},
          sync_status = 'synced',
          last_synced_at = now(),
          last_error = null
      where channel_account_id = ${accountId}::bigint
        and external_product_id = ${externalId}
        and deleted_at is null
      returning id`;
    if (byExternal.length > 0) return 'updated';

    try {
      await this.db`
        insert into erp.channel_product_mappings (
          channel_account_id, product_variant_id, external_product_id,
          external_variant_id, external_sku, sync_status, last_synced_at
        ) values (
          ${accountId}::bigint, ${variantId}::bigint, ${externalId},
          ${externalVariantId}, ${externalSku}, 'synced', now()
        )`;
      return 'imported';
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await this.db`
        update erp.channel_product_mappings
        set external_product_id = ${externalId},
            external_variant_id = ${externalVariantId},
            external_sku = ${externalSku},
            sync_status = 'synced',
            last_synced_at = now(),
            last_error = null
        where channel_account_id = ${accountId}::bigint
          and product_variant_id = ${variantId}::bigint
          and deleted_at is null`;
      return 'updated';
    }
  }

  private async recordImportError(
    accountId: string,
    externalId: string,
    message: string,
  ): Promise<void> {
    try {
      await this.db`
        update erp.channel_product_mappings
        set sync_status = 'failed', last_error = ${message.slice(0, 500)}
        where channel_account_id = ${accountId}::bigint
          and external_product_id = ${externalId}
          and deleted_at is null`;
    } catch (error) {
      this.logger.warn(
        {
          accountId,
          externalProductId: externalId,
          error: error instanceof Error ? error.message : 'error_record_failed',
        },
        'channel product import error could not be recorded',
      );
    }
  }

  /**
   * Channel detail is optional: a blank description or empty attribute set must
   * never erase a value the ERP already holds, so both are applied with
   * `coalesce`/identity semantics.
   */
  private async refreshProductText(
    organizationId: string,
    variantId: string,
    title: string,
    barcode: string | null,
    spec: ProductSpec,
  ): Promise<void> {
    await this.db`
      update erp.product_variants
      set title = ${title},
          barcode = coalesce(${barcode}::text, barcode),
          image_url = coalesce(${spec.imageUrl}::text, image_url),
          updated_at = now()
      where id = ${variantId}::bigint`;
    const attributesJson = this.attributesJson(spec.attributes);
    await this.db`
      update erp.products p
      set name = ${title},
          description = coalesce(${spec.description}::text, p.description),
          category_id = coalesce(${spec.categoryId}::bigint, p.category_id),
          image_url = coalesce(${spec.imageUrl}::text, p.image_url),
          attributes_json = case
            when ${attributesJson}::jsonb = '{}'::jsonb then p.attributes_json
            else ${attributesJson}::jsonb
          end,
          updated_at = now()
      from erp.product_variants v
      where v.id = ${variantId}::bigint
        and p.id = v.product_id
        and p.organization_id = ${organizationId}::bigint`;
  }

  private async applyProductSpec(
    organizationId: string,
    productId: string,
    spec: ProductSpec,
  ): Promise<void> {
    if (
      spec.description === null &&
      spec.categoryId === null &&
      spec.attributes === null &&
      spec.imageUrl === null
    ) {
      return;
    }
    const attributesJson = this.attributesJson(spec.attributes);
    await this.db`
      update erp.products
      set description = coalesce(${spec.description}::text, description),
          category_id = coalesce(${spec.categoryId}::bigint, category_id),
          image_url = coalesce(${spec.imageUrl}::text, image_url),
          attributes_json = case
            when ${attributesJson}::jsonb = '{}'::jsonb then attributes_json
            else ${attributesJson}::jsonb
          end,
          updated_at = now()
      where id = ${productId}::bigint
        and organization_id = ${organizationId}::bigint`;
  }

  /**
   * Reads the live commission rate for one channel product and upserts it into
   * `erp.channel_product_costs`. A channel without a commission endpoint (or a
   * non-numeric product id) is a no-op, not an error; a failed lookup is logged
   * and reported so the import itself still succeeds.
   */
  private async storeProductCommission(
    resolved: Awaited<ReturnType<ChannelAccountService['resolveForSync']>>,
    variantId: string,
    externalProductId: string,
    adapter?: CommissionCapableAdapter,
  ): Promise<{ status: 'stored' | 'empty' | 'failed'; percent: number | null }> {
    const capable = adapter ?? (resolved.adapter as unknown as CommissionCapableAdapter);
    if (typeof capable.fetchProductCommission !== 'function') {
      return { status: 'empty', percent: null };
    }
    const productId = (externalProductId ?? '').trim();
    if (!/^\d+$/.test(productId)) return { status: 'empty', percent: null };

    let result: { percent: number | null; raw: Record<string, unknown> };
    try {
      result = await capable.fetchProductCommission(resolved.account, productId);
    } catch (error) {
      this.logger.warn(
        {
          accountId: resolved.row.id,
          productId,
          error: error instanceof Error ? error.message : 'commission_lookup_failed',
        },
        'channel commission lookup failed',
      );
      return { status: 'failed', percent: null };
    }

    const raw = asRecord(result.raw);
    const percent =
      typeof result.percent === 'number' && Number.isFinite(result.percent)
        ? Math.min(100, Math.max(0, result.percent))
        : null;
    if (percent === null && Object.keys(raw).length === 0) {
      return { status: 'empty', percent: null };
    }
    // Bound what a partner payload can put in the row without truncating JSON.
    const feesJson = JSON.stringify(raw);
    const otherFees = feesJson.length <= 20_000 ? feesJson : '{}';

    await this.db`
      insert into erp.channel_product_costs (
        organization_id, channel_account_id, product_variant_id,
        commission_percent, other_fees, fetched_at
      ) values (
        ${resolved.row.organizationId}::bigint, ${resolved.row.id}::bigint, ${variantId}::bigint,
        ${percent}::numeric, ${otherFees}::jsonb, now()
      )
      on conflict (channel_account_id, product_variant_id) do update set
        commission_percent = excluded.commission_percent,
        other_fees = excluded.other_fees,
        fetched_at = now()`;
    return { status: 'stored', percent };
  }

  /** Bounded channel detail: 5000-char description, ≤50 short attribute pairs. */
  private normalizedSpec(
    item: ExternalProduct,
  ): Pick<ProductSpec, 'description' | 'attributes' | 'imageUrl'> {
    const raw = typeof item.description === 'string' ? item.description.trim() : '';
    const description = raw.length === 0 ? null : raw.slice(0, 5000);
    const attributes: Record<string, string> = {};
    if (typeof item.attributes === 'object' && item.attributes !== null) {
      for (const [key, value] of Object.entries(item.attributes as Record<string, unknown>)) {
        if (Object.keys(attributes).length >= 50) break;
        if (typeof value !== 'string') continue;
        const name = key.trim().slice(0, 80);
        const text = value.trim().slice(0, 500);
        if (name.length === 0 || text.length === 0) continue;
        attributes[name] = text;
      }
    }
    if (
      typeof item.brand === 'string' &&
      item.brand.trim().length > 0 &&
      attributes['brand'] === undefined &&
      Object.keys(attributes).length < 50
    ) {
      attributes['brand'] = item.brand.trim().slice(0, 200);
    }
    return {
      description,
      attributes: Object.keys(attributes).length === 0 ? null : attributes,
      imageUrl: this.normalisedImageUrl(item.imageUrl),
    };
  }

  /** Only an absolute http(s) URL is stored; anything else leaves the value alone. */
  private normalisedImageUrl(value: string | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().slice(0, 1000);
    return /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null;
  }

  private attributesJson(attributes: Record<string, string> | null): string {
    return attributes === null ? '{}' : JSON.stringify(attributes);
  }

  /**
   * Find-or-create the org-scoped category by display name. The code is a slug
   * (hashed when the name is non-latin) because `(organization_id, code)` is the
   * unique key; a name match reuses the existing row.
   */
  private async categoryIdFor(
    organizationId: string,
    name: string | undefined,
    cache: Map<string, string | null>,
  ): Promise<string | null> {
    const trimmed = typeof name === 'string' ? name.trim().slice(0, 200) : '';
    if (trimmed.length === 0) return null;
    const cacheKey = trimmed.toLowerCase();
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const code = this.categoryCode(trimmed);
    const found = await this.db<{ id: unknown }[]>`
      select id from erp.product_categories
      where organization_id = ${organizationId}::bigint
        and deleted_at is null
        and (lower(name) = ${cacheKey} or code = ${code})
      order by id
      limit 1`;
    let id: string | null = found[0] === undefined ? null : asString(found[0].id);
    if (id === null) {
      const inserted = await this.db<{ id: unknown }[]>`
        insert into erp.product_categories (organization_id, code, name)
        values (${organizationId}::bigint, ${code}, ${trimmed})
        on conflict (organization_id, code) where deleted_at is null do nothing
        returning id`;
      if (inserted[0] !== undefined) {
        id = asString(inserted[0].id);
      } else {
        const raced = await this.db<{ id: unknown }[]>`
          select id from erp.product_categories
          where organization_id = ${organizationId}::bigint
            and code = ${code}
            and deleted_at is null
          limit 1`;
        id = raced[0] === undefined ? null : asString(raced[0].id);
      }
    }
    cache.set(cacheKey, id);
    return id;
  }

  private categoryCode(name: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    if (base.length > 0) return base;
    // Persian/other non-latin names have no ascii slug: hash keeps the code stable.
    return `cat-${hashNaturalKey(name).slice(0, 12)}`;
  }

  private productPrefix(code: string): string {
    switch (code) {
      case 'carexy':
        return 'CH';
      case 'digikala':
        return 'DK';
      default:
        return code.slice(0, 2).toUpperCase() || 'CH';
    }
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
             coalesce((
               select greatest(sum(b.on_hand) - sum(b.reserved), 0)
               from erp.inventory_balances b
               where b.product_variant_id = m.product_variant_id
                 and b.organization_id = ${organizationId}::bigint
             ), 0)::text as available_qty,
             coalesce(max(i.safety_qty), 0)::text as safety_qty
      from erp.channel_product_mappings m
      join erp.channel_accounts a on a.id = m.channel_account_id
      left join erp.channel_inventory_mappings i
        on i.channel_account_id = m.channel_account_id
       and i.product_variant_id = m.product_variant_id
       and i.sync_enabled = true
      where a.organization_id = ${organizationId}::bigint
        and m.channel_account_id = ${accountId}::bigint
        and m.external_variant_id is not null
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
      case 'product_import':
        return 'product_import';
      case 'settlement_pull':
        throw new IntegrationError('NOT_IMPLEMENTED', {
          messageFa: 'این نوع همگام‌سازی در نسخهٔ فعلی فعال نیست.',
          details: { type },
        });
    }
  }

  private capabilityFor(
    type: SyncTriggerType,
  ): 'stock.push' | 'price.push' | 'order.pull' | 'product.push' {
    switch (type) {
      case 'inventory_push':
      case 'full_reconcile':
        return 'stock.push';
      case 'price_push':
        return 'price.push';
      case 'product_push':
      case 'product_import':
        return 'product.push';
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
