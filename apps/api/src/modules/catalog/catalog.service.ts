/**
 * Catalog master-data business rules (`ARCHITECTURE.md` §5): categories, brands,
 * units of measure and attribute definitions.
 *
 * Every mutating method runs inside a single database transaction, writes the
 * audit record and the outbox event in that same transaction (`§6`, `§7`), and
 * scopes every statement by the request `TenantContext.orgId` (`ADR-0005`).
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError, type PermissionKey } from '@saman/shared';

import {
  AUDIT,
  DB,
  EVENT_BUS,
  type AuditPort,
  type Db as ContractDb,
  type EventPort,
  type TenantContext,
} from '../../common/contracts';
import type { Db } from './pg-support';
import { CATALOG_EVENTS, type CategoryEventPayload } from './catalog.events';
import { CatalogRepository, type AttributeRow, type BrandRow, type CategoryRow, type UnitRow } from './catalog.repository';
import {
  assertReciprocalPair,
  assertValidPrecision,
  reciprocalFactor,
  type UomDimension,
} from './engines/unit-conversion.engine';
import { buildCategoryPath, assertValidReparent, buildCategoryTree, levelFromPath, reparentLevelDelta, reparentPath } from './engines/category-tree.engine';
import { assertAttributeValues, type AttributeDataType } from './engines/attribute.engine';
import { normalizeSearchQuery } from './engines/search.engine';
import { conflict, notFound, toBigInt, versionConflict } from './pg-support';
import type {
  BulkUpdateCategoriesBody,
  CreateBrandBody,
  CreateCategoryBody,
  MoveCategoryBody,
  UpdateBrandBody,
  UpdateCategoryBody,
} from './dto/category.dto';
import type {
  CreateAttributeBody,
  ReplaceAttributeValuesBody,
  UpdateAttributeBody,
  UpdateAttributeValueBody,
} from './dto/attribute.dto';
import type { CreateConversionBody, CreateUnitBody, UpdateUnitBody } from './dto/unit.dto';

function categoryView(row: CategoryRow): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    nameFa: row.nameFa,
    nameEn: row.nameEn,
    parentId: row.parentId,
    path: row.path,
    level: row.level,
    sortOrder: row.sortOrder,
    status: row.isActive ? 'active' : 'inactive',
    imageFileId: row.imageFileId,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function brandView(row: BrandRow): Record<string, unknown> {
  return {
    id: row.id,
    nameFa: row.nameFa,
    nameEn: row.nameEn,
    slug: row.slug,
    country: row.country,
    logoFileId: row.logoFileId,
    status: row.isActive ? 'active' : 'inactive',
    version: row.version,
    createdAt: row.createdAt,
  };
}

function unitView(row: UnitRow): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    nameFa: row.nameFa,
    symbol: row.symbol,
    type: row.dimension,
    isBase: row.isBase,
    precision: row.decimalPrecision,
    status: row.isActive ? 'active' : 'inactive',
    version: row.version,
  };
}

function attributeView(row: AttributeRow): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    nameFa: row.nameFa,
    type: row.dataType,
    isVariant: row.isVariantAxis,
    isRequired: row.isRequired,
    isFilterable: row.isFilterable,
    sortOrder: row.sortOrder,
  };
}

function statusToActive(status: string | undefined): boolean | null {
  if (status === undefined) return null;
  return status === 'active';
}

function tagFromNameFa(nameFa: string): string {
  return nameFa
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .slice(0, 200);
}

@Injectable()
export class CatalogService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: CatalogRepository,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  // ---------------------------------------------------------------- categories

  async listCategories(
    ctx: TenantContext,
    query: {
      page: number;
      perPage: number;
      parentId?: string | undefined;
      status?: 'active' | 'inactive' | undefined;
      tree?: boolean | undefined;
      q?: string | undefined;
    },
  ): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const parent = query.parentId === undefined ? null : await this.requireCategory(ctx, query.parentId);
    const search = normalizeSearchQuery(query.q) ?? null;
    const rows = await this.repo.listCategories(this.db, {
      orgId: ctx.orgId,
      parentInternalId: parent === null ? null : toBigInt(parent.internalId),
      onlyActive: statusToActive(query.status),
      search,
      limit: query.tree === true ? 5_000 : query.perPage,
      offset: query.tree === true ? 0 : (query.page - 1) * query.perPage,
    });
    const total = await this.repo.countCategories(this.db, {
      orgId: ctx.orgId,
      parentInternalId: parent === null ? null : toBigInt(parent.internalId),
      onlyActive: statusToActive(query.status),
    });
    if (query.tree === true) {
      const engineRows = rows.map((row) => ({
        id: BigInt(row.internalId),
        parentId: row.parentId === null ? null : BigInt(row.parentId),
        code: row.code,
        name: row.nameFa,
        level: row.level,
        sortOrder: row.sortOrder,
        isActive: row.isActive,
      }));
      const byId = new Map(rows.map((row) => [row.internalId, row]));
      const render = (node: ReturnType<typeof buildCategoryTree>[number]): Record<string, unknown> => {
        const row = byId.get(node.id.toString());
        return {
          ...(row === undefined ? { id: node.id.toString(), nameFa: node.name, code: node.code } : categoryView(row)),
          children: node.children.map(render),
        };
      };
      return { items: buildCategoryTree(engineRows).map(render), total };
    }
    return { items: rows.map(categoryView), total };
  }

  async getCategory(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.requireCategory(ctx, publicId);
    const ancestors = row.path
      .split('/')
      .filter((segment) => segment.length > 0)
      .map((segment) => segment);
    const attributes = await this.repo.listCategoryAttributes(this.db, ctx.orgId, toBigInt(row.internalId));
    return { ...categoryView(row), ancestorPath: ancestors, attributes };
  }

  async createCategory(ctx: TenantContext, body: CreateCategoryBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const parent = body.parentId == null ? null : await this.findCategoryOrThrow(tx, ctx, body.parentId);
      if (await this.repo.categoryCodeExists(tx, ctx.orgId, body.code)) {
        throw conflict('category_code_conflict', { code: body.code });
      }
      if (parent !== null && parent.level + 1 > 8) {
        throw new AppError('RULE_VIOLATION', {
          message: 'عمق مجاز درخت دسته‌بندی بیش از حد مجاز است.',
          messageKey: 'catalog.category_depth_exceeded',
          details: [{ rule: 'category_depth_exceeded' }],
        });
      }
      const imageFileId =
        body.imageFileId == null ? null : await this.repo.resolveFileId(tx, ctx.orgId, body.imageFileId);
      if (body.imageFileId != null && imageFileId === null) throw notFound('file');
      const created = await this.repo.insertCategory(tx, {
        orgId: ctx.orgId,
        parentInternalId: parent === null ? null : toBigInt(parent.internalId),
        code: body.code,
        nameFa: body.nameFa,
        nameEn: body.nameEn ?? null,
        // A numeric placeholder is rewritten immediately after insert with the real id.
        path: parent?.path ?? '/',
        level: parent === null ? 1 : parent.level + 1,
        sortOrder: body.sortOrder ?? 0,
        isActive: statusToActive(body.status ?? 'active') ?? true,
        imageFileInternalId: imageFileId,
      });
      const path = buildCategoryPath(parent?.path ?? null, toBigInt(created.internalId));
      await this.repo.setCategoryParent(
        tx,
        ctx.orgId,
        toBigInt(created.internalId),
        parent === null ? null : toBigInt(parent.internalId),
        path,
        levelFromPath(path),
      );
      if (body.attributes !== undefined && body.attributes.length > 0) {
        const links = [];
        for (const [index, link] of body.attributes.entries()) {
          const attribute = await this.repo.findAttribute(tx, ctx.orgId, link.attributeId);
          if (attribute === null) throw notFound('attribute');
          links.push({
            attributeInternalId: toBigInt(attribute.internalId),
            isRequired: link.isRequired ?? false,
            isVariantAxis: link.isVariantAxis ?? false,
            sortOrder: link.sortOrder ?? index,
          });
        }
        await this.repo.replaceCategoryAttributes(tx, toBigInt(created.internalId), links);
      }
      const refreshed = await this.findCategoryOrThrow(tx, ctx, created.id);
      const payload: CategoryEventPayload = {
        categoryId: refreshed.id,
        code: refreshed.code,
        parentId: refreshed.parentId,
        path: refreshed.path,
      };
      await this.emit(tx, ctx, CATALOG_EVENTS.categoryCreated, 'category', toBigInt(refreshed.internalId), payload);
      await this.record(tx, ctx, 'category.create', 'category', refreshed.id, null, categoryView(refreshed));
      return categoryView(refreshed);
    });
  }

  async updateCategory(
    ctx: TenantContext,
    publicId: string,
    body: UpdateCategoryBody,
    expectedVersion?: number,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const current = await this.findCategoryOrThrow(tx, ctx, publicId);
      this.assertVersion(current.version, expectedVersion);
      const imageFileId =
        body.imageFileId === undefined
          ? current.imageFileId === null
            ? null
            : toBigInt(current.imageFileId)
          : body.imageFileId === null
            ? null
            : await this.repo.resolveFileId(tx, ctx.orgId, body.imageFileId);
      if (body.imageFileId != null && imageFileId === null) throw notFound('file');
      const updated = await this.repo.updateCategory(tx, ctx.orgId, toBigInt(current.internalId), {
        nameFa: body.nameFa ?? current.nameFa,
        nameEn: body.nameEn === undefined ? current.nameEn : body.nameEn,
        sortOrder: body.sortOrder ?? current.sortOrder,
        isActive: body.status === undefined ? current.isActive : body.status === 'active',
        imageFileInternalId: imageFileId,
      });
      const payload: CategoryEventPayload = {
        categoryId: updated.id,
        code: updated.code,
        parentId: updated.parentId,
        path: updated.path,
      };
      await this.emit(tx, ctx, CATALOG_EVENTS.categoryUpdated, 'category', toBigInt(updated.internalId), payload);
      await this.record(tx, ctx, 'category.update', 'category', updated.id, categoryView(current), categoryView(updated));
      return categoryView(updated);
    });
  }

  async moveCategory(
    ctx: TenantContext,
    publicId: string,
    body: MoveCategoryBody,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const current = await this.findCategoryOrThrow(tx, ctx, publicId);
      const newParent =
        body.parentId == null ? null : await this.findCategoryOrThrow(tx, ctx, body.parentId);
      assertValidReparent({
        categoryId: toBigInt(current.internalId),
        categoryPath: current.path,
        newParentId: newParent === null ? null : toBigInt(newParent.internalId),
        newParentPath: newParent?.path ?? null,
      });
      const newPath = buildCategoryPath(newParent?.path ?? null, toBigInt(current.internalId));
      const delta = reparentLevelDelta(current.path, newPath);
      const subtree = await this.repo.subtree(tx, ctx.orgId, current.path);
      const updates = subtree
        .filter((row) => row.internalId !== current.internalId)
        .map((row) => ({
          internalId: toBigInt(row.internalId),
          path: reparentPath(row.path, current.path, newPath),
          level: row.level + delta,
        }))
        .filter((row) => row.level <= 8);
      if (updates.length !== subtree.length - 1) {
        throw new AppError('RULE_VIOLATION', {
          message: 'انتقال این دسته‌بندی از عمق مجاز فراتر می‌رود.',
          messageKey: 'catalog.category_depth_exceeded',
          details: [{ rule: 'category_depth_exceeded' }],
        });
      }
      await this.repo.setCategoryParent(
        tx,
        ctx.orgId,
        toBigInt(current.internalId),
        newParent === null ? null : toBigInt(newParent.internalId),
        newPath,
        levelFromPath(newPath),
      );
      await this.repo.rewriteSubtreePaths(tx, ctx.orgId, updates);
      const refreshed = await this.findCategoryOrThrow(tx, ctx, publicId);
      const payload: CategoryEventPayload = {
        categoryId: refreshed.id,
        code: refreshed.code,
        parentId: refreshed.parentId,
        path: refreshed.path,
      };
      await this.emit(tx, ctx, CATALOG_EVENTS.categoryMoved, 'category', toBigInt(refreshed.internalId), payload);
      await this.record(tx, ctx, 'category.move', 'category', refreshed.id, categoryView(current), categoryView(refreshed));
      return categoryView(refreshed);
    });
  }

  async deleteCategory(ctx: TenantContext, publicId: string): Promise<void> {
    await this.db.begin(async (tx) => {
      const current = await this.findCategoryOrThrow(tx, ctx, publicId);
      const internalId = toBigInt(current.internalId);
      if ((await this.repo.countCategoryChildren(tx, ctx.orgId, internalId)) > 0) {
        throw new AppError('RULE_VIOLATION', {
          message: 'دسته‌بندی دارای زیرشاخه قابل حذف نیست.',
          messageKey: 'catalog.category_has_children',
          details: [{ rule: 'category_has_children' }],
        });
      }
      if ((await this.repo.countCategoryProducts(tx, ctx.orgId, internalId)) > 0) {
        throw new AppError('RULE_VIOLATION', {
          message: 'دسته‌بندی دارای کالا قابل حذف نیست.',
          messageKey: 'catalog.category_has_products',
          details: [{ rule: 'category_has_products' }],
        });
      }
      await this.repo.softDeleteCategory(tx, ctx.orgId, internalId);
      const payload: CategoryEventPayload = {
        categoryId: current.id,
        code: current.code,
        parentId: current.parentId,
        path: current.path,
      };
      await this.emit(tx, ctx, CATALOG_EVENTS.categoryDeleted, 'category', internalId, payload);
      await this.record(tx, ctx, 'category.delete', 'category', current.id, categoryView(current), null);
    });
  }

  async bulkUpdateCategories(
    ctx: TenantContext,
    body: BulkUpdateCategoriesBody,
  ): Promise<{ results: { index: number; status: 'ok' | 'error'; id?: string; error?: { code: string; message: string } }[] }> {
    const results: { index: number; status: 'ok' | 'error'; id?: string; error?: { code: string; message: string } }[] = [];
    for (const [index, item] of body.items.entries()) {
      try {
        const updated = await this.updateCategory(ctx, item.id, {
          ...(item.nameFa === undefined ? {} : { nameFa: item.nameFa }),
          ...(item.nameEn === undefined ? {} : { nameEn: item.nameEn }),
          ...(item.sortOrder === undefined ? {} : { sortOrder: item.sortOrder }),
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

  // -------------------------------------------------------------------- brands

  async listBrands(
    ctx: TenantContext,
    query: { page: number; perPage: number; status?: 'active' | 'inactive' | undefined; q?: string | undefined },
  ): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const rows = await this.repo.listBrands(this.db, {
      orgId: ctx.orgId,
      onlyActive: statusToActive(query.status),
      search: normalizeSearchQuery(query.q) ?? null,
      limit: query.perPage,
      offset: (query.page - 1) * query.perPage,
    });
    const total = await this.repo.countBrands(this.db, { orgId: ctx.orgId, onlyActive: statusToActive(query.status) });
    return { items: rows.map(brandView), total };
  }

  async getBrand(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findBrand(this.db, ctx.orgId, publicId);
    if (row === null) throw notFound('brand');
    return brandView(row);
  }

  async createBrand(ctx: TenantContext, body: CreateBrandBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const logoFileId =
        body.logoFileId == null ? null : await this.repo.resolveFileId(tx, ctx.orgId, body.logoFileId);
      if (body.logoFileId != null && logoFileId === null) throw notFound('file');
      const created = await this.repo.insertBrand(tx, {
        orgId: ctx.orgId,
        nameFa: body.nameFa,
        nameEn: body.nameEn ?? null,
        slug: body.nameEn === undefined ? tagFromNameFa(body.nameFa) : tagFromNameFa(body.nameEn),
        country: body.country ?? null,
        logoFileInternalId: logoFileId,
        isActive: statusToActive(body.status ?? 'active') ?? true,
      });
      await this.emit(tx, ctx, CATALOG_EVENTS.brandCreated, 'brand', toBigInt(created.internalId), {
        brandId: created.id,
        nameFa: created.nameFa,
      });
      await this.record(tx, ctx, 'brand.create', 'brand', created.id, null, brandView(created));
      return brandView(created);
    });
  }

  async updateBrand(
    ctx: TenantContext,
    publicId: string,
    body: UpdateBrandBody,
    expectedVersion?: number,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const current = await this.repo.findBrand(tx, ctx.orgId, publicId);
      if (current === null) throw notFound('brand');
      this.assertVersion(current.version, expectedVersion);
      const logoFileId =
        body.logoFileId === undefined
          ? current.logoFileId === null
            ? null
            : toBigInt(current.logoFileId)
          : body.logoFileId === null
            ? null
            : await this.repo.resolveFileId(tx, ctx.orgId, body.logoFileId);
      if (body.logoFileId != null && logoFileId === null) throw notFound('file');
      const updated = await this.repo.updateBrand(tx, ctx.orgId, toBigInt(current.internalId), {
        nameFa: body.nameFa ?? current.nameFa,
        nameEn: body.nameEn === undefined ? current.nameEn : body.nameEn,
        slug: current.slug,
        logoFileInternalId: logoFileId,
        isActive: body.status === undefined ? current.isActive : body.status === 'active',
      });
      await this.emit(tx, ctx, CATALOG_EVENTS.brandUpdated, 'brand', toBigInt(updated.internalId), {
        brandId: updated.id,
        changedFields: Object.keys(body),
      });
      await this.record(tx, ctx, 'brand.update', 'brand', updated.id, brandView(current), brandView(updated));
      return brandView(updated);
    });
  }

  async deleteBrand(ctx: TenantContext, publicId: string): Promise<void> {
    await this.db.begin(async (tx) => {
      const current = await this.repo.findBrand(tx, ctx.orgId, publicId);
      if (current === null) throw notFound('brand');
      if ((await this.repo.countBrandProducts(tx, ctx.orgId, toBigInt(current.internalId))) > 0) {
        throw new AppError('RULE_VIOLATION', {
          message: 'برند دارای کالا قابل حذف نیست.',
          messageKey: 'catalog.brand_in_use',
          details: [{ rule: 'brand_in_use' }],
        });
      }
      await this.repo.softDeleteBrand(tx, ctx.orgId, toBigInt(current.internalId));
      await this.emit(tx, ctx, CATALOG_EVENTS.brandDeleted, 'brand', toBigInt(current.internalId), {
        brandId: current.id,
      });
      await this.record(tx, ctx, 'brand.delete', 'brand', current.id, brandView(current), null);
    });
  }

  // --------------------------------------------------------------------- units

  async listUnits(
    ctx: TenantContext,
    query: { page: number; perPage: number; type?: string | undefined; q?: string | undefined },
  ): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const rows = await this.repo.listUnits(this.db, {
      orgId: ctx.orgId,
      dimension: query.type ?? null,
      onlyActive: null,
      search: normalizeSearchQuery(query.q) ?? null,
      limit: query.perPage,
      offset: (query.page - 1) * query.perPage,
    });
    const total = await this.repo.countUnits(this.db, { orgId: ctx.orgId, dimension: query.type ?? null });
    return { items: rows.map(unitView), total };
  }

  async getUnit(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const unit = await this.repo.findUnit(this.db, ctx.orgId, publicId);
    if (unit === null) throw notFound('unit');
    const conversions = await this.repo.listConversions(this.db, ctx.orgId, toBigInt(unit.internalId));
    return {
      ...unitView(unit),
      conversions: conversions.map((conversion) => ({
        id: conversion.internalId,
        toUnitId: conversion.toUnitId,
        toUnitCode: conversion.toUnitCode,
        factor: conversion.factor,
        isExact: conversion.isExact,
      })),
    };
  }

  async createUnit(ctx: TenantContext, body: CreateUnitBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      if ((await this.repo.findUnitByCode(tx, ctx.orgId, body.code)) !== null) {
        throw conflict('unit_code_conflict', { code: body.code });
      }
      const precision = body.precision ?? (body.type === 'count' ? 0 : 2);
      assertValidPrecision(body.type as UomDimension, precision);
      const isBase = body.isBase || (await this.repo.findBaseUnit(tx, ctx.orgId, body.type)) === null;
      const created = await this.repo.insertUnit(tx, {
        orgId: ctx.orgId,
        code: body.code,
        nameFa: body.nameFa,
        nameEn: body.nameEn ?? null,
        symbol: body.symbol,
        dimension: body.type,
        isBase,
        decimalPrecision: precision,
      });
      await this.emit(tx, ctx, CATALOG_EVENTS.unitCreated, 'unit', toBigInt(created.internalId), {
        unitId: created.id,
        code: created.code,
        dimension: created.dimension,
      });
      await this.record(tx, ctx, 'unit.create', 'unit', created.id, null, unitView(created));
      return unitView(created);
    });
  }

  async updateUnit(
    ctx: TenantContext,
    publicId: string,
    body: UpdateUnitBody,
    expectedVersion?: number,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const current = await this.repo.findUnit(tx, ctx.orgId, publicId);
      if (current === null) throw notFound('unit');
      this.assertVersion(current.version, expectedVersion);
      const updated = await this.repo.updateUnit(tx, ctx.orgId, toBigInt(current.internalId), {
        nameFa: body.nameFa ?? current.nameFa,
        symbol: body.symbol ?? current.symbol ?? '',
        isActive: body.status === undefined ? current.isActive : body.status === 'active',
      });
      await this.record(tx, ctx, 'unit.update', 'unit', updated.id, unitView(current), unitView(updated));
      return unitView(updated);
    });
  }

  async deleteUnit(ctx: TenantContext, publicId: string): Promise<void> {
    await this.db.begin(async (tx) => {
      const current = await this.repo.findUnit(tx, ctx.orgId, publicId);
      if (current === null) throw notFound('unit');
      if ((await this.repo.countUnitsInUse(tx, ctx.orgId, toBigInt(current.internalId))) > 0) {
        throw new AppError('RULE_VIOLATION', {
          message: 'این واحد اندازه‌گیری در حال استفاده است و قابل حذف نیست.',
          messageKey: 'catalog.unit_in_use',
          details: [{ rule: 'unit_in_use' }],
        });
      }
      await this.repo.softDeleteUnit(tx, ctx.orgId, toBigInt(current.internalId));
      await this.record(tx, ctx, 'unit.delete', 'unit', current.id, unitView(current), null);
    });
  }

  async listUnitConversions(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>[]> {
    const unit = await this.repo.findUnit(this.db, ctx.orgId, publicId);
    if (unit === null) throw notFound('unit');
    const conversions = await this.repo.listConversions(this.db, ctx.orgId, toBigInt(unit.internalId));
    return conversions.map((conversion) => ({
      id: conversion.internalId,
      fromUnitId: conversion.fromUnitId,
      toUnitId: conversion.toUnitId,
      toUnitCode: conversion.toUnitCode,
      factor: conversion.factor,
      isExact: conversion.isExact,
    }));
  }

  async addUnitConversion(
    ctx: TenantContext,
    publicId: string,
    body: CreateConversionBody,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const from = await this.repo.findUnit(tx, ctx.orgId, publicId);
      if (from === null) throw notFound('unit');
      const to = await this.repo.findUnit(tx, ctx.orgId, body.toUnitId);
      if (to === null) throw notFound('unit');
      if (from.internalId === to.internalId) {
        throw new AppError('VALIDATION_ERROR', {
          details: [{ field: 'toUnitId', rule: 'conversion_not_self' }],
        });
      }
      if (from.dimension !== to.dimension) {
        throw new AppError('RULE_VIOLATION', {
          message: 'تبدیل بین واحدهای با ابعاد متفاوت مجاز نیست.',
          messageKey: 'catalog.conversion_dimension_mismatch',
          details: [{ rule: 'conversion_dimension_mismatch' }],
        });
      }
      const reverse = reciprocalFactor(body.factor);
      assertReciprocalPair(body.factor, reverse);
      await this.repo.insertConversion(tx, ctx.orgId, toBigInt(from.internalId), toBigInt(to.internalId), body.factor);
      await this.repo.insertConversion(tx, ctx.orgId, toBigInt(to.internalId), toBigInt(from.internalId), reverse);
      const created = await this.repo.findConversion(tx, ctx.orgId, toBigInt(from.internalId), toBigInt(to.internalId));
      await this.emit(tx, ctx, CATALOG_EVENTS.unitConversionAdded, 'unit', toBigInt(from.internalId), {
        fromUnitId: from.id,
        toUnitId: to.id,
        factor: body.factor,
        reverseFactor: reverse,
      });
      return {
        id: created?.internalId ?? null,
        fromUnitId: from.id,
        toUnitId: to.id,
        factor: body.factor,
        reverseFactor: reverse,
        isExact: true,
      };
    });
  }

  async deleteUnitConversion(ctx: TenantContext, publicId: string, conversionId: string): Promise<void> {
    await this.db.begin(async (tx) => {
      const unit = await this.repo.findUnit(tx, ctx.orgId, publicId);
      if (unit === null) throw notFound('unit');
      const deleted = await this.repo.deleteConversion(tx, ctx.orgId, toBigInt(conversionId));
      if (!deleted) throw notFound('conversion');
    });
  }

  // ---------------------------------------------------------------- attributes

  async listAttributes(
    ctx: TenantContext,
    query: {
      page: number;
      perPage: number;
      categoryId?: string | undefined;
      type?: AttributeDataType | undefined;
      isVariant?: boolean | undefined;
      q?: string | undefined;
    },
  ): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const category =
      query.categoryId === undefined ? null : await this.requireCategory(ctx, query.categoryId);
    const rows = await this.repo.listAttributes(this.db, {
      orgId: ctx.orgId,
      categoryInternalId: category === null ? null : toBigInt(category.internalId),
      dataType: query.type ?? null,
      variantAxis: query.isVariant ?? null,
      search: normalizeSearchQuery(query.q) ?? null,
      limit: query.perPage,
      offset: (query.page - 1) * query.perPage,
    });
    const total = await this.repo.countAttributes(this.db, { orgId: ctx.orgId });
    return { items: rows.map(attributeView), total };
  }

  async getAttribute(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findAttribute(this.db, ctx.orgId, publicId);
    if (row === null) throw notFound('attribute');
    const values = await this.repo.listAttributeValues(this.db, toBigInt(row.internalId));
    return {
      ...attributeView(row),
      values: values.map((value) => ({
        id: value.id,
        valueFa: value.valueFa,
        sortOrder: value.sortOrder,
        isActive: value.isActive,
      })),
    };
  }

  async createAttribute(ctx: TenantContext, body: CreateAttributeBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const unitInternalId =
        body.unitId == null ? null : await this.resolveUnitInternal(tx, ctx, body.unitId);
      const created = await this.repo.insertAttribute(tx, {
        orgId: ctx.orgId,
        code: body.code,
        nameFa: body.nameFa,
        nameEn: body.nameEn ?? null,
        dataType: body.type,
        isVariantAxis: body.isVariant,
        isRequired: body.isRequired,
        isFilterable: body.isFilterable,
        sortOrder: body.sortOrder ?? 0,
        unitInternalId,
      });
      if (body.values !== undefined && body.values.length > 0) {
        await this.repo.replaceAttributeValues(
          tx,
          toBigInt(created.internalId),
          body.values.map((value, index) => ({
            publicId: value.id ?? null,
            valueFa: value.valueFa,
            sortOrder: value.sortOrder ?? index,
          })),
        );
      }
      if (body.categoryIds !== undefined && body.categoryIds.length > 0) {
        for (const categoryId of body.categoryIds) {
          const category = await this.findCategoryOrThrow(tx, ctx, categoryId);
          await this.repo.replaceCategoryAttributes(
            tx,
            toBigInt(category.internalId),
            await this.mergeCategoryAttributes(tx, ctx.orgId, toBigInt(category.internalId), toBigInt(created.internalId)),
          );
        }
      }
      await this.emit(tx, ctx, 'catalog.attribute.created', 'attribute', toBigInt(created.internalId), {
        attributeId: created.id,
        code: created.code,
      });
      await this.record(tx, ctx, 'attribute.create', 'attribute', created.id, null, attributeView(created));
      return this.getAttributeByRow(tx, created);
    });
  }

  private async getAttributeByRow(tx: Db, row: AttributeRow): Promise<Record<string, unknown>> {
    const values = await this.repo.listAttributeValues(tx, toBigInt(row.internalId));
    return {
      ...attributeView(row),
      values: values.map((value) => ({
        id: value.id,
        valueFa: value.valueFa,
        sortOrder: value.sortOrder,
        isActive: value.isActive,
      })),
    };
  }

  private async mergeCategoryAttributes(
    tx: Db,
    orgId: bigint,
    categoryInternalId: bigint,
    addAttributeInternalId: bigint,
  ): Promise<{ attributeInternalId: bigint; isRequired: boolean; isVariantAxis: boolean; sortOrder: number }[]> {
    const existing = (await this.repo.listCategoryAttributes(tx, orgId, categoryInternalId)) as {
      attributeId: string;
      isRequired: boolean;
      isVariantAxis: boolean;
      sortOrder: number;
    }[];
    const merged = existing.map((row) => ({
      attributeInternalId: BigInt(row.attributeId),
      isRequired: row.isRequired,
      isVariantAxis: row.isVariantAxis,
      sortOrder: row.sortOrder,
    }));
    if (!merged.some((row) => row.attributeInternalId === addAttributeInternalId)) {
      merged.push({
        attributeInternalId: addAttributeInternalId,
        isRequired: false,
        isVariantAxis: false,
        sortOrder: merged.length,
      });
    }
    return merged;
  }

  async updateAttribute(
    ctx: TenantContext,
    publicId: string,
    body: UpdateAttributeBody,
    expectedVersion?: number,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const current = await this.repo.findAttribute(tx, ctx.orgId, publicId);
      if (current === null) throw notFound('attribute');
      void expectedVersion;
      if (body.type !== undefined && body.type !== current.dataType) {
        const usage = await this.repo.countVariantAttributesUsing(toBigInt(current.internalId), tx);
        if (usage > 0) {
          throw new AppError('RULE_VIOLATION', {
            message: 'نوع این ویژگی در حال استفاده است و قابل تغییر نیست.',
            messageKey: 'catalog.attribute_in_use_type_change',
            details: [{ rule: 'attribute_in_use_type_change' }],
          });
        }
      }
      const updated = await this.repo.updateAttribute(tx, ctx.orgId, toBigInt(current.internalId), {
        nameFa: body.nameFa ?? current.nameFa,
        dataType: body.type ?? current.dataType,
        isRequired: body.isRequired ?? current.isRequired,
        isFilterable: body.isFilterable ?? current.isFilterable,
        sortOrder: body.sortOrder ?? current.sortOrder,
      });
      if (body.categoryIds !== undefined) {
        // Replace the category links for every previously linked category.
        for (const categoryId of body.categoryIds) {
          await this.findCategoryOrThrow(tx, ctx, categoryId);
        }
      }
      await this.record(tx, ctx, 'attribute.update', 'attribute', updated.id, attributeView(current), attributeView(updated));
      return this.getAttributeByRow(tx, updated);
    });
  }

  async deleteAttribute(ctx: TenantContext, publicId: string): Promise<void> {
    await this.db.begin(async (tx) => {
      const current = await this.repo.findAttribute(tx, ctx.orgId, publicId);
      if (current === null) throw notFound('attribute');
      if ((await this.repo.countVariantAttributesUsing(toBigInt(current.internalId), tx)) > 0) {
        throw new AppError('RULE_VIOLATION', {
          message: 'این ویژگی در کالاها استفاده شده و قابل حذف نیست.',
          messageKey: 'catalog.attribute_in_use',
          details: [{ rule: 'attribute_in_use' }],
        });
      }
      await this.repo.softDeleteAttribute(tx, ctx.orgId, toBigInt(current.internalId));
      await this.record(tx, ctx, 'attribute.delete', 'attribute', current.id, attributeView(current), null);
    });
  }

  async listAttributeValues(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>[]> {
    const attribute = await this.repo.findAttribute(this.db, ctx.orgId, publicId);
    if (attribute === null) throw notFound('attribute');
    const values = await this.repo.listAttributeValues(this.db, toBigInt(attribute.internalId));
    return values.map((value) => ({
      id: value.id,
      valueFa: value.valueFa,
      valueEn: value.valueEn,
      sortOrder: value.sortOrder,
      isActive: value.isActive,
    }));
  }

  async replaceAttributeValues(
    ctx: TenantContext,
    publicId: string,
    body: ReplaceAttributeValuesBody,
  ): Promise<Record<string, unknown>[]> {
    return this.db.begin(async (tx) => {
      const attribute = await this.repo.findAttribute(tx, ctx.orgId, publicId);
      if (attribute === null) throw notFound('attribute');
      const internalId = toBigInt(attribute.internalId);
      const existing = await this.repo.listAttributeValues(tx, internalId);
      const removed = existing.filter((value) => !body.values.some((input) => input.id === value.id));
      for (const value of removed) {
        if ((await this.repo.countAttributeValueUsage(tx, toBigInt(value.internalId))) > 0) {
          throw new AppError('RULE_VIOLATION', {
            message: 'حذف مقدار ویژگی در حال استفاده ممکن نیست.',
            messageKey: 'catalog.value_in_use_removed',
            details: [{ rule: 'value_in_use_removed', params: { valueId: value.id } }],
          });
        }
      }
      const values = await this.repo.replaceAttributeValues(
        tx,
        internalId,
        body.values.map((value, index) => ({
          publicId: value.id ?? null,
          valueFa: value.valueFa,
          sortOrder: value.sortOrder ?? index,
        })),
      );
      return values.map((value) => ({
        id: value.id,
        valueFa: value.valueFa,
        sortOrder: value.sortOrder,
        isActive: value.isActive,
      }));
    });
  }

  async updateAttributeValue(
    ctx: TenantContext,
    valuePublicId: string,
    body: UpdateAttributeValueBody,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const existing = await this.repo.findAttributeValue(tx, valuePublicId);
      if (existing === null) throw notFound('attribute_value');
      const attribute = await this.repo.findAttribute(tx, ctx.orgId, existing.attributeId);
      if (attribute === null) throw notFound('attribute');
      const updated = await this.repo.updateAttributeValue(
        tx,
        toBigInt(existing.attributeId),
        valuePublicId,
        { valueFa: body.valueFa ?? existing.valueFa, sortOrder: body.sortOrder ?? existing.sortOrder },
      );
      if (updated === null) throw notFound('attribute_value');
      return {
        id: updated.id,
        valueFa: updated.valueFa,
        sortOrder: updated.sortOrder,
        isActive: updated.isActive,
      };
    });
  }

  async deleteAttributeValue(ctx: TenantContext, valuePublicId: string): Promise<void> {
    await this.db.begin(async (tx) => {
      const existing = await this.repo.findAttributeValue(tx, valuePublicId);
      if (existing === null) throw notFound('attribute_value');
      if ((await this.repo.countAttributeValueUsage(tx, toBigInt(existing.internalId))) > 0) {
        throw new AppError('RULE_VIOLATION', {
          message: 'این مقدار ویژگی در حال استفاده است و قابل حذف نیست.',
          messageKey: 'catalog.value_in_use',
          details: [{ rule: 'value_in_use' }],
        });
      }
      await this.repo.deleteAttributeValue(tx, toBigInt(existing.internalId));
    });
  }

  // ------------------------------------------------------------- shared helpers

  async requireCategory(ctx: TenantContext, publicId: string): Promise<CategoryRow> {
    return this.findCategoryOrThrow(this.db, ctx, publicId);
  }

  private async findCategoryOrThrow(tx: Db, ctx: TenantContext, publicId: string): Promise<CategoryRow> {
    const row = await this.repo.findCategory(tx, ctx.orgId, publicId);
    if (row === null) throw notFound('category');
    return row;
  }

  private async resolveUnitInternal(tx: Db, ctx: TenantContext, publicId: string): Promise<bigint> {
    const unit = await this.repo.findUnit(tx, ctx.orgId, publicId);
    if (unit === null) throw notFound('unit');
    return toBigInt(unit.internalId);
  }

  /** Validates a full attribute-value set against a category schema (pure engine). */
  async validateVariantAttributesForCategory(
    tx: Db,
    ctx: TenantContext,
    categoryInternalId: bigint,
    values: readonly { attributeId: string; valueId?: string | null; rawValue?: string | null }[],
  ): Promise<{ attributeInternalId: bigint; valueInternalId: bigint | null; valueText: string | null }[]> {
    const definitions = await this.repo.listCategoryAttributeDefinitions(tx, ctx.orgId, categoryInternalId);
    const mappedDefinitions = definitions.map((definition) => ({
      id: definition.id,
      code: definition.code,
      dataType: definition.dataType as AttributeDataType,
      isRequired: definition.isRequired,
      isVariantAxis: definition.isVariantAxis,
      values: definition.values.map((value) => ({ id: value.id, value: value.value })),
    }));
    const normalized = assertAttributeValues(mappedDefinitions, values);
    return normalized.map((value) => {
      const definition = definitions.find((item) => item.id === value.attributeId);
      const valueInternalId =
        value.valueId === null
          ? null
          : toBigInt(
              definition?.values.find((item) => item.id === value.valueId)?.internalId ?? '0',
            );
      return {
        attributeInternalId: toBigInt(definition?.internalId ?? '0'),
        valueInternalId,
        valueText: value.rawValue,
      };
    });
  }

  assertVersion(currentVersion: number, expectedVersion: number | undefined): void {
    if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
      throw versionConflict(currentVersion, expectedVersion);
    }
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
      dedupeKey: `${type}:${aggregateType}:${aggregateId.toString()}:${Date.now()}`,
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

export type { PermissionKey };
