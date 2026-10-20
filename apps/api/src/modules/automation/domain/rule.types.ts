/**
 * Allowlisted business-rule DSL (no arbitrary code execution).
 *
 * Fields, operators and actions are closed sets validated with Zod; unknown
 * keys fail at write time and are skipped (logged) at evaluation time.
 */
import { z } from 'zod';

export const RULE_FIELDS = [
  'order.grand_total',
  'order.item_count',
  'order.discount_ratio',
  'customer.order_count_24h',
  'customer.failed_cod_count',
  'inventory.available',
  'channel.failure_rate',
  'payment.failed_attempts',
] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

export const NUMERIC_FIELDS: ReadonlySet<RuleField> = new Set(RULE_FIELDS);

export const RULE_OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not_in',
  'between',
  'exists',
] as const;

export const RULE_KINDS = [
  'validation',
  'pricing_guard',
  'allocation',
  'reorder',
  'discount_eligibility',
  'fraud',
  'customer_segment',
] as const;

export const RULE_MODULES = [
  'sales',
  'inventory',
  'pricing',
  'channels',
  'accounting',
  'fulfillment',
] as const;

const ConditionSchema = z
  .object({
    field: z.enum(RULE_FIELDS),
    operator: z.enum(RULE_OPERATORS),
    value: z.union([
      z.number(),
      z.string(),
      z.boolean(),
      z.array(z.union([z.number(), z.string()])),
      z.tuple([z.number(), z.number()]),
    ]),
  })
  .superRefine((condition, ctx) => {
    if (condition.operator === 'between') {
      if (!Array.isArray(condition.value) || condition.value.length !== 2) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'between_requires_pair' });
      }
    }
    if (condition.operator === 'in' || condition.operator === 'not_in') {
      if (!Array.isArray(condition.value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'requires_list' });
      }
    }
    if (condition.operator === 'exists' && typeof condition.value !== 'boolean') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'exists_requires_boolean' });
    }
  });

const ConditionsSchema = z
  .object({
    all: z.array(ConditionSchema).min(1).optional(),
    any: z.array(ConditionSchema).min(1).optional(),
  })
  .refine((value) => (value.all?.length ?? 0) + (value.any?.length ?? 0) > 0, {
    message: 'conditions_required',
  });

const AlertActionSchema = z.object({
  type: z.literal('create_alert'),
  alertRuleId: z.string().regex(/^\d+$/),
  severity: z.enum(['info', 'warning', 'critical']),
  messageFa: z.string().min(1).max(500),
});

const FraudActionSchema = z.object({
  type: z.literal('flag_fraud'),
  score: z.number().min(0).max(100),
  reasonFa: z.string().min(1).max(500),
});

const NotifyActionSchema = z.object({
  type: z.literal('notify'),
  eventType: z.string().min(1).max(80),
  titleFa: z.string().min(1).max(250),
  userId: z.string().regex(/^\d+$/).optional(),
  channel: z.enum(['in_app', 'email', 'sms', 'push']).default('in_app'),
});

export const RuleActionSchema = z.discriminatedUnion('type', [
  AlertActionSchema,
  FraudActionSchema,
  NotifyActionSchema,
]);
export type RuleAction = z.infer<typeof RuleActionSchema>;

export const BusinessRuleSchema = z.object({
  code: z.string().min(1).max(100),
  nameFa: z.string().min(1).max(200),
  module: z.enum(RULE_MODULES),
  kind: z.enum(RULE_KINDS),
  priority: z.number().int().default(0),
  conditions: ConditionsSchema,
  actions: z.array(RuleActionSchema).min(1).max(10),
});
export type BusinessRule = z.infer<typeof BusinessRuleSchema>;

export interface RuleFact {
  readonly field: RuleField;
  readonly value: number | string | boolean | null;
}

export type FactBag = Partial<Record<RuleField, number | string | boolean | null>>;
