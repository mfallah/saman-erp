/**
 * Transactional-outbox dispatcher (ADR-0010).
 *
 * - batches of 100 with `FOR UPDATE SKIP LOCKED`;
 * - `LISTEN/NOTIFY` is a wake-up hint only, 1 s polling is the fallback;
 * - exponential backoff 30 s → 1 h; non-retryable errors or max attempts go to
 *   `erp.integration_dead_letters` and raise the `outbox_dead` metric;
 * - handlers are idempotent and keyed by `(event_type, aggregate_id, event_version)`.
 */
import type { ZodType } from 'zod';

import { backoffDelayMs } from '../../modules/channels/infrastructure/backoff';
import { IntegrationError } from '../../modules/channels/domain/channel.types';
import type { AppLogger } from '../../modules/channels/ports/logger.port';
import type { OutboxEventRow, OutboxStorePort } from './outbox.store';
import { getWorkerMetrics } from '../metrics';

export interface OutboxHandler {
  readonly eventType: string;
  readonly version?: number;
  readonly schema: ZodType;
  handle(event: OutboxEventRow, payload: unknown): Promise<void>;
}

export interface DispatchSummary {
  readonly claimed: number;
  readonly processed: number;
  readonly retried: number;
  readonly dead: number;
  readonly ignored: number;
}

export class OutboxDispatcher {
  private readonly handlers = new Map<string, OutboxHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private notifyPending = false;
  private listenRequest: { unlisten(): Promise<void> } | null = null;
  private readonly metrics = getWorkerMetrics();

  constructor(
    private readonly deps: {
      readonly store: OutboxStorePort;
      readonly logger: AppLogger;
      readonly workerId: string;
      readonly batchSize?: number;
      readonly pollIntervalMs?: number;
      readonly now?: () => Date;
      readonly random?: () => number;
    },
  ) {}

  register(handler: OutboxHandler): void {
    this.handlers.set(handler.eventType, handler);
  }

  get handlerCount(): number {
    return this.handlers.size;
  }

  async dispatchOnce(): Promise<DispatchSummary> {
    if (this.running) return { claimed: 0, processed: 0, retried: 0, dead: 0, ignored: 0 };
    this.running = true;
    const started = Date.now();
    let claimed = 0;
    let processed = 0;
    let retried = 0;
    let dead = 0;
    let ignored = 0;
    try {
      const batch = await this.deps.store.claimBatch(this.deps.batchSize ?? 100, this.deps.workerId);
      claimed = batch.length;
      for (const event of batch) {
        const handler = this.handlers.get(event.eventType);
        if (handler === undefined) {
          // Unknown events are acknowledged: replay is possible from the archive.
          await this.deps.store.markProcessed(event.id);
          this.deps.logger.warn(
            { eventId: event.id, eventType: event.eventType },
            'outbox event has no handler; acknowledged',
          );
          ignored += 1;
          continue;
        }
        try {
          const parsed = handler.schema.safeParse(event.payload);
          if (!parsed.success) {
            await this.deps.store.deadLetter(event, 'invalid_event_payload');
            this.metrics.outboxDead.inc({ event_type: event.eventType });
            dead += 1;
            continue;
          }
          await handler.handle(event, parsed.data);
          await this.deps.store.markProcessed(event.id);
          this.metrics.outboxProcessed.inc({ event_type: event.eventType });
          processed += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'handler_failed';
          const retryable =
            !(error instanceof IntegrationError) || error.retryable;
          if (!retryable || event.attempts >= event.maxAttempts) {
            await this.deps.store.deadLetter(event, message);
            this.metrics.outboxDead.inc({ event_type: event.eventType });
            this.deps.logger.error(
              { eventId: event.id, eventType: event.eventType, attempts: event.attempts },
              'outbox event dead-lettered',
            );
            dead += 1;
          } else {
            const delay = backoffDelayMs(
              { attempts: event.attempts },
              this.deps.random ?? Math.random,
            );
            const now = (this.deps.now ?? (() => new Date()))();
            await this.deps.store.markFailed(event.id, new Date(now.getTime() + delay), message);
            this.metrics.outboxFailed.inc({ event_type: event.eventType });
            this.deps.logger.warn(
              { eventId: event.id, eventType: event.eventType, attempts: event.attempts, delay },
              'outbox event scheduled for retry',
            );
            retried += 1;
          }
        }
      }
      const lag = await this.deps.store.oldestLagSeconds();
      this.metrics.outboxLag.set(lag);
      this.metrics.outboxBatch.observe({ result: 'ok' }, (Date.now() - started) / 1000);
      return { claimed, processed, retried, dead, ignored };
    } catch (error) {
      this.metrics.outboxBatch.observe({ result: 'error' }, (Date.now() - started) / 1000);
      this.deps.logger.error(
        { error: error instanceof Error ? error.message : 'dispatch_failed' },
        'outbox batch failed',
      );
      throw error;
    } finally {
      this.running = false;
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    const interval = this.deps.pollIntervalMs ?? 1_000;
    this.timer = setInterval(() => {
      if (this.notifyPending) {
        this.notifyPending = false;
      }
      void this.dispatchOnce().catch(() => undefined);
    }, interval);
    this.timer.unref();
    // NOTIFY is only a hint; failure to LISTEN must not stop the polling loop.
    try {
      if (this.deps.store.listen !== undefined) {
        this.listenRequest = await this.deps.store.listen(() => {
          this.notifyPending = true;
          void this.dispatchOnce().catch(() => undefined);
        });
      }
    } catch (error) {
      this.deps.logger.warn(
        { error: error instanceof Error ? error.message : 'listen_failed' },
        'LISTEN/NOTIFY unavailable; polling only',
      );
    }
    this.deps.logger.info(
      { pollIntervalMs: interval, handlers: this.handlers.size },
      'outbox dispatcher started',
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.listenRequest !== null) {
      try {
        await this.listenRequest.unlisten();
      } catch {
        // ignore
      }
      this.listenRequest = null;
    }
    this.deps.logger.info({ stopped: this.stopped }, 'outbox dispatcher stopped');
  }
}
