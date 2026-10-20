import { Module } from '@nestjs/common';

import { DB, type Db } from '../../common/contracts';
import {
  createNotificationLogger,
  NOTIFICATION_LOGGER,
  type Logger,
} from './infrastructure/logger';
import {
  createNotificationKeyValue,
  NOTIFICATION_KV,
  type KeyValueStore,
} from './infrastructure/key-value';
import { SqlNotificationRepository } from './repositories/notification.repository';
import {
  NotificationPreferenceService,
  NotificationTemplateService,
  NotificationsService,
} from './services/notifications.service';

@Module({
  providers: [
    { provide: NOTIFICATION_LOGGER, useFactory: (): Logger => createNotificationLogger() },
    {
      provide: NOTIFICATION_KV,
      useFactory: (logger: Logger): KeyValueStore => createNotificationKeyValue(logger),
      inject: [NOTIFICATION_LOGGER],
    },
    {
      provide: SqlNotificationRepository,
      useFactory: (db: Db): SqlNotificationRepository => new SqlNotificationRepository(db),
      inject: [DB],
    },
    {
      provide: NotificationsService,
      useFactory: (
        repository: SqlNotificationRepository,
        store: KeyValueStore,
        logger: Logger,
      ): NotificationsService => new NotificationsService({ repository, store, logger }),
      inject: [SqlNotificationRepository, NOTIFICATION_KV, NOTIFICATION_LOGGER],
    },
    {
      provide: NotificationPreferenceService,
      useFactory: (repository: SqlNotificationRepository): NotificationPreferenceService =>
        new NotificationPreferenceService(repository),
      inject: [SqlNotificationRepository],
    },
    {
      provide: NotificationTemplateService,
      useFactory: (
        repository: SqlNotificationRepository,
        logger: Logger,
      ): NotificationTemplateService => new NotificationTemplateService(repository, logger),
      inject: [SqlNotificationRepository, NOTIFICATION_LOGGER],
    },
  ],
  exports: [
    NotificationsService,
    NotificationPreferenceService,
    NotificationTemplateService,
    NOTIFICATION_KV,
  ],
})
export class NotificationsModule {}

