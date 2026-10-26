/**
 * Worker composition root. No HTTP server: Nest application context + outbox
 * dispatcher + pollers. Processors recover from Redis loss via DB rows.
 */
import { Module } from '@nestjs/common';

import { AppError } from '@saman/shared';
import { DB, type Db } from '../common/contracts';
import { PlatformModule } from '../common/platform.module';
import { AppConfigModule } from '../config/config.module';
import { LoggingModule } from '../common/logging/logging.module';
import { ChannelsModule } from '../modules/channels/channels.module';
import { LOGGER } from '../modules/channels/ports/logger.port';
import type { AppLogger } from '../modules/channels/ports/logger.port';
import { IntegrationsModule } from '../modules/integrations/integrations.module';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { AutomationModule } from '../modules/automation/automation.module';
import { AccountingModule } from '../modules/accounting/accounting.module';
import { PostingService } from '../modules/accounting/posting/posting.service';
import { WarehouseModule } from '../modules/warehouse/warehouse.module';
import { PickAssignmentService } from '../modules/warehouse/pick-assignment.service';
import { SqlOutboxStore } from './queue/outbox.store';
import { DatabaseJobQueue } from './queue/job-queue';
import { OutboxDispatcher } from './queue/outbox.dispatcher';
import { buildOutboxHandlers } from './outbox-handlers';
import { ChannelSyncProcessor } from './processors/channel-sync.processor';
import { NotificationProcessor } from './processors/notification.processor';
import { MaintenanceProcessor } from './processors/maintenance.processor';
import {
  REPORT_EXPORT_RENDERER,
  ReportExportProcessor,
  type ReportExportRenderer,
} from './processors/report-export.processor';
import { WorkerRuntime } from './runtime';
import { ChannelSyncService } from '../modules/channels/services/channel-sync.service';
import { OutboundWebhookService } from '../modules/channels/services/outbound-webhook.service';
import { NotificationsService } from '../modules/notifications/services/notifications.service';

@Module({
  imports: [AppConfigModule, LoggingModule, PlatformModule, ChannelsModule, IntegrationsModule, NotificationsModule, AutomationModule, AccountingModule, WarehouseModule],
  providers: [
    {
      provide: SqlOutboxStore,
      useFactory: (db: Db): SqlOutboxStore => new SqlOutboxStore(db),
      inject: [DB],
    },
    {
      provide: DatabaseJobQueue,
      useFactory: (db: Db): DatabaseJobQueue => new DatabaseJobQueue(db),
      inject: [DB],
    },
    {
      provide: OutboxDispatcher,
      useFactory: (
        store: SqlOutboxStore,
        db: Db,
        logger: AppLogger,
        sync: ChannelSyncService,
        outbound: OutboundWebhookService,
        notifications: NotificationsService,
        jobs: DatabaseJobQueue,
        posting: PostingService,
        pickAssignment: PickAssignmentService,
      ): OutboxDispatcher => {
        const handlers = buildOutboxHandlers({ db, logger, sync, outbound, notifications, jobs, posting, pickAssignment });
        const dispatcher = new OutboxDispatcher({
          store,
          logger,
          workerId: `outbox:${process.pid}`,
        });
        for (const handler of handlers) dispatcher.register(handler);
        return dispatcher;
      },
      inject: [
        SqlOutboxStore,
        DB,
        LOGGER,
        ChannelSyncService,
        OutboundWebhookService,
        NotificationsService,
        DatabaseJobQueue,
        PostingService,
        PickAssignmentService,
      ],
    },
    {
      provide: REPORT_EXPORT_RENDERER,
      useFactory: (): ReportExportRenderer => ({
        async render(): Promise<{ rowCount: number; artifactRef: string }> {
          // Reporting owns rendering + S3. Bound by the reporting module/worker.
          throw new AppError('NOT_IMPLEMENTED', {
            message: 'تولید فایل گزارش به سرویس گزارش‌گیری متصل نشده است.',
            messageKey: 'error.report_renderer_missing',
          });
        },
      }),
    },
    ChannelSyncProcessor,
    NotificationProcessor,
    MaintenanceProcessor,
    ReportExportProcessor,
    WorkerRuntime,
  ],
})
export class WorkerModule {}
