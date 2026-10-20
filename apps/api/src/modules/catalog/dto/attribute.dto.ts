/**
 * Attribute definition contracts (`API.md` §4.3 attributes, `DATA-MODEL` §2.4
 * `catalog.product_attributes` / `product_attribute_values`).
 */
import { z } from 'zod';

import { AttributeDataType, BooleanQuery, CatalogListBase, PublicId } from './common';

export const AttributeValueDefinitionInput = z.object({
  id: PublicId.optional(),
  valueFa: z.string().trim().min(1).max(250),
  valueEn: z.string().trim().max(250).optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});
export type AttributeValueDefinitionInput = z.infer<typeof AttributeValueDefinitionInput>;

export const CreateAttributeBody = z
  .object({
    nameFa: z.string().trim().min(1).max(150),
    nameEn: z.string().trim().max(150).optional(),
    code: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, { message: 'invalid_attribute_code' }),
    type: AttributeDataType,
    isVariant: z.boolean(),
    isRequired: z.boolean().default(false),
    isFilterable: z.boolean().default(false),
    categoryIds: z.array(PublicId).max(200).optional(),
    values: z.array(AttributeValueDefinitionInput).max(500).optional(),
    unitId: PublicId.nullish(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
  })
  .refine((body) => body.type !== 'enum' || (body.values?.length ?? 0) > 0, {
    message: 'enum_attribute_requires_values',
    path: ['values'],
  });
export type CreateAttributeBody = z.infer<typeof CreateAttributeBody>;

export const UpdateAttributeBody = z
  .object({
    nameFa: z.string().trim().min(1).max(150).optional(),
    type: AttributeDataType.optional(),
    isRequired: z.boolean().optional(),
    isFilterable: z.boolean().optional(),
    categoryIds: z.array(PublicId).max(200).optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'empty_update' });
export type UpdateAttributeBody = z.infer<typeof UpdateAttributeBody>;

export const ReplaceAttributeValuesBody = z.object({
  values: z.array(AttributeValueDefinitionInput).max(500),
});
export type ReplaceAttributeValuesBody = z.infer<typeof ReplaceAttributeValuesBody>;

export const UpdateAttributeValueBody = z
  .object({
    valueFa: z.string().trim().min(1).max(250).optional(),
    valueEn: z.string().trim().max(250).optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'empty_update' });
export type UpdateAttributeValueBody = z.infer<typeof UpdateAttributeValueBody>;

export const AttributeListQuery = CatalogListBase.extend({
  categoryId: PublicId.optional(),
  type: AttributeDataType.optional(),
  isVariant: BooleanQuery.optional(),
  q: z.string().trim().min(2).max(100).optional(),
});
export type AttributeListQuery = z.infer<typeof AttributeListQuery>;

/** `PUT /variants/{id}/attributes` value input. */
export const VariantAttributeValueInput = z
  .object({
    attributeId: PublicId,
    valueId: PublicId.nullish(),
    rawValue: z.string().trim().max(500).nullish(),
  })
  .refine((value) => value.valueId != null || value.rawValue != null, {
    message: 'attribute_value_required',
  });
export type VariantAttributeValueInput = z.infer<typeof VariantAttributeValueInput>;

export const ReplaceVariantAttributesBody = z.object({
  values: z.array(VariantAttributeValueInput).max(200),
});
export type ReplaceVariantAttributesBody = z.infer<typeof ReplaceVariantAttributesBody>;
