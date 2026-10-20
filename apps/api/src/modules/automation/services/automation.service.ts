/**
 * Business rules + alerts + fraud flags. Rules are validated JSON DSL; invalid
 * persisted rows are logged and skipped, never executed.
 */
import { BusinessRuleSchema, type FactBag, type RuleAction } from '../domain/rule.types';
import { evaluateRule } from '../domain/rule-evaluator';
import type { AutomationRepositoryPort } from '../repositories/automation.repository';
import type { Logger } from '../infrastructure/logger';
import type { FraudAssessment, FraudInput } from '../domain/fraud';

export interface AutomationNotificationPort {
  create(input: {
    organizationId: string;
    userId: string;
    eventType: string;
    title: string;
    body?: string;
    channel?: 'in_app' | 'email' | 'sms' | 'push';
    data?: Record<string, unknown>;
  }): Promise<{ id: string; delivered: boolean; reason: string } | null>;
}

export const AUTOMATION_NOTIFIER = Symbol.for('saman.automation-notifier');

export interface RuleExecutionResult {
  readonly evaluated: number;
  readonly matched: number;
  readonly alerts: number;
  readonly fraudFlags: number;
  readonly notifications: number;
}

export class AutomationService {
  constructor(
    private readonly deps: {
      readonly repository: AutomationRepositoryPort;
      readonly logger: Logger;
      readonly notifier?: AutomationNotificationPort;
    },
  ) {}

  async evaluate(input: {
    organizationId: string;
    module: string;
    entityType: string;
    entityId: string;
    facts: FactBag;
    metricValue?: number;
  }): Promise<RuleExecutionResult> {
    const rows = await this.deps.repository.listActiveRules(input.organizationId, input.module);
    let matched = 0;
    let alerts = 0;
    let fraudFlags = 0;
    let notifications = 0;

    for (const row of rows) {
      const parsed = BusinessRuleSchema.safeParse({
        code: row.code,
        nameFa: typeof row.ruleJson['nameFa'] === 'string' ? row.ruleJson['nameFa'] : row.code,
        module: row.module,
        kind: row.kind,
        priority: row.priority,
        conditions: row.ruleJson['conditions'],
        actions: row.ruleJson['actions'],
      });
      if (!parsed.success) {
        this.deps.logger.error(
          { ruleCode: row.code, issues: parsed.error.issues.length },
          'invalid automation rule skipped',
        );
        continue;
      }
      const evaluation = evaluateRule(parsed.data, input.facts);
      if (!evaluation.matched) continue;
      matched += 1;
      for (const action of evaluation.actions) {
        const applied = await this.applyAction(row.code, action, input);
        alerts += applied.alert ? 1 : 0;
        fraudFlags += applied.fraud ? 1 : 0;
        notifications += applied.notification ? 1 : 0;
      }
    }

    return { evaluated: rows.length, matched, alerts, fraudFlags, notifications };
  }

  private async applyAction(
    ruleCode: string,
    action: RuleAction,
    input: {
      organizationId: string;
      entityType: string;
      entityId: string;
      facts: FactBag;
      metricValue?: number;
    },
  ): Promise<{ alert: boolean; fraud: boolean; notification: boolean }> {
    switch (action.type) {
      case 'create_alert': {
        const exists = await this.deps.repository.alertRuleExists(
          input.organizationId,
          action.alertRuleId,
        );
        if (!exists) {
          this.deps.logger.warn(
            { ruleCode, alertRuleId: action.alertRuleId },
            'alert rule missing; action skipped',
          );
          return { alert: false, fraud: false, notification: false };
        }
        await this.deps.repository.insertAlertEvent({
          alertRuleId: action.alertRuleId,
          entityType: input.entityType,
          entityId: input.entityId,
          metricValue: input.metricValue ?? 0,
          severity: action.severity,
          details: { ruleCode, messageFa: action.messageFa, facts: input.facts },
        });
        return { alert: true, fraud: false, notification: false };
      }
      case 'flag_fraud': {
        await this.deps.repository.upsertFraudFlag({
          organizationId: input.organizationId,
          entityType: input.entityType,
          entityId: input.entityId,
          ruleCode,
          severity:
            action.score >= 80
              ? 'critical'
              : action.score >= 60
                ? 'high'
                : action.score >= 35
                  ? 'medium'
                  : 'low',
          score: action.score,
          details: { reasonFa: action.reasonFa, facts: input.facts },
        });
        return { alert: false, fraud: true, notification: false };
      }
      case 'notify': {
        if (this.deps.notifier === undefined || action.userId === undefined) {
          this.deps.logger.info({ ruleCode }, 'notify action skipped (no target/notifier)');
          return { alert: false, fraud: false, notification: false };
        }
        await this.deps.notifier.create({
          organizationId: input.organizationId,
          userId: action.userId,
          eventType: action.eventType,
          title: action.titleFa,
          channel: action.channel,
          data: { ruleCode, entityType: input.entityType, entityId: input.entityId },
        });
        return { alert: false, fraud: false, notification: true };
      }
    }
  }

  /** Persists each explainable heuristic signal as its own reviewable flag. */
  async recordFraudAssessment(input: {
    organizationId: string;
    entityType: 'sales_order' | 'customer' | 'payment' | 'cheque' | 'channel_account' | 'refund';
    entityId: string;
    assessment: FraudAssessment;
    input: FraudInput;
  }): Promise<number> {
    let written = 0;
    for (const signal of input.assessment.signals) {
      await this.deps.repository.upsertFraudFlag({
        organizationId: input.organizationId,
        entityType: input.entityType,
        entityId: input.entityId,
        ruleCode: `fraud.${signal.code}`,
        severity: input.assessment.severity,
        score: signal.score,
        details: {
          reasonFa: signal.reasonFa,
          assessmentScore: input.assessment.score,
          evidence: input.input,
        },
      });
      written += 1;
    }
    return written;
  }
}
