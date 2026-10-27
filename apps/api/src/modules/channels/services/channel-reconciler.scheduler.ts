/**
 * In-process Digikala reconcile loop (`CHANNEL_RECONCILE_ENABLED`, default on).
 *
 * Every five minutes it asks the database for Digikala accounts whose last
 * successful reconcile is older than ten minutes and runs
 * `ChannelReconcilerService.reconcileAccount` for each. The service itself takes
 * a per-account `pg_try_advisory_lock`, so two workers (or a worker plus the
 * admin endpoint) can never repair the same account concurrently.
 *
 * Deliberately not a queue: one process-local pass at a time, no new deps, the
 * timer is `unref`ed so it cannot keep the process alive. Each account is
 * isolated and the whole pass is wrapped so a failing tick is logged instead of
 * crashing the API.
 */
import type { Db } from '../../../common/contracts';
import { asString } from '../infrastructure/sql';
import type { AppLogger } from '../ports/logger.port';
import type { ChannelReconcilerService } from './channel-reconciler.service';

export const RECONCILE_INTERVAL_MS = 5 * 60_000;
/** An account is due again only after this much time. */
export const RECONCILE_STALE_MS = 10 * 60_000;
/** Bound one pass so a large tenant cannot monopolise the tick. */
const RECONCILE_MAX_ACCOUNTS = 25;

interface StaleAccountRow {
  organization_id: unknown;
  account_id: unknown;
}

export interface ReconcileAccountRef {
  readonly organizationId: string;
  readonly accountId: string;
}

export interface ReconcilePassResult {
  readonly accounts: number;
  readonly reconciled: number;
  readonly failed: number;
  readonly remapped: number;
  readonly ordersRefilled: number;
  readonly imagesFilled: number;
  readonly commissionsFilled: number;
}

export interface ReconcileDeps {
  readonly db: Db;
  readonly reconciler: ChannelReconcilerService;
  readonly logger: AppLogger;
}

/** Module-level guard: a slow pass must finish before the next tick starts. */
let passRunning = false;

/**
 * Digikala accounts that are active, credentialed and stale.
 *
 * The timestamp lives in `channel_accounts.settings.digikalaReconcileAt` (written
 * by the reconciler) so no schema change is needed; a missing/invalid value
 * counts as "never reconciled". The regex guard keeps a malformed setting from
 * failing the cast.
 */
async function listStaleDigikalaAccounts(db: Db): Promise<ReconcileAccountRef[]> {
  const rows = await db<StaleAccountRow[]>`
    select a.organization_id, a.id as account_id
    from erp.channel_accounts a
    join erp.sales_channels c on c.id = a.channel_id
    where c.code = 'digikala'
      and a.is_active = true
      and a.deleted_at is null
      and c.is_active = true
      and c.deleted_at is null
      and exists (
        select 1 from erp.channel_credentials cr
        where cr.channel_account_id = a.id and cr.is_active = true
      )
      and coalesce(
            case
              when (a.settings ->> 'digikalaReconcileAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                then (a.settings ->> 'digikalaReconcileAt')::timestamptz
              else 'epoch'::timestamptz
            end,
            'epoch'::timestamptz
          ) < now() - interval '10 minutes'
    order by a.id
    limit ${RECONCILE_MAX_ACCOUNTS}`;
  return rows.map((row) => ({
    organizationId: asString(row.organization_id),
    accountId: asString(row.account_id),
  }));
}

/** Runs one reconcile pass; safe to call from a timer (never throws). */
export async function runReconcilePass(deps: ReconcileDeps): Promise<ReconcilePassResult> {
  if (passRunning) {
    return { accounts: 0, reconciled: 0, failed: 0, remapped: 0, ordersRefilled: 0, imagesFilled: 0, commissionsFilled: 0 };
  }
  passRunning = true;
  try {
    const accounts = await listStaleDigikalaAccounts(deps.db);
    let reconciled = 0;
    let failed = 0;
    const totals = { remapped: 0, ordersRefilled: 0, imagesFilled: 0, commissionsFilled: 0 };
    for (const account of accounts) {
      try {
        const summary = await deps.reconciler.reconcileAccount(
          account.organizationId,
          account.accountId,
        );
        if (summary.skipped === undefined) reconciled += 1;
        totals.remapped += summary.remapped;
        totals.ordersRefilled += summary.ordersRefilled;
        totals.imagesFilled += summary.imagesFilled;
        totals.commissionsFilled += summary.commissionsFilled;
      } catch (error) {
        failed += 1;
        deps.logger.warn(
          {
            accountId: account.accountId,
            error: error instanceof Error ? error.message : 'digikala_reconcile_failed',
          },
          'digikala reconcile skipped for account',
        );
      }
    }
    if (accounts.length > 0) {
      deps.logger.info(
        { accounts: accounts.length, reconciled, failed, ...totals },
        'digikala reconcile pass finished',
      );
    }
    return { accounts: accounts.length, reconciled, failed, ...totals };
  } catch (error) {
    deps.logger.warn(
      { error: error instanceof Error ? error.message : 'digikala_reconcile_pass_failed' },
      'digikala reconcile pass failed',
    );
    return { accounts: 0, reconciled: 0, failed: 0, remapped: 0, ordersRefilled: 0, imagesFilled: 0, commissionsFilled: 0 };
  } finally {
    passRunning = false;
  }
}

/**
 * Starts the loop and returns a stop function. A disabled loop is a no-op
 * (returns a no-op stop) so callers do not branch on configuration.
 */
export function startChannelReconcilerScheduler(
  options: ReconcileDeps & { readonly enabled: boolean; readonly intervalMs?: number },
): () => void {
  if (!options.enabled) {
    options.logger.info({}, 'digikala_reconcile_disabled');
    return () => undefined;
  }
  const intervalMs = Math.max(60_000, options.intervalMs ?? RECONCILE_INTERVAL_MS);
  const timer = setInterval(() => {
    void runReconcilePass(options);
  }, intervalMs);
  // Never keep the process alive for a housekeeping loop.
  timer.unref();
  options.logger.info({ intervalMs }, 'digikala_reconcile_started');
  return () => clearInterval(timer);
}
