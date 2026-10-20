/**
 * Fulfillment application service: packing task → shipment → dispatch →
 * delivery. Stock leaves the warehouse at dispatch (`sale_issue`), which
 * automatically emits the COGS accounting event; reservations are released in
 * the same transaction.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@saman/shared';

import { AUDIT, DB, EVENT_BUS } from '../../common/contracts';
import type { AuditPort, Db, EventPort, TenantContext } from '../../common/contracts';
import { CatalogLookupService } from '../catalog/product.service';
import { InventoryService } from '../inventory/inventory.service';
import type { DispatchShipmentBody, CompletePackingBody, CreatePackingTaskBody, PackingScanBody } from './fulfillment.dto';
import { FulfillmentRepository } from './fulfillment.repository';
import type { PackingTaskRow, ShipmentRow } from './fulfillment.repository';
import { SalesRepository } from './sales.repository';
import { assertTransition } from './engines/order.engine';
import type { Db as SalesDb } from './sales.pg-support';
import { notFound, toBigInt } from './sales.pg-support';

@Injectable()
export class FulfillmentService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: FulfillmentRepository,
    private readonly sales: SalesRepository,
    private readonly catalog: CatalogLookupService,
    private readonly inventory: InventoryService,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  async createPackingTask(ctx: TenantContext, body: CreatePackingTaskBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const txDb = tx as unknown as SalesDb;
      const order = await this.sales.lockOrder(txDb, ctx.orgId, body.orderId);
      if (order === null) throw notFound('sales_order');
      if (!['confirmed', 'allocated', 'picking', 'packed'].includes(order.status)) {
        throw new AppError('DOCUMENT_STATE_INVALID', {
          message: 'وضعیت سفارش اجازهٔ ساخت تسک بسته‌بندی را نمی‌دهد.',
          details: [{ rule: 'invalid_transition', params: { from: order.status, to: 'picking' } }],
        });
      }
      const stationInternalId = body.stationId === undefined ? null : await this.repo.resolveStation(tx, ctx.orgId, body.stationId);
      if (body.stationId !== undefined && stationInternalId === null) throw notFound('packing_station');
      const task = await this.repo.insertPackingTask(tx, {
        orgId: ctx.orgId,
        orderInternalId: toBigInt(order.internalId),
        stationInternalId,
        actorId: ctx.actorId,
      });
      if (order.status === 'confirmed' || order.status === 'allocated') {
        await this.repo.setOrderStatus(tx, toBigInt(order.internalId), 'picking');
        await this.sales.appendStatusHistory(txDb, {
          orderInternalId: toBigInt(order.internalId),
          fromStatus: order.status,
          toStatus: 'picking',
          field: 'status',
          changedBy: ctx.actorId,
          source: 'fulfillment',
          reason: 'packing task created',
        });
        await this.emit(tx, ctx, 'sales.order.picking', 'sales_order', toBigInt(order.internalId).toString(), { orderId: order.id, status: 'picking' });
      }
      await this.record(tx, ctx, 'fulfillment.packing_task.create', 'packing_task', task.id, null, { orderId: order.id });
      return { id: task.id, orderId: order.id, status: 'pending' };
    });
  }

  async getPackingTask(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const task = await this.repo.findPackingTask(this.db, ctx.orgId, publicId);
    if (task === null) throw notFound('packing_task');
    return taskView(task);
  }

  async scanPackingTask(ctx: TenantContext, publicId: string, body: PackingScanBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const txDb = tx as unknown as SalesDb;
      const task = await this.repo.lockPackingTask(tx, ctx.orgId, publicId);
      if (task === null) throw notFound('packing_task');
      if (task.status === 'completed' || task.status === 'cancelled') {
        throw new AppError('DOCUMENT_STATE_INVALID', { details: [{ rule: 'task_closed' }] });
      }
      if (task.status === 'pending') {
        await this.repo.setPackingTaskStatus(tx, toBigInt(task.internalId), {
          status: 'in_progress',
          started: true,
          packerId: ctx.actorId,
        });
      }
      const variant = await this.repo.resolveVariantByBarcode(tx, ctx.orgId, body.barcode);
      const orderInternalId = await this.orderInternalId(tx, ctx, task.orderId);
      const lines = await this.sales.listOrderLines(txDb, orderInternalId);
      const expected = lines.some((line) => line.variantInternalId === variant?.variantInternalId);
      const result = variant === null ? 'unknown_barcode' : expected ? 'accepted' : 'wrong_product';
      await this.repo.insertPackingScan(tx, {
        taskInternalId: toBigInt(task.internalId),
        variantInternalId: variant === null ? null : variant.variantInternalId,
        barcode: body.barcode,
        quantity: body.quantity,
        result,
        actorId: ctx.actorId,
        clientScanId: body.clientScanId,
      });
      if (result !== 'accepted') {
        throw new AppError('RULE_VIOLATION', {
          message: result === 'unknown_barcode' ? 'بارکد ناشناخته است.' : 'کالای اسکن‌شده با سفارش یکسان نیست.',
          details: [{ rule: result }],
        });
      }
      return { taskId: publicId, result, variantId: variant?.variantId ?? null, sku: variant?.sku ?? null };
    });
  }

  async completePacking(ctx: TenantContext, publicId: string, body: CompletePackingBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const txDb = tx as unknown as SalesDb;
      const task = await this.repo.lockPackingTask(tx, ctx.orgId, publicId);
      if (task === null) throw notFound('packing_task');
      if (!['pending', 'in_progress'].includes(task.status)) {
        throw new AppError('DOCUMENT_STATE_INVALID', { details: [{ rule: 'task_not_open', params: { status: task.status } }] });
      }
      const orderInternalId = await this.orderInternalId(tx, ctx, task.orderId);
      const order = await this.sales.findOrder(txDb, ctx.orgId, task.orderId);
      if (order === null) throw notFound('sales_order');
      const lines = await this.sales.listOrderLines(txDb, orderInternalId);
      if (lines.length === 0) throw new AppError('RULE_VIOLATION', { details: [{ rule: 'empty_order' }] });

      const shipmentNo = await this.repo.allocateShipmentNo(tx, ctx.orgId);
      const shipment = await this.repo.insertShipment(tx, {
        orgId: ctx.orgId,
        orderInternalId,
        warehouseInternalId: order.warehouseInternalId === null ? null : toBigInt(order.warehouseInternalId),
        shipmentNo,
        status: 'packed',
        actorId: ctx.actorId,
      });
      const packageNo = body.packageNo ?? `${shipmentNo}-P1`;
      const pkg = await this.repo.insertPackage(tx, {
        shipmentInternalId: toBigInt(shipment.internalId),
        packageNo,
        packageType: body.packageType ?? 'box',
        weightGrams: body.weightGrams ?? null,
        sealed: true,
        actorId: ctx.actorId,
      });
      for (const line of lines) {
        await this.repo.insertPackageLine(tx, {
          packageInternalId: toBigInt(pkg.internalId),
          variantInternalId: toBigInt(line.variantInternalId),
          quantity: line.quantity,
          orderLineInternalId: toBigInt(line.internalId),
        });
      }
      if (body.carrierId !== undefined) {
        const carrier = await this.repo.resolveCarrier(tx, ctx.orgId, body.carrierId);
        if (carrier === null) throw notFound('carrier');
        await this.repo.updateShipment(tx, toBigInt(shipment.internalId), { carrierInternalId: carrier });
      }
      await this.repo.setPackingTaskStatus(tx, toBigInt(task.internalId), {
        status: 'completed',
        completed: true,
        packerId: ctx.actorId,
        shipmentInternalId: toBigInt(shipment.internalId),
      });
      await this.repo.setOrderStatus(tx, orderInternalId, 'packed');
      await this.sales.appendStatusHistory(txDb, {
        orderInternalId,
        fromStatus: order.status,
        toStatus: 'packed',
        field: 'fulfillment_status',
        changedBy: ctx.actorId,
        source: 'fulfillment',
        reason: 'packing completed',
      });
      await this.repo.insertShipmentEvent(tx, {
        shipmentInternalId: toBigInt(shipment.internalId),
        eventCode: 'packed',
        eventSource: 'system',
        description: `package ${packageNo} sealed`,
      });
      await this.emit(tx, ctx, 'sales.order.packed', 'sales_order', toBigInt(order.internalId).toString(), {
        orderId: order.id,
        shipmentId: shipment.id,
        shipmentNo,
        packageCount: 1,
      });
      await this.record(tx, ctx, 'fulfillment.shipment.pack', 'shipment', shipment.id, null, {
        orderId: order.id,
        packageNo,
      });
      return { shipmentId: shipment.id, shipmentNo, packageNo, orderId: order.id, status: 'packed' };
    });
  }

  async listShipments(ctx: TenantContext, query: { status: string | null; limit: number }): Promise<Record<string, unknown>[]> {
    const rows = await this.repo.listShipments(this.db, ctx.orgId, query);
    return rows.map(shipmentView);
  }

  async getShipment(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const shipment = await this.repo.findShipment(this.db, ctx.orgId, publicId);
    if (shipment === null) throw notFound('shipment');
    return shipmentView(shipment);
  }

  async dispatchShipment(ctx: TenantContext, publicId: string, body: DispatchShipmentBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const txDb = tx as unknown as SalesDb;
      const shipment = await this.repo.lockShipment(tx, ctx.orgId, publicId);
      if (shipment === null) throw notFound('shipment');
      if (shipment.status !== 'packed') {
        throw new AppError('DOCUMENT_STATE_INVALID', {
          message: 'فقط محمولهٔ بسته‌بندی‌شده قابل ارسال است.',
          details: [{ rule: 'shipment_not_packed', params: { status: shipment.status } }],
        });
      }
      const order = await this.sales.lockOrder(txDb, ctx.orgId, shipment.orderId);
      if (order === null) throw notFound('sales_order');
      const orderInternalId = toBigInt(order.internalId);
      assertTransition(order.status, 'shipped', 'ship');

      // Consume reservations into the ledger (sale_issue → automatic COGS).
      const reservations = await this.inventory.listReservations(ctx, {
        limit: 500,
        status: 'active',
        sourceType: 'sales_order',
        sourceId: orderInternalId.toString(),
      });
      let unitCount = 0;
      for (const reservation of reservations) {
        const quantity = String(reservation['quantity']);
        if (Number(quantity) <= 0) continue;
        await this.inventory.postMovement(tx as never, ctx, {
          warehouseId: String(reservation['warehouseId']),
          locationId: String(reservation['locationId']),
          variantId: String(reservation['variantId']),
          type: 'sale_issue',
          quantity,
          referenceType: 'sales_shipment',
          referenceId: shipment.id,
          referenceInternalId: toBigInt(shipment.internalId),
          idempotencyKey: `ship:${shipment.id}:${String(reservation['id'])}`,
        });
        unitCount += 1;
      }
      if (unitCount > 0) {
        await this.inventory.releaseForReference(tx as never, ctx, 'sales_order', orderInternalId);
      }

      const carrierInternalId = body.carrierId === undefined ? null : await this.repo.resolveCarrier(tx, ctx.orgId, body.carrierId);
      if (body.carrierId !== undefined && carrierInternalId === null) throw notFound('carrier');
      await this.repo.updateShipment(tx, toBigInt(shipment.internalId), {
        status: 'dispatched',
        shipped: true,
        ...(body.trackingCode === undefined ? {} : { trackingCode: body.trackingCode }),
        ...(carrierInternalId === null ? {} : { carrierInternalId }),
        ...(body.shippingCostAmount === undefined ? {} : { shippingCostAmount: body.shippingCostAmount }),
        ...(body.weightGrams === undefined ? {} : { weightGrams: body.weightGrams }),
      });
      await this.repo.setOrderStatus(tx, orderInternalId, 'shipped');
      await this.sales.appendStatusHistory(txDb, {
        orderInternalId,
        fromStatus: order.status,
        toStatus: 'shipped',
        field: 'fulfillment_status',
        changedBy: ctx.actorId,
        source: 'fulfillment',
        reason: 'shipment dispatched',
      });
      await this.repo.insertShipmentEvent(tx, {
        shipmentInternalId: toBigInt(shipment.internalId),
        eventCode: 'dispatched',
        eventSource: 'system',
        description: body.trackingCode === undefined ? null : `tracking ${body.trackingCode}`,
      });
      await this.emit(tx, ctx, 'sales.order.shipped', 'sales_order', toBigInt(order.internalId).toString(), {
        orderId: order.id,
        shipmentId: shipment.id,
        trackingCode: body.trackingCode ?? null,
        lines: unitCount,
      });
      await this.record(tx, ctx, 'fulfillment.shipment.dispatch', 'shipment', shipment.id, null, {
        orderId: order.id,
        trackingCode: body.trackingCode ?? null,
        lines: unitCount,
      });
      return { shipmentId: shipment.id, status: 'dispatched', orderId: order.id, issuedReservations: unitCount };
    });
  }

  async deliverShipment(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const txDb = tx as unknown as SalesDb;
      const shipment = await this.repo.lockShipment(tx, ctx.orgId, publicId);
      if (shipment === null) throw notFound('shipment');
      if (!['dispatched', 'in_transit'].includes(shipment.status)) {
        throw new AppError('DOCUMENT_STATE_INVALID', { details: [{ rule: 'shipment_not_dispatched', params: { status: shipment.status } }] });
      }
      const order = await this.sales.lockOrder(txDb, ctx.orgId, shipment.orderId);
      if (order === null) throw notFound('sales_order');
      const orderInternalId = toBigInt(order.internalId);
      await this.repo.updateShipment(tx, toBigInt(shipment.internalId), { status: 'delivered', delivered: true });
      await this.repo.setOrderStatus(tx, orderInternalId, 'delivered');
      await this.sales.appendStatusHistory(txDb, {
        orderInternalId,
        fromStatus: order.status,
        toStatus: 'delivered',
        field: 'fulfillment_status',
        changedBy: ctx.actorId,
        source: 'fulfillment',
        reason: 'shipment delivered',
      });
      await this.repo.insertShipmentEvent(tx, {
        shipmentInternalId: toBigInt(shipment.internalId),
        eventCode: 'delivered',
        eventSource: 'system',
        description: null,
      });
      await this.emit(tx, ctx, 'sales.order.delivered', 'sales_order', toBigInt(order.internalId).toString(), { orderId: order.id, shipmentId: shipment.id });
      await this.record(tx, ctx, 'fulfillment.shipment.deliver', 'shipment', shipment.id, null, { orderId: order.id });
      return { shipmentId: shipment.id, status: 'delivered', orderId: order.id };
    });
  }

  private async orderInternalId(tx: unknown, ctx: TenantContext, orderPublicId: string): Promise<bigint> {
    const row = await this.repo.findOrderInternal(tx, ctx.orgId, orderPublicId);
    if (row === null) throw notFound('sales_order');
    return BigInt(row.internalId);
  }

  private async emit(tx: unknown, ctx: TenantContext, type: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>): Promise<void> {
    await this.events.emit(tx as never, {
      orgId: ctx.orgId,
      type,
      aggregateType,
      aggregateId,
      payload,
      dedupeKey: `${type}:${aggregateId}:${Date.now()}`,
    });
  }

  private async record(
    tx: unknown,
    ctx: TenantContext,
    action: string,
    entityType: string,
    entityId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ): Promise<void> {
    await this.audit.record(tx as never, {
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

function taskView(row: PackingTaskRow): Record<string, unknown> {
  return {
    id: row.id,
    orderId: row.orderId,
    status: row.status,
    stationId: row.stationId,
    shipmentId: row.shipmentId,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

function shipmentView(row: ShipmentRow): Record<string, unknown> {
  return {
    id: row.id,
    shipmentNo: row.shipmentNo,
    orderId: row.orderId,
    status: row.status,
    carrierId: row.carrierId,
    trackingCode: row.trackingCode,
    shippingCostAmount: row.shippingCostAmount,
    weightGrams: row.weightGrams,
    shippedAt: row.shippedAt,
    deliveredAt: row.deliveredAt,
  };
}

