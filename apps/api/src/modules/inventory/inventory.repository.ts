/**
 * Inventory SQL (`DATA-MODEL` §2.6, §2.17 inventory additions).
 *
 * The ledger + balance projection are one unit of work: the service locks balance
 * rows in a fixed order, inserts ledger rows, then updates balances in the same
 * transaction (`ADR-0007` §2). Read queries join the owning catalog/warehouse
 * tables only to surface **public ids** for the response; writes never reach
 * outside the inventory tables except via `InventoryService` callers.
 */
import type { Db } from './inventory.pg-support';

export interface BalanceRow {
  readonly productName?: string | null;
  readonly warehouseName?: string | null;
  readonly locationCode?: string | null;
  internalId: string;
  id: string;
  warehouseId: string;
  warehouseInternalId: string;
  locationId: string;
  locationInternalId: string;
  variantId: string;
  variantInternalId: string;
  sku: string;
  productId: string;
  onHand: string;
  reserved: string;
  safetyBuffer: string;
  damaged: string;
  inTransit: string;
  lastTransactionId: string | null;
  lastCountedAt: string | null;
  version: number;
  updatedAt: string;
}

export interface LedgerRow {
  readonly sku?: string | null;
  readonly productName?: string | null;
  readonly warehouseName?: string | null;
  readonly locationCode?: string | null;
  internalId: string;
  id: string;
  warehouseId: string;
  locationId: string;
  variantId: string;
  transactionType: string;
  quantity: string;
  unitCostAmount: string | null;
  totalCostAmount: string | null;
  currency: string;
  lotId: string | null;
  referenceType: string;
  referenceId: string | null;
  referencePublicId: string | null;
  reversalOfId: string | null;
  idempotencyKey: string | null;
  businessDate: string;
  periodId: string | null;
  journalEntryId: string | null;
  costState: string;
  createdAt: string;
  createdBy: string | null;
}

export interface ReservationRow {
  internalId: string;
  id: string;
  reservationNo: string;
  warehouseId: string;
  warehouseInternalId: string;
  locationId: string;
  locationInternalId: string;
  variantId: string;
  variantInternalId: string;
  quantity: string;
  consumedQuantity: string;
  releasedQuantity: string;
  consumedTransactionId: string | null;
  referenceType: string;
  referenceId: string | null;
  referencePublicId: string | null;
  status: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface LayerRow {
  internalId: string;
  id: string;
  warehouseInternalId: string;
  variantInternalId: string;
  lotInternalId: string | null;
  receivedAt: string;
  originalQuantity: string;
  quantityRemaining: string;
  unitCostAmount: string;
  costRemainingAmount: string;
  currency: string;
  sourceKind: string;
  isClosed: boolean;
}

export interface AverageCostRow {
  internalId: string;
  warehouseInternalId: string;
  variantInternalId: string;
  quantityOnHand: string;
  avgCostAmount: string;
  totalValueAmount: string;
}

export interface AdjustmentRow {
  internalId: string;
  id: string;
  adjustmentNo: string;
  warehouseId: string;
  warehouseInternalId: string;
  reasonCode: string;
  status: string;
  description: string | null;
  requiresApproval: boolean;
  approvalRequestId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  appliedAt: string | null;
  journalEntryId: string | null;
  version: number;
  createdAt: string;
  createdBy: string | null;
}

export interface AdjustmentLineRow {
  internalId: string;
  id: string;
  variantId: string;
  variantInternalId: string;
  locationId: string;
  locationInternalId: string;
  lotId: string | null;
  systemQuantity: string;
  countedQuantity: string;
  differenceQuantity: string;
  unitCostAmount: string;
  inventoryTransactionId: string | null;
}

export interface TransferRow {
  internalId: string;
  id: string;
  transferNo: string;
  fromWarehouseId: string;
  fromWarehouseInternalId: string;
  toWarehouseId: string;
  toWarehouseInternalId: string;
  status: string;
  requestedBy: string | null;
  approvedBy: string | null;
  dispatchedAt: string | null;
  receivedAt: string | null;
  carrier: string | null;
  notes: string | null;
  version: number;
  createdAt: string;
}

export interface TransferLineRow {
  internalId: string;
  id: string;
  variantId: string;
  variantInternalId: string;
  lotId: string | null;
  quantity: string;
  dispatchedQuantity: string;
  receivedQuantity: string;
  fromLocationId: string | null;
  fromLocationInternalId: string | null;
  toLocationId: string | null;
  toLocationInternalId: string | null;
  unitCostAmount: string;
}

export interface CountRow {
  internalId: string;
  id: string;
  countNo: string;
  warehouseId: string;
  warehouseInternalId: string;
  countType: string;
  status: string;
  zoneId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  countedBy: string | null;
  approvedBy: string | null;
  adjustmentId: string | null;
  version: number;
  createdAt: string;
}

export interface CountLineRow {
  internalId: string;
  id: string;
  locationId: string;
  locationInternalId: string;
  variantId: string;
  variantInternalId: string;
  lotId: string | null;
  expectedQuantity: string;
  countedQuantity: string | null;
  varianceQuantity: string | null;
  countedAt: string | null;
  notes: string | null;
}

export interface LotRow {
  internalId: string;
  id: string;
  variantId: string;
  variantInternalId: string;
  warehouseId: string;
  lotNo: string;
  batchBarcode: string | null;
  manufactureDate: string | null;
  expiryDate: string | null;
  supplierId: string | null;
  status: string;
}

export interface ValuationRunRow {
  internalId: string;
  id: string;
  warehouseId: string | null;
  valuationMethod: string;
  valuationDate: string;
  costLayerCount: number;
  glInventoryAmount: string;
  status: string;
  totalQuantity: string;
  totalValueAmount: string;
  journalEntryId: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface ValuationLineRow {
  variantId: string;
  variantInternalId: string;
  warehouseId: string;
  quantity: string;
  unitCostAmount: string;
  totalValueAmount: string;
  layerBreakdown: unknown;
}

function balanceColumns(tx: Db) {
  return tx`
    b.id::text as "internalId",
    b.public_id as id,
    w.public_id as "warehouseId",
    b.warehouse_id::text as "warehouseInternalId",
    l.public_id as "locationId",
    b.location_id::text as "locationInternalId",
    v.public_id as "variantId",
    b.product_variant_id::text as "variantInternalId",
    v.sku,
    p.public_id as "productId",
    b.on_hand::text as "onHand",
    b.reserved::text as "reserved",
    b.safety_buffer::text as "safetyBuffer",
    b.damaged::text as "damaged",
    b.in_transit::text as "inTransit",
    b.last_transaction_id::text as "lastTransactionId",
    b.last_counted_at::text as "lastCountedAt",
    b.version,
    b.updated_at::text as "updatedAt"
  `;
}

function balanceFrom(tx: Db) {
  return tx`
    from erp.inventory_balances b
    join erp.warehouses w on w.id = b.warehouse_id
    join erp.warehouse_locations l on l.id = b.location_id
    join erp.product_variants v on v.id = b.product_variant_id
    join erp.products p on p.id = v.product_id
  `;
}

function ledgerColumns(tx: Db) {
  return tx`
    t.id::text as "internalId",
    t.public_id as id,
    w.public_id as "warehouseId",
    l.public_id as "locationId",
    v.public_id as "variantId",
    t.transaction_type as "transactionType",
    t.quantity::text as quantity,
    t.unit_cost_amount::text as "unitCostAmount",
    t.total_cost_amount::text as "totalCostAmount",
    t.currency,
    lt.public_id as "lotId",
    t.reference_type as "referenceType",
    t.reference_id::text as "referenceId",
    t.reference_public_id::text as "referencePublicId",
    t.reversal_of_id::text as "reversalOfId",
    t.idempotency_key as "idempotencyKey",
    t.business_date::text as "businessDate",
    t.period_id::text as "periodId",
    t.journal_entry_id::text as "journalEntryId",
    t.cost_state as "costState",
    t.created_at::text as "createdAt",
    t.created_by::text as "createdBy"
  `;
}

function ledgerFrom(tx: Db) {
  return tx`
    from erp.inventory_transactions t
    join erp.warehouses w on w.id = t.warehouse_id
    join erp.warehouse_locations l on l.id = t.location_id
    join erp.product_variants v on v.id = t.product_variant_id
    left join erp.inventory_lots lt on lt.id = t.lot_id
  `;
}

function reservationColumns(tx: Db) {
  return tx`
    r.id::text as "internalId",
    r.public_id as id,
    r.reservation_no as "reservationNo",
    w.public_id as "warehouseId",
    r.warehouse_id::text as "warehouseInternalId",
    l.public_id as "locationId",
    r.location_id::text as "locationInternalId",
    v.public_id as "variantId",
    r.product_variant_id::text as "variantInternalId",
    r.quantity::text as quantity,
    coalesce(r.consumed_qty, 0)::text as "consumedQuantity",
    coalesce(r.released_qty, 0)::text as "releasedQuantity",
    r.consumed_transaction_id::text as "consumedTransactionId",
    r.reference_type as "referenceType",
    r.reference_id::text as "referenceId",
    null::text as "referencePublicId",
    r.status,
    r.expires_at::text as "expiresAt",
    r.created_at::text as "createdAt"
  `;
}

function reservationFrom(tx: Db) {
  return tx`
    from erp.stock_reservations r
    join erp.warehouses w on w.id = r.warehouse_id
    join erp.warehouse_locations l on l.id = r.location_id
    join erp.product_variants v on v.id = r.product_variant_id
  `;
}

function layerColumns(tx: Db) {
  return tx`
    cl.id::text as "internalId",
    cl.public_id as id,
    cl.warehouse_id::text as "warehouseInternalId",
    cl.product_variant_id::text as "variantInternalId",
    cl.lot_id::text as "lotInternalId",
    cl.received_at::text as "receivedAt",
    cl.original_qty::text as "originalQuantity",
    cl.qty_remaining::text as "quantityRemaining",
    cl.unit_cost_amount::text as "unitCostAmount",
    cl.cost_remaining_amount::text as "costRemainingAmount",
    cl.currency,
    cl.source_kind as "sourceKind",
    cl.is_closed as "isClosed"
  `;
}

/** One mapped channel listing of a variant (stock workspace chips). */
export interface StockChannelAccount {
  accountId: string;
  channelCode: string;
  channelName: string;
  externalProductId: string | null;
  externalVariantId: string | null;
}

/** A mapped channel listing plus the internal account id used to queue a push. */
export interface StockChannelTarget extends StockChannelAccount {
  accountInternalId: string;
}

/** Aggregated variant row of `GET /inventory/stock`. */
export interface StockRow {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  onHand: string;
  reserved: string;
  channels: StockChannelAccount[];
}

export interface StockHistoryRow {
  id: string;
  type: string;
  quantity: string;
  unitCostAmount: string | null;
  totalCostAmount: string | null;
  warehouseId: string;
  locationId: string;
  referenceType: string;
  referenceId: string | null;
  businessDate: string;
  createdAt: string;
}

interface LedgerInsert {
  readonly orgId: bigint;
  readonly warehouseInternalId: bigint;
  readonly locationInternalId: bigint;
  readonly variantInternalId: bigint;
  readonly type: string;
  readonly quantity: string;
  readonly unitCostAmount: bigint | null;
  readonly totalCostAmount: bigint | null;
  readonly lotInternalId: bigint | null;
  readonly serialInternalId: bigint | null;
  readonly unitInternalId: bigint | null;
  readonly referenceType: string;
  readonly referenceInternalId: bigint | null;
  readonly referencePublicId: string | null;
  readonly reversalOfInternalId: bigint | null;
  readonly idempotencyKey: string | null;
  readonly businessDate: string;
  readonly periodInternalId: bigint | null;
  readonly costState: string;
  readonly createdBy: bigint | null;
}

export class InventoryRepository {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- balances

  async listBalances(
    tx: Db,
    params: {
      orgId: bigint;
      warehouseInternalId: bigint | null;
      variantInternalId: bigint | null;
      productInternalId: bigint | null;
      locationInternalId: bigint | null;
      includeZero: boolean;
      safetyBufferBelow: string | null;
      updatedAtGte: string | null;
      limit: number;
      cursor: { createdAt: string; id: string } | null;
    },
  ): Promise<BalanceRow[]> {
    return tx<BalanceRow[]>`
      select ${balanceColumns(tx)}
      ${balanceFrom(tx)}
      where b.organization_id = ${params.orgId}
        and (${params.warehouseInternalId}::bigint is null or b.warehouse_id = ${params.warehouseInternalId}::bigint)
        and (${params.variantInternalId}::bigint is null or b.product_variant_id = ${params.variantInternalId}::bigint)
        and (${params.productInternalId}::bigint is null or v.product_id = ${params.productInternalId}::bigint)
        and (${params.locationInternalId}::bigint is null or b.location_id = ${params.locationInternalId}::bigint)
        and (${params.includeZero}::boolean or b.on_hand > 0)
        and (${params.safetyBufferBelow}::numeric is null or b.safety_buffer < ${params.safetyBufferBelow}::numeric)
        and (${params.updatedAtGte}::timestamptz is null or b.updated_at >= ${params.updatedAtGte}::timestamptz)
        and (${params.cursor?.createdAt ?? null}::timestamptz is null
             or (b.updated_at, b.public_id) > (${params.cursor?.createdAt ?? null}::timestamptz, ${params.cursor?.id ?? null}::uuid))
      order by b.updated_at asc, b.public_id asc
      limit ${params.limit}
    `;
  }

  async findBalance(tx: Db, orgId: bigint, publicId: string): Promise<BalanceRow | null> {
    const rows = await tx<BalanceRow[]>`
      select ${balanceColumns(tx)} ${balanceFrom(tx)}
      where b.organization_id = ${orgId} and b.public_id = ${publicId}
      limit 1
    `;
    return rows[0] ?? null;
  }

  /** Ensures a balance row exists for every `(warehouse, location, variant)` key. */
  async ensureBalances(
    tx: Db,
    orgId: bigint,
    keys: readonly { warehouseInternalId: bigint; locationInternalId: bigint; variantInternalId: bigint }[],
  ): Promise<void> {
    for (const key of keys) {
      await tx`
        insert into erp.inventory_balances
          (organization_id, warehouse_id, location_id, product_variant_id, public_id)
        values (${orgId}, ${key.warehouseInternalId}, ${key.locationInternalId},
                ${key.variantInternalId}, gen_random_uuid())
        on conflict (warehouse_id, location_id, product_variant_id) do nothing
      `;
    }
  }

  /**
   * Locks balance rows in the **fixed order** required by `ADR-0007` §3:
   * variant ascending, then warehouse, then location. Never lock ledger rows.
   */
  async lockBalances(
    tx: Db,
    orgId: bigint,
    keys: readonly { warehouseInternalId: bigint; locationInternalId: bigint; variantInternalId: bigint }[],
  ): Promise<BalanceRow[]> {
    if (keys.length === 0) return [];
    const unique = new Map<string, { warehouseInternalId: bigint; locationInternalId: bigint; variantInternalId: bigint }>();
    for (const key of keys) {
      unique.set(`${key.variantInternalId}:${key.warehouseInternalId}:${key.locationInternalId}`, key);
    }
    const ordered = [...unique.values()].sort((left, right) => {
      if (left.variantInternalId !== right.variantInternalId) {
        return left.variantInternalId < right.variantInternalId ? -1 : 1;
      }
      if (left.warehouseInternalId !== right.warehouseInternalId) {
        return left.warehouseInternalId < right.warehouseInternalId ? -1 : 1;
      }
      return left.locationInternalId < right.locationInternalId ? -1 : 1;
    });
    const rows: BalanceRow[] = [];
    for (const key of ordered) {
      const locked = await tx<BalanceRow[]>`
        select ${balanceColumns(tx)} ${balanceFrom(tx)}
        where b.organization_id = ${orgId}
          and b.warehouse_id = ${key.warehouseInternalId}
          and b.location_id = ${key.locationInternalId}
          and b.product_variant_id = ${key.variantInternalId}
        for update of b
      `;
      const row = locked[0];
      if (row !== undefined) rows.push(row);
    }
    return rows;
  }

  async updateBalance(
    tx: Db,
    internalId: bigint,
    patch: {
      onHand: string;
      reserved: string;
      damaged: string;
      inTransit: string;
      lastTransactionInternalId: bigint | null;
    },
  ): Promise<void> {
    await tx`
      update erp.inventory_balances
      set on_hand = ${patch.onHand}::numeric,
          reserved = ${patch.reserved}::numeric,
          damaged = ${patch.damaged}::numeric,
          in_transit = ${patch.inTransit}::numeric,
          last_transaction_id = ${patch.lastTransactionInternalId},
          updated_at = now(),
          version = version + 1
      where id = ${internalId}
    `;
  }

  async setLastCounted(tx: Db, internalId: bigint, countedAt: string): Promise<void> {
    await tx`
      update erp.inventory_balances
      set last_counted_at = ${countedAt}::timestamptz, updated_at = now(), version = version + 1
      where id = ${internalId}
    `;
  }

  /**
   * Availability candidates for allocation: `on_hand − reserved − safety_buffer − damaged`
   * per balance key, optionally narrowed to warehouses (`ADR-0007` §4).
   */
  async availabilityCandidates(
    tx: Db,
    orgId: bigint,
    params: { variantInternalIds: readonly bigint[]; warehouseInternalIds: readonly bigint[] | null },
  ): Promise<{ warehouseInternalId: string; locationInternalId: string; variantInternalId: string; available: string }[]> {
    if (params.variantInternalIds.length === 0) return [];
    return tx`
      select b.warehouse_id::text as "warehouseInternalId",
             b.location_id::text as "locationInternalId",
             b.product_variant_id::text as "variantInternalId",
             (b.on_hand - b.reserved - b.safety_buffer - b.damaged)::text as available
      from erp.inventory_balances b
      where b.organization_id = ${orgId}
        and b.product_variant_id = any(${params.variantInternalIds.map((v) => v.toString())}::bigint[])
        and (${params.warehouseInternalIds === null}::boolean
             or b.warehouse_id = any(${(params.warehouseInternalIds ?? []).map((v) => v.toString())}::bigint[]))
        and (b.on_hand - b.reserved - b.safety_buffer - b.damaged) > 0
      order by b.product_variant_id asc, b.warehouse_id asc, b.location_id asc
    `;
  }

  /** Live availability for a single balance key (after locking). */
  async availableForKeys(
    tx: Db,
    orgId: bigint,
    keys: readonly { warehouseInternalId: bigint; locationInternalId: bigint; variantInternalId: bigint }[],
  ): Promise<{ warehouseInternalId: string; locationInternalId: string; variantInternalId: string; available: string }[]> {
    const result: {
      warehouseInternalId: string;
      locationInternalId: string;
      variantInternalId: string;
      available: string;
    }[] = [];
    for (const key of keys) {
      const rows = await tx<{ available: string }[]>`
        select (on_hand - reserved - safety_buffer - damaged)::text as available
        from erp.inventory_balances
        where organization_id = ${orgId} and warehouse_id = ${key.warehouseInternalId}
          and location_id = ${key.locationInternalId} and product_variant_id = ${key.variantInternalId}
      `;
      const available = rows[0]?.available;
      if (available !== undefined) {
        result.push({
          warehouseInternalId: key.warehouseInternalId.toString(),
          locationInternalId: key.locationInternalId.toString(),
          variantInternalId: key.variantInternalId.toString(),
          available,
        });
      }
    }
    return result;
  }

  /** All balance rows of a warehouse (count scope seeding). */
  async balancesForScope(
    tx: Db,
    orgId: bigint,
    params: {
      warehouseInternalId: bigint;
      locationInternalIds: readonly bigint[] | null;
      variantInternalIds: readonly bigint[] | null;
    },
  ): Promise<
    { locationInternalId: string; variantInternalId: string; onHand: string }[]
  > {
    return tx`
      select location_id::text as "locationInternalId",
             product_variant_id::text as "variantInternalId",
             on_hand::text as "onHand"
      from erp.inventory_balances
      where organization_id = ${orgId} and warehouse_id = ${params.warehouseInternalId} and on_hand > 0
        and (${params.locationInternalIds === null}::boolean
             or location_id = any(${(params.locationInternalIds ?? []).map((v) => v.toString())}::bigint[]))
        and (${params.variantInternalIds === null}::boolean
             or product_variant_id = any(${(params.variantInternalIds ?? []).map((v) => v.toString())}::bigint[]))
      order by location_id asc, product_variant_id asc
    `;
  }

  /** Read-only resolution of warehouse public id (owned by `warehouse` module). */
  async resolveWarehouseId(tx: Db, orgId: bigint, publicId: string): Promise<bigint | null> {
    const rows = await tx<{ id: string }[]>`
      select id::text as id from erp.warehouses
      where organization_id = ${orgId} and public_id = ${publicId} and deleted_at is null limit 1
    `;
    return rows[0] === undefined ? null : BigInt(rows[0].id);
  }

  /** Read-only resolution of location public id (owned by `warehouse` module). */
  async resolveLocationId(tx: Db, orgId: bigint, publicId: string): Promise<bigint | null> {
    const rows = await tx<{ id: string }[]>`
      select l.id::text as id from erp.warehouse_locations l
      join erp.warehouses w on w.id = l.warehouse_id
      where w.organization_id = ${orgId} and l.public_id = ${publicId} and l.is_active limit 1
    `;
    return rows[0] === undefined ? null : BigInt(rows[0].id);
  }

  /** First active location of a warehouse (default for location-less adjustments). */
  async resolveFirstActiveLocationId(tx: Db, orgId: bigint, warehouseInternalId: bigint): Promise<bigint | null> {
    const rows = await tx<{ id: string }[]>`
      select l.id::text as id from erp.warehouse_locations l
      join erp.warehouses w on w.id = l.warehouse_id
      where w.organization_id = ${orgId} and l.warehouse_id = ${warehouseInternalId}
        and l.is_active and w.deleted_at is null
      order by l.pick_priority asc, l.full_code asc
      limit 1
    `;
    return rows[0] === undefined ? null : BigInt(rows[0].id);
  }

  /** Public ids for warehouse/location internals (event payloads). */
  async publicIds(
    tx: Db,
    warehouseInternalId: bigint,
    locationInternalId: bigint,
    variantInternalId: bigint,
  ): Promise<{ warehouseId: string; locationId: string; variantId: string }> {
    const rows = await tx<{ warehouseId: string; locationId: string; variantId: string }[]>`
      select w.public_id as "warehouseId", l.public_id as "locationId", v.public_id as "variantId"
      from erp.warehouses w
      cross join erp.warehouse_locations l
      cross join erp.product_variants v
      where w.id = ${warehouseInternalId} and l.id = ${locationInternalId} and v.id = ${variantInternalId}
    `;
    return rows[0] as { warehouseId: string; locationId: string; variantId: string };
  }

  /** Public ids for a warehouse/location pair (inbound document placement). */
  async placementPublicIds(
    tx: Db,
    warehouseInternalId: bigint,
    locationInternalId: bigint,
  ): Promise<{ warehouseId: string; locationId: string } | null> {
    const rows = await tx<{ warehouseId: string; locationId: string }[]>`
      select w.public_id as "warehouseId", l.public_id as "locationId"
      from erp.warehouses w
      join erp.warehouse_locations l on l.id = ${locationInternalId}
      where w.id = ${warehouseInternalId}
      limit 1
    `;
    return rows[0] ?? null;
  }

  // ------------------------------------------------------------------ ledger

  async insertTransaction(tx: Db, input: LedgerInsert): Promise<LedgerRow> {
    const rows = await tx<{ id: string; created_at: string }[]>`
      insert into erp.inventory_transactions (
        organization_id, public_id, warehouse_id, location_id, product_variant_id,
        transaction_type, quantity, unit_cost_amount, total_cost_amount, currency,
        lot_id, serial_id, inventory_unit_id, reference_type, reference_id, reference_public_id,
        reversal_of_id, idempotency_key, business_date, period_id, cost_state, created_by
      ) values (
        ${input.orgId}, gen_random_uuid(), ${input.warehouseInternalId}, ${input.locationInternalId},
        ${input.variantInternalId}, ${input.type}, ${input.quantity}::numeric,
        ${input.unitCostAmount}, ${input.totalCostAmount}, 'IRR',
        ${input.lotInternalId}, ${input.serialInternalId}, ${input.unitInternalId},
        ${input.referenceType}, ${input.referenceInternalId}, ${input.referencePublicId},
        ${input.reversalOfInternalId}, ${input.idempotencyKey}, ${input.businessDate}::date,
        ${input.periodInternalId}, ${input.costState}, ${input.createdBy}
      )
      returning id::text as id, created_at::text as created_at
    `;
    const created = rows[0];
    if (created === undefined) throw new Error('ledger_insert_failed');
    // Global idempotency dedupe table (non-partitioned, `R1-D B-07`).
    if (input.idempotencyKey !== null) {
      await tx`
        insert into erp.inventory_ledger_keys
          (idempotency_key, organization_id, inventory_transaction_id, transaction_created_at)
        values (${input.idempotencyKey}, ${input.orgId}, ${created.id}::bigint, ${created.created_at}::timestamptz)
        on conflict (idempotency_key) do nothing
      `;
    }
    const full = await tx<LedgerRow[]>`
      select ${ledgerColumns(tx)} ${ledgerFrom(tx)} where t.id = ${created.id}::bigint limit 1
    `;
    return full[0] as LedgerRow;
  }

  async findTransaction(tx: Db, orgId: bigint, publicId: string): Promise<LedgerRow | null> {
    const rows = await tx<LedgerRow[]>`
      select ${ledgerColumns(tx)} ${ledgerFrom(tx)}
      where t.organization_id = ${orgId} and t.public_id = ${publicId}
      limit 1
    `;
    return rows[0] ?? null;
  }

  async findTransactionByIdempotencyKey(
    tx: Db,
    orgId: bigint,
    idempotencyKey: string,
  ): Promise<LedgerRow | null> {
    const rows = await tx<LedgerRow[]>`
      select ${ledgerColumns(tx)} ${ledgerFrom(tx)}
      where t.organization_id = ${orgId} and t.idempotency_key = ${idempotencyKey}
      limit 1
    `;
    return rows[0] ?? null;
  }

  async listTransactions(
    tx: Db,
    params: {
      orgId: bigint;
      warehouseInternalId: bigint | null;
      variantInternalId: bigint | null;
      type: string | null;
      referenceType: string | null;
      referenceInternalId: bigint | null;
      createdFrom: string;
      createdTo: string;
      limit: number;
    },
  ): Promise<LedgerRow[]> {
    return tx<LedgerRow[]>`
      select ${ledgerColumns(tx)} ${ledgerFrom(tx)}
      where t.organization_id = ${params.orgId}
        and t.created_at >= ${params.createdFrom}::timestamptz
        and t.created_at < ${params.createdTo}::timestamptz
        and (${params.warehouseInternalId}::bigint is null or t.warehouse_id = ${params.warehouseInternalId}::bigint)
        and (${params.variantInternalId}::bigint is null or t.product_variant_id = ${params.variantInternalId}::bigint)
        and (${params.type}::text is null or t.transaction_type = ${params.type})
        and (${params.referenceType}::text is null or t.reference_type = ${params.referenceType})
        and (${params.referenceInternalId}::bigint is null or t.reference_id = ${params.referenceInternalId}::bigint)
      order by t.created_at desc, t.id desc
      limit ${params.limit}
    `;
  }

  /** Ledger sums per balance key for the nightly consistency check. */
  async ledgerSums(
    tx: Db,
    orgId: bigint,
    params: { warehouseInternalId: bigint | null; since: string | null },
  ): Promise<{ warehouseId: string; locationId: string; variantId: string; quantitySum: string }[]> {
    return tx<{ warehouseId: string; locationId: string; variantId: string; quantitySum: string }[]>`
      select w.public_id as "warehouseId", l.public_id as "locationId", v.public_id as "variantId",
             sum(t.quantity)::text as "quantitySum"
      from erp.inventory_transactions t
      join erp.warehouses w on w.id = t.warehouse_id
      join erp.warehouse_locations l on l.id = t.location_id
      join erp.product_variants v on v.id = t.product_variant_id
      where t.organization_id = ${orgId}
        and (${params.warehouseInternalId}::bigint is null or t.warehouse_id = ${params.warehouseInternalId}::bigint)
        and (${params.since}::timestamptz is null or t.created_at >= ${params.since}::timestamptz)
      group by w.public_id, l.public_id, v.public_id
    `;
  }

  async balancesForReconciliation(
    tx: Db,
    orgId: bigint,
    warehouseInternalId: bigint | null,
  ): Promise<{ warehouseId: string; locationId: string; variantId: string; onHand: string }[]> {
    return tx<{ warehouseId: string; locationId: string; variantId: string; onHand: string }[]>`
      select w.public_id as "warehouseId", l.public_id as "locationId", v.public_id as "variantId",
             b.on_hand::text as "onHand"
      from erp.inventory_balances b
      join erp.warehouses w on w.id = b.warehouse_id
      join erp.warehouse_locations l on l.id = b.location_id
      join erp.product_variants v on v.id = b.product_variant_id
      where b.organization_id = ${orgId}
        and (${warehouseInternalId}::bigint is null or b.warehouse_id = ${warehouseInternalId}::bigint)
    `;
  }

  // ------------------------------------------------------------- reservations

  async insertReservation(
    tx: Db,
    input: {
      orgId: bigint;
      warehouseInternalId: bigint;
      locationInternalId: bigint;
      variantInternalId: bigint;
      quantity: string;
      referenceType: string;
      referenceInternalId: bigint;
      reservationNo: string;
      expiresAt: string | null;
      createdBy: bigint | null;
    },
  ): Promise<ReservationRow> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.stock_reservations (
        organization_id, public_id, warehouse_id, location_id, product_variant_id, quantity,
        reference_type, reference_id, reservation_no, status, expires_at, created_by,
        consumed_qty, released_qty
      ) values (
        ${input.orgId}, gen_random_uuid(), ${input.warehouseInternalId}, ${input.locationInternalId},
        ${input.variantInternalId}, ${input.quantity}::numeric, ${input.referenceType},
        ${input.referenceInternalId}, ${input.reservationNo}, 'active', ${input.expiresAt}::timestamptz,
        ${input.createdBy}, 0, 0
      )
      returning id::text as id
    `;
    const created = rows[0];
    if (created === undefined) throw new Error('reservation_insert_failed');
    const full = await tx<ReservationRow[]>`
      select ${reservationColumns(tx)} ${reservationFrom(tx)} where r.id = ${created.id}::bigint limit 1
    `;
    return full[0] as ReservationRow;
  }

  async listReservations(
    tx: Db,
    params: {
      orgId: bigint;
      status: string | null;
      variantInternalId: bigint | null;
      warehouseInternalId: bigint | null;
      referenceType: string | null;
      referenceInternalId: bigint | null;
      expiresBefore: string | null;
      limit: number;
    },
  ): Promise<ReservationRow[]> {
    return tx<ReservationRow[]>`
      select ${reservationColumns(tx)} ${reservationFrom(tx)}
      where r.organization_id = ${params.orgId}
        and (${params.status}::text is null or r.status = ${params.status})
        and (${params.variantInternalId}::bigint is null or r.product_variant_id = ${params.variantInternalId}::bigint)
        and (${params.warehouseInternalId}::bigint is null or r.warehouse_id = ${params.warehouseInternalId}::bigint)
        and (${params.referenceType}::text is null or r.reference_type = ${params.referenceType})
        and (${params.referenceInternalId}::bigint is null or r.reference_id = ${params.referenceInternalId}::bigint)
        and (${params.expiresBefore}::timestamptz is null or r.expires_at < ${params.expiresBefore}::timestamptz)
      order by r.created_at desc, r.id desc
      limit ${params.limit}
    `;
  }

  async findReservation(tx: Db, orgId: bigint, publicId: string): Promise<ReservationRow | null> {
    const rows = await tx<ReservationRow[]>`
      select ${reservationColumns(tx)} ${reservationFrom(tx)}
      where r.organization_id = ${orgId} and r.public_id = ${publicId} limit 1
    `;
    return rows[0] ?? null;
  }

  async lockReservations(
    tx: Db,
    orgId: bigint,
    referenceType: string,
    referenceInternalId: bigint,
  ): Promise<ReservationRow[]> {
    return tx<ReservationRow[]>`
      select ${reservationColumns(tx)} ${reservationFrom(tx)}
      where r.organization_id = ${orgId} and r.reference_type = ${referenceType}
        and r.reference_id = ${referenceInternalId} and r.status = 'active'
      order by r.product_variant_id asc, r.warehouse_id asc, r.location_id asc, r.id asc
      for update of r
    `;
  }

  async lockReservationById(tx: Db, orgId: bigint, internalId: bigint): Promise<ReservationRow | null> {
    const rows = await tx<ReservationRow[]>`
      select ${reservationColumns(tx)} ${reservationFrom(tx)}
      where r.organization_id = ${orgId} and r.id = ${internalId}
      for update of r
    `;
    return rows[0] ?? null;
  }

  async updateReservation(
    tx: Db,
    internalId: bigint,
    patch: {
      status: string;
      consumedQuantity: string;
      releasedQuantity: string;
      consumedTransactionInternalId: bigint | null;
      touchConsumedAt: boolean;
      touchReleasedAt: boolean;
    },
  ): Promise<void> {
    await tx`
      update erp.stock_reservations
      set status = ${patch.status},
          consumed_qty = ${patch.consumedQuantity}::numeric,
          released_qty = ${patch.releasedQuantity}::numeric,
          consumed_transaction_id = ${patch.consumedTransactionInternalId},
          consumed_at = case when ${patch.touchConsumedAt}::boolean then now() else consumed_at end,
          released_at = case when ${patch.touchReleasedAt}::boolean then now() else released_at end
      where id = ${internalId}
    `;
  }

  // -------------------------------------------------------------- adjustments

  async insertAdjustment(
    tx: Db,
    input: {
      orgId: bigint;
      warehouseInternalId: bigint;
      adjustmentNo: string;
      reasonCode: string;
      description: string | null;
      requiresApproval: boolean;
      createdBy: bigint | null;
    },
  ): Promise<AdjustmentRow> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.stock_adjustments
        (organization_id, public_id, warehouse_id, adjustment_no, reason_code, status,
         description, requires_approval, created_by)
      values (${input.orgId}, gen_random_uuid(), ${input.warehouseInternalId}, ${input.adjustmentNo},
              ${input.reasonCode}, 'draft', ${input.description}, ${input.requiresApproval}, ${input.createdBy})
      returning id::text as id
    `;
    const created = rows[0];
    if (created === undefined) throw new Error('adjustment_insert_failed');
    const full = await tx<AdjustmentRow[]>`
      select a.id::text as "internalId", a.public_id as id, a.adjustment_no as "adjustmentNo",
             w.public_id as "warehouseId", a.warehouse_id::text as "warehouseInternalId",
             a.reason_code as "reasonCode", a.status, a.description,
             a.requires_approval as "requiresApproval",
             a.approval_request_id::text as "approvalRequestId",
             a.approved_by::text as "approvedBy", a.approved_at::text as "approvedAt",
             a.applied_at::text as "appliedAt", a.journal_entry_id::text as "journalEntryId",
             a.version, a.created_at::text as "createdAt", a.created_by::text as "createdBy"
      from erp.stock_adjustments a
      join erp.warehouses w on w.id = a.warehouse_id
      where a.id = ${created.id}::bigint
    `;
    return full[0] as AdjustmentRow;
  }

  async listAdjustments(
    tx: Db,
    params: { orgId: bigint; status: string | null; type: string | null; warehouseInternalId: bigint | null; limit: number; offset: number },
  ): Promise<AdjustmentRow[]> {
    return tx<AdjustmentRow[]>`
      select a.id::text as "internalId", a.public_id as id, a.adjustment_no as "adjustmentNo",
             w.public_id as "warehouseId", a.warehouse_id::text as "warehouseInternalId",
             a.reason_code as "reasonCode", a.status, a.description,
             a.requires_approval as "requiresApproval",
             a.approval_request_id::text as "approvalRequestId",
             a.approved_by::text as "approvedBy", a.approved_at::text as "approvedAt",
             a.applied_at::text as "appliedAt", a.journal_entry_id::text as "journalEntryId",
             a.version, a.created_at::text as "createdAt", a.created_by::text as "createdBy"
      from erp.stock_adjustments a
      join erp.warehouses w on w.id = a.warehouse_id
      where a.organization_id = ${params.orgId}
        and (${params.status}::text is null or a.status = ${params.status})
        and (${params.type}::text is null or a.reason_code = ${params.type})
        and (${params.warehouseInternalId}::bigint is null or a.warehouse_id = ${params.warehouseInternalId}::bigint)
      order by a.created_at desc
      limit ${params.limit} offset ${params.offset}
    `;
  }

  async findAdjustment(tx: Db, orgId: bigint, publicId: string): Promise<AdjustmentRow | null> {
    const rows = await tx<AdjustmentRow[]>`
      select a.id::text as "internalId", a.public_id as id, a.adjustment_no as "adjustmentNo",
             w.public_id as "warehouseId", a.warehouse_id::text as "warehouseInternalId",
             a.reason_code as "reasonCode", a.status, a.description,
             a.requires_approval as "requiresApproval",
             a.approval_request_id::text as "approvalRequestId",
             a.approved_by::text as "approvedBy", a.approved_at::text as "approvedAt",
             a.applied_at::text as "appliedAt", a.journal_entry_id::text as "journalEntryId",
             a.version, a.created_at::text as "createdAt", a.created_by::text as "createdBy"
      from erp.stock_adjustments a
      join erp.warehouses w on w.id = a.warehouse_id
      where a.organization_id = ${orgId} and a.public_id = ${publicId}
    `;
    return rows[0] ?? null;
  }

  async lockAdjustment(tx: Db, orgId: bigint, publicId: string): Promise<AdjustmentRow | null> {
    const rows = await tx<AdjustmentRow[]>`
      select a.id::text as "internalId", a.public_id as id, a.adjustment_no as "adjustmentNo",
             w.public_id as "warehouseId", a.warehouse_id::text as "warehouseInternalId",
             a.reason_code as "reasonCode", a.status, a.description,
             a.requires_approval as "requiresApproval",
             a.approval_request_id::text as "approvalRequestId",
             a.approved_by::text as "approvedBy", a.approved_at::text as "approvedAt",
             a.applied_at::text as "appliedAt", a.journal_entry_id::text as "journalEntryId",
             a.version, a.created_at::text as "createdAt", a.created_by::text as "createdBy"
      from erp.stock_adjustments a
      join erp.warehouses w on w.id = a.warehouse_id
      where a.organization_id = ${orgId} and a.public_id = ${publicId}
      for update of a
    `;
    return rows[0] ?? null;
  }

  async insertAdjustmentLine(
    tx: Db,
    input: {
      adjustmentInternalId: bigint;
      variantInternalId: bigint;
      locationInternalId: bigint;
      lotInternalId: bigint | null;
      systemQuantity: string;
      countedQuantity: string;
      differenceQuantity: string;
      unitCostAmount: bigint;
    },
  ): Promise<AdjustmentLineRow> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.stock_adjustment_lines
        (adjustment_id, public_id, product_variant_id, location_id, lot_id, system_qty,
         counted_qty, difference_qty, unit_cost_amount)
      values (${input.adjustmentInternalId}, gen_random_uuid(), ${input.variantInternalId},
              ${input.locationInternalId}, ${input.lotInternalId}, ${input.systemQuantity}::numeric,
              ${input.countedQuantity}::numeric, ${input.differenceQuantity}::numeric,
              ${input.unitCostAmount})
      returning id::text as id
    `;
    return this.mapAdjustmentLine(tx, (rows[0]?.id ?? '0') as string) as Promise<AdjustmentLineRow>;
  }

  private async mapAdjustmentLine(tx: Db, id: string): Promise<AdjustmentLineRow | null> {
    const rows = await tx<AdjustmentLineRow[]>`
      select l.id::text as "internalId", l.public_id as id, v.public_id as "variantId",
             l.product_variant_id::text as "variantInternalId", wl.public_id as "locationId",
             l.location_id::text as "locationInternalId", lt.public_id as "lotId",
             l.system_qty::text as "systemQuantity", l.counted_qty::text as "countedQuantity",
             l.difference_qty::text as "differenceQuantity", l.unit_cost_amount::text as "unitCostAmount",
             l.inventory_transaction_id::text as "inventoryTransactionId"
      from erp.stock_adjustment_lines l
      join erp.product_variants v on v.id = l.product_variant_id
      join erp.warehouse_locations wl on wl.id = l.location_id
      left join erp.inventory_lots lt on lt.id = l.lot_id
      where l.id = ${id}::bigint
    `;
    return rows[0] ?? null;
  }

  async listAdjustmentLines(tx: Db, adjustmentInternalId: bigint): Promise<AdjustmentLineRow[]> {
    const rows = await tx<{ id: string }[]>`
      select id::text as id from erp.stock_adjustment_lines
      where adjustment_id = ${adjustmentInternalId} order by id asc
    `;
    const lines: AdjustmentLineRow[] = [];
    for (const row of rows) {
      const line = await this.mapAdjustmentLine(tx, row.id);
      if (line !== null) lines.push(line);
    }
    return lines;
  }

  async updateAdjustmentStatus(
    tx: Db,
    internalId: bigint,
    patch: { status: string; approvedBy?: bigint | null; applied?: boolean },
  ): Promise<void> {
    await tx`
      update erp.stock_adjustments
      set status = ${patch.status},
          approved_by = coalesce(${patch.approvedBy ?? null}, approved_by),
          approved_at = case when ${patch.approvedBy === undefined || patch.approvedBy === null}::boolean
                             then approved_at else now() end,
          applied_at = case when ${patch.applied === true}::boolean then now() else applied_at end,
          updated_at = now(), version = version + 1
      where id = ${internalId}
    `;
  }

  async setAdjustmentLineTransaction(
    tx: Db,
    lineInternalId: bigint,
    transactionInternalId: bigint,
  ): Promise<void> {
    await tx`
      update erp.stock_adjustment_lines
      set inventory_transaction_id = ${transactionInternalId}
      where id = ${lineInternalId}
    `;
  }

  // ----------------------------------------------------------------- transfers

  async insertTransfer(
    tx: Db,
    input: {
      orgId: bigint;
      transferNo: string;
      fromWarehouseInternalId: bigint;
      toWarehouseInternalId: bigint;
      notes: string | null;
      requestedBy: bigint | null;
    },
  ): Promise<TransferRow> {
    const rows = await tx<TransferRow[]>`
      insert into erp.inventory_transfers
        (organization_id, public_id, transfer_no, from_warehouse_id, to_warehouse_id, status, notes, requested_by)
      values (${input.orgId}, gen_random_uuid(), ${input.transferNo}, ${input.fromWarehouseInternalId},
              ${input.toWarehouseInternalId}, 'draft', ${input.notes}, ${input.requestedBy})
      returning id::text as "internalId", public_id as id, transfer_no as "transferNo",
                ''::text as "fromWarehouseId", from_warehouse_id::text as "fromWarehouseInternalId",
                ''::text as "toWarehouseId", to_warehouse_id::text as "toWarehouseInternalId",
                status, requested_by::text as "requestedBy", approved_by::text as "approvedBy",
                dispatched_at::text as "dispatchedAt", received_at::text as "receivedAt",
                carrier, notes, version, created_at::text as "createdAt"
    `;
    return rows[0] as TransferRow;
  }

  async findTransfer(tx: Db, orgId: bigint, publicId: string): Promise<TransferRow | null> {
    const rows = await tx<TransferRow[]>`
      select t.id::text as "internalId", t.public_id as id, t.transfer_no as "transferNo",
             fw.public_id as "fromWarehouseId", t.from_warehouse_id::text as "fromWarehouseInternalId",
             tw.public_id as "toWarehouseId", t.to_warehouse_id::text as "toWarehouseInternalId",
             t.status, t.requested_by::text as "requestedBy", t.approved_by::text as "approvedBy",
             t.dispatched_at::text as "dispatchedAt", t.received_at::text as "receivedAt",
             t.carrier, t.notes, t.version, t.created_at::text as "createdAt"
      from erp.inventory_transfers t
      join erp.warehouses fw on fw.id = t.from_warehouse_id
      join erp.warehouses tw on tw.id = t.to_warehouse_id
      where t.organization_id = ${orgId} and t.public_id = ${publicId}
    `;
    return rows[0] ?? null;
  }

  async lockTransfer(tx: Db, orgId: bigint, publicId: string): Promise<TransferRow | null> {
    const rows = await tx<TransferRow[]>`
      select t.id::text as "internalId", t.public_id as id, t.transfer_no as "transferNo",
             fw.public_id as "fromWarehouseId", t.from_warehouse_id::text as "fromWarehouseInternalId",
             tw.public_id as "toWarehouseId", t.to_warehouse_id::text as "toWarehouseInternalId",
             t.status, t.requested_by::text as "requestedBy", t.approved_by::text as "approvedBy",
             t.dispatched_at::text as "dispatchedAt", t.received_at::text as "receivedAt",
             t.carrier, t.notes, t.version, t.created_at::text as "createdAt"
      from erp.inventory_transfers t
      join erp.warehouses fw on fw.id = t.from_warehouse_id
      join erp.warehouses tw on tw.id = t.to_warehouse_id
      where t.organization_id = ${orgId} and t.public_id = ${publicId}
      for update of t
    `;
    return rows[0] ?? null;
  }

  async listTransfers(
    tx: Db,
    params: {
      orgId: bigint;
      status: string | null;
      fromWarehouseInternalId: bigint | null;
      toWarehouseInternalId: bigint | null;
      limit: number;
    },
  ): Promise<TransferRow[]> {
    return tx<TransferRow[]>`
      select t.id::text as "internalId", t.public_id as id, t.transfer_no as "transferNo",
             fw.public_id as "fromWarehouseId", t.from_warehouse_id::text as "fromWarehouseInternalId",
             tw.public_id as "toWarehouseId", t.to_warehouse_id::text as "toWarehouseInternalId",
             t.status, t.requested_by::text as "requestedBy", t.approved_by::text as "approvedBy",
             t.dispatched_at::text as "dispatchedAt", t.received_at::text as "receivedAt",
             t.carrier, t.notes, t.version, t.created_at::text as "createdAt"
      from erp.inventory_transfers t
      join erp.warehouses fw on fw.id = t.from_warehouse_id
      join erp.warehouses tw on tw.id = t.to_warehouse_id
      where t.organization_id = ${params.orgId}
        and (${params.status}::text is null or t.status = ${params.status})
        and (${params.fromWarehouseInternalId}::bigint is null or t.from_warehouse_id = ${params.fromWarehouseInternalId}::bigint)
        and (${params.toWarehouseInternalId}::bigint is null or t.to_warehouse_id = ${params.toWarehouseInternalId}::bigint)
      order by t.created_at desc
      limit ${params.limit}
    `;
  }

  async updateTransferStatus(
    tx: Db,
    internalId: bigint,
    patch: { status: string; dispatched?: boolean; received?: boolean; approvedBy?: bigint | null },
  ): Promise<void> {
    await tx`
      update erp.inventory_transfers
      set status = ${patch.status},
          approved_by = coalesce(${patch.approvedBy ?? null}, approved_by),
          dispatched_at = case when ${patch.dispatched === true}::boolean then now() else dispatched_at end,
          received_at = case when ${patch.received === true}::boolean then now() else received_at end
      where id = ${internalId}
    `;
  }

  async insertTransferLine(
    tx: Db,
    input: {
      transferInternalId: bigint;
      variantInternalId: bigint;
      lotInternalId: bigint | null;
      quantity: string;
      fromLocationInternalId: bigint | null;
      toLocationInternalId: bigint | null;
      unitCostAmount: bigint;
    },
  ): Promise<TransferLineRow> {
    const rows = await tx<{ id: string }[]>`
      insert into erp.inventory_transfer_lines
        (transfer_id, public_id, product_variant_id, lot_id, quantity, dispatched_qty, received_qty,
         from_location_id, to_location_id, unit_cost_amount)
      values (${input.transferInternalId}, gen_random_uuid(), ${input.variantInternalId},
              ${input.lotInternalId}, ${input.quantity}::numeric, 0, 0,
              ${input.fromLocationInternalId}, ${input.toLocationInternalId}, ${input.unitCostAmount})
      returning id::text as id
    `;
    return (await this.mapTransferLine(tx, rows[0]?.id ?? '0')) as TransferLineRow;
  }

  private async mapTransferLine(tx: Db, id: string): Promise<TransferLineRow | null> {
    const rows = await tx<TransferLineRow[]>`
      select l.id::text as "internalId", l.public_id as id, v.public_id as "variantId",
             l.product_variant_id::text as "variantInternalId", lt.public_id as "lotId",
             l.quantity::text as quantity, l.dispatched_qty::text as "dispatchedQuantity",
             l.received_qty::text as "receivedQuantity", fl.public_id as "fromLocationId",
             l.from_location_id::text as "fromLocationInternalId", tl.public_id as "toLocationId",
             l.to_location_id::text as "toLocationInternalId", l.unit_cost_amount::text as "unitCostAmount"
      from erp.inventory_transfer_lines l
      join erp.product_variants v on v.id = l.product_variant_id
      left join erp.warehouse_locations fl on fl.id = l.from_location_id
      left join erp.warehouse_locations tl on tl.id = l.to_location_id
      left join erp.inventory_lots lt on lt.id = l.lot_id
      where l.id = ${id}::bigint
    `;
    return rows[0] ?? null;
  }

  async listTransferLines(tx: Db, transferInternalId: bigint): Promise<TransferLineRow[]> {
    const rows = await tx<{ id: string }[]>`
      select id::text as id from erp.inventory_transfer_lines
      where transfer_id = ${transferInternalId} order by id asc
    `;
    const lines: TransferLineRow[] = [];
    for (const row of rows) {
      const line = await this.mapTransferLine(tx, row.id);
      if (line !== null) lines.push(line);
    }
    return lines;
  }

  async updateTransferLine(
    tx: Db,
    lineInternalId: bigint,
    patch: {
      dispatchedQuantity: string;
      receivedQuantity: string;
      toLocationInternalId?: bigint | null;
      unitCostAmount?: string | undefined;
    },
  ): Promise<void> {
    await tx`
      update erp.inventory_transfer_lines
      set dispatched_qty = ${patch.dispatchedQuantity}::numeric,
          received_qty = ${patch.receivedQuantity}::numeric,
          to_location_id = coalesce(${patch.toLocationInternalId ?? null}, to_location_id),
          unit_cost_amount = coalesce(${patch.unitCostAmount ?? null}::bigint, unit_cost_amount)
      where id = ${lineInternalId}
    `;
  }

  // -------------------------------------------------------------------- counts

  async insertCount(
    tx: Db,
    input: {
      orgId: bigint;
      warehouseInternalId: bigint;
      countNo: string;
      countType: string;
      zoneInternalId: bigint | null;
      createdBy: bigint | null;
    },
  ): Promise<CountRow> {
    const rows = await tx<CountRow[]>`
      insert into erp.stock_counts
        (organization_id, public_id, warehouse_id, count_no, count_type, status, zone_id, counted_by)
      values (${input.orgId}, gen_random_uuid(), ${input.warehouseInternalId}, ${input.countNo},
              ${input.countType}, 'draft', ${input.zoneInternalId}, ${input.createdBy})
      returning id::text as "internalId", public_id as id, count_no as "countNo",
                ''::text as "warehouseId", warehouse_id::text as "warehouseInternalId",
                count_type as "countType", status, zone_id::text as "zoneId",
                started_at::text as "startedAt", completed_at::text as "completedAt",
                counted_by::text as "countedBy", approved_by::text as "approvedBy",
                adjustment_id::text as "adjustmentId", version, created_at::text as "createdAt"
    `;
    return rows[0] as CountRow;
  }

  async findCount(tx: Db, orgId: bigint, publicId: string): Promise<CountRow | null> {
    const rows = await tx<CountRow[]>`
      select c.id::text as "internalId", c.public_id as id, c.count_no as "countNo",
             w.public_id as "warehouseId", c.warehouse_id::text as "warehouseInternalId",
             c.count_type as "countType", c.status, c.zone_id::text as "zoneId",
             c.started_at::text as "startedAt", c.completed_at::text as "completedAt",
             c.counted_by::text as "countedBy", c.approved_by::text as "approvedBy",
             c.adjustment_id::text as "adjustmentId", c.version, c.created_at::text as "createdAt"
      from erp.stock_counts c
      join erp.warehouses w on w.id = c.warehouse_id
      where c.organization_id = ${orgId} and c.public_id = ${publicId}
    `;
    return rows[0] ?? null;
  }

  async lockCount(tx: Db, orgId: bigint, publicId: string): Promise<CountRow | null> {
    const rows = await tx<CountRow[]>`
      select c.id::text as "internalId", c.public_id as id, c.count_no as "countNo",
             w.public_id as "warehouseId", c.warehouse_id::text as "warehouseInternalId",
             c.count_type as "countType", c.status, c.zone_id::text as "zoneId",
             c.started_at::text as "startedAt", c.completed_at::text as "completedAt",
             c.counted_by::text as "countedBy", c.approved_by::text as "approvedBy",
             c.adjustment_id::text as "adjustmentId", c.version, c.created_at::text as "createdAt"
      from erp.stock_counts c
      join erp.warehouses w on w.id = c.warehouse_id
      where c.organization_id = ${orgId} and c.public_id = ${publicId}
      for update of c
    `;
    return rows[0] ?? null;
  }

  async listCounts(
    tx: Db,
    params: { orgId: bigint; status: string | null; type: string | null; warehouseInternalId: bigint | null; limit: number },
  ): Promise<CountRow[]> {
    return tx<CountRow[]>`
      select c.id::text as "internalId", c.public_id as id, c.count_no as "countNo",
             w.public_id as "warehouseId", c.warehouse_id::text as "warehouseInternalId",
             c.count_type as "countType", c.status, c.zone_id::text as "zoneId",
             c.started_at::text as "startedAt", c.completed_at::text as "completedAt",
             c.counted_by::text as "countedBy", c.approved_by::text as "approvedBy",
             c.adjustment_id::text as "adjustmentId", c.version, c.created_at::text as "createdAt"
      from erp.stock_counts c
      join erp.warehouses w on w.id = c.warehouse_id
      where c.organization_id = ${params.orgId}
        and (${params.status}::text is null or c.status = ${params.status})
        and (${params.type}::text is null or c.count_type = ${params.type})
        and (${params.warehouseInternalId}::bigint is null or c.warehouse_id = ${params.warehouseInternalId}::bigint)
      order by c.created_at desc
      limit ${params.limit}
    `;
  }

  async updateCountStatus(tx: Db, internalId: bigint, status: string): Promise<void> {
    await tx`
      update erp.stock_counts
      set status = ${status},
          started_at = case when ${status} = 'counting' then coalesce(started_at, now()) else started_at end,
          completed_at = case when ${status} in ('approved', 'applied', 'cancelled') then now() else completed_at end,
          version = version + 1
      where id = ${internalId}
    `;
  }

  async seedCountLines(
    tx: Db,
    countInternalId: bigint,
    lines: readonly {
      locationInternalId: bigint;
      variantInternalId: bigint;
      lotInternalId: bigint | null;
      expectedQuantity: string;
    }[],
  ): Promise<void> {
    for (const line of lines) {
      await tx`
        insert into erp.stock_count_lines
          (stock_count_id, public_id, location_id, product_variant_id, lot_id, expected_qty)
        values (${countInternalId}, gen_random_uuid(), ${line.locationInternalId},
                ${line.variantInternalId}, ${line.lotInternalId}, ${line.expectedQuantity}::numeric)
        on conflict (stock_count_id, location_id, product_variant_id) do nothing
      `;
    }
  }

  async listCountLines(tx: Db, countInternalId: bigint): Promise<CountLineRow[]> {
    return tx<CountLineRow[]>`
      select l.id::text as "internalId", l.public_id as id, wl.public_id as "locationId",
             l.location_id::text as "locationInternalId", v.public_id as "variantId",
             l.product_variant_id::text as "variantInternalId", lt.public_id as "lotId",
             l.expected_qty::text as "expectedQuantity", l.counted_qty::text as "countedQuantity",
             l.variance_qty::text as "varianceQuantity", l.counted_at::text as "countedAt", l.notes
      from erp.stock_count_lines l
      join erp.product_variants v on v.id = l.product_variant_id
      join erp.warehouse_locations wl on wl.id = l.location_id
      left join erp.inventory_lots lt on lt.id = l.lot_id
      where l.stock_count_id = ${countInternalId}
      order by l.location_id asc, l.product_variant_id asc
    `;
  }

  async recordCountLine(
    tx: Db,
    countInternalId: bigint,
    input: {
      locationInternalId: bigint;
      variantInternalId: bigint;
      lotInternalId: bigint | null;
      expectedQuantity: string;
      countedQuantity: string;
      varianceQuantity: string;
      countedBy: bigint | null;
    },
  ): Promise<void> {
    await tx`
      insert into erp.stock_count_lines
        (stock_count_id, public_id, location_id, product_variant_id, lot_id, expected_qty,
         counted_qty, variance_qty, counted_by, counted_at)
      values (${countInternalId}, gen_random_uuid(), ${input.locationInternalId},
              ${input.variantInternalId}, ${input.lotInternalId}, ${input.expectedQuantity}::numeric,
              ${input.countedQuantity}::numeric, ${input.varianceQuantity}::numeric,
              ${input.countedBy}, now())
      on conflict (stock_count_id, location_id, product_variant_id) do update
        set counted_qty = excluded.counted_qty,
            variance_qty = excluded.variance_qty,
            counted_by = excluded.counted_by,
            counted_at = now()
    `;
  }

  // ---------------------------------------------------------------------- lots

  async listLots(
    tx: Db,
    params: { orgId: bigint; variantInternalId: bigint | null; warehouseInternalId: bigint | null; expiryBefore: string | null; status: string | null; limit: number },
  ): Promise<LotRow[]> {
    return tx<LotRow[]>`
      select l.id::text as "internalId", l.public_id as id, v.public_id as "variantId",
             l.product_variant_id::text as "variantInternalId", w.public_id as "warehouseId",
             l.lot_no as "lotNo", l.batch_barcode as "batchBarcode",
             l.manufacture_date::text as "manufactureDate", l.expiry_date::text as "expiryDate",
             s.public_id as "supplierId", l.status
      from erp.inventory_lots l
      join erp.product_variants v on v.id = l.product_variant_id
      join erp.warehouses w on w.id = l.warehouse_id
      left join erp.procurement.suppliers s on s.id = l.supplier_id
      where l.organization_id = ${params.orgId}
        and (${params.variantInternalId}::bigint is null or l.product_variant_id = ${params.variantInternalId}::bigint)
        and (${params.warehouseInternalId}::bigint is null or l.warehouse_id = ${params.warehouseInternalId}::bigint)
        and (${params.expiryBefore}::date is null or l.expiry_date < ${params.expiryBefore}::date)
        and (${params.status}::text is null or l.status = ${params.status})
      order by l.expiry_date asc nulls last
      limit ${params.limit}
    `;
  }

  async findLot(tx: Db, orgId: bigint, publicId: string): Promise<LotRow | null> {
    const rows = await tx<LotRow[]>`
      select l.id::text as "internalId", l.public_id as id, v.public_id as "variantId",
             l.product_variant_id::text as "variantInternalId", w.public_id as "warehouseId",
             l.lot_no as "lotNo", l.batch_barcode as "batchBarcode",
             l.manufacture_date::text as "manufactureDate", l.expiry_date::text as "expiryDate",
             s.public_id as "supplierId", l.status
      from erp.inventory_lots l
      join erp.product_variants v on v.id = l.product_variant_id
      join erp.warehouses w on w.id = l.warehouse_id
      left join erp.procurement.suppliers s on s.id = l.supplier_id
      where l.organization_id = ${orgId} and l.public_id = ${publicId}
    `;
    return rows[0] ?? null;
  }

  async insertLot(
    tx: Db,
    input: {
      orgId: bigint;
      variantInternalId: bigint;
      warehouseInternalId: bigint;
      lotNo: string;
      manufactureDate: string | null;
      expiryDate: string | null;
      supplierInternalId: bigint | null;
      goodsReceiptLineInternalId: bigint | null;
    },
  ): Promise<{ internalId: string; id: string }> {
    const rows = await tx<{ internalId: string; id: string }[]>`
      insert into erp.inventory_lots
        (organization_id, public_id, product_variant_id, warehouse_id, lot_no, manufacture_date,
         expiry_date, supplier_id, goods_receipt_line_id)
      values (${input.orgId}, gen_random_uuid(), ${input.variantInternalId}, ${input.warehouseInternalId},
              ${input.lotNo}, ${input.manufactureDate}::date, ${input.expiryDate}::date,
              ${input.supplierInternalId}, ${input.goodsReceiptLineInternalId})
      returning id::text as "internalId", public_id as id
    `;
    return rows[0] as { internalId: string; id: string };
  }

  async updateLot(
    tx: Db,
    orgId: bigint,
    internalId: bigint,
    patch: { manufactureDate: string | null; expiryDate: string | null; status?: string },
  ): Promise<void> {
    await tx`
      update erp.inventory_lots
      set manufacture_date = ${patch.manufactureDate}::date,
          expiry_date = ${patch.expiryDate}::date,
          status = coalesce(${patch.status ?? null}, status)
      where organization_id = ${orgId} and id = ${internalId}
    `;
  }

  async countLotStock(tx: Db, lotInternalId: bigint): Promise<string> {
    const rows = await tx<{ total: string }[]>`
      select coalesce(sum(quantity), 0)::text as total from erp.inventory_transactions
      where lot_id = ${lotInternalId} and voided_at is null
    `;
    return rows[0]?.total ?? '0.0000';
  }

  // --------------------------------------------------------------- cost layers

  async insertLayer(
    tx: Db,
    input: {
      orgId: bigint;
      warehouseInternalId: bigint;
      variantInternalId: bigint;
      lotInternalId: bigint | null;
      receiptTransactionInternalId: bigint;
      receiptTransactionCreatedAt: string;
      sourceKind: string;
      receivedAt: string;
      quantity: string;
      unitCostAmount: bigint;
    },
  ): Promise<LayerRow> {
    const totalCost = input.unitCostAmount * BigInt(Math.round(Number(input.quantity) * 1)) === 0n ? 0n : 0n;
    void totalCost;
    const rows = await tx<{ id: string }[]>`
      insert into erp.inventory_cost_layers (
        organization_id, public_id, warehouse_id, product_variant_id, lot_id,
        receipt_transaction_id, receipt_transaction_created_at, source_kind, received_at,
        original_qty, qty_remaining, unit_cost_amount, cost_remaining_amount, currency
      ) values (
        ${input.orgId}, gen_random_uuid(), ${input.warehouseInternalId}, ${input.variantInternalId},
        ${input.lotInternalId}, ${input.receiptTransactionInternalId},
        ${input.receiptTransactionCreatedAt}::timestamptz, ${input.sourceKind},
        ${input.receivedAt}::timestamptz, ${input.quantity}::numeric, ${input.quantity}::numeric,
        ${input.unitCostAmount},
        (${input.quantity}::numeric * ${input.unitCostAmount})::bigint, 'IRR'
      )
      returning id::text as id
    `;
    const created = rows[0];
    if (created === undefined) throw new Error('layer_insert_failed');
    const full = await tx<LayerRow[]>`
      select ${layerColumns(tx)} from erp.inventory_cost_layers cl
      where cl.id = ${created.id}::bigint
    `;
    return full[0] as LayerRow;
  }

  async lockLayersForUpdate(
    tx: Db,
    warehouseInternalId: bigint,
    variantInternalId: bigint,
  ): Promise<LayerRow[]> {
    return tx<LayerRow[]>`
      select ${layerColumns(tx)}
      from erp.inventory_cost_layers cl
      where cl.warehouse_id = ${warehouseInternalId}
        and cl.product_variant_id = ${variantInternalId}
        and cl.qty_remaining > 0
      order by cl.received_at asc, cl.id asc
      for update of cl
    `;
  }

  async listLayers(
    tx: Db,
    params: { warehouseInternalId: bigint | null; variantInternalId: bigint | null; limit: number },
  ): Promise<LayerRow[]> {
    return tx<LayerRow[]>`
      select ${layerColumns(tx)}
      from erp.inventory_cost_layers cl
      where (${params.warehouseInternalId}::bigint is null or cl.warehouse_id = ${params.warehouseInternalId}::bigint)
        and (${params.variantInternalId}::bigint is null or cl.product_variant_id = ${params.variantInternalId}::bigint)
        and cl.qty_remaining > 0
      order by cl.received_at asc, cl.id asc
      limit ${params.limit}
    `;
  }

  async updateLayerRemaining(
    tx: Db,
    layerInternalId: bigint,
    quantityRemaining: string,
    costRemainingAmount: bigint,
    isClosed: boolean,
  ): Promise<void> {
    await tx`
      update erp.inventory_cost_layers
      set qty_remaining = ${quantityRemaining}::numeric,
          cost_remaining_amount = ${costRemainingAmount},
          is_closed = ${isClosed}
      where id = ${layerInternalId}
    `;
  }

  async insertLayerConsumption(
    tx: Db,
    input: {
      layerInternalId: bigint;
      issueTransactionInternalId: bigint;
      issueTransactionCreatedAt: string;
      warehouseInternalId: bigint;
      variantInternalId: bigint;
      quantity: string;
      costAmount: bigint;
      consumptionKind: string;
      createdBy: bigint | null;
    },
  ): Promise<void> {
    await tx`
      insert into erp.inventory_layer_consumptions
        (layer_id, issue_transaction_id, issue_transaction_created_at, warehouse_id,
         product_variant_id, quantity, cost_amount, consumption_kind, created_by)
      values (${input.layerInternalId}, ${input.issueTransactionInternalId},
              ${input.issueTransactionCreatedAt}::timestamptz, ${input.warehouseInternalId},
              ${input.variantInternalId}, ${input.quantity}::numeric, ${input.costAmount},
              ${input.consumptionKind}, ${input.createdBy})
    `;
  }

  // ----------------------------------------------------------- average costing

  async lockAverageCost(
    tx: Db,
    orgId: bigint,
    warehouseInternalId: bigint,
    variantInternalId: bigint,
  ): Promise<AverageCostRow> {
    await tx`
      insert into erp.inventory_average_costs
        (organization_id, public_id, warehouse_id, product_variant_id)
      values (${orgId}, gen_random_uuid(), ${warehouseInternalId}, ${variantInternalId})
      on conflict (warehouse_id, product_variant_id) do nothing
    `;
    const rows = await tx<AverageCostRow[]>`
      select id::text as "internalId",
             warehouse_id::text as "warehouseInternalId",
             product_variant_id::text as "variantInternalId",
             qty_on_hand::text as "quantityOnHand",
             avg_cost_amount::text as "avgCostAmount",
             total_value_amount::text as "totalValueAmount"
      from erp.inventory_average_costs
      where warehouse_id = ${warehouseInternalId} and product_variant_id = ${variantInternalId}
      for update
    `;
    return rows[0] as AverageCostRow;
  }

  async updateAverageCost(
    tx: Db,
    internalId: bigint,
    patch: { quantityOnHand: string; avgCostAmount: bigint; totalValueAmount: bigint; lastTransactionInternalId: bigint | null },
  ): Promise<void> {
    await tx`
      update erp.inventory_average_costs
      set qty_on_hand = ${patch.quantityOnHand}::numeric,
          avg_cost_amount = ${patch.avgCostAmount},
          total_value_amount = ${patch.totalValueAmount},
          last_transaction_id = ${patch.lastTransactionInternalId},
          last_calculated_at = now()
      where id = ${internalId}
    `;
  }

  async findAverageCost(
    tx: Db,
    warehouseInternalId: bigint,
    variantInternalId: bigint,
  ): Promise<AverageCostRow | null> {
    const rows = await tx<AverageCostRow[]>`
      select id::text as "internalId",
             warehouse_id::text as "warehouseInternalId",
             product_variant_id::text as "variantInternalId",
             qty_on_hand::text as "quantityOnHand",
             avg_cost_amount::text as "avgCostAmount",
             total_value_amount::text as "totalValueAmount"
      from erp.inventory_average_costs
      where warehouse_id = ${warehouseInternalId} and product_variant_id = ${variantInternalId}
    `;
    return rows[0] ?? null;
  }

  // ---------------------------------------------------------------- valuation

  async insertValuationRun(
    tx: Db,
    input: {
      orgId: bigint;
      warehouseInternalId: bigint | null;
      valuationMethod: string;
      valuationDate: string;
      runBy: bigint | null;
    },
  ): Promise<ValuationRunRow> {
    const rows = await tx<ValuationRunRow[]>`
      insert into erp.inventory_valuation_runs
        (organization_id, public_id, warehouse_id, valuation_method, valuation_date, status, run_by)
      values (${input.orgId}, gen_random_uuid(), ${input.warehouseInternalId}, ${input.valuationMethod},
              ${input.valuationDate}::date, 'running', ${input.runBy})
      returning id::text as "internalId", public_id as id, ''::text as "warehouseId",
                valuation_method as "valuationMethod", valuation_date::text as "valuationDate",
                cost_layer_count as "costLayerCount", gl_inventory_amount::text as "glInventoryAmount",
                status, total_quantity::text as "totalQuantity",
                total_value_amount::text as "totalValueAmount",
                journal_entry_id::text as "journalEntryId", completed_at::text as "completedAt",
                error_message as "errorMessage", created_at::text as "createdAt"
    `;
    return rows[0] as ValuationRunRow;
  }

  async updateValuationRun(
    tx: Db,
    internalId: bigint,
    patch: {
      status: string;
      totalQuantity: string;
      totalValueAmount: bigint;
      glInventoryAmount: bigint;
      costLayerCount: number;
      errorMessage?: string | null;
    },
  ): Promise<void> {
    await tx`
      update erp.inventory_valuation_runs
      set status = ${patch.status},
          total_quantity = ${patch.totalQuantity}::numeric,
          total_value_amount = ${patch.totalValueAmount},
          gl_inventory_amount = ${patch.glInventoryAmount},
          cost_layer_count = ${patch.costLayerCount},
          completed_at = case when ${patch.status} in ('completed', 'failed', 'posted') then now() else completed_at end,
          error_message = ${patch.errorMessage ?? null}
      where id = ${internalId}
    `;
  }

  async insertValuationLine(
    tx: Db,
    input: {
      runInternalId: bigint;
      variantInternalId: bigint;
      warehouseInternalId: bigint;
      quantity: string;
      unitCostAmount: bigint;
      totalValueAmount: bigint;
      layerBreakdown: unknown;
    },
  ): Promise<void> {
    await tx`
      insert into erp.inventory_valuation_lines
        (run_id, product_variant_id, warehouse_id, quantity, unit_cost_amount, total_value_amount, layer_breakdown)
      values (${input.runInternalId}, ${input.variantInternalId}, ${input.warehouseInternalId},
              ${input.quantity}::numeric, ${input.unitCostAmount}, ${input.totalValueAmount},
              ${JSON.stringify(input.layerBreakdown)}::jsonb)
    `;
  }

  async listValuationLines(tx: Db, runInternalId: bigint): Promise<ValuationLineRow[]> {
    return tx<ValuationLineRow[]>`
      select v.public_id as "variantId", l.product_variant_id::text as "variantInternalId",
             w.public_id as "warehouseId", l.quantity::text as quantity,
             l.unit_cost_amount::text as "unitCostAmount",
             l.total_value_amount::text as "totalValueAmount", l.layer_breakdown as "layerBreakdown"
      from erp.inventory_valuation_lines l
      join erp.product_variants v on v.id = l.product_variant_id
      join erp.warehouses w on w.id = l.warehouse_id
      where l.run_id = ${runInternalId}
      order by v.sku asc, w.code asc
    `;
  }

  async findValuationRun(tx: Db, orgId: bigint, publicId: string): Promise<ValuationRunRow | null> {
    const rows = await tx<ValuationRunRow[]>`
      select r.id::text as "internalId", r.public_id as id, w.public_id as "warehouseId",
             r.valuation_method as "valuationMethod", r.valuation_date::text as "valuationDate",
             r.cost_layer_count as "costLayerCount", r.gl_inventory_amount::text as "glInventoryAmount",
             r.status, r.total_quantity::text as "totalQuantity",
             r.total_value_amount::text as "totalValueAmount",
             r.journal_entry_id::text as "journalEntryId", r.completed_at::text as "completedAt",
             r.error_message as "errorMessage", r.created_at::text as "createdAt"
      from erp.inventory_valuation_runs r
      left join erp.warehouses w on w.id = r.warehouse_id
      where r.organization_id = ${orgId} and r.public_id = ${publicId}
    `;
    return rows[0] ?? null;
  }

  async listValuationRuns(
    tx: Db,
    params: { orgId: bigint; status: string | null; limit: number; offset: number },
  ): Promise<ValuationRunRow[]> {
    return tx<ValuationRunRow[]>`
      select r.id::text as "internalId", r.public_id as id, w.public_id as "warehouseId",
             r.valuation_method as "valuationMethod", r.valuation_date::text as "valuationDate",
             r.cost_layer_count as "costLayerCount", r.gl_inventory_amount::text as "glInventoryAmount",
             r.status, r.total_quantity::text as "totalQuantity",
             r.total_value_amount::text as "totalValueAmount",
             r.journal_entry_id::text as "journalEntryId", r.completed_at::text as "completedAt",
             r.error_message as "errorMessage", r.created_at::text as "createdAt"
      from erp.inventory_valuation_runs r
      left join erp.warehouses w on w.id = r.warehouse_id
      where r.organization_id = ${params.orgId}
        and (${params.status}::text is null or r.status = ${params.status})
      order by r.created_at desc
      limit ${params.limit} offset ${params.offset}
    `;
  }

  /** Current valuation by warehouse/variant: on-hand × (average or layer value). */
  async currentValuation(
    tx: Db,
    params: { orgId: bigint; warehouseInternalId: bigint | null; variantInternalId: bigint | null },
  ): Promise<
    {
      variantId: string;
      variantInternalId: string;
      warehouseId: string;
      quantity: string;
      unitCostAmount: string;
      totalValueAmount: string;
      layerCount: number;
    }[]
  > {
    return tx`
      select v.public_id as "variantId", b.product_variant_id::text as "variantInternalId",
             w.public_id as "warehouseId", b.on_hand::text as quantity,
             coalesce(ac.avg_cost_amount, 0)::text as "unitCostAmount",
             coalesce(ac.total_value_amount, 0)::text as "totalValueAmount",
             coalesce(layers.layer_count, 0)::int as "layerCount"
      from erp.inventory_balances b
      join erp.warehouses w on w.id = b.warehouse_id
      join erp.product_variants v on v.id = b.product_variant_id
      left join erp.inventory_average_costs ac
        on ac.warehouse_id = b.warehouse_id and ac.product_variant_id = b.product_variant_id
      left join (
        select warehouse_id, product_variant_id, count(*)::int as layer_count
        from erp.inventory_cost_layers where qty_remaining > 0
        group by warehouse_id, product_variant_id
      ) layers on layers.warehouse_id = b.warehouse_id and layers.product_variant_id = b.product_variant_id
      where b.organization_id = ${params.orgId} and b.on_hand > 0
        and (${params.warehouseInternalId}::bigint is null or b.warehouse_id = ${params.warehouseInternalId}::bigint)
        and (${params.variantInternalId}::bigint is null or b.product_variant_id = ${params.variantInternalId}::bigint)
    `;
  }

  // ------------------------------------------------------------ consistency log

  async insertConsistencyCheck(
    tx: Db,
    input: {
      orgId: bigint;
      checkType: string;
      warehouseInternalId: bigint | null;
      variantInternalId: bigint | null;
      locationInternalId: bigint | null;
      expectedValue: string | null;
      actualValue: string | null;
      difference: string | null;
      status: string;
      details: unknown;
    },
  ): Promise<void> {
    await tx`
      insert into erp.inventory_consistency_checks
        (organization_id, check_type, warehouse_id, product_variant_id, location_id,
         expected_value, actual_value, difference, status, details, checked_at)
      values (${input.orgId}, ${input.checkType}, ${input.warehouseInternalId},
              ${input.variantInternalId}, ${input.locationInternalId},
              ${input.expectedValue}::numeric, ${input.actualValue}::numeric, ${input.difference}::numeric,
              ${input.status}, ${JSON.stringify(input.details)}::jsonb, now())
    `;
  }

  // ------------------------------------------------------ numbering & periods

  /**
   * Gap-free document number (`ADR-0014`, `DATA-MODEL` §6.10.4): `UPDATE … RETURNING`
   * on the `(org, document_type, fiscal_year)` sequence row, formatting the
   * `PREFIX-YYYY-000123` value. Fails when the fiscal year has no sequence row.
   */
  async allocateDocumentNo(
    tx: Db,
    orgId: bigint,
    documentType: string,
    businessDate: string,
  ): Promise<string> {
    const rows = await tx<{ prefix: string; next_value: string; padding: number; fiscal_year: string }[]>`
      select ns.prefix, ns.next_value::text as next_value, ns.padding,
             to_char(fy.start_date, 'YYYY') as fiscal_year
      from erp.numbering_sequences ns
      join erp.fiscal_years fy on fy.id = ns.fiscal_year_id
      where ns.organization_id = ${orgId}
        and ns.document_type = ${documentType}
        and fy.start_date <= ${businessDate}::date
        and fy.end_date >= ${businessDate}::date
      for update of ns
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new (await import('@saman/shared')).AppError('RULE_VIOLATION', {
        message: 'دنبالهٔ شماره‌گذاری برای این نوع سند تعریف نشده است.',
        messageKey: 'inventory.numbering_sequence_missing',
        details: [{ rule: 'numbering_sequence_missing', params: { documentType } }],
      });
    }
    const value = BigInt(row.next_value);
    const padded = value.toString().padStart(Number(row.padding), '0');
    await tx`
      update erp.numbering_sequences
      set next_value = next_value + 1, last_allocated_at = now()
      where organization_id = ${orgId} and document_type = ${documentType}
        and fiscal_year_id = (select fiscal_year_id from erp.numbering_sequences
                              where organization_id = ${orgId} and document_type = ${documentType}
                              limit 1)
    `;
    return `${row.prefix}-${row.fiscal_year}-${padded}`;
  }

  /**
   * Locks the accounting period of a business date `FOR SHARE` and rejects posting
   * into a closed/locked period (`R1-A B-16`, `ADR-0014`). Returns the period id.
   */
  async lockPeriodForDate(
    tx: Db,
    orgId: bigint,
    businessDate: string,
  ): Promise<{ periodInternalId: bigint; status: string } | null> {
    const rows = await tx<{ id: string; status: string }[]>`
      select p.id::text as id, p.status
      from erp.accounting_periods p
      join erp.fiscal_years fy on fy.id = p.fiscal_year_id
      where fy.organization_id = ${orgId}
        and p.start_date <= ${businessDate}::date
        and p.end_date >= ${businessDate}::date
      for share of p
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return { periodInternalId: BigInt(row.id), status: row.status };
  }

  // ------------------------------------------------------------ stock workspace

  /**
   * Aggregated variant stock for the stock workspace: organization-scoped,
   * soft-delete aware and independent of the warehouse/location split. The
   * channel listings are aggregated as JSON so the list stays one query.
   */
  async listStock(
    tx: Db,
    params: { orgId: bigint; search: string | null; limit: number; offset: number },
  ): Promise<{ items: StockRow[]; total: number }> {
    const counted = await tx<{ total: string }[]>`
      select count(*)::text as total
      from erp.product_variants v
      join erp.products p on p.id = v.product_id
      where p.organization_id = ${params.orgId}
        and p.deleted_at is null
        and v.deleted_at is null
        and (${params.search}::text is null
             or p.name ilike '%' || ${params.search}::text || '%'
             or coalesce(p.name_en, '') ilike '%' || ${params.search}::text || '%'
             or v.sku ilike '%' || ${params.search}::text || '%'
             or coalesce(v.barcode, '') = ${params.search}::text)
    `;
    const rows = await tx<StockRow[]>`
      select v.public_id as "variantId",
             p.public_id as "productId",
             p.name as "productName",
             v.sku,
             coalesce(sum(b.on_hand), 0)::text as "onHand",
             coalesce(sum(b.reserved), 0)::text as "reserved",
             coalesce(
               (select json_agg(json_build_object(
                         'accountId', ca.public_id,
                         'channelCode', sc.code,
                         'channelName', sc.name,
                         'externalProductId', m.external_product_id,
                         'externalVariantId', m.external_variant_id
                       ) order by sc.code asc, ca.id asc)
                from erp.channel_product_mappings m
                join erp.channel_accounts ca
                  on ca.id = m.channel_account_id
                 and ca.organization_id = ${params.orgId}
                 and ca.is_active
                 and ca.deleted_at is null
                join erp.sales_channels sc on sc.id = ca.channel_id and sc.deleted_at is null
                where m.product_variant_id = v.id and m.deleted_at is null),
               '[]'::json
             ) as channels
      from erp.product_variants v
      join erp.products p on p.id = v.product_id
      left join erp.inventory_balances b
        on b.product_variant_id = v.id and b.organization_id = p.organization_id
      where p.organization_id = ${params.orgId}
        and p.deleted_at is null
        and v.deleted_at is null
        and (${params.search}::text is null
             or p.name ilike '%' || ${params.search}::text || '%'
             or coalesce(p.name_en, '') ilike '%' || ${params.search}::text || '%'
             or v.sku ilike '%' || ${params.search}::text || '%'
             or coalesce(v.barcode, '') = ${params.search}::text)
      group by v.id, p.id, v.public_id, p.public_id, p.name, v.sku
      order by p.name asc, v.sku asc, v.id asc
      limit ${params.limit} offset ${params.offset}
    `;
    return { items: rows, total: Number(counted[0]?.total ?? '0') };
  }

  /** Active variant→channel mappings that can accept a stock push. */
  async listStockChannelTargets(
    tx: Db,
    orgId: bigint,
    variantInternalId: bigint,
  ): Promise<StockChannelTarget[]> {
    return tx<StockChannelTarget[]>`
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

  /** Non-locking on-hand read (response/validation only; writes use `lockBalances`). */
  async findOnHand(
    tx: Db,
    orgId: bigint,
    key: { warehouseInternalId: bigint; locationInternalId: bigint; variantInternalId: bigint },
  ): Promise<string> {
    const rows = await tx<{ onHand: string }[]>`
      select coalesce(on_hand, 0)::text as "onHand"
      from erp.inventory_balances
      where organization_id = ${orgId}
        and warehouse_id = ${key.warehouseInternalId}
        and location_id = ${key.locationInternalId}
        and product_variant_id = ${key.variantInternalId}
      limit 1
    `;
    return rows[0]?.onHand ?? '0.0000';
  }

  /** First active warehouse of the organization (default for a warehouse-less adjust). */
  async resolveDefaultWarehouseId(tx: Db, orgId: bigint): Promise<bigint | null> {
    const rows = await tx<{ id: string }[]>`
      select id::text as id from erp.warehouses
      where organization_id = ${orgId} and deleted_at is null and is_active
      order by code asc, id asc
      limit 1
    `;
    return rows[0] === undefined ? null : BigInt(rows[0].id);
  }

  /** Variant ledger history for the stock workspace (`GET /inventory/stock/:id/history`). */
  async stockHistory(
    tx: Db,
    params: { orgId: bigint; variantInternalId: bigint; limit: number; offset: number },
  ): Promise<{ items: StockHistoryRow[]; total: number }> {
    const counted = await tx<{ total: string }[]>`
      select count(*)::text as total
      from erp.inventory_transactions t
      where t.organization_id = ${params.orgId}
        and t.product_variant_id = ${params.variantInternalId}
    `;
    const items = await tx<StockHistoryRow[]>`
      select t.public_id as id,
             t.transaction_type as type,
             t.quantity::text as quantity,
             t.unit_cost_amount::text as "unitCostAmount",
             t.total_cost_amount::text as "totalCostAmount",
             w.public_id as "warehouseId",
             l.public_id as "locationId",
             t.reference_type as "referenceType",
             t.reference_public_id as "referenceId",
             t.business_date::text as "businessDate",
             t.created_at::text as "createdAt"
      from erp.inventory_transactions t
      join erp.warehouses w on w.id = t.warehouse_id
      join erp.warehouse_locations l on l.id = t.location_id
      where t.organization_id = ${params.orgId}
        and t.product_variant_id = ${params.variantInternalId}
      order by t.created_at desc, t.id desc
      limit ${params.limit} offset ${params.offset}
    `;
    return { items, total: Number(counted[0]?.total ?? '0') };
  }
}
