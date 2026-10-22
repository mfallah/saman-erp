/**
 * Product / variant / barcode / history SQL (`DATA-MODEL` §2.4).
 *
 * Ownership rule (`ARCHITECTURE.md` §4.1): catalog owns these tables exclusively.
 * The only cross-module read here is the `hasStock` list filter, which probes the
 * `inventory_balances` projection; it is isolated in one place and flagged as
 * debt to move behind a reporting read model once that module lands.
 */
import type { BigIntish, Db } from './pg-support';

export interface ProductRow {
  internalId: string;
  id: string;
  productNo: string;
  nameFa: string;
  nameEn: string | null;
  slug: string | null;
  categoryId: string;
  categoryInternalId: string;
  brandId: string | null;
  brandInternalId: string | null;
  productType: string;
  baseUnitId: string | null;
  description: string | null;
  shortDescription: string | null;
  weightGrams: number | null;
  hsCode: string | null;
  status: string;
  trackLot: boolean;
  trackSerial: boolean;
  trackUnit: boolean;
  warrantyMonths: number | null;
  isMarketplaceAllowed: boolean;
  publishedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface VariantRow {
  internalId: string;
  id: string;
  productInternalId: string;
  productId: string;
  productNo: string;
  categoryInternalId: string;
  sku: string;
  title: string | null;
  barcode: string | null;
  unitId: string | null;
  weightGrams: number | null;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
  version: number;
  trackLot: boolean;
  trackSerial: boolean;
  trackUnit: boolean;
  costMethod: string;
}

export interface BarcodeRow {
  internalId: string;
  id: string;
  variantInternalId: string;
  variantId: string;
  barcode: string;
  barcodeType: string;
  source: string;
  isPrimary: boolean;
  isActive: boolean;
}

export interface VariantAttributeRow {
  attributeId: string;
  attributeCode: string;
  attributeName: string;
  dataType: string;
  isVariantAxis: boolean;
  valueId: string | null;
  valueText: string | null;
}

export interface PriceHistoryRow {
  internalId: string;
  id: string;
  variantId: string;
  priceAmount: string;
  compareAtAmount: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string | null;
  sourceType: string;
}

export interface CostHistoryRow {
  internalId: string;
  id: string;
  variantId: string;
  costAmount: string;
  avgCostAmount: string;
  costMethod: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceType: string;
}

export interface SupplierLinkRow {
  supplierId: string;
  supplierName: string;
  supplierSku: string | null;
  purchasePriceAmount: string;
  currency: string;
  leadTimeDays: number;
  minOrderQty: string | null;
  isPrimary: boolean;
  lastPurchaseAt: string | null;
}

export interface ReorderRuleRow {
  internalId: string;
  id: string;
  variantId: string;
  warehouseId: string;
  minQty: string;
  maxQty: string | null;
  reorderQty: string | null;
  safetyStock: string;
  isActive: boolean;
  version: number;
}

function productColumns(tx: Db) {
  return tx`
    p.id::text as "internalId",
    p.public_id as "id",
    p.product_no as "productNo",
    p.name as "nameFa",
    p.name_en as "nameEn",
    p.slug,
    coalesce(c.public_id::text, '') as "categoryId",
    p.category_id::text as "categoryInternalId",
    b.public_id::text as "brandId",
    p.brand_id::text as "brandInternalId",
    p.product_type as "productType",
    bu.public_id::text as "baseUnitId",
    p.description,
    p.short_description as "shortDescription",
    p.weight_grams as "weightGrams",
    p.hs_code as "hsCode",
    p.status,
    p.track_lot as "trackLot",
    p.track_serial as "trackSerial",
    p.track_unit as "trackUnit",
    p.warranty_months as "warrantyMonths",
    p.is_marketplace_allowed as "isMarketplaceAllowed",
    p.published_at::text as "publishedAt",
    p.version,
    p.created_at::text as "createdAt",
    p.updated_at::text as "updatedAt"
  `;
}

function variantColumns(tx: Db) {
  return tx`
    v.id::text as "internalId",
    v.public_id as "id",
    v.product_id::text as "productInternalId",
    p.public_id as "productId",
    p.product_no as "productNo",
    p.category_id::text as "categoryInternalId",
    v.sku,
    v.title,
    v.barcode,
    u.public_id::text as "unitId",
    v.weight_grams as "weightGrams",
    v.is_default as "isDefault",
    v.is_active as "isActive",
    v.sort_order as "sortOrder",
    v.version,
    p.track_lot as "trackLot",
    p.track_serial as "trackSerial",
    p.track_unit as "trackUnit",
    v.cost_method as "costMethod"
  `;
}

function productFrom(tx: Db) {
  return tx`
  from erp.products p
  left join erp.product_categories c on c.id = p.category_id
  left join erp.brands b on b.id = p.brand_id
  left join erp.units_of_measure bu on bu.id = p.base_uom_id
`;
}

function variantFrom(tx: Db) {
  return tx`
  from erp.product_variants v
  join erp.products p on p.id = v.product_id
  left join erp.units_of_measure u on u.id = v.base_uom_id
`;
}

interface ProductInsert {
  orgId: BigIntish;
  productNo: string;
  nameFa: string;
  nameEn: string | null;
  slug: string | null;
  categoryInternalId: BigIntish;
  brandInternalId: BigIntish | null;
  productType: string;
  baseUnitInternalId: BigIntish;
  description: string | null;
  shortDescription: string | null;
  weightGrams: number | null;
  hsCode: string | null;
  status: string;
  trackLot: boolean;
  trackSerial: boolean;
  trackUnit: boolean;
  warrantyMonths: number | null;
  isMarketplaceAllowed: boolean;
}

interface VariantInsert {
  productInternalId: BigIntish;
  sku: string;
  title: string | null;
  barcode: string | null;
  unitInternalId: BigIntish | null;
  weightGrams: number | null;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
}

export class ProductRepository {
  constructor(private readonly db: Db) {}

  // ------------------------------------------------------------------ products

  async listProducts(
    tx: Db,
    params: {
      orgId: BigIntish;
      search: string | null;
      categoryInternalId: BigIntish | null;
      categoryPath: string | null;
      brandInternalId: BigIntish | null;
      status: string | null;
      hasStock: boolean | null;
      updatedAtGte: string | null;
      limit: number;
      offset: number;
    },
  ): Promise<ProductRow[]> {
    const pattern = params.search === null ? null : `%${params.search}%`;
    return tx<ProductRow[]>`
      select ${productColumns(tx)}
      ${productFrom(tx)}
      where p.organization_id = ${params.orgId}
        and p.deleted_at is null
        and (${pattern}::text is null or p.name ilike ${pattern} or p.product_no ilike ${pattern})
        and (${params.categoryInternalId}::bigint is null or p.category_id = ${params.categoryInternalId}::bigint)
        and (${params.categoryPath}::text is null or c.path like ${params.categoryPath})
        and (${params.brandInternalId}::bigint is null or p.brand_id = ${params.brandInternalId}::bigint)
        and (${params.status}::text is null or p.status = ${params.status})
        and (${params.updatedAtGte}::timestamptz is null or p.updated_at >= ${params.updatedAtGte}::timestamptz)
        -- ponytail: cross-module read of the inventory projection for the hasStock
        -- list filter; replace with the reporting read model when reporting lands.
        and (${params.hasStock}::boolean is null
             or exists (
               select 1 from erp.inventory_balances ib
               join erp.product_variants v2 on v2.id = ib.product_variant_id
               where v2.product_id = p.id and ib.on_hand > 0
             ) = ${params.hasStock}::boolean)
      order by p.created_at desc, p.id desc
      limit ${params.limit} offset ${params.offset}
    `;
  }

  async countProducts(
    tx: Db,
    params: {
      orgId: BigIntish;
      search: string | null;
      categoryInternalId: BigIntish | null;
      categoryPath: string | null;
      brandInternalId: BigIntish | null;
      status: string | null;
    },
  ): Promise<number> {
    const pattern = params.search === null ? null : `%${params.search}%`;
    const rows = await tx<{ total: string }[]>`
      select count(*)::text as total
      ${productFrom(tx)}
      where p.organization_id = ${params.orgId} and p.deleted_at is null
        and (${pattern}::text is null or p.name ilike ${pattern} or p.product_no ilike ${pattern})
        and (${params.categoryInternalId}::bigint is null or p.category_id = ${params.categoryInternalId}::bigint)
        and (${params.categoryPath}::text is null or c.path like ${params.categoryPath})
        and (${params.brandInternalId}::bigint is null or p.brand_id = ${params.brandInternalId}::bigint)
        and (${params.status}::text is null or p.status = ${params.status})
    `;
    return Number(rows[0]?.total ?? '0');
  }

  async findProduct(tx: Db, orgId: BigIntish, publicId: string): Promise<ProductRow | null> {
    const rows = await tx<ProductRow[]>`
      select ${productColumns(tx)}
      ${productFrom(tx)}
      where p.organization_id = ${orgId} and p.public_id = ${publicId} and p.deleted_at is null
      limit 1
    `;
    return rows[0] ?? null;
  }

  async findProductForUpdate(tx: Db, orgId: BigIntish, publicId: string): Promise<ProductRow | null> {
    const rows = await tx<ProductRow[]>`
      select ${productColumns(tx)}
      ${productFrom(tx)}
      where p.organization_id = ${orgId} and p.public_id = ${publicId} and p.deleted_at is null
      for update of p
    `;
    return rows[0] ?? null;
  }

  async findProductByNo(tx: Db, orgId: BigIntish, productNo: string): Promise<ProductRow | null> {
    const rows = await tx<ProductRow[]>`
      select ${productColumns(tx)}
      ${productFrom(tx)}
      where p.organization_id = ${orgId} and p.product_no = ${productNo} and p.deleted_at is null
      limit 1
    `;
    return rows[0] ?? null;
  }

  async insertProduct(tx: Db, input: ProductInsert): Promise<ProductRow> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.products (
        organization_id, public_id, product_no, name, name_en, slug, category_id, brand_id,
        product_type, base_uom_id, description, short_description, weight_grams, hs_code,
        status, track_lot, track_serial, track_unit, warranty_months, is_marketplace_allowed
      ) values (
        ${input.orgId}, gen_random_uuid(), ${input.productNo}, ${input.nameFa}, ${input.nameEn},
        ${input.slug}, ${input.categoryInternalId}, ${input.brandInternalId}, ${input.productType},
        ${input.baseUnitInternalId}, ${input.description}, ${input.shortDescription},
        ${input.weightGrams}, ${input.hsCode}, ${input.status}, ${input.trackLot},
        ${input.trackSerial}, ${input.trackUnit}, ${input.warrantyMonths}, ${input.isMarketplaceAllowed}
      )
      returning id::text as id
    `;
    const internalId = rows[0]?.id ?? '';
    const created = await tx<ProductRow[]>`
      select ${productColumns(tx)} ${productFrom(tx)}
      where p.id = ${internalId}::bigint limit 1
    `;
    return created[0] as ProductRow;
  }

  async updateProduct(
    tx: Db,
    orgId: BigIntish,
    internalId: BigIntish,
    input: {
      nameFa: string;
      nameEn: string | null;
      slug: string | null;
      categoryInternalId: BigIntish;
      brandInternalId: BigIntish | null;
      description: string | null;
      shortDescription: string | null;
      status: string;
      weightGrams: number | null;
      hsCode: string | null;
      warrantyMonths: number | null;
      isMarketplaceAllowed: boolean;
    },
  ): Promise<ProductRow> {
    await tx`
      update erp.products
      set name = ${input.nameFa}, name_en = ${input.nameEn}, slug = ${input.slug},
          category_id = ${input.categoryInternalId}, brand_id = ${input.brandInternalId},
          description = ${input.description}, short_description = ${input.shortDescription},
          status = ${input.status}, weight_grams = ${input.weightGrams}, hs_code = ${input.hsCode},
          warranty_months = ${input.warrantyMonths},
          is_marketplace_allowed = ${input.isMarketplaceAllowed},
          updated_at = now(), version = version + 1
      where organization_id = ${orgId} and id = ${internalId}
    `;
    const rows = await tx<ProductRow[]>`
      select ${productColumns(tx)} ${productFrom(tx)}
      where p.id = ${internalId} limit 1
    `;
    return rows[0] as ProductRow;
  }

  async setProductStatus(
    tx: Db,
    orgId: BigIntish,
    internalId: BigIntish,
    status: string,
    publishedAt: string | null,
  ): Promise<void> {
    await tx`
      update erp.products
      set status = ${status},
          published_at = ${publishedAt}::timestamptz,
          updated_at = now(), version = version + 1
      where organization_id = ${orgId} and id = ${internalId}
    `;
  }

  async softDeleteProduct(tx: Db, orgId: BigIntish, internalId: BigIntish): Promise<void> {
    await tx`
      update erp.products set deleted_at = now(), status = 'discontinued',
        updated_at = now(), version = version + 1
      where organization_id = ${orgId} and id = ${internalId}
    `;
  }

  async countProductDependencies(
    tx: Db,
    orgId: BigIntish,
    internalId: BigIntish,
  ): Promise<{ stock: number; openOrders: number }> {
    const rows = await tx<{ stock: string; open_orders: string }[]>`
      select
        (select count(*) from erp.inventory_balances ib
          join erp.product_variants v on v.id = ib.product_variant_id
         where v.product_id = ${internalId} and ib.on_hand > 0)::text as stock,
        (select count(*) from erp.sales_order_lines l
          join erp.sales_orders o on o.id = l.order_id
          join erp.product_variants v on v.id = l.product_variant_id
         where o.organization_id = ${orgId} and v.product_id = ${internalId}
           and o.status not in ('cancelled', 'closed', 'returned'))::text as open_orders
    `;
    const row = rows[0];
    return { stock: Number(row?.stock ?? '0'), openOrders: Number(row?.open_orders ?? '0') };
  }

  // ------------------------------------------------------------------ variants

  async listVariants(
    tx: Db,
    params: {
      orgId: BigIntish;
      productInternalId: BigIntish | null;
      onlyActive: boolean | null;
      barcode: string | null;
      sku: string | null;
      search: string | null;
      limit: number;
      offset: number;
    },
  ): Promise<VariantRow[]> {
    const pattern = params.search === null ? null : `%${params.search}%`;
    return tx<VariantRow[]>`
      select ${variantColumns(tx)}
      ${variantFrom(tx)}
      where p.organization_id = ${params.orgId} and v.deleted_at is null and p.deleted_at is null
        and (${params.productInternalId}::bigint is null or v.product_id = ${params.productInternalId}::bigint)
        and (${params.onlyActive}::boolean is null or v.is_active = ${params.onlyActive}::boolean)
        and (${params.barcode}::text is null or v.barcode = ${params.barcode})
        and (${params.sku}::text is null or v.sku = ${params.sku})
        and (${pattern}::text is null or v.sku ilike ${pattern} or v.title ilike ${pattern})
      order by v.created_at asc, v.id asc
      limit ${params.limit} offset ${params.offset}
    `;
  }

  async countVariants(tx: Db, params: { orgId: BigIntish; productInternalId: BigIntish | null }): Promise<number> {
    const rows = await tx<{ total: string }[]>`
      select count(*)::text as total
      ${variantFrom(tx)}
      where p.organization_id = ${params.orgId} and v.deleted_at is null and p.deleted_at is null
        and (${params.productInternalId}::bigint is null or v.product_id = ${params.productInternalId}::bigint)
    `;
    return Number(rows[0]?.total ?? '0');
  }

  async findVariant(tx: Db, orgId: BigIntish, publicId: string): Promise<VariantRow | null> {
    const rows = await tx<VariantRow[]>`
      select ${variantColumns(tx)}
      ${variantFrom(tx)}
      where p.organization_id = ${orgId} and v.public_id = ${publicId} and v.deleted_at is null
      limit 1
    `;
    return rows[0] ?? null;
  }

  async findVariantsByPublicIds(
    tx: Db,
    orgId: BigIntish,
    publicIds: readonly string[],
  ): Promise<VariantRow[]> {
    if (publicIds.length === 0) return [];
    return tx<VariantRow[]>`
      select ${variantColumns(tx)}
      ${variantFrom(tx)}
      where p.organization_id = ${orgId} and v.public_id = any(${publicIds}::uuid[]) and v.deleted_at is null
    `;
  }

  async variantSkuExists(tx: Db, sku: string, exceptInternalId?: BigIntish): Promise<boolean> {
    const rows = await tx<{ exists: boolean }[]>`
      select exists(
        select 1 from erp.product_variants
        where sku = ${sku} and deleted_at is null
          and (${exceptInternalId ?? null}::bigint is null or id <> ${exceptInternalId ?? null}::bigint)
      ) as exists
    `;
    return rows[0]?.exists ?? false;
  }

  async insertVariant(tx: Db, input: VariantInsert): Promise<VariantRow> {    const rows = await tx<{ id: string }[]>`
      insert into erp.product_variants
        (product_id, public_id, sku, title, barcode, base_uom_id, weight_grams, is_default, is_active, sort_order)
      values (${input.productInternalId}, gen_random_uuid(), ${input.sku}, ${input.title},
              ${input.barcode}, ${input.unitInternalId}, ${input.weightGrams}, ${input.isDefault},
              ${input.isActive}, ${input.sortOrder})
      returning id::text as id
    `;
    const internalId = rows[0]?.id ?? '';
    const created = await tx<VariantRow[]>`
      select ${variantColumns(tx)} ${variantFrom(tx)} where v.id = ${internalId}::bigint limit 1
    `;
    return created[0] as VariantRow;
  }

  async updateVariant(
    tx: Db,
    orgId: BigIntish,
    internalId: BigIntish,
    input: {
      sku: string;
      title: string | null;
      barcode: string | null;
      unitInternalId: BigIntish | null;
      weightGrams: number | null;
      isActive: boolean;
    },
  ): Promise<VariantRow> {
    await tx`
      update erp.product_variants v
      set sku = ${input.sku}, title = ${input.title}, barcode = ${input.barcode},
          base_uom_id = ${input.unitInternalId}, weight_grams = ${input.weightGrams},
          is_active = ${input.isActive}, updated_at = now(), version = version + 1
      where v.id = ${internalId}
        and exists (select 1 from erp.products p
                    where p.id = v.product_id and p.organization_id = ${orgId})
    `;
    const rows = await tx<VariantRow[]>`
      select ${variantColumns(tx)} ${variantFrom(tx)} where v.id = ${internalId} limit 1
    `;
    return rows[0] as VariantRow;
  }

  async setVariantBarcode(tx: Db, variantInternalId: BigIntish, barcode: string | null): Promise<void> {
    await tx`update erp.product_variants set barcode = ${barcode}, updated_at = now() where id = ${variantInternalId}`;
  }

  async softDeleteVariant(tx: Db, orgId: BigIntish, internalId: BigIntish): Promise<void> {
    await tx`
      update erp.product_variants v
      set deleted_at = now(), is_active = false, updated_at = now(), version = version + 1
      where v.id = ${internalId}
        and exists (select 1 from erp.products p
                    where p.id = v.product_id and p.organization_id = ${orgId})
    `;
  }

  async countVariantDependencies(
    tx: Db,
    orgId: BigIntish,
    internalId: BigIntish,
  ): Promise<{ stock: number; openOrders: number }> {
    const rows = await tx<{ stock: string; open_orders: string }[]>`
      select
        (select count(*) from erp.inventory_balances ib
         where ib.product_variant_id = ${internalId} and ib.on_hand > 0)::text as stock,
        (select count(*) from erp.sales_order_lines l
          join erp.sales_orders o on o.id = l.order_id
         where o.organization_id = ${orgId} and l.product_variant_id = ${internalId}
           and o.status not in ('cancelled', 'closed', 'returned'))::text as open_orders
    `;
    const row = rows[0];
    return { stock: Number(row?.stock ?? '0'), openOrders: Number(row?.open_orders ?? '0') };
  }

  async countProductVariants(tx: Db, productInternalId: BigIntish): Promise<number> {
    const rows = await tx<{ total: string }[]>`
      select count(*)::text as total from erp.product_variants
      where product_id = ${productInternalId} and deleted_at is null
    `;
    return Number(rows[0]?.total ?? '0');
  }

  // ------------------------------------------------------- variant attributes

  async replaceVariantAttributes(
    tx: Db,
    variantInternalId: BigIntish,
    values: readonly { attributeInternalId: BigIntish; valueInternalId: BigIntish | null; valueText: string | null }[],
  ): Promise<void> {
    await tx`delete from erp.product_variant_attributes where variant_id = ${variantInternalId}`;
    for (const value of values) {
      await tx`
        insert into erp.product_variant_attributes (variant_id, attribute_id, value_id, value_text)
        values (${variantInternalId}, ${value.attributeInternalId}, ${value.valueInternalId}, ${value.valueText})
        on conflict (variant_id, attribute_id) do update
          set value_id = excluded.value_id, value_text = excluded.value_text
      `;
    }
  }

  async listVariantAttributes(tx: Db, variantInternalId: BigIntish): Promise<VariantAttributeRow[]> {
    return tx<VariantAttributeRow[]>`
      select a.public_id as "attributeId", a.code as "attributeCode", a.name as "attributeName",
             a.data_type as "dataType", a.is_variant_axis as "isVariantAxis",
             vv.public_id as "valueId", va.value_text as "valueText"
      from erp.product_variant_attributes va
      join erp.product_attributes a on a.id = va.attribute_id
      left join erp.product_attribute_values vv on vv.id = va.value_id
      where va.variant_id = ${variantInternalId}
      order by a.sort_order asc
    `;
  }

  async variantAxisSignatures(tx: Db, productInternalId: BigIntish): Promise<string[]> {
    const rows = await tx<{ signature: string }[]>`
      select coalesce(string_agg(
        va.attribute_id::text || '=' || coalesce(va.value_id::text, va.value_text, ''), '|' order by va.attribute_id
      ), '') as signature
      from erp.product_variant_attributes va
      join erp.product_variants v on v.id = va.variant_id
      join erp.product_attributes a on a.id = va.attribute_id and a.is_variant_axis
      where v.product_id = ${productInternalId} and v.deleted_at is null
      group by v.id
    `;
    return rows.map((row) => row.signature).filter((signature) => signature.length > 0);
  }

  // ------------------------------------------------------------------ barcodes

  async listVariantBarcodes(tx: Db, variantInternalId: BigIntish): Promise<BarcodeRow[]> {
    return tx<BarcodeRow[]>`
      select b.id::text as "internalId", b.public_id as id,
             b.product_variant_id::text as "variantInternalId", v.public_id as "variantId",
             b.barcode, b.barcode_type as "barcodeType", b.source,
             b.is_primary as "isPrimary", b.is_active as "isActive"
      from erp.product_barcodes b
      join erp.product_variants v on v.id = b.product_variant_id
      where b.product_variant_id = ${variantInternalId}
      order by b.is_primary desc, b.created_at asc
    `;
  }

  async barcodeExists(tx: Db, barcode: string, exceptInternalId?: BigIntish): Promise<boolean> {
    const rows = await tx<{ exists: boolean }[]>`
      select exists(
        select 1 from erp.product_barcodes
        where barcode = ${barcode}
          and (${exceptInternalId ?? null}::bigint is null or id <> ${exceptInternalId ?? null}::bigint)
      ) as exists
    `;
    return rows[0]?.exists ?? false;
  }

  async insertBarcode(
    tx: Db,
    input: {
      variantInternalId: BigIntish;
      barcode: string;
      barcodeType: string;
      source: string;
      isPrimary: boolean;
    },
  ): Promise<BarcodeRow> {
    if (input.isPrimary) {
      await tx`
        update erp.product_barcodes set is_primary = false
        where product_variant_id = ${input.variantInternalId} and is_primary
      `;
    }
    const rows = await tx<BarcodeRow[]>`
      insert into erp.product_barcodes
        (product_variant_id, public_id, barcode, barcode_type, source, is_primary)
      values (${input.variantInternalId}, gen_random_uuid(), ${input.barcode},
              ${input.barcodeType}, ${input.source}, ${input.isPrimary})
      returning id::text as "internalId", public_id as id,
                product_variant_id::text as "variantInternalId", ''::text as "variantId",
                barcode, barcode_type as "barcodeType", source,
                is_primary as "isPrimary", is_active as "isActive"
    `;
    if (input.isPrimary) {
      await tx`
        update erp.product_variants set barcode = ${input.barcode}
        where id = ${input.variantInternalId}
      `;
    }
    return rows[0] as BarcodeRow;
  }

  async findBarcode(tx: Db, orgId: BigIntish, publicId: string): Promise<BarcodeRow | null> {
    const rows = await tx<BarcodeRow[]>`
      select b.id::text as "internalId", b.public_id as id,
             b.product_variant_id::text as "variantInternalId", v.public_id as "variantId",
             b.barcode, b.barcode_type as "barcodeType", b.source,
             b.is_primary as "isPrimary", b.is_active as "isActive"
      from erp.product_barcodes b
      join erp.product_variants v on v.id = b.product_variant_id
      join erp.products p on p.id = v.product_id
      where p.organization_id = ${orgId} and b.public_id = ${publicId}
      limit 1
    `;
    return rows[0] ?? null;
  }

  async findBarcodeByValue(
    tx: Db,
    orgId: BigIntish,
    barcode: string,
  ): Promise<{ barcode: BarcodeRow; variant: VariantRow; product: ProductRow } | null> {
    const rows = await tx<
      {
        barcodeInternalId: string;
        barcodeId: string;
        barcode: string;
        barcodeType: string;
        source: string;
        isPrimary: boolean;
        variantInternalId: string;
        variantId: string;
      }[]
    >`
      select b.id::text as "barcodeInternalId", b.public_id as "barcodeId", b.barcode,
             b.barcode_type as "barcodeType", b.source, b.is_primary as "isPrimary",
             v.id::text as "variantInternalId", v.public_id as "variantId"
      from erp.product_barcodes b
      join erp.product_variants v on v.id = b.product_variant_id
      join erp.products p on p.id = v.product_id
      where p.organization_id = ${orgId} and b.barcode = ${barcode} and b.is_active
        and v.deleted_at is null and p.deleted_at is null
      limit 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const variant = await tx<VariantRow[]>`
      select ${variantColumns(tx)} ${variantFrom(tx)}
      where v.id = ${row.variantInternalId}::bigint limit 1
    `;
    const product = await tx<ProductRow[]>`
      select ${productColumns(tx)} ${productFrom(tx)}
      where p.id = (select product_id from erp.product_variants where id = ${row.variantInternalId}::bigint)
      limit 1
    `;
    if (variant[0] === undefined || product[0] === undefined) return null;
    return {
      barcode: {
        internalId: row.barcodeInternalId,
        id: row.barcodeId,
        variantInternalId: row.variantInternalId,
        variantId: row.variantId,
        barcode: row.barcode,
        barcodeType: row.barcodeType,
        source: row.source,
        isPrimary: row.isPrimary,
        isActive: true,
      },
      variant: variant[0],
      product: product[0],
    };
  }

  async deleteBarcode(tx: Db, orgId: BigIntish, internalId: BigIntish): Promise<boolean> {
    const rows = await tx<{ id: string }[]>`
      delete from erp.product_barcodes b
      using erp.product_variants v, erp.products p
      where b.product_variant_id = v.id and v.product_id = p.id
        and p.organization_id = ${orgId} and b.id = ${internalId}
      returning b.id::text as id
    `;
    return rows.length > 0;
  }

  async productBarcodes(tx: Db, productInternalId: BigIntish): Promise<BarcodeRow[]> {
    return tx<BarcodeRow[]>`
      select b.id::text as "internalId", b.public_id as id,
             b.product_variant_id::text as "variantInternalId", v.public_id as "variantId",
             b.barcode, b.barcode_type as "barcodeType", b.source,
             b.is_primary as "isPrimary", b.is_active as "isActive"
      from erp.product_barcodes b
      join erp.product_variants v on v.id = b.product_variant_id
      where v.product_id = ${productInternalId}
    `;
  }

  // ------------------------------------------------------ price / cost history

  async listPriceHistory(
    tx: Db,
    variantInternalId: BigIntish,
    params: { limit: number; offset: number; dateGte: string | null },
  ): Promise<PriceHistoryRow[]> {
    return tx<PriceHistoryRow[]>`
      select h.id::text as "internalId", h.public_id as id, v.public_id as "variantId",
             h.price_amount::text as "priceAmount", h.compare_at_amount::text as "compareAtAmount",
             h.effective_from::text as "effectiveFrom", h.effective_to::text as "effectiveTo",
             h.reason, h.source_type as "sourceType"
      from erp.product_price_history h
      join erp.product_variants v on v.id = h.product_variant_id
      where h.product_variant_id = ${variantInternalId}
        and (${params.dateGte}::timestamptz is null or h.effective_from >= ${params.dateGte}::timestamptz)
      order by h.effective_from desc
      limit ${params.limit} offset ${params.offset}
    `;
  }

  async insertPriceHistory(
    tx: Db,
    input: {
      variantInternalId: BigIntish;
      priceAmount: bigint;
      compareAtAmount: bigint | null;
      effectiveFrom: string;
      reason: string | null;
      sourceType: string;
      changedBy: bigint | null;
    },
  ): Promise<PriceHistoryRow> {
    // Effective-dated close+insert: exactly one open row per variant.
    await tx`
      update erp.product_price_history
      set effective_to = ${input.effectiveFrom}::timestamptz
      where product_variant_id = ${input.variantInternalId} and effective_to is null
    `;
    const rows = await tx<PriceHistoryRow[]>`
      insert into erp.product_price_history
        (product_variant_id, public_id, price_amount, compare_at_amount, effective_from, reason,
         changed_by, source_type)
      values (${input.variantInternalId}, gen_random_uuid(), ${input.priceAmount},
              ${input.compareAtAmount}, ${input.effectiveFrom}::timestamptz, ${input.reason},
              ${input.changedBy}, ${input.sourceType})
      returning id::text as "internalId", public_id as id, ''::text as "variantId",
                price_amount::text as "priceAmount", compare_at_amount::text as "compareAtAmount",
                effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
                reason, source_type as "sourceType"
    `;
    return rows[0] as PriceHistoryRow;
  }

  async openPriceHistory(tx: Db, variantInternalId: BigIntish): Promise<PriceHistoryRow | null> {
    const rows = await tx<PriceHistoryRow[]>`
      select h.id::text as "internalId", h.public_id as id, v.public_id as "variantId",
             h.price_amount::text as "priceAmount", h.compare_at_amount::text as "compareAtAmount",
             h.effective_from::text as "effectiveFrom", h.effective_to::text as "effectiveTo",
             h.reason, h.source_type as "sourceType"
      from erp.product_price_history h
      join erp.product_variants v on v.id = h.product_variant_id
      where h.product_variant_id = ${variantInternalId} and h.effective_to is null
      limit 1
    `;
    return rows[0] ?? null;
  }

  async listCostHistory(
    tx: Db,
    variantInternalId: BigIntish,
    params: { limit: number; offset: number; dateGte: string | null },
  ): Promise<CostHistoryRow[]> {
    return tx<CostHistoryRow[]>`
      select h.id::text as "internalId", h.public_id as id, v.public_id as "variantId",
             h.cost_amount::text as "costAmount", h.avg_cost_amount::text as "avgCostAmount",
             h.cost_method as "costMethod", h.effective_from::text as "effectiveFrom",
             h.effective_to::text as "effectiveTo", h.source_type as "sourceType"
      from erp.product_cost_history h
      join erp.product_variants v on v.id = h.product_variant_id
      where h.product_variant_id = ${variantInternalId}
        and (${params.dateGte}::timestamptz is null or h.effective_from >= ${params.dateGte}::timestamptz)
      order by h.effective_from desc
      limit ${params.limit} offset ${params.offset}
    `;
  }

  async insertCostHistory(
    tx: Db,
    input: {
      variantInternalId: BigIntish;
      costAmount: bigint;
      avgCostAmount: bigint;
      costMethod: string;
      effectiveFrom: string;
      sourceType: string;
      referenceId: string | null;
    },
  ): Promise<CostHistoryRow> {
    await tx`
      update erp.product_cost_history
      set effective_to = ${input.effectiveFrom}::timestamptz
      where product_variant_id = ${input.variantInternalId} and effective_to is null
    `;
    const rows = await tx<CostHistoryRow[]>`
      insert into erp.product_cost_history
        (product_variant_id, public_id, cost_amount, avg_cost_amount, cost_method,
         effective_from, source_type, reference_id)
      values (${input.variantInternalId}, gen_random_uuid(), ${input.costAmount},
              ${input.avgCostAmount}, ${input.costMethod}, ${input.effectiveFrom}::timestamptz,
              ${input.sourceType}, ${input.referenceId})
      returning id::text as "internalId", public_id as id, ''::text as "variantId",
                cost_amount::text as "costAmount", avg_cost_amount::text as "avgCostAmount",
                cost_method as "costMethod", effective_from::text as "effectiveFrom",
                effective_to::text as "effectiveTo", source_type as "sourceType"
    `;
    return rows[0] as CostHistoryRow;
  }

  async latestCost(tx: Db, variantInternalId: BigIntish): Promise<CostHistoryRow | null> {
    const rows = await tx<CostHistoryRow[]>`
      select h.id::text as "internalId", h.public_id as id, v.public_id as "variantId",
             h.cost_amount::text as "costAmount", h.avg_cost_amount::text as "avgCostAmount",
             h.cost_method as "costMethod", h.effective_from::text as "effectiveFrom",
             h.effective_to::text as "effectiveTo", h.source_type as "sourceType"
      from erp.product_cost_history h
      join erp.product_variants v on v.id = h.product_variant_id
      where h.product_variant_id = ${variantInternalId}
      order by h.effective_from desc limit 1
    `;
    return rows[0] ?? null;
  }

  // ------------------------------------------------------------ supplier links

  async listSupplierLinks(tx: Db, variantInternalId: BigIntish): Promise<SupplierLinkRow[]> {
    return tx<SupplierLinkRow[]>`
      select s.public_id as "supplierId", s.name as "supplierName", ps.supplier_sku as "supplierSku",
             ps.purchase_price_amount::text as "purchasePriceAmount", ps.currency,
             ps.lead_time_days as "leadTimeDays", ps.min_order_qty::text as "minOrderQty",
             ps.is_primary as "isPrimary", ps.last_purchase_at::text as "lastPurchaseAt"
      from erp.product_suppliers ps
      join erp.procurement.suppliers s on s.id = ps.supplier_id
      where ps.product_variant_id = ${variantInternalId}
      order by ps.is_primary desc, s.name asc
    `;
  }

  async replaceSupplierLinks(
    tx: Db,
    variantInternalId: BigIntish,
    links: readonly {
      supplierInternalId: BigIntish;
      supplierSku: string | null;
      purchasePriceAmount: bigint;
      leadTimeDays: number;
      minOrderQty: string | null;
      isPrimary: boolean;
    }[],
  ): Promise<void> {
    await tx`delete from erp.product_suppliers where product_variant_id = ${variantInternalId}`;
    for (const link of links) {
      await tx`
        insert into erp.product_suppliers
          (product_variant_id, supplier_id, supplier_sku, purchase_price_amount, lead_time_days,
           min_order_qty, is_primary)
        values (${variantInternalId}, ${link.supplierInternalId}, ${link.supplierSku},
                ${link.purchasePriceAmount}, ${link.leadTimeDays}, ${link.minOrderQty}::numeric,
                ${link.isPrimary})
        on conflict (product_variant_id, supplier_id) do update
          set supplier_sku = excluded.supplier_sku,
              purchase_price_amount = excluded.purchase_price_amount,
              lead_time_days = excluded.lead_time_days,
              min_order_qty = excluded.min_order_qty,
              is_primary = excluded.is_primary
      `;
    }
  }

  // ------------------------------------------------------------ reorder rules

  async listReorderRules(
    tx: Db,
    params: {
      orgId: BigIntish;
      variantInternalId: BigIntish | null;
      warehouseInternalId: BigIntish | null;
      onlyActive: boolean | null;
      limit: number;
      offset: number;
    },
  ): Promise<ReorderRuleRow[]> {
    return tx<ReorderRuleRow[]>`
      select r.id::text as "internalId", r.public_id as id, v.public_id as "variantId",
             w.public_id as "warehouseId", r.min_qty::text as "minQty", r.max_qty::text as "maxQty",
             r.reorder_qty::text as "reorderQty", r.safety_stock::text as "safetyStock",
             r.is_active as "isActive", r.version
      from erp.product_reorder_rules r
      join erp.product_variants v on v.id = r.product_variant_id
      join erp.warehouses w on w.id = r.warehouse_id
      where w.organization_id = ${params.orgId}
        and (${params.variantInternalId}::bigint is null or r.product_variant_id = ${params.variantInternalId}::bigint)
        and (${params.warehouseInternalId}::bigint is null or r.warehouse_id = ${params.warehouseInternalId}::bigint)
        and (${params.onlyActive}::boolean is null or r.is_active = ${params.onlyActive}::boolean)
      order by r.created_at desc
      limit ${params.limit} offset ${params.offset}
    `;
  }

  async upsertReorderRule(
    tx: Db,
    input: {
      variantInternalId: BigIntish;
      warehouseInternalId: BigIntish;
      minQty: string;
      maxQty: string | null;
      reorderQty: string | null;
      safetyStock: string;
    },
  ): Promise<ReorderRuleRow> {
    await tx`
      insert into erp.product_reorder_rules
        (public_id, product_variant_id, warehouse_id, min_qty, max_qty, reorder_qty, safety_stock)
      values (gen_random_uuid(), ${input.variantInternalId}, ${input.warehouseInternalId},
              ${input.minQty}::numeric, ${input.maxQty}::numeric, ${input.reorderQty}::numeric,
              ${input.safetyStock}::numeric)
      on conflict (product_variant_id, warehouse_id) do update
        set min_qty = excluded.min_qty, max_qty = excluded.max_qty,
            reorder_qty = excluded.reorder_qty, safety_stock = excluded.safety_stock,
            is_active = true, updated_at = now(), version = product_reorder_rules.version + 1
    `;
    const rows = await tx<ReorderRuleRow[]>`
      select r.id::text as "internalId", r.public_id as id, v.public_id as "variantId",
             w.public_id as "warehouseId", r.min_qty::text as "minQty", r.max_qty::text as "maxQty",
             r.reorder_qty::text as "reorderQty", r.safety_stock::text as "safetyStock",
             r.is_active as "isActive", r.version
      from erp.product_reorder_rules r
      join erp.product_variants v on v.id = r.product_variant_id
      join erp.warehouses w on w.id = r.warehouse_id
      where r.product_variant_id = ${input.variantInternalId}
        and r.warehouse_id = ${input.warehouseInternalId}
      limit 1
    `;
    return rows[0] as ReorderRuleRow;
  }

  /**
   * Resolves a procurement supplier public id (FK target owned by `procurement`).
   * Read-only cross-module lookup, equivalent to calling `SupplierService`; kept
   * here so the catalog write path stays a single statement set.
   */
  async resolveSupplierId(tx: Db, orgId: BigIntish, supplierPublicId: string): Promise<bigint | null> {
    const rows = await tx<{ id: string }[]>`
      select id::text as id from erp.procurement.suppliers
      where organization_id = ${orgId} and public_id = ${supplierPublicId} and deleted_at is null
      limit 1
    `;
    const row = rows[0];
    return row === undefined ? null : BigInt(row.id);
  }

  /** Resolves a warehouse public id (FK target owned by `warehouse`). */
  async resolveWarehouseId(tx: Db, orgId: BigIntish, warehousePublicId: string): Promise<bigint | null> {
    const rows = await tx<{ id: string }[]>`
      select id::text as id from erp.warehouses
      where organization_id = ${orgId} and public_id = ${warehousePublicId} and deleted_at is null
      limit 1
    `;
    const row = rows[0];
    return row === undefined ? null : BigInt(row.id);
  }
}
