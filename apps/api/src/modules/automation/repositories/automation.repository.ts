/** Automation persistence: rules, alert events, fraud flags. */
import type { Db } from '../../../common/contracts';
import { asNumber, asString } from './automation.sql';
import type { BusinessRule } from '../domain/rule.types';

export interface StoredRuleRow {
  readonly id: string;
  readonly code: string;
  readonly module: string;
  readonly kind: string;
  readonly priority: number;
  readonly ruleJson: Record<string, unknown>;
}

export interface AutomationRepositoryPort {
  listActiveRules(organizationId: string, module: string): Promise<readonly StoredRuleRow[]>;
  alertRuleExists(organizationId: string, alertRuleId: string): Promise<boolean>;
  insertAlertEvent(input: {
    alertRuleId: string;
    entityType: string;
    entityId: string;
    metricValue: number;
    severity: 'info' | 'warning' | 'critical';
    details: Record<string, unknown>;
  }): Promise<void>;
  upsertFraudFlag(input: {
    organizationId: string;
    entityType: string;
    entityId: string;
    ruleCode: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    score: number;
    details: Record<string, unknown>;
  }): Promise<void>;
}

export class SqlAutomationRepository implements AutomationRepositoryPort {
  constructor(private readonly db: Db) {}

  async listActiveRules(
    organizationId: string,
    module: string,
  ): Promise<readonly StoredRuleRow[]> {
    const rows = await this.db<
      {
        id: unknown;
        code: unknown;
        module: unknown;
        rule_kind: unknown;
        priority: unknown;
        rule_json: unknown;
      }[]
    >`
      select id, code, module, rule_kind, priority, rule_json
      from erp.business_rules
      where organization_id = ${organizationId}::bigint
        and module = ${module}
        and is_active = true
        and (effective_from is null or effective_from <= now())
        and (effective_to is null or effective_to > now())
      order by priority desc, id`;
    return rows.map((row) => ({
      id: asString(row.id),
      code: asString(row.code),
      module: asString(row.module),
      kind: asString(row.rule_kind),
      priority: asNumber(row.priority),
      ruleJson:
        typeof row.rule_json === 'object' && row.rule_json !== null
          ? (row.rule_json as Record<string, unknown>)
          : {},
    }));
  }

  async alertRuleExists(organizationId: string, alertRuleId: string): Promise<boolean> {
    const rows = await this.db<{ id: string }[]>`
      select id::text from erp.alert_rules
      where organization_id = ${organizationId}::bigint
        and id = ${alertRuleId}::bigint
        and is_active = true`;
    return rows.length > 0;
  }

  async insertAlertEvent(input: {
    alertRuleId: string;
    entityType: string;
    entityId: string;
    metricValue: number;
    severity: 'info' | 'warning' | 'critical';
    details: Record<string, unknown>;
  }): Promise<void> {
    await this.db`
      insert into erp.alert_events (
        alert_rule_id, entity_type, entity_id, metric_value, severity, status, details
      ) values (
        ${input.alertRuleId}::bigint, ${input.entityType}, ${input.entityId}::bigint,
        ${input.metricValue}, ${input.severity}, 'firing',
        ${JSON.stringify(input.details)}::jsonb
      )`;
  }

  async upsertFraudFlag(input: {
    organizationId: string;
    entityType: string;
    entityId: string;
    ruleCode: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    score: number;
    details: Record<string, unknown>;
  }): Promise<void> {
    await this.db`
      insert into erp.fraud_flags (
        organization_id, entity_type, entity_id, rule_code, severity, score, status, details
      ) values (
        ${input.organizationId}::bigint, ${input.entityType}, ${input.entityId}::bigint,
        ${input.ruleCode}, ${input.severity}, ${input.score}, 'open',
        ${JSON.stringify(input.details)}::jsonb
      )
      on conflict (entity_type, entity_id, rule_code) do update set
          severity = excluded.severity,
          score = greatest(erp.fraud_flags.score, excluded.score),
          details = excluded.details`;
  }
}

export { type BusinessRule };
