/**
 * Fulfillment persistence (packing tasks, shipments, packages, tracking
 * events). Order status/history stay in the sales repository; this class only
 * touches the fulfillment-owned tables plus the single `sales_orders` status
 * transition it is responsible for.
 */
import { Inject, Injectable } from '@nestjs/common';

import { DB } from '../../common/contracts';
import type { Db } from '../../common/contracts';
import type { TenantContext } from '../../common/contracts';
import { toBigInt } from './sales.pg-support';

/** Sales `Db` exposes `PromiseLike`, which `await` rejects in strict TS; the
 * runtime object is a normal postgres.js client, so methods cast once here. */
export type FulfillmentDb = unknown;

type Sql = {
  <T = Record<string, unknown>>(template: TemplateStringsArray, ...parameters: readonly unknown[]): Promise<T>;
  unsafe<T = Record<string, unknown>>(query: string, parameters?: readonly unknown[]): Promise<T>;
};
function sql(tx: FulfillmentDb): Sql {
  return tx as Sql;
}

export interface PackingTaskRow {
  internalId: string;
  id: string;
  orderId: string;
  status: string;
  stationId: string | null;
  shipmentId: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ShipmentRow {
  internalId: string;
  id: string;
  shipmentNo: string | null;
  orderId: string;
  status: string;
  carrierId: string | null;
  trackingCode: string | null;
  shippingCostAmount: string;
  weightGrams: number | null;
  shippedAt: string | null;
  deliveredAt: string | null;
}

const TASK_COLUMNS = `t.id::text as "internalId", t.public_id as id, o.public_id as "orderId",
  t.status, s.public_id as "stationId", sh.public_id as "shipmentId",
  t.started_at::text as "startedAt", t.completed_at::text as "completedAt"`;

const SHIPMENT_COLUMNS = `sh.id::text as "internalId", sh.public_id as id, sh.shipment_no as "shipmentNo",
  o.public_id as "orderId", sh.status, c.public_id as "carrierId", sh.tracking_code as "trackingCode",
  sh.shipping_cost_amount::text as "shippingCostAmount", sh.weight_grams as "weightGrams",
  sh.shipped_at::text as "shippedAt", sh.delivered_at::text as "deliveredAt"`;

@Injectable()
export class FulfillmentRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findOrderInternal(tx: FulfillmentDb, orgId: bigint, orderPublicId: string): Promise<{ internalId: string; status: string; warehousePublicId: string | null; warehouseInternalId: string | null } | null> {
    const rows = await sql(tx)<{ internalId: string; status: string; warehousePublicId: string | null; warehouseInternalId: string | null }[]>`
      select o.id::text as "internalId", o.status,
             w.public_id as "warehousePublicId", o.warehouse_id::text as "warehouseInternalId"
        from erp.sales_orders o
        left join erp.warehouses w on w.id = o.warehouse_id
       where o.organization_id = ${orgId} and o.public_id = ${orderPublicId}
       limit 1`;
    return rows[0] ?? null;
  }

  async setOrderStatus(tx: FulfillmentDb, orderInternalId: bigint, status: string): Promise<void> {
    await sql(tx)`
      update erp.sales_orders
         set status = ${status},
             fulfillment_status = ${status},
             version = version + 1,
             updated_at = now()
       where id = ${orderInternalId}`;
  }

  async resolveStation(tx: FulfillmentDb, orgId: bigint, stationPublicId: string): Promise<bigint | null> {
    const rows = await sql(tx)<{ id: string }[]>`
      select ps.id::text as id
        from erp.packing_stations ps
        join erp.warehouses w on w.id = ps.warehouse_id
       where w.organization_id = ${orgId} and ps.public_id = ${stationPublicId} and ps.deleted_at is null
       limit 1`;
    return rows[0] === undefined ? null : BigInt(rows[0].id);
  }

  async insertPackingTask(
    tx: FulfillmentDb,
    input: { orgId: bigint; orderInternalId: bigint; stationInternalId: bigint | null; actorId: bigint | null },
  ): Promise<{ internalId: string; id: string }> {
    const rows = await sql(tx)<{ internalId: string; id: string }[]>`
      insert into erp.packing_tasks (order_id, station_id, status, created_by)
      values (${input.orderInternalId}, ${input.stationInternalId}, 'pending', ${input.actorId})
      returning id::text as "internalId", public_id as id`;
    const row = rows[0];
    if (row === undefined) throw new Error('packing_task_insert_failed');
    return row;
  }

  async findPackingTask(tx: FulfillmentDb, orgId: bigint, publicId: string): Promise<PackingTaskRow | null> {
    const rows = await sql(tx)<PackingTaskRow[]>`
      select ${sql(tx).unsafe(TASK_COLUMNS)}
        from erp.packing_tasks t
        join erp.sales_orders o on o.id = t.order_id
        left join erp.packing_stations s on s.id = t.station_id
        left join erp.shipments sh on sh.id = t.shipment_id
       where o.organization_id = ${orgId} and t.public_id = ${publicId}
       limit 1`;
    return rows[0] ?? null;
  }

  async lockPackingTask(tx: FulfillmentDb, orgId: bigint, publicId: string): Promise<PackingTaskRow | null> {
    const rows = await sql(tx)<PackingTaskRow[]>`
      select ${sql(tx).unsafe(TASK_COLUMNS)}
        from erp.packing_tasks t
        join erp.sales_orders o on o.id = t.order_id
        left join erp.packing_stations s on s.id = t.station_id
        left join erp.shipments sh on sh.id = t.shipment_id
       where o.organization_id = ${orgId} and t.public_id = ${publicId}
       for update of t
       limit 1`;
    return rows[0] ?? null;
  }

  async setPackingTaskStatus(
    tx: FulfillmentDb,
    taskInternalId: bigint,
    patch: { status: string; started?: boolean; completed?: boolean; packerId?: bigint | null; shipmentInternalId?: bigint | null },
  ): Promise<void> {
    await sql(tx)`
      update erp.packing_tasks
         set status = ${patch.status},
             started_at = case when ${patch.started === true} then coalesce(started_at, now()) else started_at end,
             completed_at = case when ${patch.completed === true} then now() else completed_at end,
             packer_id = coalesce(${patch.packerId ?? null}, packer_id),
             shipment_id = coalesce(${patch.shipmentInternalId ?? null}, shipment_id)
       where id = ${taskInternalId}`;
  }

  async resolveVariantByBarcode(tx: FulfillmentDb, orgId: bigint, barcode: string): Promise<{ variantInternalId: string; variantId: string; sku: string | null } | null> {
    const rows = await sql(tx)<{ variantInternalId: string; variantId: string; sku: string | null }[]>`
      select v.id::text as "variantInternalId", v.public_id as "variantId", v.sku
        from erp.product_variants v
        join erp.products p on p.id = v.product_id
       where p.organization_id = ${orgId} and v.deleted_at is null
         and (v.barcode = ${barcode} or exists (
           select 1 from erp.product_barcodes b
            where b.product_variant_id = v.id and b.barcode = ${barcode} and b.is_active
         ))
       limit 1`;
    return rows[0] ?? null;
  }

  async insertPackingScan(
    tx: FulfillmentDb,
    input: { taskInternalId: bigint; variantInternalId: string | null; barcode: string; quantity: string; result: string; actorId: bigint | null; clientScanId?: string | undefined },
  ): Promise<void> {
    await sql(tx)`
      insert into erp.packing_scans
        (packing_task_id, product_variant_id, barcode, quantity, result, scanned_by, client_scan_id)
      values (${input.taskInternalId}, ${input.variantInternalId === null ? null : input.variantInternalId}::bigint,
              ${input.barcode}, ${input.quantity}::numeric, ${input.result}, ${input.actorId},
              ${input.clientScanId ?? null})`;
  }

  async allocateShipmentNo(tx: FulfillmentDb, orgId: bigint): Promise<string> {
    const rows = await sql(tx)<{ n: number }[]>`
      select (count(*) + 1)::int as n from erp.shipments where organization_id = ${orgId}`;
    const n = rows[0]?.n ?? 1;
    return `SHP-${new Date().getUTCFullYear()}-${String(n).padStart(6, '0')}`;
  }

  async insertShipment(
    tx: FulfillmentDb,
    input: { orgId: bigint; orderInternalId: bigint; warehouseInternalId: bigint | null; shipmentNo: string; status: string; actorId: bigint | null },
  ): Promise<{ internalId: string; id: string; shipmentNo: string }> {
    const rows = await sql(tx)<{ internalId: string; id: string; shipmentNo: string }[]>`
      insert into erp.shipments
        (organization_id, order_id, warehouse_id, shipment_no, status, created_by)
      values (${input.orgId}, ${input.orderInternalId}, ${input.warehouseInternalId},
              ${input.shipmentNo}, ${input.status}, ${input.actorId})
      returning id::text as "internalId", public_id as id, shipment_no as "shipmentNo"`;
    const row = rows[0];
    if (row === undefined) throw new Error('shipment_insert_failed');
    return row;
  }

  async findShipment(tx: FulfillmentDb, orgId: bigint, publicId: string): Promise<ShipmentRow | null> {
    const rows = await sql(tx)<ShipmentRow[]>`
      select ${sql(tx).unsafe(SHIPMENT_COLUMNS)}
        from erp.shipments sh
        join erp.sales_orders o on o.id = sh.order_id
        left join erp.shipping_carriers c on c.id = sh.carrier_id
       where sh.organization_id = ${orgId} and sh.public_id = ${publicId}
       limit 1`;
    return rows[0] ?? null;
  }

  async lockShipment(tx: FulfillmentDb, orgId: bigint, publicId: string): Promise<ShipmentRow | null> {
    const rows = await sql(tx)<ShipmentRow[]>`
      select ${sql(tx).unsafe(SHIPMENT_COLUMNS)}
        from erp.shipments sh
        join erp.sales_orders o on o.id = sh.order_id
        left join erp.shipping_carriers c on c.id = sh.carrier_id
       where sh.organization_id = ${orgId} and sh.public_id = ${publicId}
       for update of sh
       limit 1`;
    return rows[0] ?? null;
  }

  async listShipments(tx: FulfillmentDb, orgId: bigint, query: { status: string | null; limit: number }): Promise<ShipmentRow[]> {
    return sql(tx)<ShipmentRow[]>`
      select ${sql(tx).unsafe(SHIPMENT_COLUMNS)}
        from erp.shipments sh
        join erp.sales_orders o on o.id = sh.order_id
        left join erp.shipping_carriers c on c.id = sh.carrier_id
       where sh.organization_id = ${orgId}
         and (${query.status}::text is null or sh.status = ${query.status})
       order by sh.id desc limit ${query.limit}`;
  }

  async updateShipment(
    tx: FulfillmentDb,
    shipmentInternalId: bigint,
    patch: { status?: string; shipped?: boolean; delivered?: boolean; trackingCode?: string | null; carrierInternalId?: bigint | null; shippingCostAmount?: string | null; weightGrams?: number | null; deliveredAt?: string | null },
  ): Promise<void> {
    await sql(tx)`
      update erp.shipments
         set status = coalesce(${patch.status ?? null}, status),
             shipped_at = case when ${patch.shipped === true} then coalesce(shipped_at, now()) else shipped_at end,
             delivered_at = case when ${patch.delivered === true} then coalesce(delivered_at, ${patch.deliveredAt ?? null}::timestamptz, now()) else delivered_at end,
             tracking_code = coalesce(${patch.trackingCode ?? null}, tracking_code),
             carrier_id = coalesce(${patch.carrierInternalId ?? null}, carrier_id),
             shipping_cost_amount = coalesce(${patch.shippingCostAmount ?? null}::bigint, shipping_cost_amount),
             weight_grams = coalesce(${patch.weightGrams ?? null}::int, weight_grams),
             version = version + 1, updated_at = now()
       where id = ${shipmentInternalId}`;
  }

  async insertPackage(
    tx: FulfillmentDb,
    input: { shipmentInternalId: bigint; packageNo: string; packageType: string; weightGrams: number | null; sealed: boolean; actorId: bigint | null },
  ): Promise<{ internalId: string; id: string; packageNo: string }> {
    const rows = await sql(tx)<{ internalId: string; id: string; packageNo: string }[]>`
      insert into erp.shipment_packages
        (shipment_id, package_no, package_type, weight_grams, status, sealed_at, sealed_by, created_by)
      values (${input.shipmentInternalId}, ${input.packageNo}, ${input.packageType}, ${input.weightGrams},
              ${input.sealed ? 'sealed' : 'open'},
              case when ${input.sealed} then now() else null end,
              ${input.sealed ? input.actorId : null}, ${input.actorId})
      returning id::text as "internalId", public_id as id, package_no as "packageNo"`;
    const row = rows[0];
    if (row === undefined) throw new Error('package_insert_failed');
    return row;
  }

  async insertPackageLine(
    tx: FulfillmentDb,
    input: { packageInternalId: bigint; variantInternalId: bigint; quantity: string; orderLineInternalId: bigint | null },
  ): Promise<void> {
    await sql(tx)`
      insert into erp.shipment_package_lines
        (package_id, product_variant_id, quantity, sales_order_line_id)
      values (${input.packageInternalId}, ${input.variantInternalId}, ${input.quantity}::numeric, ${input.orderLineInternalId})`;
  }

  async insertShipmentEvent(
    tx: FulfillmentDb,
    input: { shipmentInternalId: bigint; eventCode: string; eventSource: string; description: string | null },
  ): Promise<void> {
    await sql(tx)`
      insert into erp.shipment_events (shipment_id, event_code, event_source, description, event_at)
      values (${input.shipmentInternalId}, ${input.eventCode}, ${input.eventSource}, ${input.description}, now())`;
  }

  async resolveCarrier(tx: FulfillmentDb, orgId: bigint, publicId: string): Promise<bigint | null> {
    const rows = await sql(tx)<{ id: string }[]>`
      select id::text as id from erp.shipping_carriers
       where organization_id = ${orgId} and public_id = ${publicId} limit 1`;
    return rows[0] === undefined ? null : BigInt(rows[0].id);
  }
}
