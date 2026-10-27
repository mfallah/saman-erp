/**
 * Self-healing reconciliation for Digikala accounts.
 *
 * Digikala mappings were historically written with the **product** id in
 * `external_variant_id`, which broke order-line resolution (orders arrived with
 * zero lines), left product images empty and blocked stock/price writes. Nothing
 * repaired that on its own unless a human pressed a button, so this service runs
 * the same repairs from a 5-minute worker tick and from the admin endpoint.
 *
 * Four isolated steps, each in its own try/catch so one failing channel call can
 * never block the rest:
 *   1. remap product ids → real variant ids on existing mappings;
 *   2. re-pull the last 7 days when any order of the account has **zero** lines;
 *   3. fill `products.image_url` / `product_variants.image_url` from the channel
 *      catalogue for mappings whose image is still NULL;
 *   4. refresh commission rows that are still missing for mapped variants.
 *
 * Every run is guarded by a per-account `pg_try_advisory_lock` (session lock on a
 * reserved connection) so the scheduler and an admin call can never overlap.
 */
import { Inject, Injectable } from '@nestjs/common';

import { DB, type Db } from '../../../common/contracts';
import { asNumber, asString } from '../infrastructure/sql';
import type { AppLogger } from '../ports/logger.port';
import { LOGGER } from '../ports/logger.port';
import { productImageUrlOf } from '../adapters/digikala/digikala.adapter';
import type { ResolvedAdapterAccount } from './adapter.registry';
import { ChannelAccountService } from './channel-accounts.service';
import { ChannelSyncService } from './channel-sync.service';

/** Summary returned by `reconcileAccount` (and the admin endpoint). */
export interface ReconcileSummary {
  /** Mappings re-pointed to a real Digikala variant id. */
  readonly remapped: number;
  /** Orders of this account that gained their lines during this run. */
  readonly ordersRefilled: number;
  /** Product/variant rows that received an `image_url`. */
  readonly imagesFilled: number;
  /** `channel_product_costs` rows written for variants that had none. */
  readonly commissionsFilled: number;
  /** Bad mappings found before the remap step. */
  readonly badMappings: number;
  /** Zero-line orders found before the order backfill. */
  readonly zeroLineOrders: number;
  /** Zero-line orders that could not be repaired (outside the 7-day window). */
  readonly ordersStillEmpty: number;
  /** Set when the run did nothing on purpose (`locked`, `not_digikala`, …). */
  readonly skipped?: string;
  /** One entry per isolated step failure. */
  readonly errors: readonly string[];
  readonly durationMs: number;
}

/**
 * Bad-mapping detector.
 *
 * A row is bad when the variant id is the product id (the historical bug), is
 * NULL/empty, or is not a plausible Digikala variant id. Digikala ids are
 * numeric; the reported variant ids are 5–12 digits, so anything else (UUIDs,
 * seller-list row ids, prefixed values) is unusable for stock/price writes.
 */
const BAD_MAPPING_SQL = (db: Db, accountId: string) => db<{ bad: unknown }[]>`
  select count(*)::int as bad
  from erp.channel_product_mappings m
  where m.channel_account_id = ${accountId}::bigint
    and m.deleted_at is null
    and (
      m.external_variant_id is not distinct from m.external_product_id
      or m.external_variant_id is null
      or btrim(m.external_variant_id) !~ '^[0-9]{5,12}$'
    )`;

/** `backfillOrders` clamps to 30; seven days is the order-repair window. */
const ORDER_BACKFILL_DAYS = 7;
/**
 * Order events emitted by the backfill are materialised by the outbox worker
 * (separate process), so the reconciler polls briefly for the lines to land.
 */
const ORDER_HEAL_POLL_MS = 750;
const ORDER_HEAL_MAX_WAIT_MS = 8_000;
/** Catalogue walk bound per reconcile run (50 rows/page × 10 pages). */
const IMAGE_MAX_PAGES = 10;
/** `syncCommissions` bound, kept identical to its own cap. */
const COMMISSION_SYNC_LIMIT = 200;

/** A held session lock plus its dedicated connection. */
interface ReservedLock {
  readonly reserved: Awaited<ReturnType<Db['reserve']>>;
}

@Injectable()
export class ChannelReconcilerService {
  private readonly releasedLocks = new WeakSet<object>();
  private readonly activeLocks = new Map<string, ReservedLock>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly accounts: ChannelAccountService,
    private readonly sync: ChannelSyncService,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  /**
   * Runs every repair step for one account, in order, and returns the counts.
   * A step failure is logged and reported; the other steps still run.
   */
  /**
   * Public entry point. Guarantees the reserved-connection lock is released even
   * when a step throws or the channel stalls, and bounds the run so a rate
   * limited partner can never block the scheduler forever.
   */
  async reconcileAccount(organizationId: string, accountId: string): Promise<ReconcileSummary> {
    const startedAt = Date.now();
    const budgetMs = 240_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.reconcileAccountRun(organizationId, accountId),
        new Promise<ReconcileSummary>((resolve) => {
          timer = setTimeout(() => {
            this.logger.warn({ accountId }, 'digikala reconcile exceeded its time budget');
            resolve(this.emptySummary({ skipped: 'timeout', durationMs: Date.now() - startedAt }));
          }, budgetMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      const held = this.activeLocks.get(accountId);
      if (held !== undefined) await this.releaseAccountLock(held, accountId);
    }
  }

  private async reconcileAccountRun(organizationId: string, accountId: string): Promise<ReconcileSummary> {
    const startedAt = Date.now();
    let lock: ReservedLock | null;
    try {
      lock = await this.tryAccountLock(accountId);
    } catch (error) {
      this.logger.error(
        { accountId, error: this.messageOf(error) },
        'digikala reconcile could not take its advisory lock',
      );
      return this.emptySummary({ skipped: 'lock_unavailable', durationMs: Date.now() - startedAt });
    }
    if (lock === null) {
      this.logger.info({ accountId }, 'digikala reconcile skipped: another worker holds the lock');
      return this.emptySummary({ skipped: 'locked', durationMs: Date.now() - startedAt });
    }
    this.activeLocks.set(accountId, lock);

    const errors: string[] = [];
    let resolved: ResolvedAdapterAccount | null = null;
    try {
      resolved = await this.accounts.resolveForSync(organizationId, accountId);
    } catch (error) {
      errors.push(`resolve:${this.messageOf(error)}`);
      this.logger.error(
        { accountId, error: this.messageOf(error) },
        'digikala reconcile could not resolve the account',
      );
    }
    if (resolved === null) {
      try {
        // Credential failure is not going to fix itself within the tick window.
        await this.touchReconciled(accountId);
      } catch (touchError) {
        this.logger.warn(
          { accountId, error: this.messageOf(touchError) },
          'digikala reconcile could not record its timestamp',
        );
      }
      await this.releaseAccountLock(lock, accountId);
      return this.emptySummary({ skipped: 'unresolved', durationMs: Date.now() - startedAt, errors });
    }
    if (resolved.adapter.code !== 'digikala') {
      this.logger.info(
        { accountId, channel: resolved.adapter.code },
        'digikala reconcile skipped: account is not digikala',
      );
      await this.releaseAccountLock(lock, accountId);
      return this.emptySummary({ skipped: 'not_digikala', durationMs: Date.now() - startedAt });
    }

    let remapped = 0;
    let ordersRefilled = 0;
    let imagesFilled = 0;
    let commissionsFilled = 0;
    let badMappings = 0;
    let zeroLineOrders = 0;
    let ordersStillEmpty = 0;

    // (a) bad mappings → remap existing rows in place.
    try {
      badMappings = await this.countBadMappings(accountId);
      if (badMappings > 0) {
        const result = await this.sync.remapDigikalaProducts({ organizationId, accountId });
        remapped = result.updated;
        this.logger.info({ accountId, badMappings, ...result }, 'digikala reconcile remapped mappings');
      }
    } catch (error) {
      errors.push(`remap:${this.messageOf(error)}`);
      this.logger.error({ accountId, error: this.messageOf(error) }, 'digikala reconcile remap step failed');
    }

    // (b) orders with zero lines → clear cursor/idempotency and re-pull 7 days.
    try {
      zeroLineOrders = await this.countZeroLineOrders(organizationId, accountId);
      if (zeroLineOrders > 0) {
        const backfill = await this.sync.backfillOrders({
          organizationId,
          accountId,
          days: ORDER_BACKFILL_DAYS,
        });
        // Synchronous on purpose: the reconciler counts what actually healed.
        await this.sync.runJob(backfill.jobId, 'reconciler');
        // The worker dispatches `channel.order.received` asynchronously; give it
        // a bounded window so the returned count is what really landed.
        ordersStillEmpty = await this.waitForOrderLines(
          organizationId,
          accountId,
          zeroLineOrders,
        );
        ordersRefilled = Math.max(0, zeroLineOrders - ordersStillEmpty);
        this.logger.info(
          {
            accountId,
            jobId: backfill.jobId,
            zeroLineOrders,
            ordersRefilled,
            ordersStillEmpty,
            clearedCursors: backfill.clearedCursors,
            clearedIdempotencyKeys: backfill.clearedIdempotencyKeys,
          },
          'digikala reconcile re-pulled orders',
        );
      }
    } catch (error) {
      errors.push(`orders:${this.messageOf(error)}`);
      this.logger.error({ accountId, error: this.messageOf(error) }, 'digikala reconcile order step failed');
    }

    // (c) images → channel catalogue `image_src`, only where still NULL.
    try {
      imagesFilled = await this.backfillImages(resolved);
      if (imagesFilled > 0) {
        this.logger.info({ accountId, imagesFilled }, 'digikala reconcile filled product images');
      }
    } catch (error) {
      errors.push(`images:${this.messageOf(error)}`);
      this.logger.error({ accountId, error: this.messageOf(error) }, 'digikala reconcile image step failed');
    }

    // (d) commissions → only variants that have no cost row yet.
    try {
      const missing = await this.countMissingCommissions(accountId);
      if (missing > 0) {
        const result = await this.sync.syncCommissions({
          organizationId,
          accountId,
          limit: COMMISSION_SYNC_LIMIT,
        });
        commissionsFilled = result.updated;
        this.logger.info(
          { accountId, missing, ...result },
          'digikala reconcile refreshed commissions',
        );
      }
    } catch (error) {
      errors.push(`commissions:${this.messageOf(error)}`);
      this.logger.error(
        { accountId, error: this.messageOf(error) },
        'digikala reconcile commission step failed',
      );
    }

    const durationMs = Date.now() - startedAt;
    try {
      await this.touchReconciled(accountId);
    } catch (error) {
      errors.push(`touch:${this.messageOf(error)}`);
      this.logger.warn(
        { accountId, error: this.messageOf(error) },
        'digikala reconcile could not record its timestamp',
      );
    }
    await this.releaseAccountLock(lock, accountId);

    const summary: ReconcileSummary = {
      remapped,
      ordersRefilled,
      imagesFilled,
      commissionsFilled,
      badMappings,
      zeroLineOrders,
      ordersStillEmpty,
      errors,
      durationMs,
    };
    this.logger.info({ accountId, ...summary }, 'digikala reconcile finished');
    return summary;
  }

  private async countBadMappings(accountId: string): Promise<number> {
    const rows = await BAD_MAPPING_SQL(this.db, accountId);
    return rows[0] === undefined ? 0 : asNumber(rows[0].bad);
  }

  /**
   * Zero-line detector: `sales_orders LEFT JOIN sales_order_lines` where the
   * line side is NULL, scoped to the organisation **and** the channel account.
   */
  private async countZeroLineOrders(organizationId: string, accountId: string): Promise<number> {
    const rows = await this.db<{ orders: unknown }[]>`
      select count(*)::int as orders
      from erp.sales_orders o
      left join erp.sales_order_lines l on l.order_id = o.id
      where o.organization_id = ${organizationId}::bigint
        and o.channel_account_id = ${accountId}::bigint
        and l.id is null`;
    return rows[0] === undefined ? 0 : asNumber(rows[0].orders);
  }

  /**
   * Bounded wait for the outbox worker to materialise the lines of the orders
   * just re-pulled. Returns the lowest zero-line count observed, which is 0 when
   * every order healed inside the window.
   */
  private async waitForOrderLines(
    organizationId: string,
    accountId: string,
    initial: number,
  ): Promise<number> {
    let remaining = await this.countZeroLineOrders(organizationId, accountId);
    let best = Math.min(initial, remaining);
    const deadline = Date.now() + ORDER_HEAL_MAX_WAIT_MS;
    while (best > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, ORDER_HEAL_POLL_MS));
      remaining = await this.countZeroLineOrders(organizationId, accountId);
      best = Math.min(best, remaining);
    }
    return best;
  }

  /** Mapped variants without a `channel_product_costs` row. */  private async countMissingCommissions(accountId: string): Promise<number> {
    const rows = await this.db<{ missing: unknown }[]>`
      select count(*)::int as missing
      from erp.channel_product_mappings m
      where m.channel_account_id = ${accountId}::bigint
        and m.deleted_at is null
        and not exists (
          select 1
          from erp.channel_product_costs c
          where c.channel_account_id = m.channel_account_id
            and c.product_variant_id = m.product_variant_id
        )`;
    return rows[0] === undefined ? 0 : asNumber(rows[0].missing);
  }

  /**
   * Reads the seller catalogue once and fills `image_url` on the mapped
   * product/variant rows that are still NULL. Only absolute http(s) URLs are
   * stored (the adapter already normalises them).
   */
  private async backfillImages(resolved: ResolvedAdapterAccount): Promise<number> {
    const listProductCatalog = resolved.adapter.listProductCatalog;
    if (listProductCatalog === undefined) return 0;
    const catalog = listProductCatalog.bind(resolved.adapter);

    const imageByProduct = new Map<string, string>();
    for await (const entry of catalog(resolved.account, { maxPages: IMAGE_MAX_PAGES })) {
      const externalProductId = entry.externalProductId.trim();
      if (externalProductId.length === 0) continue;
      const imageUrl = productImageUrlOf(entry.raw);
      if (imageUrl !== null) imageByProduct.set(externalProductId, imageUrl);
    }
    if (imageByProduct.size === 0) return 0;

    const rows = await this.db<
      {
        variant_id: unknown;
        product_id: unknown;
        external_product_id: unknown;
        product_image: unknown;
        variant_image: unknown;
      }[]
    >`
      select v.id::text as variant_id,
             p.id::text as product_id,
             m.external_product_id::text as external_product_id,
             p.image_url as product_image,
             v.image_url as variant_image
      from erp.channel_product_mappings m
      join erp.product_variants v on v.id = m.product_variant_id
      join erp.products p on p.id = v.product_id
      where m.channel_account_id = ${resolved.row.id}::bigint
        and m.deleted_at is null
        and m.external_product_id in (
          select jsonb_array_elements_text(${this.db.json([...imageByProduct.keys()])}::jsonb)
        )
        and (p.image_url is null or v.image_url is null)`;

    const products = new Map<string, string>();
    const variants = new Map<string, string>();
    for (const row of rows) {
      const imageUrl = imageByProduct.get(asString(row.external_product_id));
      if (imageUrl === undefined) continue;
      if (row.product_image === null) products.set(asString(row.product_id), imageUrl);
      if (row.variant_image === null) variants.set(asString(row.variant_id), imageUrl);
    }

    let filled = 0;
    for (const [productId, imageUrl] of products) {
      const changed = await this.db<{ id: unknown }[]>`
        update erp.products
        set image_url = ${imageUrl}, updated_at = now()
        where id = ${productId}::bigint
          and image_url is null
        returning id`;
      filled += changed.length;
    }
    for (const [variantId, imageUrl] of variants) {
      const changed = await this.db<{ id: unknown }[]>`
        update erp.product_variants
        set image_url = ${imageUrl}, updated_at = now()
        where id = ${variantId}::bigint
          and image_url is null
        returning id`;
      filled += changed.length;
    }
    return filled;
  }

  /**
   * Session advisory lock on a reserved connection: `pg_try_advisory_lock` is
   * connection-scoped, so it is taken and released on the same connection while
   * the reconcile itself uses the pool. Returns null when another worker holds it.
   */
  private async tryAccountLock(accountId: string): Promise<ReservedLock | null> {
    const reserved = await this.db.reserve();
    try {
      const rows = await reserved<{ locked: unknown }[]>`
        select pg_try_advisory_lock(hashtextextended(${`digikala-reconcile:${accountId}`}, 0)) as locked`;
      if (rows[0]?.locked !== true) {
        reserved.release();
        return null;
      }
      return { reserved };
    } catch (error) {
      reserved.release();
      throw error;
    }
  }

  private async releaseAccountLock(lock: ReservedLock, accountId: string): Promise<void> {
    if (this.releasedLocks.has(lock)) return;
    this.releasedLocks.add(lock);
    this.activeLocks.delete(accountId);
    try {
      await lock.reserved`
        select pg_advisory_unlock(hashtextextended(${`digikala-reconcile:${accountId}`}, 0))`;
    } catch (error) {
      // Releasing is best-effort: a dropped connection frees session locks anyway.
      this.logger.warn(
        { accountId, error: this.messageOf(error) },
        'digikala reconcile could not release its advisory lock',
      );
    } finally {
      lock.reserved.release();
    }
  }

  /** Records `settings.digikalaReconcileAt` so the tick only picks stale accounts. */
  private async touchReconciled(accountId: string): Promise<void> {
    await this.db`
      update erp.channel_accounts
      set settings = jsonb_set(
            case when jsonb_typeof(settings) = 'object' then settings else '{}'::jsonb end,
            '{digikalaReconcileAt}',
            to_jsonb(now()::text),
            true
          ),
          updated_at = now()
      where id = ${accountId}::bigint`;
  }

  private emptySummary(input: {
    skipped: string;
    durationMs: number;
    errors?: readonly string[];
  }): ReconcileSummary {
    return {
      remapped: 0,
      ordersRefilled: 0,
      imagesFilled: 0,
      commissionsFilled: 0,
      badMappings: 0,
      zeroLineOrders: 0,
      ordersStillEmpty: 0,
      skipped: input.skipped,
      errors: input.errors ?? [],
      durationMs: input.durationMs,
    };
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
