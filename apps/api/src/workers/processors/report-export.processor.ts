/**
 * Report/export worker orchestration. Rendering + object storage live behind
 * `ReportExportRenderer` (reporting module / S3 adapter); this processor owns
 * the durable job lifecycle, retries and dead-lettering.
 */
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { DB, type Db } from '../../common/contracts';
import type { AppLogger } from '../../modules/channels/ports/logger.port';
import { LOGGER } from '../../modules/channels/ports/logger.port';
import { ReportExportJobPayload } from '../job-payloads';
import { DatabaseJobQueue } from '../queue/job-queue';
import { getWorkerMetrics } from '../metrics';

export const REPORT_EXPORT_RENDERER = Symbol.for('saman.report-export-renderer');

export interface ReportExportRenderer {
  render(input: {
    exportJobId: string;
    organizationId: string;
    workerId: string;
  }): Promise<{ rowCount: number; artifactRef: string }>;
}

@Injectable()
export class ReportExportProcessor implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly queue: DatabaseJobQueue;
  private readonly metrics = getWorkerMetrics();
  private readonly workerId = `reports:${process.pid}`;

  constructor(
    @Inject(DB) db: Db,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Inject(REPORT_EXPORT_RENDERER) private readonly renderer: ReportExportRenderer,
  ) {
    this.queue = new DatabaseJobQueue(db);
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.logger.error(
          { error: error instanceof Error ? error.message : 'report_failed' },
          'report export poll failed',
        );
      });
    }, 2_000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(limit = 2): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const jobs = await this.queue.claim('reports', this.workerId, limit);
      for (const job of jobs) {
        const parsed = ReportExportJobPayload.safeParse(job.payload);
        if (!parsed.success) {
          await this.queue.fail(job.id, 'VALIDATION_ERROR', 'invalid report payload', new Date());
          this.metrics.jobRuns.inc({ queue: 'reports', status: 'failed' });
          continue;
        }
        try {
          const result = await this.renderer.render({
            exportJobId: parsed.data.exportJobId,
            organizationId: parsed.data.organizationId,
            workerId: this.workerId,
          });
          await this.queue.complete(job.id, {
            rowCount: result.rowCount,
            artifactRef: result.artifactRef,
          });
          this.metrics.jobRuns.inc({ queue: 'reports', status: 'succeeded' });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'render_failed';
          const attemptsLeft = job.attempts < job.maxAttempts;
          await this.queue.fail(
            job.id,
            'REPORT_EXPORT_FAILED',
            message,
            new Date(Date.now() + (attemptsLeft ? 30_000 * job.attempts : 0)),
          );
          this.metrics.jobRuns.inc({
            queue: 'reports',
            status: attemptsLeft ? 'retried' : 'failed',
          });
        }
      }
      return jobs.length;
    } finally {
      this.running = false;
    }
  }
}
