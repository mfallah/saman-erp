/**
 * Purchasing SQL (`DATA-MODEL` §2.9 suppliers / purchase orders / goods receipts).
 *
 * Owns the raw statements for supplier masters and the purchase-order + goods-receipt
 * document chain. Stock is **never** written here: `PurchasingService` posts the
 * inbound ledger rows through `InventoryService.postMovement`, so the balance
 * projection, cost layers and average-cost state stay owned by the inventory module.
 *
 * Money/bigint columns are selected as text (`ADR-0013`); `timestamptz` values are
 * left as timestamps so they serialize to ISO in the API envelope. Every response
 * column is a **public** id — internal ids never leave the repository.
 */
import { type Db } from './purchasing.pg-support';

export interface SupplierRow {
  internalId: string;
  id: string;
  code: string;
  name: string;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface GoodsReceiptListRow {
  internalId: string;
  id: string;
  receiptNo: string | null;
  receivedAt: string;
  businessDate: string;
  status: string;
  purchaseOrderId: string | null;
  poNo: string | null;
  supplierId: string | null;
  supplierName: string | null;
  warehouseId: string;
  warehouseName: string | null;
  subtotalAmount: string | null;
  grandTotalAmount: string | null;
  lineCount: number;
  totalQuantity: string;
}

export interface GoodsReceiptLineRow {
  id: string;
  lineNo: number;
  variantId: string;
  sku: string | null;
  productName: string | null;
  quantity: string;
  acceptedQty: string;
  rejectedQty: string;
  unitCostAmount: string;
  lineTotalAmount: string | null;
  purchaseOrderLineId: string | null;
  inventoryTransactionId: string | null;
  serials: { id: string; serialNo: string; status: string }[] | null;
}

export interface InsertedDocumentRow {
  internalId: string;
  id: string;
  documentNo: string | null;
}

/** Active variant→channel mapping that can accept an `inventory_push` job. */
export interface ChannelTargetRow {
  accountInternalId: string;
  accountId: string;
  channelCode: string;
  channelName: string;
  externalProductId: string | null;
  externalVariantId: string | null;
}

export interface SupplierListParams {
  orgId: bigint;
  q: string | null;
  limit: number;
}

export interface ReceiptListParams {
  orgId: bigint;
  q: string | null;
  supplierPublicId: string | null;
  warehousePublicId: string | null;
  /** Allowed internal warehouse ids (`null` = unrestricted, `[]` = none). */
  warehouseIds?: readonly string[] | null;
  limit: number;
  offset: number;
}

export class PurchasingRepository {
  // ------------------------------------------------------------------ suppliers

  async listSuppliers(tx: Db, params: SupplierListParams): Promise<SupplierRow[]> {
    return tx<SupplierRow[]>`
      select s.id::text as "internalId",
             s.public_id as id,
             s.code,
             s.name,
             s.phone,
             s.is_active as "isActive",
             s.created_at as "createdAt"
      from erp.suppliers s
      where s.organization_id = ${params.orgId}
        and s.deleted_at is null
        and (${params.q}::text is null
             or s.name ilike '%' || ${params.q}::text || '%'
             or s.code ilike '%' || ${params.q}::text || '%'
             or coalesce(s.phone, '') ilike '%' || ${params.q}::text || '%'
             or coalesce(s.mobile, '') ilike '%' || ${params.q}::text || '%')
      order by s.name asc, s.id asc
      limit ${params.limit}
    `;
  }

  async findSupplier(tx: Db, orgId: bigint, publicId: string): Promise<SupplierRow | null> {
    const rows = await tx<SupplierRow[]>`
      select s.id::text as "internalId",
             s.public_id as id,
             s.code,
             s.name,
             s.phone,
             s.is_active as "isActive",
             s.created_at as "createdAt"
      from erp.suppliers s
      where s.organization_id = ${orgId}
        and s.public_id = ${publicId}::uuid
        and s.deleted_at is null
      limit 1
    `;
    return rows[0] ?? null;
  }

  /** Case-insensitive name match: a receipt never silently duplicates a supplier. */
  async findSupplierByName(tx: Db, orgId: bigint, name: string): Promise<SupplierRow | null> {
    const rows = await tx<SupplierRow[]>`
      select s.id::text as "internalId",
             s.public_id as id,
             s.code,
             s.name,
             s.phone,
             s.is_active as "isActive",
             s.created_at as "createdAt"
      from erp.suppliers s
      where s.organization_id = ${orgId}
        and s.deleted_at is null
        and lower(s.name) = lower(${name})
      order by s.id asc
      limit 1
    `;
    return rows[0] ?? null;
  }

  async insertSupplier(
    tx: Db,
    input: { orgId: bigint; code: string; name: string; phone: string | null; createdBy: bigint | null },
  ): Promise<SupplierRow> {
    const rows = await tx<SupplierRow[]>`
      insert into erp.suppliers (organization_id, code, name, phone, created_by, updated_by)
      values (${input.orgId}, ${input.code}, ${input.name}, ${input.phone}, ${input.createdBy}, ${input.createdBy})
      returning id::text as "internalId",
                public_id as id,
                code,
                name,
                phone,
                is_active as "isActive",
                created_at as "createdAt"
    `;
    const row = rows[0];
    if (row === undefined) throw new RangeError('supplier_insert_failed');
    return row;
  }

  // ---------------------------------------------------------------- documents

  /**
   * Gap-free document number (`ADR-0014`): `UPDATE … RETURNING` on the
   * `(org, document_type, fiscal_year)` sequence row, formatted `PREFIX-YYYY-000123`.
   * Returns `null` when the organization has no sequence covering the business date,
   * so receiving keeps working (`po_no`/`receipt_no` are nullable) instead of failing
   * the whole receipt on a numbering-configuration gap.
   */
  async allocateDocumentNo(tx: Db, orgId: bigint, documentType: string, businessDate: string): Promise<string | null> {
    const sequence = await tx<{ prefix: string; next_value: string; padding: number; fiscal_year: string }[]>`
      select ns.prefix, ns.next_value::text as next_value, ns.padding,
             to_char(fy.start_date, 'YYYY') as fiscal_year
      from erp.numbering_sequences ns
      join erp.fiscal_years fy on fy.id = ns.fiscal_year_id
      where ns.organization_id = ${orgId}
        and ns.document_type = ${documentType}
        and fy.start_date <= ${businessDate}::date
        and fy.end_date >= ${businessDate}::date
      order by fy.start_date desc
      limit 1
      for update of ns
    `;
    const row = sequence[0];
    if (row === undefined) return null;
    const padded = BigInt(row.next_value).toString().padStart(Number(row.padding), '0');
    await tx`
      update erp.numbering_sequences
      set next_value = next_value + 1, last_allocated_at = now()
      where organization_id = ${orgId}
        and document_type = ${documentType}
        and fiscal_year_id = (
          select ns.fiscal_year_id from erp.numbering_sequences ns
          join erp.fiscal_years fy on fy.id = ns.fiscal_year_id
          where ns.organization_id = ${orgId}
            and ns.document_type = ${documentType}
            and fy.start_date <= ${businessDate}::date
            and fy.end_date >= ${businessDate}::date
          order by fy.start_date desc
          limit 1
        )
    `;
    return `${row.prefix}-${row.fiscal_year}-${padded}`;
  }

  async insertPurchaseOrder(
    tx: Db,
    input: {
      orgId: bigint;
      poNo: string | null;
      supplierInternalId: bigint;
      warehouseInternalId: bigint;
      orderDate: string;
      subtotalAmount: bigint;
      grandTotalAmount: bigint;
      notes: string | null;
      createdBy: bigint | null;
    },
  ): Promise<InsertedDocumentRow> {
    const rows = await tx<InsertedDocumentRow[]>`
      insert into erp.purchase_orders (
        organization_id, po_no, supplier_id, warehouse_id, order_date, status, currency,
        subtotal_amount, grand_total_amount, notes, created_by, updated_by
      )
      values (
        ${input.orgId}, ${input.poNo}, ${input.supplierInternalId}, ${input.warehouseInternalId},
        ${input.orderDate}::date, 'received', 'IRR', ${input.subtotalAmount}, ${input.grandTotalAmount},
        ${input.notes}, ${input.createdBy}, ${input.createdBy}
      )
      returning id::text as "internalId", public_id as id, po_no as "documentNo"
    `;
    const row = rows[0];
    if (row === undefined) throw new RangeError('purchase_order_insert_failed');
    return row;
  }

  async insertPurchaseOrderLine(
    tx: Db,
    input: {
      purchaseOrderInternalId: bigint;
      lineNo: number;
      variantInternalId: bigint;
      quantity: string;
      unitPriceAmount: bigint;
      lineTotalAmount: bigint;
      createdBy: bigint | null;
    },
  ): Promise<InsertedDocumentRow> {
    const rows = await tx<InsertedDocumentRow[]>`
      insert into erp.purchase_order_lines (
        purchase_order_id, line_no, product_variant_id, quantity, unit_price_amount,
        line_total_amount, received_qty, created_by, updated_by
      )
      values (
        ${input.purchaseOrderInternalId}, ${input.lineNo}, ${input.variantInternalId},
        ${input.quantity}::numeric, ${input.unitPriceAmount}, ${input.lineTotalAmount}, 0,
        ${input.createdBy}, ${input.createdBy}
      )
      returning id::text as "internalId", public_id as id, null::text as "documentNo"
    `;
    const row = rows[0];
    if (row === undefined) throw new RangeError('purchase_order_line_insert_failed');
    return row;
  }

  /** Records the received quantity of a PO line (full receipt today, partial later). */
  async addPurchaseOrderLineReceived(
    tx: Db,
    purchaseOrderLineInternalId: bigint,
    receivedQuantity: string,
    updatedBy: bigint | null,
  ): Promise<void> {
    await tx`
      update erp.purchase_order_lines
      set received_qty = received_qty + ${receivedQuantity}::numeric,
          updated_by = ${updatedBy}
      where id = ${purchaseOrderLineInternalId}
    `;
  }

  async insertGoodsReceipt(
    tx: Db,
    input: {
      orgId: bigint;
      purchaseOrderInternalId: bigint;
      warehouseInternalId: bigint;
      receiptNo: string | null;
      receivedAt: Date;
      businessDate: string;
      receivedBy: bigint | null;
      notes: string | null;
    },
  ): Promise<InsertedDocumentRow> {
    const rows = await tx<InsertedDocumentRow[]>`
      insert into erp.goods_receipts (
        organization_id, purchase_order_id, warehouse_id, receipt_no, received_at,
        business_date, status, received_by, notes, posted_at, created_by, updated_by
      )
      values (
        ${input.orgId}, ${input.purchaseOrderInternalId}, ${input.warehouseInternalId}, ${input.receiptNo},
        ${input.receivedAt}, ${input.businessDate}::date, 'received', ${input.receivedBy},
        ${input.notes}, now(), ${input.receivedBy}, ${input.receivedBy}
      )
      returning id::text as "internalId", public_id as id, receipt_no as "documentNo"
    `;
    const row = rows[0];
    if (row === undefined) throw new RangeError('goods_receipt_insert_failed');
    return row;
  }

  async insertGoodsReceiptLine(
    tx: Db,
    input: {
      receiptInternalId: bigint;
      purchaseOrderLineInternalId: bigint;
      lineNo: number;
      variantInternalId: bigint;
      quantity: string;
      unitCostAmount: bigint;
      inventoryTransactionInternalId: bigint;
      createdBy: bigint | null;
    },
  ): Promise<InsertedDocumentRow> {
    const rows = await tx<InsertedDocumentRow[]>`
      insert into erp.goods_receipt_lines (
        receipt_id, purchase_order_line_id, line_no, product_variant_id, quantity,
        accepted_qty, rejected_qty, unit_cost_amount, inventory_transaction_id,
        created_by, updated_by
      )
      values (
        ${input.receiptInternalId}, ${input.purchaseOrderLineInternalId}, ${input.lineNo},
        ${input.variantInternalId}, ${input.quantity}::numeric, ${input.quantity}::numeric, 0,
        ${input.unitCostAmount}, ${input.inventoryTransactionInternalId},
        ${input.createdBy}, ${input.createdBy}
      )
      returning id::text as "internalId", public_id as id, null::text as "documentNo"
    `;
    const row = rows[0];
    if (row === undefined) throw new RangeError('goods_receipt_line_insert_failed');
    return row;
  }

  /** Creates one traceability row per received serial (`inventory_serials`). */
  async insertSerial(
    tx: Db,
    input: {
      variantInternalId: bigint;
      serialNo: string;
      locationInternalId: bigint;
      receivedAt: Date;
      createdBy: bigint | null;
    },
  ): Promise<void> {
    await tx`
      insert into erp.inventory_serials (
        product_variant_id, serial_no, status, location_id, received_at, created_by, updated_by
      )
      values (
        ${input.variantInternalId}, ${input.serialNo}, 'available', ${input.locationInternalId},
        ${input.receivedAt}, ${input.createdBy}, ${input.createdBy}
      )
    `;
  }

  // ------------------------------------------------------------------- reads

  async listReceipts(tx: Db, params: ReceiptListParams): Promise<GoodsReceiptListRow[]> {
    return tx<GoodsReceiptListRow[]>`
      select gr.id::text as "internalId",
             gr.public_id as id,
             gr.receipt_no as "receiptNo",
             gr.received_at as "receivedAt",
             gr.business_date::text as "businessDate",
             gr.status,
             po.public_id as "purchaseOrderId",
             po.po_no as "poNo",
             s.public_id as "supplierId",
             s.name as "supplierName",
             w.public_id as "warehouseId",
             w.name as "warehouseName",
             po.subtotal_amount::text as "subtotalAmount",
             po.grand_total_amount::text as "grandTotalAmount",
             (select count(*)::int from erp.goods_receipt_lines l where l.receipt_id = gr.id) as "lineCount",
             coalesce(
               (select sum(l.accepted_qty) from erp.goods_receipt_lines l where l.receipt_id = gr.id),
               0
             )::text as "totalQuantity"
      from erp.goods_receipts gr
      left join erp.purchase_orders po
        on po.id = gr.purchase_order_id and po.organization_id = gr.organization_id
      left join erp.suppliers s on s.id = po.supplier_id and s.deleted_at is null
      left join erp.warehouses w on w.id = gr.warehouse_id
      where gr.organization_id = ${params.orgId}
        and (${params.q}::text is null
             or coalesce(gr.receipt_no, '') ilike '%' || ${params.q}::text || '%'
             or coalesce(s.name, '') ilike '%' || ${params.q}::text || '%'
             or coalesce(w.name, '') ilike '%' || ${params.q}::text || '%'
             or coalesce(po.po_no, '') ilike '%' || ${params.q}::text || '%')
        and (${params.supplierPublicId}::uuid is null or s.public_id = ${params.supplierPublicId}::uuid)
        and (${params.warehousePublicId}::uuid is null or w.public_id = ${params.warehousePublicId}::uuid)
        and (${params.warehouseIds ?? null}::bigint[] is null or gr.warehouse_id = any(${params.warehouseIds ?? null}::bigint[]))
      order by gr.received_at desc, gr.id desc
      limit ${params.limit} offset ${params.offset}
    `;
  }

  async countReceipts(tx: Db, params: Omit<ReceiptListParams, 'limit' | 'offset'>): Promise<number> {
    const rows = await tx<{ total: string }[]>`
      select count(*)::text as total
      from erp.goods_receipts gr
      left join erp.purchase_orders po
        on po.id = gr.purchase_order_id and po.organization_id = gr.organization_id
      left join erp.suppliers s on s.id = po.supplier_id and s.deleted_at is null
      left join erp.warehouses w on w.id = gr.warehouse_id
      where gr.organization_id = ${params.orgId}
        and (${params.q}::text is null
             or coalesce(gr.receipt_no, '') ilike '%' || ${params.q}::text || '%'
             or coalesce(s.name, '') ilike '%' || ${params.q}::text || '%'
             or coalesce(w.name, '') ilike '%' || ${params.q}::text || '%'
             or coalesce(po.po_no, '') ilike '%' || ${params.q}::text || '%')
        and (${params.supplierPublicId}::uuid is null or s.public_id = ${params.supplierPublicId}::uuid)
        and (${params.warehousePublicId}::uuid is null or w.public_id = ${params.warehousePublicId}::uuid)
        and (${params.warehouseIds ?? null}::bigint[] is null or gr.warehouse_id = any(${params.warehouseIds ?? null}::bigint[]))
    `;
    return Number(rows[0]?.total ?? '0');
  }

  async findReceipt(tx: Db, orgId: bigint, publicId: string): Promise<GoodsReceiptListRow | null> {
    const rows = await tx<GoodsReceiptListRow[]>`
      select gr.id::text as "internalId",
             gr.public_id as id,
             gr.receipt_no as "receiptNo",
             gr.received_at as "receivedAt",
             gr.business_date::text as "businessDate",
             gr.status,
             po.public_id as "purchaseOrderId",
             po.po_no as "poNo",
             s.public_id as "supplierId",
             s.name as "supplierName",
             w.public_id as "warehouseId",
             w.name as "warehouseName",
             po.subtotal_amount::text as "subtotalAmount",
             po.grand_total_amount::text as "grandTotalAmount",
             (select count(*)::int from erp.goods_receipt_lines l where l.receipt_id = gr.id) as "lineCount",
             coalesce(
               (select sum(l.accepted_qty) from erp.goods_receipt_lines l where l.receipt_id = gr.id),
               0
             )::text as "totalQuantity"
      from erp.goods_receipts gr
      left join erp.purchase_orders po
        on po.id = gr.purchase_order_id and po.organization_id = gr.organization_id
      left join erp.suppliers s on s.id = po.supplier_id and s.deleted_at is null
      left join erp.warehouses w on w.id = gr.warehouse_id
      where gr.organization_id = ${orgId} and gr.public_id = ${publicId}::uuid
      limit 1
    `;
    return rows[0] ?? null;
  }

  /**
   * Receipt lines with their posted ledger entry and the serials received with this
   * receipt. `inventory_serials` carries no receipt reference, so serials are bound to
   * the line by variant **and** the receipt's exact `received_at` timestamp (both
   * written by `PurchasingService` in the same transaction). Always organization-scoped.
   */
  async listReceiptLines(tx: Db, orgId: bigint, receiptPublicId: string): Promise<GoodsReceiptLineRow[]> {
    return tx<GoodsReceiptLineRow[]>`
      select l.public_id as id,
             l.line_no as "lineNo",
             v.public_id as "variantId",
             v.sku,
             p.name as "productName",
             l.quantity::text as quantity,
             l.accepted_qty::text as "acceptedQty",
             l.rejected_qty::text as "rejectedQty",
             l.unit_cost_amount::text as "unitCostAmount",
             pol.line_total_amount::text as "lineTotalAmount",
             pol.public_id as "purchaseOrderLineId",
             t.public_id as "inventoryTransactionId",
             coalesce(
               (select json_agg(json_build_object(
                         'id', s.public_id,
                         'serialNo', s.serial_no,
                         'status', s.status
                       ) order by s.serial_no asc)
                from erp.inventory_serials s
                where s.product_variant_id = l.product_variant_id
                  and s.received_at = gr.received_at),
               '[]'::json
             ) as serials
      from erp.goods_receipts gr
      join erp.goods_receipt_lines l on l.receipt_id = gr.id
      join erp.product_variants v on v.id = l.product_variant_id
      join erp.products p on p.id = v.product_id
      left join erp.purchase_order_lines pol on pol.id = l.purchase_order_line_id
      left join erp.inventory_transactions t on t.id = l.inventory_transaction_id
      where gr.organization_id = ${orgId} and gr.public_id = ${receiptPublicId}::uuid
      order by l.line_no asc
    `;
  }

  /** Active variant→channel mappings that can accept a stock push. */
  async listChannelTargets(tx: Db, orgId: bigint, variantInternalId: bigint): Promise<ChannelTargetRow[]> {
    return tx<ChannelTargetRow[]>`
      select ca.id::text as "accountInternalId",
             ca.public_id as "accountId",
             sc.code as "channelCode",
             sc.name as "channelName",
             m.external_product_id as "externalProductId",
             m.external_variant_id as "externalVariantId"
      from erp.channel_product_mappings m
      join erp.channel_accounts ca
        on ca.id = m.channel_account_id
       and ca.organization_id = ${orgId}
       and ca.is_active
       and ca.deleted_at is null
       and ca.stock_push_enabled
      join erp.sales_channels sc on sc.id = ca.channel_id and sc.deleted_at is null and sc.is_active
      where m.product_variant_id = ${variantInternalId} and m.deleted_at is null
      order by sc.code asc, ca.id asc
    `;
  }
}
