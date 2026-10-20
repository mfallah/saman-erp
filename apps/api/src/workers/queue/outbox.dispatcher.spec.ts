import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { SilentLogger } from '../../modules/channels/ports/logger.port';
import { IntegrationError } from '../../modules/channels/domain/channel.types';
import { OutboxDispatcher, type OutboxHandler } from '../queue/outbox.dispatcher';
import type { OutboxEventRow, OutboxStorePort } from '../queue/outbox.store';

type FakeEvent = { -readonly [K in keyof OutboxEventRow]: OutboxEventRow[K] } & {
  status: 'pending' | 'processed' | 'failed' | 'dead';
};

class FakeOutboxStore implements OutboxStorePort {
  readonly events: FakeEvent[] = [];
  readonly deadLetters: { id: string; attempts: number; error: string }[] = [];
  failures: { id: string; next: Date; error: string }[] = [];

  async claimBatch(limit: number): Promise<readonly OutboxEventRow[]> {
    const claimable = this.events
      .filter((event) => event.status === 'pending' || event.status === 'failed')
      .slice(0, limit);
    return claimable.map((event) => {
      const attempts = event.attempts + 1;
      event.attempts = attempts;
      return { ...event, attempts };
    });
  }

  async markProcessed(id: string): Promise<void> {
    const event = this.events.find((candidate) => candidate.id === id);
    if (event !== undefined) event.status = 'processed';
  }

  async markFailed(id: string, next: Date, error: string): Promise<void> {
    const event = this.events.find((candidate) => candidate.id === id);
    if (event !== undefined) event.status = 'failed';
    this.failures.push({ id, next, error });
  }

  async deadLetter(event: OutboxEventRow, error: string): Promise<void> {
    const stored = this.events.find((candidate) => candidate.id === event.id);
    if (stored !== undefined) stored.status = 'dead';
    this.deadLetters.push({ id: event.id, attempts: event.attempts, error });
  }

  async oldestLagSeconds(): Promise<number> {
    return 0;
  }
  async notifyChannel(): Promise<void> {}
}

function seed(store: FakeOutboxStore, input: Partial<FakeEvent> = {}): FakeEvent {
  const event: FakeEvent = {
    id: '1',
    organizationId: '1',
    eventType: 'test.event',
    eventVersion: 1,
    aggregateType: 'test',
    aggregateId: '1',
    payload: { value: 1 },
    attempts: 0,
    maxAttempts: 2,
    availableAt: new Date('2026-10-20T10:00:00Z'),
    status: 'pending',
    ...input,
  };
  store.events.push(event);
  return event;
}

function dispatcher(store: FakeOutboxStore, handler: OutboxHandler): OutboxDispatcher {
  const instance = new OutboxDispatcher({
    store,
    logger: new SilentLogger(),
    workerId: 'test',
    now: () => new Date('2026-10-20T10:00:00Z'),
    random: () => 0,
  });
  instance.register(handler);
  return instance;
}

const successHandler: OutboxHandler = {
  eventType: 'test.event',
  schema: z.object({ value: z.number() }),
  async handle() {},
};

describe('OutboxDispatcher retry → DLQ', () => {
  it('retries with backoff, then dead-letters after max attempts', async () => {
    const store = new FakeOutboxStore();
    const event = seed(store);
    const failing: OutboxHandler = {
      eventType: 'test.event',
      schema: z.object({ value: z.number() }),
      async handle() {
        throw new IntegrationError('UPSTREAM_UNAVAILABLE', {
          messageFa: 'موقتاً در دسترس نیست.',
          retryable: true,
        });
      },
    };
    const worker = dispatcher(store, failing);

    const first = await worker.dispatchOnce();
    assert.equal(first.retried, 1);
    assert.equal(first.dead, 0);
    assert.equal(store.deadLetters.length, 0);
    assert.equal(store.failures.length, 1);
    assert.equal(event.status, 'failed');
    assert.equal(event.attempts, 1);

    const second = await worker.dispatchOnce();
    assert.equal(second.dead, 1);
    assert.equal(store.deadLetters.length, 1);
    assert.equal(store.deadLetters[0]?.attempts, 2);
    assert.equal(event.status, 'dead');
  });

  it('dead-letters non-retryable errors immediately', async () => {
    const store = new FakeOutboxStore();
    const event = seed(store, { maxAttempts: 10 });
    const handler: OutboxHandler = {
      eventType: 'test.event',
      schema: z.object({ value: z.number() }),
      async handle() {
        throw new IntegrationError('VALIDATION_ERROR', {
          messageFa: 'داده معتبر نیست.',
          retryable: false,
        });
      },
    };
    const result = await dispatcher(store, handler).dispatchOnce();
    assert.equal(result.dead, 1);
    assert.equal(result.retried, 0);
    assert.equal(event.attempts, 1);
    assert.equal(store.deadLetters.length, 1);
  });

  it('dead-letters invalid payloads without invoking the handler', async () => {
    const store = new FakeOutboxStore();
    const event = seed(store, { payload: { wrong: true } });
    let called = 0;
    const handler: OutboxHandler = {
      eventType: 'test.event',
      schema: z.object({ value: z.number() }),
      async handle() {
        called += 1;
      },
    };
    const result = await dispatcher(store, handler).dispatchOnce();
    assert.equal(called, 0);
    assert.equal(result.dead, 1);
    assert.equal(store.deadLetters[0]?.error, 'invalid_event_payload');
    assert.equal(event.status, 'dead');
  });

  it('marks successful and unknown events processed (never loops)', async () => {
    const store = new FakeOutboxStore();
    const success = seed(store, { id: '1' });
    const unknown = seed(store, { id: '2', eventType: 'unknown.event' });
    const result = await dispatcher(store, successHandler).dispatchOnce();
    assert.equal(result.processed, 1);
    assert.equal(result.ignored, 1);
    assert.equal(success.status, 'processed');
    assert.equal(unknown.status, 'processed');
  });
});
