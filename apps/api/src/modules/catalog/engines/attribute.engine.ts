/**
 * Category/variant attribute schema validation (`DATA-MODEL` §2.4
 * `catalog.product_attributes`, `category_attributes`, `product_variant_attributes`).
 *
 * A category defines which attributes are relevant and which are variant axes
 * (size/color). Variants carry a value per axis plus optional descriptive
 * attributes. Validation is pure and returns structured errors, so the service
 * can map them to `VALIDATION_ERROR` details and the product form can pre-check
 * the same rules client-side.
 */
import { AppError } from '@saman/shared';

export const ATTRIBUTE_DATA_TYPES = ['text', 'number', 'boolean', 'enum', 'date', 'color'] as const;
export type AttributeDataType = (typeof ATTRIBUTE_DATA_TYPES)[number];

export interface AttributeDefinition {
  readonly id: string;
  readonly code: string;
  readonly name?: string;
  readonly dataType: AttributeDataType;
  readonly isRequired: boolean;
  readonly isVariantAxis: boolean;
  /** Allowed values for `enum` attributes. */
  readonly values?: readonly { readonly id: string; readonly value: string }[];
}

export interface AttributeValueInput {
  readonly attributeId: string;
  readonly valueId?: string | null;
  readonly rawValue?: string | null;
}

export interface NormalizedAttributeValue {
  readonly attributeId: string;
  readonly valueId: string | null;
  readonly rawValue: string | null;
}

export interface AttributeValidationIssue {
  readonly attributeId: string;
  readonly code: string;
  readonly rule:
    | 'unknown_attribute'
    | 'duplicate_attribute'
    | 'required_attribute_missing'
    | 'value_not_allowed'
    | 'invalid_number'
    | 'invalid_boolean'
    | 'invalid_date'
    | 'invalid_color'
    | 'raw_value_required'
    | 'variant_axis_missing';
}

export interface AttributeValidationResult {
  readonly values: readonly NormalizedAttributeValue[];
  readonly issues: readonly AttributeValidationIssue[];
  /** Stable signature of the variant axis combination (uniqueness within product). */
  readonly axisSignature: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const NUMBER_PATTERN = /^-?\d+(?:\.\d{1,6})?$/;

/**
 * Validates supplied attribute values against the category-attribute schema.
 *
 * - every required attribute must be present;
 * - enum values must reference an allowed value id;
 * - typed attributes must carry a well-formed raw value;
 * - variant axes participate in the axis signature used for uniqueness.
 */
export function validateAttributeValues(
  definitions: readonly AttributeDefinition[],
  inputs: readonly AttributeValueInput[],
): AttributeValidationResult {
  const defsById = new Map(definitions.map((definition) => [definition.id, definition]));
  const issues: AttributeValidationIssue[] = [];
  const normalized: NormalizedAttributeValue[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const definition = defsById.get(input.attributeId);
    if (definition === undefined) {
      issues.push({
        attributeId: input.attributeId,
        code: input.attributeId,
        rule: 'unknown_attribute',
      });
      continue;
    }
    if (seen.has(definition.id)) {
      issues.push({ attributeId: definition.id, code: definition.code, rule: 'duplicate_attribute' });
      continue;
    }
    seen.add(definition.id);

    const valueId = input.valueId ?? null;
    const rawValue = input.rawValue === null || input.rawValue === undefined ? null : input.rawValue.trim();

    if (definition.dataType === 'enum') {
      const allowed = definition.values ?? [];
      if (valueId === null || !allowed.some((value) => value.id === valueId)) {
        issues.push({ attributeId: definition.id, code: definition.code, rule: 'value_not_allowed' });
        continue;
      }
    } else if (valueId !== null) {
      // Non-enum attributes never carry a value id.
      issues.push({ attributeId: definition.id, code: definition.code, rule: 'raw_value_required' });
      continue;
    } else if (definition.dataType === 'boolean') {
      if (rawValue === null || !/^(true|false|0|1)$/.test(rawValue)) {
        issues.push({ attributeId: definition.id, code: definition.code, rule: 'invalid_boolean' });
        continue;
      }
    } else if (definition.dataType === 'number') {
      if (rawValue === null || !NUMBER_PATTERN.test(rawValue)) {
        issues.push({ attributeId: definition.id, code: definition.code, rule: 'invalid_number' });
        continue;
      }
    } else if (definition.dataType === 'date') {
      if (rawValue === null || !DATE_PATTERN.test(rawValue) || Number.isNaN(Date.parse(rawValue))) {
        issues.push({ attributeId: definition.id, code: definition.code, rule: 'invalid_date' });
        continue;
      }
    } else if (definition.dataType === 'color') {
      if (rawValue === null || !COLOR_PATTERN.test(rawValue)) {
        issues.push({ attributeId: definition.id, code: definition.code, rule: 'invalid_color' });
        continue;
      }
    } else if (definition.dataType === 'text' && rawValue === null) {
      issues.push({ attributeId: definition.id, code: definition.code, rule: 'raw_value_required' });
      continue;
    }

    normalized.push({ attributeId: definition.id, valueId, rawValue });
  }

  for (const definition of definitions) {
    if (!definition.isRequired) continue;
    if (!seen.has(definition.id)) {
      issues.push({
        attributeId: definition.id,
        code: definition.code,
        rule: 'required_attribute_missing',
      });
    }
  }

  const axisSignature = buildAxisSignature(definitions, normalized);

  return { values: normalized, issues, axisSignature };
}

/**
 * Signature of the variant-axis combination: sorted `attributeId=valueId|raw`
 * tuples. Two variants of one product may not share a signature.
 */
export function buildAxisSignature(
  definitions: readonly AttributeDefinition[],
  values: readonly NormalizedAttributeValue[],
): string {
  const axisIds = new Set(
    definitions.filter((definition) => definition.isVariantAxis).map((definition) => definition.id),
  );
  return values
    .filter((value) => axisIds.has(value.attributeId))
    .map((value) => `${value.attributeId}=${value.valueId ?? value.rawValue ?? ''}`)
    .sort()
    .join('|');
}

/** Throws `VALIDATION_ERROR` carrying every issue when validation fails. */
export function assertAttributeValues(
  definitions: readonly AttributeDefinition[],
  inputs: readonly AttributeValueInput[],
): NormalizedAttributeValue[] {
  const result = validateAttributeValues(definitions, inputs);
  if (result.issues.length > 0) {
    throw new AppError('VALIDATION_ERROR', {
      details: result.issues.map((issue) => ({
        field: `attributes.${issue.code}`,
        rule: issue.rule,
        params: { attributeId: issue.attributeId },
      })),
    });
  }
  return [...result.values];
}

/**
 * Ensures variant axis combinations stay unique inside a product. `existing`
 * holds the signatures already used by sibling variants.
 */
export function assertUniqueAxisSignature(signature: string, existing: ReadonlySet<string>): void {
  if (signature === '') return;
  if (existing.has(signature)) {
    throw new AppError('CONFLICT', {
      message: 'تنوعی با همین ترکیب ویژگی‌ها برای این کالا ثبت شده است.',
      messageKey: 'catalog.variant_combination_conflict',
      details: [{ rule: 'variant_combination_conflict' }],
    });
  }
}
