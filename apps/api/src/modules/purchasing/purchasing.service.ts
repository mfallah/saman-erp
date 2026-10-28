/**
 * Purchasing application service — supplier master + goods receipts (`TASK A`).
 *
 * The receipt is one atomic unit of work (`ARCHITECTURE.md` §6): supplier resolve/
 * create, purchase order + lines, goods receipt + lines, the inbound inventory ledger
 * rows, serial numbers and `received_qty` all commit together, so stock can never
 * disagree with its document. The ledger rows are posted through
 * `InventoryService.postMovement` — this module never writes stock tables, balances,
 * cost layers or the moving-average state itself.
 *
 * Channel stock push is deliberately **after** the commit (the pattern already used
 * by the stock workspace): an outage at an external channel can never roll back a
 * receipt that physically happened.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { AppError, parseMoney } from '@saman/shared';

import { AUDIT, DB, type AuditPort, type Db as ContractDb, type TenantContext } from '../../common/contracts';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ScopeService } from '../../common/scope/scope.service';
import { deriveInternalBarcode, renderLabelSheetSvg, type VariantLabel } from '../catalog/engines/label.engine';
import { CatalogLookupService, type VariantLookup } from '../catalog/product.service';
import { ChannelSyncService } from '../channels/services/channel-sync.service';
import {
  QUANTITY_SCALE,
  compareQuantity,
  isWholeQuantity,
  multiplyMoneyByQuantity,
  normalizeQuantity,
  parseQuantity,
} from '../inventory/engines/quantity.engine';
import { InventoryService } from '../inventory/inventory.service';
import { isUniqueViolation, notFound, toBigInt, validation, type Db } from './purchasing.pg-support';
import {
  PurchasingRepository,
  type ChannelTargetRow,
  type GoodsReceiptLineRow,
  type GoodsReceiptListRow,
  type SupplierRow,
} from './purchasing.repository';
import type { CreateReceiptBody, CreateSupplierBody, ReceiptLabelsPreviewBody } from './dto/purchasing.dto';

interface PreparedLine {
  readonly variant: VariantLookup;
  readonly quantity: string;
  readonly unitCostAmount: bigint;
  readonly lineTotalAmount: bigint;
  readonly serials: readonly string[];
}

/** Normalized line the label renderer consumes (receipt lines or unsaved preview). */
interface LabelSheetLine {
  readonly variantId: string;
  readonly quantity: string;
  readonly serials: readonly string[];
  readonly sku?: string | null;
  readonly productName?: string | null;
}

export interface QueuedChannel {
  readonly accountId: string;
  readonly channelCode: string;
  readonly channelName: string;
  readonly externalProductId: string | null;
  readonly externalVariantId: string | null;
  readonly externalId: string | null;
}

/** One label per accepted unit when no serial is recorded; fractional units = 1 label. */
function labelUnitCount(acceptedQuantity: string): number {
  const quantity = Number(acceptedQuantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return 1;
  return Number.isInteger(quantity) ? quantity : 1;
}

function supplierView(row: SupplierRow): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    phone: row.phone,
    isActive: row.isActive,
    createdAt: row.createdAt,
  };
}

function receiptSummaryView(row: GoodsReceiptListRow): Record<string, unknown> {
  const lineCount = Number(row.lineCount ?? 0);
  return {
    id: row.id,
    receiptNo: row.receiptNo,
    // Contract aliases used by the purchasing screen (`PurchaseReceipt`).
    receiptNumber: row.receiptNo,
    number: row.receiptNo,
    receivedAt: row.receivedAt,
    businessDate: row.businessDate,
    status: row.status,
    purchaseOrderId: row.purchaseOrderId,
    poNo: row.poNo,
    supplierId: row.supplierId,
    supplierName: row.supplierName,
    warehouseId: row.warehouseId,
    warehouseName: row.warehouseName,
    subtotalAmount: row.subtotalAmount,
    grandTotalAmount: row.grandTotalAmount,
    total: row.grandTotalAmount,
    totalCost: row.grandTotalAmount,
    lineCount,
    itemCount: lineCount,
    totalQuantity: normalizeQuantity(row.totalQuantity ?? '0'),
  };
}

function receiptLineView(row: GoodsReceiptLineRow): Record<string, unknown> {
  const serialItems = (row.serials ?? []).map((serial) => ({
    id: serial.id,
    serialNo: serial.serialNo,
    status: serial.status,
  }));
  return {
    id: row.id,
    lineNo: Number(row.lineNo),
    variantId: row.variantId,
    sku: row.sku,
    productName: row.productName,
    quantity: normalizeQuantity(row.quantity),
    acceptedQty: normalizeQuantity(row.acceptedQty),
    rejectedQty: normalizeQuantity(row.rejectedQty),
    unitCostAmount: row.unitCostAmount,
    // Contract alias: the screen's line type names the cost `unitCost`.
    unitCost: row.unitCostAmount,
    lineTotalAmount: row.lineTotalAmount,
    purchaseOrderLineId: row.purchaseOrderLineId,
    inventoryTransactionId: row.inventoryTransactionId,
    serials: serialItems.map((serial) => serial.serialNo),
    serialItems,
  };
}

function channelView(target: ChannelTargetRow): QueuedChannel {
  return {
    accountId: target.accountId,
    channelCode: target.channelCode,
    channelName: target.channelName,
    externalProductId: target.externalProductId,
    externalVariantId: target.externalVariantId,
    externalId: target.externalVariantId ?? target.externalProductId,
  };
}

@Injectable()
export class PurchasingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: PurchasingRepository,
    private readonly inventory: InventoryService,
    private readonly catalog: CatalogLookupService,
    private readonly sync: ChannelSyncService,
    @Inject(AUDIT) private readonly audit: AuditPort,
    private readonly moduleRef: ModuleRef,
    private readonly scopes: ScopeService,
  ) {}

  // ----------------------------------------------------------------- suppliers

  async listSuppliers(
    ctx: TenantContext,
    query: { q?: string | undefined; limit: number },
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.repo.listSuppliers(this.db, {
      orgId: ctx.orgId,
      q: query.q ?? null,
      limit: query.limit,
    });
    return rows.map(supplierView);
  }

  async createSupplier(ctx: TenantContext, body: CreateSupplierBody): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const code = body.code ?? this.generateSupplierCode();
      let supplier: SupplierRow;
      try {
        supplier = await this.repo.insertSupplier(tx, {
          orgId: ctx.orgId,
          code,
          name: body.name,
          phone: body.phone ?? null,
          createdBy: ctx.actorId,
        });
      } catch (error) {
        // A duplicate code is a client-visible conflict, never a retried insert:
        // Postgres aborts the transaction on a unique violation (23505).
        if (isUniqueViolation(error)) {
          throw new AppError('CONFLICT', {
            message: 'کد تأمین‌کننده تکراری است.',
            details: [{ field: 'code', rule: 'supplier_code_taken', params: { code } }],
          });
        }
        throw error;
      }
      await this.record(tx, ctx, 'purchase.supplier.create', 'supplier', supplier.id, supplierView(supplier));
      return supplierView(supplier);
    });
  }

  // ------------------------------------------------------------------ receipts

  async listReceipts(
    ctx: TenantContext,
    query: {
      page: number;
      perPage: number;
      q?: string | undefined;
      supplierId?: string | undefined;
      warehouseId?: string | undefined;
    },
  ): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const allowedWarehouseIds = this.scopes.visibleWarehouseIds(this.scopes.forContext(ctx));
    if (allowedWarehouseIds !== null && allowedWarehouseIds.length === 0) {
      return { items: [], total: 0 };
    }
    const scope = {
      orgId: ctx.orgId,
      q: query.q ?? null,
      supplierPublicId: query.supplierId ?? null,
      warehousePublicId: query.warehouseId ?? null,
      warehouseIds: allowedWarehouseIds,
    };
    const [rows, total] = await Promise.all([
      this.repo.listReceipts(this.db, {
        ...scope,
        limit: query.perPage,
        offset: (query.page - 1) * query.perPage,
      }),
      this.repo.countReceipts(this.db, scope),
    ]);
    return { items: rows.map(receiptSummaryView), total };
  }


  /**
   * Void a received goods receipt: reverse stock for every accepted unit and
   * mark its serials void. Posted documents are immutable, so "editing" a
   * receipt means void + re-enter (auditable trail).
   */
  async voidReceipt(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const receipt = await this.repo.findReceipt(this.db, ctx.orgId, publicId);
    if (receipt === null) throw notFound('goods_receipt');
    if (String(receipt.status) === 'voided') {
      throw new AppError('RULE_VIOLATION', { message: 'این رسید قبلاً ابطال شده است.' });
    }
    const lines = await this.repo.listReceiptLines(this.db, ctx.orgId, publicId);
    const reversed: { variantId: string; quantity: number }[] = [];
    for (const line of lines) {
      const quantity = Math.trunc(Number(line.acceptedQty ?? line.quantity ?? 0));
      if (!Number.isFinite(quantity) || quantity <= 0) continue;
      await this.inventory.quickAdjust(ctx, {
        variantId: line.variantId,
        quantityDelta: -quantity,
        reason: `void receipt ${publicId}`,
      });
      reversed.push({ variantId: line.variantId, quantity });
      for (const serial of line.serials ?? []) {
        await this.db`
          update erp.inventory_serials s
          set status = 'void'
          from erp.product_variants v
          where v.id = s.product_variant_id
            and v.public_id = ${line.variantId}
            and s.serial_no = ${serial.serialNo}
        `;
      }
    }
    await this.db`
      update erp.goods_receipts
      set status = 'voided', notes = coalesce(notes, '') || ${` | voided at ${new Date().toISOString()}`}
      where organization_id = ${ctx.orgId} and public_id = ${publicId}
    `;
    return { id: publicId, status: 'voided', reversed };
  }

  async getReceipt(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findReceipt(this.db, ctx.orgId, publicId);
    if (row === null) throw notFound('goods_receipt');
    const lines = await this.repo.listReceiptLines(this.db, ctx.orgId, publicId);
    return { ...receiptSummaryView(row), lines: lines.map(receiptLineView) };
  }

  /**
   * Printable label sheet for a goods receipt (`GET /inventory/receipts/:id/labels.svg`).
   *
   * One label per recorded serial when the line carries serials, otherwise one per
   * accepted unit (`copies` repeats the set). Barcodes come from the catalog lookup
   * surface; a variant without one prints the same deterministic internal code the
   * generate endpoint persists. Labels are capped by the pure renderer, so an
   * oversized request fails as a validation error rather than a huge response.
   */
  async receiptLabelsSvg(ctx: TenantContext, receiptPublicId: string, copies: number): Promise<string> {
    const receipt = await this.repo.findReceipt(this.db, ctx.orgId, receiptPublicId);
    if (receipt === null) throw notFound('goods_receipt');
    const lines = await this.repo.listReceiptLines(this.db, ctx.orgId, receiptPublicId);
    const sheet = await this.renderLabelSheet(
      ctx,
      lines.map((line) => ({
        variantId: line.variantId,
        quantity: line.acceptedQty ?? line.quantity,
        serials: (line.serials ?? []).map((serial) => serial.serialNo),
        sku: line.sku,
        productName: line.productName,
      })),
    );

    const repeated: VariantLabel[] = [];
    for (let copy = 0; copy < copies; copy += 1) repeated.push(...sheet);
    return renderLabelSheetSvg(repeated);
  }

  /**
   * Labels for a receipt that has **not been saved yet**
   * (`POST /goods-receipts/labels/preview`): same payload/SVG as the saved-receipt
   * endpoint, so the operator can print while the goods are still on the dock.
   */
  async previewReceiptLabelsSvg(ctx: TenantContext, input: ReceiptLabelsPreviewBody): Promise<string> {
    if (input.warehouseId !== undefined) {
      await this.inventory.assertWarehouseInOrganization(ctx, input.warehouseId);
    }
    const validated = new Set<string>();
    const lines: LabelSheetLine[] = [];
    for (const [index, line] of input.lines.entries()) {
      if (!validated.has(line.variantId)) {
        await this.catalog.requireVariant(ctx, line.variantId);
        validated.add(line.variantId);
      }
      const quantity = normalizeQuantity(line.quantity);
      if (compareQuantity(quantity, '0') <= 0) {
        throw validation(`lines[${index}].quantity`, 'quantity_must_be_positive');
      }
      lines.push({
        variantId: line.variantId,
        quantity,
        serials: this.previewSerials(index, line.serials, quantity),
      });
    }
    return renderLabelSheetSvg(await this.renderLabelSheet(ctx, lines));
  }

  /** Serial count rules mirror `createReceipt`, so preview and save agree. */
  private previewSerials(
    index: number,
    serials: readonly string[] | undefined,
    quantity: string,
  ): readonly string[] {
    if (serials === undefined || serials.length === 0) return [];
    if (!isWholeQuantity(quantity)) {
      throw validation(`lines[${index}].serials`, 'serial_quantity_must_be_integer');
    }
    if (parseQuantity(quantity) / QUANTITY_SCALE !== BigInt(serials.length)) {
      throw validation(`lines[${index}].serials`, 'serial_count_mismatch');
    }
    return serials;
  }

  /** One label per serial, else one per whole unit (fractional units = 1 label). */
  private async renderLabelSheet(
    ctx: TenantContext,
    lines: readonly LabelSheetLine[],
  ): Promise<readonly VariantLabel[]> {
    const identities = await this.catalog.labelData(
      ctx,
      lines.map((line) => line.variantId),
    );
    const byVariant = new Map(identities.map((identity) => [identity.variantId, identity]));

    const labels: VariantLabel[] = [];
    for (const line of lines) {
      const identity = byVariant.get(line.variantId);
      const base: VariantLabel = {
        barcode: identity?.barcode ?? deriveInternalBarcode(line.variantId, 'code128'),
        sku: identity?.sku ?? line.sku ?? line.variantId.slice(0, 8),
        productName: identity?.productName ?? line.productName ?? '',
      };
      const serials = line.serials.map((serial) => serial.trim()).filter((serialNo) => serialNo.length > 0);
      if (serials.length > 0) {
        for (const serial of serials) labels.push({ ...base, serial });
        continue;
      }
      const units = labelUnitCount(line.quantity);
      for (let unit = 0; unit < units; unit += 1) labels.push(base);
    }
    if (labels.length === 0) {
      throw new AppError('RULE_VIOLATION', {
        message: 'این رسید هیچ واحد پذیرفته‌شده‌ای برای چاپ برچسب ندارد.',
        messageKey: 'purchasing.receipt_no_labels',
        details: [{ rule: 'receipt_has_no_accepted_units' }],
      });
    }
    return labels;
  }

  /**
   * Posts one goods receipt. Everything below runs in a **single transaction**: if
   * any line fails (closed period, zero cost, unknown variant, duplicate serial) the
   * purchase order, receipt and every ledger row roll back together.
   */
  async createReceipt(ctx: TenantContext, input: CreateReceiptBody): Promise<Record<string, unknown>> {
    const receivedAt = input.receivedAt === undefined ? new Date() : new Date(input.receivedAt);
    if (Number.isNaN(receivedAt.getTime())) throw validation('receivedAt', 'invalid_datetime');
    const businessDate = receivedAt.toISOString().slice(0, 10);
    const prepared = await this.prepareLines(ctx, input.lines);

    const committed = await this.db.begin(async (tx) => {
      const placement = await this.inventory.resolveInboundPlacement(tx, ctx, input.warehouseId);
      const supplier = await this.resolveSupplier(tx, ctx, input);
      const subtotalAmount = prepared.reduce((sum, line) => sum + line.lineTotalAmount, 0n);

      const poNo = await this.repo.allocateDocumentNo(tx, ctx.orgId, 'purchase_order', businessDate);
      const purchaseOrder = await this.repo.insertPurchaseOrder(tx, {
        orgId: ctx.orgId,
        poNo,
        supplierInternalId: toBigInt(supplier.internalId),
        warehouseInternalId: placement.warehouseInternalId,
        orderDate: businessDate,
        subtotalAmount,
        grandTotalAmount: subtotalAmount,
        notes: input.notes ?? null,
        createdBy: ctx.actorId,
      });

      const purchaseOrderLines: bigint[] = [];
      for (const [index, line] of prepared.entries()) {
        const inserted = await this.repo.insertPurchaseOrderLine(tx, {
          purchaseOrderInternalId: toBigInt(purchaseOrder.internalId),
          lineNo: index + 1,
          variantInternalId: line.variant.internalId,
          quantity: line.quantity,
          unitPriceAmount: line.unitCostAmount,
          lineTotalAmount: line.lineTotalAmount,
          createdBy: ctx.actorId,
        });
        purchaseOrderLines.push(toBigInt(inserted.internalId));
      }

      const receiptNo = await this.repo.allocateDocumentNo(tx, ctx.orgId, 'goods_receipt', businessDate);
      const receipt = await this.repo.insertGoodsReceipt(tx, {
        orgId: ctx.orgId,
        purchaseOrderInternalId: toBigInt(purchaseOrder.internalId),
        warehouseInternalId: placement.warehouseInternalId,
        receiptNo,
        receivedAt,
        businessDate,
        receivedBy: ctx.actorId,
        notes: input.notes ?? null,
      });
      const receiptInternalId = toBigInt(receipt.internalId);

      for (const [index, line] of prepared.entries()) {
        const purchaseOrderLineInternalId = purchaseOrderLines[index];
        if (purchaseOrderLineInternalId === undefined) throw new RangeError('purchase_order_line_missing');

        // Per-line placement: a line may name its own warehouse/location; every
        // other line keeps the receipt-level placement resolved above.
        const requested = input.lines[index];
        const linePlacement =
          requested !== undefined && (requested.warehouseId !== undefined || requested.locationId !== undefined)
            ? await this.inventory.resolveInboundPlacement(
                tx,
                ctx,
                requested.warehouseId ?? input.warehouseId,
                requested.locationId,
              )
            : placement;

        // Stock truth: inbound ledger row with the purchase unit cost, in this tx.
        const movement = await this.inventory.postMovement(tx, ctx, {
          warehouseId: linePlacement.warehouseId,
          locationId: linePlacement.locationId,
          variantId: line.variant.id,
          type: 'receipt',
          quantity: line.quantity,
          unitCostAmount: line.unitCostAmount,
          referenceType: 'goods_receipt',
          referenceId: receipt.id,
          referenceInternalId: receiptInternalId,
          idempotencyKey: `goods-receipt:${receipt.id}:${index + 1}`,
          businessDate,
        });

        await this.repo.insertGoodsReceiptLine(tx, {
          receiptInternalId,
          purchaseOrderLineInternalId,
          lineNo: index + 1,
          variantInternalId: line.variant.internalId,
          quantity: line.quantity,
          unitCostAmount: movement.unitCostAmount,
          inventoryTransactionInternalId: toBigInt(movement.transaction.internalId),
          createdBy: ctx.actorId,
        });
        await this.repo.addPurchaseOrderLineReceived(tx, purchaseOrderLineInternalId, line.quantity, ctx.actorId);

        for (const serialNo of line.serials) {
          try {
            await this.repo.insertSerial(tx, {
              variantInternalId: line.variant.internalId,
              serialNo,
              locationInternalId: linePlacement.locationInternalId,
              receivedAt,
              createdBy: ctx.actorId,
            });
          } catch (error) {
            // `uq_inventory_serials_product_variant_id_serial_no`: a serial that is
            // already registered is a client-visible conflict, not a 500.
            if (isUniqueViolation(error)) {
              throw new AppError('CONFLICT', {
                message: `شماره سریال «${serialNo}» قبلاً برای این تنوع کالا ثبت شده است.`,
                messageKey: 'purchasing.duplicate_serial',
                details: [
                  { field: `lines[${index}].serials`, rule: 'duplicate_serial', params: { serialNo } },
                ],
              });
            }
            throw error;
          }
        }
      }

      await this.record(tx, ctx, 'purchase.receipt.create', 'goods_receipt', receipt.id, {
        receiptNo,
        poNo,
        supplierId: supplier.id,
        warehouseId: placement.warehouseId,
        lineCount: prepared.length,
        grandTotalAmount: subtotalAmount.toString(),
      });

      return {
        receiptId: receipt.id,
        variantInternalIds: prepared.map((line) => line.variant.internalId),
      };
    });

    const detail = await this.getReceipt(ctx, committed.receiptId);
    const queued = await this.queueInventoryPushes(ctx, committed.variantInternalIds);
    return { ...detail, queuedAccounts: queued.accounts, queuedChannels: queued.channels };
  }

  // ------------------------------------------------------------------ internals

  /** Validates + normalizes lines and resolves every variant through the catalog. */
  private async prepareLines(
    ctx: TenantContext,
    lines: CreateReceiptBody['lines'],
  ): Promise<readonly PreparedLine[]> {
    const prepared: PreparedLine[] = [];
    const serialKeys = new Set<string>();
    for (const [index, line] of lines.entries()) {
      const variant = await this.catalog.requireVariant(ctx, line.variantId);
      const quantity = normalizeQuantity(line.quantity);
      if (compareQuantity(quantity, '0') <= 0) {
        throw validation(`lines[${index}].quantity`, 'quantity_must_be_positive');
      }
      const unitCostAmount = await this.resolveUnitCost(ctx, variant, line.unitCost, index);
      const serials = this.normalizeSerials(index, line.serials, quantity);
      for (const serialNo of serials) {
        const key = `${variant.internalId.toString()}:${serialNo}`;
        if (serialKeys.has(key)) throw validation(`lines[${index}].serials`, 'duplicate_serial');
        serialKeys.add(key);
      }
      prepared.push({
        variant,
        quantity,
        unitCostAmount,
        lineTotalAmount: multiplyMoneyByQuantity(unitCostAmount, quantity),
        serials,
      });
    }
    return prepared;
  }

  /**
   * Unit cost of a received line: explicit value wins, otherwise the variant's latest
   * recorded cost. A zero/unknown cost is rejected here with the offending field —
   * a zero-cost inbound movement is refused by the ledger engine (`R1-A M-07`).
   */
  private async resolveUnitCost(
    ctx: TenantContext,
    variant: VariantLookup,
    unitCost: string | undefined,
    index: number,
  ): Promise<bigint> {
    const raw = unitCost ?? (await this.catalog.latestCost(ctx, variant.id));
    if (raw === null || raw === undefined) {
      throw validation(
        `lines[${index}].unitCost`,
        'unit_cost_required',
        'برای این سطر بهای خرید مشخص نیست؛ مبلغ واحد را وارد کنید.',
        'purchasing.unit_cost_required',
      );
    }
    const unitCostAmount = parseMoney(raw);
    if (unitCostAmount <= 0n) {
      throw validation(
        `lines[${index}].unitCost`,
        'unit_cost_must_be_positive',
        'بهای واحد باید بزرگ‌تر از صفر باشد.',
        'purchasing.unit_cost_invalid',
      );
    }
    return unitCostAmount;
  }

  private normalizeSerials(
    index: number,
    serials: readonly string[] | undefined,
    quantity: string,
  ): readonly string[] {
    if (serials === undefined || serials.length === 0) return [];
    if (!isWholeQuantity(quantity)) {
      throw validation(`lines[${index}].serials`, 'serial_quantity_must_be_integer');
    }
    if (parseQuantity(quantity) / QUANTITY_SCALE !== BigInt(serials.length)) {
      throw validation(`lines[${index}].serials`, 'serial_count_mismatch');
    }
    return serials;
  }

  /** Resolves the receipt supplier, matching by name before creating a new master. */
  private async resolveSupplier(
    tx: Db,
    ctx: TenantContext,
    input: CreateReceiptBody,
  ): Promise<SupplierRow> {
    if (input.supplierId !== undefined) {
      const supplier = await this.repo.findSupplier(tx, ctx.orgId, input.supplierId);
      if (supplier === null) throw notFound('supplier');
      return supplier;
    }
    const name = input.supplierName?.trim() ?? '';
    if (name.length === 0) throw validation('supplierName', 'supplier_required');
    const existing = await this.repo.findSupplierByName(tx, ctx.orgId, name);
    if (existing !== null) return existing;
    const supplier = await this.repo.insertSupplier(tx, {
      orgId: ctx.orgId,
      code: this.generateSupplierCode(),
      name,
      phone: null,
      createdBy: ctx.actorId,
    });
    await this.record(tx, ctx, 'purchase.supplier.create', 'supplier', supplier.id, supplierView(supplier), {
      source: 'purchasing.receipt',
    });
    return supplier;
  }

  /**
   * `SUP-XXXXXXXX` from 4 random bytes: code is only a human handle and the unique
   * index is per organization, so atomically generated codes avoid the classic
   * count+1 race (an insert retry is impossible inside the same transaction).
   */
  private generateSupplierCode(): string {
    return `SUP-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  }

  /**
   * Queues an `inventory_push` job per mapped channel account of the received
   * variants and runs it after the response. A mapping whose adapter rejects the
   * capability is skipped: the receipt is already committed and must not be reported
   * as failed.
   */
  private async queueInventoryPushes(
    ctx: TenantContext,
    variantInternalIds: readonly bigint[],
  ): Promise<{ accounts: string[]; channels: QueuedChannel[] }> {
    const targets = new Map<string, ChannelTargetRow>();
    for (const variantInternalId of new Set(variantInternalIds.map((id) => id.toString()))) {
      const rows = await this.repo.listChannelTargets(this.db, ctx.orgId, BigInt(variantInternalId));
      for (const row of rows) targets.set(row.accountInternalId, row);
    }

    const accounts: string[] = [];
    const channels: QueuedChannel[] = [];
    for (const target of targets.values()) {
      try {
        const job = await this.sync.trigger({
          organizationId: ctx.orgId.toString(),
          accountId: target.accountInternalId,
          type: 'inventory_push',
          force: true,
        });
        // Run immediately after the receipt transaction commits. The job pushes
        // one small chunk and reports `remaining`; the chain below drains the
        // remainder without ever bursting the channel.
        setImmediate(() => {
          void this.runInventoryPushChain(job.jobId, ctx.orgId.toString(), target.accountInternalId).catch(
            () => undefined,
          );
        });
        // A purchase changes the moving-average cost, so the channel price must
        // be recomputed and pushed as well (not only the stock).
        try {
          const { PricingService } = await import('../pricing/pricing.service');
          const pricing = this.moduleRef.get(PricingService, { strict: false });
          await pricing.applyToAccount({ accountId: target.accountId });
          const priceJob = await this.sync.trigger({
            organizationId: ctx.orgId.toString(),
            accountId: target.accountInternalId,
            type: 'price_push',
            force: true,
          });
          setImmediate(() => {
            void this.sync.runJob(priceJob.jobId).catch(() => undefined);
          });
        } catch {
          // Price policy may be missing for this account; stock push still stands.
        }
        accounts.push(target.accountId);
        channels.push(channelView(target));
      } catch {
        // Channel without (or rejecting) stock-push capability: nothing to queue.
      }
    }
    return { accounts, channels };
  }

  /**
   * Runs one `push_inventory` job and, while the summary reports variants the
   * chunk did not reach and the channel is not rate limited, queues the next
   * chunk. Bounded so a huge catalogue cannot loop forever; each job is the
   * durable record of what was pushed (status + `response_summary`).
   */
  private async runInventoryPushChain(
    jobId: string,
    organizationId: string,
    accountId: string,
  ): Promise<void> {
    let current = jobId;
    for (let round = 0; round < 5; round += 1) {
      const result = await this.sync.runJob(current, 'purchasing');
      if (result.status !== 'succeeded') return;
      const remaining = Number(result.summary['remaining'] ?? 0);
      const rateLimited = Number(result.summary['rateLimited'] ?? 0);
      if (!Number.isFinite(remaining) || remaining <= 0 || rateLimited > 0) return;
      const next = await this.sync.trigger({
        organizationId,
        accountId,
        type: 'inventory_push',
        force: true,
      });
      current = next.jobId;
    }
  }

  private async record(
    tx: Db,
    ctx: TenantContext,
    action: string,
    entityType: string,
    entityId: string,
    after: Record<string, unknown> | null,
    meta?: Record<string, unknown>,
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
      before: null,
      after,
      ...(meta === undefined ? {} : { meta }),
    });
  }
}
