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
import type { DatabaseJobQueue } from './queue/job-queue';
import type { ChannelSyncService } from '../modules/channels/services/channel-sync.service';
import type { OutboundWebhookService } from '../modules/channels/services/outbound-webhook.service';
import type { NotificationsService } from '../modules/notifications/services/notifications.service';
import type { PostingService } from '../modules/accounting/posting/posting.service';
import type { PickAssignmentPort } from '../modules/warehouse/pick-assignment.service';
import type { AccountingEventType } from '../modules/accounting/events';
import type { TenantContext } from '../common/contracts';
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

const OrderReceivedLine = z.object({
  externalLineId: z.string().max(150).optional(),
  externalSku: z.string().max(150).optional(),
  externalVariantId: z.string().max(150).optional(),
  externalProductId: z.string().max(150).optional(),
  externalProductTitle: z.string().max(300).optional(),
  quantity: z.string(),
  unitPrice: z.string(),
  discount: z.string().optional(),
});

const OrderReceivedPayload = z.object({
  channelAccountId: z.string().regex(/^\d+$/),
  channelCode: z.string().min(1).max(50),
  externalOrderId: z.string().min(1).max(150),
  externalStatus: z.string().max(50),
  placedAt: z.string().datetime(),
  grandTotal: z.string().regex(/^-?\d+$/),
  lineCount: z.number().int().nonnegative(),
  lines: z.array(OrderReceivedLine).optional(),
});

const SyncRequestedPayload = z.object({ jobId: z.string().regex(/^\d+$/) });

export interface HandlerDependencies {
  readonly db: Db;
  readonly logger: AppLogger;
  readonly sync: ChannelSyncService;
  readonly outbound: OutboundWebhookService;
  readonly notifications: NotificationsService;
  readonly jobs: DatabaseJobQueue;
  readonly posting: PostingService;
  readonly pickAssignment: PickAssignmentPort;
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
      const lines = parsed.lines ?? [];
      if (lines.length === 0) {
        deps.logger.info(
          { eventId: event.id, externalOrderId: parsed.externalOrderId },
          'channel order received without line payload; nothing to materialise',
        );
        return;
      }
      const db = deps.db;
      const org = event.organizationId;
      const orderNo = `${parsed.channelCode.toUpperCase()}-${parsed.externalOrderId}`.slice(0, 60);
      let subtotal = 0;
      let discountTotal = 0;
      for (const line of lines) {
        const quantity = Math.max(0, Number(line.quantity) || 0);
        const unitPrice = Math.max(0, Math.trunc(Number(line.unitPrice) || 0));
        const discount = Math.max(0, Math.trunc(Number(line.discount ?? '0') || 0));
        subtotal += Math.max(0, quantity * unitPrice - discount);
        discountTotal += discount;
      }
      const grandTotal = Math.max(Number(parsed.grandTotal) || 0, subtotal);
      const inserted = await db<{ id: string }[]>`
        insert into erp.sales_orders
          (organization_id, public_id, order_no, channel_account_id, external_order_id,
           warehouse_id, status, currency, subtotal_amount, discount_amount, tax_amount,
           shipping_amount, grand_total_amount, order_date, business_date, idempotency_key)
        values
          (${org}, gen_random_uuid(), ${orderNo}, ${parsed.channelAccountId}::bigint,
           ${parsed.externalOrderId},
           (select id from erp.warehouses where organization_id = ${org} and deleted_at is null order by id limit 1),
           'pending', 'IRR', ${subtotal}, ${discountTotal}, 0, 0, ${grandTotal},
           ${parsed.placedAt}::timestamptz, (${parsed.placedAt}::timestamptz)::date,
           ${`channel:order:${parsed.externalOrderId}`})
        on conflict (organization_id, order_no) do nothing
        returning id::text as id
      `;
      const orderId = inserted[0]?.id;
      if (orderId === undefined) {
        deps.logger.info({ externalOrderId: parsed.externalOrderId }, 'channel order already materialised');
        return;
      }
      let lineNo = 0;
      for (const line of lines) {
        lineNo += 1;
        const quantity = Math.max(0, Number(line.quantity) || 0);
        const unitPrice = Math.max(0, Math.trunc(Number(line.unitPrice) || 0));
        const discount = Math.max(0, Math.trunc(Number(line.discount ?? '0') || 0));
        const net = Math.max(0, quantity * unitPrice - discount);
        const variant = await db<{ id: string; sku: string | null; title: string | null }[]>`
          select v.id::text as id, v.sku, coalesce(v.title, p.name) as title
          from erp.channel_product_mappings m
          join erp.product_variants v on v.id = m.product_variant_id
          join erp.products p on p.id = v.product_id
          where m.channel_account_id = ${parsed.channelAccountId}::bigint
            and m.deleted_at is null
            and (
              (${line.externalProductId ?? null}::text is not null and m.external_product_id = ${line.externalProductId ?? null})
              or (${line.externalVariantId ?? null}::text is not null and m.external_variant_id = ${line.externalVariantId ?? null})
              or (${line.externalSku ?? null}::text is not null and m.external_sku = ${line.externalSku ?? null})
              or (${line.externalSku ?? null}::text is not null and v.sku = ${line.externalSku ?? null})
              or (${line.externalProductTitle ?? null}::text is not null and btrim(p.name) = btrim(${line.externalProductTitle ?? null}))
            )
          limit 1
        `;
        const row = variant[0];
        if (row === undefined) continue;
        await db`
          insert into erp.sales_order_lines
            (order_id, line_no, product_variant_id, sku_snapshot, title_snapshot,
             quantity, unit_price_amount, discount_amount, net_amount, gross_amount,
             tax_percent, tax_amount, status)
          values (${orderId}::bigint, ${lineNo}, ${row.id}::bigint, ${row.sku}, ${row.title},
                  ${quantity}, ${unitPrice}, ${discount}, ${net}, ${quantity * unitPrice},
                  0, 0, 'pending')
        `;
      }
      deps.logger.info(
        { eventId: event.id, externalOrderId: parsed.externalOrderId, orderId, lines: lines.length },
        'channel order materialised',
      );

      // Pick tasks are a side effect: a failure here must not roll back (or
      // endlessly re-dispatch) an order that is already materialised.
      try {
        const tasks = await deps.pickAssignment.assignOrderPickTasks({
          orgId: BigInt(org),
          orderInternalId: BigInt(orderId),
        });
        deps.logger.info({ eventId: event.id, orderId, tasks }, 'pick tasks created for channel order');
      } catch (error) {
        deps.logger.error(
          { eventId: event.id, orderId, error: error instanceof Error ? error.message : String(error) },
          'pick task auto-assignment failed',
        );
      }
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


  /**
   * Automatic double-entry posting from inventory domain events. The posting
   * rules are code-owned and versioned; `postEventIsolated` writes the journal,
   * balances, audit and the follow-up outbox event in one transaction.
   */
  const makeAccountingHandler = (eventType: string): OutboxHandler => ({
    eventType,
    schema: z.record(z.unknown()),
    async handle(event, payload) {
      // outbox jsonb may arrive as a string depending on the driver path; normalise.
      const rawPayload: unknown = typeof payload === 'string' ? JSON.parse(payload) : payload;
      const data = (rawPayload ?? {}) as Record<string, unknown>;
      const entryDate = String(data['businessDate'] ?? new Date().toISOString().slice(0, 10));
      const ctx: TenantContext = {
        requestId: `outbox:${event.id}`,
        orgId: BigInt(event.organizationId),
        orgPublicId: '',
        actorId: null,
        actorPublicId: null,
        permissions: [],
        branchIds: null,
        warehouseIds: null,
      };
      // Adjustments: derive gain/shortage from the signed quantity when the
      // emitter did not supply a kind (the rule needs it to pick the account).
      const enriched =
        event.eventType === 'inventory.adjustment.posted' && data['kind'] === undefined
          ? { ...data, kind: String(data['quantity'] ?? '0').startsWith('-') ? 'count_shortage' : 'count_gain' }
          : data;
      await deps.posting.postEventIsolated(ctx, {
        eventType: event.eventType as AccountingEventType,
        payload: enriched,
        context: { entryDate },
      });
      deps.logger.info({ eventId: event.id, eventType: event.eventType }, 'accounting journal posted from event');
    },
  });
  const accountingHandlers: OutboxHandler[] = [
    'inventory.adjustment.posted',
    'inventory.issue.posted',
    'inventory.transfer.dispatched',
    'inventory.transfer.received',
    'inventory.valuation.posted',
  ].map(makeAccountingHandler);

  return [webhookReceived, orderReceived, notificationSend, syncRequested, ...accountingHandlers];

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
