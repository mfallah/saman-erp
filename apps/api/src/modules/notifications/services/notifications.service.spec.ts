import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SilentLogger } from '../infrastructure/logger';
import { InMemoryKeyValueStore } from '../infrastructure/key-value';
import {
  renderTemplate,
  resolvePreference,
  extractTemplateVariables,
} from '../domain/notification.policy';
import { NotificationsService } from './notifications.service';
import type {
  NotificationRecord,
  NotificationRepositoryPort,
  NotificationRow,
  NotificationTemplateRow,
} from '../repositories/notification.repository';
import type { QuietHours } from '../domain/notification.policy';

class FakeNotificationRepository implements NotificationRepositoryPort {
  rows: NotificationRow[] = [];
  prefs: { eventType: string; channel: string; enabled: boolean; quietHours: QuietHours | null }[] = [];
  private sequence = 0;

  async insert(record: NotificationRecord): Promise<string> {
    this.sequence += 1;
    const id = String(this.sequence);
    this.rows.push({
      id,
      eventType: record.eventType,
      title: record.title,
      body: record.body,
      data: record.data,
      channel: record.channel,
      priority: record.priority,
      readAt: null,
      dismissedAt: null,
      createdAt: new Date('2026-10-20T10:00:00Z'),
    });
    return id;
  }
  async list(input: { userId: string; unreadOnly: boolean; limit: number }): Promise<readonly NotificationRow[]> {
    return this.rows.filter((row) => !input.unreadOnly || row.readAt === null).slice(0, input.limit);
  }
  async findById(_userId: string, id: string): Promise<NotificationRow | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }
  async markRead(_userId: string, id: string): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row === undefined) return false;
    this.rows = this.rows.map((candidate) =>
      candidate.id === id ? { ...candidate, readAt: new Date('2026-10-20T11:00:00Z') } : candidate,
    );
    return true;
  }
  async markAllRead(): Promise<number> {
    return 0;
  }
  async dismiss(_userId: string, id: string): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row === undefined) return false;
    this.rows = this.rows.map((candidate) =>
      candidate.id === id ? { ...candidate, dismissedAt: new Date() } : candidate,
    );
    return true;
  }
  async preferences(): Promise<typeof this.prefs> {
    return this.prefs;
  }
  async upsertPreference(input: {
    userId: string;
    eventType: string;
    channel: string;
    enabled: boolean;
    quietHours?: QuietHours | null;
  }): Promise<void> {
    this.prefs = this.prefs.filter(
      (row) => !(row.eventType === input.eventType && row.channel === input.channel),
    );
    this.prefs.push({
      eventType: input.eventType,
      channel: input.channel,
      enabled: input.enabled,
      quietHours: input.quietHours ?? null,
    });
  }
  async findTemplate(): Promise<NotificationTemplateRow | null> {
    return null;
  }
  async listTemplates(): Promise<readonly NotificationTemplateRow[]> {
    return [];
  }
  async upsertTemplate(): Promise<NotificationTemplateRow> {
    throw new Error('unused');
  }
  async deleteTemplate(): Promise<void> {}
}

describe('notification policy', () => {
  it('renders Persian templates and fails closed on missing variables', () => {
    assert.equal(
      renderTemplate('سفارش {{orderNo}} برای {{customer}} ثبت شد.', {
        orderNo: 'S-100',
        customer: 'سارا',
      }),
      'سفارش S-100 برای سارا ثبت شد.',
    );
    assert.deepEqual(extractTemplateVariables('{{a}} {{b}} {{a}}'), ['a', 'b']);
    assert.throws(() => renderTemplate('سلام {{missing}}', {}));
  });

  it('suppresses non-critical SMS during quiet hours but keeps the inbox', () => {
    const quiet: QuietHours = { from: '22:00', to: '07:00' };
    const now = new Date('2026-10-20T20:00:00Z'); // 23:30 Asia/Tehran
    const base = {
      preferences: [],
      eventType: 'order.created',
      priority: 'normal' as const,
      quietHours: quiet,
      now,
    };
    assert.deepEqual(resolvePreference({ ...base, channel: 'sms' }), {
      allowed: false,
      reason: 'quiet_hours',
    });
    assert.deepEqual(resolvePreference({ ...base, channel: 'in_app' }), {
      allowed: true,
      reason: 'allowed',
    });
    assert.deepEqual(resolvePreference({ ...base, channel: 'sms', priority: 'critical' }), {
      allowed: true,
      reason: 'allowed',
    });
  });

  it('honours an explicit opt-out', () => {
    const decision = resolvePreference({
      preferences: [{ eventType: 'stock.low', channel: 'sms', enabled: false }],
      eventType: 'stock.low',
      channel: 'sms',
      priority: 'high',
      now: new Date('2026-10-20T08:00:00Z'),
    });
    assert.deepEqual(decision, { allowed: false, reason: 'disabled' });
  });
});

describe('NotificationsService', () => {
  it('dedupes repeated events and tracks delivery/read state', async () => {
    const repository = new FakeNotificationRepository();
    const service = new NotificationsService({
      repository,
      store: new InMemoryKeyValueStore(),
      logger: new SilentLogger(),
    });
    const first = await service.create({
      organizationId: '1',
      userId: '2',
      eventType: 'order.created',
      title: 'سفارش جدید',
      dedupeKey: 'order-1',
    });
    assert.equal(first?.delivered, true);
    const duplicate = await service.create({
      organizationId: '1',
      userId: '2',
      eventType: 'order.created',
      title: 'سفارش جدید',
      dedupeKey: 'order-1',
    });
    assert.equal(duplicate, null);
    assert.equal((await service.list({ userId: '2' })).length, 1);

    const id = first?.id ?? '';
    await service.markRead('2', id);
    const row = await service.get('2', id);
    const status = service.deliveryStatus(row);
    assert.equal(status.state, 'read');
  });

  it('does not create an in-app row when the channel is disabled', async () => {
    const repository = new FakeNotificationRepository();
    repository.prefs = [{ eventType: 'marketing', channel: 'in_app', enabled: false, quietHours: null }];
    const service = new NotificationsService({
      repository,
      store: new InMemoryKeyValueStore(),
      logger: new SilentLogger(),
    });
    const result = await service.create({
      organizationId: '1',
      userId: '2',
      eventType: 'marketing',
      title: 'تخفیف',
    });
    assert.deepEqual(result, { id: '', delivered: false, reason: 'disabled' });
    assert.equal(repository.rows.length, 0);
  });
});
