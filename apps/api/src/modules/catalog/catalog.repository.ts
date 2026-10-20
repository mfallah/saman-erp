/**
 * Catalog master-data SQL (`DATA-MODEL` §2.4) — categories, brands, units,
 * attributes and media.
 *
 * Every statement is organization-scoped (`ADR-0005`) and parameterized; soft
 * deletes are expressed as `deleted_at IS NULL` on reads. Repositories own SQL
 * only — business rules live in `catalog.service.ts` (`ARCHITECTURE.md` §5).
 */
import type { BigIntish, Db } from './pg-support';

export interface CategoryRow {
  internalId: string;
  id: string;
  parentId: string | null;
  code: string;
  nameFa: string;
  nameEn: string | null;
  path: string;
  level: number;
  sortOrder: number;
  isActive: boolean;
  imageFileId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface BrandRow {
  internalId: string;
  id: string;
  nameFa: string;
  nameEn: string | null;
  slug: string | null;
  country: string | null;
  logoFileId: string | null;
  isActive: boolean;
  version: number;
  createdAt: string;
}

export interface UnitRow {
  internalId: string;
  id: string;
  code: string;
  nameFa: string;
  symbol: string | null;
  dimension: string;
  isBase: boolean;
  decimalPrecision: number;
  isActive: boolean;
  version: number;
}

export interface ConversionRow {
  internalId: string;
  fromUnitId: string;
  toUnitId: string;
  toUnitCode: string;
  factor: string;
  isExact: boolean;
}

export interface AttributeRow {
  internalId: string;
  id: string;
  code: string;
  nameFa: string;
  dataType: string;
  isVariantAxis: boolean;
  isRequired: boolean;
  isFilterable: boolean;
  sortOrder: number;
}

export interface AttributeValueRow {
  internalId: string;
  id: string;
  attributeId: string;
  valueFa: string;
  valueEn: string | null;
  sortOrder: number;
  isActive: boolean;
}

export interface MediaRow {
  internalId: string;
  id: string;
  productId: string;
  variantId: string | null;
  fileId: string;
  mediaType: string;
  alt: string | null;
  sortOrder: number;
  isPrimary: boolean;
}

interface CategoryInsert {
  orgId: BigIntish;
  parentInternalId: BigIntish | null;
  code: string;
  nameFa: string;
  nameEn: string | null;
  path: string;
  level: number;
  sortOrder: number;
  isActive: boolean;
  imageFileInternalId: BigIntish | null;
}

interface CategoryUpdate {
  nameFa: string;
  nameEn: string | null;
  sortOrder: number;
  isActive: boolean;
  imageFileInternalId: BigIntish | null;
}

interface BrandInsert {
  orgId: BigIntish;
  nameFa: string;
  nameEn: string | null;
  slug: string | null;
  country: string | null;
  logoFileInternalId: BigIntish | null;
  isActive: boolean;
}

interface BrandUpdate {
  nameFa: string;
  nameEn: string | null;
  slug: string | null;
  logoFileInternalId: BigIntish | null;
  isActive: boolean;
}

interface UnitInsert {
  orgId: BigIntish;
  code: string;
  nameFa: string;
  nameEn: string | null;
  symbol: string;
  dimension: string;
  isBase: boolean;
  decimalPrecision: number;
}

interface AttributeInsert {
  orgId: BigIntish;
  code: string;
  nameFa: string;
  nameEn: string | null;
  dataType: string;
  isVariantAxis: boolean;
  isRequired: boolean;
  isFilterable: boolean;
  sortOrder: number;
  unitInternalId: BigIntish | null;
}

function categoryColumns(tx: Db) {
  return tx`
  id::text as "internalId",
  public_id as "id",
  parent_id::text as "parentId",
  code,
  name as "nameFa",
  name_en as "nameEn",
  path,
  level,
  sort_order as "sortOrder",
  is_active as "isActive",
  image_file_id::text as "imageFileId",
  version,
  created_at::text as "createdAt",
  updated_at::text as "updatedAt"
`;
}

function brandColumns(tx: Db) {
  return tx`
  id::text as "internalId",
  public_id as "id",
  name as "nameFa",
  NULL::text as "nameEn",
  slug,
  country,
  logo_file_id::text as "logoFileId",
  is_active as "isActive",
  version,
  created_at::text as "createdAt"
`;
}

function unitColumns(tx: Db) {
  return tx`
  id::text as "internalId",
  public_id as "id",
  code,
  name as "nameFa",
  symbol,
  dimension,
  is_base as "isBase",
  decimal_precision as "decimalPrecision",
  is_active as "isActive",
  version
`;
}

function attributeColumns(tx: Db) {
  return tx`
  id::text as "internalId",
  public_id as "id",
  code,
  name as "nameFa",
  data_type as "dataType",
  is_variant_axis as "isVariantAxis",
  is_required as "isRequired",
  is_filterable as "isFilterable",
  sort_order as "sortOrder"
`;
}

function attributeValueColumns(tx: Db) {
  return tx`
  id::text as "internalId",
  public_id as "id",
  attribute_id::text as "attributeId",
  value as "valueFa",
  NULL::text as "valueEn",
  sort_order as "sortOrder",
  is_active as "isActive"
`;
}

export class CatalogRepository {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- categories

  async listCategories(
    tx: Db,
    params: {
      orgId: BigIntish;
      parentInternalId: BigIntish | null;
      onlyActive: boolean | null;
      search: string | null;
      limit: number;
      offset: number;
    },
  ): Promise<CategoryRow[]> {
    const pattern = params.search === null ? null : `%${params.search}%`;
    return tx<CategoryRow[]>`
      select ${categoryColumns(tx)}
      from erp.product_categories
      where organization_id = ${params.orgId}
        and deleted_at is null
        and (${params.parentInternalId}::bigint is null or parent_id = ${params.parentInternalId}::bigint)
        and (${params.onlyActive}::boolean is null or is_active = ${params.onlyActive}::boolean)
        and (${pattern}::text is null or name ilike ${pattern} or code ilike ${pattern})
      order by level asc, sort_order asc, code asc
      limit ${params.limit} offset ${params.offset}
    `;
  }

  async countCategories(
    tx: Db,
    params: { orgId: BigIntish; parentInternalId: BigIntish | null; onlyActive: boolean | null },
  ): Promise<number> {
    const rows = await tx<{ total: string }[]>`
      select count(*)::text as total
      from erp.product_categories
      where organization_id = ${params.orgId}
        and deleted_at is null
        and (${params.parentInternalId}::bigint is null or parent_id = ${params.parentInternalId}::bigint)
        and (${params.onlyActive}::boolean is null or is_active = ${params.onlyActive}::boolean)
    `;
    return Number(rows[0]?.total ?? '0');
  }

  async findCategory(tx: Db, orgId: BigIntish, publicId: string): Promise<CategoryRow | null> {
    const rows = await tx<CategoryRow[]>`
      select ${categoryColumns(tx)}
      from erp.product_categories
      where organization_id = ${orgId} and public_id = ${publicId} and deleted_at is null
      limit 1
    `;
    return rows[0] ?? null;
  }

  async findCategoryForUpdate(tx: Db, orgId: BigIntish, publicId: string): Promise<CategoryRow | null> {
    const rows = await tx<CategoryRow[]>`
      select ${categoryColumns(tx)}
      from erp.product_categories
      where organization_id = ${orgId} and public_id = ${publicId} and deleted_at is null
      for update
    `;
    return rows[0] ?? null;
  }

  async categoryCodeExists(tx: Db, orgId: BigIntish, code: string, exceptInternalId?: BigIntish): Promise<boolean> {
    const rows = await tx<{ exists: boolean }[]>`
      select exists(
        select 1 from erp.product_categories
        where organization_id = ${orgId} and code = ${code} and deleted_at is null
          and (${exceptInternalId ?? null}::bigint is null or id <> ${exceptInternalId ?? null}::bigint)
      ) as exists
    `;
    return rows[0]?.exists ?? false;
  }

  async insertCategory(tx: Db, input: CategoryInsert): Promise<CategoryRow> {
    const rows = await tx<CategoryRow[]>`
      insert into erp.product_categories (
        organization_id, parent_id, code, name, name_en, path, level, sort_order, is_active, image_file_id
      ) values (
        ${input.orgId}, ${input.parentInternalId}, ${input.code}, ${input.nameFa}, ${input.nameEn},
        ${input.path}, ${input.level}, ${input.sortOrder}, ${input.isActive}, ${input.imageFileInternalId}
      )
      returning ${categoryColumns(tx)}
    `;
    return rows[0] as CategoryRow;
  }

  async updateCategory(
    tx: Db,
    orgId: BigIntish,
    internalId: BigIntish,
    input: CategoryUpdate,
  ): Promise<CategoryRow> {
    const rows = await tx<CategoryRow[]>`
      update erp.product_categories
      set name = ${input.nameFa},
          name_en = ${input.nameEn},
          sort_order = ${input.sortOrder},
          is_active = ${input.isActive},
          image_file_id = ${input.imageFileInternalId},
          updated_at = now(),
          version = version + 1
      where organization_id = ${orgId} and id = ${internalId}
      returning ${categoryColumns(tx)}
    `;
    return rows[0] as CategoryRow;
  }

  async softDeleteCategory(tx: Db, orgId: BigIntish, internalId: BigIntish): Promise<void> {
    await tx`
      update erp.product_categories
      set deleted_at = now(), is_active = false, updated_at = now(), version = version + 1
      where organization_id = ${orgId} and id = ${internalId}
    `;
  }

  async countCategoryChildren(tx: Db, orgId: BigIntish, internalId: BigIntish): Promise<number> {
    const rows = await tx<{ total: string }[]>`
      select count(*)::text as total from erp.product_categories
      where organization_id = ${orgId} and parent_id = ${internalId} and deleted_at is null
    `;
    return Number(rows[0]?.total ?? '0');
  }

  async countCategoryProducts(tx: Db, orgId: BigIntish, internalId: BigIntish): Promise<number> {
    const rows = await tx<{ total: string }[]>`
      select count(*)::text as total from erp.products
      where organization_id = ${orgId} and category_id = ${internalId} and deleted_at is null
    `;
    return Number(rows[0]?.total ?? '0');
  }

  /** Descendant rows (path prefix) used by move operations. */
  async subtree(tx: Db, orgId: BigIntish, path: string): Promise<CategoryRow[]> {
    return tx<CategoryRow[]>`
      select ${categoryColumns(tx)}
      from erp.product_categories
      where organization_id = ${orgId} and deleted_at is null and path like ${`${path}%`}
      order by level asc
      for update
    `;
  }

  async rewriteSubtreePaths(
    tx: Db,
    orgId: BigIntish,
    updates: readonly { internalId: BigIntish; path: string; level: number }[],
  ): Promise<void> {
    for (const update of updates) {
      await tx`
        update erp.product_categories
        set path = ${update.path}, level = ${update.level}, updated_at = now(), version = version + 1
        where organization_id = ${orgId} and id = ${update.internalId}
      `;
    }
  }

  async setCategoryParent(
    tx: Db,
    orgId: BigIntish,
    internalId: BigIntish,
    parentInternalId: BigIntish | null,
    path: string,
    level: number,
  ): Promise<CategoryRow> {
    const rows = await tx<CategoryRow[]>`
      update erp.product_categories
      set parent_id = ${parentInternalId}, path = ${path}, level = ${level},
          updated_at = now(), version = version + 1
      where organization_id = ${orgId} and id = ${internalId}
      returning ${categoryColumns(tx)}
    `;
    return rows[0] as CategoryRow;
  }

  async listCategoryAttributes(tx: Db, orgId: BigIntish, categoryInternalId: BigIntish): Promise<unknown[]> {
    return tx`
      select ca.attribute_id::text as "attributeId", ca.is_required as "isRequired",
             ca.is_variant_axis as "isVariantAxis", ca.sort_order as "sortOrder"
      from erp.category_attributes ca
      join erp.product_attributes a on a.id = ca.attribute_id
      where a.organization_id = ${orgId} and ca.category_id = ${categoryInternalId} and a.deleted_at is null
      order by ca.sort_order asc
    `;
  }

  async replaceCategoryAttributes(
    tx: Db,
    categoryInternalId: BigIntish,
    links: readonly { attributeInternalId: BigIntish; isRequired: boolean; isVariantAxis: boolean; sortOrder: number }[],
  ): Promise<void> {
    await tx`delete from erp.category_attributes where category_id = ${categoryInternalId}`;
    for (const link of links) {
      await tx`
        insert into erp.category_attributes
          (category_id, attribute_id, is_required, is_variant_axis, sort_order)
        values (${categoryInternalId}, ${link.attributeInternalId}, ${link.isRequired},
                ${link.isVariantAxis}, ${link.sortOrder})
      `;
    }
  }

  // -------------------------------------------------------------------- brands

  async listBrands(
    tx: Db,
    params: { orgId: BigIntish; onlyActive: boolean | null; search: string | null; limit: number; offset: number },
  ): Promise<BrandRow[]> {
    const pattern = params.search === null ? null : `%${params.search}%`;
    return tx<BrandRow[]>`
      select ${brandColumns(tx)}
      from erp.brands
      where organization_id = ${params.orgId} and deleted_at is null
        and (${params.onlyActive}::boolean is null or is_active = ${params.onlyActive}::boolean)
        and (${pattern}::text is null or name ilike ${pattern})
      order by name asc
      limit ${params.limit} offset ${params.offset}
    `;
  }

  async countBrands(tx: Db, params: { orgId: BigIntish; onlyActive: boolean | null }): Promise<number> {
    const rows = await tx<{ total: string }[]>`
      select count(*)::text as total from erp.brands
      where organization_id = ${params.orgId} and deleted_at is null
        and (${params.onlyActive}::boolean is null or is_active = ${params.onlyActive}::boolean)
    `;
    return Number(rows[0]?.total ?? '0');
  }

  async findBrand(tx: Db, orgId: BigIntish, publicId: string): Promise<BrandRow | null> {
    const rows = await tx<BrandRow[]>`
      select ${brandColumns(tx)} from erp.brands
      where organization_id = ${orgId} and public_id = ${publicId} and deleted_at is null limit 1
    `;
    return rows[0] ?? null;
  }

  async insertBrand(tx: Db, input: BrandInsert): Promise<BrandRow> {
    const rows = await tx<BrandRow[]>`
      insert into erp.brands (organization_id, name, slug, country, logo_file_id, is_active)
      values (${input.orgId}, ${input.nameFa}, ${input.slug}, ${input.country},
              ${input.logoFileInternalId}, ${input.isActive})
      returning ${brandColumns(tx)}
    `;
    return rows[0] as BrandRow;
  }

  async updateBrand(tx: Db, orgId: BigIntish, internalId: BigIntish, input: BrandUpdate): Promise<BrandRow> {
    const rows = await tx<BrandRow[]>`
      update erp.brands
      set name = ${input.nameFa}, slug = ${input.slug},
          logo_file_id = ${input.logoFileInternalId}, is_active = ${input.isActive},
          updated_at = now(), version = version + 1
      where organization_id = ${orgId} and id = ${internalId}
      returning ${brandColumns(tx)}
    `;
    return rows[0] as BrandRow;
  }

  async softDeleteBrand(tx: Db, orgId: BigIntish, internalId: BigIntish): Promise<void> {
    await tx`
      update erp.brands set deleted_at = now(), is_active = false,
        updated_at = now(), version = version + 1
      where organization_id = ${orgId} and id = ${internalId}
    `;
  }

  async countBrandProducts(tx: Db, orgId: BigIntish, internalId: BigIntish): Promise<number> {
    const rows = await tx<{ total: string }[]>`
      select count(*)::text as total from erp.products
      where organization_id = ${orgId} and brand_id = ${internalId} and deleted_at is null
    `;
    return Number(rows[0]?.total ?? '0');
  }

  // --------------------------------------------------------------------- units

  async listUnits(
    tx: Db,
    params: {
      orgId: BigIntish;
      dimension: string | null;
      onlyActive: boolean | null;
      search: string | null;
      limit: number;
      offset: number;
    },
  ): Promise<UnitRow[]> {
    const pattern = params.search === null ? null : `%${params.search}%`;
    return tx<UnitRow[]>`
      select ${unitColumns(tx)} from erp.units_of_measure
      where organization_id = ${params.orgId} and deleted_at is null
        and (${params.dimension}::text is null or dimension = ${params.dimension})
        and (${params.onlyActive}::boolean is null or is_active = ${params.onlyActive}::boolean)
        and (${pattern}::text is null or name ilike ${pattern} or code ilike ${pattern})
      order by name asc
      limit ${params.limit} offset ${params.offset}
    `;
  }

  async countUnits(tx: Db, params: { orgId: BigIntish; dimension: string | null }): Promise<number> {
    const rows = await tx<{ total: string }[]>`
      select count(*)::text as total from erp.units_of_measure
      where organization_id = ${params.orgId} and deleted_at is null
        and (${params.dimension}::text is null or dimension = ${params.dimension})
    `;
    return Number(rows[0]?.total ?? '0');
  }

  async findUnit(tx: Db, orgId: BigIntish, publicId: string): Promise<UnitRow | null> {
    const rows = await tx<UnitRow[]>`
      select ${unitColumns(tx)} from erp.units_of_measure
      where organization_id = ${orgId} and public_id = ${publicId} and deleted_at is null limit 1
    `;
    return rows[0] ?? null;
  }

  async findUnitByCode(tx: Db, orgId: BigIntish, code: string): Promise<UnitRow | null> {
    const rows = await tx<UnitRow[]>`
      select ${unitColumns(tx)} from erp.units_of_measure
      where organization_id = ${orgId} and code = ${code} and deleted_at is null limit 1
    `;
    return rows[0] ?? null;
  }

  async findBaseUnit(tx: Db, orgId: BigIntish, dimension: string): Promise<UnitRow | null> {
    const rows = await tx<UnitRow[]>`
      select ${unitColumns(tx)} from erp.units_of_measure
      where organization_id = ${orgId} and dimension = ${dimension} and is_base and deleted_at is null
      limit 1
    `;
    return rows[0] ?? null;
  }

  async insertUnit(tx: Db, input: UnitInsert): Promise<UnitRow> {
    const rows = await tx<UnitRow[]>`
      insert into erp.units_of_measure
        (organization_id, code, name, symbol, dimension, is_base, decimal_precision)
      values (${input.orgId}, ${input.code}, ${input.nameFa}, ${input.symbol}, ${input.dimension},
              ${input.isBase}, ${input.decimalPrecision})
      returning ${unitColumns(tx)}
    `;
    return rows[0] as UnitRow;
  }

  async updateUnit(
    tx: Db,
    orgId: BigIntish,
    internalId: BigIntish,
    input: { nameFa: string; symbol: string; isActive: boolean },
  ): Promise<UnitRow> {
    const rows = await tx<UnitRow[]>`
      update erp.units_of_measure
      set name = ${input.nameFa}, symbol = ${input.symbol}, is_active = ${input.isActive},
          updated_at = now(), version = version + 1
      where organization_id = ${orgId} and id = ${internalId}
      returning ${unitColumns(tx)}
    `;
    return rows[0] as UnitRow;
  }

  async softDeleteUnit(tx: Db, orgId: BigIntish, internalId: BigIntish): Promise<void> {
    await tx`
      update erp.units_of_measure set deleted_at = now(), is_active = false,
        updated_at = now(), version = version + 1
      where organization_id = ${orgId} and id = ${internalId}
    `;
  }

  async countUnitsInUse(tx: Db, orgId: BigIntish, unitInternalId: BigIntish): Promise<number> {
    const rows = await tx<{ total: string }[]>`
      select (
        (select count(*) from erp.product_variants v
          join erp.products p on p.id = v.product_id
         where p.organization_id = ${orgId} and v.base_uom_id = ${unitInternalId} and v.deleted_at is null)
        + (select count(*) from erp.products p
            where p.organization_id = ${orgId} and p.base_uom_id = ${unitInternalId} and p.deleted_at is null)
      )::text as total
    `;
    return Number(rows[0]?.total ?? '0');
  }

  async listConversions(tx: Db, orgId: BigIntish, fromUnitInternalId: BigIntish): Promise<ConversionRow[]> {
    return tx<ConversionRow[]>`
      select uc.id::text as "internalId", uc.from_unit_id::text as "fromUnitId",
             uc.to_unit_id::text as "toUnitId", tu.code as "toUnitCode",
             uc.factor::text as factor, uc.is_exact as "isExact"
      from erp.unit_conversions uc
      join erp.units_of_measure tu on tu.id = uc.to_unit_id
      where uc.organization_id = ${orgId} and uc.from_unit_id = ${fromUnitInternalId}
      order by tu.code asc
    `;
  }

  async findConversion(
    tx: Db,
    orgId: BigIntish,
    fromUnitInternalId: BigIntish,
    toUnitInternalId: BigIntish,
  ): Promise<ConversionRow | null> {
    const rows = await tx<ConversionRow[]>`
      select uc.id::text as "internalId", uc.from_unit_id::text as "fromUnitId",
             uc.to_unit_id::text as "toUnitId", ''::text as "toUnitCode",
             uc.factor::text as factor, uc.is_exact as "isExact"
      from erp.unit_conversions uc
      where uc.organization_id = ${orgId} and uc.from_unit_id = ${fromUnitInternalId}
        and uc.to_unit_id = ${toUnitInternalId}
      limit 1
    `;
    return rows[0] ?? null;
  }

  async insertConversion(
    tx: Db,
    orgId: BigIntish,
    fromUnitInternalId: BigIntish,
    toUnitInternalId: BigIntish,
    factor: string,
  ): Promise<void> {
    await tx`
      insert into erp.unit_conversions (organization_id, from_unit_id, to_unit_id, factor, is_exact)
      values (${orgId}, ${fromUnitInternalId}, ${toUnitInternalId}, ${factor}::numeric, true)
      on conflict (from_unit_id, to_unit_id) do update set factor = excluded.factor
    `;
  }

  async deleteConversion(tx: Db, orgId: BigIntish, conversionInternalId: BigIntish): Promise<boolean> {
    const rows = await tx<{ id: string }[]>`
      delete from erp.unit_conversions
      where organization_id = ${orgId} and id = ${conversionInternalId}
      returning id::text as id
    `;
    return rows.length > 0;
  }

  // ---------------------------------------------------------------- attributes

  async listAttributes(
    tx: Db,
    params: {
      orgId: BigIntish;
      categoryInternalId: BigIntish | null;
      dataType: string | null;
      variantAxis: boolean | null;
      search: string | null;
      limit: number;
      offset: number;
    },
  ): Promise<AttributeRow[]> {
    const pattern = params.search === null ? null : `%${params.search}%`;
    return tx<AttributeRow[]>`
      select distinct ${attributeColumns(tx)}
      from erp.product_attributes a
      left join erp.category_attributes ca on ca.attribute_id = a.id
      where a.organization_id = ${params.orgId} and a.deleted_at is null
        and (${params.categoryInternalId}::bigint is null or ca.category_id = ${params.categoryInternalId}::bigint)
        and (${params.dataType}::text is null or a.data_type = ${params.dataType})
        and (${params.variantAxis}::boolean is null or a.is_variant_axis = ${params.variantAxis}::boolean)
        and (${pattern}::text is null or a.name ilike ${pattern} or a.code ilike ${pattern})
      order by a.sort_order asc, a.code asc
      limit ${params.limit} offset ${params.offset}
    `;
  }

  async countAttributes(tx: Db, params: { orgId: BigIntish }): Promise<number> {
    const rows = await tx<{ total: string }[]>`
      select count(*)::text as total from erp.product_attributes
      where organization_id = ${params.orgId} and deleted_at is null
    `;
    return Number(rows[0]?.total ?? '0');
  }

  async findAttribute(tx: Db, orgId: BigIntish, publicId: string): Promise<AttributeRow | null> {
    const rows = await tx<AttributeRow[]>`
      select ${attributeColumns(tx)} from erp.product_attributes
      where organization_id = ${orgId} and public_id = ${publicId} and deleted_at is null limit 1
    `;
    return rows[0] ?? null;
  }

  async insertAttribute(tx: Db, input: AttributeInsert): Promise<AttributeRow> {
    const rows = await tx<AttributeRow[]>`
      insert into erp.product_attributes
        (organization_id, code, name, data_type, is_variant_axis, is_required, is_filterable, sort_order, unit_id)
      values (${input.orgId}, ${input.code}, ${input.nameFa}, ${input.dataType},
              ${input.isVariantAxis}, ${input.isRequired}, ${input.isFilterable}, ${input.sortOrder},
              ${input.unitInternalId})
      returning ${attributeColumns(tx)}
    `;
    return rows[0] as AttributeRow;
  }

  async updateAttribute(
    tx: Db,
    orgId: BigIntish,
    internalId: BigIntish,
    input: { nameFa: string; dataType: string; isRequired: boolean; isFilterable: boolean; sortOrder: number },
  ): Promise<AttributeRow> {
    const rows = await tx<AttributeRow[]>`
      update erp.product_attributes
      set name = ${input.nameFa}, data_type = ${input.dataType}, is_required = ${input.isRequired},
          is_filterable = ${input.isFilterable}, sort_order = ${input.sortOrder},
          updated_at = now()
      where organization_id = ${orgId} and id = ${internalId}
      returning ${attributeColumns(tx)}
    `;
    return rows[0] as AttributeRow;
  }

  async softDeleteAttribute(tx: Db, orgId: BigIntish, internalId: BigIntish): Promise<void> {
    await tx`
      update erp.product_attributes set deleted_at = now(), updated_at = now()
      where organization_id = ${orgId} and id = ${internalId}
    `;
  }

  async listAttributeValues(tx: Db, attributeInternalId: BigIntish): Promise<AttributeValueRow[]> {
    return tx<AttributeValueRow[]>`
      select ${attributeValueColumns(tx)} from erp.product_attribute_values
      where attribute_id = ${attributeInternalId}
      order by sort_order asc, value asc
    `;
  }

  async findAttributeValue(tx: Db, publicId: string): Promise<AttributeValueRow | null> {
    const rows = await tx<AttributeValueRow[]>`
      select ${attributeValueColumns(tx)} from erp.product_attribute_values
      where public_id = ${publicId} limit 1
    `;
    return rows[0] ?? null;
  }

  async replaceAttributeValues(
    tx: Db,
    attributeInternalId: BigIntish,
    values: readonly { publicId: string | null; valueFa: string; sortOrder: number }[],
  ): Promise<AttributeValueRow[]> {
    for (const value of values) {
      if (value.publicId === null) {
        await tx`
          insert into erp.product_attribute_values (attribute_id, public_id, value, sort_order)
          values (${attributeInternalId}, gen_random_uuid(), ${value.valueFa}, ${value.sortOrder})
          on conflict (attribute_id, value) do update set sort_order = excluded.sort_order, is_active = true
        `;
      } else {
        await tx`
          update erp.product_attribute_values
          set value = ${value.valueFa}, sort_order = ${value.sortOrder}, is_active = true
          where attribute_id = ${attributeInternalId} and public_id = ${value.publicId}
        `;
      }
    }
    return this.listAttributeValues(tx, attributeInternalId);
  }

  async updateAttributeValue(
    tx: Db,
    attributeInternalId: BigIntish,
    valuePublicId: string,
    input: { valueFa: string; sortOrder: number },
  ): Promise<AttributeValueRow | null> {
    const rows = await tx<AttributeValueRow[]>`
      update erp.product_attribute_values
      set value = ${input.valueFa}, sort_order = ${input.sortOrder}
      where attribute_id = ${attributeInternalId} and public_id = ${valuePublicId}
      returning ${attributeValueColumns(tx)}
    `;
    return rows[0] ?? null;
  }

  async deleteAttributeValue(tx: Db, valueInternalId: BigIntish): Promise<boolean> {
    const rows = await tx<{ id: string }[]>`
      delete from erp.product_attribute_values where id = ${valueInternalId} returning id::text as id
    `;
    return rows.length > 0;
  }

  async countVariantAttributesUsing(attributeInternalId: BigIntish, tx: Db): Promise<number> {
    const rows = await tx<{ total: string }[]>`
      select count(*)::text as total from erp.product_variant_attributes
      where attribute_id = ${attributeInternalId}
    `;
    return Number(rows[0]?.total ?? '0');
  }

  async countAttributeValueUsage(tx: Db, valueInternalId: BigIntish): Promise<number> {
    const rows = await tx<{ total: string }[]>`
      select count(*)::text as total from erp.product_variant_attributes
      where value_id = ${valueInternalId}
    `;
    return Number(rows[0]?.total ?? '0');
  }

  async replaceCategoryAttributeLinks(
    tx: Db,
    categoryInternalId: BigIntish,
    attributeInternalIds: readonly bigint[],
  ): Promise<void> {
    await tx`delete from erp.category_attributes where category_id = ${categoryInternalId}`;
    for (const attributeInternalId of attributeInternalIds) {
      await tx`
        insert into erp.category_attributes (category_id, attribute_id)
        values (${categoryInternalId}, ${attributeInternalId})
        on conflict do nothing
      `;
    }
  }

  /**
   * Attribute definitions relevant to a category together with their allowed
   * values — the input of the pure attribute-validation engine.
   */
  async listCategoryAttributeDefinitions(
    tx: Db,
    orgId: BigIntish,
    categoryInternalId: BigIntish,
  ): Promise<
    {
      internalId: string;
      id: string;
      code: string;
      nameFa: string;
      dataType: string;
      isRequired: boolean;
      isVariantAxis: boolean;
      values: { internalId: string; id: string; value: string }[];
    }[]
  > {
    const rows = await tx<
      {
        internalId: string;
        id: string;
        code: string;
        nameFa: string;
        dataType: string;
        isRequired: boolean;
        isVariantAxis: boolean;
        values: { internalId: string; id: string; value: string }[];
      }[]
    >`
      select a.id::text as "internalId", a.public_id as id, a.code, a.name as "nameFa",
             a.data_type as "dataType",
             coalesce(ca.is_required, a.is_required) as "isRequired",
             coalesce(ca.is_variant_axis, a.is_variant_axis) as "isVariantAxis",
             coalesce(
               jsonb_agg(jsonb_build_object('internalId', v.id::text, 'id', v.public_id, 'value', v.value)
                 order by v.sort_order) filter (where v.id is not null),
               '[]'::jsonb
             ) as values
      from erp.product_attributes a
      left join erp.category_attributes ca on ca.attribute_id = a.id and ca.category_id = ${categoryInternalId}
      left join erp.product_attribute_values v on v.attribute_id = a.id and v.is_active
      where a.organization_id = ${orgId} and a.deleted_at is null
        and (ca.attribute_id is not null or a.is_required)
      group by a.id, ca.is_required, ca.is_variant_axis
      order by a.sort_order asc
    `;
    return rows;
  }

  // --------------------------------------------------------------------- media

  async listProductMedia(tx: Db, productInternalId: BigIntish): Promise<MediaRow[]> {
    const rows = await tx<
      {
        internalId: string;
        id: string;
        productId: string;
        variantId: string | null;
        fileId: string;
        mediaType: string;
        alt: string | null;
        sortOrder: number;
        isPrimary: boolean;
      }[]
    >`
      select m.id::text as "internalId", m.public_id as id, m.product_id::text as "productId",
             m.variant_id::text as "variantId", m.file_id::text as "fileId", m.media_type as "mediaType",
             m.alt, m.sort_order as "sortOrder", m.is_primary as "isPrimary"
      from erp.product_media m
      where m.product_id = ${productInternalId}
      order by m.sort_order asc, m.created_at asc
    `;
    return rows;
  }

  async findMedia(tx: Db, productInternalId: BigIntish, mediaPublicId: string): Promise<MediaRow | null> {
    const rows = await tx<MediaRow[]>`
      select m.id::text as "internalId", m.public_id as id, m.product_id::text as "productId",
             m.variant_id::text as "variantId", m.file_id::text as "fileId", m.media_type as "mediaType",
             m.alt, m.sort_order as "sortOrder", m.is_primary as "isPrimary"
      from erp.product_media m
      where m.product_id = ${productInternalId} and m.public_id = ${mediaPublicId}
      limit 1
    `;
    return rows[0] ?? null;
  }

  async insertMedia(
    tx: Db,
    input: {
      productInternalId: BigIntish;
      variantInternalId: BigIntish | null;
      fileInternalId: BigIntish;
      mediaType: string;
      alt: string | null;
      sortOrder: number;
      isPrimary: boolean;
    },
  ): Promise<MediaRow> {    if (input.isPrimary) {
      await tx`update erp.product_media set is_primary = false where product_id = ${input.productInternalId}`;
    }
    const rows = await tx<MediaRow[]>`
      insert into erp.product_media
        (product_id, variant_id, file_id, media_type, alt, sort_order, is_primary, public_id)
      values (${input.productInternalId}, ${input.variantInternalId}, ${input.fileInternalId},
              ${input.mediaType}, ${input.alt}, ${input.sortOrder}, ${input.isPrimary}, gen_random_uuid())
      returning id::text as "internalId", public_id as id, product_id::text as "productId",
                variant_id::text as "variantId", file_id::text as "fileId", media_type as "mediaType",
                alt, sort_order as "sortOrder", is_primary as "isPrimary"
    `;
    return rows[0] as MediaRow;
  }

  async updateMedia(
    tx: Db,
    productInternalId: BigIntish,
    mediaInternalId: BigIntish,
    input: { alt: string | null; sortOrder: number; isPrimary: boolean },
  ): Promise<MediaRow | null> {
    if (input.isPrimary) {
      await tx`update erp.product_media set is_primary = false where product_id = ${productInternalId}`;
    }
    const rows = await tx<MediaRow[]>`
      update erp.product_media
      set alt = ${input.alt}, sort_order = ${input.sortOrder}, is_primary = ${input.isPrimary}
      where product_id = ${productInternalId} and id = ${mediaInternalId}
      returning id::text as "internalId", public_id as id, product_id::text as "productId",
                variant_id::text as "variantId", file_id::text as "fileId", media_type as "mediaType",
                alt, sort_order as "sortOrder", is_primary as "isPrimary"
    `;
    return rows[0] ?? null;
  }

  async deleteMedia(tx: Db, productInternalId: BigIntish, mediaInternalId: BigIntish): Promise<boolean> {
    const rows = await tx<{ id: string }[]>`
      delete from erp.product_media
      where product_id = ${productInternalId} and id = ${mediaInternalId} returning id::text as id
    `;
    return rows.length > 0;
  }

  /**
   * Resolves a platform `file_assets` public id to its internal id.
   * `platform` is a cross-cutting module (`ARCHITECTURE.md` §4.1 rule 3), so this
   * read is allowed; when the `files` service lands it becomes a public-service
   * call with the same contract.
   */
  async resolveFileId(tx: Db, orgId: BigIntish, filePublicId: string): Promise<bigint | null> {
    const rows = await tx<{ id: string }[]>`
      select id::text as id from erp.file_assets
      where organization_id = ${orgId} and public_id = ${filePublicId} and deleted_at is null
      limit 1
    `;
    const row = rows[0];
    return row === undefined ? null : BigInt(row.id);
  }
}
