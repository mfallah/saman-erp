/**
 * Warehouse application service (`API.md` §4.5): location tree, putaway
 * suggestions, pick-wave planning, pick-task execution with two-stage scan
 * verification. Reservations/stock come from `InventoryService`; orders from
 * `SalesService` — never their tables.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@saman/shared';

import { AUDIT, DB, EVENT_BUS, type AuditPort, type Db as ContractDb, type EventPort, type TenantContext } from '../../common/contracts';
import { CatalogLookupService } from '../catalog/product.service';
import { InventoryService } from '../inventory/inventory.service';
import { addQuantity, compareQuantity, subQuantity } from '../inventory/engines/quantity.engine';
import { SalesService } from '../sales/sales.service';
import type { Db } from './warehouse.pg-support';
import { notFound, toBigInt } from './warehouse.pg-support';
import { WarehouseRepository } from './warehouse.repository';
import { type LocationRow, type PickTaskRow, type PickWaveRow, type WarehouseRow } from './warehouse.repository';
import { WAREHOUSE_EVENTS, type PickTaskEventPayload, type WaveEventPayload } from './warehouse.events';
import { assertValidLocationParent, assignPickRoute, generateLocationCode, labelNumber, normalizeLocationBarcode, orderPickTasks, suggestPutaway, verifyScan, type LocationNodeType } from './engines/location.engine';
import type {
  AssignTaskBody,
  BulkCreateLocationsBody,
  CreatePickWaveBody,
  CreateWarehouseBody,
  LocationNodeInput,
  PickScanBody,
  PutawaySuggestionQuery,
  ReleaseWaveBody,
  UpdateLocationBody,
  UpdateWarehouseBody,
} from './dto/warehouse.dto';

function warehouseView(row: WarehouseRow): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    branchId: row.branchId,
    type: row.warehouseType,
    city: row.city,
    address: row.address,
    status: row.isActive ? 'active' : 'inactive',
    version: row.version,
    createdAt: row.createdAt,
  };
}

function locationView(row: LocationRow): Record<string, unknown> {
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    code: row.fullCode,
    fullCode: row.fullCode,
    barcode: row.barcode,
    type: row.locationType,
    pickPriority: row.pickPriority,
    isPickable: row.isPickable,
    status: row.isActive ? 'active' : 'inactive',
    zoneCode: row.zoneCode,
    abcClass: row.abcClass,
    capacity: row.capacityQuantity,
    version: row.version,
  };
}

function waveView(row: PickWaveRow, tasks: readonly Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    id: row.id,
    waveNo: row.waveNo,
    warehouseId: row.warehouseId,
    strategy: row.strategy,
    status: row.status,
    priority: row.priority,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    ...(tasks.length > 0 ? { tasks } : {}),
  };
}

function pickTaskView(row: PickTaskRow): Record<string, unknown> {
  return {
    id: row.id,
    waveId: row.waveId,
    orderId: row.orderId,
    variantId: row.variantId,
    locationId: row.locationId,
    locationCode: row.locationFullCode,
    quantityRequired: row.quantityRequired,
    quantityPicked: row.quantityPicked,
    sequenceNo: row.sequenceNo,
    status: row.status,
    assignedTo: row.assignedTo,
  };
}

@Injectable()
export class WarehouseService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: WarehouseRepository,
    private readonly catalog: CatalogLookupService,
    private readonly inventory: InventoryService,
    private readonly sales: SalesService,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  // ============================================================= warehouses

  async listWarehouses(ctx: TenantContext, query: { page: number; perPage: number; status?: string | undefined; q?: string | undefined }) {
    const rows = await this.repo.listWarehouses(this.db, {
      orgId: ctx.orgId,
      status: query.status === undefined ? null : query.status === 'active',
      branchInternalId: null,
      search: query.q ?? null,
      limit: query.perPage,
      offset: (query.page - 1) * query.perPage,
    });
    return rows.map(warehouseView);
  }

  async getWarehouse(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.requireWarehouse(this.db, ctx, publicId);
    return warehouseView(row);
  }

  async createWarehouse(ctx: TenantContext, body: CreateWarehouseBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      if (await this.repo.codeExists(tx, ctx.orgId, body.code)) {
        throw new AppError('CONFLICT', {
          message: 'کد انبار تکراری است.',
          messageKey: 'warehouse.code_conflict',
          details: [{ field: 'code', rule: 'warehouse_code_conflict' }],
        });
      }
      const created = await this.repo.insertWarehouse(tx, {
        orgId: ctx.orgId,
        code: body.code.toUpperCase(),
        name: body.name,
        branchInternalId: null,
        warehouseType: body.type === 'return' ? 'returns' : (body.type ?? 'main'),
        address: body.address ?? null,
        city: body.city ?? null,
      });
      await this.emit(tx, ctx, WAREHOUSE_EVENTS.warehouseCreated, 'warehouse', toBigInt(created.internalId), {
        warehouseId: created.id,
        code: created.code,
      });
      await this.record(tx, ctx, 'warehouse.create', 'warehouse', created.id, null, warehouseView(created));
      return warehouseView(created);
    });
  }

  async updateWarehouse(ctx: TenantContext, publicId: string, body: UpdateWarehouseBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const current = await this.requireWarehouse(tx, ctx, publicId);
      const updated = await this.repo.updateWarehouse(tx, ctx.orgId, toBigInt(current.internalId), {
        name: body.name ?? current.name,
        address: body.address === undefined ? current.address : body.address,
        city: body.city === undefined ? current.city : body.city,
        isActive: body.status === undefined ? current.isActive : body.status === 'active',
        warehouseType: current.warehouseType,
      });
      await this.record(tx, ctx, 'warehouse.update', 'warehouse', updated.id, warehouseView(current), warehouseView(updated));
      return warehouseView(updated);
    });
  }

  async deleteWarehouse(ctx: TenantContext, publicId: string): Promise<void> {
    await this.db.begin(async (tx) => {
      const current = await this.requireWarehouse(tx, ctx, publicId);
      if (await this.repo.warehouseHasStock(tx, toBigInt(current.internalId))) {
        throw new AppError('RULE_VIOLATION', {
          message: 'انباری که موجودی دارد قابل حذف نیست.',
          messageKey: 'warehouse.warehouse_has_stock',
          details: [{ rule: 'warehouse_has_stock' }],
        });
      }
      await this.repo.softDeleteWarehouse(tx, ctx.orgId, toBigInt(current.internalId));
    });
  }

  async listWarehouseLocations(
    ctx: TenantContext,
    warehousePublicId: string,
    query: { limit: number; code?: string | undefined; type?: string | undefined; q?: string | undefined },
  ): Promise<Record<string, unknown>[]> {
    const warehouse = await this.requireWarehouse(this.db, ctx, warehousePublicId);
    const rows = await this.repo.listLocations(this.db, {
      orgId: ctx.orgId,
      warehouseInternalId: toBigInt(warehouse.internalId),
      locationType: query.type ?? null,
      search: query.q ?? query.code ?? null,
      limit: query.limit,
      offset: 0,
    });
    return rows.map(locationView);
  }

  async capacity(ctx: TenantContext, warehousePublicId: string): Promise<Record<string, unknown>[]> {
    const warehouse = await this.requireWarehouse(this.db, ctx, warehousePublicId);
    const rows = await this.repo.listLocations(this.db, {
      orgId: ctx.orgId,
      warehouseInternalId: toBigInt(warehouse.internalId),
      locationType: null,
      search: null,
      limit: 500,
      offset: 0,
    });
    return rows.map((row) => ({
      id: row.id,
      code: row.fullCode,
      capacity: row.capacityQuantity,
      zoneCode: row.zoneCode,
    }));
  }

  // ============================================================ location tree

  async locationTree(ctx: TenantContext, warehousePublicId: string): Promise<Record<string, unknown>[]> {
    const warehouse = await this.requireWarehouse(this.db, ctx, warehousePublicId);
    const flat = await this.repo.locationTree(this.db, toBigInt(warehouse.internalId));
    const byParent = new Map<string, typeof flat>();
    for (const node of flat) {
      const key = node.parentId ?? 'root';
      const list = byParent.get(key) ?? [];
      list.push(node);
      byParent.set(key, list);
    }
    const build = (parentId: string | null): Record<string, unknown>[] =>
      (byParent.get(parentId ?? 'root') ?? []).map((node) => ({
        id: node.id,
        code: node.code,
        name: node.code,
        type: 'location',
        level: node.level,
        fullCode: node.fullCode,
        abcClass: node.abcClass,
        capacity: node.capacityQuantity,
        pickPriority: node.pickPriority,
        children: build(node.id),
      }));
    return build(null);
  }

  async listLocations(ctx: TenantContext, query: { limit: number; code?: string | undefined; type?: string | undefined; q?: string | undefined }) {
    const rows = await this.repo.listLocations(this.db, {
      orgId: ctx.orgId,
      warehouseInternalId: null,
      locationType: query.type ?? null,
      search: query.q ?? query.code ?? null,
      limit: query.limit,
      offset: 0,
    });
    return rows.map(locationView);
  }

  async lookupLocation(ctx: TenantContext, code: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findLocationByCode(this.db, ctx.orgId, null, code);
    if (row === null) throw notFound('location');
    return { ...locationView(row), warehouseId: row.warehouseId };
  }

  async getLocation(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findLocation(this.db, ctx.orgId, publicId);
    if (row === null) throw notFound('location');
    return locationView(row);
  }

  async locationContents(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>[]> {
    const row = await this.repo.findLocation(this.db, ctx.orgId, publicId);
    if (row === null) throw notFound('location');
    return this.repo.locationContents(this.db, toBigInt(row.internalId));
  }

  async createLocationNode(
    ctx: TenantContext,
    warehousePublicId: string,
    body: LocationNodeInput,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const warehouse = await this.requireWarehouse(tx, ctx, warehousePublicId);
      const warehouseInternalId = toBigInt(warehouse.internalId);
      const created = await this.insertNode(tx, warehouseInternalId, body);
      if (body.type === 'location') {
        await this.emit(tx, ctx, WAREHOUSE_EVENTS.locationCreated, 'warehouse_location', toBigInt(created.internalId), {
          locationId: created.id,
          code: created.fullCode ?? '',
        });
      }
      return locationView(created);
    });
  }

  async bulkCreateLocations(
    ctx: TenantContext,
    warehousePublicId: string,
    body: BulkCreateLocationsBody,
  ): Promise<{ results: { index: number; status: 'ok' | 'error'; id?: string; error?: string }[] }> {
    const results: { index: number; status: 'ok' | 'error'; id?: string; error?: string }[] = [];
    for (const [index, item] of body.items.entries()) {
      try {
        const created = await this.createLocationNode(ctx, warehousePublicId, item);
        results.push({ index, status: 'ok', id: String(created['id']) });
      } catch (error) {
        results.push({ index, status: 'error', error: error instanceof Error ? error.message : 'error' });
      }
    }
    return { results };
  }

  private async insertNode(tx: Db, warehouseInternalId: bigint, body: LocationNodeInput): Promise<LocationRow> {
    const requestedType = body.type as LocationNodeType;
    // A node without a parent gets a real stock location: build the minimal
    // zone→aisle→rack→shelf→bin chain and attach the location to it, so it shows
    // up in the location list and can be used for inbound placement.
    if (requestedType !== 'zone' && body.parentId === undefined) {
      return this.createStandaloneLocation(tx, warehouseInternalId, body);
    }
    const nodeType: LocationNodeType = requestedType;
    if (nodeType === 'zone') {
      assertValidLocationParent('zone', null);
      await this.repo.insertZone(tx, {
        warehouseInternalId,
        code: body.code.toUpperCase(),
        name: body.name ?? body.code,
        abcClass: body.abcClass ?? null,
        pickSequence: body.pickPriority ?? 0,
        zoneType: 'storage',
      });
      return this.locationPlaceholder(warehouseInternalId, body.code, 'zone');
    }
    if (nodeType === 'aisle') {
      const zone = await this.repo.resolveZone(tx, body.parentId ?? '');
      if (zone === null) throw notFound('zone');
      assertValidLocationParent('aisle', 'zone');
      await this.repo.insertAisle(tx, {
        zoneInternalId: toBigInt(zone.internalId),
        code: body.code.toUpperCase(),
        name: body.name ?? body.code,
        sequenceNo: 0,
      });
      return this.locationPlaceholder(warehouseInternalId, body.code, 'aisle');
    }
    if (nodeType === 'rack') {
      const aisle = await this.repo.resolveAisle(tx, body.parentId ?? '');
      if (aisle === null) throw notFound('aisle');
      assertValidLocationParent('rack', 'aisle');
      await this.repo.insertRack(tx, {
        aisleInternalId: toBigInt(aisle.internalId),
        code: body.code.toUpperCase(),
        name: body.name ?? body.code,
        sequenceNo: 0,
      });
      return this.locationPlaceholder(warehouseInternalId, body.code, 'rack');
    }
    if (nodeType === 'shelf') {
      const rack = await this.repo.resolveRack(tx, body.parentId ?? '');
      if (rack === null) throw notFound('rack');
      assertValidLocationParent('shelf', 'rack');
      await this.repo.insertShelf(tx, {
        rackInternalId: toBigInt(rack.internalId),
        code: body.code.toUpperCase(),
        levelNo: Number(body.code) || 0,
        sequenceNo: 0,
      });
      return this.locationPlaceholder(warehouseInternalId, body.code, 'shelf');
    }
    if (nodeType === 'bin') {
      const shelf = await this.repo.resolveShelf(tx, body.parentId ?? '');
      if (shelf === null) throw notFound('shelf');
      assertValidLocationParent('bin', 'shelf');
      await this.repo.insertBin(tx, {
        shelfInternalId: toBigInt(shelf.internalId),
        code: body.code.toUpperCase(),
        binType: 'standard',
        capacityQuantity: body.capacity ?? null,
        isPickFace: body.isPickFace ?? true,
      });
      return this.locationPlaceholder(warehouseInternalId, body.code, 'bin');
    }
    // leaf location under a bin
    const bin = await this.repo.resolveBin(tx, body.parentId ?? '');
    if (bin === null) throw notFound('bin');
    assertValidLocationParent('location', 'bin');
    const chain = await this.repo.binChain(tx, toBigInt(bin.internalId));
    if (chain === null) throw notFound('bin');
    const fullCode = generateLocationCode({
      zoneCode: chain.zoneCode,
      aisleCode: chain.aisleCode,
      rackCode: chain.rackCode,
      shelfCode: chain.shelfCode,
      binCode: chain.binCode,
    });
    return this.repo.insertLocation(tx, {
      warehouseInternalId,
      binInternalId: toBigInt(bin.internalId),
      fullCode,
      barcode: normalizeLocationBarcode(body.barcode, fullCode),
      locationType: body.locationType ?? 'bin',
      pickPriority: body.pickPriority ?? 0,
      isPickable: true,
    });
  }

  /** Zone/aisle/rack/shelf/bin nodes are not stock addresses; return a node view. */
  /** Creates the minimal hierarchy chain and a real stock location under it. */
  private async createStandaloneLocation(
    tx: Db,
    warehouseInternalId: bigint,
    body: LocationNodeInput,
  ): Promise<LocationRow> {
    const suffix = String(Date.now()).slice(-5);
    const code = body.code.toUpperCase();
    const zoneCode = `Z${suffix}`;
    const aisleCode = `A${suffix}`;
    const rackCode = `R${suffix}`;
    const shelfCode = 'S1';
    const binCode = 'B1';
    const zoneId = await this.repo.insertZone(tx, {
      warehouseInternalId,
      code: zoneCode,
      name: zoneCode,
      abcClass: body.abcClass ?? null,
      pickSequence: body.pickPriority ?? 0,
      zoneType: 'storage',
    });
    const aisleId = await this.repo.insertAisle(tx, {
      zoneInternalId: toBigInt(zoneId),
      code: aisleCode,
      name: aisleCode,
      sequenceNo: 0,
    });
    const rackId = await this.repo.insertRack(tx, {
      aisleInternalId: toBigInt(aisleId),
      code: rackCode,
      name: rackCode,
      sequenceNo: 0,
    });
    const shelfId = await this.repo.insertShelf(tx, {
      rackInternalId: toBigInt(rackId),
      code: shelfCode,
      levelNo: 1,
      sequenceNo: 0,
    });
    const binId = await this.repo.insertBin(tx, {
      shelfInternalId: toBigInt(shelfId),
      code: binCode,
      binType: 'storage',
      capacityQuantity: body.capacity ?? null,
      isPickFace: body.isPickFace ?? true,
    });
    const fullCode = generateLocationCode({
      zoneCode,
      aisleCode,
      rackCode,
      shelfCode,
      binCode,
    });
    return this.repo.insertLocation(tx, {
      warehouseInternalId,
      binInternalId: toBigInt(binId),
      fullCode: `${fullCode}-${code}`,
      barcode: body.barcode ?? `${fullCode}-${code}`,
      locationType: body.locationType ?? 'bin',
      pickPriority: body.pickPriority ?? 0,
      isPickable: true,
    });
  }

  private locationPlaceholder(
    warehouseInternalId: bigint,
    code: string,
    nodeType: string,
  ): Promise<LocationRow> {
    const synthetic: LocationRow = {
      internalId: '0',
      id: code.toUpperCase(),
      warehouseInternalId: warehouseInternalId.toString(),
      warehouseId: '',
      fullCode: code.toUpperCase(),
      barcode: null,
      locationType: nodeType,
      pickPriority: 0,
      isPickable: false,
      isActive: true,
      binInternalId: null,
      zoneCode: null,
      abcClass: null,
      capacityQuantity: null,
      version: 1,
    };
    return Promise.resolve(synthetic);
  }

  async updateLocation(ctx: TenantContext, publicId: string, body: UpdateLocationBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const row = await this.repo.findLocation(tx, ctx.orgId, publicId);
      if (row === null) throw notFound('location');
      const updated = await this.repo.updateLocation(tx, toBigInt(row.internalId), {
        barcode: body.barcode === undefined ? row.barcode : normalizeLocationBarcode(body.barcode, row.fullCode),
        pickPriority: body.pickPriority ?? row.pickPriority,
        isActive: body.status === undefined ? row.isActive : body.status === 'active',
        isPickable: body.isPickable ?? row.isPickable,
      });
      return locationView(updated);
    });
  }

  async deleteLocation(ctx: TenantContext, publicId: string): Promise<void> {
    await this.db.begin(async (tx) => {
      const row = await this.repo.findLocation(tx, ctx.orgId, publicId);
      if (row === null) throw notFound('location');
      if (await this.repo.locationHasStock(tx, toBigInt(row.internalId))) {
        throw new AppError('RULE_VIOLATION', {
          message: 'مکانی که موجودی دارد قابل حذف نیست.',
          messageKey: 'warehouse.location_has_stock',
          details: [{ rule: 'location_has_stock' }],
        });
      }
      await this.repo.softDeleteLocation(tx, toBigInt(row.internalId));
    });
  }

  // ============================================================== putaway

  async putawaySuggestions(ctx: TenantContext, query: PutawaySuggestionQuery): Promise<Record<string, unknown>> {
    const warehouse = await this.requireWarehouse(this.db, ctx, query.warehouseId);
    const variant = await this.catalog.requireVariant(ctx, query.variantId);
    const locations = await this.repo.listLocations(this.db, {
      orgId: ctx.orgId,
      warehouseInternalId: toBigInt(warehouse.internalId),
      locationType: null,
      search: null,
      limit: 500,
      offset: 0,
    });
    const candidates = locations
      .filter((location) => location.isPickable)
      .map((location) => ({
        locationId: location.id,
        fullCode: location.fullCode,
        abcClass: location.abcClass,
        freeCapacity: location.capacityQuantity,
        proximityScore: Math.max(0, 100 - Math.min(100, location.pickPriority)),
        isPickFace: location.isPickable,
        sameVariantQuantity: undefined,
        allowed: true,
      }));
    const suggestions = suggestPutaway(
      { variantAbcClass: suggestAbcForVariant(variant.sku), quantity: query.quantity },
      candidates,
    ).slice(0, 10);
    return { variantId: variant.id, suggestions };
  }

  async listPutawayTasks(ctx: TenantContext, warehousePublicId: string): Promise<Record<string, unknown>[]> {
    const warehouse = await this.requireWarehouse(this.db, ctx, warehousePublicId);
    void warehouse;
    return [];
  }

  // =============================================================== pick waves
  async listWaves(ctx: TenantContext, query: { limit: number; status?: string | undefined; warehouseId?: string | undefined }) {
    const warehouseInternalId =
      query.warehouseId === undefined ? null : toBigInt((await this.requireWarehouse(this.db, ctx, query.warehouseId)).internalId);
    const rows = await this.repo.listWaves(this.db, {
      orgId: ctx.orgId,
      status: query.status ?? null,
      warehouseInternalId,
      limit: query.limit,
    });
    return rows.map((row) => waveView(row));
  }

  async getWave(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    return this.getWaveInTx(this.db, ctx, publicId);
  }

  async createPickWave(ctx: TenantContext, body: CreatePickWaveBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const warehouse = await this.requireWarehouse(tx, ctx, body.warehouseId);
      const warehouseInternalId = toBigInt(warehouse.internalId);
      const waveNo = await this.repo.allocateWaveNo(tx, ctx.orgId);
      const wave = await this.repo.insertWave(tx, {
        warehouseInternalId,
        waveNo,
        strategy: body.strategy === 'fifo' || body.strategy === 'fefo' ? 'batch' : 'zone_batch',
        priority: body.priority ?? 0,
        plannedBy: ctx.actorId,
      });
      let taskCount = 0;
      for (const [orderIndex, orderId] of body.orderIds.entries()) {
        const order = await this.sales.getOrder(ctx, orderId);
        const status = String(order['status']);
        if (!['confirmed', 'allocated', 'picking'].includes(status)) {
          throw new AppError('DOCUMENT_STATE_INVALID', {
            message: 'سفارش انتخاب‌شده در وضعیت قابل موج‌برداری نیست.',
            messageKey: 'warehouse.order_not_allocated',
            details: [{ rule: 'order_not_allocated', params: { orderId, status } }],
          });
        }
        const orderInternalId = await this.sales.resolveOrderId(ctx, orderId);
        await this.repo.insertWaveOrder(tx, toBigInt(wave.internalId), orderInternalId, orderIndex + 1);
        const reservations = await this.inventory.listReservations(ctx, {
          limit: 500,
          status: 'active',
          sourceType: 'sales_order',
          // listReservations expects the internal key (see inventory.dto contract).
          sourceId: orderInternalId.toString(),
        });
        const grouped = new Map<string, { variantId: string; locationId: string; quantity: string }>();
        for (const reservation of reservations) {
          const variantId = String(reservation['variantId']);
          const locationId = String(reservation['locationId']);
          const key = `${variantId}:${locationId}`;
          const existing = grouped.get(key);
          const quantity = String(reservation['quantity']);
          grouped.set(key, {
            variantId,
            locationId,
            quantity: existing === undefined ? quantity : addQuantity(existing.quantity, quantity),
          });
        }
        for (const line of grouped.values()) {
          const [variant] = await this.catalog.findVariants(ctx, [line.variantId]);
          const location = await this.repo.findLocation(tx, ctx.orgId, line.locationId);
          if (variant === undefined || location === null) continue;
          await this.repo.insertPickTask(tx, {
            waveInternalId: toBigInt(wave.internalId),
            orderInternalId,
            variantInternalId: variant.internalId,
            locationInternalId: toBigInt(location.internalId),
            quantityRequired: line.quantity,
            sequenceNo: taskCount + 1,
          });
          taskCount += 1;
        }
      }
      const payload: WaveEventPayload = {
        waveId: wave.id,
        waveNo: wave.waveNo,
        warehouseId: wave.warehouseId,
        status: wave.status,
        orderCount: body.orderIds.length,
        taskCount,
      };
      await this.emit(tx, ctx, WAREHOUSE_EVENTS.waveCreated, 'pick_wave', toBigInt(wave.internalId), payload);
      await this.record(tx, ctx, 'warehouse.wave.create', 'pick_wave', wave.id, null, waveView(wave));
      return this.getWaveInTx(tx, ctx, wave.id);
    });
  }

  private async getWaveInTx(tx: Db, ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const wave = await this.repo.findWave(tx, ctx.orgId, publicId);
    if (wave === null) throw notFound('pick_wave');
    const tasks = await this.repo.listPickTasks(tx, {
      orgId: ctx.orgId,
      waveInternalId: toBigInt(wave.internalId),
      status: null,
      assignedTo: null,
      limit: 1000,
    });
    const route = assignPickRoute(tasks.map(toTaskLike));
    return {
      ...waveView(wave, tasks.map(pickTaskView)),
      route: route.map((task) => ({ taskId: task.taskId, locationCode: task.locationFullCode, routeStep: task.routeStep })),
    };
  }

  async releaseWave(ctx: TenantContext, publicId: string, body: ReleaseWaveBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const wave = await this.repo.findWave(tx, ctx.orgId, publicId);
      if (wave === null) throw notFound('pick_wave');
      if (wave.status !== 'planned') {
        throw new AppError('DOCUMENT_STATE_INVALID', { details: [{ rule: 'wave_not_planned' }] });
      }
      await this.repo.updateWaveStatus(tx, toBigInt(wave.internalId), { status: 'released', started: true });
      void body;
      const payload: WaveEventPayload = {
        waveId: wave.id,
        waveNo: wave.waveNo,
        warehouseId: wave.warehouseId,
        status: 'released',
        orderCount: (await this.repo.listWaveOrders(tx, toBigInt(wave.internalId))).length,
        taskCount: 0,
      };
      await this.emit(tx, ctx, WAREHOUSE_EVENTS.waveReleased, 'pick_wave', toBigInt(wave.internalId), payload);
      return this.getWaveInTx(tx, ctx, publicId);
    });
  }

  async cancelWave(ctx: TenantContext, publicId: string, reason: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const wave = await this.repo.findWave(tx, ctx.orgId, publicId);
      if (wave === null) throw notFound('pick_wave');
      if (!['planned', 'released'].includes(wave.status)) {
        throw new AppError('DOCUMENT_STATE_INVALID', { details: [{ rule: 'wave_not_cancellable' }] });
      }
      const tasks = await this.repo.listPickTasks(tx, {
        orgId: ctx.orgId,
        waveInternalId: toBigInt(wave.internalId),
        status: null,
        assignedTo: null,
        limit: 1000,
      });
      for (const task of tasks) {
        await this.repo.updatePickTask(tx, toBigInt(task.internalId), { status: 'cancelled' });
      }
      await this.repo.updateWaveStatus(tx, toBigInt(wave.internalId), { status: 'cancelled' });
      await this.record(tx, ctx, 'warehouse.wave.cancel', 'pick_wave', wave.id, waveView(wave), { status: 'cancelled', reason });
      return this.getWaveInTx(tx, ctx, publicId);
    });
  }

  // =============================================================== pick tasks

  async listPickTasks(ctx: TenantContext, query: { limit: number; status?: string | undefined; waveId?: string | undefined }) {
    const wave = query.waveId === undefined ? null : await this.repo.findWave(this.db, ctx.orgId, query.waveId);
    const rows = await this.repo.listPickTasks(this.db, {
      orgId: ctx.orgId,
      waveInternalId: wave === null ? null : toBigInt(wave.internalId),
      status: query.status ?? null,
      assignedTo: null,
      limit: query.limit,
    });
    return orderPickTasks(rows.map(toTaskLike)).map((task) => pickTaskView(task.task));
  }

  async getPickTask(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const task = await this.repo.findPickTask(this.db, ctx.orgId, publicId);
    if (task === null) throw notFound('pick_task');
    return pickTaskView(task);
  }

  async assignPickTask(ctx: TenantContext, publicId: string, body: AssignTaskBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const task = await this.repo.lockPickTask(tx, ctx.orgId, publicId);
      if (task === null) throw notFound('pick_task');
      const updated = await this.repo.updatePickTask(tx, toBigInt(task.internalId), {
        status: task.status,
        assignedTo: toBigInt(body.assigneeUserId),
      });
      return pickTaskView(updated);
    });
  }

  async startPickTask(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const task = await this.repo.lockPickTask(tx, ctx.orgId, publicId);
      if (task === null) throw notFound('pick_task');
      if (task.status === 'in_progress') {
        throw new AppError('RESOURCE_LOCKED', {
          message: 'این تسک توسط اپراتور دیگری در حال انجام است.',
          messageKey: 'warehouse.task_locked',
          details: [{ rule: 'task_locked' }],
        });
      }
      if (task.status !== 'pending') {
        throw new AppError('DOCUMENT_STATE_INVALID', { details: [{ rule: 'task_not_startable' }] });
      }
      const updated = await this.repo.updatePickTask(tx, toBigInt(task.internalId), {
        status: 'in_progress',
        started: true,
      });
      return pickTaskView(updated);
    });
  }

  /**
   * Two-stage scan verification: location barcode → variant barcode → quantity.
   * Rejections persist a `pick_scans` row with the specific rule and return
   * `RULE_VIOLATION` so the scanner UI can block the flow (`API.md` §4.5).
   */
  async scanPickTask(ctx: TenantContext, publicId: string, body: PickScanBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const task = await this.repo.lockPickTask(tx, ctx.orgId, publicId);
      if (task === null) throw notFound('pick_task');
      const resolved = await this.catalog.resolveBarcode(ctx, body.barcode);
      const resolvedVariantId = resolved === null ? null : resolved.variantId;
      const variantLookup =
        resolvedVariantId === null ? undefined : (await this.catalog.findVariants(ctx, [resolvedVariantId]))[0];
      const remaining = subQuantity(task.quantityRequired, task.quantityPicked);
      const verification = verifyScan({
        taskStatus: task.status as 'pending',
        scannedLocationCode: body.locationCode ?? null,
        expectedLocationCode: task.locationFullCode,
        scannedBarcode: body.barcode,
        expectedBarcode: task.barcode ?? '',
        scannedQuantity: body.quantity,
        remainingQuantity: remaining,
        resolvedVariantId,
        expectedVariantId: task.variantId,
      });
      if (!verification.accepted) {
        await this.repo.insertPickScan(tx, {
          taskInternalId: toBigInt(task.internalId),
          barcode: body.barcode,
          expectedBarcode: task.barcode,
          variantInternalId: variantLookup?.internalId ?? null,
          quantity: body.quantity,
          result:
            verification.rule === 'wrong_location'
              ? 'rejected_wrong_location'
              : 'rejected_wrong_item',
          scannedBy: ctx.actorId ?? 0n,
          scanSource: body.scanSource ?? 'scanner',
          clientScanId: body.eventId ?? null,
        });
        throw new AppError('RULE_VIOLATION', {
          message: verification.messageFa ?? 'اسکن با انتظار تسک همخوانی ندارد.',
          messageKey: `warehouse.${verification.rule ?? 'scan_rejected'}`,
          details: [{ rule: verification.rule ?? 'scan_rejected', params: { taskId: task.id } }],
        });
      }
      await this.repo.insertPickScan(tx, {
        taskInternalId: toBigInt(task.internalId),
        barcode: body.barcode,
        expectedBarcode: task.barcode,
        variantInternalId: variantLookup?.internalId ?? null,
        quantity: body.quantity,
        result: 'accepted',
        scannedBy: ctx.actorId ?? 0n,
        scanSource: body.scanSource ?? 'scanner',
        clientScanId: body.eventId ?? null,
      });
      const picked = addQuantity(task.quantityPicked, body.quantity);
      const isComplete = compareQuantity(picked, task.quantityRequired) >= 0;
      const updated = await this.repo.updatePickTask(tx, toBigInt(task.internalId), {
        status: isComplete ? 'picked' : 'in_progress',
        quantityPicked: picked,
        completed: isComplete,
      });
      await this.emit(tx, ctx, WAREHOUSE_EVENTS.pickScanAccepted, 'pick_task', toBigInt(task.internalId), {
        taskId: task.id,
        barcode: body.barcode,
        quantity: body.quantity,
        result: 'accepted',
      });
      return pickTaskView(updated);
    });
  }

  async completePickTask(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const task = await this.repo.lockPickTask(tx, ctx.orgId, publicId);
      if (task === null) throw notFound('pick_task');
      if (task.status !== 'in_progress') {
        throw new AppError('DOCUMENT_STATE_INVALID', { details: [{ rule: 'task_not_in_progress' }] });
      }
      if (compareQuantity(task.quantityPicked, task.quantityRequired) < 0) {
        throw new AppError('DOCUMENT_STATE_INVALID', {
          message: 'برداشت ناقص است؛ از ثبت برداشت کوتاه (/short) استفاده کنید.',
          messageKey: 'warehouse.pick_short_required',
          details: [{ rule: 'pick_short_required', params: { required: task.quantityRequired, picked: task.quantityPicked } }],
        });
      }
      const updated = await this.repo.updatePickTask(tx, toBigInt(task.internalId), {
        status: 'picked',
        completed: true,
      });
      const payload: PickTaskEventPayload = {
        taskId: task.id,
        waveId: task.waveId,
        orderId: task.orderId,
        variantId: task.variantId,
        locationId: task.locationId,
        quantityRequired: task.quantityRequired,
        quantityPicked: task.quantityPicked,
        status: 'picked',
      };
      await this.emit(tx, ctx, WAREHOUSE_EVENTS.pickTaskCompleted, 'pick_task', toBigInt(task.internalId), payload);
      return pickTaskView(updated);
    });
  }

  async shortPickTask(ctx: TenantContext, publicId: string, body: { lines: readonly { lineId: string; pickedQuantity: string; reason: string }[] }): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const task = await this.repo.lockPickTask(tx, ctx.orgId, publicId);
      if (task === null) throw notFound('pick_task');
      const line = body.lines[0];
      const updated = await this.repo.updatePickTask(tx, toBigInt(task.internalId), {
        status: 'short',
        quantityPicked: line?.pickedQuantity ?? task.quantityPicked,
        completed: true,
      });
      await this.emit(tx, ctx, WAREHOUSE_EVENTS.pickTaskShort, 'pick_task', toBigInt(task.internalId), {
        taskId: task.id,
        reason: line?.reason ?? '',
      });
      return pickTaskView(updated);
    });
  }

  async cancelPickTask(ctx: TenantContext, publicId: string, reason: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const task = await this.repo.lockPickTask(tx, ctx.orgId, publicId);
      if (task === null) throw notFound('pick_task');
      if (task.status === 'picked') {
        throw new AppError('DOCUMENT_STATE_INVALID', { details: [{ rule: 'task_already_picked' }] });
      }
      await this.repo.updatePickTask(tx, toBigInt(task.internalId), { status: 'cancelled' });
      await this.record(tx, ctx, 'warehouse.pick.cancel', 'pick_task', task.id, pickTaskView(task), { status: 'cancelled', reason });
      return this.getPickTask(ctx, publicId);
    });
  }

  // ================================================================ helpers

  private async requireWarehouse(tx: Db, ctx: TenantContext, publicId: string): Promise<WarehouseRow> {
    const row = await this.repo.findWarehouse(tx, ctx.orgId, publicId);
    if (row === null) throw notFound('warehouse');
    return row;
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

// ---------------------------------------------------------------- small utils

interface TaskLike {
  taskId: string;
  locationFullCode: string;
  pickPriority: number;
  sequenceNo: number;
  task: PickTaskRow;
}

function toTaskLike(row: PickTaskRow): TaskLike {
  return {
    taskId: row.id,
    locationFullCode: row.locationFullCode,
    pickPriority: row.pickPriority,
    sequenceNo: row.sequenceNo,
    task: row,
  };
}

function suggestAbcForVariant(sku: string): string | null {
  // Deterministic ABC heuristic by SKU hash; replaced by sales-velocity class once
  // the automation module computes the real ABC classification.
  let hash = 0;
  for (const char of sku) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return hash % 3 === 0 ? 'A' : hash % 3 === 1 ? 'B' : 'C';
}

export { labelNumber };
