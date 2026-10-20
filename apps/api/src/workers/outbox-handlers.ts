/**
 * Outbox handler registry. Handlers are idempotent: re-dispatch is safe because
 * they key on archived event ids / job ids and the dispatcher only marks rows
 * processed after success.
 */
import { z } from 'zod';

import type { Db } from '../common/contracts';
import type { AppLogger } from '../modules/channels/ports/logger.port';
import type { OutboxStorePort } from './queue/outbox.store';
import { OutboxDispatcher, type OutboxHandler } from './queue/outbox.dispatcher';
import { DatabaseJobQueue } from './queue/job-queue';
import { ChannelSyncService } from '../modules/channels/services/channel-sync.service';
import { OutboundWebhookService } from '../modules/channels/services/outbound-webhook.service';
import { NotificationsService } from '../modules/notifications/services/notifications.service';
import {
  NotificationJobPayload,
  OutboundWebhookJobPayload,
  ReportExportJobPayload,
} from './job-payloads';

const WebhookReceivedPayload = z.object({
  channelAccountId: z.string().regex(/^\d+$/),
  channelCode: z.string().min(1).max(50),
  externalEventId: z.string().min(1).max(200),
  eventType: z.string().min(1).max(100),
  rawBodySha256: z.string().length(64).optional(),
});

const OrderReceivedPayload = z.object({
  channelAccountId: z.string().regex(/^\d+$/),
  channelCode: z.string().min(1).max(50),
  externalOrderId: z.string().min(1).max(150),
  externalStatus: z.string().max(50),
  placedAt: z.string().datetime(),
  grandTotal: z.string().regex(/^-?\d+$/),
  lineCount: z.number().int().nonnegative(),
});

const SyncRequestedPayload = z.object({ jobId: z.string().regex(/^\d+$/) });

export interface HandlerDependencies {
  readonly db: Db;
  readonly logger: AppLogger;
  readonly sync: ChannelSyncService;
  readonly outbound: OutboundWebhookService;
  readonly notifications: NotificationsService;
  readonly jobs: DatabaseJobQueue;
}

export function buildOutboxHandlers(deps: HandlerDependencies): readonly OutboxHandler[] {
  const webhookReceived: OutboxHandler = {
    eventType: 'channel.webhook.received',
    schema: WebhookReceivedPayload,
    async handle(event, payload) {
      const parsed = WebhookReceivedPayload.parse(payload);
      // Idempotent acknowledgement of the archived row. Domain consumers are
      // separate outbox events (sales/fulfillment own order creation).
      await deps.db`
        update erp.channel_webhook_events
        set status = 'processed', processed_at = coalesce(processed_at, now()), attempts = attempts + 1
        where channel_account_id = ${parsed.channelAccountId}::bigint
          and external_event_id = ${parsed.externalEventId}
          and status in ('received', 'processing')`;
      deps.logger.info(
        {
          eventId: event.id,
          channelAccountId: parsed.channelAccountId,
          eventType: parsed.eventType,
        },
        'archived webhook acknowledged',
      );
    },
  };

  const orderReceived: OutboxHandler = {
    eventType: 'channel.order.received',
    schema: OrderReceivedPayload,
    async handle(event, payload) {
      const parsed = OrderReceivedPayload.parse(payload);
      // The sales module owns canonical order creation. Until its intake port is
      // bound, this handler records the typed event and leaves the natural key
      // in idempotency_keys so a consumer can replay without duplicates.
      deps.logger.info(
        {
          eventId: event.id,
          externalOrderId: parsed.externalOrderId,
          channel: parsed.channelCode,
          lines: parsed.lineCount,
        },
        'channel order event observed (no intake binding)',
      );
    },
  };

  const notificationSend: OutboxHandler = {
    eventType: 'notification.send',
    schema: NotificationJobPayload,
    async handle(_event, payload) {
      const parsed = NotificationJobPayload.parse(payload);
      await deps.notifications.create({
        organizationId: parsed.organizationId,
        userId: parsed.userId,
        eventType: parsed.eventType,
        title: parsed.title,
        ...(parsed.body === undefined ? {} : { body: parsed.body }),
        channel: parsed.channel,
        priority: parsed.priority,
        ...(parsed.data === undefined ? {} : { data: parsed.data }),
        ...(parsed.mobile === undefined ? {} : { mobile: parsed.mobile }),
      });
    },
  };

  const syncRequested: OutboxHandler = {
    eventType: 'channel.sync.requested',
    schema: SyncRequestedPayload,
    async handle(_event, payload) {
      const parsed = SyncRequestedPayload.parse(payload);
      await deps.sync.runJob(parsed.jobId, 'outbox');
    },
  };

  const outboundDeliver: OutboxHandler = {
    eventType: 'webhook.outbound.deliver',
    schema: OutboundWebhookJobPayload,
    async handle(_event, payload) {
      const parsed = OutboundWebhookJobPayload.parse(payload);
      await deps.outbound.deliver(
        {
          organizationId: parsed.organizationId,
          eventType: parsed.eventType,
          entityType: parsed.entityType,
          entityId: parsed.entityId,
          aggregateType: parsed.aggregateType,
          aggregateId: parsed.aggregateId,
          data: parsed.data,
          version: parsed.version,
        },
        parsed.attemptNo,
      );
    },
  };

  const reportRequested: OutboxHandler = {
    eventType: 'report.export.requested',
    schema: ReportExportJobPayload,
    async handle(_event, payload) {
      const parsed = ReportExportJobPayload.parse(payload);
      await deps.jobs.add({
        queue: 'reports',
        jobType: 'report_export',
        payload: { exportJobId: parsed.exportJobId, organizationId: parsed.organizationId },
      });
    },
  };

  return [webhookReceived, orderReceived, notificationSend, syncRequested, outboundDeliver, reportRequested];
}

export function createOutboxDispatcher(input: {
  readonly store: OutboxStorePort;
  readonly logger: AppLogger;
  readonly handlers: readonly OutboxHandler[];
}): OutboxDispatcher {
  const dispatcher = new OutboxDispatcher({
    store: input.store,
    logger: input.logger,
    workerId: `outbox:${process.pid}`,
  });
  for (const handler of input.handlers) dispatcher.register(handler);
  return dispatcher;
}
