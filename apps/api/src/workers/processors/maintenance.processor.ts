/**
 * Maintenance worker: partition creation, retention, expired reservations and
 * inventory consistency reconciliation. Every statement is guarded so a worker
 * still boots before a migration has created an optional function/table.
 */
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { DB, type Db } from '../../common/contracts';
import type { AppLogger } from '../../modules/channels/ports/logger.port';
import { LOGGER } from '../../modules/channels/ports/logger.port';
import { getWorkerMetrics } from '../metrics';

export interface MaintenanceReport {
  readonly task: string;
  readonly skipped?: string;
  readonly affected?: number;
  readonly created?: readonly string[];
  readonly detail?: string;
}

@Injectable()
export class MaintenanceProcessor implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private lastRunDay: string | null = null;
  private readonly metrics = getWorkerMetrics();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    // Hourly tick; the actual maintenance window is 02:00 Asia/Tehran.
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.logger.error(
          { error: error instanceof Error ? error.message : 'maintenance_failed' },
          'maintenance tick failed',
        );
      });
    }, 60 * 60 * 1000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const tehranHour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Tehran',
        hour: '2-digit',
        hour12: false,
      }).format(now),
    );
    const day = now.toISOString().slice(0, 10);
    if (tehranHour !== 2 || this.lastRunDay === day) return;
    this.lastRunDay = day;
    for (const task of ['partitions', 'retention', 'expired_reservations', 'reconcile'] as const) {
      await this.run(task);
    }
  }

  async run(task: 'partitions' | 'retention' | 'expired_reservations' | 'reconcile'): Promise<MaintenanceReport> {
    try {
      switch (task) {
        case 'partitions':
          return await this.createPartitions();
        case 'retention':
          return await this.retention();
        case 'expired_reservations':
          return await this.expireReservations();
        case 'reconcile':
          return await this.reconcile();
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'maintenance_failed';
      this.logger.error({ task, detail }, 'maintenance task failed');
      await this.logMaintenance(task, false, detail, 0);
      return { task, detail };
    }
  }

  private async createPartitions(): Promise<MaintenanceReport> {
    const exists = await this.hasProcedure('erp.maintain_partitions(integer)');
    if (!exists) {
      return { task: 'partitions', skipped: 'erp.maintain_partitions(integer) missing' };
    }
    const started = Date.now();
    const rows = await this.db<{ partition_name: unknown; action: unknown }[]>`
      select * from erp.maintain_partitions(3)`;
    const created = rows.map((row) => String(row.partition_name ?? row.action ?? ''));
    await this.logMaintenance('partitions', true, `created ${created.length} partitions`, Date.now() - started);
    this.logger.info({ created: created.length }, 'partition maintenance completed');
    return { task: 'partitions', created };
  }

  private async retention(): Promise<MaintenanceReport> {
    let affected = 0;
    // Processed outbox rows older than 30 days (ADR-0010 retention).
    const outbox = await this.db`
      delete from erp.outbox_events
      where status = 'processed' and processed_at < now() - interval '30 days'`;
    affected += outbox.count;
    // Webhook archive bodies are pruned after 90 days (payload already minimised).
    if (await this.tableExists('erp.channel_webhook_events')) {
      const pruned = await this.db`
        update erp.channel_webhook_events
        set payload = '{"pruned":true}'::jsonb, raw_body = null
        where received_at < now() - interval '90 days'
          and payload <> '{"pruned":true}'::jsonb`;
      affected += pruned.count;
    }
    if (await this.hasProcedure('erp.fn_purge_expired_idempotency()')) {
      await this.db`select erp.fn_purge_expired_idempotency()`;
    }
    await this.logMaintenance('retention', true, `affected ${affected}`, 0);
    return { task: 'retention', affected };
  }

  private async expireReservations(): Promise<MaintenanceReport> {
    if (!(await this.tableExists('erp.inventory_reservations'))) {
      return { task: 'expired_reservations', skipped: 'table missing' };
    }
    const result = await this.db`
      update erp.inventory_reservations
      set status = 'expired', updated_at = now()
      where status = 'active' and expires_at is not null and expires_at < now()`;
    await this.logMaintenance('expired_reservations', true, `expired ${result.count}`, 0);
    return { task: 'expired_reservations', affected: result.count };
  }

  private async reconcile(): Promise<MaintenanceReport> {
    if (!(await this.hasProcedure('erp.fn_inventory_consistency_check()'))) {
      return { task: 'reconcile', skipped: 'erp.fn_inventory_consistency_check() missing' };
    }
    await this.db`select erp.fn_inventory_consistency_check()`;
    await this.logMaintenance('reconcile', true, 'consistency check executed', 0);
    return { task: 'reconcile', detail: 'executed' };
  }

  private async tableExists(name: string): Promise<boolean> {
    const rows = await this.db<{ present: boolean }[]>`
      select to_regclass(${name}) is not null as present`;
    return rows[0]?.present === true;
  }

  private async hasProcedure(name: string): Promise<boolean> {
    const rows = await this.db<{ present: boolean }[]>`
      select to_regprocedure(${name}) is not null as present`;
    return rows[0]?.present === true;
  }

  private async logMaintenance(
    parentTable: string,
    success: boolean,
    detail: string,
    durationMs: number,
  ): Promise<void> {
    if (!(await this.tableExists('erp.partition_maintenance_log'))) return;
    await this.db`
      insert into erp.partition_maintenance_log (
        run_at, parent_table, action, partition_name, success, detail, duration_ms
      ) values (
        now(), ${parentTable}, 'analyze', ${`worker:${parentTable}`}, ${success},
        ${detail.slice(0, 1000)}, ${durationMs}
      )`;
    this.metrics.jobRuns.inc({ queue: 'maintenance', status: success ? 'succeeded' : 'failed' });
  }
}
