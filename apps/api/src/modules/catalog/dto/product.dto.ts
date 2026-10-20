/**
 * Product, variant, barcode, media and supplier-link contracts
 * (`API.md` §4.3 products/variants/barcodes/media).
 */
import { MoneyString, QuantityString } from '@saman/shared';
import { z } from 'zod';

import {
  BarcodeSource,
  BarcodeType,
  BooleanQuery,
  CatalogListBase,
  ProductStatus,
  PublicId,
} from './common';
import { VariantAttributeValueInput } from './attribute.dto';

const ProductName = z.string().trim().min(1).max(300);
const Sku = z.string().trim().min(2).max(100);
const WeightGrams = z.number().int().min(0).max(10_000_000);

export const Dimensions = z.object({
  lengthCm: z.number().min(0).max(100_000).optional(),
  widthCm: z.number().min(0).max(100_000).optional(),
  heightCm: z.number().min(0).max(100_000).optional(),
});
export type Dimensions = z.infer<typeof Dimensions>;

export const CreateVariantBody = z.object({
  sku: Sku.optional(),
  title: z.string().trim().max(300).optional(),
  barcode: z.string().trim().min(4).max(50).optional(),
  barcodeType: BarcodeType.optional(),
  attributes: z.array(VariantAttributeValueInput).max(200).optional(),
  unitId: PublicId,
  weightGrams: WeightGrams.optional(),
  dimensions: Dimensions.optional(),
  isDefault: z.boolean().optional(),
});
export type CreateVariantBody = z.infer<typeof CreateVariantBody>;

export const CreateProductBody = z.object({
  nameFa: ProductName,
  nameEn: z.string().trim().max(300).optional(),
  categoryId: PublicId,
  brandId: PublicId.nullish(),
  description: z.string().trim().max(20_000).optional(),
  shortDescription: z.string().trim().max(500).optional(),
  productType: z.enum(['stock', 'service', 'bundle', 'digital']).optional(),
  baseUnitId: PublicId.optional(),
  attributes: z.array(VariantAttributeValueInput).max(200).optional(),
  variants: z.array(CreateVariantBody).min(1).max(200),
  mediaFileIds: z.array(PublicId).max(50).optional(),
  status: ProductStatus.optional(),
  trackLot: z.boolean().optional(),
  trackSerial: z.boolean().optional(),
  trackUnit: z.boolean().optional(),
  weightGrams: WeightGrams.optional(),
  warrantyMonths: z.number().int().min(0).max(600).optional(),
  hsCode: z.string().trim().max(20).optional(),
  isMarketplaceAllowed: z.boolean().optional(),
});
export type CreateProductBody = z.infer<typeof CreateProductBody>;

export const UpdateProductBody = z
  .object({
    nameFa: ProductName.optional(),
    nameEn: z.string().trim().max(300).optional(),
    categoryId: PublicId.optional(),
    brandId: PublicId.nullish(),
    description: z.string().trim().max(20_000).optional(),
    shortDescription: z.string().trim().max(500).optional(),
    attributes: z.array(VariantAttributeValueInput).max(200).optional(),
    status: ProductStatus.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'empty_update' });
export type UpdateProductBody = z.infer<typeof UpdateProductBody>;

export const UpdateVariantBody = z
  .object({
    weightGrams: WeightGrams.optional(),
    dimensions: Dimensions.optional(),
    unitId: PublicId.optional(),
    status: z.enum(['active', 'inactive']).optional(),
    title: z.string().trim().max(300).optional(),
    attributes: z.array(VariantAttributeValueInput).max(200).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'empty_update' });
export type UpdateVariantBody = z.infer<typeof UpdateVariantBody>;

export const BulkUpdateProductsBody = z.object({
  items: z
    .array(
      z.object({
        id: PublicId,
        nameFa: ProductName.optional(),
        categoryId: PublicId.optional(),
        brandId: PublicId.nullish(),
        status: ProductStatus.optional(),
        attrs: z.array(VariantAttributeValueInput).max(200).optional(),
      }),
    )
    .min(1)
    .max(100),
});
export type BulkUpdateProductsBody = z.infer<typeof BulkUpdateProductsBody>;

export const PublishProductBody = z.object({
  channelIds: z.array(PublicId).max(50).optional(),
});
export type PublishProductBody = z.infer<typeof PublishProductBody>;

export const ArchiveProductBody = z.object({ reason: z.string().trim().min(1).max(300) });
export type ArchiveProductBody = z.infer<typeof ArchiveProductBody>;

export const ProductListQuery = CatalogListBase.extend({
  q: z.string().trim().min(2).max(100).optional(),
  categoryId: PublicId.optional(),
  brandId: PublicId.optional(),
  status: ProductStatus.optional(),
  hasStock: BooleanQuery.optional(),
  channelCode: z.string().trim().max(40).optional(),
  updatedAtGte: z.string().datetime().optional(),
});
export type ProductListQuery = z.infer<typeof ProductListQuery>;

export const VariantListQuery = CatalogListBase.extend({
  productId: PublicId.optional(),
  status: z.enum(['active', 'inactive']).optional(),
  hasStock: BooleanQuery.optional(),
  channelCode: z.string().trim().max(40).optional(),
  barcode: z.string().trim().max(50).optional(),
  sku: z.string().trim().max(100).optional(),
  q: z.string().trim().min(2).max(100).optional(),
});
export type VariantListQuery = z.infer<typeof VariantListQuery>;

export const ProductDetailQuery = z.object({
  include: z.string().trim().max(300).optional(),
});
export type ProductDetailQuery = z.infer<typeof ProductDetailQuery>;

export const LookupProductQuery = z
  .object({
    barcode: z.string().trim().min(4).max(50).optional(),
    sku: z.string().trim().min(2).max(100).optional(),
    channelCode: z.string().trim().max(40).optional(),
    externalId: z.string().trim().max(150).optional(),
  })
  .refine(
    (query) =>
      query.barcode !== undefined ||
      query.sku !== undefined ||
      (query.channelCode !== undefined && query.externalId !== undefined),
    { message: 'lookup_key_required' },
  );
export type LookupProductQuery = z.infer<typeof LookupProductQuery>;

export const BarcodeLookupQuery = z.object({
  code: z.string().trim().min(4).max(100).optional(),
  value: z.string().trim().min(4).max(100).optional(),
  codeType: z.string().trim().max(30).optional(),
});
export type BarcodeLookupQuery = z.infer<typeof BarcodeLookupQuery>;

export const CreateBarcodeBody = z.object({
  value: z.string().trim().min(4).max(50),
  type: BarcodeType,
  source: BarcodeSource.optional(),
  isPrimary: z.boolean().optional(),
});
export type CreateBarcodeBody = z.infer<typeof CreateBarcodeBody>;

export const BarcodeIdParam = z.object({ id: PublicId, barcodeId: PublicId });
export type BarcodeIdParam = z.infer<typeof BarcodeIdParam>;

export const AttachMediaBody = z.object({
  fileId: PublicId,
  alt: z.string().trim().max(250).optional(),
  isPrimary: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  mediaType: z.enum(['image', 'video', 'document', '360']).optional(),
});
export type AttachMediaBody = z.infer<typeof AttachMediaBody>;

export const UpdateMediaBody = z
  .object({
    alt: z.string().trim().max(250).optional(),
    isPrimary: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'empty_update' });
export type UpdateMediaBody = z.infer<typeof UpdateMediaBody>;

export const MediaIdParam = z.object({ id: PublicId, mediaId: PublicId });
export type MediaIdParam = z.infer<typeof MediaIdParam>;

export const SupplierLinkInput = z.object({
  supplierId: PublicId,
  supplierSku: z.string().trim().max(100).optional(),
  leadTimeDays: z.number().int().min(0).max(3650).optional(),
  lastPrice: MoneyString.optional(),
  minOrderQty: QuantityString.optional(),
  isPrimary: z.boolean().optional(),
});
export type SupplierLinkInput = z.infer<typeof SupplierLinkInput>;

export const ReplaceSupplierLinksBody = z.object({
  items: z.array(SupplierLinkInput).max(200),
});
export type ReplaceSupplierLinksBody = z.infer<typeof ReplaceSupplierLinksBody>;

export const PriceHistoryQuery = CatalogListBase.extend({
  channelId: PublicId.optional(),
  dateGte: z.string().datetime().optional(),
});
export type PriceHistoryQuery = z.infer<typeof PriceHistoryQuery>;

export const CostHistoryQuery = CatalogListBase.extend({
  dateGte: z.string().datetime().optional(),
});
export type CostHistoryQuery = z.infer<typeof CostHistoryQuery>;

/** Price-history write used by the pricing module (effective-dated close+insert). */
export const RecordPriceHistoryBody = z.object({
  variantId: PublicId,
  priceAmount: MoneyString,
  compareAtAmount: MoneyString.optional(),
  effectiveFrom: z.string().datetime().optional(),
  reason: z.string().trim().max(100).optional(),
  sourceType: z.enum(['manual', 'pricing_run', 'channel', 'import']).default('manual'),
});
export type RecordPriceHistoryBody = z.infer<typeof RecordPriceHistoryBody>;

/** Cost-history write used by inventory valuation / receipt costing. */
export const RecordCostHistoryBody = z.object({
  variantId: PublicId,
  costAmount: MoneyString,
  avgCostAmount: MoneyString.optional(),
  costMethod: z.enum(['moving_average', 'fifo', 'standard']).default('moving_average'),
  effectiveFrom: z.string().datetime().optional(),
  sourceType: z.enum(['receipt', 'valuation', 'manual', 'import']).default('manual'),
  referenceId: z.string().max(64).optional(),
});
export type RecordCostHistoryBody = z.infer<typeof RecordCostHistoryBody>;
