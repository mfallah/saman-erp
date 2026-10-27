/**
 * Warehouse SQL (`DATA-MODEL` §2.5): location hierarchy, putaway, pick waves and
 * scan logs. Inventory balances are read only through the inventory service for
 * stock decisions; the location-contents projection is a documented read-only
 * join used by the scanner UI.
 */
import type { BigIntish, Db } from './warehouse.pg-support';

export interface WarehouseRow {
  internalId: string;
  id: string;
  code: string;
  name: string;
  branchId: string | null;
  warehouseType: string;
  city: string | null;
  address: string | null;
  isActive: boolean;
  version: number;
  createdAt: string;
}

export interface LocationRow {
  internalId: string;
  id: string;
  warehouseInternalId: string;
  warehouseId: string;
  fullCode: string;
  barcode: string | null;
  locationType: string;
  pickPriority: number;
  isPickable: boolean;
  isActive: boolean;
  binInternalId: string | null;
  zoneCode: string | null;
  abcClass: string | null;
  capacityQuantity: string | null;
  version: number;
}

export interface PickWaveRow {
  internalId: string;
  id: string;
  waveNo: string;
  warehouseId: string;
  warehouseInternalId: string;
  strategy: string;
  status: string;
  priority: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PickTaskRow {
  internalId: string;
  id: string;
  waveInternalId: string | null;
  waveId: string | null;
  orderId: string;
  orderNo: string | null;
  orderInternalId: string;
  variantId: string;
  variantInternalId: string;
  locationId: string;
  locationInternalId: string;
  locationFullCode: string;
  pickPriority: number;
  quantityRequired: string;
  quantityPicked: string;
  sequenceNo: number;
  status: string;
  assignedTo: string | null;
  assignedToName: string | null;
  barcode: string | null;
  sku: string | null;
  title: string | null;
  createdAt: string;
  ageMinutes: number;
}

/** Row returned by the picker's own task feed (`GET warehouse/pick-tasks/mine`). */
export interface MyPickTaskRow {
  id: string;
  status: string;
  orderNo: string | null;
  channelCode: string | null;
  sku: string | null;
  title: string | null;
  productName: string | null;
  variantSku: string | null;
  imageUrl: string | null;
  quantity: string;
  quantityRequired: string;
  quantityPicked: string;
  locationCode: string;
  sequenceNo: number;
  assignedTo: string | null;
  assignedToName: string | null;
  createdAt: string;
  ageMinutes: number;
}

/** An order that has lines but no pick task yet (backfill candidate). */
export interface PickBackfillCandidateRow {
  internalId: string;
  orderId: string;
  orderNo: string | null;
}

/** An order line still waiting for its auto-created pick task. */
export interface PickQueueLineRow {
  id: string;
  variantInternalId: string;
  quantity: string;
}

/** Active warehouse picker and the number of tasks already open for them. */
export interface PickerRow {
  id: string;
  openTasks: number;
}

/** One open pick task as shown on the picking board (order + location + owner). */
export interface PickBoardTaskRow {
  id: string;
  orderInternalId: string;
  orderId: string;
  orderNo: string | null;
  channelCode: string | null;
  orderStatus: string;
  fulfillmentStatus: string;
  waveId: string | null;
  waveNo: string | null;
  sku: string | null;
  title: string | null;
  productName: string | null;
  variantSku: string | null;
  imageUrl: string | null;
  quantityRequired: string;
  quantityPicked: string;
  locationCode: string | null;
  sequenceNo: number;
  status: string;
  assignedTo: string | null;
  assignedToName: string | null;
  createdAt: string;
  ageMinutes: number;
}

/** Aggregates that explain *why* the picking board may be empty. */
export interface PickBoardDiagnosticsRow {
  tasksTotal: number;
  openTasks: number;
  ordersTotal: number;
  ordersWithLines: number;
  ordersWithoutLines: number;
  ordersWithoutTasks: number;
  ordersWithoutWarehouse: number;
  warehouses: number;
  activePickers: number;
  fallbackPickers: number;
}

/** One order line of a pack task, shown on the packing card. */
export interface PackTaskItemRow {
  name: string;
  sku: string | null;
  qty: string;
  imageUrl: string | null;
}

/**
 * A pack task from `erp.pack_tasks` (created by the picking station when an
 * order is fully picked). The table is owned by the fulfilment migration.
 * `channelCode` drives the handling rule (Digikala warehouse vs ship-to-customer);
 * `items`, `address` and `customerName` make the packing card self-explanatory.
 */
export interface PackTaskRow {
  internalId: string;
  id: string;
  orderInternalId: string;
  orderId: string;
  orderNo: string | null;
  channelCode: string | null;
  fulfillmentStatus: string;
  packageNo: string | null;
  status: string;
  assignedTo: string | null;
  assignedToName: string | null;
  notes: string | null;
  itemCount: number;
  totalQuantity: string;
  items: readonly PackTaskItemRow[];
  /** `erp.sales_orders.shipping_address_json`, when the order carries one. */
  address: Record<string, unknown> | null;
  customerName: string | null;
  customerPhone: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  ageMinutes: number;
}

/** Counters behind the packing board's empty-state explanation. */
export interface PackBoardDiagnosticsRow {
  tasksTotal: number;
  pending: number;
  packing: number;
  packed: number;
  pickedOrders: number;
  pickedOrdersWithoutPackTask: number;
  pickedTasks: number;
}

/** Channel reference of an order, used for the best-effort ready-to-ship push. */
export interface OrderChannelRefRow {
  externalOrderId: string | null;
  accountPublicId: string | null;
}

/** Every barcode a pick task's item can be identified by (station scan). */
export interface PickTaskBarcodeRow {
  /** Primary barcode stored on the variant (`product_variants.barcode`). */
  variantBarcode: string | null;
  /** Sales-order-line SKU snapshot, falling back to the variant SKU. */
  sku: string | null;
  /** Additional active barcodes from `erp.product_barcodes`. */
  barcodes: string[] | null;
}

/** A scanned code resolved by `GET /scan/lookup`. */
export interface ScanLookupRow {
  kind: 'product' | 'location' | 'order' | 'task';
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  url: string;
}

export interface PutawayTaskRow {
  internalId: string;
  id: string;
  warehouseId: string;
  variantId: string;
  targetLocationId: string;
  quantity: string;
  status: string;
  sourceReferenceType: string | null;
  sourceReferenceId: string | null;
}

function warehouseColumns(tx: Db) {
  return tx`
    w.id::text as "internalId",
    w.public_id as id,
    w.code,
    w.name,
    b.public_id as "branchId",
    w.warehouse_type as "warehouseType",
    w.city,
    w.address,
    w.is_active as "isActive",
    w.version,
    w.created_at::text as "createdAt"
  `;
}

function warehouseFrom(tx: Db) {
  return tx`
    from erp.warehouses w
    left join erp.branches b on b.id = w.branch_id
  `;
}

function locationColumns(tx: Db) {
  return tx`
    l.id::text as "internalId",
    l.public_id as id,
    l.warehouse_id::text as "warehouseInternalId",
    w.public_id as "warehouseId",
    l.full_code as "fullCode",
    l.barcode,
    l.location_type as "locationType",
    l.pick_priority as "pickPriority",
    l.is_pickable as "isPickable",
    l.is_active as "isActive",
    l.bin_id::text as "binInternalId",
    z.code as "zoneCode",
    z.abc_class as "abcClass",
    bn.capacity_qty::text as "capacityQuantity",
    l.version
  `;
}

function locationFrom(tx: Db) {
  return tx`
    from erp.warehouse_locations l
    join erp.warehouses w on w.id = l.warehouse_id
    left join erp.warehouse_bins bn on bn.id = l.bin_id
    left join erp.warehouse_shelves sh on sh.id = bn.shelf_id
    left join erp.warehouse_racks rk on rk.id = sh.rack_id
    left join erp.warehouse_aisles ai on ai.id = rk.aisle_id
    left join erp.warehouse_zones z on z.id = ai.zone_id
  `;
}

export class WarehouseRepository {
  constructor(private readonly db: Db) {}

  // =============================================================== warehouses

  async listWarehouses(tx: Db, params: { orgId: bigint; status: boolean | null; branchInternalId: BigIntish | null; search: string | null; warehouseIds?: readonly string[] | null; limit: number; offset: number }) {
    const pattern = params.search === null ? null : `%${params.search}%`;
    return tx<WarehouseRow[]>`
      select ${warehouseColumns(tx)} ${warehouseFrom(tx)}
      where w.organization_id = ${params.orgId} and w.deleted_at is null
        and (${params.status}::boolean is null or w.is_active = ${params.status}::boolean)
        and (${pattern}::text is null or w.name ilike ${pattern} or w.code ilike ${pattern})
        and (${params.warehouseIds ?? null}::bigint[] is null or w.id = any(${params.warehouseIds ?? null}::bigint[]))
      order by w.code asc
      limit ${params.limit} offset ${params.offset}
    `;
  }

  async findWarehouse(tx: Db, orgId: bigint, publicId: string): Promise<WarehouseRow | null> {
    const rows = await tx<WarehouseRow[]>`
      select ${warehouseColumns(tx)} ${warehouseFrom(tx)}
      where w.organization_id = ${orgId} and w.public_id = ${publicId} and w.deleted_at is null
      limit 1
    `;
    return rows[0] ?? null;
  }

  async codeExists(tx: Db, orgId: bigint, code: string, exceptInternalId?: bigint): Promise<boolean> {
    const rows = await tx<{ exists: boolean }[]>`
      select exists(
        select 1 from erp.warehouses
        where organization_id = ${orgId} and code = ${code} and deleted_at is null
          and (${exceptInternalId ?? null}::bigint is null or id <> ${exceptInternalId ?? null}::bigint)
      ) as exists
    `;
    return rows[0]?.exists ?? false;
  }

  async insertWarehouse(
    tx: Db,
    input: {
      orgId: bigint;
      code: string;
      name: string;
      branchInternalId: BigIntish | null;
      warehouseType: string;
      address: string | null;
      city: string | null;
    },
  ): Promise<WarehouseRow> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.warehouses
        (organization_id, public_id, code, name, branch_id, warehouse_type, address, city)
      values (${input.orgId}, gen_random_uuid(), ${input.code}, ${input.name},
              ${input.branchInternalId}, ${input.warehouseType}, ${input.address}, ${input.city})
      returning id::text as id
    `;
    return (await this.findWarehouseById(tx, input.orgId, BigInt(rows[0]?.id ?? '0'))) as WarehouseRow;
  }

  private async findWarehouseById(tx: Db, orgId: bigint, internalId: bigint): Promise<WarehouseRow | null> {
    const rows = await tx<WarehouseRow[]>`
      select ${warehouseColumns(tx)} ${warehouseFrom(tx)}
      where w.organization_id = ${orgId} and w.id = ${internalId} limit 1
    `;
    return rows[0] ?? null;
  }

  async updateWarehouse(
    tx: Db,
    orgId: bigint,
    internalId: bigint,
    patch: { name: string; address: string | null; city: string | null; isActive: boolean; warehouseType: string },
  ): Promise<WarehouseRow> {
    await tx`
      update erp.warehouses
      set name = ${patch.name}, address = ${patch.address}, city = ${patch.city},
          is_active = ${patch.isActive}, warehouse_type = ${patch.warehouseType},
          updated_at = now(), version = version + 1
      where organization_id = ${orgId} and id = ${internalId}
    `;
    return (await this.findWarehouseById(tx, orgId, internalId)) as WarehouseRow;
  }

  async softDeleteWarehouse(tx: Db, orgId: bigint, internalId: bigint): Promise<void> {
    await tx`
      update erp.warehouses set deleted_at = now(), is_active = false,
        updated_at = now(), version = version + 1
      where organization_id = ${orgId} and id = ${internalId}
    `;
  }

  async warehouseHasStock(tx: Db, warehouseInternalId: bigint): Promise<boolean> {
    const rows = await tx<{ exists: boolean }[]>`
      select exists(
        select 1 from erp.inventory_balances
        where warehouse_id = ${warehouseInternalId} and on_hand > 0
      ) as exists
    `;
    return rows[0]?.exists ?? false;
  }

  // ============================================================ location tree

  async insertZone(tx: Db, input: { warehouseInternalId: bigint; code: string; name: string; abcClass: string | null; pickSequence: number; zoneType: string }): Promise<string> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.warehouse_zones
        (public_id, warehouse_id, code, name, zone_type, abc_class, pick_sequence)
      values (gen_random_uuid(), ${input.warehouseInternalId}, ${input.code}, ${input.name},
              ${input.zoneType}, ${input.abcClass}, ${input.pickSequence})
      returning id::text as id
    `;
    return rows[0]?.id ?? '0';
  }

  async insertAisle(tx: Db, input: { zoneInternalId: bigint; code: string; name: string; sequenceNo: number }): Promise<string> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.warehouse_aisles (public_id, zone_id, code, name, sequence_no)
      values (gen_random_uuid(), ${input.zoneInternalId}, ${input.code}, ${input.name}, ${input.sequenceNo})
      returning id::text as id
    `;
    return rows[0]?.id ?? '0';
  }

  async insertRack(tx: Db, input: { aisleInternalId: bigint; code: string; name: string; sequenceNo: number }): Promise<string> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.warehouse_racks (public_id, aisle_id, code, name, sequence_no)
      values (gen_random_uuid(), ${input.aisleInternalId}, ${input.code}, ${input.name}, ${input.sequenceNo})
      returning id::text as id
    `;
    return rows[0]?.id ?? '0';
  }

  async insertShelf(tx: Db, input: { rackInternalId: bigint; code: string; levelNo: number; sequenceNo: number }): Promise<string> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.warehouse_shelves (public_id, rack_id, code, level_no, sequence_no)
      values (gen_random_uuid(), ${input.rackInternalId}, ${input.code}, ${input.levelNo}, ${input.sequenceNo})
      returning id::text as id
    `;
    return rows[0]?.id ?? '0';
  }

  async insertBin(
    tx: Db,
    input: { shelfInternalId: bigint; code: string; binType: string; capacityQuantity: string | null; isPickFace: boolean },
  ): Promise<string> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.warehouse_bins
        (public_id, shelf_id, code, bin_type, capacity_qty, is_pick_face)
      values (gen_random_uuid(), ${input.shelfInternalId}, ${input.code}, ${input.binType},
              ${input.capacityQuantity}::numeric, ${input.isPickFace})
      returning id::text as id
    `;
    return rows[0]?.id ?? '0';
  }

  async insertLocation(
    tx: Db,
    input: {
      warehouseInternalId: bigint;
      binInternalId: bigint | null;
      fullCode: string;
      barcode: string;
      locationType: string;
      pickPriority: number;
      isPickable: boolean;
    },
  ): Promise<LocationRow> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.warehouse_locations
        (public_id, warehouse_id, bin_id, full_code, barcode, location_type, pick_priority, is_pickable)
      values (gen_random_uuid(), ${input.warehouseInternalId}, ${input.binInternalId}, ${input.fullCode},
              ${input.barcode}, ${input.locationType}, ${input.pickPriority}, ${input.isPickable})
      returning id::text as id
    `;
    return (await this.findLocationById(tx, BigInt(rows[0]?.id ?? '0'))) as LocationRow;
  }

  private async findLocationById(tx: Db, internalId: bigint): Promise<LocationRow | null> {
    const rows = await tx<LocationRow[]>`
      select ${locationColumns(tx)} ${locationFrom(tx)} where l.id = ${internalId} limit 1
    `;
    return rows[0] ?? null;
  }

  async listLocations(
    tx: Db,
    params: {
      orgId: bigint;
      warehouseInternalId: bigint | null;
      locationType: string | null;
      search: string | null;
      limit: number;
      offset: number;
    },
  ): Promise<LocationRow[]> {
    const pattern = params.search === null ? null : `%${params.search}%`;
    return tx<LocationRow[]>`
      select ${locationColumns(tx)} ${locationFrom(tx)}
      where w.organization_id = ${params.orgId} and w.deleted_at is null
        and (${params.warehouseInternalId}::bigint is null or l.warehouse_id = ${params.warehouseInternalId}::bigint)
        and (${params.locationType}::text is null or l.location_type = ${params.locationType})
        and (${pattern}::text is null or l.full_code ilike ${pattern} or l.barcode ilike ${pattern})
      order by l.pick_priority asc, l.full_code asc
      limit ${params.limit} offset ${params.offset}
    `;
  }

  async findLocationByCode(tx: Db, orgId: bigint, warehouseInternalId: bigint | null, code: string): Promise<LocationRow | null> {
    const normalized = code.trim().toUpperCase();
    const rows = await tx<LocationRow[]>`
      select ${locationColumns(tx)} ${locationFrom(tx)}
      where w.organization_id = ${orgId}
        and (${warehouseInternalId}::bigint is null or l.warehouse_id = ${warehouseInternalId}::bigint)
        and (upper(l.full_code) = ${normalized} or upper(coalesce(l.barcode, '')) = ${normalized})
      limit 1
    `;
    return rows[0] ?? null;
  }

  async findLocation(tx: Db, orgId: bigint, publicId: string): Promise<LocationRow | null> {
    const rows = await tx<LocationRow[]>`
      select ${locationColumns(tx)} ${locationFrom(tx)}
      where w.organization_id = ${orgId} and l.public_id = ${publicId}
      limit 1
    `;
    return rows[0] ?? null;
  }

  async updateLocation(
    tx: Db,
    internalId: bigint,
    patch: { barcode: string | null; pickPriority: number; isActive: boolean; isPickable: boolean },
  ): Promise<LocationRow> {
    await tx`
      update erp.warehouse_locations
      set barcode = ${patch.barcode}, pick_priority = ${patch.pickPriority},
          is_active = ${patch.isActive}, is_pickable = ${patch.isPickable},
          updated_at = now(), version = version + 1
      where id = ${internalId}
    `;
    return (await this.findLocationById(tx, internalId)) as LocationRow;
  }

  async softDeleteLocation(tx: Db, internalId: bigint): Promise<void> {
    await tx`
      update erp.warehouse_locations
      set is_active = false, updated_at = now(), version = version + 1
      where id = ${internalId}
    `;
  }

  async locationHasStock(tx: Db, locationInternalId: bigint): Promise<boolean> {
    const rows = await tx<{ exists: boolean }[]>`
      select exists(
        select 1 from erp.inventory_balances
        where location_id = ${locationInternalId} and on_hand > 0
      ) as exists
    `;
    return rows[0]?.exists ?? false;
  }

  async locationContents(tx: Db, locationInternalId: bigint): Promise<Record<string, unknown>[]> {
    return tx`
      select v.public_id as "variantId", v.sku, b.on_hand::text as "onHand",
             b.reserved::text as reserved, b.damaged::text as damaged,
             (b.on_hand - b.reserved - b.safety_buffer - b.damaged)::text as available
      from erp.inventory_balances b
      join erp.product_variants v on v.id = b.product_variant_id
      where b.location_id = ${locationInternalId} and b.on_hand > 0
      order by v.sku asc
    `;
  }

  /** Full zone/aisle/rack/shelf/bin tree for `GET /warehouses/{id}/tree`. */
  async locationTree(tx: Db, warehouseInternalId: bigint): Promise<
    {
      level: string;
      id: string;
      code: string;
      fullCode: string | null;
      parentId: string | null;
      abcClass: string | null;
      capacityQuantity: string | null;
      pickPriority: number | null;
    }[]
  > {
    return tx`
      select 'zone' as level, z.public_id as id, z.code, null::text as "fullCode",
             null::uuid as "parentId", z.abc_class as "abcClass", null::text as "capacityQuantity",
             z.pick_sequence as "pickPriority"
      from erp.warehouse_zones z where z.warehouse_id = ${warehouseInternalId}
      union all
      select 'aisle', a.public_id, a.code, null, z.public_id, null, null, a.sequence_no
      from erp.warehouse_aisles a
      join erp.warehouse_zones z on z.id = a.zone_id
      where z.warehouse_id = ${warehouseInternalId}
      union all
      select 'rack', r.public_id, r.code, null, a.public_id, null, null, r.sequence_no
      from erp.warehouse_racks r
      join erp.warehouse_aisles a on a.id = r.aisle_id
      join erp.warehouse_zones z on z.id = a.zone_id
      where z.warehouse_id = ${warehouseInternalId}
      union all
      select 'shelf', sh.public_id, sh.code, null, r.public_id, null, null, sh.sequence_no
      from erp.warehouse_shelves sh
      join erp.warehouse_racks r on r.id = sh.rack_id
      join erp.warehouse_aisles a on a.id = r.aisle_id
      join erp.warehouse_zones z on z.id = a.zone_id
      where z.warehouse_id = ${warehouseInternalId}
      union all
      select 'bin', bn.public_id, bn.code, null, sh.public_id, null, bn.capacity_qty::text, 0
      from erp.warehouse_bins bn
      join erp.warehouse_shelves sh on sh.id = bn.shelf_id
      join erp.warehouse_racks r on r.id = sh.rack_id
      join erp.warehouse_aisles a on a.id = r.aisle_id
      join erp.warehouse_zones z on z.id = a.zone_id
      where z.warehouse_id = ${warehouseInternalId}
      union all
      select 'location', l.public_id, l.full_code, l.full_code, bn.public_id, null, bn.capacity_qty::text, l.pick_priority
      from erp.warehouse_locations l
      left join erp.warehouse_bins bn on bn.id = l.bin_id
      where l.warehouse_id = ${warehouseInternalId}
    `;
  }

  async resolveZone(tx: Db, publicId: string): Promise<{ internalId: string; warehouseInternalId: string; code: string; abcClass: string | null } | null> {
    const rows = await tx<{ internalId: string; warehouseInternalId: string; code: string; abcClass: string | null }[]>`
      select id::text as "internalId", warehouse_id::text as "warehouseInternalId", code,
             abc_class as "abcClass"
      from erp.warehouse_zones where public_id = ${publicId}
    `;
    return rows[0] ?? null;
  }

  async resolveAisle(tx: Db, publicId: string): Promise<{ internalId: string } | null> {
    const rows = await tx<{ internalId: string }[]>`
      select id::text as "internalId" from erp.warehouse_aisles where public_id = ${publicId}
    `;
    return rows[0] ?? null;
  }

  async resolveRack(tx: Db, publicId: string): Promise<{ internalId: string } | null> {
    const rows = await tx<{ internalId: string }[]>`
      select id::text as "internalId" from erp.warehouse_racks where public_id = ${publicId}
    `;
    return rows[0] ?? null;
  }

  async resolveShelf(tx: Db, publicId: string): Promise<{ internalId: string } | null> {
    const rows = await tx<{ internalId: string }[]>`
      select id::text as "internalId" from erp.warehouse_shelves where public_id = ${publicId}
    `;
    return rows[0] ?? null;
  }

  async resolveBin(tx: Db, publicId: string): Promise<{ internalId: string; shelfInternalId: string; code: string } | null> {
    const rows = await tx<{ internalId: string; shelfInternalId: string; code: string }[]>`
      select id::text as "internalId", shelf_id::text as "shelfInternalId", code
      from erp.warehouse_bins where public_id = ${publicId}
    `;
    return rows[0] ?? null;
  }

  /** Code chain of a bin: `zone/aisle/rack/shelf/bin` codes for full-code build. */
  async binChain(
    tx: Db,
    binInternalId: bigint,
  ): Promise<{ zoneCode: string; aisleCode: string; rackCode: string; shelfCode: string; binCode: string } | null> {
    const rows = await tx<
      { zoneCode: string; aisleCode: string; rackCode: string; shelfCode: string; binCode: string }[]
    >`
      select z.code as "zoneCode", a.code as "aisleCode", r.code as "rackCode",
             s.code as "shelfCode", b.code as "binCode"
      from erp.warehouse_bins b
      join erp.warehouse_shelves s on s.id = b.shelf_id
      join erp.warehouse_racks r on r.id = s.rack_id
      join erp.warehouse_aisles a on a.id = r.aisle_id
      join erp.warehouse_zones z on z.id = a.zone_id
      where b.id = ${binInternalId}
    `;
    return rows[0] ?? null;
  }

  // ============================================================= putaway rules

  async listPutawayRules(tx: Db, warehouseInternalId: bigint): Promise<
    { internalId: string; variantId: string | null; categoryId: string | null; locationId: string | null; strategy: string; priority: number }[]
  > {
    return tx`
      select pr.id::text as "internalId", v.public_id as "variantId", c.public_id as "categoryId",
             l.public_id as "locationId", pr.strategy, pr.priority
      from erp.putaway_rules pr
      left join erp.product_variants v on v.id = pr.product_variant_id
      left join erp.product_categories c on c.id = pr.category_id
      left join erp.warehouse_locations l on l.id = pr.location_id
      where pr.warehouse_id = ${warehouseInternalId} and pr.is_active
      order by pr.priority asc
    `;
  }

  async loadCapacity(tx: Db, locationInternalIds: readonly bigint[]): Promise<{ locationInternalId: string; capacityQuantity: string | null }[]> {
    if (locationInternalIds.length === 0) return [];
    return tx`
      select l.id::text as "locationInternalId", bn.capacity_qty::text as "capacityQuantity"
      from erp.warehouse_locations l
      left join erp.warehouse_bins bn on bn.id = l.bin_id
      where l.id = any(${locationInternalIds.map((v) => v.toString())}::bigint[])
    `;
  }

  async insertPutawayTask(
    tx: Db,
    input: {
      warehouseInternalId: bigint;
      variantInternalId: bigint;
      targetLocationInternalId: bigint;
      quantity: string;
      sourceReferenceType: string | null;
      sourceReferenceInternalId: bigint | null;
      lotInternalId: bigint | null;
    },
  ): Promise<PutawayTaskRow> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.putaway_tasks
        (public_id, warehouse_id, product_variant_id, target_location_id, quantity,
         source_reference_type, source_reference_id, lot_id)
      values (gen_random_uuid(), ${input.warehouseInternalId}, ${input.variantInternalId},
              ${input.targetLocationInternalId}, ${input.quantity}::numeric,
              ${input.sourceReferenceType}, ${input.sourceReferenceInternalId}, ${input.lotInternalId})
      returning id::text as id
    `;
    return (await this.findPutawayTaskById(tx, BigInt(rows[0]?.id ?? '0'))) as PutawayTaskRow;
  }

  async findPutawayTaskById(tx: Db, internalId: bigint): Promise<PutawayTaskRow | null> {
    const rows = await tx<PutawayTaskRow[]>`
      select t.id::text as "internalId", t.public_id as id, w.public_id as "warehouseId",
             v.public_id as "variantId", l.public_id as "targetLocationId",
             t.quantity::text as quantity, t.status,
             t.source_reference_type as "sourceReferenceType",
             t.source_reference_id::text as "sourceReferenceId"
      from erp.putaway_tasks t
      join erp.warehouses w on w.id = t.warehouse_id
      join erp.product_variants v on v.id = t.product_variant_id
      join erp.warehouse_locations l on l.id = t.target_location_id
      where t.id = ${internalId}
    `;
    return rows[0] ?? null;
  }

  // =================================================================== waves

  async insertWave(
    tx: Db,
    input: { warehouseInternalId: bigint; waveNo: string; strategy: string; priority: number; plannedBy: bigint | null },
  ): Promise<PickWaveRow> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.pick_waves
        (public_id, warehouse_id, wave_no, strategy, status, priority, planned_by)
      values (gen_random_uuid(), ${input.warehouseInternalId}, ${input.waveNo}, ${input.strategy},
              'planned', ${input.priority}, ${input.plannedBy})
      returning id::text as id
    `;
    return (await this.findWaveById(tx, BigInt(rows[0]?.id ?? '0'))) as PickWaveRow;
  }

  private async findWaveById(tx: Db, internalId: bigint): Promise<PickWaveRow | null> {
    const rows = await tx<PickWaveRow[]>`
      select pw.id::text as "internalId", pw.public_id as id, pw.wave_no as "waveNo",
             w.public_id as "warehouseId", pw.warehouse_id::text as "warehouseInternalId",
             pw.strategy, pw.status, pw.priority, pw.created_at::text as "createdAt",
             pw.started_at::text as "startedAt", pw.completed_at::text as "completedAt"
      from erp.pick_waves pw
      join erp.warehouses w on w.id = pw.warehouse_id
      where pw.id = ${internalId}
    `;
    return rows[0] ?? null;
  }

  async findWave(tx: Db, orgId: bigint, publicId: string): Promise<PickWaveRow | null> {
    const rows = await tx<PickWaveRow[]>`
      select pw.id::text as "internalId", pw.public_id as id, pw.wave_no as "waveNo",
             w.public_id as "warehouseId", pw.warehouse_id::text as "warehouseInternalId",
             pw.strategy, pw.status, pw.priority, pw.created_at::text as "createdAt",
             pw.started_at::text as "startedAt", pw.completed_at::text as "completedAt"
      from erp.pick_waves pw
      join erp.warehouses w on w.id = pw.warehouse_id
      where w.organization_id = ${orgId} and pw.public_id = ${publicId}
    `;
    return rows[0] ?? null;
  }

  async insertWaveOrder(tx: Db, waveInternalId: bigint, orderInternalId: bigint, sequenceNo: number): Promise<void> {
    await tx`
      insert into erp.wave_orders (wave_id, sales_order_id, sequence_no)
      values (${waveInternalId}, ${orderInternalId}, ${sequenceNo})
      on conflict (wave_id, sales_order_id) do nothing
    `;
  }

  async insertPickTask(
    tx: Db,
    input: {
      waveInternalId: bigint;
      orderInternalId: bigint;
      variantInternalId: bigint;
      locationInternalId: bigint;
      quantityRequired: string;
      sequenceNo: number;
    },
  ): Promise<PickTaskRow> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.pick_tasks
        (public_id, wave_id, order_id, product_variant_id, location_id, quantity_required, sequence_no, status)
      values (gen_random_uuid(), ${input.waveInternalId}, ${input.orderInternalId},
              ${input.variantInternalId}, ${input.locationInternalId}, ${input.quantityRequired}::numeric,
              ${input.sequenceNo}, 'pending')
      returning id::text as id
    `;
    return (await this.findPickTaskById(tx, BigInt(rows[0]?.id ?? '0'))) as PickTaskRow;
  }

  private async findPickTaskById(tx: Db, internalId: bigint): Promise<PickTaskRow | null> {
    // Left joins keep a task visible even when its location/order row was
    // removed or soft-deleted; a station must never hide work silently.
    const rows = await tx<PickTaskRow[]>`
      select t.id::text as "internalId", t.public_id as id, t.wave_id::text as "waveInternalId",
             pw.public_id as "waveId", coalesce(o.public_id::text, '') as "orderId",
             o.order_no as "orderNo", t.order_id::text as "orderInternalId",
             coalesce(v.public_id::text, '') as "variantId", t.product_variant_id::text as "variantInternalId",
             coalesce(l.public_id::text, '') as "locationId", coalesce(t.location_id::text, '') as "locationInternalId",
             coalesce(l.full_code, '') as "locationFullCode", coalesce(l.pick_priority, 0) as "pickPriority",
             t.quantity_required::text as "quantityRequired", t.quantity_picked::text as "quantityPicked",
             t.sequence_no as "sequenceNo", t.status, t.assigned_to::text as "assignedTo",
             au.full_name as "assignedToName",
             v.barcode, coalesce(sol.sku_snapshot, v.sku) as sku,
             coalesce(nullif(sol.title_snapshot, 'کالای نامشخص کانال'), p.name, sol.title_snapshot) as title,
             t.created_at::text as "createdAt",
             floor(extract(epoch from (now() - t.created_at)) / 60)::int as "ageMinutes"
      from erp.pick_tasks t
      left join erp.warehouse_locations l on l.id = t.location_id
      left join erp.product_variants v on v.id = t.product_variant_id
      left join erp.products p on p.id = v.product_id
      left join erp.sales_order_lines sol on sol.id = t.sales_order_line_id
      left join erp.sales_orders o on o.id = t.order_id
      left join erp.users au on au.id = t.assigned_to
      left join erp.pick_waves pw on pw.id = t.wave_id
      where t.id = ${internalId}
    `;
    return rows[0] ?? null;
  }

  // Tasks are scoped through their sales order: channel orders are materialised
  // without a pick wave, so the wave→warehouse path alone would miss them.
  async findPickTask(tx: Db, orgId: bigint, publicId: string): Promise<PickTaskRow | null> {
    const rows = await tx<{ id: string }[]>`
      select t.id::text as id from erp.pick_tasks t
      join erp.sales_orders o on o.id = t.order_id
      where o.organization_id = ${orgId} and t.public_id = ${publicId}
    `;
    const row = rows[0];
    return row === undefined ? null : this.findPickTaskById(tx, BigInt(row.id));
  }

  async lockPickTask(tx: Db, orgId: bigint, publicId: string): Promise<PickTaskRow | null> {
    const rows = await tx<{ id: string }[]>`
      select t.id::text as id from erp.pick_tasks t
      join erp.sales_orders o on o.id = t.order_id
      where o.organization_id = ${orgId} and t.public_id = ${publicId}
      for update of t
    `;
    const row = rows[0];
    return row === undefined ? null : this.findPickTaskById(tx, BigInt(row.id));
  }

  /** Open tasks assigned to one picker, with the fields the picking station shows. */
  async listMyPickTasks(
    tx: Db,
    params: { orgId: bigint; assignedTo: bigint; warehouseIds?: readonly string[] | null; limit: number },
  ): Promise<MyPickTaskRow[]> {
    return tx<MyPickTaskRow[]>`
      select t.public_id as id, t.status, o.order_no as "orderNo",
             ch.code as "channelCode",
             coalesce(sol.sku_snapshot, v.sku) as sku,
             coalesce(nullif(sol.title_snapshot, 'کالای نامشخص کانال'), p.name, sol.title_snapshot) as title,
             coalesce(nullif(sol.title_snapshot, 'کالای نامشخص کانال'), p.name, sol.title_snapshot) as "productName",
             coalesce(sol.sku_snapshot, v.sku) as "variantSku",
             coalesce(v.image_url, p.image_url, sol.image_url) as "imageUrl",
             t.quantity_required::text as quantity,
             t.quantity_required::text as "quantityRequired",
             t.quantity_picked::text as "quantityPicked",
             l.full_code as "locationCode", t.sequence_no as "sequenceNo",
             au.public_id as "assignedTo", au.full_name as "assignedToName",
             t.created_at::text as "createdAt",
             floor(extract(epoch from (now() - t.created_at)) / 60)::int as "ageMinutes"
      from erp.pick_tasks t
      join erp.sales_orders o on o.id = t.order_id
      join erp.product_variants v on v.id = t.product_variant_id
      join erp.products p on p.id = v.product_id
      join erp.warehouse_locations l on l.id = t.location_id
      left join erp.sales_order_lines sol on sol.id = t.sales_order_line_id
      left join erp.channel_accounts ca on ca.id = o.channel_account_id
      left join erp.sales_channels ch on ch.id = ca.channel_id
      left join erp.users au on au.id = t.assigned_to
      where o.organization_id = ${params.orgId}
        and t.assigned_to = ${params.assignedTo}
        and t.status in ('pending', 'in_progress')
        and (${params.warehouseIds ?? null}::bigint[] is null or l.warehouse_id = any(${params.warehouseIds ?? null}::bigint[]))
      order by l.pick_priority asc, l.full_code asc, t.sequence_no asc
      limit ${params.limit}
    `;
  }

  /**
   * Barcodes that identify a pick task's item: the variant barcode, its active
   * `product_barcodes` rows and the sales-order-line SKU snapshot (which is the
   * SKU the channel actually shipped). Used by the station scan endpoint.
   */
  async findPickTaskBarcodes(tx: Db, taskInternalId: bigint): Promise<PickTaskBarcodeRow | null> {
    const rows = await tx<PickTaskBarcodeRow[]>`
      select v.barcode as "variantBarcode",
             coalesce(sol.sku_snapshot, v.sku) as sku,
             (select array_agg(b.barcode order by b.is_primary desc, b.created_at asc)
                from erp.product_barcodes b
               where b.product_variant_id = t.product_variant_id
                 and b.is_active
                 and b.deleted_at is null) as barcodes
      from erp.pick_tasks t
      left join erp.product_variants v on v.id = t.product_variant_id
      left join erp.sales_order_lines sol on sol.id = t.sales_order_line_id
      where t.id = ${taskInternalId}
    `;
    return rows[0] ?? null;
  }

  async findActiveUserId(tx: Db, orgId: bigint, publicId: string): Promise<bigint | null> {
    const rows = await tx<{ id: string }[]>`
      select id::text as id from erp.users
      where organization_id = ${orgId} and public_id = ${publicId}
        and deleted_at is null and status = 'active'
      limit 1
    `;
    return rows[0] === undefined ? null : BigInt(rows[0].id);
  }

  /** Manual reassignment; `assignedTo: null` releases the task back to the pool. */
  async assignPickTask(
    tx: Db,
    orgId: bigint,
    publicId: string,
    assignedTo: bigint | null,
  ): Promise<PickTaskRow | null> {
    const rows = await tx<{ id: string }[]>`
      update erp.pick_tasks t
      set assigned_to = ${assignedTo}
      from erp.sales_orders o
      where o.id = t.order_id and o.organization_id = ${orgId} and t.public_id = ${publicId}
      returning t.id::text as id
    `;
    const row = rows[0];
    return row === undefined ? null : this.findPickTaskById(tx, BigInt(row.id));
  }

  // ---------------------------------------------------- channel-order dispatch

  /**
   * Warehouse to pick an order from. Channel orders are materialised without a
   * header warehouse, so fall back to the line's warehouse and finally to the
   * organization's first active warehouse — otherwise no pick task is ever
   * created for those orders.
   */
  async findOrderWarehouse(tx: Db, orgId: bigint, orderInternalId: bigint): Promise<string | null> {
    const rows = await tx<{ warehouseInternalId: string | null }[]>`
      select coalesce(
        o.warehouse_id,
        (select l.warehouse_id from erp.sales_order_lines l
          where l.order_id = o.id and l.warehouse_id is not null
          order by l.line_no asc limit 1),
        (select w.id from erp.warehouses w
          where w.organization_id = o.organization_id
            and w.deleted_at is null and w.is_active
          order by w.id asc limit 1)
      )::text as "warehouseInternalId"
      from erp.sales_orders o
      where o.id = ${orderInternalId} and o.organization_id = ${orgId}
    `;
    return rows[0]?.warehouseInternalId ?? null;
  }

  /** Order lines without a pick task yet — the insert is the idempotency gate. */
  async listUnpickedOrderLines(tx: Db, orderInternalId: bigint): Promise<PickQueueLineRow[]> {
    return tx<PickQueueLineRow[]>`
      select l.id::text as id, l.product_variant_id::text as "variantInternalId", l.quantity::text as quantity
      from erp.sales_order_lines l
      where l.order_id = ${orderInternalId}
        and l.quantity > 0
        and not exists (select 1 from erp.pick_tasks t where t.sales_order_line_id = l.id)
      order by l.line_no asc
    `;
  }

  /** Active users holding the execute permission (`warehouse.pick`). */
  async listActivePickers(tx: Db, orgId: bigint): Promise<PickerRow[]> {
    return tx<PickerRow[]>`
      select u.id::text as id,
             (select count(*) from erp.pick_tasks t
               where t.assigned_to = u.id and t.status in ('pending', 'in_progress'))::int as "openTasks"
      from erp.users u
      where u.organization_id = ${orgId}
        and u.status = 'active'
        and u.deleted_at is null
        and exists (
          select 1 from erp.user_roles ur
          join erp.roles r on r.id = ur.role_id and r.deleted_at is null
          join erp.role_permissions rp on rp.role_id = ur.role_id
          join erp.permissions p on p.id = rp.permission_id
          where ur.user_id = u.id
            and p.key = 'warehouse.pick'
            and (ur.expires_at is null or ur.expires_at > now())
        )
      order by u.id asc
    `;
  }

  /**
   * Safety net when nobody holds `warehouse.pick`: active users with a warehouse
   * or admin role (including the seeded `warehouse_manager` /
   * `warehouse_operator` codes). The board must never be unusable just because
   * the execute permission was not granted yet.
   */
  async listFallbackPickers(tx: Db, orgId: bigint): Promise<PickerRow[]> {
    return tx<PickerRow[]>`
      select u.id::text as id,
             (select count(*) from erp.pick_tasks t
               where t.assigned_to = u.id and t.status in ('pending', 'in_progress'))::int as "openTasks"
      from erp.users u
      where u.organization_id = ${orgId}
        and u.status = 'active'
        and u.deleted_at is null
        and exists (
          select 1 from erp.user_roles ur
          join erp.roles r on r.id = ur.role_id and r.deleted_at is null
          where ur.user_id = u.id
            and r.code in ('warehouse', 'warehouse_manager', 'warehouse_operator', 'admin')
            and (ur.expires_at is null or ur.expires_at > now())
        )
      order by u.id asc
    `;
  }

  /** Stocked location for the variant, else any pick face in the warehouse. */
  async findPickLocationForVariant(
    tx: Db,
    warehouseInternalId: string,
    variantInternalId: string,
  ): Promise<string | null> {
    const rows = await tx<{ id: string | null }[]>`
      select coalesce(
        (select b.location_id
           from erp.inventory_balances b
           join erp.warehouse_locations l on l.id = b.location_id
          where b.warehouse_id = ${warehouseInternalId}::bigint
            and b.product_variant_id = ${variantInternalId}::bigint
            and (b.on_hand - b.reserved - b.safety_buffer - b.damaged) > 0
            and l.is_pickable and l.is_active and l.deleted_at is null
          order by l.pick_priority asc, l.full_code asc, b.id asc
          limit 1),
        (select l.id
           from erp.warehouse_locations l
          where l.warehouse_id = ${warehouseInternalId}::bigint
            and l.is_pickable and l.is_active and l.deleted_at is null
          order by l.pick_priority asc, l.full_code asc
          limit 1)
      )::text as id
    `;
    return rows[0]?.id ?? null;
  }

  async insertOrderPickTask(
    tx: Db,
    input: {
      orderInternalId: bigint;
      lineInternalId: string;
      variantInternalId: string;
      locationInternalId: string;
      quantity: string;
      sequenceNo: number;
      assignedTo: bigint | null;
    },
  ): Promise<void> {
    await tx`
      insert into erp.pick_tasks
        (public_id, order_id, sales_order_line_id, product_variant_id, location_id,
         quantity_required, sequence_no, status, assigned_to)
      values (gen_random_uuid(), ${input.orderInternalId}, ${input.lineInternalId}::bigint,
              ${input.variantInternalId}::bigint, ${input.locationInternalId}::bigint,
              ${input.quantity}::numeric, ${input.sequenceNo}, 'pending', ${input.assignedTo})
    `;
  }

  async listPickTasks(
    tx: Db,
    params: { orgId: bigint; waveInternalId: bigint | null; status: string | null; assignedTo: bigint | null; warehouseIds?: readonly string[] | null; limit: number },
  ): Promise<PickTaskRow[]> {
    const rows = await tx<{ id: string }[]>`
      select t.id::text as id
      from erp.pick_tasks t
      left join erp.pick_waves pw on pw.id = t.wave_id
      left join erp.warehouses w on w.id = pw.warehouse_id
      left join erp.sales_orders o on o.id = t.order_id
      left join erp.warehouse_locations l on l.id = t.location_id
      where (
          (${params.waveInternalId}::bigint is not null and t.wave_id = ${params.waveInternalId}::bigint)
          or (${params.waveInternalId}::bigint is null and coalesce(o.organization_id, w.organization_id) = ${params.orgId})
        )
        and (${params.status}::text is null or t.status = ${params.status})
        and (${params.assignedTo}::bigint is null or t.assigned_to = ${params.assignedTo}::bigint)
        and (${params.warehouseIds ?? null}::bigint[] is null
             or coalesce(l.warehouse_id, o.warehouse_id) = any(${params.warehouseIds ?? null}::bigint[]))
      order by l.pick_priority asc, l.full_code asc, t.sequence_no asc
      limit ${params.limit}
    `;
    const tasks: PickTaskRow[] = [];
    for (const row of rows) {
      const task = await this.findPickTaskById(tx, BigInt(row.id));
      if (task !== null) tasks.push(task);
    }
    return tasks;
  }

  async updatePickTask(
    tx: Db,
    internalId: bigint,
    patch: {
      status: string;
      quantityPicked?: string;
      assignedTo?: bigint | null;
      started?: boolean;
      completed?: boolean;
    },
  ): Promise<PickTaskRow> {
    await tx`
      update erp.pick_tasks
      set status = ${patch.status},
          quantity_picked = coalesce(${patch.quantityPicked ?? null}::numeric, quantity_picked),
          assigned_to = coalesce(${patch.assignedTo ?? null}, assigned_to),
          started_at = case when ${patch.started === true}::boolean then coalesce(started_at, now()) else started_at end,
          completed_at = case when ${patch.completed === true}::boolean then now() else completed_at end
      where id = ${internalId}
    `;
    return (await this.findPickTaskById(tx, internalId)) as PickTaskRow;
  }

  // ------------------------------------------------------- pick station board

  /**
   * Every open pick task of the organization, newest order first, with the
   * assignee, location and quantities the picking station renders. Scoping goes
   * through the sales order so channel orders without a wave are included.
   */
  async listPickBoard(tx: Db, params: { orgId: bigint; warehouseIds?: readonly string[] | null; limit: number }): Promise<PickBoardTaskRow[]> {
    return tx<PickBoardTaskRow[]>`
      select t.public_id as id, t.order_id::text as "orderInternalId",
             coalesce(o.public_id::text, '') as "orderId", o.order_no as "orderNo",
             ch.code as "channelCode",
             coalesce(o.status, 'unknown') as "orderStatus",
             coalesce(o.fulfillment_status, 'unfulfilled') as "fulfillmentStatus",
             pw.public_id as "waveId", pw.wave_no as "waveNo",
             coalesce(sol.sku_snapshot, v.sku) as sku,
             coalesce(nullif(sol.title_snapshot, 'کالای نامشخص کانال'), p.name, sol.title_snapshot) as title,
             coalesce(nullif(sol.title_snapshot, 'کالای نامشخص کانال'), p.name, sol.title_snapshot) as "productName",
             coalesce(sol.sku_snapshot, v.sku) as "variantSku",
             coalesce(v.image_url, p.image_url, sol.image_url) as "imageUrl",
             t.quantity_required::text as "quantityRequired",
             t.quantity_picked::text as "quantityPicked",
             l.full_code as "locationCode", t.sequence_no as "sequenceNo", t.status,
             t.assigned_to::text as "assignedTo", au.full_name as "assignedToName",
             t.created_at::text as "createdAt",
             floor(extract(epoch from (now() - t.created_at)) / 60)::int as "ageMinutes"
      from erp.pick_tasks t
      join erp.sales_orders o on o.id = t.order_id
      left join erp.pick_waves pw on pw.id = t.wave_id
      left join erp.sales_order_lines sol on sol.id = t.sales_order_line_id
      left join erp.product_variants v on v.id = t.product_variant_id
      left join erp.products p on p.id = v.product_id
      left join erp.warehouse_locations l on l.id = t.location_id
      left join erp.channel_accounts ca on ca.id = o.channel_account_id
      left join erp.sales_channels ch on ch.id = ca.channel_id
      left join erp.users au on au.id = t.assigned_to
      where o.organization_id = ${params.orgId}
        and t.status in ('pending', 'in_progress')
        and (${params.warehouseIds ?? null}::bigint[] is null
             or coalesce(l.warehouse_id, o.warehouse_id) = any(${params.warehouseIds ?? null}::bigint[]))
      order by t.created_at asc, o.order_no asc, t.sequence_no asc
      limit ${params.limit}
    `;
  }

  /** Counters behind the empty state of the picking board. */
  async pickBoardDiagnostics(tx: Db, params: { orgId: bigint }): Promise<PickBoardDiagnosticsRow> {
    const rows = await tx<PickBoardDiagnosticsRow[]>`
      select
        (select count(*) from erp.pick_tasks t
           join erp.sales_orders o on o.id = t.order_id
          where o.organization_id = ${params.orgId})::int as "tasksTotal",
        (select count(*) from erp.pick_tasks t
           join erp.sales_orders o on o.id = t.order_id
          where o.organization_id = ${params.orgId} and t.status in ('pending', 'in_progress'))::int as "openTasks",
        (select count(*) from erp.sales_orders o
          where o.organization_id = ${params.orgId})::int as "ordersTotal",
        (select count(*) from erp.sales_orders o
          where o.organization_id = ${params.orgId}
            and exists (select 1 from erp.sales_order_lines l where l.order_id = o.id))::int as "ordersWithLines",
        (select count(*) from erp.sales_orders o
          where o.organization_id = ${params.orgId}
            and not exists (select 1 from erp.sales_order_lines l where l.order_id = o.id))::int as "ordersWithoutLines",
        (select count(*) from erp.sales_orders o
          where o.organization_id = ${params.orgId}
            and o.status not in ('cancelled', 'closed', 'delivered')
            and exists (select 1 from erp.sales_order_lines l where l.order_id = o.id)
            and not exists (select 1 from erp.pick_tasks t where t.order_id = o.id))::int as "ordersWithoutTasks",
        (select count(*) from erp.sales_orders o
          where o.organization_id = ${params.orgId}
            and o.warehouse_id is null
            and exists (select 1 from erp.sales_order_lines l where l.order_id = o.id)
            and not exists (
              select 1 from erp.sales_order_lines l
               where l.order_id = o.id and l.warehouse_id is not null
            ))::int as "ordersWithoutWarehouse",
        (select count(*) from erp.warehouses w
          where w.organization_id = ${params.orgId}
            and w.deleted_at is null and w.is_active)::int as "warehouses",
        (select count(*) from erp.users u
          where u.organization_id = ${params.orgId}
            and u.status = 'active' and u.deleted_at is null
            and exists (
              select 1 from erp.user_roles ur
              join erp.roles r on r.id = ur.role_id and r.deleted_at is null
              join erp.role_permissions rp on rp.role_id = ur.role_id
              join erp.permissions p on p.id = rp.permission_id
              where ur.user_id = u.id and p.key = 'warehouse.pick'
                and (ur.expires_at is null or ur.expires_at > now())
            ))::int as "activePickers",
        (select count(*) from erp.users u
          where u.organization_id = ${params.orgId}
            and u.status = 'active' and u.deleted_at is null
            and exists (
              select 1 from erp.user_roles ur
              join erp.roles r on r.id = ur.role_id and r.deleted_at is null
              where ur.user_id = u.id and r.code in ('warehouse', 'warehouse_manager', 'warehouse_operator', 'admin')
                and (ur.expires_at is null or ur.expires_at > now())
            ))::int as "fallbackPickers"
    `;
    const row = rows[0];
    if (row === undefined) {
      return {
        tasksTotal: 0,
        openTasks: 0,
        ordersTotal: 0,
        ordersWithLines: 0,
        ordersWithoutLines: 0,
        ordersWithoutTasks: 0,
        ordersWithoutWarehouse: 0,
        warehouses: 0,
        activePickers: 0,
        fallbackPickers: 0,
      };
    }
    return row;
  }

  /** Orders with lines but no pick task at all — the station's backfill queue. */
  async listOrdersAwaitingPickTasks(
    tx: Db,
    params: { orgId: bigint; limit: number },
  ): Promise<PickBackfillCandidateRow[]> {
    return tx<PickBackfillCandidateRow[]>`
      select o.id::text as "internalId", o.public_id as "orderId", o.order_no as "orderNo"
      from erp.sales_orders o
      where o.organization_id = ${params.orgId}
        and o.status not in ('cancelled', 'closed', 'delivered')
        and exists (select 1 from erp.sales_order_lines l where l.order_id = o.id)
        and not exists (select 1 from erp.pick_tasks t where t.order_id = o.id)
      order by o.id asc
      limit ${params.limit}
    `;
  }

  /** Open pick tasks left on an order; `0` means the order is fully picked. */
  async countOpenOrderPickTasks(tx: Db, orderInternalId: bigint): Promise<number> {
    const rows = await tx<{ count: number }[]>`
      select count(*)::int as count
      from erp.pick_tasks t
      where t.order_id = ${orderInternalId}
        and t.status in ('pending', 'in_progress')
    `;
    return rows[0]?.count ?? 0;
  }

  async setOrderFulfillmentStatus(
    tx: Db,
    orgId: bigint,
    orderInternalId: bigint,
    fulfillmentStatus: string,
  ): Promise<void> {
    await tx`
      update erp.sales_orders
      set fulfillment_status = ${fulfillmentStatus}, updated_at = now()
      where id = ${orderInternalId} and organization_id = ${orgId}
    `;
  }

  /** Channel account + external order id, for the best-effort ready-to-ship push. */
  async findOrderChannelRef(tx: Db, orgId: bigint, orderInternalId: bigint): Promise<OrderChannelRefRow | null> {
    const rows = await tx<OrderChannelRefRow[]>`
      select o.external_order_id as "externalOrderId", a.public_id as "accountPublicId"
      from erp.sales_orders o
      left join erp.channel_accounts a on a.id = o.channel_account_id
      where o.id = ${orderInternalId} and o.organization_id = ${orgId}
    `;
    return rows[0] ?? null;
  }

  // ------------------------------------------------------------- pack tasks

  private async findPackTaskById(tx: Db, internalId: bigint): Promise<PackTaskRow | null> {
    const rows = await tx<PackTaskRow[]>`
      select pt.id::text as "internalId", pt.public_id as id, pt.order_id::text as "orderInternalId",
             coalesce(o.public_id::text, '') as "orderId", o.order_no as "orderNo",
             ch.code as "channelCode",
             coalesce(o.fulfillment_status, 'unfulfilled') as "fulfillmentStatus",
             pt.package_no as "packageNo", pt.status,
             pt.assigned_to::text as "assignedTo", au.full_name as "assignedToName",
             pt.notes, pt.created_at::text as "createdAt", pt.updated_at::text as "updatedAt",
             pt.closed_at::text as "closedAt",
             (select count(*) from erp.sales_order_lines l where l.order_id = pt.order_id)::int as "itemCount",
             coalesce((select sum(l.quantity) from erp.sales_order_lines l where l.order_id = pt.order_id), 0)::text as "totalQuantity",
             o.shipping_address_json as address,
             c.full_name as "customerName",
             coalesce(c.mobile, o.shipping_address_json ->> 'receiverMobile') as "customerPhone",
             -- Every line of the order travels in the same package; the packing
             -- card shows the whole order, not a subset.
             coalesce((
               select json_agg(json_build_object(
                        'name', coalesce(nullif(l.title_snapshot, 'کالای نامشخص کانال'), p.name, l.title_snapshot),
                        'sku', coalesce(l.sku_snapshot, v.sku),
                        'qty', l.quantity::text,
                        'imageUrl', coalesce(v.image_url, p.image_url, l.image_url)
                      ) order by l.line_no)
                 from erp.sales_order_lines l
                 left join erp.product_variants v on v.id = l.product_variant_id
                 left join erp.products p on p.id = v.product_id
                where l.order_id = pt.order_id
             ), '[]'::json) as items,
             floor(extract(epoch from (now() - pt.created_at)) / 60)::int as "ageMinutes"
      from erp.pack_tasks pt
      left join erp.sales_orders o on o.id = pt.order_id
      left join erp.customers c on c.id = o.customer_id
      left join erp.channel_accounts ca on ca.id = o.channel_account_id
      left join erp.sales_channels ch on ch.id = ca.channel_id
      left join erp.users au on au.id = pt.assigned_to
      where pt.id = ${internalId}
    `;
    return rows[0] ?? null;
  }

  async listPackBoard(tx: Db, params: { orgId: bigint; warehouseIds?: readonly string[] | null; limit: number }): Promise<PackTaskRow[]> {
    const rows = await tx<{ id: string }[]>`
      select pt.id::text as id
      from erp.pack_tasks pt
      join erp.sales_orders o on o.id = pt.order_id
      where pt.organization_id = ${params.orgId}
        and pt.status in ('pending', 'packing')
        and (${params.warehouseIds ?? null}::bigint[] is null
             or o.warehouse_id = any(${params.warehouseIds ?? null}::bigint[]))
      order by pt.created_at asc
      limit ${params.limit}
    `;
    const tasks: PackTaskRow[] = [];
    for (const row of rows) {
      const task = await this.findPackTaskById(tx, BigInt(row.id));
      if (task !== null) tasks.push(task);
    }
    return tasks;
  }

  async lockPackTask(tx: Db, orgId: bigint, publicId: string): Promise<PackTaskRow | null> {
    const rows = await tx<{ id: string }[]>`
      select pt.id::text as id from erp.pack_tasks pt
      where pt.organization_id = ${orgId} and pt.public_id = ${publicId}
      for update of pt
    `;
    const row = rows[0];
    return row === undefined ? null : this.findPackTaskById(tx, BigInt(row.id));
  }

  async findOpenPackTaskForOrder(tx: Db, orgId: bigint, orderInternalId: bigint): Promise<PackTaskRow | null> {
    const rows = await tx<{ id: string }[]>`
      select pt.id::text as id from erp.pack_tasks pt
      where pt.organization_id = ${orgId} and pt.order_id = ${orderInternalId}
        and pt.status in ('pending', 'packing')
      order by pt.created_at asc
      limit 1
    `;
    const row = rows[0];
    return row === undefined ? null : this.findPackTaskById(tx, BigInt(row.id));
  }

  /** Idempotent: one open pack task per order; returns the existing one if any. */
  async insertPackTask(
    tx: Db,
    input: {
      orgId: bigint;
      orderInternalId: bigint;
      packageNo: string;
      assignedTo: bigint | null;
      notes: string | null;
    },
  ): Promise<PackTaskRow | null> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.pack_tasks
        (public_id, organization_id, order_id, package_no, status, assigned_to, notes)
      select gen_random_uuid(), ${input.orgId}::bigint, ${input.orderInternalId}::bigint,
             ${input.packageNo}::text, 'pending', ${input.assignedTo}::bigint, ${input.notes}::text
      where not exists (
        select 1 from erp.pack_tasks pt
        where pt.organization_id = ${input.orgId} and pt.order_id = ${input.orderInternalId}
          and pt.status in ('pending', 'packing')
      )
      returning id::text as id
    `;
    const row = rows[0];
    if (row !== undefined) return this.findPackTaskById(tx, BigInt(row.id));
    return this.findOpenPackTaskForOrder(tx, input.orgId, input.orderInternalId);
  }

  async updatePackTask(
    tx: Db,
    internalId: bigint,
    patch: {
      status: string;
      packageNo?: string;
      assignedTo?: bigint;
      notes?: string;
      closed?: boolean;
    },
  ): Promise<PackTaskRow> {
    await tx`
      update erp.pack_tasks
      set status = ${patch.status},
          package_no = coalesce(${patch.packageNo ?? null}, package_no),
          assigned_to = coalesce(${patch.assignedTo ?? null}, assigned_to),
          notes = coalesce(${patch.notes ?? null}, notes),
          closed_at = case when ${patch.closed === true}::boolean then now() else closed_at end,
          updated_at = now()
      where id = ${internalId}
    `;
    return (await this.findPackTaskById(tx, internalId)) as PackTaskRow;
  }

  /** `assignedTo: null` releases the task back to the packing pool. */
  async assignPackTask(
    tx: Db,
    orgId: bigint,
    publicId: string,
    assignedTo: bigint | null,
  ): Promise<PackTaskRow | null> {
    const rows = await tx<{ id: string }[]>`
      update erp.pack_tasks pt
      set assigned_to = ${assignedTo}, updated_at = now()
      where pt.organization_id = ${orgId} and pt.public_id = ${publicId}
      returning pt.id::text as id
    `;
    const row = rows[0];
    return row === undefined ? null : this.findPackTaskById(tx, BigInt(row.id));
  }

  async countPackTasksForOrder(tx: Db, orgId: bigint, orderInternalId: bigint): Promise<number> {
    const rows = await tx<{ count: number }[]>`
      select count(*)::int as count from erp.pack_tasks pt
      where pt.organization_id = ${orgId} and pt.order_id = ${orderInternalId}
    `;
    return rows[0]?.count ?? 0;
  }

  /** Counters behind the packing board's empty state; requires `pack_tasks` to exist. */
  async packBoardDiagnostics(tx: Db, params: { orgId: bigint }): Promise<PackBoardDiagnosticsRow> {
    const rows = await tx<PackBoardDiagnosticsRow[]>`
      select
        (select count(*) from erp.pack_tasks pt where pt.organization_id = ${params.orgId})::int as "tasksTotal",
        (select count(*) from erp.pack_tasks pt where pt.organization_id = ${params.orgId} and pt.status = 'pending')::int as pending,
        (select count(*) from erp.pack_tasks pt where pt.organization_id = ${params.orgId} and pt.status = 'packing')::int as packing,
        (select count(*) from erp.pack_tasks pt where pt.organization_id = ${params.orgId} and pt.status = 'packed')::int as packed,
        (select count(*) from erp.sales_orders o
          where o.organization_id = ${params.orgId} and o.fulfillment_status = 'picked')::int as "pickedOrders",
        (select count(*) from erp.sales_orders o
          where o.organization_id = ${params.orgId} and o.fulfillment_status = 'picked'
            and not exists (
              select 1 from erp.pack_tasks pt
              where pt.order_id = o.id and pt.status in ('pending', 'packing')
            ))::int as "pickedOrdersWithoutPackTask",
        (select count(*) from erp.pick_tasks t
          join erp.sales_orders o on o.id = t.order_id
          where o.organization_id = ${params.orgId} and t.status = 'picked')::int as "pickedTasks"
    `;
    const row = rows[0];
    if (row === undefined) {
      return {
        tasksTotal: 0,
        pending: 0,
        packing: 0,
        packed: 0,
        pickedOrders: 0,
        pickedOrdersWithoutPackTask: 0,
        pickedTasks: 0,
      };
    }
    return row;
  }

  async updateWaveStatus(
    tx: Db,
    internalId: bigint,
    patch: { status: string; started?: boolean; completed?: boolean },
  ): Promise<void> {
    await tx`
      update erp.pick_waves
      set status = ${patch.status},
          started_at = case when ${patch.started === true}::boolean then coalesce(started_at, now()) else started_at end,
          completed_at = case when ${patch.completed === true}::boolean then now() else completed_at end
      where id = ${internalId}
    `;
  }

  async listWaveOrders(tx: Db, waveInternalId: bigint): Promise<{ orderId: string }[]> {
    return tx`
      select o.public_id as "orderId"
      from erp.wave_orders wo
      join erp.sales_orders o on o.id = wo.sales_order_id
      where wo.wave_id = ${waveInternalId}
      order by wo.sequence_no asc
    `;
  }

  async insertPickScan(
    tx: Db,
    input: {
      taskInternalId: bigint;
      barcode: string;
      expectedBarcode: string | null;
      variantInternalId: bigint | null;
      quantity: string;
      result: string;
      scannedBy: bigint;
      scanSource: string;
      clientScanId: string | null;
    },
  ): Promise<void> {
    await tx`
      insert into erp.pick_scans
        (pick_task_id, barcode, expected_barcode, product_variant_id, quantity, result,
         scanned_by, scan_source, client_scan_id)
      values (${input.taskInternalId}, ${input.barcode}, ${input.expectedBarcode},
              ${input.variantInternalId}, ${input.quantity}::numeric, ${input.result},
              ${input.scannedBy}, ${input.scanSource}, ${input.clientScanId})
    `;
  }

  async listWaves(tx: Db, params: { orgId: bigint; status: string | null; warehouseInternalId: bigint | null; limit: number }) {
    return tx<PickWaveRow[]>`
      select pw.id::text as "internalId", pw.public_id as id, pw.wave_no as "waveNo",
             w.public_id as "warehouseId", pw.warehouse_id::text as "warehouseInternalId",
             pw.strategy, pw.status, pw.priority, pw.created_at::text as "createdAt",
             pw.started_at::text as "startedAt", pw.completed_at::text as "completedAt"
      from erp.pick_waves pw
      join erp.warehouses w on w.id = pw.warehouse_id
      where w.organization_id = ${params.orgId}
        and (${params.status}::text is null or pw.status = ${params.status})
        and (${params.warehouseInternalId}::bigint is null or pw.warehouse_id = ${params.warehouseInternalId}::bigint)
      order by pw.created_at desc
      limit ${params.limit}
    `;
  }

  async resolveWarehouseId(tx: Db, orgId: bigint, publicId: string): Promise<bigint | null> {
    const rows = await tx<{ id: string }[]>`
      select id::text as id from erp.warehouses
      where organization_id = ${orgId} and public_id = ${publicId} and deleted_at is null limit 1
    `;
    return rows[0] === undefined ? null : BigInt(rows[0].id);
  }

  async allocateWaveNo(tx: Db, orgId: bigint): Promise<string> {
    const rows = await tx<{ total: string }[]>`
      select count(*)::text as total from erp.pick_waves pw
      join erp.warehouses w on w.id = pw.warehouse_id
      where w.organization_id = ${orgId}
    `;
    return `WAV-${(Number(rows[0]?.total ?? '0') + 1).toString().padStart(6, '0')}`;
  }

  // ---------------------------------------------------------- global barcode

  /** Variant resolved by SKU, primary barcode or any active `product_barcodes`. */
  async scanLookupProduct(tx: Db, orgId: bigint, code: string): Promise<ScanLookupRow | null> {
    const rows = await tx<
      {
        id: string;
        productId: string;
        name: string | null;
        variantTitle: string | null;
        sku: string | null;
        imageUrl: string | null;
        barcode: string | null;
      }[]
    >`
      select v.public_id as id, p.public_id as "productId",
             p.name, v.title as "variantTitle", v.sku, v.barcode,
             coalesce(v.image_url, p.image_url) as "imageUrl"
      from erp.product_variants v
      join erp.products p on p.id = v.product_id
      where p.organization_id = ${orgId}
        and p.deleted_at is null and v.deleted_at is null
        and (
          lower(v.sku) = lower(${code})
          or lower(coalesce(v.barcode, '')) = lower(${code})
          or exists (
            select 1 from erp.product_barcodes b
            where b.product_variant_id = v.id
              and b.is_active and b.deleted_at is null
              and lower(b.barcode) = lower(${code})
          )
        )
      order by v.is_default desc, v.sort_order asc, v.id asc
      limit 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const subtitle = [row.variantTitle, row.sku === null ? null : `SKU ${row.sku}`, row.barcode]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .join(' · ');
    return {
      kind: 'product',
      id: row.id,
      title: row.name ?? row.variantTitle ?? row.sku ?? code,
      subtitle: subtitle.length > 0 ? subtitle : null,
      imageUrl: row.imageUrl,
      url: `/products/${row.productId}`,
    };
  }

  /** Warehouse location by its barcode or human `full_code`. */
  async scanLookupLocation(tx: Db, orgId: bigint, code: string): Promise<ScanLookupRow | null> {
    const rows = await tx<
      { id: string; fullCode: string; warehouseId: string; warehouseName: string; warehouseCode: string }[]
    >`
      select l.public_id as id, l.full_code as "fullCode",
             w.public_id as "warehouseId", w.name as "warehouseName", w.code as "warehouseCode"
      from erp.warehouse_locations l
      join erp.warehouses w on w.id = l.warehouse_id
      where w.organization_id = ${orgId}
        and w.deleted_at is null and l.deleted_at is null
        and (
          lower(l.full_code) = lower(${code})
          or lower(coalesce(l.barcode, '')) = lower(${code})
        )
      order by l.is_pickable desc, l.full_code asc
      limit 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      kind: 'location',
      id: row.id,
      title: row.fullCode,
      subtitle: `انبار ${row.warehouseName} (${row.warehouseCode})`,
      imageUrl: null,
      url: `/warehouses/${row.warehouseId}/locations?code=${encodeURIComponent(row.fullCode)}`,
    };
  }

  /** Sales order by its human order number. */
  async scanLookupOrder(tx: Db, orgId: bigint, code: string): Promise<ScanLookupRow | null> {
    const rows = await tx<{ id: string; orderNo: string; customerName: string | null; status: string }[]>`
      select o.public_id as id, o.order_no as "orderNo",
             coalesce(c.full_name, o.shipping_address_json ->> 'receiverName') as "customerName",
             o.status
      from erp.sales_orders o
      left join erp.customers c on c.id = o.customer_id
      where o.organization_id = ${orgId} and lower(o.order_no) = lower(${code})
      order by o.created_at desc
      limit 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      kind: 'order',
      id: row.id,
      title: row.orderNo,
      subtitle: [row.customerName, row.status].filter((part): part is string => typeof part === 'string').join(' · ') || null,
      imageUrl: null,
      url: `/orders/${row.id}`,
    };
  }

  /** Pick task by its public id (the code printed on a task sheet). */
  async scanLookupTask(tx: Db, orgId: bigint, publicId: string): Promise<ScanLookupRow | null> {
    const rows = await tx<
      { id: string; orderNo: string | null; sku: string | null; locationCode: string | null; imageUrl: string | null }[]
    >`
      select t.public_id as id, o.order_no as "orderNo",
             coalesce(sol.sku_snapshot, v.sku) as sku,
             l.full_code as "locationCode",
             coalesce(v.image_url, p.image_url) as "imageUrl"
      from erp.pick_tasks t
      join erp.sales_orders o on o.id = t.order_id
      left join erp.sales_order_lines sol on sol.id = t.sales_order_line_id
      left join erp.product_variants v on v.id = t.product_variant_id
      left join erp.products p on p.id = v.product_id
      left join erp.warehouse_locations l on l.id = t.location_id
      where o.organization_id = ${orgId} and t.public_id = ${publicId}::uuid
      limit 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      kind: 'task',
      id: row.id,
      title: `وظیفه برداشت ${row.orderNo ?? ''}`.trim(),
      subtitle: [row.sku, row.locationCode].filter((part): part is string => part !== null).join(' · ') || null,
      imageUrl: row.imageUrl,
      url: `/picking?task=${row.id}`,
    };
  }
}
