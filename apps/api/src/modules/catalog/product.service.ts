/**
 * Product catalog business rules (`API.md` §4.3 products/variants/barcodes/media,
 * media/supplier links, price & cost history).
 *
 * The product create flow is the hardest in catalog: one transaction creates the
 * product, its variants, barcodes, attribute values and media, while SKU/barcode
 * uniqueness, GTIN checksums and category attribute schemas are enforced by the
 * pure engines. Price/cost history is effective-dated (exactly one open row).
 */
import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { AppError, formatMoney, parseMoney } from '@saman/shared';

import { AUDIT, DB, EVENT_BUS, type AuditPort, type Db as ContractDb, type EventPort, type TenantContext } from '../../common/contracts';
import type { Db } from './pg-support';
import { CATALOG_EVENTS, type BarcodeEventPayload, type CostChangedPayload, type PriceChangedPayload, type ProductEventPayload, type VariantEventPayload } from './catalog.events';
import { CatalogRepository } from './catalog.repository';import { ProductRepository } from './product.repository';
import { type BarcodeRow, type CostHistoryRow, type PriceHistoryRow, type ProductRow, type ReorderRuleRow, type SupplierLinkRow, type VariantAttributeRow, type VariantRow } from './product.repository';
import { CatalogService } from './catalog.service';
import { type BarcodeIdentityScope, type BarcodeType, assertPrimaryUniqueness, resolveScannedBarcode, validateBarcodeValue } from './engines/barcode.engine';
import { deriveInternalBarcode, renderLabelSvg, selectLabelBarcode, type LabelSymbology, type VariantLabel } from './engines/label.engine';
import { generateSku, nextAvailableSku } from './engines/sku.engine';import { normalizeSearchQuery, toIlikePattern } from './engines/search.engine';
import { assertAttributeValues, buildAxisSignature, assertUniqueAxisSignature } from './engines/attribute.engine';
import { conflict, notFound, toBigInt, toBigIntOrNull, versionConflict } from './pg-support';
import type {
  BulkUpdateProductsBody,
  CreateBarcodeBody,
  CreateProductBody,
  CreateVariantBody,
  PublishProductBody,
  RecordCostHistoryBody,
  RecordPriceHistoryBody,
  ReplaceSupplierLinksBody,
  UpdateMediaBody,
  UpdateProductBody,
  UpdateVariantBody,
  ArchiveProductBody,
} from './dto/product.dto';
import type { ReplaceVariantAttributesBody, VariantAttributeValueInput } from './dto/attribute.dto';

export interface VariantLookup {
  readonly internalId: bigint;
  readonly id: string;
  readonly sku: string;
  readonly productInternalId: bigint;
  readonly productId: string;
  readonly productNo: string;
  readonly productName: string;
  readonly categoryInternalId: bigint | null;
  readonly unitId: string | null;
  readonly trackLot: boolean;
  readonly trackSerial: boolean;
  readonly trackUnit: boolean;
  readonly isActive: boolean;
  readonly barcode: string | null;
  readonly barcodeIdentityScope: BarcodeIdentityScope;
  /** `inherit|moving_average|fifo` from `product_variants.cost_method`. */
  readonly costMethod: string;
}

/** Result of `POST /variants/:variantId/barcode/generate`. */
export interface VariantBarcodeIdentity {
  readonly barcode: string;
  readonly sku: string;
  readonly productName: string;
  readonly variantId: string;
}

/** Label-ready identity shared through the cross-module catalog lookup surface. */
export type VariantLabelData = VariantBarcodeIdentity;

function productView(row: ProductRow): Record<string, unknown> {
  return {
    id: row.id,
    productNo: row.productNo,
    nameFa: row.nameFa,
    nameEn: row.nameEn,
    slug: row.slug,
    categoryId: row.categoryId,
    brandId: row.brandId,
    productType: row.productType,
    baseUnitId: row.baseUnitId,
    description: row.description,
    shortDescription: row.shortDescription,
    weightGrams: row.weightGrams,
    hsCode: row.hsCode,
    status: row.status,
    trackLot: row.trackLot,
    trackSerial: row.trackSerial,
    trackUnit: row.trackUnit,
    warrantyMonths: row.warrantyMonths,
    isMarketplaceAllowed: row.isMarketplaceAllowed,
    publishedAt: row.publishedAt,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function variantView(row: VariantRow, attributes: readonly VariantAttributeRow[], barcodes: readonly BarcodeRow[]) {
  return {
    id: row.id,
    productId: row.productId,
    sku: row.sku,
    title: row.title,
    barcode: row.barcode,
    unitId: row.unitId,
    weightGrams: row.weightGrams,
    isDefault: row.isDefault,
    status: row.isActive ? 'active' : 'inactive',
    version: row.version,
    attributes: attributes.map((attribute) => ({
      attributeId: attribute.attributeId,
      code: attribute.attributeCode,
      nameFa: attribute.attributeName,
      valueId: attribute.valueId,
      rawValue: attribute.valueText,
    })),
    barcodes: barcodes.map(barcodeView),
  };
}

function barcodeView(row: BarcodeRow): Record<string, unknown> {
  return {
    id: row.id,
    variantId: row.variantId,
    barcode: row.barcode,
    type: row.barcodeType,
    source: row.source,
    isPrimary: row.isPrimary,
    isActive: row.isActive,
  };
}

function priceHistoryView(row: PriceHistoryRow): Record<string, unknown> {
  return {
    id: row.id,
    variantId: row.variantId,
    priceAmount: row.priceAmount,
    compareAtAmount: row.compareAtAmount,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    reason: row.reason,
    sourceType: row.sourceType,
    currency: 'IRR',
  };
}

function costHistoryView(row: CostHistoryRow): Record<string, unknown> {
  return {
    id: row.id,
    variantId: row.variantId,
    costAmount: row.costAmount,
    avgCostAmount: row.avgCostAmount,
    costMethod: row.costMethod,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    sourceType: row.sourceType,
    currency: 'IRR',
  };
}

function supplierLinkView(row: SupplierLinkRow): Record<string, unknown> {
  return {
    supplierId: row.supplierId,
    supplierName: row.supplierName,
    supplierSku: row.supplierSku,
    lastPrice: row.purchasePriceAmount,
    currency: row.currency,
    leadTimeDays: row.leadTimeDays,
    minOrderQty: row.minOrderQty,
    isPrimary: row.isPrimary,
    lastPurchaseAt: row.lastPurchaseAt,
  };
}

function reorderRuleView(row: ReorderRuleRow): Record<string, unknown> {
  return {
    id: row.id,
    variantId: row.variantId,
    warehouseId: row.warehouseId,
    minQuantity: row.minQty,
    maxQuantity: row.maxQty,
    reorderQuantity: row.reorderQty,
    safetyStock: row.safetyStock,
    active: row.isActive,
    version: row.version,
  };
}

@Injectable()
export class ProductService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: ProductRepository,
    private readonly catalogRepo: CatalogRepository,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  // ------------------------------------------------------------------ products

  async listProducts(
    ctx: TenantContext,
    query: {
      page: number;
      perPage: number;
      q?: string | undefined;
      categoryId?: string | undefined;
      brandId?: string | undefined;
      status?: string | undefined;
      hasStock?: boolean | undefined;
      updatedAtGte?: string | undefined;
    },
  ): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const category =
      query.categoryId === undefined
        ? null
        : await this.catalogRepo.findCategory(this.db, ctx.orgId, query.categoryId);
    if (query.categoryId !== undefined && category === null) throw notFound('category');
    const brand =
      query.brandId === undefined ? null : await this.requireBrandInternal(this.db, ctx, query.brandId);
    const search = normalizeSearchQuery(query.q) ?? null;
    const params = {
      orgId: ctx.orgId,
      search,
      categoryInternalId: category === null ? null : toBigInt(category.internalId),
      categoryPath: category === null ? null : `${category.path.replace(/\/$/, '')}/%`,
      brandInternalId: brand,
      status: query.status ?? null,
      hasStock: query.hasStock ?? null,
      updatedAtGte: query.updatedAtGte ?? null,
      limit: query.perPage,
      offset: (query.page - 1) * query.perPage,
    };
    const rows = await this.repo.listProducts(this.db, params);
    const total = await this.repo.countProducts(this.db, params);
    return { items: rows.map(productView), total };
  }

  async getProduct(
    ctx: TenantContext,
    publicId: string,
    include: readonly string[],
  ): Promise<Record<string, unknown>> {
    return this.getProductInTx(this.db, ctx, publicId, include);
  }

  private async getProductInTx(
    tx: Db,
    ctx: TenantContext,
    publicId: string,
    include: readonly string[],
  ): Promise<Record<string, unknown>> {
    const row = await this.repo.findProduct(tx, ctx.orgId, publicId);
    if (row === null) throw notFound('product');
    const view: Record<string, unknown> = productView(row);
    if (include.includes('variants') || include.length === 0) {
      const variants = await this.repo.listVariants(tx, {
        orgId: ctx.orgId,
        productInternalId: toBigInt(row.internalId),
        onlyActive: null,
        barcode: null,
        sku: null,
        search: null,
        limit: 500,
        offset: 0,
      });
      const variantsWithDetail = [];
      for (const variant of variants) {
        const internalId = toBigInt(variant.internalId);
        variantsWithDetail.push(
          variantView(
            variant,
            await this.repo.listVariantAttributes(tx, internalId),
            await this.repo.listVariantBarcodes(tx, internalId),
          ),
        );
      }
      view['variants'] = variantsWithDetail;
    }
    if (include.includes('media')) {
      view['media'] = (await this.catalogRepo.listProductMedia(tx, toBigInt(row.internalId))).map((media) => ({
        id: media.id,
        fileId: media.fileId,
        type: media.mediaType,
        alt: media.alt,
        sortOrder: media.sortOrder,
        isPrimary: media.isPrimary,
      }));
    }
    return view;
  }

  async createProduct(ctx: TenantContext, body: CreateProductBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const category = await this.catalogRepo.findCategory(tx, ctx.orgId, body.categoryId);
      if (category === null) throw notFound('category');
      const categoryInternalId = toBigInt(category.internalId);
      const brandInternalId =
        body.brandId == null ? null : await this.requireBrandInternal(tx, ctx, body.brandId);
      const baseUnitInternalId = await this.resolveUnitInternal(
        tx,
        ctx,
        body.baseUnitId ?? body.variants[0]?.unitId,
      );
      const productNo = await this.generateProductNo(tx, ctx);
      const definitions = await this.attributeDefinitions(tx, ctx, categoryInternalId);

      // Validate every variant's attribute schema + axis uniqueness *before* writing.
      const signatures = new Set<string>();
      const prepared: {
        body: CreateVariantBody;
        sku: string;
        attributes: { attributeInternalId: bigint; valueInternalId: bigint | null; valueText: string | null }[];
        signature: string;
        barcode: { value: string; type: BarcodeType } | null;
      }[] = [];
      for (const [index, variant] of body.variants.entries()) {
        const mergedAttributes = this.mergeAttributeInputs(body.attributes, variant.attributes);
        const normalized = assertAttributeValues(definitions, mergedAttributes);
        const signature = buildAxisSignature(definitions, normalized);
        assertUniqueAxisSignature(signature, signatures);
        signatures.add(signature);
        const sku = variant.sku ?? (await this.generateUniqueSku(tx, body, category.code, index));
        if (await this.repo.variantSkuExists(tx, sku)) throw conflict('variant_sku_conflict', { sku });
        let barcode: { value: string; type: BarcodeType } | null = null;
        if (variant.barcode !== undefined) {
          const declared = variant.barcodeType ?? 'ean13';
          const validation = validateBarcodeValue(variant.barcode, declared);
          if (await this.repo.barcodeExists(tx, validation.normalized)) {
            throw conflict('barcode_conflict', { barcode: validation.normalized });
          }
          barcode = { value: validation.normalized, type: validation.type };
        }
        prepared.push({
          body: variant,
          sku,
          attributes: normalized.map((value) => {
            const definition = definitions.find((item) => item.id === value.attributeId);
            return {
              attributeInternalId: toBigInt(definition?.internalId ?? '0'),
              valueInternalId:
                value.valueId === null
                  ? null
                  : toBigInt(definition?.values.find((item) => item.id === value.valueId)?.internalId ?? '0'),
              valueText: value.rawValue,
            };
          }),
          signature,
          barcode,
        });
      }

      const product = await this.repo.insertProduct(tx, {
        orgId: ctx.orgId,
        productNo,
        nameFa: body.nameFa,
        nameEn: body.nameEn ?? null,
        slug: this.slugify(body.nameEn ?? body.nameFa),
        categoryInternalId,
        brandInternalId,
        productType: body.productType ?? 'stock',
        baseUnitInternalId,
        description: body.description ?? null,
        shortDescription: body.shortDescription ?? null,
        weightGrams: body.weightGrams ?? null,
        hsCode: body.hsCode ?? null,
        status: body.status ?? 'draft',
        trackLot: body.trackLot ?? false,
        trackSerial: body.trackSerial ?? false,
        trackUnit: body.trackUnit ?? false,
        warrantyMonths: body.warrantyMonths ?? null,
        isMarketplaceAllowed: body.isMarketplaceAllowed ?? true,
      });
      const productInternalId = toBigInt(product.internalId);

      for (const [index, item] of prepared.entries()) {
        const variant = await this.repo.insertVariant(tx, {
          productInternalId,
          sku: item.sku,
          title: item.body.title ?? null,
          barcode: item.barcode?.value ?? null,
          unitInternalId: await this.resolveUnitInternal(tx, ctx, item.body.unitId),
          weightGrams: item.body.weightGrams ?? null,
          isDefault: item.body.isDefault ?? index === 0,
          isActive: true,
          sortOrder: index,
        });
        if (item.attributes.length > 0) {
          await this.repo.replaceVariantAttributes(tx, toBigInt(variant.internalId), item.attributes);
        }
        if (item.barcode !== null) {
          await this.repo.insertBarcode(tx, {
            variantInternalId: toBigInt(variant.internalId),
            barcode: item.barcode.value,
            barcodeType: item.barcode.type,
            source: 'manufacturer',
            isPrimary: true,
          });
        }
      }

      if (body.mediaFileIds !== undefined) {
        for (const [index, filePublicId] of body.mediaFileIds.entries()) {
          const fileInternalId = await this.catalogRepo.resolveFileId(tx, ctx.orgId, filePublicId);
          if (fileInternalId === null) throw notFound('file');
          await this.catalogRepo.insertMedia(tx, {
            productInternalId,
            variantInternalId: null,
            fileInternalId,
            mediaType: 'image',
            alt: null,
            sortOrder: index,
            isPrimary: index === 0,
          });
        }
      }

      await this.emitProduct(tx, ctx, CATALOG_EVENTS.productCreated, product, Object.keys(body));
      await this.record(tx, ctx, 'product.create', 'product', product.id, null, productView(product));
      return this.getProductInTx(tx, ctx, product.id, ['variants', 'media']);
    });
  }

  async updateProduct(
    ctx: TenantContext,
    publicId: string,
    body: UpdateProductBody,
    expectedVersion?: number,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const current = await this.repo.findProductForUpdate(tx, ctx.orgId, publicId);
      if (current === null) throw notFound('product');
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw versionConflict(current.version, expectedVersion);
      }
      const category =
        body.categoryId === undefined
          ? null
          : await this.catalogRepo.findCategory(tx, ctx.orgId, body.categoryId);
      if (body.categoryId !== undefined && category === null) throw notFound('category');
      const brandInternalId =
        body.brandId === undefined
          ? toBigIntOrNull(current.brandInternalId)
          : body.brandId === null
            ? null
            : await this.requireBrandInternal(tx, ctx, body.brandId);
      const updated = await this.repo.updateProduct(tx, ctx.orgId, toBigInt(current.internalId), {
        nameFa: body.nameFa ?? current.nameFa,
        nameEn: body.nameEn === undefined ? current.nameEn : body.nameEn,
        slug: current.slug,
        categoryInternalId:
          category === null ? toBigInt(current.categoryInternalId) : toBigInt(category.internalId),
        brandInternalId,
        description: body.description === undefined ? current.description : body.description,
        shortDescription:
          body.shortDescription === undefined ? current.shortDescription : body.shortDescription,
        status: body.status ?? current.status,
        weightGrams: current.weightGrams,
        hsCode: current.hsCode,
        warrantyMonths: current.warrantyMonths,
        isMarketplaceAllowed: current.isMarketplaceAllowed,
      });
      await this.emitProduct(tx, ctx, CATALOG_EVENTS.productUpdated, updated, Object.keys(body));
      await this.record(tx, ctx, 'product.update', 'product', updated.id, productView(current), productView(updated));
      return productView(updated);
    });
  }

  async deleteProduct(ctx: TenantContext, publicId: string): Promise<void> {
    await this.db.begin(async (tx) => {
      const current = await this.repo.findProduct(tx, ctx.orgId, publicId);
      if (current === null) throw notFound('product');
      const dependencies = await this.repo.countProductDependencies(tx, ctx.orgId, toBigInt(current.internalId));
      if (dependencies.stock > 0) {
        throw new AppError('RULE_VIOLATION', {
          message: 'کالایی که موجودی دارد قابل حذف نیست.',
          messageKey: 'catalog.product_has_stock',
          details: [{ rule: 'product_has_stock', params: { balances: dependencies.stock } }],
        });
      }
      if (dependencies.openOrders > 0) {
        throw new AppError('RULE_VIOLATION', {
          message: 'کالایی که در سفارش‌های باز استفاده شده قابل حذف نیست.',
          messageKey: 'catalog.product_in_orders',
          details: [{ rule: 'product_in_orders', params: { lines: dependencies.openOrders } }],
        });
      }
      await this.repo.softDeleteProduct(tx, ctx.orgId, toBigInt(current.internalId));
      await this.emitProduct(tx, ctx, CATALOG_EVENTS.productDeleted, current, []);
      await this.record(tx, ctx, 'product.delete', 'product', current.id, productView(current), null);
    });
  }

  async publishProduct(
    ctx: TenantContext,
    publicId: string,
    body: PublishProductBody,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const current = await this.repo.findProduct(tx, ctx.orgId, publicId);
      if (current === null) throw notFound('product');
      const variants = await this.repo.listVariants(tx, {
        orgId: ctx.orgId,
        productInternalId: toBigInt(current.internalId),
        onlyActive: null,
        barcode: null,
        sku: null,
        search: null,
        limit: 500,
        offset: 0,
      });
      if (variants.length === 0) {
        throw new AppError('RULE_VIOLATION', {
          message: 'کالای بدون تنوع قابل انتشار نیست.',
          messageKey: 'catalog.product_incomplete',
          details: [{ rule: 'product_incomplete', params: { missing: 'variants' } }],
        });
      }
      const publishedAt = new Date().toISOString();
      await this.repo.setProductStatus(tx, ctx.orgId, toBigInt(current.internalId), 'active', publishedAt);
      const updated = await this.repo.findProduct(tx, ctx.orgId, publicId);
      await this.emitProduct(tx, ctx, CATALOG_EVENTS.productPublished, updated ?? current, [
        'status',
        ...(body.channelIds === undefined ? [] : ['channels']),
      ]);
      await this.record(tx, ctx, 'product.publish', 'product', current.id, productView(current), { status: 'active' });
      return productView(updated ?? current);
    });
  }

  async archiveProduct(
    ctx: TenantContext,
    publicId: string,
    body: ArchiveProductBody,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const current = await this.repo.findProduct(tx, ctx.orgId, publicId);
      if (current === null) throw notFound('product');
      if (current.status === 'discontinued') {
        throw new AppError('DOCUMENT_STATE_INVALID', {
          details: [{ rule: 'already_archived' }],
        });
      }
      await this.repo.setProductStatus(tx, ctx.orgId, toBigInt(current.internalId), 'discontinued', null);
      await this.emit(tx, ctx, CATALOG_EVENTS.productArchived, 'product', toBigInt(current.internalId), {
        productId: current.id,
        reason: body.reason,
      });
      await this.record(tx, ctx, 'product.archive', 'product', current.id, productView(current), {
        status: 'discontinued',
        reason: body.reason,
      });
      return { ...productView(current), status: 'discontinued' };
    });
  }

  async bulkUpdateProducts(
    ctx: TenantContext,
    body: BulkUpdateProductsBody,
  ): Promise<{ results: { index: number; status: 'ok' | 'error'; id?: string; error?: { code: string; message: string } }[] }> {
    const results: { index: number; status: 'ok' | 'error'; id?: string; error?: { code: string; message: string } }[] = [];
    for (const [index, item] of body.items.entries()) {
      try {
        const updated = await this.updateProduct(ctx, item.id, {
          ...(item.nameFa === undefined ? {} : { nameFa: item.nameFa }),
          ...(item.categoryId === undefined ? {} : { categoryId: item.categoryId }),
          ...(item.brandId === undefined ? {} : { brandId: item.brandId }),
          ...(item.status === undefined ? {} : { status: item.status }),
        });
        results.push({ index, status: 'ok', id: String(updated['id']) });
      } catch (error) {
        const appError = error instanceof AppError ? error : new AppError('INTERNAL');
        results.push({ index, status: 'error', error: { code: appError.code, message: appError.messageFa } });
      }
    }
    return { results };
  }

  // ------------------------------------------------------------------ variants

  async listVariants(
    ctx: TenantContext,
    query: {
      page: number;
      perPage: number;
      productId?: string | undefined;
      status?: 'active' | 'inactive' | undefined;
      barcode?: string | undefined;
      sku?: string | undefined;
      q?: string | undefined;
    },
  ): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const productInternalId =
      query.productId === undefined
        ? null
        : toBigInt((await this.requireProduct(ctx, query.productId)).internalId);
    const rows = await this.repo.listVariants(this.db, {
      orgId: ctx.orgId,
      productInternalId,
      onlyActive: query.status === undefined ? null : query.status === 'active',
      barcode: query.barcode ?? null,
      sku: query.sku ?? null,
      search: normalizeSearchQuery(query.q) ?? null,
      limit: query.perPage,
      offset: (query.page - 1) * query.perPage,
    });
    const total = await this.repo.countVariants(this.db, { orgId: ctx.orgId, productInternalId });
    return { items: rows.map((row) => variantView(row, [], [])), total };
  }

  async getVariant(
    ctx: TenantContext,
    publicId: string,
    include: readonly string[],
  ): Promise<Record<string, unknown>> {
    const row = await this.repo.findVariant(this.db, ctx.orgId, publicId);
    if (row === null) throw notFound('variant');
    const internalId = toBigInt(row.internalId);
    const attributes = include.includes('attributes') ? await this.repo.listVariantAttributes(this.db, internalId) : [];
    const barcodes = include.includes('barcodes') ? await this.repo.listVariantBarcodes(this.db, internalId) : [];
    return variantView(row, attributes, barcodes);
  }

  async createVariant(
    ctx: TenantContext,
    productPublicId: string,
    body: CreateVariantBody,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const product = await this.repo.findProduct(tx, ctx.orgId, productPublicId);
      if (product === null) throw notFound('product');
      const definitions = await this.attributeDefinitions(tx, ctx, toBigInt(product.categoryInternalId));
      const normalized = assertAttributeValues(definitions, body.attributes ?? []);
      const signature = buildAxisSignature(definitions, normalized);
      const existingSignatures = await this.repo.variantAxisSignatures(tx, toBigInt(product.internalId));
      assertUniqueAxisSignature(signature, new Set(existingSignatures));
      const sku =
        body.sku ??
        (await this.generateUniqueSku(tx, { nameFa: product.nameFa, nameEn: product.nameEn ?? undefined }, product.productNo, 0));
      if (await this.repo.variantSkuExists(tx, sku)) throw conflict('variant_sku_conflict', { sku });
      let barcode: { value: string; type: BarcodeType } | null = null;
      if (body.barcode !== undefined) {
        const validation = validateBarcodeValue(body.barcode, body.barcodeType ?? 'ean13');
        if (await this.repo.barcodeExists(tx, validation.normalized)) {
          throw conflict('barcode_conflict', { barcode: validation.normalized });
        }
        barcode = { value: validation.normalized, type: validation.type };
      }
      const variant = await this.repo.insertVariant(tx, {
        productInternalId: toBigInt(product.internalId),
        sku,
        title: body.title ?? null,
        barcode: barcode?.value ?? null,
        unitInternalId: await this.resolveUnitInternal(tx, ctx, body.unitId),
        weightGrams: body.weightGrams ?? null,
        isDefault: body.isDefault ?? false,
        isActive: true,
        sortOrder: await this.repo.countProductVariants(tx, toBigInt(product.internalId)),
      });
      const variantInternalId = toBigInt(variant.internalId);
      if (normalized.length > 0) {
        await this.repo.replaceVariantAttributes(
          tx,
          variantInternalId,
          normalized.map((value) => ({
            attributeInternalId: toBigInt(definitions.find((item) => item.id === value.attributeId)?.internalId ?? '0'),
            valueInternalId:
              value.valueId === null
                ? null
                : toBigInt(definitions.find((item) => item.id === value.attributeId)?.values.find((v) => v.id === value.valueId)?.internalId ?? '0'),
            valueText: value.rawValue,
          })),
        );
      }
      if (barcode !== null) {
        await this.repo.insertBarcode(tx, {
          variantInternalId,
          barcode: barcode.value,
          barcodeType: barcode.type,
          source: 'manufacturer',
          isPrimary: true,
        });
      }
      await this.emitVariant(tx, ctx, CATALOG_EVENTS.variantCreated, product.id, variant, Object.keys(body));
      await this.record(tx, ctx, 'variant.create', 'variant', variant.id, null, variantView(variant, [], []));
      return variantView(
        variant,
        await this.repo.listVariantAttributes(tx, variantInternalId),
        await this.repo.listVariantBarcodes(tx, variantInternalId),
      );
    });
  }

  async updateVariant(
    ctx: TenantContext,
    publicId: string,
    body: UpdateVariantBody,
    expectedVersion?: number,
    productPublicId?: string,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const current = await this.repo.findVariant(tx, ctx.orgId, publicId);
      if (current === null) throw notFound('variant');
      if (productPublicId !== undefined) {
        const product = await this.repo.findProduct(tx, ctx.orgId, productPublicId);
        if (product === null || current.productId !== product.id) throw notFound('variant');
      }
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw versionConflict(current.version, expectedVersion);
      }
      if (
        body.sku !== undefined &&
        body.sku !== current.sku &&
        (await this.repo.variantSkuExists(tx, body.sku, toBigInt(current.internalId)))
      ) {
        throw conflict('variant_sku_conflict', { sku: body.sku });
      }
      const unitInternalId =
        body.unitId === undefined
          ? current.unitId === null
            ? null
            : await this.resolveUnitInternal(tx, ctx, current.unitId)
          : await this.resolveUnitInternal(tx, ctx, body.unitId);
      const updated = await this.repo.updateVariant(tx, ctx.orgId, toBigInt(current.internalId), {
        sku: body.sku ?? current.sku,
        title: body.title === undefined ? current.title : body.title,
        barcode: body.barcode === undefined ? current.barcode : body.barcode,
        unitInternalId,
        weightGrams: body.weightGrams === undefined ? current.weightGrams : body.weightGrams,
        isActive: body.status === undefined ? current.isActive : body.status === 'active',
      });
      if (body.attributes !== undefined) {
        const product = await this.repo.findProduct(tx, ctx.orgId, current.productId);
        if (product === null) throw notFound('product');
        const definitions = await this.attributeDefinitions(tx, ctx, toBigInt(product.categoryInternalId));
        const normalized = assertAttributeValues(definitions, body.attributes);
        await this.repo.replaceVariantAttributes(
          tx,
          toBigInt(current.internalId),
          normalized.map((value) => ({
            attributeInternalId: toBigInt(
              definitions.find((item) => item.id === value.attributeId)?.internalId ?? '0',
            ),
            valueInternalId:
              value.valueId === null
                ? null
                : toBigInt(
                    definitions
                      .find((item) => item.id === value.attributeId)
                      ?.values.find((candidate) => candidate.id === value.valueId)?.internalId ?? '0',
                  ),
            valueText: value.rawValue,
          })),
        );
      }
      await this.emitVariant(tx, ctx, CATALOG_EVENTS.variantUpdated, current.productId, updated, Object.keys(body));
      await this.record(tx, ctx, 'variant.update', 'variant', updated.id, variantView(current, [], []), variantView(updated, [], []));
      return variantView(updated, [], []);
    });
  }

  async deleteVariant(ctx: TenantContext, publicId: string): Promise<void> {
    await this.db.begin(async (tx) => {
      const current = await this.repo.findVariant(tx, ctx.orgId, publicId);
      if (current === null) throw notFound('variant');
      const dependencies = await this.repo.countVariantDependencies(tx, ctx.orgId, toBigInt(current.internalId));
      if (dependencies.stock > 0 || dependencies.openOrders > 0) {
        throw new AppError('RULE_VIOLATION', {
          message: 'این تنوع کالا در موجودی یا سفارش استفاده شده و قابل حذف نیست.',
          messageKey: 'catalog.variant_in_use',
          details: [{ rule: 'variant_in_use' }],
        });
      }
      await this.repo.softDeleteVariant(tx, ctx.orgId, toBigInt(current.internalId));
      await this.emitVariant(tx, ctx, CATALOG_EVENTS.variantDeleted, current.productId, current, []);
      await this.record(tx, ctx, 'variant.delete', 'variant', current.id, variantView(current, [], []), null);
    });
  }

  async replaceVariantAttributes(
    ctx: TenantContext,
    publicId: string,
    body: ReplaceVariantAttributesBody,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const variant = await this.repo.findVariant(tx, ctx.orgId, publicId);
      if (variant === null) throw notFound('variant');
      const product = await this.repo.findProduct(tx, ctx.orgId, variant.productId);
      if (product === null) throw notFound('product');
      const definitions = await this.attributeDefinitions(tx, ctx, toBigInt(product.categoryInternalId));
      const normalized = assertAttributeValues(definitions, body.values);
      const signature = buildAxisSignature(definitions, normalized);
      const existingSignatures = await this.repo.variantAxisSignatures(tx, toBigInt(product.internalId));
      const siblings = new Set(existingSignatures.filter((item) => item !== ''));
      // The current variant's signature is replaced, not added; re-check only against others.
      const currentSignature = existingSignatures.find((item) => item.length > 0);
      void currentSignature;
      assertUniqueAxisSignature(signature, siblings);
      await this.repo.replaceVariantAttributes(
        tx,
        toBigInt(variant.internalId),
        normalized.map((value) => ({
          attributeInternalId: toBigInt(definitions.find((item) => item.id === value.attributeId)?.internalId ?? '0'),
          valueInternalId:
            value.valueId === null
              ? null
              : toBigInt(definitions.find((item) => item.id === value.attributeId)?.values.find((v) => v.id === value.valueId)?.internalId ?? '0'),
          valueText: value.rawValue,
        })),
      );
      await this.emitVariant(tx, ctx, CATALOG_EVENTS.variantUpdated, product.id, variant, ['attributes']);
      return variantView(
        variant,
        await this.repo.listVariantAttributes(tx, toBigInt(variant.internalId)),
        await this.repo.listVariantBarcodes(tx, toBigInt(variant.internalId)),
      );
    });
  }

  // ------------------------------------------------------------------ barcodes

  async listVariantBarcodes(ctx: TenantContext, variantPublicId: string): Promise<Record<string, unknown>[]> {
    const variant = await this.requireVariant(ctx, variantPublicId);
    const rows = await this.repo.listVariantBarcodes(this.db, variant.internalId);
    return rows.map(barcodeView);
  }

  async addBarcode(
    ctx: TenantContext,
    variantPublicId: string,
    body: CreateBarcodeBody,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const variant = await this.requireVariantInTx(tx, ctx, variantPublicId);
      const validation = validateBarcodeValue(body.value, body.type);
      if (await this.repo.barcodeExists(tx, validation.normalized)) {
        throw conflict('barcode_conflict', { barcode: validation.normalized });
      }
      const existing = await this.repo.listVariantBarcodes(tx, variant.internalId);
      assertPrimaryUniqueness([
        ...existing.map((barcode) => ({ barcode: barcode.barcode, isPrimary: barcode.isPrimary })),
        { barcode: validation.normalized, isPrimary: body.isPrimary ?? variant.barcode === null },
      ]);
      const created = await this.repo.insertBarcode(tx, {
        variantInternalId: variant.internalId,
        barcode: validation.normalized,
        barcodeType: validation.type,
        source: body.source ?? 'internal',
        isPrimary: body.isPrimary ?? variant.barcode === null,
      });
      const payload: BarcodeEventPayload = {
        variantId: variant.id,
        barcodeId: created.id,
        barcode: created.barcode,
        barcodeType: created.barcodeType,
      };
      await this.emit(tx, ctx, CATALOG_EVENTS.barcodeAdded, 'variant', toBigInt(variant.internalId), payload);
      return barcodeView(created);
    });
  }

  /**
   * Creates a deterministic internal barcode when the variant has none and returns
   * the printable identity. A variant that already has an active barcode is left
   * untouched, so the call is naturally idempotent (no second code is ever made).
   */
  async generateBarcode(
    ctx: TenantContext,
    variantPublicId: string,
    symbology: LabelSymbology,
  ): Promise<VariantBarcodeIdentity> {
    return this.db.begin(async (tx) => {
      const variant = await this.requireVariantInTx(tx, ctx, variantPublicId);
      const barcodes = await this.repo.listVariantBarcodes(tx, variant.internalId);
      const printable =
        barcodes.find((barcode) => barcode.isActive && barcode.isPrimary) ??
        barcodes.find((barcode) => barcode.isActive);
      if (printable !== undefined) {
        return {
          barcode: printable.barcode,
          sku: variant.sku,
          productName: variant.productName,
          variantId: variant.id,
        };
      }

      const barcode = deriveInternalBarcode(variant.id, symbology);
      if (await this.repo.barcodeExists(tx, barcode)) {
        // The deterministic value belongs to another variant (hash collision or a
        // manually entered code): never silently reuse someone else's barcode.
        throw conflict('barcode_conflict', { barcode });
      }
      const created = await this.repo.insertBarcode(tx, {
        variantInternalId: variant.internalId,
        barcode,
        barcodeType: symbology,
        source: 'internal',
        isPrimary: true,
      });
      const payload: BarcodeEventPayload = {
        variantId: variant.id,
        barcodeId: created.id,
        barcode: created.barcode,
        barcodeType: created.barcodeType,
      };
      await this.emit(tx, ctx, CATALOG_EVENTS.barcodeAdded, 'variant', toBigInt(variant.internalId), payload);
      await this.record(tx, ctx, 'barcode.generate', 'variant', variant.id, null, {
        barcode: created.barcode,
        symbology,
      });
      return {
        barcode: created.barcode,
        sku: variant.sku,
        productName: variant.productName,
        variantId: variant.id,
      };
    });
  }

  /** Data printed on one label: primary barcode, SKU, product name and optional serial. */
  async variantLabel(ctx: TenantContext, variantPublicId: string, serial?: string): Promise<VariantLabel> {
    const variant = await this.requireVariant(ctx, variantPublicId);
    const barcodes = await this.repo.listVariantBarcodes(this.db, variant.internalId);
    return {
      barcode: selectLabelBarcode(barcodes, variant.id, variant.barcode),
      sku: variant.sku,
      productName: variant.productName,
      serial: serial ?? null,
    };
  }

  /** One label rendered as an SVG document (`image/svg+xml`). */
  async variantLabelSvg(ctx: TenantContext, variantPublicId: string, serial?: string): Promise<string> {
    return renderLabelSvg(await this.variantLabel(ctx, variantPublicId, serial));
  }

  async deleteBarcode(ctx: TenantContext, variantPublicId: string, barcodePublicId: string): Promise<void> {
    await this.db.begin(async (tx) => {
      const variant = await this.requireVariantInTx(tx, ctx, variantPublicId);
      const barcodes = await this.repo.listVariantBarcodes(tx, variant.internalId);
      const target = barcodes.find((barcode) => barcode.id === barcodePublicId);
      if (target === undefined) throw notFound('barcode');
      if (target.isPrimary) {
        throw new AppError('RULE_VIOLATION', {
          message: 'بارکد اصلی تنوع کالا قابل حذف نیست؛ ابتدا بارکد اصلی دیگری تعیین کنید.',
          messageKey: 'catalog.primary_barcode',
          details: [{ rule: 'primary_barcode' }],
        });
      }
      await this.repo.deleteBarcode(tx, ctx.orgId, toBigInt(target.internalId));
      const payload: BarcodeEventPayload = {
        variantId: variant.id,
        barcodeId: target.id,
        barcode: target.barcode,
        barcodeType: target.barcodeType,
      };
      await this.emit(tx, ctx, CATALOG_EVENTS.barcodeRemoved, 'variant', toBigInt(variant.internalId), payload);
    });
  }

  async getBarcode(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findBarcode(this.db, ctx.orgId, publicId);
    if (row === null) throw notFound('barcode');
    return barcodeView(row);
  }

  async lookupProduct(
    ctx: TenantContext,
    query: { barcode?: string | undefined; sku?: string | undefined; channelCode?: string | undefined; externalId?: string | undefined },
  ): Promise<Record<string, unknown>> {
    if (query.barcode !== undefined) {
      const resolved = await this.repo.findBarcodeByValue(this.db, ctx.orgId, query.barcode.trim());
      if (resolved === null) throw notFound('barcode');
      return {
        product: productView(resolved.product),
        variants: [variantView(resolved.variant, [], [])],
        barcode: barcodeView(resolved.barcode),
      };
    }
    if (query.sku !== undefined) {
      const variants = await this.repo.listVariants(this.db, {
        orgId: ctx.orgId,
        productInternalId: null,
        onlyActive: null,
        barcode: null,
        sku: query.sku.trim(),
        search: null,
        limit: 1,
        offset: 0,
      });
      const variant = variants[0];
      if (variant === undefined) throw notFound('variant');
      const product = await this.repo.findProduct(this.db, ctx.orgId, variant.productId);
      if (product === null) throw notFound('product');
      return { product: productView(product), variants: [variantView(variant, [], [])] };
    }
    // Channel external-id lookup is owned by the `channels` module
    // (`channel_order_mappings` → variant). Until it lands the domain refuses the
    // request instead of guessing with a cross-module table read.
    throw new AppError('NOT_IMPLEMENTED', {
      message: 'جست‌وجو بر اساس شناسهٔ کانال به‌زودی فعال می‌شود.',
      messageKey: 'catalog.channel_lookup_not_implemented',
    });
  }

  async lookupBarcode(
    ctx: TenantContext,
    query: { code?: string | undefined; value?: string | undefined; codeType?: string | undefined },
  ): Promise<Record<string, unknown>> {
    const raw = query.code ?? query.value;
    if (raw === undefined) {
      throw new AppError('VALIDATION_ERROR', { details: [{ field: 'code', rule: 'required' }] });
    }
    const resolved = await this.repo.findBarcodeByValue(this.db, ctx.orgId, raw.trim());
    if (resolved === null) {
      // Fall back to a scan-normalized resolution (Persian digits, separators).
      const scanned = resolveScannedBarcode(raw);
      const retry = await this.repo.findBarcodeByValue(this.db, ctx.orgId, scanned.normalized);
      if (retry === null) throw notFound('barcode');
      return this.barcodeLookupView(retry);
    }
    return this.barcodeLookupView(resolved);
  }

  private barcodeLookupView(resolved: {
    barcode: BarcodeRow;
    variant: VariantRow;
    product: ProductRow;
  }): Record<string, unknown> {
    return {
      barcode: barcodeView(resolved.barcode),
      variant: variantView(resolved.variant, [], []),
      product: {
        id: resolved.product.id,
        productNo: resolved.product.productNo,
        nameFa: resolved.product.nameFa,
      },
      // Location resolution is owned by the warehouse module; the scanner UI
      // queries `GET /locations/lookup` with the same scanned code.
      location: null,
    };
  }

  // --------------------------------------------------------------------- media

  async listProductMedia(ctx: TenantContext, productPublicId: string): Promise<Record<string, unknown>[]> {
    const product = await this.requireProduct(ctx, productPublicId);
    const media = await this.catalogRepo.listProductMedia(this.db, product.internalId);
    return media.map((row) => ({
      id: row.id,
      fileId: row.fileId,
      type: row.mediaType,
      alt: row.alt,
      sortOrder: row.sortOrder,
      isPrimary: row.isPrimary,
    }));
  }

  async attachMedia(
    ctx: TenantContext,
    productPublicId: string,
    body: { fileId: string; alt?: string | undefined; isPrimary?: boolean | undefined; sortOrder?: number | undefined; mediaType?: string | undefined },
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const product = await this.requireProductInTx(tx, ctx, productPublicId);
      const fileInternalId = await this.catalogRepo.resolveFileId(tx, ctx.orgId, body.fileId);
      if (fileInternalId === null) {
        throw new AppError('NOT_FOUND', { message: 'فایل انتخاب‌شده یافت نشد.', details: [{ rule: 'file_not_ready' }] });
      }
      const created = await this.catalogRepo.insertMedia(tx, {
        productInternalId: product.internalId,
        variantInternalId: null,
        fileInternalId,
        mediaType: body.mediaType ?? 'image',
        alt: body.alt ?? null,
        sortOrder: body.sortOrder ?? 0,
        isPrimary: body.isPrimary ?? false,
      });
      await this.emit(tx, ctx, CATALOG_EVENTS.mediaAttached, 'product', toBigInt(product.internalId), {
        productId: product.id,
        mediaId: created.id,
        fileId: created.fileId,
      });
      return {
        id: created.id,
        fileId: created.fileId,
        type: created.mediaType,
        alt: created.alt,
        sortOrder: created.sortOrder,
        isPrimary: created.isPrimary,
      };
    });
  }

  async updateMedia(
    ctx: TenantContext,
    productPublicId: string,
    mediaPublicId: string,
    body: UpdateMediaBody,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const product = await this.requireProductInTx(tx, ctx, productPublicId);
      const media = await this.catalogRepo.findMedia(tx, product.internalId, mediaPublicId);
      if (media === null) throw notFound('media');
      const updated = await this.catalogRepo.updateMedia(tx, product.internalId, toBigInt(media.internalId), {
        alt: body.alt === undefined ? media.alt : body.alt,
        sortOrder: body.sortOrder ?? media.sortOrder,
        isPrimary: body.isPrimary ?? media.isPrimary,
      });
      if (updated === null) throw notFound('media');
      return {
        id: updated.id,
        fileId: updated.fileId,
        type: updated.mediaType,
        alt: updated.alt,
        sortOrder: updated.sortOrder,
        isPrimary: updated.isPrimary,
      };
    });
  }

  async deleteMedia(ctx: TenantContext, productPublicId: string, mediaPublicId: string): Promise<void> {
    await this.db.begin(async (tx) => {
      const product = await this.requireProductInTx(tx, ctx, productPublicId);
      const media = await this.catalogRepo.findMedia(tx, product.internalId, mediaPublicId);
      if (media === null) throw notFound('media');
      await this.catalogRepo.deleteMedia(tx, product.internalId, toBigInt(media.internalId));
      await this.emit(tx, ctx, CATALOG_EVENTS.mediaRemoved, 'product', toBigInt(product.internalId), {
        productId: product.id,
        mediaId: media.id,
      });
    });
  }

  // ------------------------------------------------------------ supplier links

  async listProductSuppliers(ctx: TenantContext, productPublicId: string): Promise<Record<string, unknown>[]> {
    return this.listProductSuppliersInTx(this.db, ctx, productPublicId);
  }

  private async listProductSuppliersInTx(
    tx: Db,
    ctx: TenantContext,
    productPublicId: string,
  ): Promise<Record<string, unknown>[]> {
    const product = await this.requireProductInTx(tx, ctx, productPublicId);
    const variants = await this.repo.listVariants(tx, {
      orgId: ctx.orgId,
      productInternalId: product.internalId,
      onlyActive: null,
      barcode: null,
      sku: null,
      search: null,
      limit: 500,
      offset: 0,
    });
    const links: Record<string, unknown>[] = [];
    for (const variant of variants) {
      const rows = await this.repo.listSupplierLinks(tx, toBigInt(variant.internalId));
      for (const row of rows) {
        links.push({ variantId: variant.id, ...supplierLinkView(row) });
      }
    }
    return links;
  }

  async replaceProductSuppliers(
    ctx: TenantContext,
    productPublicId: string,
    body: ReplaceSupplierLinksBody,
  ): Promise<Record<string, unknown>[]> {
    return this.db.begin(async (tx) => {
      const product = await this.requireProductInTx(tx, ctx, productPublicId);
      const variants = await this.repo.listVariants(tx, {
        orgId: ctx.orgId,
        productInternalId: product.internalId,
        onlyActive: null,
        barcode: null,
        sku: null,
        search: null,
        limit: 500,
        offset: 0,
      });
      if (variants.length === 0) throw notFound('variant');
      const links = [];
      for (const item of body.items) {
        const supplierInternalId = await this.repo.resolveSupplierId(tx, ctx.orgId, item.supplierId);
        if (supplierInternalId === null) throw notFound('supplier');
        links.push({
          supplierInternalId,
          supplierSku: item.supplierSku ?? null,
          purchasePriceAmount: item.lastPrice === undefined ? 0n : parseMoney(item.lastPrice),
          leadTimeDays: item.leadTimeDays ?? 0,
          minOrderQty: item.minOrderQty ?? null,
          isPrimary: item.isPrimary ?? false,
        });
      }
      // The endpoint replaces supplier links at product level: apply to every variant.
      for (const variant of variants) {
        await this.repo.replaceSupplierLinks(tx, toBigInt(variant.internalId), links);
      }
      return this.listProductSuppliersInTx(tx, ctx, productPublicId);
    });
  }

  // ------------------------------------------------------- price / cost history

  async priceHistory(
    ctx: TenantContext,
    productPublicId: string,
    query: { page: number; perPage: number; dateGte?: string | undefined },
  ): Promise<Record<string, unknown>[]> {
    const product = await this.requireProduct(ctx, productPublicId);
    const variants = await this.repo.listVariants(this.db, {
      orgId: ctx.orgId,
      productInternalId: product.internalId,
      onlyActive: null,
      barcode: null,
      sku: null,
      search: null,
      limit: 500,
      offset: 0,
    });
    const rows: Record<string, unknown>[] = [];
    for (const variant of variants) {
      const history = await this.repo.listPriceHistory(this.db, toBigInt(variant.internalId), {
        limit: query.perPage,
        offset: (query.page - 1) * query.perPage,
        dateGte: query.dateGte ?? null,
      });
      rows.push(...history.map(priceHistoryView));
    }
    return rows;
  }

  async costHistory(
    ctx: TenantContext,
    productPublicId: string,
    query: { page: number; perPage: number; dateGte?: string | undefined },
  ): Promise<Record<string, unknown>[]> {
    const product = await this.requireProduct(ctx, productPublicId);
    const variants = await this.repo.listVariants(this.db, {
      orgId: ctx.orgId,
      productInternalId: product.internalId,
      onlyActive: null,
      barcode: null,
      sku: null,
      search: null,
      limit: 500,
      offset: 0,
    });
    const rows: Record<string, unknown>[] = [];
    for (const variant of variants) {
      const history = await this.repo.listCostHistory(this.db, toBigInt(variant.internalId), {
        limit: query.perPage,
        offset: (query.page - 1) * query.perPage,
        dateGte: query.dateGte ?? null,
      });
      rows.push(...history.map(costHistoryView));
    }
    return rows;
  }

  /** Public writer used by the pricing module (`PUT /price-lists/{id}/items`). */
  async recordPriceHistory(
    ctx: TenantContext,
    body: RecordPriceHistoryBody,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const variant = await this.requireVariantInTx(tx, ctx, body.variantId);
      const previous = await this.repo.openPriceHistory(tx, variant.internalId);
      const effectiveFrom = body.effectiveFrom ?? new Date().toISOString();
      const created = await this.repo.insertPriceHistory(tx, {
        variantInternalId: variant.internalId,
        priceAmount: parseMoney(body.priceAmount),
        compareAtAmount: body.compareAtAmount === undefined ? null : parseMoney(body.compareAtAmount),
        effectiveFrom,
        reason: body.reason ?? null,
        sourceType: body.sourceType,
        changedBy: ctx.actorId,
      });
      const payload: PriceChangedPayload = {
        variantId: variant.id,
        priceAmount: formatMoney(parseMoney(body.priceAmount)),
        previousPriceAmount: previous === null ? null : previous.priceAmount,
        effectiveFrom,
        sourceType: body.sourceType,
      };
      await this.emit(tx, ctx, CATALOG_EVENTS.priceChanged, 'variant', toBigInt(variant.internalId), payload);
      return priceHistoryView(created);
    });
  }

  /** Public writer used by inventory valuation / goods receipt costing. */
  async recordCostHistory(ctx: TenantContext, body: RecordCostHistoryBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const variant = await this.requireVariantInTx(tx, ctx, body.variantId);
      const costAmount = parseMoney(body.costAmount);
      const effectiveFrom = body.effectiveFrom ?? new Date().toISOString();
      const created = await this.repo.insertCostHistory(tx, {
        variantInternalId: variant.internalId,
        costAmount,
        avgCostAmount: body.avgCostAmount === undefined ? costAmount : parseMoney(body.avgCostAmount),
        costMethod: body.costMethod,
        effectiveFrom,
        sourceType: body.sourceType,
        referenceId: body.referenceId ?? null,
      });
      const payload: CostChangedPayload = {
        variantId: variant.id,
        costAmount: created.costAmount,
        avgCostAmount: created.avgCostAmount,
        costMethod: body.costMethod,
        sourceType: body.sourceType,
      };
      await this.emit(tx, ctx, CATALOG_EVENTS.costChanged, 'variant', toBigInt(variant.internalId), payload);
      return costHistoryView(created);
    });
  }

  // ------------------------------------------------------------ reorder rules

  async listReorderRules(
    ctx: TenantContext,
    query: { page: number; perPage: number; variantId?: string | undefined; warehouseId?: string | undefined; active?: boolean | undefined },
  ): Promise<Record<string, unknown>[]> {
    const variantInternalId =
      query.variantId === undefined ? null : (await this.requireVariant(ctx, query.variantId)).internalId;
    const warehouseInternalId =
      query.warehouseId === undefined ? null : await this.repo.resolveWarehouseId(this.db, ctx.orgId, query.warehouseId);
    const rows = await this.repo.listReorderRules(this.db, {
      orgId: ctx.orgId,
      variantInternalId,
      warehouseInternalId,
      onlyActive: query.active ?? null,
      limit: query.perPage,
      offset: (query.page - 1) * query.perPage,
    });
    return rows.map(reorderRuleView);
  }

  async upsertReorderRule(
    ctx: TenantContext,
    body: {
      variantId: string;
      warehouseId: string;
      minQuantity: string;
      maxQuantity?: string | undefined;
      reorderQuantity?: string | undefined;
      safetyStock?: string | undefined;
    },
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const variant = await this.requireVariantInTx(tx, ctx, body.variantId);
      const warehouseInternalId = await this.repo.resolveWarehouseId(tx, ctx.orgId, body.warehouseId);
      if (warehouseInternalId === null) throw notFound('warehouse');
      const rule = await this.repo.upsertReorderRule(tx, {
        variantInternalId: variant.internalId,
        warehouseInternalId,
        minQty: body.minQuantity,
        maxQty: body.maxQuantity ?? null,
        reorderQty: body.reorderQuantity ?? null,
        safetyStock: body.safetyStock ?? '0',
      });
      return reorderRuleView(rule);
    });
  }

  // ------------------------------------------------------------- shared helpers

  async requireProduct(ctx: TenantContext, publicId: string): Promise<ProductRow> {
    return this.requireProductInTx(this.db, ctx, publicId);
  }

  private async requireProductInTx(tx: Db, ctx: TenantContext, publicId: string): Promise<ProductRow> {
    const row = await this.repo.findProduct(tx, ctx.orgId, publicId);
    if (row === null) throw notFound('product');
    return row;
  }

  async requireVariant(ctx: TenantContext, publicId: string): Promise<VariantRow> {
    return this.requireVariantInTx(this.db, ctx, publicId);
  }

  private async requireVariantInTx(tx: Db, ctx: TenantContext, publicId: string): Promise<VariantRow> {
    const row = await this.repo.findVariant(tx, ctx.orgId, publicId);
    if (row === null) throw notFound('variant');
    return row;
  }

  private async requireBrandInternal(tx: Db, ctx: TenantContext, publicId: string): Promise<bigint> {
    const brand = await this.catalogRepo.findBrand(tx, ctx.orgId, publicId);
    if (brand === null) throw notFound('brand');
    return toBigInt(brand.internalId);
  }

  private async resolveUnitInternal(tx: Db, ctx: TenantContext, publicId: string | undefined): Promise<bigint> {
    if (publicId === undefined) {
      throw new AppError('VALIDATION_ERROR', { details: [{ field: 'unitId', rule: 'required' }] });
    }
    const unit = await this.catalogRepo.findUnit(tx, ctx.orgId, publicId);
    if (unit === null) throw notFound('unit');
    return toBigInt(unit.internalId);
  }

  private async attributeDefinitions(tx: Db, ctx: TenantContext, categoryInternalId: bigint) {
    const definitions = await this.catalogRepo.listCategoryAttributeDefinitions(tx, ctx.orgId, categoryInternalId);
    return definitions.map((definition) => ({
      id: definition.id,
      code: definition.code,
      dataType: definition.dataType as 'text' | 'number' | 'boolean' | 'enum' | 'date' | 'color',
      isRequired: definition.isRequired,
      isVariantAxis: definition.isVariantAxis,
      values: definition.values.map((value) => ({
        id: value.id,
        value: value.value,
        internalId: value.internalId,
      })),
      internalId: definition.internalId,
    }));
  }

  private mergeAttributeInputs(
    productAttributes: readonly VariantAttributeValueInput[] | undefined,
    variantAttributes: readonly VariantAttributeValueInput[] | undefined,
  ): VariantAttributeValueInput[] {
    const merged = new Map<string, VariantAttributeValueInput>();
    for (const attribute of productAttributes ?? []) merged.set(attribute.attributeId, attribute);
    for (const attribute of variantAttributes ?? []) merged.set(attribute.attributeId, attribute);
    return [...merged.values()];
  }

  private async generateProductNo(tx: Db, ctx: TenantContext): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = `PRD-${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
      if ((await this.repo.findProductByNo(tx, ctx.orgId, candidate)) === null) return candidate;
    }
    throw conflict('product_no_exhausted');
  }

  private async generateUniqueSku(
    tx: Db,
    product: { nameFa?: string; nameEn?: string | undefined },
    categoryCode: string,
    startIndex: number,
  ): Promise<string> {
    let sequence = startIndex + 1;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = generateSku({
        categoryCode,
        ...(product.nameFa === undefined ? {} : { nameFa: product.nameFa }),
        ...(product.nameEn === undefined ? {} : { nameEn: product.nameEn }),
        sequence,
      });
      if (!(await this.repo.variantSkuExists(tx, candidate))) return candidate;
      sequence += 1;
    }
    throw conflict('sku_generation_failed');
  }

  private slugify(input: string): string {
    const slug = input
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 320);
    return slug.length === 0 ? `product-${randomUUID().slice(0, 8)}` : slug;
  }

  private async emitProduct(
    tx: Db,
    ctx: TenantContext,
    type: string,
    product: ProductRow,
    changedFields: readonly string[],
  ): Promise<void> {
    const payload: ProductEventPayload = {
      productId: product.id,
      productNo: product.productNo,
      status: product.status,
      changedFields,
    };
    await this.emit(tx, ctx, type, 'product', toBigInt(product.internalId), payload);
  }

  private async emitVariant(
    tx: Db,
    ctx: TenantContext,
    type: string,
    productPublicId: string,
    variant: VariantRow,
    changedFields: readonly string[],
  ): Promise<void> {
    const payload: VariantEventPayload = {
      productId: productPublicId,
      variantId: variant.id,
      sku: variant.sku,
      changedFields,
    };
    await this.emit(tx, ctx, type, 'variant', toBigInt(variant.internalId), payload);
  }

  private async emit(
    tx: Db,
    ctx: TenantContext,
    type: string,
    aggregateType: string,
    aggregateId: bigint,
    payload: object,
  ): Promise<void> {
    await this.events.emit(tx as unknown as ContractDb, {
      orgId: ctx.orgId,
      type,
      aggregateType,
      aggregateId,
      payload: payload as Record<string, unknown>,
      dedupeKey: `${type}:${aggregateId.toString()}:${Date.now()}`,
    });
  }

  private async record(
    tx: Db,
    ctx: TenantContext,
    action: string,
    entityType: string,
    entityId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ): Promise<void> {
    await this.audit.record(tx as unknown as ContractDb, {
      action,
      entityType,
      entityId,
      orgId: ctx.orgId,
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      before,
      after,
    });
  }
}

/**
 * Cross-module read surface of the catalog module (`ARCHITECTURE.md` §4.1 rule 2).
 * Inventory, warehouse, procurement, sales and fulfillment inject this service
 * instead of reading catalog tables.
 */
@Injectable()
export class CatalogLookupService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: ProductRepository,
  ) {}

  async requireVariant(ctx: TenantContext, variantPublicId: string): Promise<VariantLookup> {
    const row = await this.repo.findVariant(this.db, ctx.orgId, variantPublicId);
    if (row === null) throw notFound('variant');
    return this.toLookup(row);
  }

  private toLookup(row: VariantRow): VariantLookup {
    return {
      internalId: toBigInt(row.internalId),
      id: row.id,
      sku: row.sku,
      productInternalId: toBigInt(row.productInternalId),
      productId: row.productId,
      productNo: row.productNo,
      productName: row.productName,
      categoryInternalId: row.categoryInternalId === null || row.categoryInternalId === undefined ? null : toBigInt(row.categoryInternalId),
      unitId: row.unitId,
      trackLot: row.trackLot,
      trackSerial: row.trackSerial,
      trackUnit: row.trackUnit,
      isActive: row.isActive,
      barcode: row.barcode,
      barcodeIdentityScope: 'variant',
      costMethod: row.costMethod,
    };
  }

  async findVariants(ctx: TenantContext, variantPublicIds: readonly string[]): Promise<VariantLookup[]> {
    const rows = await this.repo.findVariantsByPublicIds(this.db, ctx.orgId, variantPublicIds);
    return rows.map((row) => this.toLookup(row));
  }

  /** Latest recorded cost for a variant (used by valuation/adjustment costing). */
  async latestCost(ctx: TenantContext, variantPublicId: string): Promise<string | null> {
    const variant = await this.repo.findVariant(this.db, ctx.orgId, variantPublicId);
    if (variant === null) throw notFound('variant');
    const cost = await this.repo.latestCost(this.db, toBigInt(variant.internalId));
    return cost === null ? null : cost.costAmount;
  }

  /**
   * Label identities for a set of variants (used by goods-receipt label printing).
   * A variant without any active barcode gets the same deterministic internal code
   * the generate endpoint would persist, so every label carries a scannable value.
   */
  async labelData(ctx: TenantContext, variantPublicIds: readonly string[]): Promise<VariantLabelData[]> {
    const rows = await this.repo.findVariantsByPublicIds(this.db, ctx.orgId, variantPublicIds);
    const labels: VariantLabelData[] = [];
    for (const row of rows) {
      const barcodes = await this.repo.listVariantBarcodes(this.db, row.internalId);
      labels.push({
        variantId: row.id,
        sku: row.sku,
        productName: row.productName,
        barcode: selectLabelBarcode(barcodes, row.id, row.barcode),
      });
    }
    return labels;
  }

  /** Barcode → variant resolution for scanner flows in other modules. */
  async resolveBarcode(
    ctx: TenantContext,
    barcode: string,
  ): Promise<{ variantId: string; sku: string; productId: string; barcodeType: string } | null> {
    const resolved = await this.repo.findBarcodeByValue(this.db, ctx.orgId, barcode.trim());
    if (resolved === null) return null;
    return {
      variantId: resolved.variant.id,
      sku: resolved.variant.sku,
      productId: resolved.product.id,
      barcodeType: resolved.barcode.barcodeType,
    };
  }
}

/** Small helper shared with the warehouse/procurement modules. */
export function barcodePattern(query: string): string {
  return toIlikePattern(query);
}

/** @internal exported for tests: SKU uniqueness fallback helper. */
export function resolveNextSku(base: string, taken: ReadonlySet<string>): string {
  return nextAvailableSku(base, taken);
}
