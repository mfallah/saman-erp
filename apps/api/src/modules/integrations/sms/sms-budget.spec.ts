import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryKeyValueStore } from '../infrastructure/key-value';
import { LimoError } from '../limo/limo.errors';
import { SmsBudgetService } from './sms-budget.service';

describe('SMS daily monetary budget', () => {
  it('exhausts the budget and leaves the spent counter unchanged', async () => {
    const store = new InMemoryKeyValueStore();
    const budget = new SmsBudgetService(store, {
      smsDailyIrr: 1_000,
      voiceDailyIrr: 2_000,
      now: () => new Date('2026-10-20T10:00:00Z'),
    });

    const first = await budget.reserve('7', 800);
    assert.equal(await budget.spent('7'), 800);

    await assert.rejects(
      budget.reserve('7', 300),
      (error: unknown) => error instanceof LimoError && error.code === 'BUDGET_EXHAUSTED',
    );
    assert.equal(await budget.spent('7'), 800);
    assert.equal(await budget.remaining('7'), 200);

    await budget.release(first);
    assert.equal(await budget.spent('7'), 0);
  });

  it('reconciles the reserved estimate with the provider amount', async () => {
    const store = new InMemoryKeyValueStore();
    const budget = new SmsBudgetService(store, {
      smsDailyIrr: 10_000,
      now: () => new Date('2026-10-20T10:00:00Z'),
    });
    const reservation = await budget.reserve('7', 1_500);
    await budget.reconcile(reservation, 2_000);
    assert.equal(await budget.spent('7'), 2_000);
  });

  it('keeps voice and SMS budgets separate', async () => {
    const store = new InMemoryKeyValueStore();
    const budget = new SmsBudgetService(store, {
      smsDailyIrr: 1_000,
      voiceDailyIrr: 5_000,
      now: () => new Date('2026-10-20T10:00:00Z'),
    });
    await budget.reserve('7', 1_000, 'sms');
    await budget.reserve('7', 5_000, 'voice');
    assert.equal(await budget.remaining('7', 'sms'), 0);
    assert.equal(await budget.remaining('7', 'voice'), 0);
    await assert.rejects(
      budget.reserve('7', 1, 'voice'),
      (error: unknown) => error instanceof LimoError && error.code === 'BUDGET_EXHAUSTED',
    );
  });
});
