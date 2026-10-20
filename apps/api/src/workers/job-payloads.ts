/** Typed job/event payloads (Zod). Queue jobs are validated on both ends. */
import { z } from 'zod';

export const QUEUE_NAMES = [
  'channel-sync',
  'notifications',
  'reports',
  'maintenance',
  'webhooks',
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export const ChannelSyncJobPayload = z.object({
  jobId: z.string().regex(/^\d+$/),
});
export type ChannelSyncJobPayload = z.infer<typeof ChannelSyncJobPayload>;

export const NotificationJobPayload = z.object({
  organizationId: z.string().regex(/^\d+$/),
  userId: z.string().regex(/^\d+$/),
  eventType: z.string().min(1).max(100),
  title: z.string().min(1).max(250),
  body: z.string().max(5000).optional(),
  channel: z.enum(['in_app', 'email', 'sms', 'push']).default('in_app'),
  priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  data: z.record(z.unknown()).optional(),
  mobile: z.string().max(20).optional(),
});
export type NotificationJobPayload = z.infer<typeof NotificationJobPayload>;

export const MaintenanceJobPayload = z.object({
  task: z.enum(['partitions', 'retention', 'expired_reservations', 'reconcile']),
});
export type MaintenanceJobPayload = z.infer<typeof MaintenanceJobPayload>;

export const ReportExportJobPayload = z.object({
  exportJobId: z.string().regex(/^\d+$/),
  organizationId: z.string().regex(/^\d+$/),
});
export type ReportExportJobPayload = z.infer<typeof ReportExportJobPayload>;

export const OutboundWebhookJobPayload = z.object({
  organizationId: z.string().regex(/^\d+$/),
  eventType: z.string().min(1).max(100),
  entityType: z.string().max(60).nullable(),
  entityId: z.string().regex(/^\d+$/).nullable(),
  aggregateType: z.string().min(1).max(80),
  aggregateId: z.string().regex(/^\d+$/),
  data: z.record(z.unknown()),
  version: z.number().int().positive().default(1),
  attemptNo: z.number().int().positive().default(1),
});
export type OutboundWebhookJobPayload = z.infer<typeof OutboundWebhookJobPayload>;
