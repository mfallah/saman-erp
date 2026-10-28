/**
 * Lightweight in-process auto-sync loop (`AUTO_SYNC_ENABLED`, default on).
 *
 * Every 60 s it queues and runs an `order_pull` job for each active channel
 * account that has usable credentials and has not opted out via
 * `settings.autoOrderPull = false`. It never pushes anything: the only work is
 * the remote order read `ChannelSyncService.trigger` mirrors into
 * `channel_sync_jobs`.
 *
 * Deliberately not a queue: one process-local pass at a time, no new deps, the
 * timer is `unref`ed so it cannot keep the process alive. Each account is
 * isolated — one misconfigured channel never stops the others — and the whole
 * pass is wrapped so a failing tick is logged instead of crashing the API.
 */
import type { Db } from '../../../common/contracts';
import { asRecord, asString } from '../infrastructure/sql';
import { IntegrationError } from '../domain/channel.types';
import type { AppLogger } from '../ports/logger.port';
import type { ChannelSyncService } from './channel-sync.service';

export const AUTO_SYNC_INTERVAL_MS = 60_000;
/** Bound one pass so a large tenant cannot monopolise the tick. */
const AUTO_SYNC_MAX_ACCOUNTS = 50;
/**
 * Per-channel pull cadence. Carexy is deliberately slower: it rate-limits hard
 * (HTTP 429) and a 60 s pull was one of the causes of the 2026-10-28 storm.
 */
const PULL_INTERVAL_SECONDS: Readonly<Record<string, number>> = {
  carexy: 300,
  digikala: 60,
};
const DEFAULT_PULL_INTERVAL_SECONDS = 300;

interface AutoSyncAccountRow {
  organization_id: unknown;
  account_id: unknown;
  channel_code: unknown;
  settings: unknown;
}

export interface AutoSyncAccount {
  readonly organizationId: string;
  readonly accountId: string;
  readonly channelCode: string;
  readonly autoOrderPull: boolean;
  /** Minimum seconds between two pulls of this account. */
  readonly intervalSeconds: number;
}

export interface AutoSyncPassResult {
  readonly accounts: number;
  readonly triggered: number;
  readonly failed: number;
  readonly notDue: number;
}

export interface AutoSyncDeps {
  readonly db: Db;
  readonly sync: ChannelSyncService;
  readonly logger: AppLogger;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

/** Module-level guard: a slow pass must finish before the next tick starts. */
let passRunning = false;
/** Last trigger time per account, so a 60 s tick honours a 5 min cadence. */
const lastTriggeredAt = new Map<string, number>();

/** Active accounts with credentials only; a placeholder account is skipped. */
async function listAutoSyncAccounts(db: Db): Promise<AutoSyncAccount[]> {
  const rows = await db<AutoSyncAccountRow[]>`
    select a.organization_id, a.id as account_id, c.code as channel_code, a.settings
    from erp.channel_accounts a
    join erp.sales_channels c on c.id = a.channel_id
    where a.is_active = true
      and a.deleted_at is null
      and c.is_active = true
      and c.deleted_at is null
      and exists (
        select 1 from erp.channel_credentials cr
        where cr.channel_account_id = a.id and cr.is_active = true
      )
    order by a.organization_id, a.id
    limit ${AUTO_SYNC_MAX_ACCOUNTS}`;
  return rows.map((row) => {
    const settings = asRecord(row.settings);
    const intervalSetting = settings['orderPullIntervalSeconds'];
    const channelCode = asString(row.channel_code);
    const intervalSeconds =
      typeof intervalSetting === 'number' && Number.isFinite(intervalSetting) && intervalSetting >= 30
        ? Math.trunc(intervalSetting)
        : (PULL_INTERVAL_SECONDS[channelCode] ?? DEFAULT_PULL_INTERVAL_SECONDS);
    return {
      organizationId: asString(row.organization_id),
      accountId: asString(row.account_id),
      channelCode,
      autoOrderPull: settings['autoOrderPull'] === true,
      intervalSeconds,
    };
  });
}

/** Runs one order-pull pass; safe to call from a timer (never throws). */
export async function runAutoSyncPass(deps: AutoSyncDeps): Promise<AutoSyncPassResult> {
  if (passRunning) return { accounts: 0, triggered: 0, failed: 0, notDue: 0 };
  passRunning = true;
  const now = deps.now ?? Date.now;
  try {
    const accounts = (await listAutoSyncAccounts(deps.db)).filter((row) => row.autoOrderPull);
    let triggered = 0;
    let failed = 0;
    let notDue = 0;
    for (const account of accounts) {
      const last = lastTriggeredAt.get(account.accountId) ?? 0;
      if (now() - last < account.intervalSeconds * 1000) {
        notDue += 1;
        continue;
      }
      lastTriggeredAt.set(account.accountId, now());
      try {
        const job = await deps.sync.trigger({
          organizationId: account.organizationId,
          accountId: account.accountId,
          type: 'order_pull',
          force: true,
        });
        triggered += 1;
        await deps.sync.runJob(job.jobId, 'auto-sync');
      } catch (error) {
        failed += 1;
        // A channel without an order endpoint (Carexy today) is expected, not an
        // incident: log it at debug so the cadence cannot flood the logs.
        const expected =
          error instanceof IntegrationError && error.code === 'NOT_IMPLEMENTED';
        deps.logger[expected ? 'debug' : 'warn'](
          {
            accountId: account.accountId,
            channel: account.channelCode,
            error: error instanceof Error ? error.message : 'auto_sync_failed',
          },
          'auto order pull skipped for account',
        );
      }
    }
    return { accounts: accounts.length, triggered, failed, notDue };
  } catch (error) {
    deps.logger.warn(
      { error: error instanceof Error ? error.message : 'auto_sync_pass_failed' },
      'auto order pull pass failed',
    );
    return { accounts: 0, triggered: 0, failed: 0, notDue: 0 };
  } finally {
    passRunning = false;
  }
}

/**
 * Starts the loop and returns a stop function. A disabled scheduler is a no-op
 * (returns a no-op stop) so callers do not branch on configuration.
 */
export function startAutoSyncScheduler(
  options: AutoSyncDeps & { readonly enabled: boolean; readonly intervalMs?: number },
): () => void {
  if (!options.enabled) {
    options.logger.info({}, 'auto_sync_disabled');
    return () => undefined;
  }
  const intervalMs = Math.max(1000, options.intervalMs ?? AUTO_SYNC_INTERVAL_MS);
  const timer = setInterval(() => {
    void runAutoSyncPass(options);
  }, intervalMs);
  // Never keep the process alive for a housekeeping loop.
  timer.unref();
  options.logger.info({ intervalMs }, 'auto_sync_started');
  return () => clearInterval(timer);
}
