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
  barcode: string | null;
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

  async listWarehouses(tx: Db, params: { orgId: bigint; status: boolean | null; branchInternalId: BigIntish | null; search: string | null; limit: number; offset: number }) {
    const pattern = params.search === null ? null : `%${params.search}%`;
    return tx<WarehouseRow[]>`
      select ${warehouseColumns(tx)} ${warehouseFrom(tx)}
      where w.organization_id = ${params.orgId} and w.deleted_at is null
        and (${params.status}::boolean is null or w.is_active = ${params.status}::boolean)
        and (${pattern}::text is null or w.name ilike ${pattern} or w.code ilike ${pattern})
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
             null::text as "parentId", z.abc_class as "abcClass", null::text as "capacityQuantity",
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
    const rows = await tx<PickTaskRow[]>`
      select t.id::text as "internalId", t.public_id as id, t.wave_id::text as "waveInternalId",
             pw.public_id as "waveId", o.public_id as "orderId", t.order_id::text as "orderInternalId",
             v.public_id as "variantId", t.product_variant_id::text as "variantInternalId",
             l.public_id as "locationId", t.location_id::text as "locationInternalId",
             l.full_code as "locationFullCode", l.pick_priority as "pickPriority",
             t.quantity_required::text as "quantityRequired", t.quantity_picked::text as "quantityPicked",
             t.sequence_no as "sequenceNo", t.status, t.assigned_to::text as "assignedTo",
             v.barcode
      from erp.pick_tasks t
      join erp.warehouse_locations l on l.id = t.location_id
      join erp.product_variants v on v.id = t.product_variant_id
      join erp.sales_orders o on o.id = t.order_id
      left join erp.pick_waves pw on pw.id = t.wave_id
      where t.id = ${internalId}
    `;
    return rows[0] ?? null;
  }

  async findPickTask(tx: Db, orgId: bigint, publicId: string): Promise<PickTaskRow | null> {
    const rows = await tx<{ id: string }[]>`
      select t.id::text as id from erp.pick_tasks t
      join erp.warehouses w on w.id = (select warehouse_id from erp.pick_waves where id = t.wave_id)
      where w.organization_id = ${orgId} and t.public_id = ${publicId}
    `;
    const row = rows[0];
    return row === undefined ? null : this.findPickTaskById(tx, BigInt(row.id));
  }

  async lockPickTask(tx: Db, orgId: bigint, publicId: string): Promise<PickTaskRow | null> {
    const rows = await tx<{ id: string }[]>`
      select t.id::text as id from erp.pick_tasks t
      join erp.pick_waves pw on pw.id = t.wave_id
      join erp.warehouses w on w.id = pw.warehouse_id
      where w.organization_id = ${orgId} and t.public_id = ${publicId}
      for update of t
    `;
    const row = rows[0];
    return row === undefined ? null : this.findPickTaskById(tx, BigInt(row.id));
  }

  async listPickTasks(
    tx: Db,
    params: { orgId: bigint; waveInternalId: bigint | null; status: string | null; assignedTo: bigint | null; limit: number },
  ): Promise<PickTaskRow[]> {
    const rows = await tx<{ id: string }[]>`
      select t.id::text as id
      from erp.pick_tasks t
      left join erp.pick_waves pw on pw.id = t.wave_id
      left join erp.warehouses w on w.id = pw.warehouse_id
      left join erp.warehouse_locations l on l.id = t.location_id
      where (
          (${params.waveInternalId}::bigint is not null and t.wave_id = ${params.waveInternalId}::bigint)
          or (${params.waveInternalId}::bigint is null and w.organization_id = ${params.orgId})
        )
        and (${params.status}::text is null or t.status = ${params.status})
        and (${params.assignedTo}::bigint is null or t.assigned_to = ${params.assignedTo}::bigint)
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
}
