import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SilentLogger } from '../infrastructure/logger';
import { BusinessRuleSchema, type BusinessRule } from '../domain/rule.types';
import { evaluateRule } from '../domain/rule-evaluator';
import { assessFraud } from '../domain/fraud';
import { AutomationService } from './automation.service';
import type { AutomationRepositoryPort, StoredRuleRow } from '../repositories/automation.repository';

function rule(overrides: Partial<BusinessRule> = {}): BusinessRule {
  return {
    code: 'high-value-new-customer',
    nameFa: 'مشتری جدید با سفارش بزرگ',
    module: 'sales',
    kind: 'fraud',
    priority: 10,
    conditions: {
      all: [
        { field: 'order.grand_total', operator: 'gte', value: 50_000_000 },
        { field: 'customer.order_count_24h', operator: 'lte', value: 1 },
      ],
    },
    actions: [{ type: 'flag_fraud', score: 70, reasonFa: 'سفارش بزرگ از مشتری جدید' }],
    ...overrides,
  };
}

describe('allowlisted rule evaluator', () => {
  it('matches all/any conditions with numeric semantics', () => {
    const result = evaluateRule(rule(), {
      'order.grand_total': 60_000_000,
      'customer.order_count_24h': 1,
    });
    assert.equal(result.matched, true);
    assert.equal(result.actions.length, 1);
  });

  it('uses OR semantics for any and never matches missing facts', () => {
    const anyRule = rule({
      conditions: {
        any: [
          { field: 'order.discount_ratio', operator: 'gt', value: 0.5 },
          { field: 'channel.failure_rate', operator: 'gte', value: 0.2 },
        ],
      },
    });
    assert.equal(evaluateRule(anyRule, { 'channel.failure_rate': 0.25 }).matched, true);
    assert.equal(evaluateRule(anyRule, {}).matched, false);
  });

  it('rejects unknown fields/operators/actions at validation time', () => {
    assert.equal(
      BusinessRuleSchema.safeParse({ ...rule(), conditions: { all: [{ field: 'order.secret', operator: 'gt', value: 1 }] } })
        .success,
      false,
    );
    assert.equal(
      BusinessRuleSchema.safeParse({ ...rule(), actions: [{ type: 'run_sql' }] }).success,
      false,
    );
  });
});

describe('fraud heuristics', () => {
  it('scores velocity and amount anomalies deterministically', () => {
    const assessment = assessFraud({
      orderCount24h: 7,
      orderAmount: 90_000_000,
      meanAmount: 10_000_000,
      stdDevAmount: 5_000_000,
      failedCodCount: 2,
      addressMismatch: true,
      channelFailureRate: 0.05,
      newCustomer: true,
    });
    assert.equal(assessment.severity === 'critical' || assessment.severity === 'high', true);
    const codes = assessment.signals.map((signal) => signal.code);
    assert.equal(codes.includes('velocity_24h'), true);
    assert.equal(codes.includes('amount_anomaly'), true);
    assert.equal(codes.includes('new_customer_high_value'), true);
    assert.equal(assessment.score <= 100, true);
  });

  it('returns a low score for normal activity', () => {
    const assessment = assessFraud({
      orderCount24h: 1,
      orderAmount: 1_000_000,
      meanAmount: 1_000_000,
      stdDevAmount: 100_000,
      failedCodCount: 0,
      addressMismatch: false,
      channelFailureRate: 0,
      newCustomer: false,
    });
    assert.equal(assessment.severity, 'low');
    assert.deepEqual(assessment.signals, []);
  });
});

class FakeAutomationRepository implements AutomationRepositoryPort {
  rules: StoredRuleRow[] = [];
  fraud: { ruleCode: string; score: number }[] = [];
  alerts: string[] = [];

  async listActiveRules(): Promise<readonly StoredRuleRow[]> {
    return this.rules;
  }
  async alertRuleExists(): Promise<boolean> {
    return true;
  }
  async insertAlertEvent(input: { details: Record<string, unknown> }): Promise<void> {
    this.alerts.push(String(input.details['ruleCode'] ?? ''));
  }
  async upsertFraudFlag(input: { ruleCode: string; score: number }): Promise<void> {
    this.fraud.push({ ruleCode: input.ruleCode, score: input.score });
  }
}

describe('AutomationService', () => {
  it('executes valid rules and skips invalid persisted JSON', async () => {
    const repository = new FakeAutomationRepository();
    repository.rules = [
      {
        id: '1',
        code: 'fraud-rule',
        module: 'sales',
        kind: 'fraud',
        priority: 1,
        ruleJson: {
          nameFa: 'قاعده',
          conditions: { all: [{ field: 'order.grand_total', operator: 'gt', value: 1000 }] },
          actions: [{ type: 'flag_fraud', score: 60, reasonFa: 'مبلغ بالا' }],
        },
      },
      {
        id: '2',
        code: 'broken-rule',
        module: 'sales',
        kind: 'fraud',
        priority: 0,
        ruleJson: { conditions: { all: [{ field: 'sql.injection', operator: 'eq', value: 1 }] }, actions: [] },
      },
    ];
    const service = new AutomationService({ repository, logger: new SilentLogger() });
    const result = await service.evaluate({
      organizationId: '1',
      module: 'sales',
      entityType: 'sales_order',
      entityId: '99',
      facts: { 'order.grand_total': 5_000 },
    });
    assert.deepEqual(result, {
      evaluated: 2,
      matched: 1,
      alerts: 0,
      fraudFlags: 1,
      notifications: 0,
    });
    assert.deepEqual(repository.fraud, [{ ruleCode: 'fraud-rule', score: 60 }]);
  });
});
