/**
 * Sales application service (`API.md` §4.7, `DATA-MODEL` §2.9).
 *
 * Orders are canonical; channel orders are ingested through the same entry point.
 * Confirmation reserves stock through the public `InventoryService` inside the
 * same transaction (all-or-nothing, `ADR-0007`), and the FSM + money arithmetic
 * live in the pure `order.engine`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError, formatMoney, parseMoney } from '@saman/shared';

import {
  AUDIT,
  DB,
  EVENT_BUS,
  type AuditPort,
  type Db as ContractDb,
  type EventPort,
  type TenantContext,
} from '../../common/contracts';
import { CatalogLookupService, type VariantLookup } from '../catalog/product.service';
import { InventoryService } from '../inventory/inventory.service';
import type { Db } from './sales.pg-support';
import { notFound, parseIfMatch, toBigInt, versionConflict } from './sales.pg-support';
import {
  SalesRepository,
  type AddressRow,
  type CustomerRow,
  type InvoiceRow,
  type OrderLineRow,
  type OrderRow,
  type RefundRow,
  type ReturnLineRow,
  type ReturnRow,
} from './sales.repository';
import {
  SALES_ACCOUNTING_EVENTS,
  SALES_EVENTS,
  type InvoicePayload,
  type OrderEventPayload,
  type RefundPayload,
  type ReturnPayload,
} from './sales.events';
import {
  ORDER_ACTIONS,
  assertRefundWithinPaid,
  assertTransition,
  computeOrderTotals,
  computeReturnLineCredit,
  holdsReservation,
  isEditable,
  type OrderLineInput,
} from './engines/order.engine';
import { addQuantity, compareQuantity, normalizeQuantity, subQuantity } from '../inventory/engines/quantity.engine';
import type {
  CancelOrderBody,
  ConfirmOrderBody,
  CreateAddressBody,
  CreateCustomerBody,
  CreateInvoiceBody,
  CreateOrderBody,
  CreateRefundBody,
  CreateReturnBody,
  HoldOrderBody,
  InspectReturnBody,
  IssueInvoiceBody,
  OrderLineInput as OrderLineDto,
  ReceiveReturnBody,
  UpdateAddressBody,
  UpdateCreditBody,
  UpdateCustomerBody,
  UpdateOrderBody,
} from './dto/sales.dto';

const DEFAULT_RESERVATION_TTL_MINUTES = 24 * 60;
/** Refunds at/above this IRR value need a second approver (`ADR-0008`). */
const REFUND_APPROVAL_THRESHOLD = 50_000_000n;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function customerView(row: CustomerRow): Record<string, unknown> {
  return {
    id: row.id,
    customerNo: row.customerNo,
    fullName: row.fullName,
    mobile: row.mobile,
    nationalId: row.nationalId,
    email: row.email,
    customerType: row.customerType,
    creditLimit: row.creditLimitAmount,
    paymentTermDays: row.paymentTermsDays,
    status: row.status,
    notes: row.notes,
    version: row.version,
    createdAt: row.createdAt,
  };
}

function addressView(row: AddressRow): Record<string, unknown> {
  return {
    id: row.id,
    customerId: row.customerId,
    title: row.label,
    type: row.addressType,
    receiverName: row.receiverName,
    receiverMobile: row.receiverMobile,
    province: row.province,
    city: row.city,
    district: row.district,
    line1: row.addressLine,
    postalCode: row.postalCode,
    lat: row.latitude,
    lng: row.longitude,
    isDefault: row.isDefault,
  };
}

function orderView(row: OrderRow): Record<string, unknown> {
  return {
    id: row.id,
    orderNo: row.orderNo,
    customerId: row.customerId,
    customerName: row.customerName,
    channelCode: row.channelCode,
    externalOrderId: row.externalOrderId,
    warehouseId: row.warehouseId,
    status: row.status,
    paymentStatus: row.paymentStatus,
    fulfillmentStatus: row.fulfillmentStatus,
    currency: row.currency,
    totals: {
      subtotal: row.subtotalAmount,
      discount: row.discountAmount,
      tax: row.taxAmount,
      shipping: row.shippingAmount,
      grandTotal: row.grandTotalAmount,
      paid: row.paidAmount,
      refunded: row.refundedAmount,
    },
    orderDate: row.orderDate,
    businessDate: row.businessDate,
    confirmedAt: row.confirmedAt,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    version: row.version,
    createdAt: row.createdAt,
  };
}

function orderLineView(row: OrderLineRow): Record<string, unknown> {
  return {
    id: row.id,
    lineNo: row.lineNo,
    variantId: row.variantId,
    sku: row.sku,
    title: row.title,
    quantity: row.quantity,
    unitPrice: row.unitPriceAmount,
    discount: row.discountAmount,
    net: row.netAmount,
    taxPercent: row.taxPercent,
    tax: row.taxAmount,
    gross: row.grossAmount,
    allocatedHeaderDiscount: row.allocatedHeaderDiscountAmount,
    status: row.status,
  };
}

function invoiceView(row: InvoiceRow, lines: readonly Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    id: row.id,
    invoiceNo: row.invoiceNo,
    orderId: row.orderId,
    customerId: row.customerId,
    documentKind: row.documentKind,
    invoiceDate: row.invoiceDate,
    status: row.status,
    subtotal: row.subtotalAmount,
    discount: row.discountAmount,
    tax: row.taxAmount,
    grandTotal: row.grandTotalAmount,
    net: row.netAmount,
    rounding: row.roundingAmount,
    originalInvoiceId: row.originalInvoiceId,
    currency: 'IRR',
    version: row.version,
    ...(lines.length > 0 ? { lines } : {}),
  };
}

function returnView(row: ReturnRow, lines: readonly Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    id: row.id,
    returnNo: row.returnNo,
    orderId: row.orderId,
    status: row.status,
    reasonCode: row.reasonCode,
    resolution: row.resolution,
    requestedAt: row.requestedAt,
    receivedAt: row.receivedAt,
    approvedAt: row.approvedAt,
    version: row.version,
    ...(lines.length > 0 ? { lines } : {}),
  };
}

function returnLineView(row: ReturnLineRow): Record<string, unknown> {
  return {
    id: row.id,
    variantId: row.variantId,
    orderLineId: row.orderLineId,
    quantity: row.quantity,
    condition: row.condition,
    restockAction: row.restockAction,
    net: row.netAmount,
    tax: row.taxAmount,
    gross: row.grossAmount,
    refundAmount: row.refundAmount,
  };
}

function refundView(row: RefundRow): Record<string, unknown> {
  return {
    id: row.id,
    refundNo: row.refundNo,
    returnId: row.returnId,
    customerId: row.customerId,
    amount: row.amount,
    method: row.method,
    status: row.status,
    reason: row.reason,
    processedAt: row.processedAt,
    currency: 'IRR',
    version: row.version,
  };
}

@Injectable()
export class SalesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: SalesRepository,
    private readonly catalog: CatalogLookupService,
    private readonly inventory: InventoryService,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  // ================================================================ customers

  async listCustomers(ctx: TenantContext, query: { page: number; perPage: number; q?: string | undefined; mobile?: string | undefined; status?: string | undefined }) {
    const rows = await this.repo.listCustomers(this.db, {
      orgId: ctx.orgId,
      search: query.q ?? null,
      mobile: query.mobile ?? null,
      status: query.status ?? null,
      limit: query.perPage,
      offset: (query.page - 1) * query.perPage,
    });
    const total = await this.repo.countCustomers(this.db, { orgId: ctx.orgId, status: query.status ?? null });
    return { items: rows.map(customerView), total };
  }

  async getCustomer(ctx: TenantContext, publicId: string, include: readonly string[]): Promise<Record<string, unknown>> {
    const row = await this.requireCustomer(this.db, ctx, publicId);
    const view: Record<string, unknown> = customerView(row);
    if (include.includes('addresses')) {
      view['addresses'] = (await this.repo.listAddresses(this.db, toBigInt(row.internalId))).map(addressView);
    }
    if (include.includes('credit')) {
      const ar = await this.repo.customerArSnapshot(this.db, ctx.orgId, toBigInt(row.internalId));
      view['credit'] = {
        creditLimit: row.creditLimitAmount,
        termDays: row.paymentTermsDays,
        openOrders: ar.openOrders,
        outstandingAmount: ar.outstandingAmount,
        currency: 'IRR',
      };
    }
    return view;
  }

  async createCustomer(ctx: TenantContext, body: CreateCustomerBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      if (body.mobile !== undefined) {
        const existing = await this.repo.findCustomerByMobile(tx, ctx.orgId, body.mobile);
        if (existing !== null) {
          throw new AppError('CONFLICT', {
            message: 'مشتری با این شمارهٔ موبایل قبلاً ثبت شده است.',
            messageKey: 'sales.customer_mobile_conflict',
            details: [{ field: 'mobile', rule: 'customer_mobile_conflict' }],
          });
        }
      }
      const customerNo = `CUS-${Date.now().toString(36).toUpperCase()}`;
      const created = await this.repo.insertCustomer(tx, {
        orgId: ctx.orgId,
        customerNo,
        fullName: body.fullName,
        mobile: body.mobile ?? null,
        nationalId: body.nationalId ?? null,
        email: body.email ?? null,
        customerType: body.customerType ?? 'retail',
        creditLimitAmount: body.creditLimit === undefined ? 0n : parseMoney(body.creditLimit),
        paymentTermsDays: body.paymentTermDays ?? 0,
        notes: body.notes ?? null,
      });
      if (body.addresses !== undefined) {
        for (const address of body.addresses) {
          await this.repo.insertAddress(tx, {
            customerInternalId: toBigInt(created.internalId),
            label: address.title ?? null,
            addressType: 'shipping',
            receiverName: body.fullName,
            receiverMobile: body.mobile ?? null,
            province: address.province,
            city: address.city,
            district: null,
            addressLine: address.line2 === undefined ? address.line1 : `${address.line1}، ${address.line2}`,
            postalCode: address.postalCode ?? null,
            latitude: null,
            longitude: null,
            isDefault: address.isDefault ?? true,
          });
        }
      }
      await this.emit(tx, ctx, SALES_EVENTS.customerCreated, 'customer', toBigInt(created.internalId), {
        customerId: created.id,
      });
      await this.record(tx, ctx, 'customer.create', 'customer', created.id, null, customerView(created));
      return customerView(created);
    });
  }

  async updateCustomer(
    ctx: TenantContext,
    publicId: string,
    body: UpdateCustomerBody,
    expectedVersion?: number,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const current = await this.requireCustomer(tx, ctx, publicId);
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw versionConflict(current.version, expectedVersion);
      }
      const updated = await this.repo.updateCustomer(tx, ctx.orgId, toBigInt(current.internalId), {
        fullName: body.fullName ?? current.fullName,
        email: body.email === undefined ? current.email : body.email,
        status: body.status ?? current.status,
        notes: body.notes === undefined ? current.notes : body.notes,
        creditLimitAmount: BigInt(current.creditLimitAmount),
        paymentTermsDays: current.paymentTermsDays,
      });
      await this.record(tx, ctx, 'customer.update', 'customer', updated.id, customerView(current), customerView(updated));
      return customerView(updated);
    });
  }

  async deleteCustomer(ctx: TenantContext, publicId: string): Promise<void> {
    await this.db.begin(async (tx) => {
      const current = await this.requireCustomer(tx, ctx, publicId);
      const openOrders = await this.repo.countOpenOrdersForCustomer(tx, ctx.orgId, toBigInt(current.internalId));
      if (openOrders > 0) {
        throw new AppError('RULE_VIOLATION', {
          message: 'مشتری دارای سفارش باز یا مطالبات قابل حذف نیست.',
          messageKey: 'sales.open_receivables',
          details: [{ rule: 'open_receivables', params: { openOrders } }],
        });
      }
      await this.repo.softDeleteCustomer(tx, ctx.orgId, toBigInt(current.internalId));
      await this.emit(tx, ctx, SALES_EVENTS.customerDeleted, 'customer', toBigInt(current.internalId), { customerId: current.id });
      await this.record(tx, ctx, 'customer.delete', 'customer', current.id, customerView(current), null);
    });
  }

  async lookupCustomer(ctx: TenantContext, query: { mobile?: string | undefined }) {
    if (query.mobile === undefined) {
      throw new AppError('NOT_IMPLEMENTED', { messageKey: 'sales.lookup_email_not_supported' });
    }
    const row = await this.repo.findCustomerByMobile(this.db, ctx.orgId, query.mobile);
    if (row === null) throw notFound('customer');
    return customerView(row);
  }

  async listAddresses(ctx: TenantContext, customerPublicId: string): Promise<Record<string, unknown>[]> {
    const customer = await this.requireCustomer(this.db, ctx, customerPublicId);
    return (await this.repo.listAddresses(this.db, toBigInt(customer.internalId))).map(addressView);
  }

  async addAddress(ctx: TenantContext, customerPublicId: string, body: CreateAddressBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const customer = await this.requireCustomer(tx, ctx, customerPublicId);
      const created = await this.repo.insertAddress(tx, {
        customerInternalId: toBigInt(customer.internalId),
        label: body.title ?? null,
        addressType: body.type ?? 'shipping',
        receiverName: body.receiverName ?? customer.fullName,
        receiverMobile: body.receiverMobile ?? customer.mobile,
        province: body.province,
        city: body.city,
        district: body.district ?? null,
        addressLine: body.line2 === undefined ? body.line1 : `${body.line1}، ${body.line2}`,
        postalCode: body.postalCode ?? null,
        latitude: body.lat === undefined ? null : String(body.lat),
        longitude: body.lng === undefined ? null : String(body.lng),
        isDefault: body.isDefault ?? false,
      });
      return addressView(created);
    });
  }

  async updateAddress(
    ctx: TenantContext,
    customerPublicId: string,
    addressPublicId: string,
    body: UpdateAddressBody,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const customer = await this.requireCustomer(tx, ctx, customerPublicId);
      const existing = await this.repo.findAddress(tx, toBigInt(customer.internalId), addressPublicId);
      if (existing === null) throw notFound('address');
      await this.repo.updateAddress(tx, toBigInt(customer.internalId), addressPublicId, {
        label: body.title === undefined ? existing.label : body.title,
        receiverName: body.receiverName === undefined ? existing.receiverName : body.receiverName,
        receiverMobile: body.receiverMobile === undefined ? existing.receiverMobile : body.receiverMobile,
        province: body.province === undefined ? existing.province : body.province,
        city: body.city === undefined ? existing.city : body.city,
        addressLine: body.line1 ?? existing.addressLine,
        postalCode: body.postalCode === undefined ? existing.postalCode : body.postalCode,
        isDefault: body.isDefault ?? existing.isDefault,
      });
      const updated = await this.repo.findAddress(tx, toBigInt(customer.internalId), addressPublicId);
      if (updated === null) throw notFound('address');
      return addressView(updated);
    });
  }

  async deleteAddress(ctx: TenantContext, customerPublicId: string, addressPublicId: string): Promise<void> {
    await this.db.begin(async (tx) => {
      const customer = await this.requireCustomer(tx, ctx, customerPublicId);
      const existing = await this.repo.findAddress(tx, toBigInt(customer.internalId), addressPublicId);
      if (existing === null) throw notFound('address');
      if (existing.isDefault) {
        throw new AppError('RULE_VIOLATION', {
          message: 'نشانی پیش‌فرض قابل حذف نیست.',
          messageKey: 'sales.default_address',
          details: [{ rule: 'default_address' }],
        });
      }
      await this.repo.deleteAddress(tx, toBigInt(customer.internalId), addressPublicId);
    });
  }

  async getCredit(ctx: TenantContext, customerPublicId: string): Promise<Record<string, unknown>> {
    const customer = await this.requireCustomer(this.db, ctx, customerPublicId);
    const ar = await this.repo.customerArSnapshot(this.db, ctx.orgId, toBigInt(customer.internalId));
    return {
      creditLimit: customer.creditLimitAmount,
      termDays: customer.paymentTermsDays,
      openOrders: ar.openOrders,
      outstandingAmount: ar.outstandingAmount,
      availableCredit: formatMoney(
        BigInt(customer.creditLimitAmount) - BigInt(ar.outstandingAmount),
      ),
      currency: 'IRR',
    };
  }

  async updateCredit(
    ctx: TenantContext,
    customerPublicId: string,
    body: UpdateCreditBody,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const customer = await this.requireCustomer(tx, ctx, customerPublicId);
      const updated = await this.repo.updateCustomer(tx, ctx.orgId, toBigInt(customer.internalId), {
        fullName: customer.fullName,
        email: customer.email,
        status: customer.status,
        notes: body.note === undefined ? customer.notes : body.note,
        creditLimitAmount: parseMoney(body.creditLimit),
        paymentTermsDays: body.termDays ?? customer.paymentTermsDays,
      });
      return {
        creditLimit: updated.creditLimitAmount,
        termDays: updated.paymentTermsDays,
        currency: 'IRR',
      };
    });
  }

  // =================================================================== orders

  async listOrders(ctx: TenantContext, query: { limit: number; status?: string | undefined; customerId?: string | undefined; channelCode?: string | undefined; warehouseId?: string | undefined; createdAtGte?: string | undefined }) {
    const customer = query.customerId === undefined ? null : await this.requireCustomer(this.db, ctx, query.customerId);
    const warehouseInternalId =
      query.warehouseId === undefined ? null : await this.repo.resolveWarehouseId(this.db, ctx.orgId, query.warehouseId);
    const rows = await this.repo.listOrders(this.db, {
      orgId: ctx.orgId,
      status: query.status ?? null,
      customerInternalId: customer === null ? null : toBigInt(customer.internalId),
      channelCode: query.channelCode ?? null,
      warehouseInternalId,
      createdFrom: query.createdAtGte ?? null,
      limit: query.limit,
      offset: 0,
    });
    return rows.map(orderView);
  }

  async getOrder(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    return this.getOrderInTx(this.db, ctx, publicId);
  }

  private async getOrderInTx(tx: Db, ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findOrder(tx, ctx.orgId, publicId);
    if (row === null) throw notFound('sales_order');
    const lines = await this.repo.listOrderLines(tx, toBigInt(row.internalId));
    const history = await this.repo.listStatusHistory(tx, toBigInt(row.internalId));
    return { ...orderView(row), lines: lines.map(orderLineView), history };
  }

  async createOrder(
    ctx: TenantContext,
    body: CreateOrderBody,
    options: { channelAccountInternalId?: bigint | null; externalOrderId?: string | null; idempotencyKey?: string | null; sourceStatus?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      if (options.idempotencyKey !== null && options.idempotencyKey !== undefined) {
        const existing = await this.repo.findOrderByIdempotencyKey(tx, ctx.orgId, options.idempotencyKey);
        if (existing !== null) return this.getOrderInTx(tx, ctx, existing.id);
      }
      const customer = await this.requireCustomer(tx, ctx, body.customerId);
      const warehouseInternalId =
        body.warehouseId === undefined ? null : await this.repo.resolveWarehouseId(tx, ctx.orgId, body.warehouseId);
      const prepared = await this.prepareLines(tx, ctx, body.lines);
      const totals = computeOrderTotals({
        lines: prepared.inputs,
        headerDiscountAmount: body.discount === undefined ? 0n : parseMoney(body.discount),
        shippingAmount: body.shippingAmount === undefined ? 0n : parseMoney(body.shippingAmount),
      });
      const address = body.shippingAddressId === undefined ? null : await this.repo.findAddress(tx, toBigInt(customer.internalId), body.shippingAddressId);
      const order = await this.repo.insertOrder(tx, {
        orgId: ctx.orgId,
        orderNo: null,
        customerInternalId: toBigInt(customer.internalId),
        channelAccountInternalId: options.channelAccountInternalId ?? null,
        externalOrderId: options.externalOrderId ?? null,
        warehouseInternalId,
        status: options.sourceStatus ?? 'draft',
        currency: 'IRR',
        subtotalAmount: totals.subtotalAmount,
        discountAmount: totals.discountAmount,
        taxAmount: totals.taxAmount,
        shippingAmount: totals.shippingAmount,
        grandTotalAmount: totals.grandTotalAmount,
        shippingAddressJson: address === null ? null : JSON.stringify(addressView(address)),
        customerNote: body.customerNote ?? null,
        idempotencyKey: options.idempotencyKey ?? null,
        businessDate: todayIso(),
        orderDate: new Date().toISOString(),
        createdBy: ctx.actorId,
      });
      await this.insertLines(tx, toBigInt(order.internalId), prepared, totals.lines);
      await this.repo.appendStatusHistory(tx, {
        orderInternalId: toBigInt(order.internalId),
        fromStatus: null,
        toStatus: order.status,
        field: 'status',
        changedBy: ctx.actorId,
        source: options.channelAccountInternalId == null ? 'erp' : 'channel',
        reason: null,
      });
      await this.emitOrderEvent(tx, ctx, SALES_EVENTS.orderCreated, order);
      await this.record(tx, ctx, 'sales.order.create', 'sales_order', order.id, null, orderView(order));
      if (body.autoConfirm === true) {
        return this.confirmOrderInTx(tx, ctx, order.id, {});
      }
      return this.getOrderInTx(tx, ctx, order.id);
    });
  }

  /** Channel adapter entry point (`ADR-0006`): canonical order from a partner. */
  async ingestChannelOrder(
    ctx: TenantContext,
    input: {
      channelCode: string;
      externalOrderId: string;
      body: CreateOrderBody;
    },
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const channelAccountInternalId = await this.repo.resolveChannelAccountId(tx, ctx.orgId, input.channelCode);
      if (channelAccountInternalId === null) {
        throw new AppError('VALIDATION_ERROR', {
          details: [{ field: 'channelCode', rule: 'unknown_channel' }],
        });
      }
      const idempotencyKey = `channel:order:${input.channelCode}:${input.externalOrderId}`;
      const existing = await this.repo.findOrderByIdempotencyKey(tx, ctx.orgId, idempotencyKey);
      if (existing !== null) {
        return { deduplicated: true, order: await this.getOrderInTx(tx, ctx, existing.id) };
      }
      const created = await this.createOrder(ctx, input.body, {
        channelAccountInternalId,
        externalOrderId: input.externalOrderId,
        idempotencyKey,
      });
      return { deduplicated: false, order: created };
    });
  }

  private async prepareLines(
    tx: Db,
    ctx: TenantContext,
    lines: readonly OrderLineDto[],
  ): Promise<{ inputs: OrderLineInput[]; variants: VariantLookup[] }> {
    const variants = await this.catalog.findVariants(
      ctx,
      lines.map((line) => line.variantId),
    );
    const byId = new Map(variants.map((variant) => [variant.id, variant]));
    const inputs: OrderLineInput[] = [];
    for (const [index, line] of lines.entries()) {
      const variant = byId.get(line.variantId);
      if (variant === undefined) throw notFound('variant');
      if (!variant.isActive) {
        throw new AppError('RULE_VIOLATION', {
          message: 'تنوع کالا غیرفعال است و قابل فروش نیست.',
          messageKey: 'sales.variant_inactive',
          details: [{ field: `lines[${index}].variantId`, rule: 'variant_inactive' }],
        });
      }
      inputs.push({
        quantity: line.quantity,
        unitPriceAmount: parseMoney(line.unitPrice),
        discountAmount: line.discount === undefined ? 0n : parseMoney(line.discount),
        taxPercent: line.taxPercent ?? '0',
      });
    }
    void tx;
    return { inputs, variants: lines.map((line) => byId.get(line.variantId)).filter((variant): variant is VariantLookup => variant !== undefined) };
  }

  private async insertLines(
    tx: Db,
    orderInternalId: bigint,
    prepared: { inputs: readonly OrderLineInput[]; variants: readonly VariantLookup[] },
    lines: readonly { quantity: string; unitPriceAmount: bigint; discountAmount: bigint; netAmount: bigint; taxPercent: string; taxAmount: bigint; grossAmount: bigint; allocatedHeaderDiscountAmount: bigint }[],
  ): Promise<void> {
    const variantList = prepared.variants;
    for (const [index, line] of lines.entries()) {
      const variant = variantList[index];
      if (variant === undefined) throw notFound('variant');
      await this.repo.insertOrderLine(tx, {
        orderInternalId,
        lineNo: index + 1,
        variantInternalId: variant.internalId,
        skuSnapshot: variant.sku,
        titleSnapshot: variant.sku,
        quantity: line.quantity,
        unitPriceAmount: line.unitPriceAmount,
        discountAmount: line.discountAmount,
        netAmount: line.netAmount,
        taxPercent: line.taxPercent,
        taxAmount: line.taxAmount,
        grossAmount: line.grossAmount,
        allocatedHeaderDiscountAmount: line.allocatedHeaderDiscountAmount,
      });
    }
  }

  async updateOrder(
    ctx: TenantContext,
    publicId: string,
    body: UpdateOrderBody,
    expectedVersion?: number,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const current = await this.repo.lockOrder(tx, ctx.orgId, publicId);
      if (current === null) throw notFound('sales_order');
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw versionConflict(current.version, expectedVersion);
      }
      if (!isEditable(current.status as 'draft')) {
        throw new AppError('DOCUMENT_STATE_INVALID', {
          message: 'فقط سفارش پیش‌نویس یا ارسال‌شده قابل ویرایش است.',
          details: [{ rule: 'order_not_editable', params: { status: current.status } }],
        });
      }
      const existingLines = await this.repo.listOrderLines(tx, toBigInt(current.internalId));
      let totals = computeOrderTotals({
        lines: existingLines.map((line) => ({
          quantity: line.quantity,
          unitPriceAmount: BigInt(line.unitPriceAmount),
          discountAmount: BigInt(line.discountAmount),
          taxPercent: line.taxPercent,
        })),
        headerDiscountAmount: body.discount === undefined ? BigInt(current.discountAmount) : parseMoney(body.discount),
        shippingAmount: body.shippingAmount === undefined ? BigInt(current.shippingAmount) : parseMoney(body.shippingAmount),
      });
      let prepared: { inputs: OrderLineInput[]; variants: VariantLookup[] } | null = null;
      if (body.lines !== undefined) {
        prepared = await this.prepareLines(tx, ctx, body.lines);
        totals = computeOrderTotals({
          lines: prepared.inputs,
          headerDiscountAmount: body.discount === undefined ? BigInt(current.discountAmount) : parseMoney(body.discount),
          shippingAmount: body.shippingAmount === undefined ? BigInt(current.shippingAmount) : parseMoney(body.shippingAmount),
        });
        await this.repo.deleteOrderLines(tx, toBigInt(current.internalId));
        await this.insertLines(tx, toBigInt(current.internalId), prepared, totals.lines);
      }
      await this.repo.updateOrderTotals(tx, toBigInt(current.internalId), {
        subtotalAmount: totals.subtotalAmount,
        discountAmount: totals.discountAmount,
        taxAmount: totals.taxAmount,
        shippingAmount: totals.shippingAmount,
        grandTotalAmount: totals.grandTotalAmount,
        customerNote: body.customerNote === undefined ? current.customerNote : body.customerNote,
      });
      return this.getOrderInTx(tx, ctx, publicId);
    });
  }

  async deleteOrder(ctx: TenantContext, publicId: string): Promise<void> {
    await this.db.begin(async (tx) => {
      const current = await this.repo.lockOrder(tx, ctx.orgId, publicId);
      if (current === null) throw notFound('sales_order');
      if (!isEditable(current.status as 'draft')) {
        throw new AppError('DOCUMENT_STATE_INVALID', { details: [{ rule: 'order_not_editable' }] });
      }
      await this.repo.deleteOrder(tx, ctx.orgId, toBigInt(current.internalId));
    });
  }

  async transitionAction(
    ctx: TenantContext,
    publicId: string,
    action: 'submit' | 'hold' | 'release',
    reason?: string,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const order = await this.repo.lockOrder(tx, ctx.orgId, publicId);
      if (order === null) throw notFound('sales_order');
      if (action === 'release' && order.status === 'on_hold') {
        // Release returns the order to the status before immersion: confirmed if
        // stock was already reserved, otherwise submitted.
        const reservations = await this.inventory.listReservations(ctx, {
          limit: 1,
          status: 'active',
          sourceType: 'sales_order',
          sourceId: order.id,
        });
        const target = reservations.length > 0 ? 'confirmed' : 'submitted';
        assertTransition(order.status, target, action);
        await this.repo.updateOrderStatus(tx, toBigInt(order.internalId), { status: target });
        await this.appendHistory(tx, ctx, order, target, action, reason ?? null);
        await this.emitOrderEvent(tx, ctx, SALES_EVENTS.orderReleased, order, target);
        return this.getOrderInTx(tx, ctx, publicId);
      }
      const target = ORDER_ACTIONS[action];
      if (target === undefined) throw new AppError('VALIDATION_ERROR', { details: [{ rule: 'unknown_action' }] });
      assertTransition(order.status, target, action);
      await this.repo.updateOrderStatus(tx, toBigInt(order.internalId), {
        status: target,
        submitted: action === 'submit',
        onHold: action === 'hold',
      });
      await this.appendHistory(tx, ctx, order, target, action, reason ?? null);
      await this.emitOrderEvent(
        tx,
        ctx,
        action === 'submit' ? SALES_EVENTS.orderSubmitted : action === 'hold' ? SALES_EVENTS.orderOnHold : SALES_EVENTS.orderReleased,
        order,
        target,
      );
      return this.getOrderInTx(tx, ctx, publicId);
    });
  }

  async confirmOrder(ctx: TenantContext, publicId: string, body: ConfirmOrderBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => this.confirmOrderInTx(tx, ctx, publicId, body));
  }

  private async confirmOrderInTx(
    tx: Db,
    ctx: TenantContext,
    publicId: string,
    body: ConfirmOrderBody,
  ): Promise<Record<string, unknown>> {
    const order = await this.repo.lockOrder(tx, ctx.orgId, publicId);
    if (order === null) throw notFound('sales_order');
    if (order.status !== 'confirmed') {
      assertTransition(order.status, 'confirmed', 'confirm');
      const lines = await this.repo.listOrderLines(tx, toBigInt(order.internalId));
      await this.inventory.reserveForReference(tx, ctx, {
        referenceType: 'sales_order',
        referenceInternalId: toBigInt(order.internalId),
        referencePublicId: order.id,
        lines: lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
        warehouseIds: order.warehouseId === null ? null : [order.warehouseId],
        ttlMinutes: DEFAULT_RESERVATION_TTL_MINUTES,
        reason: 'sales_order_confirm',
      });
      void body;
    }
    const orderNo = order.orderNo ?? (await this.repo.allocateDocumentNo(tx, ctx.orgId, 'sales_order', order.businessDate));
    await this.repo.updateOrderStatus(tx, toBigInt(order.internalId), {
      status: 'confirmed',
      orderNo,
      confirmed: true,
    });
    await this.appendHistory(tx, ctx, order, 'confirmed', 'confirm', null);
    await this.emitOrderEvent(tx, ctx, SALES_EVENTS.orderConfirmed, order, 'confirmed');
    return this.getOrderInTx(tx, ctx, publicId);
  }

  async allocateOrder(ctx: TenantContext, publicId: string, body: { strategy?: 'single_warehouse_first' | 'split_fewest_locations' | 'fifo' | undefined }): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const order = await this.repo.lockOrder(tx, ctx.orgId, publicId);
      if (order === null) throw notFound('sales_order');
      assertTransition(order.status, 'allocated', 'allocate');
      await this.inventory.releaseForReference(tx, ctx, 'sales_order', toBigInt(order.internalId));
      const lines = await this.repo.listOrderLines(tx, toBigInt(order.internalId));
      await this.inventory.reserveForReference(tx, ctx, {
        referenceType: 'sales_order',
        referenceInternalId: toBigInt(order.internalId),
        referencePublicId: order.id,
        lines: lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
        warehouseIds: order.warehouseId === null ? null : [order.warehouseId],
        ttlMinutes: DEFAULT_RESERVATION_TTL_MINUTES,
        reason: 'sales_order_allocate',
        ...(body.strategy === undefined ? {} : { strategy: body.strategy }),
      });
      await this.repo.updateOrderStatus(tx, toBigInt(order.internalId), {
        status: 'allocated',
        fulfillmentStatus: 'allocated',
      });
      await this.appendHistory(tx, ctx, order, 'allocated', 'allocate', null);
      await this.emitOrderEvent(tx, ctx, SALES_EVENTS.orderAllocated, order, 'allocated');
      return this.getOrderInTx(tx, ctx, publicId);
    });
  }

  async deallocateOrder(ctx: TenantContext, publicId: string, reason: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const order = await this.repo.lockOrder(tx, ctx.orgId, publicId);
      if (order === null) throw notFound('sales_order');
      assertTransition(order.status, 'confirmed', 'deallocate');
      await this.inventory.releaseForReference(tx, ctx, 'sales_order', toBigInt(order.internalId));
      await this.repo.updateOrderStatus(tx, toBigInt(order.internalId), {
        status: 'confirmed',
        fulfillmentStatus: 'unfulfilled',
      });
      await this.appendHistory(tx, ctx, order, 'confirmed', 'deallocate', reason);
      await this.emitOrderEvent(tx, ctx, SALES_EVENTS.orderDeallocated, order, 'confirmed');
      return this.getOrderInTx(tx, ctx, publicId);
    });
  }

  async cancelOrder(ctx: TenantContext, publicId: string, body: CancelOrderBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const order = await this.repo.lockOrder(tx, ctx.orgId, publicId);
      if (order === null) throw notFound('sales_order');
      assertTransition(order.status, 'cancelled', 'cancel');
      if (holdsReservation(order.status as 'confirmed')) {
        await this.inventory.releaseForReference(tx, ctx, 'sales_order', toBigInt(order.internalId));
      }
      await this.repo.updateOrderStatus(tx, toBigInt(order.internalId), {
        status: 'cancelled',
        cancelled: true,
        cancelReason: body.reason,
        fulfillmentStatus: 'cancelled',
      });
      await this.appendHistory(tx, ctx, order, 'cancelled', 'cancel', body.reason);
      await this.emitOrderEvent(tx, ctx, SALES_EVENTS.orderCancelled, order, 'cancelled');
      void body.restock;
      return this.getOrderInTx(tx, ctx, publicId);
    });
  }

  async fulfillmentQueue(ctx: TenantContext, query: { limit: number; status?: string | undefined; warehouseId?: string | undefined }) {
    const warehouseInternalId =
      query.warehouseId === undefined ? null : await this.repo.resolveWarehouseId(this.db, ctx.orgId, query.warehouseId);
    const rows = await this.repo.fulfillmentQueue(this.db, {
      orgId: ctx.orgId,
      warehouseInternalId,
      status: query.status ?? null,
      limit: query.limit,
    });
    return rows.map(orderView);
  }

  private async appendHistory(
    tx: Db,
    ctx: TenantContext,
    order: OrderRow,
    toStatus: string,
    action: string,
    reason: string | null,
  ): Promise<void> {
    await this.repo.appendStatusHistory(tx, {
      orderInternalId: toBigInt(order.internalId),
      fromStatus: order.status,
      toStatus,
      field: 'status',
      changedBy: ctx.actorId,
      source: 'erp',
      reason: reason ?? action,
    });
  }

  // ================================================================= invoices

  async getInvoice(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const invoice = await this.repo.findInvoice(this.db, ctx.orgId, publicId);
    if (invoice === null) throw notFound('invoice');
    const lines = await this.repo.listInvoiceLines(this.db, toBigInt(invoice.internalId));
    return invoiceView(
      invoice,
      lines.map((line) => ({
        id: line.id,
        variantId: line.variantId,
        quantity: line.quantity,
        unitPrice: line.unitPriceAmount,
        discount: line.discountAmount,
        net: line.netAmount,
        taxPercent: line.taxPercent,
        tax: line.taxAmount,
        gross: line.grossAmount,
      })),
    );
  }

  async createInvoice(ctx: TenantContext, body: CreateInvoiceBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const customer = await this.requireCustomer(tx, ctx, body.customerId);
      const order = body.orderId === undefined ? null : await this.repo.findOrder(tx, ctx.orgId, body.orderId);
      if (body.orderId !== undefined && order === null) throw notFound('sales_order');
      const linesInput =
        body.lines ??
        (order === null
          ? []
          : (await this.repo.listOrderLines(tx, toBigInt(order.internalId))).map((line) => ({
              variantId: line.variantId,
              quantity: line.quantity,
              unitPrice: line.unitPriceAmount,
              discount: line.discountAmount,
              taxPercent: line.taxPercent,
            })));
      if (linesInput.length === 0) {
        throw new AppError('VALIDATION_ERROR', { details: [{ field: 'lines', rule: 'required' }] });
      }
      const totals = computeOrderTotals({
        lines: linesInput.map((line) => ({
          quantity: line.quantity,
          unitPriceAmount: parseMoney(line.unitPrice),
          discountAmount: line.discount === undefined ? 0n : parseMoney(line.discount),
          taxPercent: line.taxPercent ?? '0',
        })),
      });
      const invoice = await this.repo.insertInvoice(tx, {
        orgId: ctx.orgId,
        customerInternalId: toBigInt(customer.internalId),
        orderInternalId: order === null ? null : toBigInt(order.internalId),
        documentKind: 'invoice',
        originalInvoiceInternalId: null,
        invoiceDate: body.issueDate ?? todayIso(),
        status: 'draft',
        subtotalAmount: totals.subtotalAmount,
        discountAmount: totals.discountAmount,
        taxAmount: totals.taxAmount,
        grandTotalAmount: totals.grandTotalAmount,
        netAmount: totals.subtotalAmount,
        roundingAmount: totals.roundingAmount,
        sellerName: 'Saman ERP',
      });
      const variants = await this.catalog.findVariants(ctx, linesInput.map((line) => line.variantId));
      for (const [index, line] of totals.lines.entries()) {
        const variantId = linesInput[index]?.variantId ?? '';
        const variant = variants.find((candidate) => candidate.id === variantId);
        if (variant === undefined) throw notFound('variant');
        await this.repo.insertInvoiceLine(tx, {
          invoiceInternalId: toBigInt(invoice.internalId),
          variantInternalId: variant.internalId,
          quantity: line.quantity,
          unitPriceAmount: line.unitPriceAmount,
          discountAmount: line.discountAmount,
          netAmount: line.netAmount,
          taxPercent: line.taxPercent,
          taxAmount: line.taxAmount,
          grossAmount: line.grossAmount,
        });
      }
      return this.getInvoice(ctx, invoice.id);
    });
  }

  async issueInvoice(ctx: TenantContext, publicId: string, body: IssueInvoiceBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const invoice = await this.repo.findInvoice(tx, ctx.orgId, publicId);
      if (invoice === null) throw notFound('invoice');
      if (invoice.status !== 'draft') {
        throw new AppError('DOCUMENT_STATE_INVALID', { details: [{ rule: 'invoice_not_draft' }] });
      }
      const issueDate = body.issueDate ?? todayIso();
      const invoiceNo = await this.repo.allocateDocumentNo(tx, ctx.orgId, 'customer_invoice', issueDate);
      await this.repo.updateInvoiceStatus(tx, toBigInt(invoice.internalId), { status: 'issued', invoiceNo });
      const payload: InvoicePayload = {
        invoiceId: invoice.id,
        invoiceNo,
        orderId: invoice.orderId,
        customerId: invoice.customerId,
        documentKind: invoice.documentKind,
        netAmount: invoice.netAmount,
        taxAmount: invoice.taxAmount,
        grandTotalAmount: invoice.grandTotalAmount,
        issueDate,
        originalInvoiceId: invoice.originalInvoiceId,
      };
      await this.emit(tx, ctx, SALES_EVENTS.invoiceIssued, 'customer_invoice', toBigInt(invoice.internalId), payload);
      await this.emit(tx, ctx, SALES_ACCOUNTING_EVENTS.invoiceIssued, 'customer_invoice', toBigInt(invoice.internalId), payload);
      await this.record(tx, ctx, 'customer.invoice.issue', 'customer_invoice', invoice.id, invoiceView(invoice), { status: 'issued', invoiceNo });
      return this.getInvoice(ctx, publicId);
    });
  }

  async voidInvoice(ctx: TenantContext, publicId: string, reason: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const invoice = await this.repo.findInvoice(tx, ctx.orgId, publicId);
      if (invoice === null) throw notFound('invoice');
      if (invoice.status === 'voided') {
        throw new AppError('DOCUMENT_STATE_INVALID', { details: [{ rule: 'invoice_already_voided' }] });
      }
      await this.repo.updateInvoiceStatus(tx, toBigInt(invoice.internalId), {
        status: 'voided',
        voided: true,
        voidReason: reason,
      });
      await this.emit(tx, ctx, SALES_EVENTS.invoiceVoided, 'customer_invoice', toBigInt(invoice.internalId), {
        invoiceId: invoice.id,
        reason,
      });
      return this.getInvoice(ctx, publicId);
    });
  }

  // ================================================================== returns

  async getReturn(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findReturn(this.db, ctx.orgId, publicId);
    if (row === null) throw notFound('return');
    const lines = await this.repo.listReturnLines(this.db, toBigInt(row.internalId));
    return returnView(row, lines.map(returnLineView));
  }

  async createReturn(ctx: TenantContext, body: CreateReturnBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const order = await this.repo.findOrder(tx, ctx.orgId, body.orderId);
      if (order === null) throw notFound('sales_order');
      if (!['confirmed', 'allocated', 'packed', 'shipped', 'delivered', 'closed'].includes(order.status)) {
        throw new AppError('DOCUMENT_STATE_INVALID', {
          message: 'برای این سفارش امکان ثبت مرجوعی وجود ندارد.',
          details: [{ rule: 'return_not_allowed', params: { status: order.status } }],
        });
      }
      const orderLines = await this.repo.listOrderLines(tx, toBigInt(order.internalId));
      const returnNo = await this.repo.allocateDocumentNo(tx, ctx.orgId, 'sales_return', todayIso());
      const created = await this.repo.insertReturn(tx, {
        orgId: ctx.orgId,
        orderInternalId: toBigInt(order.internalId),
        returnNo,
        reasonCode: 'customer_change_mind',
        description: `[resolution=${body.resolution}]`,
        warehouseInternalId: order.warehouseInternalId === null ? null : toBigInt(order.warehouseInternalId),
        requestedBy: ctx.actorId,
      });
      for (const line of body.lines) {
        const orderLine = orderLines.find((candidate) => candidate.id === line.orderLineId);
        if (orderLine === undefined) throw notFound('order_line');
        const alreadyReturned = await this.repo.returnedQuantityForOrderLine(tx, toBigInt(orderLine.internalId));
        const remaining = subQuantity(orderLine.quantity, alreadyReturned);
        if (compareQuantity(line.quantity, remaining) > 0) {
          throw new AppError('RULE_VIOLATION', {
            message: 'مقدار مرجوعی بیش از مقدار قابل مرجوع است.',
            messageKey: 'sales.return_quantity_exceeded',
            details: [
              {
                field: 'lines',
                rule: 'return_quantity_exceeded',
                params: { orderLineId: line.orderLineId, remaining },
              },
            ],
          });
        }
        const credit = computeReturnLineCredit({
          originalNetAmount: BigInt(orderLine.netAmount),
          originalQuantity: orderLine.quantity,
          returnedQuantity: line.quantity,
          taxPercent: orderLine.taxPercent,
        });
        await this.repo.insertReturnLine(tx, {
          returnInternalId: toBigInt(created.internalId),
          orderLineInternalId: toBigInt(orderLine.internalId),
          variantInternalId: toBigInt(orderLine.variantInternalId),
          quantity: line.quantity,
          condition: 'unknown',
          restockAction: 'restock',
          netAmount: credit.netAmount,
          taxPercent: orderLine.taxPercent,
          taxAmount: credit.taxAmount,
          grossAmount: credit.grossAmount,
          refundAmount: credit.grossAmount,
        });
      }
      await this.emit(tx, ctx, SALES_EVENTS.returnCreated, 'return', toBigInt(created.internalId), {
        returnId: created.id,
        returnNo: created.returnNo,
        orderId: order.id,
      });
      return this.getReturn(ctx, created.id);
    });
  }

  async receiveReturn(ctx: TenantContext, publicId: string, body: ReceiveReturnBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const row = await this.repo.findReturn(tx, ctx.orgId, publicId);
      if (row === null) throw notFound('return');
      if (!['requested', 'approved'].includes(row.status)) {
        throw new AppError('DOCUMENT_STATE_INVALID', { details: [{ rule: 'return_not_receivable' }] });
      }
      const lines = await this.repo.listReturnLines(tx, toBigInt(row.internalId));
      for (const received of body.lines) {
        const line = lines.find((candidate) => candidate.id === received.lineId);
        if (line === undefined) throw notFound('return_line');
        if (line.restockAction === 'restock' && compareQuantity(received.receivedQuantity, '0') > 0) {
          await this.inventory.postMovement(tx, ctx, {
            warehouseId: body.warehouseId,
            locationId: received.locationId,
            variantId: line.variantId,
            type: 'return_in',
            quantity: received.receivedQuantity,
            referenceType: 'return',
            referenceId: row.id,
            referenceInternalId: toBigInt(row.internalId),
            idempotencyKey: `ret-in:${row.id}:line:${line.id}`,
          });
        }
      }
      await this.repo.updateReturnStatus(tx, toBigInt(row.internalId), { status: 'received', received: true });
      await this.emit(tx, ctx, SALES_EVENTS.returnReceived, 'return', toBigInt(row.internalId), {
        returnId: row.id,
        returnNo: row.returnNo,
      });
      return this.getReturn(ctx, publicId);
    });
  }

  async inspectReturn(ctx: TenantContext, publicId: string, _body: InspectReturnBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const row = await this.repo.findReturn(tx, ctx.orgId, publicId);
      if (row === null) throw notFound('return');
      if (row.status !== 'received') {
        throw new AppError('DOCUMENT_STATE_INVALID', { details: [{ rule: 'return_not_received' }] });
      }
      await this.repo.updateReturnStatus(tx, toBigInt(row.internalId), { status: 'inspected' });
      return this.getReturn(ctx, publicId);
    });
  }

  async approveReturn(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const row = await this.repo.findReturn(tx, ctx.orgId, publicId);
      if (row === null) throw notFound('return');
      if (row.status !== 'requested' && row.status !== 'inspected') {
        throw new AppError('DOCUMENT_STATE_INVALID', { details: [{ rule: 'return_not_approvable' }] });
      }
      await this.repo.updateReturnStatus(tx, toBigInt(row.internalId), {
        status: row.status === 'requested' ? 'approved' : 'inspected',
        approvedBy: ctx.actorId,
      });
      return this.getReturn(ctx, publicId);
    });
  }

  /** Closes the return: issues the VAT credit note and posts the accounting event. */
  async closeReturn(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const row = await this.repo.findReturn(tx, ctx.orgId, publicId);
      if (row === null) throw notFound('return');
      if (row.status !== 'inspected' && row.status !== 'received' && row.status !== 'approved') {
        throw new AppError('DOCUMENT_STATE_INVALID', { details: [{ rule: 'return_not_closable' }] });
      }
      const lines = await this.repo.listReturnLines(tx, toBigInt(row.internalId));
      const order = await this.repo.findOrder(tx, ctx.orgId, row.orderId);
      if (order === null) throw notFound('sales_order');
      const invoices = await this.repo.invoiceLinesForOrder(tx, toBigInt(order.internalId));
      void invoices;
      const netTotal = lines.reduce((total, line) => total + BigInt(line.netAmount), 0n);
      const taxTotal = lines.reduce((total, line) => total + BigInt(line.taxAmount), 0n);
      const creditNote = await this.repo.insertInvoice(tx, {
        orgId: ctx.orgId,
        customerInternalId: toBigInt(row.orderInternalId) === 0n ? toBigInt(order.customerInternalId) : toBigInt(order.customerInternalId),
        orderInternalId: toBigInt(order.internalId),
        documentKind: 'credit_note',
        originalInvoiceInternalId: null,
        invoiceDate: todayIso(),
        status: 'issued',
        subtotalAmount: netTotal,
        discountAmount: 0n,
        taxAmount: taxTotal,
        grandTotalAmount: netTotal + taxTotal,
        netAmount: netTotal,
        roundingAmount: 0n,
        sellerName: 'Saman ERP',
      });
      const creditNo = await this.repo.allocateDocumentNo(tx, ctx.orgId, 'customer_invoice', todayIso());
      await this.repo.updateInvoiceStatus(tx, toBigInt(creditNote.internalId), {
        status: 'issued',
        invoiceNo: creditNo,
      });
      await this.repo.updateReturnStatus(tx, toBigInt(row.internalId), { status: 'completed' });
      const payload: ReturnPayload = {
        returnId: row.id,
        returnNo: row.returnNo,
        orderId: order.id,
        status: 'completed',
        resolution: row.resolution ?? 'refund',
        lines: lines.map((line) => ({
          returnLineId: line.id,
          variantId: line.variantId,
          quantity: line.quantity,
          netAmount: line.netAmount,
          taxAmount: line.taxAmount,
          grossAmount: line.grossAmount,
        })),
      };
      await this.emit(tx, ctx, SALES_EVENTS.returnClosed, 'return', toBigInt(row.internalId), payload);
      await this.emit(tx, ctx, SALES_ACCOUNTING_EVENTS.returnReceived, 'return', toBigInt(row.internalId), payload);
      return this.getReturn(ctx, publicId);
    });
  }

  // ================================================================== refunds

  async getRefund(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findRefund(this.db, ctx.orgId, publicId);
    if (row === null) throw notFound('refund');
    return refundView(row);
  }

  async createRefund(ctx: TenantContext, body: CreateRefundBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const customer = await this.requireCustomer(tx, ctx, body.customerId);
      const amount = parseMoney(body.amount);
      const alreadyRefunded = await this.repo.refundedTotalForCustomer(tx, ctx.orgId, toBigInt(customer.internalId));
      let paidAmount = BigInt(customer.creditLimitAmount);
      if (body.orderId !== undefined) {
        const order = await this.repo.findOrder(tx, ctx.orgId, body.orderId);
        if (order === null) throw notFound('sales_order');
        paidAmount = BigInt(order.paidAmount);
      }
      assertRefundWithinPaid(amount, paidAmount === 0n ? amount : paidAmount, alreadyRefunded);
      const returnRow = body.returnId === undefined ? null : await this.repo.findReturn(tx, ctx.orgId, body.returnId);
      const refundNo = `RFD-${Date.now().toString(36).toUpperCase()}`;
      const created = await this.repo.insertRefund(tx, {
        orgId: ctx.orgId,
        returnInternalId: returnRow === null ? null : toBigInt(returnRow.internalId),
        customerInternalId: toBigInt(customer.internalId),
        refundNo,
        amount,
        method: body.method === 'bank' ? 'bank_transfer' : body.method === 'store_credit' ? 'customer_credit' : body.method,
        status: amount >= REFUND_APPROVAL_THRESHOLD ? 'pending_approval' : 'approved',
        reason: body.reason,
        createdBy: ctx.actorId,
      });
      await this.emit(tx, ctx, SALES_EVENTS.refundRequested, 'refund', toBigInt(created.internalId), {
        refundId: created.id,
        amount: created.amount,
      });
      return refundView(created);
    });
  }

  async approveRefund(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const row = await this.repo.findRefund(tx, ctx.orgId, publicId);
      if (row === null) throw notFound('refund');
      if (row.status !== 'pending_approval') {
        throw new AppError('DOCUMENT_STATE_INVALID', { details: [{ rule: 'refund_not_pending' }] });
      }
      await this.repo.updateRefundStatus(tx, toBigInt(row.internalId), { status: 'approved', approvedBy: ctx.actorId });
      await this.emit(tx, ctx, SALES_EVENTS.refundApproved, 'refund', toBigInt(row.internalId), { refundId: row.id });
      return this.getRefund(ctx, publicId);
    });
  }

  async payRefund(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const row = await this.repo.findRefund(tx, ctx.orgId, publicId);
      if (row === null) throw notFound('refund');
      if (row.status !== 'approved') {
        throw new AppError('DOCUMENT_STATE_INVALID', { details: [{ rule: 'refund_not_approved' }] });
      }
      await this.repo.updateRefundStatus(tx, toBigInt(row.internalId), { status: 'paid', processed: true });
      const payload: RefundPayload = {
        refundId: row.id,
        refundNo: row.refundNo,
        returnId: row.returnId,
        customerId: row.customerId,
        amount: row.amount,
        method: row.method,
        status: 'paid',
      };
      await this.emit(tx, ctx, SALES_EVENTS.refundPaid, 'refund', toBigInt(row.internalId), payload);
      await this.emit(tx, ctx, SALES_ACCOUNTING_EVENTS.refundPaid, 'refund', toBigInt(row.internalId), payload);
      return this.getRefund(ctx, publicId);
    });
  }

  async voidRefund(ctx: TenantContext, publicId: string, reason: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const row = await this.repo.findRefund(tx, ctx.orgId, publicId);
      if (row === null) throw notFound('refund');
      if (row.status === 'paid') {
        throw new AppError('DOCUMENT_STATE_INVALID', { details: [{ rule: 'refund_already_paid' }] });
      }
      await this.repo.updateRefundStatus(tx, toBigInt(row.internalId), { status: 'voided' });
      void reason;
      return this.getRefund(ctx, publicId);
    });
  }

  // =================================================================== helpers

  private async requireCustomer(tx: Db, ctx: TenantContext, publicId: string): Promise<CustomerRow> {
    const row = await this.repo.findCustomer(tx, ctx.orgId, publicId);
    if (row === null) throw notFound('customer');
    return row;
  }

  private async emitOrderEvent(
    tx: Db,
    ctx: TenantContext,
    type: string,
    order: OrderRow,
    status?: string,
  ): Promise<void> {
    const payload: OrderEventPayload = {
      orderId: order.id,
      orderNo: order.orderNo,
      status: status ?? order.status,
      customerId: order.customerId,
      channelCode: order.channelCode,
      grandTotalAmount: order.grandTotalAmount,
      currency: order.currency,
    };
    await this.emit(tx, ctx, type, 'sales_order', toBigInt(order.internalId), payload);
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

export { normalizeQuantity, addQuantity, parseIfMatch, toBigInt };
