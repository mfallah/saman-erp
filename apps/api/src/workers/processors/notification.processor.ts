/** Notification queue drain: typed payload → in-app/SMS delivery. */
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { AppError } from '@saman/shared';
import { DB, type Db } from '../../common/contracts';
import type { AppLogger } from '../../modules/channels/ports/logger.port';
import { LOGGER } from '../../modules/channels/ports/logger.port';
import { NotificationsService } from '../../modules/notifications/services/notifications.service';
import { NotificationJobPayload } from '../job-payloads';
import { DatabaseJobQueue } from '../queue/job-queue';
import { getWorkerMetrics } from '../metrics';

@Injectable()
export class NotificationProcessor implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly queue: DatabaseJobQueue;
  private readonly metrics = getWorkerMetrics();
  private readonly workerId = `notifications:${process.pid}`;

  constructor(
    @Inject(DB) db: Db,
    private readonly notifications: NotificationsService,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {
    this.queue = new DatabaseJobQueue(db);
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.logger.error(
          { error: error instanceof Error ? error.message : 'processor_failed' },
          'notification poll failed',
        );
      });
    }, 1_000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(limit = 20): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const jobs = await this.queue.claim('notifications', this.workerId, limit);
      for (const job of jobs) {
        const parsed = NotificationJobPayload.safeParse(job.payload);
        if (!parsed.success) {
          await this.queue.fail(job.id, 'VALIDATION_ERROR', 'invalid notification payload', new Date());
          this.metrics.notifications.inc({ channel: 'unknown', status: 'failed' });
          continue;
        }
        try {
          await this.notifications.create({
            organizationId: parsed.data.organizationId,
            userId: parsed.data.userId,
            eventType: parsed.data.eventType,
            title: parsed.data.title,
            ...(parsed.data.body === undefined ? {} : { body: parsed.data.body }),
            channel: parsed.data.channel,
            priority: parsed.data.priority,
            ...(parsed.data.data === undefined ? {} : { data: parsed.data.data }),
            ...(parsed.data.mobile === undefined ? {} : { mobile: parsed.data.mobile }),
          });
          await this.queue.complete(job.id, { delivered: true });
          this.metrics.notifications.inc({ channel: parsed.data.channel, status: 'delivered' });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'delivery_failed';
          const retryable = !(error instanceof AppError);
          const nextRun = new Date(Date.now() + Math.min(60_000, 1000 * 2 ** job.attempts));
          await this.queue.fail(job.id, 'NOTIFICATION_FAILED', message, nextRun);
          this.metrics.notifications.inc({
            channel: parsed.data.channel,
            status: retryable ? 'retried' : 'failed',
          });
        }
      }
      return jobs.length;
    } finally {
      this.running = false;
    }
  }
}
