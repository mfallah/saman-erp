/** Prometheus metrics for the worker (single registry, idempotent getters). */
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export interface WorkerMetrics {
  readonly registry: Registry;
  readonly outboxProcessed: Counter<'event_type'>;
  readonly outboxFailed: Counter<'event_type'>;
  readonly outboxDead: Counter<'event_type'>;
  readonly outboxLag: Gauge<'event_type'>;
  readonly outboxBatch: Histogram<'result'>;
  readonly channelSync: Counter<'job_type' | 'status'>;
  readonly notifications: Counter<'channel' | 'status'>;
  readonly webhookDeliveries: Counter<'outcome'>;
  readonly jobRuns: Counter<'queue' | 'status'>;
}

let cached: WorkerMetrics | null = null;

export function getWorkerMetrics(): WorkerMetrics {
  if (cached !== null) return cached;
  const registry = new Registry();
  const outboxProcessed = new Counter({
    name: 'saman_outbox_processed_total',
    help: 'Outbox events processed successfully',
    labelNames: ['event_type'],
    registers: [registry],
  });
  const outboxFailed = new Counter({
    name: 'saman_outbox_failed_total',
    help: 'Outbox dispatch attempts that failed and will retry',
    labelNames: ['event_type'],
    registers: [registry],
  });
  const outboxDead = new Counter({
    name: 'saman_outbox_dead_total',
    help: 'Outbox events sent to the dead-letter table',
    labelNames: ['event_type'],
    registers: [registry],
  });
  const outboxLag = new Gauge({
    name: 'saman_outbox_lag_seconds',
    help: 'Age of the oldest claimable outbox event',
    labelNames: ['event_type'],
    registers: [registry],
  });
  const outboxBatch = new Histogram({
    name: 'saman_outbox_batch_duration_seconds',
    help: 'Duration of one outbox dispatch batch',
    labelNames: ['result'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [registry],
  });
  const channelSync = new Counter({
    name: 'saman_channel_sync_total',
    help: 'Channel sync job outcomes',
    labelNames: ['job_type', 'status'],
    registers: [registry],
  });
  const notifications = new Counter({
    name: 'saman_notifications_total',
    help: 'Notification delivery outcomes',
    labelNames: ['channel', 'status'],
    registers: [registry],
  });
  const webhookDeliveries = new Counter({
    name: 'saman_webhook_deliveries_total',
    help: 'Outbound webhook delivery outcomes',
    labelNames: ['outcome'],
    registers: [registry],
  });
  const jobRuns = new Counter({
    name: 'saman_job_runs_total',
    help: 'Background job outcomes',
    labelNames: ['queue', 'status'],
    registers: [registry],
  });
  cached = {
    registry,
    outboxProcessed,
    outboxFailed,
    outboxDead,
    outboxLag,
    outboxBatch,
    channelSync,
    notifications,
    webhookDeliveries,
    jobRuns,
  };
  return cached;
}
