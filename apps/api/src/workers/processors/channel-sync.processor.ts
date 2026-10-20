/**
 * Channel sync worker: claims mirrored `channel_sync_jobs` rows and executes
 * them through `ChannelSyncService` (adapter calls, retry, DLQ).
 */
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { DB, type Db } from '../../common/contracts';
import type { AppLogger } from '../../modules/channels/ports/logger.port';
import { LOGGER } from '../../modules/channels/ports/logger.port';
import type { ChannelSyncService } from '../../modules/channels/services/channel-sync.service';
import { getWorkerMetrics } from '../metrics';

@Injectable()
export class ChannelSyncProcessor implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly metrics = getWorkerMetrics();
  private readonly workerId: string;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly sync: ChannelSyncService,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {
    this.workerId = `channel-sync:${process.pid}`;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.logger.error(
          { error: error instanceof Error ? error.message : 'processor_failed' },
          'channel sync poll failed',
        );
      });
    }, 1_000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async runOnce(limit = 10): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const rows = await this.db<{ id: string }[]>`
        with candidates as (
          select id from erp.channel_sync_jobs
          where status in ('queued', 'failed')
            and next_run_at <= now()
            and attempts < max_attempts
            and (locked_at is null or locked_at < now() - interval '5 minutes')
          order by next_run_at asc, id asc
          limit ${limit}
          for update skip locked
        )
        update erp.channel_sync_jobs j
        set locked_at = now(), locked_by = ${this.workerId}
        from candidates c
        where j.id = c.id
        returning j.id::text`;
      for (const row of rows) {
        const result = await this.sync.runJob(String(row.id), this.workerId);
        this.metrics.channelSync.inc({ job_type: result.jobType, status: result.status });
        this.logger.info({ jobId: result.jobId, status: result.status }, 'channel sync job executed');
      }
      return rows.length;
    } finally {
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
