/**
 * Sales SQL (`DATA-MODEL` §2.9): customers, addresses, sales orders, invoices,
 * returns and refunds. Tenant-scoped and parameterized; writes never touch other
 * modules' tables (inventory is updated through `InventoryService`).
 */
import type { BigIntish, Db } from './sales.pg-support';

export interface CustomerRow {
  internalId: string;
  id: string;
  customerNo: string;
  fullName: string;
  mobile: string | null;
  nationalId: string | null;
  email: string | null;
  customerType: string;
  creditLimitAmount: string;
  paymentTermsDays: number;
  status: string;
  notes: string | null;
  version: number;
  createdAt: string;
}

export interface AddressRow {
  internalId: string;
  id: string;
  customerId: string;
  label: string | null;
  addressType: string;
  receiverName: string | null;
  receiverMobile: string | null;
  province: string | null;
  city: string | null;
  district: string | null;
  addressLine: string;
  postalCode: string | null;
  latitude: string | null;
  longitude: string | null;
  isDefault: boolean;
}

export interface OrderRow {
  internalId: string;
  id: string;
  orderNo: string | null;
  customerId: string;
  customerInternalId: string;
  customerName: string;
  channelCode: string | null;
  channelAccountInternalId: string | null;
  externalOrderId: string | null;
  warehouseId: string | null;
  warehouseInternalId: string | null;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  currency: string;
  subtotalAmount: string;
  discountAmount: string;
  taxAmount: string;
  shippingAmount: string;
  grandTotalAmount: string;
  paidAmount: string;
  refundedAmount: string;
  customerNote: string | null;
  idempotencyKey: string | null;
  orderDate: string;
  businessDate: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  version: number;
  createdAt: string;
}

export interface OrderLineRow {
  internalId: string;
  id: string;
  orderInternalId: string;
  lineNo: number;
  variantId: string;
  variantInternalId: string;
  sku: string | null;
  title: string | null;
  quantity: string;
  unitPriceAmount: string;
  discountAmount: string;
  netAmount: string;
  taxPercent: string;
  taxAmount: string;
  grossAmount: string;
  allocatedHeaderDiscountAmount: string;
  status: string;
}

export interface InvoiceRow {
  internalId: string;
  id: string;
  invoiceNo: string | null;
  orderId: string | null;
  orderInternalId: string | null;
  customerId: string;
  customerInternalId: string;
  documentKind: string;
  invoiceDate: string;
  status: string;
  subtotalAmount: string;
  discountAmount: string;
  taxAmount: string;
  grandTotalAmount: string;
  netAmount: string;
  roundingAmount: string;
  originalInvoiceId: string | null;
  version: number;
  createdAt: string;
}

export interface InvoiceLineRow {
  internalId: string;
  id: string;
  variantId: string;
  quantity: string;
  unitPriceAmount: string;
  discountAmount: string;
  netAmount: string;
  taxPercent: string;
  taxAmount: string;
  grossAmount: string;
}

export interface ReturnRow {
  internalId: string;
  id: string;
  returnNo: string;
  orderId: string;
  orderInternalId: string;
  status: string;
  reasonCode: string;
  description: string | null;
  resolution: string | null;
  requestedAt: string;
  receivedAt: string | null;
  approvedAt: string | null;
  version: number;
}

export interface ReturnLineRow {
  internalId: string;
  id: string;
  variantId: string;
  variantInternalId: string;
  orderLineId: string | null;
  quantity: string;
  condition: string;
  restockAction: string;
  netAmount: string;
  taxAmount: string;
  grossAmount: string;
  refundAmount: string;
}

export interface RefundRow {
  internalId: string;
  id: string;
  refundNo: string;
  returnId: string | null;
  returnInternalId: string | null;
  customerId: string;
  customerInternalId: string;
  amount: string;
  method: string;
  status: string;
  reason: string | null;
  processedAt: string | null;
  version: number;
}

function customerColumns(tx: Db) {
  return tx`
    c.id::text as "internalId",
    c.public_id as id,
    c.customer_no as "customerNo",
    c.full_name as "fullName",
    c.mobile,
    c.national_id as "nationalId",
    c.email,
    c.customer_type as "customerType",
    c.credit_limit_amount::text as "creditLimitAmount",
    c.payment_terms_days as "paymentTermsDays",
    c.status,
    c.notes,
    c.version,
    c.created_at::text as "createdAt"
  `;
}

interface CustomerInsert {
  orgId: BigIntish;
  customerNo: string;
  fullName: string;
  mobile: string | null;
  nationalId: string | null;
  email: string | null;
  customerType: string;
  creditLimitAmount: bigint;
  paymentTermsDays: number;
  notes: string | null;
}

interface OrderInsert {
  orgId: BigIntish;
  orderNo: string | null;
  customerInternalId: BigIntish;
  channelAccountInternalId: BigIntish | null;
  externalOrderId: string | null;
  warehouseInternalId: BigIntish | null;
  status: string;
  currency: string;
  subtotalAmount: bigint;
  discountAmount: bigint;
  taxAmount: bigint;
  shippingAmount: bigint;
  grandTotalAmount: bigint;
  shippingAddressJson: string | null;
  customerNote: string | null;
  idempotencyKey: string | null;
  businessDate: string;
  createdBy: BigIntish | null;
  orderDate: string;
}

interface OrderLineInsert {
  orderInternalId: BigIntish;
  lineNo: number;
  variantInternalId: BigIntish;
  skuSnapshot: string;
  titleSnapshot: string;
  quantity: string;
  unitPriceAmount: bigint;
  discountAmount: bigint;
  netAmount: bigint;
  taxPercent: string;
  taxAmount: bigint;
  grossAmount: bigint;
  allocatedHeaderDiscountAmount: bigint;
}

export class SalesRepository {
  constructor(private readonly db: Db) {}

  // ================================================================ customers

  async listCustomers(
    tx: Db,
    params: {
      orgId: bigint;
      search: string | null;
      mobile: string | null;
      status: string | null;
      limit: number;
      offset: number;
    },
  ): Promise<CustomerRow[]> {
    const pattern = params.search === null ? null : `%${params.search}%`;
    return tx<CustomerRow[]>`
      select ${customerColumns(tx)}
      from erp.sales.customers c
      where c.organization_id = ${params.orgId} and c.deleted_at is null
        and (${pattern}::text is null or c.full_name ilike ${pattern} or c.mobile ilike ${pattern})
        and (${params.mobile}::text is null or c.mobile = ${params.mobile})
        and (${params.status}::text is null or c.status = ${params.status})
      order by c.created_at desc, c.id desc
      limit ${params.limit} offset ${params.offset}
    `;
  }

  async countCustomers(tx: Db, params: { orgId: bigint; status: string | null }): Promise<number> {
    const rows = await tx<{ total: string }[]>`
      select count(*)::text as total from erp.sales.customers
      where organization_id = ${params.orgId} and deleted_at is null
        and (${params.status}::text is null or status = ${params.status})
    `;
    return Number(rows[0]?.total ?? '0');
  }

  async findCustomer(tx: Db, orgId: bigint, publicId: string): Promise<CustomerRow | null> {
    const rows = await tx<CustomerRow[]>`
      select ${customerColumns(tx)} from erp.sales.customers c
      where c.organization_id = ${orgId} and c.public_id = ${publicId} and c.deleted_at is null
      limit 1
    `;
    return rows[0] ?? null;
  }

  async findCustomerByMobile(tx: Db, orgId: bigint, mobile: string): Promise<CustomerRow | null> {
    const rows = await tx<CustomerRow[]>`
      select ${customerColumns(tx)} from erp.sales.customers c
      where c.organization_id = ${orgId} and c.mobile = ${mobile} and c.deleted_at is null limit 1
    `;
    return rows[0] ?? null;
  }

  async insertCustomer(tx: Db, input: CustomerInsert): Promise<CustomerRow> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.sales.customers
        (organization_id, public_id, customer_no, full_name, mobile, national_id, email,
         customer_type, credit_limit_amount, payment_terms_days, notes)
      values (${input.orgId}, gen_random_uuid(), ${input.customerNo}, ${input.fullName},
              ${input.mobile}, ${input.nationalId}, ${input.email}, ${input.customerType},
              ${input.creditLimitAmount}, ${input.paymentTermsDays}, ${input.notes})
      returning id::text as id
    `;
    const created = rows[0];
    if (created === undefined) throw new Error('customer_insert_failed');
    const full = await tx<CustomerRow[]>`
      select ${customerColumns(tx)} from erp.sales.customers c where c.id = ${created.id}::bigint
    `;
    return full[0] as CustomerRow;
  }

  async updateCustomer(
    tx: Db,
    orgId: bigint,
    internalId: bigint,
    patch: { fullName: string; email: string | null; status: string; notes: string | null; creditLimitAmount: bigint; paymentTermsDays: number },
  ): Promise<CustomerRow> {
    await tx`
      update erp.sales.customers
      set full_name = ${patch.fullName}, email = ${patch.email}, status = ${patch.status},
          notes = ${patch.notes}, credit_limit_amount = ${patch.creditLimitAmount},
          payment_terms_days = ${patch.paymentTermsDays}, updated_at = now(), version = version + 1
      where organization_id = ${orgId} and id = ${internalId}
    `;
    const rows = await tx<CustomerRow[]>`
      select ${customerColumns(tx)} from erp.sales.customers c
      where c.organization_id = ${orgId} and c.id = ${internalId}
    `;
    return rows[0] as CustomerRow;
  }

  async softDeleteCustomer(tx: Db, orgId: bigint, internalId: bigint): Promise<void> {
    await tx`
      update erp.sales.customers set deleted_at = now(), status = 'inactive',
        updated_at = now(), version = version + 1
      where organization_id = ${orgId} and id = ${internalId}
    `;
  }

  async countOpenOrdersForCustomer(tx: Db, orgId: bigint, customerInternalId: bigint): Promise<number> {
    const rows = await tx<{ total: string }[]>`
      select count(*)::text as total from erp.sales.sales_orders
      where organization_id = ${orgId} and customer_id = ${customerInternalId}
        and status not in ('closed', 'cancelled', 'delivered', 'returned')
    `;
    return Number(rows[0]?.total ?? '0');
  }

  async listAddresses(tx: Db, customerInternalId: bigint): Promise<AddressRow[]> {
    return tx<AddressRow[]>`
      select a.id::text as "internalId", a.public_id as id, c.public_id as "customerId",
             a.label, a.address_type as "addressType", a.receiver_name as "receiverName",
             a.receiver_mobile as "receiverMobile", a.province, a.city, a.district,
             a.address_line as "addressLine", a.postal_code as "postalCode",
             a.latitude::text as latitude, a.longitude::text as longitude,
             a.is_default as "isDefault"
      from erp.sales.customer_addresses a
      join erp.sales.customers c on c.id = a.customer_id
      where a.customer_id = ${customerInternalId}
      order by a.is_default desc, a.id asc
    `;
  }

  async insertAddress(
    tx: Db,
    input: {
      customerInternalId: bigint;
      label: string | null;
      addressType: string;
      receiverName: string | null;
      receiverMobile: string | null;
      province: string | null;
      city: string | null;
      district: string | null;
      addressLine: string;
      postalCode: string | null;
      latitude: string | null;
      longitude: string | null;
      isDefault: boolean;
    },
  ): Promise<AddressRow> {
    if (input.isDefault) {
      await tx`
        update erp.sales.customer_addresses set is_default = false
        where customer_id = ${input.customerInternalId} and address_type = ${input.addressType}
      `;
    }
    const rows = await tx<{ id: string }[]>`
      insert into erp.sales.customer_addresses
        (customer_id, public_id, label, address_type, receiver_name, receiver_mobile,
         province, city, district, address_line, postal_code, latitude, longitude, is_default)
      values (${input.customerInternalId}, gen_random_uuid(), ${input.label}, ${input.addressType},
              ${input.receiverName}, ${input.receiverMobile}, ${input.province}, ${input.city},
              ${input.district}, ${input.addressLine}, ${input.postalCode},
              ${input.latitude}::numeric, ${input.longitude}::numeric, ${input.isDefault})
      returning id::text as id
    `;
    const created = rows[0];
    if (created === undefined) throw new Error('address_insert_failed');
    const all = await this.listAddresses(tx, input.customerInternalId);
    const row = all.find((address) => address.internalId === created.id);
    if (row === undefined) throw new Error('address_read_failed');
    return row;
  }

  async findAddress(tx: Db, customerInternalId: bigint, publicId: string): Promise<AddressRow | null> {
    const all = await this.listAddresses(tx, customerInternalId);
    return all.find((address) => address.id === publicId) ?? null;
  }

  async updateAddress(
    tx: Db,
    customerInternalId: bigint,
    publicId: string,
    patch: {
      label: string | null;
      receiverName: string | null;
      receiverMobile: string | null;
      province: string | null;
      city: string | null;
      addressLine: string;
      postalCode: string | null;
      isDefault: boolean;
    },
  ): Promise<void> {
    if (patch.isDefault) {
      await tx`update erp.sales.customer_addresses set is_default = false where customer_id = ${customerInternalId}`;
    }
    await tx`
      update erp.sales.customer_addresses
      set label = ${patch.label}, receiver_name = ${patch.receiverName},
          receiver_mobile = ${patch.receiverMobile}, province = ${patch.province},
          city = ${patch.city}, address_line = ${patch.addressLine},
          postal_code = ${patch.postalCode}, is_default = ${patch.isDefault}
      where customer_id = ${customerInternalId} and public_id = ${publicId}
    `;
  }

  async deleteAddress(tx: Db, customerInternalId: bigint, publicId: string): Promise<boolean> {
    const rows = await tx<{ id: string }[]>`
      delete from erp.sales.customer_addresses
      where customer_id = ${customerInternalId} and public_id = ${publicId}
        and is_default = false
      returning id::text as id
    `;
    return rows.length > 0;
  }

  async customerArSnapshot(
    tx: Db,
    orgId: bigint,
    customerInternalId: bigint,
  ): Promise<{ openOrders: number; outstandingAmount: string }> {
    const rows = await tx<{ open_orders: string; outstanding: string }[]>`
      select count(*)::text as open_orders,
             coalesce(sum(grand_total_amount - paid_amount - refunded_amount), 0)::text as outstanding
      from erp.sales.sales_orders
      where organization_id = ${orgId} and customer_id = ${customerInternalId}
        and status not in ('closed', 'cancelled')
    `;
    const row = rows[0];
    return { openOrders: Number(row?.open_orders ?? '0'), outstandingAmount: row?.outstanding ?? '0' };
  }

  // =================================================================== orders

  async listOrders(
    tx: Db,
    params: {
      orgId: bigint;
      status: string | null;
      customerInternalId: BigIntish | null;
      channelCode: string | null;
      warehouseInternalId: BigIntish | null;
      createdFrom: string | null;
      limit: number;
      offset: number;
    },
  ): Promise<OrderRow[]> {
    return tx<OrderRow[]>`
      select ${this.orderColumns(tx)}
      ${this.orderFrom(tx)}
      where o.organization_id = ${params.orgId}
        and (${params.status}::text is null or o.status = ${params.status})
        and (${params.customerInternalId}::bigint is null or o.customer_id = ${params.customerInternalId}::bigint)
        and (${params.channelCode}::text is null or ch.code = ${params.channelCode})
        and (${params.warehouseInternalId}::bigint is null or o.warehouse_id = ${params.warehouseInternalId}::bigint)
        and (${params.createdFrom}::timestamptz is null or o.created_at >= ${params.createdFrom}::timestamptz)
      order by o.created_at desc, o.id desc
      limit ${params.limit} offset ${params.offset}
    `;
  }

  private orderColumns(tx: Db) {
    return tx`
      o.id::text as "internalId",
      o.public_id as id,
      o.order_no as "orderNo",
      c.public_id as "customerId",
      o.customer_id::text as "customerInternalId",
      c.full_name as "customerName",
      ch.code as "channelCode",
      o.channel_account_id::text as "channelAccountInternalId",
      o.external_order_id as "externalOrderId",
      w.public_id as "warehouseId",
      o.warehouse_id::text as "warehouseInternalId",
      o.status,
      o.payment_status as "paymentStatus",
      o.fulfillment_status as "fulfillmentStatus",
      o.currency,
      o.subtotal_amount::text as "subtotalAmount",
      o.discount_amount::text as "discountAmount",
      o.tax_amount::text as "taxAmount",
      o.shipping_amount::text as "shippingAmount",
      o.grand_total_amount::text as "grandTotalAmount",
      o.paid_amount::text as "paidAmount",
      o.refunded_amount::text as "refundedAmount",
      o.customer_note as "customerNote",
      o.idempotency_key as "idempotencyKey",
      o.order_date::text as "orderDate",
      o.business_date::text as "businessDate",
      o.confirmed_at::text as "confirmedAt",
      o.cancelled_at::text as "cancelledAt",
      o.cancel_reason as "cancelReason",
      o.version,
      o.created_at::text as "createdAt"
    `;
  }

  private orderFrom(tx: Db) {
    return tx`
      from erp.sales.sales_orders o
      join erp.sales.customers c on c.id = o.customer_id
      left join erp.warehouse.warehouses w on w.id = o.warehouse_id
      left join erp.channels.channel_accounts ca on ca.id = o.channel_account_id
      left join erp.channels.sales_channels ch on ch.id = ca.channel_id
    `;
  }

  async findOrder(tx: Db, orgId: bigint, publicId: string): Promise<OrderRow | null> {
    const rows = await tx<OrderRow[]>`
      select ${this.orderColumns(tx)} ${this.orderFrom(tx)}
      where o.organization_id = ${orgId} and o.public_id = ${publicId}
      limit 1
    `;
    return rows[0] ?? null;
  }

  async lockOrder(tx: Db, orgId: bigint, publicId: string): Promise<OrderRow | null> {
    const rows = await tx<OrderRow[]>`
      select ${this.orderColumns(tx)} ${this.orderFrom(tx)}
      where o.organization_id = ${orgId} and o.public_id = ${publicId}
      for update of o
    `;
    return rows[0] ?? null;
  }

  async findOrderByIdempotencyKey(tx: Db, orgId: bigint, key: string): Promise<OrderRow | null> {
    const rows = await tx<OrderRow[]>`
      select ${this.orderColumns(tx)} ${this.orderFrom(tx)}
      where o.organization_id = ${orgId} and o.idempotency_key = ${key}
      limit 1
    `;
    return rows[0] ?? null;
  }

  async insertOrder(tx: Db, input: OrderInsert): Promise<OrderRow> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.sales.sales_orders
        (organization_id, public_id, order_no, customer_id, channel_account_id, external_order_id,
         warehouse_id, status, currency, subtotal_amount, discount_amount, tax_amount,
         shipping_amount, grand_total_amount, shipping_address_json, customer_note,
         idempotency_key, business_date, order_date, created_by)
      values (${input.orgId}, gen_random_uuid(), ${input.orderNo}, ${input.customerInternalId},
              ${input.channelAccountInternalId}, ${input.externalOrderId}, ${input.warehouseInternalId},
              ${input.status}, ${input.currency}, ${input.subtotalAmount}, ${input.discountAmount},
              ${input.taxAmount}, ${input.shippingAmount}, ${input.grandTotalAmount},
              ${input.shippingAddressJson}::jsonb, ${input.customerNote}, ${input.idempotencyKey},
              ${input.businessDate}::date, ${input.orderDate}::timestamptz, ${input.createdBy})
      returning id::text as id
    `;
    const created = rows[0];
    if (created === undefined) throw new Error('order_insert_failed');
    const full = await tx<OrderRow[]>`
      select ${this.orderColumns(tx)} ${this.orderFrom(tx)} where o.id = ${created.id}::bigint
    `;
    return full[0] as OrderRow;
  }

  async updateOrderTotals(
    tx: Db,
    internalId: bigint,
    totals: {
      subtotalAmount: bigint;
      discountAmount: bigint;
      taxAmount: bigint;
      shippingAmount: bigint;
      grandTotalAmount: bigint;
      customerNote: string | null;
    },
  ): Promise<void> {
    await tx`
      update erp.sales.sales_orders
      set subtotal_amount = ${totals.subtotalAmount}, discount_amount = ${totals.discountAmount},
          tax_amount = ${totals.taxAmount}, shipping_amount = ${totals.shippingAmount},
          grand_total_amount = ${totals.grandTotalAmount}, customer_note = ${totals.customerNote},
          updated_at = now(), version = version + 1
      where id = ${internalId}
    `;
  }

  async updateOrderStatus(
    tx: Db,
    internalId: bigint,
    patch: {
      status: string;
      orderNo?: string | null;
      confirmed?: boolean;
      cancelled?: boolean;
      cancelReason?: string | null;
      onHold?: boolean;
      submitted?: boolean;
      fulfillmentStatus?: string | null;
      packed?: boolean;
      shipped?: boolean;
      delivered?: boolean;
      closed?: boolean;
    },
  ): Promise<void> {
    await tx`
      update erp.sales.sales_orders
      set status = ${patch.status},
          order_no = coalesce(${patch.orderNo ?? null}, order_no),
          confirmed_at = case when ${patch.confirmed === true}::boolean then now() else confirmed_at end,
          submitted_at = case when ${patch.submitted === true}::boolean then now() else submitted_at end,
          on_hold_at = case when ${patch.onHold === true}::boolean then now() else on_hold_at end,
          cancelled_at = case when ${patch.cancelled === true}::boolean then now() else cancelled_at end,
          cancel_reason = ${patch.cancelReason ?? null},
          closed_at = case when ${patch.closed === true}::boolean then now() else closed_at end,
          fulfillment_status = coalesce(${patch.fulfillmentStatus ?? null}, fulfillment_status),
          updated_at = now(), version = version + 1
      where id = ${internalId}
    `;
  }

  async deleteOrder(tx: Db, orgId: bigint, internalId: bigint): Promise<void> {
    await tx`
      delete from erp.sales.sales_orders
      where organization_id = ${orgId} and id = ${internalId} and status in ('draft', 'submitted')
    `;
  }

  async insertOrderLine(tx: Db, input: OrderLineInsert): Promise<OrderLineRow> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.sales.sales_order_lines
        (order_id, public_id, line_no, product_variant_id, sku_snapshot, title_snapshot,
         quantity, unit_price_amount, discount_amount, net_amount, tax_percent, tax_amount,
         gross_amount, allocated_header_discount_amount)
      values (${input.orderInternalId}, gen_random_uuid(), ${input.lineNo}, ${input.variantInternalId},
              ${input.skuSnapshot}, ${input.titleSnapshot}, ${input.quantity}::numeric,
              ${input.unitPriceAmount}, ${input.discountAmount}, ${input.netAmount},
              ${input.taxPercent}::numeric, ${input.taxAmount}, ${input.grossAmount},
              ${input.allocatedHeaderDiscountAmount})
      returning id::text as id
    `;
    const created = rows[0];
    if (created === undefined) throw new Error('order_line_insert_failed');
    return (await this.mapOrderLine(tx, created.id)) as OrderLineRow;
  }

  private async mapOrderLine(tx: Db, id: string): Promise<OrderLineRow | null> {
    const rows = await tx<OrderLineRow[]>`
      select l.id::text as "internalId", l.public_id as id, l.order_id::text as "orderInternalId",
             l.line_no as "lineNo", v.public_id as "variantId",
             l.product_variant_id::text as "variantInternalId", l.sku_snapshot as sku,
             l.title_snapshot as title, l.quantity::text as quantity,
             l.unit_price_amount::text as "unitPriceAmount", l.discount_amount::text as "discountAmount",
             l.net_amount::text as "netAmount", l.tax_percent::text as "taxPercent",
             l.tax_amount::text as "taxAmount", l.gross_amount::text as "grossAmount",
             l.allocated_header_discount_amount::text as "allocatedHeaderDiscountAmount", l.status
      from erp.sales.sales_order_lines l
      join erp.catalog.product_variants v on v.id = l.product_variant_id
      where l.id = ${id}::bigint
    `;
    return rows[0] ?? null;
  }

  async listOrderLines(tx: Db, orderInternalId: bigint): Promise<OrderLineRow[]> {
    const rows = await tx<{ id: string }[]>`
      select id::text as id from erp.sales.sales_order_lines
      where order_id = ${orderInternalId} order by line_no asc
    `;
    const lines: OrderLineRow[] = [];
    for (const row of rows) {
      const line = await this.mapOrderLine(tx, row.id);
      if (line !== null) lines.push(line);
    }
    return lines;
  }

  async deleteOrderLines(tx: Db, orderInternalId: bigint): Promise<void> {
    await tx`delete from erp.sales.sales_order_lines where order_id = ${orderInternalId}`;
  }

  async appendStatusHistory(
    tx: Db,
    input: {
      orderInternalId: bigint;
      fromStatus: string | null;
      toStatus: string;
      field: string;
      changedBy: bigint | null;
      source: string;
      reason: string | null;
    },
  ): Promise<void> {
    await tx`
      insert into erp.sales.order_status_history
        (order_id, from_status, to_status, field, changed_by, source, reason)
      values (${input.orderInternalId}, ${input.fromStatus}, ${input.toStatus}, ${input.field},
              ${input.changedBy}, ${input.source}, ${input.reason})
    `;
  }

  async listStatusHistory(tx: Db, orderInternalId: bigint): Promise<
    { fromStatus: string | null; toStatus: string; field: string; changedAt: string; reason: string | null }[]
  > {
    return tx`
      select from_status as "fromStatus", to_status as "toStatus", field,
             changed_at::text as "changedAt", reason
      from erp.sales.order_status_history
      where order_id = ${orderInternalId}
      order by changed_at asc, id asc
    `;
  }

  /** Confirmed orders waiting for fulfillment (queue endpoint). */
  async fulfillmentQueue(
    tx: Db,
    params: { orgId: bigint; warehouseInternalId: BigIntish | null; status: string | null; limit: number },
  ): Promise<OrderRow[]> {
    return tx<OrderRow[]>`
      select ${this.orderColumns(tx)} ${this.orderFrom(tx)}
      where o.organization_id = ${params.orgId}
        and o.status in ('confirmed', 'allocated', 'picking', 'packed')
        and (${params.status}::text is null or o.status = ${params.status})
        and (${params.warehouseInternalId}::bigint is null or o.warehouse_id = ${params.warehouseInternalId}::bigint)
      order by o.order_date asc, o.id asc
      limit ${params.limit}
    `;
  }

  async resolveWarehouseId(tx: Db, orgId: bigint, publicId: string): Promise<bigint | null> {
    const rows = await tx<{ id: string }[]>`
      select id::text as id from erp.warehouse.warehouses
      where organization_id = ${orgId} and public_id = ${publicId} and deleted_at is null limit 1
    `;
    return rows[0] === undefined ? null : BigInt(rows[0].id);
  }

  async resolveChannelAccountId(tx: Db, orgId: bigint, channelCode: string): Promise<bigint | null> {
    const rows = await tx<{ id: string }[]>`
      select ca.id::text as id
      from erp.channels.channel_accounts ca
      join erp.channels.sales_channels ch on ch.id = ca.channel_id
      where ca.organization_id = ${orgId} and ch.code = ${channelCode} and ca.is_active
      order by ca.is_default desc limit 1
    `;
    return rows[0] === undefined ? null : BigInt(rows[0].id);
  }

  async allocateDocumentNo(tx: Db, orgId: bigint, documentType: string, businessDate: string): Promise<string> {
    const rows = await tx<{ prefix: string; next_value: string; padding: number; fiscal_year: string }[]>`
      select ns.prefix, ns.next_value::text as next_value, ns.padding,
             to_char(fy.start_date, 'YYYY') as fiscal_year
      from erp.platform.numbering_sequences ns
      join erp.accounting.fiscal_years fy on fy.id = ns.fiscal_year_id
      where ns.organization_id = ${orgId} and ns.document_type = ${documentType}
        and fy.start_date <= ${businessDate}::date and fy.end_date >= ${businessDate}::date
      for update of ns
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new (await import('@saman/shared')).AppError('RULE_VIOLATION', {
        message: 'دنبالهٔ شماره‌گذاری برای این نوع سند تعریف نشده است.',
        messageKey: 'sales.numbering_sequence_missing',
        details: [{ rule: 'numbering_sequence_missing', params: { documentType } }],
      });
    }
    await tx`
      update erp.platform.numbering_sequences
      set next_value = next_value + 1, last_allocated_at = now()
      where organization_id = ${orgId} and document_type = ${documentType}
        and fiscal_year_id = (select fiscal_year_id from erp.platform.numbering_sequences
                              where organization_id = ${orgId} and document_type = ${documentType} limit 1)
    `;
    return `${row.prefix}-${row.fiscal_year}-${BigInt(row.next_value).toString().padStart(Number(row.padding), '0')}`;
  }

  // ================================================================= invoices

  async insertInvoice(
    tx: Db,
    input: {
      orgId: bigint;
      customerInternalId: bigint;
      orderInternalId: bigint | null;
      documentKind: string;
      originalInvoiceInternalId: bigint | null;
      invoiceDate: string;
      status: string;
      subtotalAmount: bigint;
      discountAmount: bigint;
      taxAmount: bigint;
      grandTotalAmount: bigint;
      netAmount: bigint;
      roundingAmount: bigint;
      sellerName: string;
    },
  ): Promise<InvoiceRow> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.sales.customer_invoices
        (organization_id, public_id, customer_id, order_id, invoice_no, document_kind,
         original_invoice_id, invoice_date, status, subtotal_amount, discount_amount, tax_amount,
         grand_total_amount, net_amount, rounding_amount, seller_name, currency)
      values (${input.orgId}, gen_random_uuid(), ${input.customerInternalId}, ${input.orderInternalId},
              null, ${input.documentKind}, ${input.originalInvoiceInternalId}, ${input.invoiceDate}::date,
              ${input.status}, ${input.subtotalAmount}, ${input.discountAmount}, ${input.taxAmount},
              ${input.grandTotalAmount}, ${input.netAmount}, ${input.roundingAmount},
              ${input.sellerName}, 'IRR')
      returning id::text as id
    `;
    const created = rows[0];
    if (created === undefined) throw new Error('invoice_insert_failed');
    return (await this.findInvoiceById(tx, input.orgId, BigInt(created.id))) as InvoiceRow;
  }

  async insertInvoiceLine(
    tx: Db,
    input: {
      invoiceInternalId: bigint;
      variantInternalId: bigint;
      quantity: string;
      unitPriceAmount: bigint;
      discountAmount: bigint;
      netAmount: bigint;
      taxPercent: string;
      taxAmount: bigint;
      grossAmount: bigint;
    },
  ): Promise<void> {
    await tx`
      insert into erp.sales.customer_invoice_lines
        (customer_invoice_id, public_id, product_variant_id, quantity, unit_price_amount,
         discount_amount, net_amount, tax_percent, tax_amount, gross_amount)
      values (${input.invoiceInternalId}, gen_random_uuid(), ${input.variantInternalId},
              ${input.quantity}::numeric, ${input.unitPriceAmount}, ${input.discountAmount},
              ${input.netAmount}, ${input.taxPercent}::numeric, ${input.taxAmount}, ${input.grossAmount})
    `;
  }

  private async findInvoiceById(tx: Db, orgId: bigint, internalId: bigint): Promise<InvoiceRow | null> {
    const rows = await tx<InvoiceRow[]>`
      select i.id::text as "internalId", i.public_id as id, i.invoice_no as "invoiceNo",
             o.public_id as "orderId", i.order_id::text as "orderInternalId",
             c.public_id as "customerId", i.customer_id::text as "customerInternalId",
             i.document_kind as "documentKind", i.invoice_date::text as "invoiceDate", i.status,
             i.subtotal_amount::text as "subtotalAmount", i.discount_amount::text as "discountAmount",
             i.tax_amount::text as "taxAmount", i.grand_total_amount::text as "grandTotalAmount",
             i.net_amount::text as "netAmount", i.rounding_amount::text as "roundingAmount",
             orig.public_id as "originalInvoiceId", i.version, i.created_at::text as "createdAt"
      from erp.sales.customer_invoices i
      join erp.sales.customers c on c.id = i.customer_id
      left join erp.sales.sales_orders o on o.id = i.order_id
      left join erp.sales.customer_invoices orig on orig.id = i.original_invoice_id
      where i.organization_id = ${orgId} and i.id = ${internalId}
    `;
    return rows[0] ?? null;
  }

  async findInvoice(tx: Db, orgId: bigint, publicId: string): Promise<InvoiceRow | null> {
    const rows = await tx<{ id: string }[]>`
      select id::text as id from erp.sales.customer_invoices
      where organization_id = ${orgId} and public_id = ${publicId}
    `;
    const row = rows[0];
    return row === undefined ? null : this.findInvoiceById(tx, orgId, BigInt(row.id));
  }

  async listInvoiceLines(tx: Db, invoiceInternalId: bigint): Promise<InvoiceLineRow[]> {
    return tx<InvoiceLineRow[]>`
      select l.id::text as "internalId", l.public_id as id, v.public_id as "variantId",
             l.quantity::text as quantity, l.unit_price_amount::text as "unitPriceAmount",
             l.discount_amount::text as "discountAmount", l.net_amount::text as "netAmount",
             l.tax_percent::text as "taxPercent", l.tax_amount::text as "taxAmount",
             l.gross_amount::text as "grossAmount"
      from erp.sales.customer_invoice_lines l
      join erp.catalog.product_variants v on v.id = l.product_variant_id
      where l.customer_invoice_id = ${invoiceInternalId}
    `;
  }

  async updateInvoiceStatus(
    tx: Db,
    internalId: bigint,
    patch: { status: string; invoiceNo?: string | null; voided?: boolean; voidReason?: string | null },
  ): Promise<void> {
    await tx`
      update erp.sales.customer_invoices
      set status = ${patch.status},
          invoice_no = coalesce(${patch.invoiceNo ?? null}, invoice_no),
          voided_at = case when ${patch.voided === true}::boolean then now() else voided_at end,
          void_reason = ${patch.voidReason ?? null},
          updated_at = now(), version = version + 1
      where id = ${internalId}
    `;
  }

  // ================================================================== returns

  async insertReturn(
    tx: Db,
    input: {
      orgId: bigint;
      orderInternalId: bigint;
      returnNo: string;
      reasonCode: string;
      description: string | null;
      warehouseInternalId: bigint | null;
      requestedBy: bigint | null;
    },
  ): Promise<ReturnRow> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.sales.returns
        (organization_id, public_id, order_id, return_no, reason_code, status, description,
         warehouse_id, requested_by)
      values (${input.orgId}, gen_random_uuid(), ${input.orderInternalId}, ${input.returnNo},
              ${input.reasonCode}, 'requested', ${input.description}, ${input.warehouseInternalId},
              ${input.requestedBy})
      returning id::text as id
    `;
    const created = rows[0];
    if (created === undefined) throw new Error('return_insert_failed');
    return (await this.findReturnById(tx, input.orgId, BigInt(created.id))) as ReturnRow;
  }

  private async findReturnById(tx: Db, orgId: bigint, internalId: bigint): Promise<ReturnRow | null> {
    const rows = await tx<ReturnRow[]>`
      select r.id::text as "internalId", r.public_id as id, r.return_no as "returnNo",
             o.public_id as "orderId", r.order_id::text as "orderInternalId", r.status,
             r.reason_code as "reasonCode", r.description,
             null::text as resolution, r.requested_at::text as "requestedAt",
             r.received_at::text as "receivedAt", r.approved_at::text as "approvedAt", r.version
      from erp.sales.returns r
      join erp.sales.sales_orders o on o.id = r.order_id
      where r.organization_id = ${orgId} and r.id = ${internalId}
    `;
    return rows[0] ?? null;
  }

  async findReturn(tx: Db, orgId: bigint, publicId: string): Promise<ReturnRow | null> {
    const rows = await tx<{ id: string }[]>`
      select id::text as id from erp.sales.returns where organization_id = ${orgId} and public_id = ${publicId}
    `;
    const row = rows[0];
    return row === undefined ? null : this.findReturnById(tx, orgId, BigInt(row.id));
  }

  async insertReturnLine(
    tx: Db,
    input: {
      returnInternalId: bigint;
      orderLineInternalId: bigint | null;
      variantInternalId: bigint;
      quantity: string;
      condition: string;
      restockAction: string;
      netAmount: bigint;
      taxPercent: string;
      taxAmount: bigint;
      grossAmount: bigint;
      refundAmount: bigint;
    },
  ): Promise<void> {
    await tx`
      insert into erp.sales.return_lines
        (return_id, public_id, sales_order_line_id, product_variant_id, quantity, condition,
         restock_action, tax_percent, net_amount, tax_amount, gross_amount, refund_amount)
      values (${input.returnInternalId}, gen_random_uuid(), ${input.orderLineInternalId},
              ${input.variantInternalId}, ${input.quantity}::numeric, ${input.condition},
              ${input.restockAction}, ${input.taxPercent}::numeric, ${input.netAmount},
              ${input.taxAmount}, ${input.grossAmount}, ${input.refundAmount})
    `;
  }

  async listReturnLines(tx: Db, returnInternalId: bigint): Promise<ReturnLineRow[]> {
    return tx<ReturnLineRow[]>`
      select l.id::text as "internalId", l.public_id as id, v.public_id as "variantId",
             l.product_variant_id::text as "variantInternalId", ol.public_id as "orderLineId",
             l.quantity::text as quantity, l.condition, l.restock_action as "restockAction",
             l.net_amount::text as "netAmount", l.tax_amount::text as "taxAmount",
             l.gross_amount::text as "grossAmount", l.refund_amount::text as "refundAmount"
      from erp.sales.return_lines l
      join erp.catalog.product_variants v on v.id = l.product_variant_id
      left join erp.sales.sales_order_lines ol on ol.id = l.sales_order_line_id
      where l.return_id = ${returnInternalId}
      order by l.id asc
    `;
  }

  async updateReturnStatus(
    tx: Db,
    internalId: bigint,
    patch: { status: string; approvedBy?: bigint | null; received?: boolean },
  ): Promise<void> {
    await tx`
      update erp.sales.returns
      set status = ${patch.status},
          approved_by = coalesce(${patch.approvedBy ?? null}, approved_by),
          approved_at = case when ${patch.approvedBy === null || patch.approvedBy === undefined}::boolean
                             then approved_at else now() end,
          received_at = case when ${patch.received === true}::boolean then now() else received_at end
      where id = ${internalId}
    `;
  }

  async returnedQuantityForOrderLine(tx: Db, orderLineInternalId: bigint): Promise<string> {
    const rows = await tx<{ total: string }[]>`
      select coalesce(sum(quantity), 0)::text as total
      from erp.sales.return_lines
      where sales_order_line_id = ${orderLineInternalId}
        and return_id in (select id from erp.sales.returns where status not in ('rejected', 'cancelled'))
    `;
    return rows[0]?.total ?? '0.0000';
  }

  // ================================================================== refunds

  async insertRefund(
    tx: Db,
    input: {
      orgId: bigint;
      returnInternalId: bigint | null;
      customerInternalId: bigint;
      refundNo: string;
      amount: bigint;
      method: string;
      status: string;
      reason: string | null;
      createdBy: bigint | null;
    },
  ): Promise<RefundRow> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.sales.refunds
        (organization_id, public_id, return_id, customer_id, refund_no, amount, method, status,
         reason, created_by)
      values (${input.orgId}, gen_random_uuid(), ${input.returnInternalId}, ${input.customerInternalId},
              ${input.refundNo}, ${input.amount}, ${input.method}, ${input.status}, ${input.reason},
              ${input.createdBy})
      returning id::text as id
    `;
    const created = rows[0];
    if (created === undefined) throw new Error('refund_insert_failed');
    return (await this.findRefundById(tx, input.orgId, BigInt(created.id))) as RefundRow;
  }

  private async findRefundById(tx: Db, orgId: bigint, internalId: bigint): Promise<RefundRow | null> {
    const rows = await tx<RefundRow[]>`
      select f.id::text as "internalId", f.public_id as id, f.refund_no as "refundNo",
             r.public_id as "returnId", f.return_id::text as "returnInternalId",
             c.public_id as "customerId", f.customer_id::text as "customerInternalId",
             f.amount::text as amount, f.method, f.status, f.reason,
             f.processed_at::text as "processedAt", f.version
      from erp.sales.refunds f
      join erp.sales.customers c on c.id = f.customer_id
      left join erp.sales.returns r on r.id = f.return_id
      where f.organization_id = ${orgId} and f.id = ${internalId}
    `;
    return rows[0] ?? null;
  }

  async findRefund(tx: Db, orgId: bigint, publicId: string): Promise<RefundRow | null> {
    const rows = await tx<{ id: string }[]>`
      select id::text as id from erp.sales.refunds where organization_id = ${orgId} and public_id = ${publicId}
    `;
    const row = rows[0];
    return row === undefined ? null : this.findRefundById(tx, orgId, BigInt(row.id));
  }

  async updateRefundStatus(
    tx: Db,
    internalId: bigint,
    patch: { status: string; approvedBy?: bigint | null; processed?: boolean },
  ): Promise<void> {
    await tx`
      update erp.sales.refunds
      set status = ${patch.status},
          approved_by = coalesce(${patch.approvedBy ?? null}, approved_by),
          processed_at = case when ${patch.processed === true}::boolean then now() else processed_at end
      where id = ${internalId}
    `;
  }

  async refundedTotalForCustomer(tx: Db, orgId: bigint, customerInternalId: bigint): Promise<bigint> {
    const rows = await tx<{ total: string }[]>`
      select coalesce(sum(amount), 0)::text as total from erp.sales.refunds
      where organization_id = ${orgId} and customer_id = ${customerInternalId}
        and status in ('approved', 'paid')
    `;
    return BigInt(rows[0]?.total ?? '0');
  }

  async invoiceLinesForOrder(tx: Db, orgInternalId: bigint): Promise<{ netAmount: bigint; taxAmount: bigint }> {
    const rows = await tx<{ net: string; tax: string }[]>`
      select coalesce(sum(net_amount), 0)::text as net, coalesce(sum(tax_amount), 0)::text as tax
      from erp.sales.customer_invoices where order_id = ${orgInternalId}
    `;
    return { netAmount: BigInt(rows[0]?.net ?? '0'), taxAmount: BigInt(rows[0]?.tax ?? '0') };
  }
}
