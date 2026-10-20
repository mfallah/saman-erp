/**
 * In-app notifications + optional SMS delivery + user preferences.
 * Idempotent creation keyed by an optional dedupe key (KV, 60 s).
 */
import { createHash } from 'node:crypto';

import { AppError } from '@saman/shared';
import type { Logger } from '../infrastructure/logger';
import type { KeyValueStore } from '../infrastructure/key-value';
import {
  resolvePreference,
  type NotificationChannel,
  type PreferenceRow,
  type QuietHours,
} from '../domain/notification.policy';
import type {
  NotificationRepositoryPort,
  NotificationRow,
  NotificationTemplateRow,
} from '../repositories/notification.repository';

export interface NotificationSmsPort {
  sendAdHoc(input: {
    organizationId: string;
    userId: string | null;
    mobile: string;
    message: string;
    purpose?: string;
  }): Promise<{ smsMessageId: string; providerMessageId: string | null }>;
}

export const NOTIFICATION_SMS_PORT = Symbol.for('saman.notification-sms-port');

export interface CreateNotificationInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly eventType: string;
  readonly title: string;
  readonly body?: string;
  readonly data?: Record<string, unknown>;
  readonly channel?: NotificationChannel;
  readonly priority?: 'low' | 'normal' | 'high' | 'critical';
  readonly mobile?: string;
  readonly dedupeKey?: string;
  readonly expiresAt?: Date;
}

export interface NotificationDeliveryStatus {
  readonly id: string;
  readonly channel: string;
  readonly state: 'pending' | 'read' | 'dismissed' | 'sent';
  readonly readAt: Date | null;
  readonly dismissedAt: Date | null;
  readonly smsMessageId: string | null;
}

export class NotificationsService {
  constructor(
    private readonly deps: {
      readonly repository: NotificationRepositoryPort;
      readonly store: KeyValueStore;
      readonly logger: Logger;
      readonly sms?: NotificationSmsPort;
      readonly now?: () => Date;
    },
  ) {}

  async create(input: CreateNotificationInput): Promise<{ id: string; delivered: boolean; reason: string } | null> {
    const channel = input.channel ?? 'in_app';
    const priority = input.priority ?? 'normal';
    const now = (this.deps.now ?? (() => new Date()))();

    if (input.dedupeKey !== undefined) {
      const key = `notif:${input.userId}:${createHash('sha256')
        .update(`${input.eventType}:${input.dedupeKey}`)
        .digest('hex')}`;
      if ((await this.deps.store.get(key)) !== null) {
        return null;
      }
      await this.deps.store.set(key, '1', 60);
    }

    const preferences = await this.deps.repository.preferences(input.userId);
    const quiet = preferences.find(
      (row) => row.eventType === '*' && row.channel === '*' && row.quietHours !== null,
    )?.quietHours;
    const decision = resolvePreference({
      preferences: preferences as readonly PreferenceRow[],
      eventType: input.eventType,
      channel,
      priority,
      quietHours: quiet ?? null,
      now,
    });
    if (!decision.allowed) {
      this.deps.logger.info(
        { userId: input.userId, eventType: input.eventType, channel, reason: decision.reason },
        'notification suppressed by preference',
      );
      return { id: '', delivered: false, reason: decision.reason };
    }

    const id = await this.deps.repository.insert({
      organizationId: input.organizationId,
      userId: input.userId,
      eventType: input.eventType,
      title: input.title.slice(0, 250),
      body: input.body === undefined ? null : input.body.slice(0, 5000),
      data: input.data ?? {},
      channel,
      priority,
      expiresAt: input.expiresAt ?? null,
    });

    if (channel === 'sms' && this.deps.sms !== undefined && input.mobile !== undefined) {
      try {
        const sent = await this.deps.sms.sendAdHoc({
          organizationId: input.organizationId,
          userId: input.userId,
          mobile: input.mobile,
          message: `${input.title}${input.body === undefined ? '' : `\n${input.body}`}`,
          purpose: input.eventType,
        });
        this.deps.logger.info(
          { notificationId: id, smsMessageId: sent.smsMessageId },
          'notification sms sent',
        );
      } catch (error) {
        // In-app row already exists; SMS failure is retried by the worker.
        this.deps.logger.warn(
          {
            notificationId: id,
            error: error instanceof Error ? error.message : 'sms_failed',
          },
          'notification sms failed',
        );
      }
    }
    return { id, delivered: true, reason: 'allowed' };
  }

  async list(input: {
    userId: string;
    unreadOnly?: boolean;
    type?: string;
    limit?: number;
  }): Promise<readonly NotificationRow[]> {
    return this.deps.repository.list({
      userId: input.userId,
      unreadOnly: input.unreadOnly ?? false,
      ...(input.type === undefined ? {} : { type: input.type }),
      limit: Math.min(Math.max(input.limit ?? 50, 1), 200),
    });
  }

  async get(userId: string, id: string): Promise<NotificationRow> {
    const row = await this.deps.repository.findById(userId, id);
    if (row === null) throw new AppError('NOT_FOUND');
    return row;
  }

  async markRead(userId: string, id: string): Promise<void> {
    if (!(await this.deps.repository.markRead(userId, id))) throw new AppError('NOT_FOUND');
  }

  async markAllRead(userId: string): Promise<number> {
    return this.deps.repository.markAllRead(userId);
  }

  async dismiss(userId: string, id: string): Promise<void> {
    if (!(await this.deps.repository.dismiss(userId, id))) throw new AppError('NOT_FOUND');
  }

  deliveryStatus(row: NotificationRow, smsMessageId?: string | null): NotificationDeliveryStatus {
    return {
      id: row.id,
      channel: row.channel,
      state:
        row.dismissedAt !== null
          ? 'dismissed'
          : row.readAt !== null
            ? 'read'
            : smsMessageId !== undefined && smsMessageId !== null
              ? 'sent'
              : 'pending',
      readAt: row.readAt,
      dismissedAt: row.dismissedAt,
      smsMessageId: smsMessageId ?? (typeof row.data['smsMessageId'] === 'string' ? row.data['smsMessageId'] : null),
    };
  }
}

export class NotificationPreferenceService {
  constructor(private readonly repository: NotificationRepositoryPort) {}

  async list(userId: string): Promise<
    readonly { eventType: string; channel: string; enabled: boolean; quietHours: QuietHours | null }[]
  > {
    return this.repository.preferences(userId);
  }

  async update(input: {
    userId: string;
    channels?: readonly { event: string; type: string; enabled: boolean }[];
    quietHours?: QuietHours | null;
  }): Promise<void> {
    for (const item of input.channels ?? []) {
      await this.repository.upsertPreference({
        userId: input.userId,
        eventType: item.event,
        channel: item.type,
        enabled: item.enabled,
      });
    }
    if (input.quietHours !== undefined) {
      await this.repository.upsertPreference({
        userId: input.userId,
        eventType: '*',
        channel: '*',
        enabled: true,
        quietHours: input.quietHours,
      });
    }
  }
}

export class NotificationTemplateService {
  constructor(
    private readonly repository: NotificationRepositoryPort,
    private readonly logger: Logger,
  ) {}

  async get(organizationId: string, eventType: string, channel: string): Promise<NotificationTemplateRow> {
    const template = await this.repository.findTemplate(organizationId, eventType, channel);
    if (template === null) throw new AppError('NOT_FOUND');
    return template;
  }

  async list(organizationId: string): Promise<readonly NotificationTemplateRow[]> {
    return this.repository.listTemplates(organizationId);
  }

  async upsert(input: {
    organizationId: string;
    eventType: string;
    channel: NotificationChannel;
    subjectFa?: string | null;
    bodyFa: string;
    variables: readonly string[];
    isActive?: boolean;
  }): Promise<NotificationTemplateRow> {
    return this.repository.upsertTemplate({
      organizationId: input.organizationId,
      eventType: input.eventType,
      channel: input.channel,
      subjectFa: input.subjectFa ?? null,
      bodyFa: input.bodyFa,
      variables: input.variables,
      isActive: input.isActive ?? true,
    });
  }

  async remove(organizationId: string, id: string): Promise<void> {
    void organizationId;
    await this.repository.deleteTemplate(id);
    this.logger.info({ templateId: id }, 'notification template deactivated');
  }
}
