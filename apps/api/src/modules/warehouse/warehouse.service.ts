/**
 * Warehouse application service (`API.md` §4.5): location tree, putaway
 * suggestions, pick-wave planning, pick-task execution with two-stage scan
 * verification. Reservations/stock come from `InventoryService`; orders from
 * `SalesService` — never their tables.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError } from '@saman/shared';

import { AUDIT, DB, EVENT_BUS, type AuditPort, type Db as ContractDb, type EventPort, type TenantContext } from '../../common/contracts';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ScopeService } from '../../common/scope/scope.service';
import { ChannelAccountService } from '../channels/services/channel-accounts.service';
import { CatalogLookupService } from '../catalog/product.service';
import { InventoryService } from '../inventory/inventory.service';
import { addQuantity, compareQuantity, subQuantity } from '../inventory/engines/quantity.engine';
import { SalesService } from '../sales/sales.service';
import type { Db } from './warehouse.pg-support';
import { notFound, toBigInt } from './warehouse.pg-support';
import { PickAssignmentService } from './pick-assignment.service';
import { WarehouseRepository } from './warehouse.repository';
import { type LocationRow, type MyPickTaskRow, type PackTaskRow, type PickBoardDiagnosticsRow, type PickBoardTaskRow, type PickTaskBarcodeRow, type PickTaskRow, type PickWaveRow, type ScanLookupRow, type WarehouseRow } from './warehouse.repository';
import { WAREHOUSE_EVENTS, type PickTaskEventPayload, type WaveEventPayload } from './warehouse.events';
import { assertValidLocationParent, assignPickRoute, generateLocationCode, labelNumber, normalizeLocationBarcode, orderPickTasks, suggestPutaway, verifyScan, type LocationNodeType } from './engines/location.engine';
import type {
  AssignTaskBody,
  BulkCreateLocationsBody,
  CreatePickWaveBody,
  CreateWarehouseBody,
  LocationNodeInput,
  PackTaskCompleteBody,
  PickScanBody,
  PickTaskAssignBody,
  PutawaySuggestionQuery,
  ReleaseWaveBody,
  StationPickCompleteBody,
  StationPickScanBody,
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
    orderNo: row.orderNo,
    variantId: row.variantId,
    locationId: row.locationId,
    locationCode: row.locationFullCode,
    quantityRequired: row.quantityRequired,
    quantityPicked: row.quantityPicked,
    sequenceNo: row.sequenceNo,
    status: row.status,
    assignedTo: row.assignedTo,
    assignedToName: row.assignedToName,
    sku: row.sku,
    title: row.title,
    barcode: row.barcode,
    createdAt: row.createdAt,
    ageMinutes: row.ageMinutes,
  };
}

function myPickTaskView(row: MyPickTaskRow): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    orderNo: row.orderNo,
    channelCode: row.channelCode,
    sku: row.sku,
    title: row.title,
    productName: row.productName,
    variantSku: row.variantSku,
    imageUrl: row.imageUrl,
    quantity: row.quantity,
    quantityRequired: row.quantityRequired,
    quantityPicked: row.quantityPicked,
    locationCode: row.locationCode,
    sequenceNo: row.sequenceNo,
    assignedTo: row.assignedTo,
    assignedToName: row.assignedToName,
    createdAt: row.createdAt,
    ageMinutes: row.ageMinutes,
  };
}

function pickBoardTaskView(row: PickBoardTaskRow): Record<string, unknown> {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNo: row.orderNo,
    channelCode: row.channelCode,
    orderStatus: row.orderStatus,
    fulfillmentStatus: row.fulfillmentStatus,
    waveId: row.waveId,
    waveNo: row.waveNo,
    sku: row.sku,
    title: row.title,
    productName: row.productName,
    variantSku: row.variantSku,
    imageUrl: row.imageUrl,
    quantityRequired: row.quantityRequired,
    quantityPicked: row.quantityPicked,
    locationCode: row.locationCode,
    sequenceNo: row.sequenceNo,
    status: row.status,
    assignedTo: row.assignedTo,
    assignedToName: row.assignedToName,
    createdAt: row.createdAt,
    ageMinutes: row.ageMinutes,
  };
}

type PackHandling = 'digikala_warehouse' | 'ship_to_customer';

/**
 * Who receives the packed goods: Digikala orders are delivered to a Digikala
 * warehouse (Digikala issues its own shipment barcode, so the ERP must never
 * print a customer label); Carexy/ERP orders ship to the customer address.
 */
function packHandling(channelCode: string | null): PackHandling {
  return channelCode === 'digikala' ? 'digikala_warehouse' : 'ship_to_customer';
}

function packTaskView(row: PackTaskRow): Record<string, unknown> {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNo: row.orderNo,
    channelCode: row.channelCode,
    handling: packHandling(row.channelCode),
    fulfillmentStatus: row.fulfillmentStatus,
    packageNo: row.packageNo,
    status: row.status,
    assignedTo: row.assignedTo,
    assignedToName: row.assignedToName,
    notes: row.notes,
    itemCount: row.itemCount,
    totalQuantity: row.totalQuantity,
    items: row.items,
    address: row.address,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt,
    ageMinutes: row.ageMinutes,
  };
}

/** Shipping address keys the packing label/card can use (channel payloads vary). */
const ADDRESS_NAME_KEYS = ['receiverName', 'recipientName', 'receiver_name', 'recipient', 'name'] as const;
const ADDRESS_PHONE_KEYS = ['receiverMobile', 'receiverPhone', 'mobile', 'phone', 'receiver_mobile'] as const;
const ADDRESS_LINE_KEYS = ['line1', 'addressLine', 'address_line', 'address', 'line'] as const;

function pickAddressString(address: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (address === null) return null;
  for (const key of keys) {
    const value = address[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** Single printable line built from the structured shipping address. */
function formatAddressText(address: Record<string, unknown> | null): string | null {
  if (address === null) return null;
  const parts: string[] = [];
  const line = pickAddressString(address, ADDRESS_LINE_KEYS);
  if (line !== null) parts.push(line);
  for (const key of ['district', 'city', 'province']) {
    const value = address[key];
    if (typeof value === 'string' && value.trim().length > 0) parts.push(value.trim());
  }
  const postal = address['postalCode'] ?? address['postal_code'];
  if (typeof postal === 'string' && postal.trim().length > 0) parts.push(`کد پستی ${postal.trim()}`);
  return parts.length > 0 ? parts.join('، ') : null;
}

/** Shape returned by `GET /scan/lookup`. */
function scanLookupView(row: ScanLookupRow): Record<string, unknown> {
  return {
    type: row.kind,
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    imageUrl: row.imageUrl,
    url: row.url,
  };
}

interface PickOrderGroup {
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly orderStatus: string;
  readonly fulfillmentStatus: string;
  readonly waveNo: string | null;
  readonly taskCount: number;
  readonly openCount: number;
  readonly assigneeNames: readonly string[];
  readonly oldestAgeMinutes: number;
  readonly tasks: readonly Record<string, unknown>[];
}

/** Groups flat board rows by order (the station shows one header per order). */
function groupPickBoardRows(rows: readonly PickBoardTaskRow[]): PickOrderGroup[] {
  const groups = new Map<string, { orderId: string; orderNo: string | null; orderStatus: string; fulfillmentStatus: string; waveNo: string | null; tasks: Record<string, unknown>[]; assignees: Set<string>; oldest: number }>();
  for (const row of rows) {
    const key = row.orderId.length > 0 ? row.orderId : row.orderInternalId;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        orderId: key,
        orderNo: row.orderNo,
        orderStatus: row.orderStatus,
        fulfillmentStatus: row.fulfillmentStatus,
        waveNo: row.waveNo,
        tasks: [],
        assignees: new Set<string>(),
        oldest: row.ageMinutes,
      };
      groups.set(key, group);
    }
    group.tasks.push(pickBoardTaskView(row));
    if (row.assignedToName !== null) group.assignees.add(row.assignedToName);
    group.oldest = Math.max(group.oldest, row.ageMinutes);
  }
  return [...groups.values()].map((group) => ({
    orderId: group.orderId,
    orderNo: group.orderNo,
    orderStatus: group.orderStatus,
    fulfillmentStatus: group.fulfillmentStatus,
    waveNo: group.waveNo,
    taskCount: group.tasks.length,
    openCount: group.tasks.filter((task) => task['status'] !== 'picked').length,
    assigneeNames: [...group.assignees],
    oldestAgeMinutes: group.oldest,
    tasks: group.tasks,
  }));
}

function isUndefinedTable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '42P01'
  );
}

/**
 * Barcodes that identify a task's item, most specific first: the variant
 * barcode, its active `product_barcodes`, then the sales-order-line SKU
 * snapshot (what the channel actually shipped). De-duplicated, blanks dropped.
 */
function pickTaskBarcodeCandidates(
  row: PickTaskBarcodeRow | null,
  task: PickTaskRow,
): string[] {
  const candidates: string[] = [];
  const push = (value: string | null | undefined): void => {
    const trimmed = value?.trim() ?? '';
    if (trimmed.length > 0 && !candidates.includes(trimmed)) candidates.push(trimmed);
  };
  push(row?.variantBarcode ?? null);
  for (const barcode of row?.barcodes ?? []) push(barcode);
  push(row?.sku ?? null);
  push(task.barcode);
  push(task.sku);
  return candidates;
}

/**
 * Full-barcode scan is the primary path; the last 3 characters typed by the
 * operator are the fallback (`barcode.endsWith(input)`, case-insensitive).
 * Shorter typed inputs are not accepted as a suffix, so `"1"` cannot match
 * every barcode that happens to end with it.
 */
function matchTaskBarcode(candidates: readonly string[], input: string): string | null {
  const value = input.trim().toLowerCase();
  if (value.length === 0) return null;
  const exact = candidates.find((candidate) => candidate.toLowerCase() === value);
  if (exact !== undefined) return exact;
  if (value.length < 3) return null;
  return candidates.find((candidate) => candidate.toLowerCase().endsWith(value)) ?? null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PACK_TABLE_MISSING_MESSAGE =
  'جدول تسک‌های بسته‌بندی (erp.pack_tasks) هنوز ساخته نشده است؛ مهاجرت مربوطه باید اعمال شود.';

@Injectable()
export class WarehouseService {
  private readonly logger = new Logger(WarehouseService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: WarehouseRepository,
    private readonly catalog: CatalogLookupService,
    private readonly inventory: InventoryService,
    private readonly sales: SalesService,
    private readonly channelAccounts: ChannelAccountService,
    private readonly pickAssignment: PickAssignmentService,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
    private readonly scopes: ScopeService,
  ) {}

  // ============================================================= warehouses

  async listWarehouses(ctx: TenantContext, query: { page: number; perPage: number; status?: string | undefined; q?: string | undefined }) {
    const warehouseIds = this.scopes.visibleWarehouseIds(this.scopes.forContext(ctx));
    if (warehouseIds !== null && warehouseIds.length === 0) return [];
    const rows = await this.repo.listWarehouses(this.db, {
      orgId: ctx.orgId,
      status: query.status === undefined ? null : query.status === 'active',
      branchInternalId: null,
      search: query.q ?? null,
      warehouseIds,
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
    // Code lookup is not id-addressed, so the guard cannot see the warehouse:
    // check it here before returning another warehouse's location.
    this.scopes.assertWarehouse(this.scopes.forContext(ctx), row.warehouseInternalId);
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
    const warehouseIds = this.scopes.visibleWarehouseIds(this.scopes.forContext(ctx));
    if (warehouseIds !== null && warehouseIds.length === 0) return [];
    const wave = query.waveId === undefined ? null : await this.repo.findWave(this.db, ctx.orgId, query.waveId);
    const rows = await this.repo.listPickTasks(this.db, {
      orgId: ctx.orgId,
      waveInternalId: wave === null ? null : toBigInt(wave.internalId),
      status: query.status ?? null,
      assignedTo: null,
      warehouseIds,
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

  /** Open tasks for the caller's picking station (`GET warehouse/pick-tasks/mine`). */
  async listMyPickTasks(ctx: TenantContext, limit: number): Promise<Record<string, unknown>[]> {
    if (ctx.actorId === null) return [];
    const warehouseIds = this.scopes.visibleWarehouseIds(this.scopes.forContext(ctx));
    if (warehouseIds !== null && warehouseIds.length === 0) return [];
    const rows = await this.repo.listMyPickTasks(this.db, {
      orgId: ctx.orgId,
      assignedTo: ctx.actorId,
      warehouseIds,
      limit,
    });
    return rows.map(myPickTaskView);
  }

  /** Manual reassignment / release (`PATCH warehouse/pick-tasks/:id/assign`). */
  async reassignPickTask(
    ctx: TenantContext,
    publicId: string,
    body: PickTaskAssignBody,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const task = await this.repo.lockPickTask(tx, ctx.orgId, publicId);
      if (task === null) throw notFound('pick_task');
      let assignedTo: bigint | null = null;
      if (body.userId !== undefined) {
        assignedTo = await this.repo.findActiveUserId(tx, ctx.orgId, body.userId);
        if (assignedTo === null) throw notFound('user');
      }
      const updated = await this.repo.assignPickTask(tx, ctx.orgId, publicId, assignedTo);
      if (updated === null) throw notFound('pick_task');
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
        // Claim an unassigned task for the operator who actually starts it.
        ...(ctx.actorId === null ? {} : { assignedTo: ctx.actorId }),
      });
      await this.emit(tx, ctx, WAREHOUSE_EVENTS.pickTaskStarted, 'pick_task', toBigInt(task.internalId), {
        taskId: task.id,
        orderId: task.orderId,
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
      // A fully scanned order must reach the packing station even when the
      // operator never presses "complete".
      const completion = isComplete ? await this.settleOrderIfPicked(tx, ctx, task, updated) : null;
      await this.emit(tx, ctx, WAREHOUSE_EVENTS.pickScanAccepted, 'pick_task', toBigInt(task.internalId), {
        taskId: task.id,
        barcode: body.barcode,
        quantity: body.quantity,
        result: 'accepted',
      });
      return { ...pickTaskView(updated), ...(completion ?? {}) };
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

  // ============================================================ pick station

  /**
   * `GET warehouse/pick-tasks/board` — every open pick task of the organization
   * grouped by order, plus the counters that explain an empty board.
   */
  async pickTaskBoard(ctx: TenantContext, limit = 200): Promise<Record<string, unknown>> {
    const warehouseIds = this.scopes.visibleWarehouseIds(this.scopes.forContext(ctx));
    if (warehouseIds !== null && warehouseIds.length === 0) {
      return {
        generatedAt: new Date().toISOString(),
        summary: { openTasks: 0, pending: 0, inProgress: 0, orders: 0, unassigned: 0, oldestAgeMinutes: 0, truncated: false },
        diagnostics: null,
        orders: [],
        tasks: [],
      };
    }
    const [rows, diagnostics]: [PickBoardTaskRow[], PickBoardDiagnosticsRow] = await Promise.all([
      this.repo.listPickBoard(this.db, { orgId: ctx.orgId, warehouseIds, limit }),
      this.repo.pickBoardDiagnostics(this.db, { orgId: ctx.orgId }),
    ]);
    const tasks = rows.map(pickBoardTaskView);
    const summary = {
      openTasks: rows.length,
      pending: rows.filter((row) => row.status === 'pending').length,
      inProgress: rows.filter((row) => row.status === 'in_progress').length,
      orders: new Set(rows.map((row) => (row.orderId.length > 0 ? row.orderId : row.orderInternalId))).size,
      unassigned: rows.filter((row) => row.assignedTo === null).length,
      oldestAgeMinutes: rows.reduce((oldest, row) => Math.max(oldest, row.ageMinutes), 0),
      truncated: rows.length >= limit,
    };
    return {
      generatedAt: new Date().toISOString(),
      summary,
      diagnostics,
      orders: groupPickBoardRows(rows),
      tasks,
    };
  }

  /**
   * Creates the missing pick tasks for orders that already have lines.
   *
   * Auto-assignment normally runs on the materialisation event; orders whose
   * lines arrived later (or before the picker permission was fixed) would
   * otherwise stay invisible on the station forever.
   */
  async backfillPickTasks(ctx: TenantContext, limit = 50): Promise<Record<string, unknown>> {
    const candidates = await this.repo.listOrdersAwaitingPickTasks(this.db, { orgId: ctx.orgId, limit });
    let tasksCreated = 0;
    const orders: Record<string, unknown>[] = [];
    for (const candidate of candidates) {
      const created = await this.pickAssignment.assignOrderPickTasks({
        orgId: ctx.orgId,
        orderInternalId: toBigInt(candidate.internalId),
      });
      tasksCreated += created;
      orders.push({ orderId: candidate.orderId, orderNo: candidate.orderNo, tasksCreated: created });
    }
    this.logger.log(
      `pick backfill in org ${ctx.orgId.toString()}: ${tasksCreated.toString()} task(s) for ${candidates.length.toString()} order(s)`,
    );
    return { ordersChecked: candidates.length, tasksCreated, orders };
  }

  /**
   * `POST warehouse/pick-tasks/:id/complete` — the operator confirms the picked
   * quantity. When the last open task of the order is completed the order
   * becomes `picked` and a `pack_tasks` row is created for the packing station.
   */
  async completeStationPickTask(
    ctx: TenantContext,
    publicId: string,
    body: StationPickCompleteBody,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const task = await this.repo.lockPickTask(tx, ctx.orgId, publicId);
      if (task === null) throw notFound('pick_task');
      if (task.status === 'picked' || task.status === 'short') {
        // Idempotent double-click: report the settled task, create nothing.
        return { task: pickTaskView(task), orderComplete: false, packTask: null, alreadyCompleted: true };
      }
      if (task.status !== 'pending' && task.status !== 'in_progress') {
        throw new AppError('DOCUMENT_STATE_INVALID', {
          message: 'این تسک قابل تکمیل نیست.',
          details: [{ rule: 'task_not_completable', params: { status: task.status } }],
        });
      }
      this.assertPickScanMatches(task, body.scannedBarcode);
      const quantity = body.quantityPicked ?? task.quantityRequired;
      if (compareQuantity(quantity, '0') <= 0) {
        throw new AppError('RULE_VIOLATION', {
          message: 'مقدار برداشت باید بزرگ‌تر از صفر باشد.',
          messageKey: 'warehouse.quantity_must_be_positive',
          details: [{ rule: 'quantity_must_be_positive' }],
        });
      }
      if (compareQuantity(quantity, task.quantityRequired) > 0) {
        throw new AppError('RULE_VIOLATION', {
          message: 'مقدار برداشت از مقدار موردنیاز تسک بیشتر است.',
          messageKey: 'warehouse.quantity_exceeds_required',
          details: [{ rule: 'quantity_exceeds_required', params: { required: task.quantityRequired, picked: quantity } }],
        });
      }
      if (compareQuantity(quantity, task.quantityRequired) < 0) {
        // Partial picks are a documented `short` flow, not a completed line.
        throw new AppError('DOCUMENT_STATE_INVALID', {
          message: 'برداشت ناقص است؛ مقدار کامل را ثبت کنید یا از ثبت برداشت کوتاه استفاده کنید.',
          messageKey: 'warehouse.pick_short_required',
          details: [{ rule: 'pick_short_required', params: { required: task.quantityRequired, picked: quantity } }],
        });
      }
      return this.settleStationTask(tx, ctx, task, quantity);
    });
  }

  /**
   * `POST warehouse/pick-tasks/:id/scan` — barcode-first picking. The scan
   * resolves the item's barcode (variant barcode, `product_barcodes` or the
   * sales-order-line SKU snapshot) and accepts either the full barcode or its
   * last 3 characters (the operator's typed fallback). A match completes the
   * task through the same settlement path as `/complete`, so it also creates the
   * order's pack task; a mismatch is a 422 `barcode_mismatch` that names the
   * expected 3-character suffix.
   */
  async scanStationPickTask(
    ctx: TenantContext,
    publicId: string,
    body: StationPickScanBody,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const task = await this.repo.lockPickTask(tx, ctx.orgId, publicId);
      if (task === null) throw notFound('pick_task');
      if (task.status === 'picked' || task.status === 'short') {
        return {
          matched: true,
          barcode: task.barcode ?? body.barcode.trim(),
          task: pickTaskView(task),
          orderComplete: false,
          packTask: null,
          alreadyCompleted: true,
        };
      }
      if (task.status !== 'pending' && task.status !== 'in_progress') {
        throw new AppError('DOCUMENT_STATE_INVALID', {
          message: 'این تسک قابل تکمیل نیست.',
          details: [{ rule: 'task_not_completable', params: { status: task.status } }],
        });
      }
      const barcodeRow = await this.repo.findPickTaskBarcodes(tx, toBigInt(task.internalId));
      const candidates = pickTaskBarcodeCandidates(barcodeRow, task);
      const variantInternalId = task.variantInternalId.length > 0 ? toBigInt(task.variantInternalId) : null;
      const matched = matchTaskBarcode(candidates, body.barcode);
      if (matched === null) {
        const expected = candidates[0] ?? null;
        await this.repo.insertPickScan(tx, {
          taskInternalId: toBigInt(task.internalId),
          barcode: body.barcode.trim(),
          expectedBarcode: expected,
          variantInternalId,
          quantity: task.quantityRequired,
          result: 'rejected_wrong_item',
          scannedBy: ctx.actorId ?? 0n,
          scanSource: 'scanner',
          clientScanId: null,
        });
        throw new AppError('RULE_VIOLATION', {
          message:
            expected === null
              ? 'بارکد اسکن‌شده با کالای این تسک یکسان نیست.'
              : `بارکد اسکن‌شده با کالای این تسک یکسان نیست؛ ۳ رقم آخر «${expected.slice(-3)}» است.`,
          messageKey: 'warehouse.barcode_mismatch',
          details: [
            {
              rule: 'barcode_mismatch',
              params: {
                taskId: task.id,
                expectedSuffix: expected === null ? null : expected.slice(-3),
              },
            },
          ],
        });
      }
      await this.repo.insertPickScan(tx, {
        taskInternalId: toBigInt(task.internalId),
        barcode: body.barcode.trim(),
        expectedBarcode: matched,
        variantInternalId,
        quantity: task.quantityRequired,
        result: 'accepted',
        scannedBy: ctx.actorId ?? 0n,
        scanSource: 'scanner',
        clientScanId: null,
      });
      const completion = await this.settleStationTask(tx, ctx, task, task.quantityRequired);
      return { matched: true, barcode: matched, ...completion };
    });
  }

  /**
   * Single settlement path for a station pick (manual `complete` and a matching
   * `scan` both end here): task `picked` + full quantity, order settlement and
   * pack-task creation when no open task is left.
   */
  private async settleStationTask(
    tx: Db,
    ctx: TenantContext,
    task: PickTaskRow,
    quantity: string,
  ): Promise<{ task: Record<string, unknown>; orderComplete: boolean; packTask: Record<string, unknown> | null }> {
    const updated = await this.repo.updatePickTask(tx, toBigInt(task.internalId), {
      status: 'picked',
      quantityPicked: quantity,
      completed: true,
      assignedTo: ctx.actorId,
    });
    const completion = await this.settleOrderIfPicked(tx, ctx, task, updated);
    const payload: PickTaskEventPayload = {
      taskId: task.id,
      waveId: task.waveId,
      orderId: task.orderId,
      variantId: task.variantId,
      locationId: task.locationId,
      quantityRequired: task.quantityRequired,
      quantityPicked: quantity,
      status: 'picked',
    };
    await this.emit(tx, ctx, WAREHOUSE_EVENTS.pickTaskCompleted, 'pick_task', toBigInt(task.internalId), payload);
    return { task: pickTaskView(updated), ...completion };
  }

  /**
   * Marks the order `picked` and creates its pack task once no open pick task is
   * left. Idempotent and tolerant of a missing `pack_tasks` migration: a
   * missing table is logged, never allowed to break picking.
   */
  private async settleOrderIfPicked(
    tx: Db,
    ctx: TenantContext,
    task: PickTaskRow,
    updated: PickTaskRow,
  ): Promise<{ orderComplete: boolean; packTask: Record<string, unknown> | null }> {
    const orderInternalId = toBigInt(task.orderInternalId);
    const open = await this.repo.countOpenOrderPickTasks(tx, orderInternalId);
    if (open > 0) {
      return { orderComplete: false, packTask: null };
    }
    await this.repo.setOrderFulfillmentStatus(tx, ctx.orgId, orderInternalId, 'picked');
    const packTask = await this.createPackTaskForOrder(tx, ctx, updated);
    return { orderComplete: true, packTask: packTask === null ? null : packTaskView(packTask) };
  }

  private async createPackTaskForOrder(tx: Db, ctx: TenantContext, task: PickTaskRow): Promise<PackTaskRow | null> {
    const orderInternalId = toBigInt(task.orderInternalId);
    try {
      const existing = await this.repo.findOpenPackTaskForOrder(tx, ctx.orgId, orderInternalId);
      if (existing !== null) return existing;
      const count = await this.repo.countPackTasksForOrder(tx, ctx.orgId, orderInternalId);
      // An order that already has a settled pack task is not packed twice.
      if (count > 0) return null;
      const packTask = await this.repo.insertPackTask(tx, {
        orgId: ctx.orgId,
        orderInternalId,
        packageNo: this.buildPackageNo(task.orderNo, count + 1),
        assignedTo: null,
        notes: 'به‌صورت خودکار پس از تکمیل برداشت سفارش ساخته شد',
      });
      if (packTask !== null) {
        await this.emit(tx, ctx, WAREHOUSE_EVENTS.packTaskCreated, 'pack_task', toBigInt(packTask.internalId), {
          packTaskId: packTask.id,
          orderId: task.orderId,
        });
      }
      return packTask;
    } catch (error) {
      if (!isUndefinedTable(error)) throw error;
      this.logger.warn(
        `pack task for order ${task.orderId} was not created: ${PACK_TABLE_MISSING_MESSAGE}`,
      );
      return null;
    }
  }

  private assertPickScanMatches(task: PickTaskRow, scanned: string | undefined): void {
    if (scanned === undefined) return;
    const value = scanned.trim().toLowerCase();
    if (value.length === 0) return;
    const candidates = [task.barcode, task.sku]
      .filter((candidate): candidate is string => candidate !== null && candidate.trim().length > 0)
      .map((candidate) => candidate.trim().toLowerCase());
    if (!candidates.includes(value)) {
      throw new AppError('RULE_VIOLATION', {
        message: 'بارکد اسکن‌شده با کالای این تسک یکسان نیست.',
        messageKey: 'warehouse.barcode_mismatch',
        details: [{ rule: 'barcode_mismatch', params: { taskId: task.id } }],
      });
    }
  }

  private buildPackageNo(orderNo: string | null, sequence: number): string {
    const prefix = (orderNo ?? 'ORD').replace(/[^A-Za-z0-9-]/g, '').slice(0, 32) || 'ORD';
    return `${prefix}-P${sequence}`.slice(0, 40);
  }

  // ============================================================ pack station

  /** `GET warehouse/pack-tasks/board` — open pack tasks plus empty-state counters. */
  async packTaskBoard(ctx: TenantContext, limit = 200): Promise<Record<string, unknown>> {
    try {
      const warehouseIds = this.scopes.visibleWarehouseIds(this.scopes.forContext(ctx));
      if (warehouseIds !== null && warehouseIds.length === 0) {
        return {
          generatedAt: new Date().toISOString(),
          tableReady: true,
          summary: { openTasks: 0, pending: 0, packing: 0, packed: 0, unassigned: 0, oldestAgeMinutes: 0, truncated: false },
          diagnostics: { tasksTotal: 0, pending: 0, packing: 0, packed: 0, pickedOrders: 0, pickedOrdersWithoutPackTask: 0, pickedTasks: 0 },
          tasks: [],
        };
      }
      const rows = await this.repo.listPackBoard(this.db, { orgId: ctx.orgId, warehouseIds, limit });
      const diagnostics = await this.repo.packBoardDiagnostics(this.db, { orgId: ctx.orgId });
      return {
        generatedAt: new Date().toISOString(),
        tableReady: true,
        summary: {
          openTasks: rows.length,
          pending: rows.filter((row) => row.status === 'pending').length,
          packing: rows.filter((row) => row.status === 'packing').length,
          packed: diagnostics.packed,
          unassigned: rows.filter((row) => row.assignedTo === null).length,
          oldestAgeMinutes: rows.reduce((oldest, row) => Math.max(oldest, row.ageMinutes), 0),
          truncated: rows.length >= limit,
        },
        diagnostics,
        tasks: rows.map(packTaskView),
      };
    } catch (error) {
      if (!isUndefinedTable(error)) throw error;
      this.logger.warn(PACK_TABLE_MISSING_MESSAGE);
      return {
        generatedAt: new Date().toISOString(),
        tableReady: false,
        warning: PACK_TABLE_MISSING_MESSAGE,
        summary: {
          openTasks: 0,
          pending: 0,
          packing: 0,
          packed: 0,
          unassigned: 0,
          oldestAgeMinutes: 0,
          truncated: false,
        },
        diagnostics: {
          tasksTotal: 0,
          pending: 0,
          packing: 0,
          packed: 0,
          pickedOrders: 0,
          pickedOrdersWithoutPackTask: 0,
          pickedTasks: 0,
        },
        tasks: [],
      };
    }
  }

  async startPackTask(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    return this.packTable(() =>
      this.db.begin(async (tx) => {
        const task = await this.repo.lockPackTask(tx, ctx.orgId, publicId);
        if (task === null) throw notFound('pack_task');
        if (task.status === 'packing') return packTaskView(task);
        if (task.status !== 'pending') {
          throw new AppError('DOCUMENT_STATE_INVALID', {
            message: 'این تسک بسته‌بندی قابل شروع نیست.',
            details: [{ rule: 'task_not_startable', params: { status: task.status } }],
          });
        }
        const updated = await this.repo.updatePackTask(tx, toBigInt(task.internalId), {
          status: 'packing',
          ...(ctx.actorId === null ? {} : { assignedTo: ctx.actorId }),
        });
        await this.emit(tx, ctx, WAREHOUSE_EVENTS.packTaskStarted, 'pack_task', toBigInt(task.internalId), {
          packTaskId: task.id,
          orderId: task.orderId,
        });
        return packTaskView(updated);
      }),
    );
  }

  /**
   * `POST warehouse/pack-tasks/:id/complete` → task `packed`, order
   * `ready_to_ship`, then a best-effort channel ready-to-ship notification
   * (skipped silently when the adapter does not support it).
   *
   * Channel-aware label rule: a Digikala order is delivered to a Digikala
   * warehouse, which issues its own shipment barcode — the ERP must NOT print a
   * customer label for it (`label: null`) and derives the package number from
   * the order number. Carexy/ERP orders ship to the customer, so the response
   * carries the address label (`{ orderNo, recipient, phone, address, packageNo }`).
   */
  async completePackTask(
    ctx: TenantContext,
    publicId: string,
    body: PackTaskCompleteBody,
  ): Promise<Record<string, unknown>> {
    let orderInternalId: bigint | null = null;
    let orderPublicId = '';
    let shouldNotifyChannel = false;
    const result = await this.packTable(() =>
      this.db.begin(async (tx) => {
        const task = await this.repo.lockPackTask(tx, ctx.orgId, publicId);
        if (task === null) throw notFound('pack_task');
        orderInternalId = toBigInt(task.orderInternalId);
        orderPublicId = task.orderId;
        const handling = packHandling(task.channelCode);
        if (task.status === 'packed') {
          return {
            packTask: packTaskView(task),
            orderId: task.orderId,
            handling,
            label: handling === 'digikala_warehouse' ? null : this.buildAddressLabel(task, task.packageNo),
            alreadyCompleted: true,
          };
        }
        if (task.status !== 'pending' && task.status !== 'packing') {
          throw new AppError('DOCUMENT_STATE_INVALID', {
            message: 'این تسک بسته‌بندی قابل تکمیل نیست.',
            details: [{ rule: 'task_not_completable', params: { status: task.status } }],
          });
        }
        const count = await this.repo.countPackTasksForOrder(tx, ctx.orgId, toBigInt(task.orderInternalId));
        // Digikala already has the shipment barcode: the ERP package number is
        // always derived from the order number, never operator-supplied.
        const packageNo =
          handling === 'digikala_warehouse'
            ? this.buildPackageNo(task.orderNo, count + 1)
            : (body.packageNo ?? task.packageNo ?? this.buildPackageNo(task.orderNo, count + 1));
        const weightNote = body.weight === undefined ? null : `weight_g=${Math.round(body.weight)}`;
        const handlingNote = `handling=${handling}`;
        const notes = [task.notes, handlingNote, body.note ?? null, weightNote]
          .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
          .join(' | ');
        const updated = await this.repo.updatePackTask(tx, toBigInt(task.internalId), {
          status: 'packed',
          packageNo,
          ...(notes.length > 0 ? { notes } : {}),
          closed: true,
          ...(ctx.actorId === null ? {} : { assignedTo: ctx.actorId }),
        });
        await this.repo.setOrderFulfillmentStatus(tx, ctx.orgId, toBigInt(task.orderInternalId), 'ready_to_ship');
        shouldNotifyChannel = true;
        await this.emit(tx, ctx, WAREHOUSE_EVENTS.packTaskCompleted, 'pack_task', toBigInt(task.internalId), {
          packTaskId: task.id,
          orderId: task.orderId,
          packageNo,
          weight: body.weight ?? null,
        });
        return {
          packTask: packTaskView(updated),
          orderId: task.orderId,
          orderFulfillmentStatus: 'ready_to_ship',
          handling,
          label: handling === 'digikala_warehouse' ? null : this.buildAddressLabel(updated, packageNo),
          alreadyCompleted: false,
        };
      }),
    );
    // Outside the transaction: a partner call must never hold a DB lock or
    // roll back a successfully packed order.
    if (orderInternalId !== null && shouldNotifyChannel) {
      await this.pushChannelReadyToShip(ctx, orderInternalId, orderPublicId);
    }
    return result;
  }

  /**
   * Printable address label for a ship-to-customer order. Only the order number,
   * recipient, phone and address are included (the packing UI prints exactly
   * these); Digikala orders never reach this method.
   */
  private buildAddressLabel(
    task: PackTaskRow,
    packageNo: string | null,
  ): {
    orderNo: string;
    recipient: string | null;
    phone: string | null;
    address: string | null;
    packageNo: string | null;
  } | null {
    if (task.orderNo === null && packageNo === null) return null;
    return {
      orderNo: task.orderNo ?? '',
      recipient:
        pickAddressString(task.address, ADDRESS_NAME_KEYS) ?? task.customerName ?? null,
      phone:
        pickAddressString(task.address, ADDRESS_PHONE_KEYS) ?? task.customerPhone ?? null,
      address: formatAddressText(task.address),
      packageNo,
    };
  }

  /** `POST warehouse/pack-tasks/:id/assign`; omitting `userId` releases it. */
  async assignPackStationTask(
    ctx: TenantContext,
    publicId: string,
    body: PickTaskAssignBody,
  ): Promise<Record<string, unknown>> {
    return this.packTable(() =>
      this.db.begin(async (tx) => {
        const task = await this.repo.lockPackTask(tx, ctx.orgId, publicId);
        if (task === null) throw notFound('pack_task');
        let assignedTo: bigint | null = null;
        if (body.userId !== undefined) {
          assignedTo = await this.repo.findActiveUserId(tx, ctx.orgId, body.userId);
          if (assignedTo === null) throw notFound('user');
        }
        const updated = await this.repo.assignPackTask(tx, ctx.orgId, publicId, assignedTo);
        if (updated === null) throw notFound('pack_task');
        return packTaskView(updated);
      }),
    );
  }

  /**
   * Best-effort channel notification when an order is ready to ship. Adapters
   * without `order.ack`, channel-less (manual) orders and partner failures are
   * skipped silently: packing already succeeded and must not be reported failed.
   */
  private async pushChannelReadyToShip(
    ctx: TenantContext,
    orderInternalId: bigint,
    orderPublicId: string,
  ): Promise<void> {
    try {
      const ref = await this.repo.findOrderChannelRef(this.db, ctx.orgId, orderInternalId);
      if (ref === null || ref.accountPublicId === null || ref.externalOrderId === null) return;
      const resolved = await this.channelAccounts.resolveByPublicId(ctx.orgId.toString(), ref.accountPublicId);
      if (!resolved.adapter.supports('order.ack')) return;
      await resolved.adapter.acknowledgeOrder(resolved.account, ref.externalOrderId, 'packed');
    } catch (error) {
      this.logger.debug(
        `ready-to-ship push skipped for order ${orderPublicId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Turns a missing `pack_tasks` table into an honest 501 instead of a 500. */
  private async packTable<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!isUndefinedTable(error)) throw error;
      throw new AppError('NOT_IMPLEMENTED', {
        message: PACK_TABLE_MISSING_MESSAGE,
        messageKey: 'warehouse.pack_tasks_missing',
        details: [{ rule: 'pack_tasks_table_missing' }],
      });
    }
  }

  // ============================================================ global scan

  /**
   * `GET /scan/lookup?q=` — resolves one scanned code against the ERP in the
   * order a warehouse operator expects: product barcode/SKU first, then a
   * warehouse location barcode/code, then a sales-order number and finally a
   * pick-task id. The SPA scan page can route the returned `url` directly.
   */
  async scanLookup(ctx: TenantContext, q: string): Promise<Record<string, unknown>> {
    const code = q.trim();
    const product = await this.repo.scanLookupProduct(this.db, ctx.orgId, code);
    if (product !== null) return scanLookupView(product);
    const location = await this.repo.scanLookupLocation(this.db, ctx.orgId, code);
    if (location !== null) return scanLookupView(location);
    const order = await this.repo.scanLookupOrder(this.db, ctx.orgId, code);
    if (order !== null) return scanLookupView(order);
    if (UUID_PATTERN.test(code)) {
      const task = await this.repo.scanLookupTask(this.db, ctx.orgId, code);
      if (task !== null) return scanLookupView(task);
    }
    throw new AppError('NOT_FOUND', {
      message: 'کالا، مکان، سفارش یا وظیفه‌ای با این کد یافت نشد.',
      messageKey: 'warehouse.scan_not_found',
      details: [{ rule: 'scan_not_found' }],
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
