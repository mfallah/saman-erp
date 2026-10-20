/** Pure, allowlisted rule evaluator. No dynamic property access from input. */
import { NUMERIC_FIELDS, type BusinessRule, type RuleAction, type RuleField, type FactBag } from './rule.types';

export interface EvaluationResult {
  readonly matched: boolean;
  readonly actions: readonly RuleAction[];
  readonly reason?: string;
}

function numeric(value: number | string | boolean | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function compare(
  field: RuleField,
  operator: string,
  rawActual: number | string | boolean | null | undefined,
  expected: unknown,
): boolean {
  if (operator === 'exists') {
    const exists = rawActual !== null && rawActual !== undefined;
    return expected === true ? exists : !exists;
  }
  if (rawActual === null || rawActual === undefined) return false;

  if (Array.isArray(expected)) {
    const actual = String(rawActual);
    const list = expected.map((item) => String(item));
    if (operator === 'between') {
      if (expected.length !== 2) return false;
      const actualNumber = numeric(rawActual);
      const low = numeric(expected[0] as number);
      const high = numeric(expected[1] as number);
      if (actualNumber === null || low === null || high === null) return false;
      return actualNumber >= low && actualNumber <= high;
    }
    if (operator === 'in') return list.includes(actual);
    if (operator === 'not_in') return !list.includes(actual);
    return false;
  }

  if (NUMERIC_FIELDS.has(field)) {
    const actualNumber = numeric(rawActual);
    const expectedNumber = numeric(expected as number | string);
    if (actualNumber === null || expectedNumber === null) return false;
    switch (operator) {
      case 'eq':
        return actualNumber === expectedNumber;
      case 'neq':
        return actualNumber !== expectedNumber;
      case 'gt':
        return actualNumber > expectedNumber;
      case 'gte':
        return actualNumber >= expectedNumber;
      case 'lt':
        return actualNumber < expectedNumber;
      case 'lte':
        return actualNumber <= expectedNumber;
      default:
        return false;
    }
  }

  const actual = String(rawActual);
  const expectedText = String(expected);
  switch (operator) {
    case 'eq':
      return actual === expectedText;
    case 'neq':
      return actual !== expectedText;
    default:
      return false;
  }
}

export function evaluateCondition(
  condition: { field: RuleField; operator: string; value: unknown },
  facts: FactBag,
): boolean {
  const actual = facts[condition.field];
  return compare(condition.field, condition.operator, actual, condition.value);
}

export function evaluateRule(rule: BusinessRule, facts: FactBag): EvaluationResult {
  const all = rule.conditions.all ?? [];
  const any = rule.conditions.any ?? [];
  const allMatched = all.every((condition) => evaluateCondition(condition, facts));
  const anyMatched = any.length === 0 || any.some((condition) => evaluateCondition(condition, facts));
  const matched = allMatched && anyMatched;
  return matched
    ? { matched: true, actions: rule.actions }
    : { matched: false, actions: [], reason: 'conditions_not_met' };
}

/** Validates persisted JSON; callers log-and-skip invalid rows. */
export function evaluateRules(
  rules: readonly BusinessRule[],
  facts: FactBag,
): readonly { rule: BusinessRule; actions: readonly RuleAction[] }[] {
  const results: { rule: BusinessRule; actions: readonly RuleAction[] }[] = [];
  for (const rule of rules) {
    const evaluation = evaluateRule(rule, facts);
    if (evaluation.matched) results.push({ rule, actions: evaluation.actions });
  }
  return results;
}
