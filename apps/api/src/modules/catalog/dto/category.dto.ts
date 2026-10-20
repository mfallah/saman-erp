/**
 * Category & brand request contracts (`API.md` §4.3).
 * Field names follow the API contract (camelCase); the repository maps them to
 * the `catalog.product_categories` / `catalog.brands` columns.
 */
import { z } from 'zod';

import { BooleanQuery, CatalogListBase, EntityStatus, ProductStatus, PublicId } from './common';

const CategoryName = z.string().trim().min(2).max(200);
const CategoryCode = z
  .string()
  .trim()
  .min(2)
  .max(50)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, { message: 'invalid_category_code' });

export const CategoryIdInput = z.object({ categoryId: PublicId });

export const CategoryAttributeLink = z.object({
  attributeId: PublicId,
  isRequired: z.boolean().optional(),
  isVariantAxis: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

export const CreateCategoryBody = z.object({
  nameFa: CategoryName,
  nameEn: z.string().trim().max(200).optional(),
  parentId: PublicId.nullish(),
  code: CategoryCode,
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  imageFileId: PublicId.nullish(),
  attributes: z.array(CategoryAttributeLink).max(200).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
export type CreateCategoryBody = z.infer<typeof CreateCategoryBody>;

export const UpdateCategoryBody = z
  .object({
    nameFa: CategoryName.optional(),
    nameEn: z.string().trim().max(200).optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
    imageFileId: PublicId.nullish(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'empty_update' });
export type UpdateCategoryBody = z.infer<typeof UpdateCategoryBody>;

export const MoveCategoryBody = z.object({ parentId: PublicId.nullish() });
export type MoveCategoryBody = z.infer<typeof MoveCategoryBody>;

export const BulkUpdateCategoriesBody = z.object({
  items: z
    .array(
      z.object({
        id: PublicId,
        nameFa: CategoryName.optional(),
        nameEn: z.string().trim().max(200).optional(),
        sortOrder: z.number().int().min(0).max(100_000).optional(),
        status: z.enum(['active', 'inactive']).optional(),
      }),
    )
    .min(1)
    .max(100),
});
export type BulkUpdateCategoriesBody = z.infer<typeof BulkUpdateCategoriesBody>;

export const CategoryListQuery = CatalogListBase.extend({
  parentId: PublicId.optional(),
  status: EntityStatus.optional(),
  channelId: PublicId.optional(),
  tree: BooleanQuery.optional(),
  q: z.string().trim().min(2).max(100).optional(),
});
export type CategoryListQuery = z.infer<typeof CategoryListQuery>;

const BrandName = z.string().trim().min(1).max(200);

export const CreateBrandBody = z.object({
  nameFa: BrandName,
  nameEn: z.string().trim().max(200).optional(),
  logoFileId: PublicId.nullish(),
  externalCodes: z.record(z.string().max(120)).optional(),
  country: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
export type CreateBrandBody = z.infer<typeof CreateBrandBody>;

export const UpdateBrandBody = z
  .object({
    nameFa: BrandName.optional(),
    nameEn: z.string().trim().max(200).optional(),
    logoFileId: PublicId.nullish(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'empty_update' });
export type UpdateBrandBody = z.infer<typeof UpdateBrandBody>;

export const BrandListQuery = CatalogListBase.extend({
  status: EntityStatus.optional(),
  q: z.string().trim().min(2).max(100).optional(),
});
export type BrandListQuery = z.infer<typeof BrandListQuery>;

export const ProductStatusFilter = ProductStatus.optional();
