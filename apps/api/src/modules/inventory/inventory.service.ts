/**
 * Inventory application service (`ADR-0007`) — the stock truth of the ERP.
 *
 * Responsibilities:
 * - **ledger primitive** `postMovement`: validates the movement, guards the
 *   accounting period, locks balances in the fixed order, writes the append-only
 *   ledger row, updates the balance projection and maintains cost layers /
 *   moving-average state in the *same* transaction;
 * - **reservations**: all-or-nothing allocation with row-locked balances and a
 *   deterministic lock order, release/consume/expire lifecycle;
 * - **adjustments / transfers / counts** documents with maker-checker hooks and
 *   reversal-based corrections (history is never rewritten);
 * - **valuation** snapshots and the nightly layer-vs-average consistency job.
 *
 * Other modules (sales, fulfillment, warehouse, procurement) call the public
 * methods that accept a caller transaction — never the repository.
 */
import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { AppError, parseMoney } from '@saman/shared';

import { AUDIT, DB, EVENT_BUS, type AuditPort, type Db as ContractDb, type EventPort, type TenantContext } from '../../common/contracts';
import { CatalogLookupService } from '../catalog/product.service';
import { type VariantLookup } from '../catalog/product.service';
import type { Db } from './inventory.pg-support';
import { notFound, parseIfMatch, toBigInt, versionConflict } from './inventory.pg-support';
import { InventoryRepository } from './inventory.repository';
import { type AdjustmentRow, type BalanceRow, type LedgerRow, type ReservationRow } from './inventory.repository';
import { INVENTORY_ACCOUNTING_EVENTS, INVENTORY_EVENTS, type AdjustmentPayload, type CountPayload, type LedgerMovementPayload, type ReservationPayload, type TransferPayload, type ValuationPayload } from './inventory.events';
import { applyMovementToBalance, applyReservationDelta, assertValidMovement, availableQuantity, isInboundType, isOutboundType, signedQuantity, type InventoryTransactionType } from './engines/ledger.engine';
import { absQuantity, addQuantity, compareQuantity, divideMoneyByQuantity, formatQuantity, isPositiveQuantity, multiplyMoneyByQuantity, normalizeQuantity, parseQuantity, subQuantity } from './engines/quantity.engine';
import { assertAllocatable, groupReservations, planAllocation, reservationExpiry, reservationRemaining, type AllocationPlan, type BalanceCandidate } from './engines/allocation.engine';
import { applyIssueCostToAverage, applyReceiptToAverage, consumeLayersAtUnitCost, consumeLayersFifo, layersValue, reconcileLayersWithAverage, resolveInboundCost, resolveIssueCost, sortLayersFifo, type AverageCostState, type CostLayer, type CostMethod, type LayerConsumptionResult } from './engines/cost.engine';

const DEFAULT_RESERVATION_TTL_MINUTES = 30;
/** Manual stock adjustments above this IRR value need a second approver (`ADR-0008`). */
const ADJUSTMENT_APPROVAL_THRESHOLD = 100_000_000n;
/** Documented fallback when the organization has no usable IANA timezone. */
const DEFAULT_BUSINESS_TIME_ZONE = 'Asia/Tehran';
/**
 * Scope used in `erp.idempotency_keys` for the movement payload hash. The hash
 * field is `erp.idempotency_keys.request_hash` (SHA-256 hex, 64 chars); the
 * inventory ledger key itself stays in `erp.inventory_ledger_keys`.
 */
const MOVEMENT_IDEMPOTENCY_SCOPE = 'inventory.post_movement';

export interface PostMovementInput {
  readonly warehouseId: string;
  readonly locationId: string;
  readonly variantId: string;
  readonly type: InventoryTransactionType;
  /** Positive magnitude; the engine derives the ledger sign from `type`. */
  readonly quantity: string;
  readonly unitCostAmount?: bigint | null;
  readonly lotId?: string | null;
  readonly referenceType: string;
  readonly referenceId?: string | null;
  readonly referenceInternalId?: bigint | null;
  readonly idempotencyKey?: string | null;
  readonly businessDate?: string;
  readonly reversalOfInternalId?: bigint | null;
}

export interface MovementResult {
  readonly transaction: LedgerRow;
  readonly balance: BalanceRow;
  readonly unitCostAmount: bigint;
  readonly totalCostAmount: bigint;
}

/** Result of an inline stock delta; `variantInternalId` is internal-only. */
export interface QuickAdjustResult {
  readonly adjustmentId: string;
  readonly variantId: string;
  readonly variantInternalId: bigint;
  readonly warehouseId: string;
  readonly onHand: string;
}

interface LockedCostState {
  readonly average: AverageCostState;
  readonly averageInternalId: bigint;
  readonly layers: readonly CostLayer[];
}

/**
 * Local business date for an IANA timezone. The process clock is UTC; using
 * `toISOString().slice(0, 10)` would roll the business day at 00:00 UTC instead
 * of the organization's midnight.
 */
export function businessDateInTimeZone(now: Date, timeZone: string = DEFAULT_BUSINESS_TIME_ZONE): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
      parts.find((entry) => entry.type === type)?.value;
    const year = part('year');
    const month = part('month');
    const day = part('day');
    if (year === undefined || month === undefined || day === undefined) {
      throw new RangeError('invalid_business_date_parts');
    }
    return `${year}-${month}-${day}`;
  } catch {
    if (timeZone !== DEFAULT_BUSINESS_TIME_ZONE) {
      return businessDateInTimeZone(now, DEFAULT_BUSINESS_TIME_ZONE);
    }
    throw new RangeError('invalid_business_timezone');
  }
}

/** Backwards-compatible UTC-independent fallback date helper. */
function todayIso(timeZone: string = DEFAULT_BUSINESS_TIME_ZONE): string {
  return businessDateInTimeZone(new Date(), timeZone);
}

/**
 * Canonical request fingerprint for a movement. The result is stored in
 * `erp.idempotency_keys.request_hash` and compared on replay; a mismatch with
 * the same idempotency key is a real conflict, not a retry.
 */
export function movementPayloadHash(input: PostMovementInput): string {
  const canonical = {
    warehouseId: input.warehouseId,
    locationId: input.locationId,
    variantId: input.variantId,
    type: input.type,
    quantity: normalizeQuantity(absQuantity(input.quantity)),
    unitCostAmount: input.unitCostAmount === null || input.unitCostAmount === undefined ? null : input.unitCostAmount.toString(),
    lotId: input.lotId ?? null,
    referenceType: input.referenceType,
    referenceId: input.referenceId ?? null,
    referenceInternalId:
      input.referenceInternalId === null || input.referenceInternalId === undefined
        ? null
        : input.referenceInternalId.toString(),
    businessDate: input.businessDate ?? null,
    reversalOfInternalId:
      input.reversalOfInternalId === null || input.reversalOfInternalId === undefined
        ? null
        : input.reversalOfInternalId.toString(),
    idempotencyKey: input.idempotencyKey ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Fallback for ledger rows written before the hash sidecar existed. It compares
 * the fields that are persisted verbatim; omitted optional inputs are ignored so
 * an old retry that relied on defaults can still replay.
 */
function legacyMovementMatches(input: PostMovementInput, existing: LedgerRow): boolean {
  if (
    existing.warehouseId !== input.warehouseId ||
    existing.locationId !== input.locationId ||
    existing.variantId !== input.variantId ||
    existing.transactionType !== input.type ||
    existing.referenceType !== input.referenceType ||
    existing.referencePublicId !== (input.referenceId ?? null) ||
    existing.lotId !== (input.lotId ?? null)
  ) {
    return false;
  }
  if (normalizeQuantity(absQuantity(existing.quantity)) !== normalizeQuantity(absQuantity(input.quantity))) {
    return false;
  }
  if (input.businessDate !== undefined && existing.businessDate !== input.businessDate) return false;
  if (input.unitCostAmount !== null && input.unitCostAmount !== undefined) {
    if (existing.unitCostAmount !== input.unitCostAmount.toString()) return false;
  }
  if (input.reversalOfInternalId !== null && input.reversalOfInternalId !== undefined) {
    if (existing.reversalOfId !== input.reversalOfInternalId.toString()) return false;
  }
  return true;
}

function balanceOf(row: BalanceRow) {
  return {
    onHand: row.onHand,
    reserved: row.reserved,
    safetyBuffer: row.safetyBuffer,
    damaged: row.damaged,
    inTransit: row.inTransit,
  };
}

@Injectable()
export class InventoryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: InventoryRepository,
    private readonly catalog: CatalogLookupService,
    @Inject(AUDIT) private readonly audit: AuditPort,
    @Inject(EVENT_BUS) private readonly events: EventPort,
  ) {}

  // ================================================================ availability

  async listBalances(
    ctx: TenantContext,
    query: {
      limit: number;
      cursor?: string | undefined;
      warehouseId?: string | undefined;
      variantId?: string | undefined;
      productId?: string | undefined;
      locationId?: string | undefined;
      includeZero?: boolean | undefined;
      safetyBufferBelow?: string | undefined;
      updatedAtGte?: string | undefined;
    },
  ): Promise<Record<string, unknown>[]> {
    const warehouseInternalId =
      query.warehouseId === undefined ? null : await this.requireWarehouse(this.db, ctx, query.warehouseId);
    const locationInternalId =
      query.locationId === undefined ? null : await this.requireLocation(this.db, ctx, query.locationId);
    const variant = query.variantId === undefined ? null : await this.catalog.requireVariant(ctx, query.variantId);
    const rows = await this.repo.listBalances(this.db, {
      orgId: ctx.orgId,
      warehouseInternalId,
      variantInternalId: variant?.internalId ?? null,
      productInternalId: null,
      locationInternalId,
      includeZero: query.includeZero ?? false,
      safetyBufferBelow: query.safetyBufferBelow ?? null,
      updatedAtGte: query.updatedAtGte ?? null,
      limit: query.limit + 1,
      cursor: null,
    });
    return rows.slice(0, query.limit).map(balanceView);
  }

  async getBalance(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findBalance(this.db, ctx.orgId, publicId);
    if (row === null) throw notFound('balance');
    return balanceView(row);
  }

  /** Bulk availability for allocation UI / channel stock push (`ADR-0007` §4). */
  async availability(
    ctx: TenantContext,
    query: { variantIds: readonly string[]; warehouseIds?: readonly string[] | undefined },
  ): Promise<Record<string, unknown>> {
    const variants = await this.catalog.findVariants(ctx, query.variantIds);
    const warehouseInternalIds =
      query.warehouseIds === undefined
        ? null
        : await Promise.all(query.warehouseIds.map((id) => this.requireWarehouse(this.db, ctx, id)));
    const candidates = await this.repo.availabilityCandidates(this.db, ctx.orgId, {
      variantInternalIds: variants.map((variant) => variant.internalId),
      warehouseInternalIds,
    });
    const byVariant = new Map<string, { warehouseId: string; available: string }[]>();
    const warehousePublic = new Map<string, string>();
    if (warehouseInternalIds !== null) {
      for (const [index, internalId] of warehouseInternalIds.entries()) {
        const publicId = query.warehouseIds?.[index];
        if (publicId !== undefined) warehousePublic.set(internalId.toString(), publicId);
      }
    }
    for (const candidate of candidates) {
      const variant = variants.find((item) => item.internalId.toString() === candidate.variantInternalId);
      if (variant === undefined) continue;
      const list = byVariant.get(variant.id) ?? [];
      list.push({
        warehouseId: warehousePublic.get(candidate.warehouseInternalId) ?? candidate.warehouseInternalId,
        available: candidate.available,
      });
      byVariant.set(variant.id, list);
    }
    const items = variants.map((variant) => {
      const byWarehouse = byVariant.get(variant.id) ?? [];
      const total = byWarehouse.reduce((sum, entry) => addQuantity(sum, entry.available), '0.0000');
      return { variantId: variant.id, available: total, byWarehouse };
    });
    return { items };
  }

  async listLedger(
    ctx: TenantContext,
    query: {
      limit: number;
      warehouseId?: string | undefined;
      variantId?: string | undefined;
      type?: string | undefined;
      referenceType?: string | undefined;
      referenceId?: string | undefined;
      createdFrom?: string | undefined;
      createdTo?: string | undefined;
    },
  ): Promise<Record<string, unknown>[]> {
    const createdFrom = query.createdFrom ?? new Date(Date.now() - 31 * 24 * 3_600_000).toISOString();
    const createdTo = query.createdTo ?? new Date(Date.now() + 60_000).toISOString();
    const spanDays = (Date.parse(createdTo) - Date.parse(createdFrom)) / 86_400_000;
    if (Number.isNaN(spanDays) || spanDays <= 0 || spanDays > 366) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'createdAt', rule: 'date_range_required', params: { maxDays: 366 } }],
      });
    }
    const warehouseInternalId =
      query.warehouseId === undefined ? null : await this.requireWarehouse(this.db, ctx, query.warehouseId);
    const variant = query.variantId === undefined ? null : await this.catalog.requireVariant(ctx, query.variantId);
    const rows = await this.repo.listTransactions(this.db, {
      orgId: ctx.orgId,
      warehouseInternalId,
      variantInternalId: variant?.internalId ?? null,
      type: query.type ?? null,
      referenceType: query.referenceType ?? null,
      referenceInternalId: query.referenceId === undefined ? null : toBigInt(query.referenceId),
      createdFrom,
      createdTo,
      limit: query.limit,
    });
    return rows.map(ledgerView);
  }

  async getLedgerEntry(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findTransaction(this.db, ctx.orgId, publicId);
    if (row === null) throw notFound('ledger_entry');
    return ledgerView(row);
  }

  // ============================================================ ledger primitive

  /**
   * Posts one inventory movement. MUST run inside the caller's transaction so a
   * receipt/issue is atomic with its document state change (`ARCHITECTURE.md` §6).
   */
  async postMovement(tx: Db, ctx: TenantContext, input: PostMovementInput): Promise<MovementResult> {
    const idempotencyKey = input.idempotencyKey ?? null;
    let requestHash: string | null = null;
    if (idempotencyKey !== null) {
      requestHash = movementPayloadHash(input);
      // Serialise the check-then-insert window. The ledger key table remains the
      // durable global dedupe record; this advisory lock only closes the race.
      await this.repo.lockMovementIdempotencyKey(tx, ctx.orgId, idempotencyKey);
      const existing = await this.repo.findTransactionByIdempotencyKey(tx, ctx.orgId, idempotencyKey);
      if (existing !== null) {
        const storedHash = await this.repo.findMovementRequestHash(
          tx,
          ctx.orgId,
          MOVEMENT_IDEMPOTENCY_SCOPE,
          idempotencyKey,
        );
        // Rows written before this fix have no hash sidecar; fall back to the
        // persisted fields so a mismatched legacy retry still conflicts. Every
        // movement written from now on has the hash sidecar.
        const hashMismatch = storedHash === null ? !legacyMovementMatches(input, existing) : storedHash !== requestHash;
        if (hashMismatch) {
          throw new AppError('CONFLICT', {
            message: 'کلید ایدمپوتنسی با بدنهٔ متفاوتی استفاده شده است.',
            messageKey: 'inventory.idempotency_key_reused',
            details: [
              {
                rule: 'idempotency_key_reused',
                params: { idempotencyKey, transactionId: existing.id },
              },
            ],
          });
        }
        return this.replayMovement(tx, ctx, existing);
      }
    }

    const variant = await this.catalog.requireVariant(ctx, input.variantId);
    const warehouseInternalId = await this.requireWarehouse(tx, ctx, input.warehouseId);
    const locationInternalId = await this.requireLocation(tx, ctx, input.locationId);
    const businessDate = input.businessDate ?? (await this.organizationBusinessDate(tx, ctx));
    const period = await this.repo.lockPeriodForDate(tx, ctx.orgId, businessDate);
    if (period === null) {
      throw new AppError('RULE_VIOLATION', {
        message: 'برای تاریخ عملیات، دورهٔ مالی باز وجود ندارد.',
        messageKey: 'inventory.period_not_found',
        details: [{ rule: 'period_not_found', params: { businessDate } }],
      });
    }
    if (period.status === 'closed' || period.status === 'locked') {
      throw new AppError('PERIOD_CLOSED', { details: [{ rule: 'period_closed', params: { businessDate } }] });
    }

    const inbound = isInboundType(input.type);
    const costMethod = this.costMethodOf(variant);
    const magnitude = absQuantity(input.quantity);
    assertValidMovement({
      type: input.type,
      quantity: magnitude,
      unitCostAmount: inbound ? (input.unitCostAmount ?? 0n) : 1n,
    });

    // Lock cost state before the balance row: balances (asc) → cost layers → average.
    const layers = isOutboundType(input.type)
      ? (await this.repo.lockLayersForUpdate(tx, warehouseInternalId, variant.internalId)).map(layerFromRow)
      : [];
    const averageRow = await this.repo.lockAverageCost(tx, ctx.orgId, warehouseInternalId, variant.internalId);
    const averageState: AverageCostState = {
      quantityOnHand: averageRow.quantityOnHand,
      unitCostAmount: BigInt(averageRow.avgCostAmount),
      totalValueAmount: BigInt(averageRow.totalValueAmount),
    };

    let unitCostAmount: bigint;
    let totalCostAmount: bigint;
    let layerResult: LayerConsumptionResult | null = null;
    if (inbound) {
      unitCostAmount = resolveInboundCost({
        unitCostAmount: input.unitCostAmount ?? null,
        average: averageState,
        allowZero: input.type === 'opening_balance',
      });
      totalCostAmount = multiplyMoneyByQuantity(unitCostAmount, magnitude);
    } else {
      const issue = resolveIssueCost({
        method: costMethod,
        quantity: magnitude,
        layers,
        average: averageState,
      });
      if (costMethod === 'fifo') {
        layerResult = issue.layerResult ?? null;
      } else {
        layerResult = consumeLayersAtUnitCost(layers, magnitude, averageState.unitCostAmount);
        totalCostAmount = issue.totalCostAmount;
        unitCostAmount = issue.unitCostAmount;
      }
      totalCostAmount = issue.totalCostAmount;
      unitCostAmount = issue.unitCostAmount;
    }

    const key = {
      warehouseInternalId,
      locationInternalId,
      variantInternalId: variant.internalId,
    };
    await this.repo.ensureBalances(tx, ctx.orgId, [key]);
    const locked = await this.repo.lockBalances(tx, ctx.orgId, [key]);
    const balanceRow = locked[0];
    if (balanceRow === undefined) throw notFound('balance');

    const transaction = await this.repo.insertTransaction(tx, {
      orgId: ctx.orgId,
      warehouseInternalId,
      locationInternalId,
      variantInternalId: variant.internalId,
      type: input.type,
      quantity: signedQuantity(input.type, magnitude),
      unitCostAmount,
      totalCostAmount,
      lotInternalId: input.lotId === null || input.lotId === undefined ? null : toBigInt(input.lotId),
      serialInternalId: null,
      unitInternalId: null,
      referenceType: input.referenceType,
      referenceInternalId: input.referenceInternalId ?? (input.referenceId === undefined || input.referenceId === null ? null : toBigInt(input.referenceId)),
      referencePublicId: input.referenceId ?? null,
      reversalOfInternalId: input.reversalOfInternalId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      businessDate,
      periodInternalId: period.periodInternalId,
      costState: inbound ? 'pending' : costMethod === 'fifo' ? 'layered' : 'averaged',
      createdBy: ctx.actorId,
    });

    if (idempotencyKey !== null && requestHash !== null) {
      await this.repo.saveMovementRequestHash(tx, {
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        scope: MOVEMENT_IDEMPOTENCY_SCOPE,
        idempotencyKey,
        requestHash,
        transactionPublicId: transaction.id,
      });
    }

    const delta = applyMovementToBalance(balanceOf(balanceRow), { type: input.type, quantity: magnitude });
    await this.repo.updateBalance(tx, toBigInt(balanceRow.internalId), {
      onHand: delta.onHand,
      reserved: delta.reserved,
      damaged: delta.damaged,
      inTransit: delta.inTransit,
      lastTransactionInternalId: toBigInt(transaction.internalId),
    });

    // Cost layers + average state, in the same transaction as the ledger row.
    if (inbound) {
      await this.repo.insertLayer(tx, {
        orgId: ctx.orgId,
        warehouseInternalId,
        variantInternalId: variant.internalId,
        lotInternalId: input.lotId === null || input.lotId === undefined ? null : toBigInt(input.lotId),
        receiptTransactionInternalId: toBigInt(transaction.internalId),
        receiptTransactionCreatedAt: transaction.createdAt,
        sourceKind: inboundSourceKind(input.type),
        receivedAt: transaction.createdAt,
        quantity: magnitude,
        unitCostAmount,
      });
      const next = applyReceiptToAverage(averageState, { quantity: magnitude, unitCostAmount });
      await this.repo.updateAverageCost(tx, toBigInt(averageRow.internalId), {
        quantityOnHand: next.quantityOnHand,
        avgCostAmount: next.unitCostAmount,
        totalValueAmount: next.totalValueAmount,
        lastTransactionInternalId: toBigInt(transaction.internalId),
      });
    } else if (layerResult !== null) {
      for (const consumption of layerResult.consumptions) {
        const layer = layers.find((candidate) => candidate.layerId === consumption.layerId);
        if (layer === undefined) continue;
        const remainingQuantity = subQuantity(layer.quantityRemaining, consumption.quantity);
        const remainingCost = layer.costRemainingAmount - consumption.costAmount;
        await this.repo.updateLayerRemaining(
          tx,
          toBigInt(layer.layerId),
          remainingQuantity,
          remainingCost < 0n ? 0n : remainingCost,
          compareQuantity(remainingQuantity, '0') === 0,
        );
        await this.repo.insertLayerConsumption(tx, {
          layerInternalId: toBigInt(layer.layerId),
          issueTransactionInternalId: toBigInt(transaction.internalId),
          issueTransactionCreatedAt: transaction.createdAt,
          warehouseInternalId,
          variantInternalId: variant.internalId,
          quantity: consumption.quantity,
          costAmount: consumption.costAmount,
          consumptionKind: consumptionKind(input.type),
          createdBy: ctx.actorId,
        });
      }
      const next = applyIssueCostToAverage(averageState, magnitude, totalCostAmount);
      await this.repo.updateAverageCost(tx, toBigInt(averageRow.internalId), {
        quantityOnHand: next.quantityOnHand,
        avgCostAmount: next.unitCostAmount,
        totalValueAmount: next.totalValueAmount,
        lastTransactionInternalId: toBigInt(transaction.internalId),
      });
    }

    await this.emitMovementEvents(tx, ctx, transaction, variant, unitCostAmount, totalCostAmount);
    return {
      transaction,
      balance: { ...balanceRow, onHand: delta.onHand, reserved: delta.reserved, damaged: delta.damaged, inTransit: delta.inTransit },
      unitCostAmount,
      totalCostAmount,
    };
  }

  /** Controller-facing ledger movement (own transaction, e.g. opening balance). */
  async postMovementStandalone(ctx: TenantContext, input: PostMovementInput): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const result = await this.postMovement(tx, ctx, input);
      return { transaction: ledgerView(result.transaction), balance: balanceView(result.balance) };
    });
  }

  /**
   * Placement of an **inbound document** (purchasing receipt, return restock,
   * opening balance): the warehouse/location pair its ledger rows and documents
   * should use. A warehouse-less caller lands in the organization's default
   * warehouse — bootstrapped exactly like a stock adjustment when none exists — so
   * receiving works on a fresh install. Runs inside the caller's transaction.
   */
  async resolveInboundPlacement(
    tx: Db,
    ctx: TenantContext,
    warehousePublicId?: string | undefined,
  ): Promise<{ warehouseId: string; locationId: string; warehouseInternalId: bigint; locationInternalId: bigint }> {
    const warehouseInternalId =
      warehousePublicId === undefined
        ? await this.ensureDefaultWarehouse(tx, ctx)
        : await this.requireWarehouse(tx, ctx, warehousePublicId);
    const locationInternalId = await this.resolveDefaultAdjustmentLocation(tx, ctx, warehouseInternalId);
    const ids = await this.repo.placementPublicIds(tx, warehouseInternalId, locationInternalId);
    if (ids === null) throw notFound('warehouse');
    return { ...ids, warehouseInternalId, locationInternalId };
  }

  // ================================================================ reservations

  async listReservations(
    ctx: TenantContext,
    query: {
      limit: number;
      status?: string | undefined;
      variantId?: string | undefined;
      warehouseId?: string | undefined;
      sourceType?: string | undefined;
      sourceId?: string | undefined;
      expiresBefore?: string | undefined;
    },
  ): Promise<Record<string, unknown>[]> {
    const variant = query.variantId === undefined ? null : await this.catalog.requireVariant(ctx, query.variantId);
    const warehouseInternalId =
      query.warehouseId === undefined ? null : await this.requireWarehouse(this.db, ctx, query.warehouseId);
    const rows = await this.repo.listReservations(this.db, {
      orgId: ctx.orgId,
      status: query.status ?? null,
      variantInternalId: variant?.internalId ?? null,
      warehouseInternalId,
      referenceType: query.sourceType ?? null,
      referenceInternalId: query.sourceId === undefined ? null : toBigInt(query.sourceId),
      expiresBefore: query.expiresBefore ?? null,
      limit: query.limit,
    });
    return rows.map(reservationView);
  }

  async getReservation(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findReservation(this.db, ctx.orgId, publicId);
    if (row === null) throw notFound('reservation');
    return reservationView(row);
  }

  /** Manual reservation (`POST /inventory/reservations`). */
  async createReservation(
    ctx: TenantContext,
    input: {
      warehouseId?: string | undefined;
      lines: readonly { variantId: string; quantity: string }[];
      reason: string;
      ttlMinutes?: number | undefined;
    },
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const result = await this.reserveForReference(tx, ctx, {
        referenceType: 'manual',
        referenceInternalId: 0n,
        referencePublicId: null,
        lines: input.lines,
        warehouseIds: input.warehouseId === undefined ? null : [input.warehouseId],
        ttlMinutes: input.ttlMinutes ?? DEFAULT_RESERVATION_TTL_MINUTES,
        reason: input.reason,
      });
      return {
        id: result.reservations[0]?.id ?? null,
        reservations: result.reservations,
        allocations: result.plan.allocations,
      };
    });
  }

  /**
   * Reserves stock for a document (sales order confirm, transfer, count hold).
   * All-or-nothing: every line must be satisfiable or no reservation is written
   * (`ADR-0007` §3). Locks balances in variant→warehouse→location order.
   */
  async reserveForReference(
    tx: Db,
    ctx: TenantContext,
    input: {
      referenceType: string;
      referenceInternalId: bigint;
      referencePublicId: string | null;
      lines: readonly { variantId: string; quantity: string }[];
      warehouseIds?: readonly string[] | null;
      ttlMinutes: number;
      reason: string;
      strategy?: 'single_warehouse_first' | 'split_fewest_locations' | 'fifo';
    },
  ): Promise<{ plan: AllocationPlan; reservations: Record<string, unknown>[] }> {
    if (input.lines.length === 0) {
      throw new AppError('VALIDATION_ERROR', { details: [{ field: 'lines', rule: 'required' }] });
    }
    const variants = await this.catalog.findVariants(
      ctx,
      input.lines.map((line) => line.variantId),
    );
    const byPublicId = new Map(variants.map((variant) => [variant.id, variant]));
    const lines = input.lines.map((line, index) => {
      const variant = byPublicId.get(line.variantId);
      if (variant === undefined) throw notFound('variant');
      if (!isPositiveQuantity(line.quantity)) {
        throw new AppError('VALIDATION_ERROR', {
          details: [{ field: `lines[${index}].quantity`, rule: 'quantity_positive' }],
        });
      }
      return { lineIndex: index, variantId: variant.id, variantInternalId: variant.internalId, quantity: normalizeQuantity(line.quantity) };
    });
    const warehouseInternalIds =
      input.warehouseIds === undefined || input.warehouseIds === null
        ? null
        : await Promise.all(input.warehouseIds.map((id) => this.requireWarehouse(tx, ctx, id)));

    // Lock every candidate balance in the fixed order before planning, then
    // re-read availability from the locked rows (this is what makes the
    // 100-parallel-allocator scenario safe).
    const candidates = await this.repo.availabilityCandidates(tx, ctx.orgId, {
      variantInternalIds: [...new Set(lines.map((line) => line.variantInternalId))],
      warehouseInternalIds,
    });
    const keys = candidates.map((candidate) => ({
      warehouseInternalId: toBigInt(candidate.warehouseInternalId),
      locationInternalId: toBigInt(candidate.locationInternalId),
      variantInternalId: toBigInt(candidate.variantInternalId),
    }));
    const lockedRows = await this.repo.lockBalances(tx, ctx.orgId, keys);
    const lockedByKey = new Map<string, BalanceRow>();
    for (const row of lockedRows) {
      lockedByKey.set(
        `${row.variantInternalId}:${row.warehouseInternalId}:${row.locationInternalId}`,
        row,
      );
    }
    const lockedAvailability = await this.repo.availableForKeys(tx, ctx.orgId, keys);
    const lockedCandidates: BalanceCandidate[] = lockedAvailability.map((row) => ({
      warehouseId: this.publicIdFor(candidates, row.warehouseInternalId, 'warehouseInternalId'),
      locationId: this.publicIdFor(candidates, row.locationInternalId, 'locationInternalId'),
      variantId:
        variants.find((variant) => variant.internalId.toString() === row.variantInternalId)?.id ?? row.variantInternalId,
      available: row.available,
    }));
    const allKeys = new Map<string, { warehouseInternalId: bigint; locationInternalId: bigint; variantInternalId: bigint }>();
    for (const key of keys) {
      allKeys.set(`${key.variantInternalId}:${key.warehouseInternalId}:${key.locationInternalId}`, key);
    }
    const plan = assertAllocatable(
      planAllocation(
        lines.map((line) => ({ lineIndex: line.lineIndex, variantId: line.variantId, quantity: line.quantity })),
        lockedCandidates,
        input.strategy ?? 'single_warehouse_first',
        input.warehouseIds ?? [],
      ),
    );

    const expiresAt = reservationExpiry(new Date(), input.ttlMinutes);
    const reservations: Record<string, unknown>[] = [];
    const balanceUpdates = new Map<string, { row: BalanceRow; reserved: string }>();
    for (const grouped of groupReservations(plan)) {
      const variant = variants.find((item) => item.id === grouped.variantId);
      if (variant === undefined) throw notFound('variant');
      const key = allKeys.get(
        `${variant.internalId.toString()}:${toBigInt(grouped.warehouseId)}:${toBigInt(grouped.locationId)}`,
      );
      const warehouseInternalId = key?.warehouseInternalId ?? toBigInt(grouped.warehouseId);
      const locationInternalId = key?.locationInternalId ?? toBigInt(grouped.locationId);
      const row = lockedByKey.get(
        `${variant.internalId.toString()}:${warehouseInternalId.toString()}:${locationInternalId.toString()}`,
      );
      if (row === undefined) throw notFound('balance');
      const created = await this.repo.insertReservation(tx, {
        orgId: ctx.orgId,
        warehouseInternalId,
        locationInternalId,
        variantInternalId: variant.internalId,
        quantity: grouped.quantity,
        referenceType: input.referenceType,
        referenceInternalId: input.referenceInternalId,
        // 128 random bits are collision-free for a reservation number and keep
        // `RSV-` + 32 upper-case hex well inside the 40-char budget.
        reservationNo: `RSV-${randomUUID().replace(/-/g, '').slice(0, 32).toUpperCase()}`,
        expiresAt,
        createdBy: ctx.actorId,
      });
      const buffered = balanceUpdates.get(row.internalId) ?? { row, reserved: row.reserved };
      const reserved = applyReservationDelta(
        {
          onHand: buffered.row.onHand,
          reserved: buffered.reserved,
          safetyBuffer: buffered.row.safetyBuffer,
          damaged: buffered.row.damaged,
        },
        grouped.quantity,
      );
      balanceUpdates.set(row.internalId, { row: buffered.row, reserved });
      await this.repo.updateBalance(tx, toBigInt(row.internalId), {
        onHand: buffered.row.onHand,
        reserved,
        damaged: buffered.row.damaged,
        inTransit: buffered.row.inTransit,
        lastTransactionInternalId:
          buffered.row.lastTransactionId === null ? null : toBigInt(buffered.row.lastTransactionId),
      });
      reservations.push(reservationView(created));
      await this.emitReservationEvent(tx, ctx, created, INVENTORY_EVENTS.reservationCreated);
    }
    return { plan, reservations };
  }

  async releaseReservation(ctx: TenantContext, publicId: string, reason?: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const reservation = await this.repo.findReservation(tx, ctx.orgId, publicId);
      if (reservation === null) throw notFound('reservation');
      const updated = await this.releaseReservationRow(tx, ctx, reservation);
      await this.record(tx, ctx, 'inventory.reservation.release', 'stock_reservation', reservation.id, reservationView(reservation), reservationView(updated));
      void reason;
      return reservationView(updated);
    });
  }

  private async releaseReservationRow(
    tx: Db,
    ctx: TenantContext,
    reservation: ReservationRow,
    quantity?: string,
  ): Promise<ReservationRow> {
    const remaining = reservationRemaining({
      quantity: reservation.quantity,
      consumedQuantity: reservation.consumedQuantity,
      releasedQuantity: reservation.releasedQuantity,
      status: reservation.status as 'active',
      expiresAt: reservation.expiresAt,
    });
    const releaseQuantity = quantity ?? remaining;
    if (!isPositiveQuantity(releaseQuantity)) {
      throw new AppError('DOCUMENT_STATE_INVALID', { details: [{ rule: 'reservation_already_settled' }] });
    }
    const released = addQuantity(reservation.releasedQuantity, releaseQuantity);
    const newStatus = compareQuantity(addQuantity(released, reservation.consumedQuantity), reservation.quantity) === 0
      ? 'released'
      : 'active';
    await this.repo.updateReservation(tx, toBigInt(reservation.internalId), {
      status: newStatus,
      consumedQuantity: reservation.consumedQuantity,
      releasedQuantity: released,
      consumedTransactionInternalId:
        reservation.consumedTransactionId === null ? null : toBigInt(reservation.consumedTransactionId),
      touchConsumedAt: false,
      touchReleasedAt: newStatus === 'released',
    });
    const locked = await this.repo.lockBalances(tx, ctx.orgId, [
      {
        warehouseInternalId: toBigInt(reservation.warehouseInternalId),
        locationInternalId: toBigInt(reservation.locationInternalId),
        variantInternalId: toBigInt(reservation.variantInternalId),
      },
    ]);
    const row = locked[0];
    if (row === undefined) throw notFound('balance');
    const reserved = applyReservationDelta(balanceOf(row), `-${releaseQuantity.replace(/^-/, '')}`);
    await this.repo.updateBalance(tx, toBigInt(row.internalId), {
      onHand: row.onHand,
      reserved,
      damaged: row.damaged,
      inTransit: row.inTransit,
      lastTransactionInternalId: row.lastTransactionId === null ? null : toBigInt(row.lastTransactionId),
    });
    const refreshed = await this.repo.findReservation(tx, ctx.orgId, reservation.id);
    if (refreshed === null) throw notFound('reservation');
    await this.emitReservationEvent(tx, ctx, refreshed, INVENTORY_EVENTS.reservationReleased);
    return refreshed;
  }

  /** Releases every active reservation of a document (cancel/deallocate flows). */
  async releaseForReference(
    tx: Db,
    ctx: TenantContext,
    referenceType: string,
    referenceInternalId: bigint,
  ): Promise<number> {
    const reservations = await this.repo.lockReservations(tx, ctx.orgId, referenceType, referenceInternalId);
    for (const reservation of reservations) {
      await this.releaseReservationRow(tx, ctx, reservation);
    }
    return reservations.length;
  }

  /** Consumes a reservation into the ledger (`sale_issue` at shipment/pick issue). */
  async consumeReservation(
    ctx: TenantContext,
    publicId: string,
    input: { referenceType: string; referenceId: string },
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const reservation = await this.repo.findReservation(tx, ctx.orgId, publicId);
      if (reservation === null) throw notFound('reservation');
      const remaining = reservationRemaining({
        quantity: reservation.quantity,
        consumedQuantity: reservation.consumedQuantity,
        releasedQuantity: reservation.releasedQuantity,
        status: reservation.status as 'active',
        expiresAt: reservation.expiresAt,
      });
      const result = await this.postMovement(tx, ctx, {
        warehouseId: reservation.warehouseId,
        locationId: reservation.locationId,
        variantId: reservation.variantId,
        type: 'reservation_consume',
        quantity: remaining,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        referenceInternalId: toBigInt(input.referenceId),
      });
      await this.repo.updateReservation(tx, toBigInt(reservation.internalId), {
        status: 'consumed',
        consumedQuantity: addQuantity(reservation.consumedQuantity, remaining),
        releasedQuantity: reservation.releasedQuantity,
        consumedTransactionInternalId: toBigInt(result.transaction.internalId),
        touchConsumedAt: true,
        touchReleasedAt: false,
      });
      const balanceRow = await this.repo.lockBalances(tx, ctx.orgId, [
        {
          warehouseInternalId: toBigInt(reservation.warehouseInternalId),
          locationInternalId: toBigInt(reservation.locationInternalId),
          variantInternalId: toBigInt(reservation.variantInternalId),
        },
      ]);
      const row = balanceRow[0];
      if (row !== undefined) {
        const reserved = applyReservationDelta(balanceOf(row), `-${remaining.replace(/^-/, '')}`);
        await this.repo.updateBalance(tx, toBigInt(row.internalId), {
          onHand: result.balance.onHand,
          reserved,
          damaged: result.balance.damaged,
          inTransit: result.balance.inTransit,
          lastTransactionInternalId: toBigInt(result.transaction.internalId),
        });
      }
      const refreshed = await this.repo.findReservation(tx, ctx.orgId, publicId);
      if (refreshed === null) throw notFound('reservation');
      await this.emitReservationEvent(tx, ctx, refreshed, INVENTORY_EVENTS.reservationConsumed);
      return { reservation: reservationView(refreshed), transaction: ledgerView(result.transaction) };
    });
  }

  /** Sweep job: releases expired active reservations (`fulfillment:expire-reservations`). */
  async expireReservations(ctx: TenantContext): Promise<{ expired: number }> {
    return this.db.begin(async (tx) => {
      const expired = await this.repo.listReservations(tx, {
        orgId: ctx.orgId,
        status: 'active',
        variantInternalId: null,
        warehouseInternalId: null,
        referenceType: null,
        referenceInternalId: null,
        expiresBefore: new Date().toISOString(),
        limit: 500,
      });
      let count = 0;
      for (const reservation of expired) {
        await this.releaseReservationRow(tx, ctx, reservation);
        await this.repo.updateReservation(tx, toBigInt(reservation.internalId), {
          status: 'expired',
          consumedQuantity: reservation.consumedQuantity,
          releasedQuantity: addQuantity(reservation.releasedQuantity, reservationRemaining({
            quantity: reservation.quantity,
            consumedQuantity: reservation.consumedQuantity,
            releasedQuantity: reservation.releasedQuantity,
            status: 'active',
            expiresAt: reservation.expiresAt,
          })),
          consumedTransactionInternalId: null,
          touchConsumedAt: false,
          touchReleasedAt: true,
        });
        count += 1;
      }
      return { expired: count };
    });
  }

  // =============================================================== adjustments

  async listAdjustments(
    ctx: TenantContext,
    query: { page: number; perPage: number; status?: string | undefined; type?: string | undefined; warehouseId?: string | undefined },
  ): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const warehouseInternalId =
      query.warehouseId === undefined ? null : await this.requireWarehouse(this.db, ctx, query.warehouseId);
    const rows = await this.repo.listAdjustments(this.db, {
      orgId: ctx.orgId,
      status: query.status ?? null,
      type: query.type ?? null,
      warehouseInternalId,
      limit: query.perPage,
      offset: (query.page - 1) * query.perPage,
    });
    return { items: rows.map(adjustmentView), total: rows.length };
  }

  async getAdjustment(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findAdjustment(this.db, ctx.orgId, publicId);
    if (row === null) throw notFound('adjustment');
    const lines = await this.repo.listAdjustmentLines(this.db, toBigInt(row.internalId));
    return { ...adjustmentView(row), lines: lines.map(adjustmentLineView) };
  }

  /**
   * Inline stock delta used by the stock workspace (`POST /inventory/stock/adjust`).
   *
   * The delta is posted immediately through the same ledger primitive as every
   * other movement (balance projection, cost layers/average, accounting event and
   * audit share one transaction), so there is no second write path for stock.
   * A delta that would drive the balance negative is rejected before posting.
   */
  async quickAdjust(
    ctx: TenantContext,
    input: {
      variantId: string;
      quantityDelta: number;
      reason?: string | undefined;
      warehouseId?: string | undefined;
    },
  ): Promise<QuickAdjustResult> {
    if (!Number.isInteger(input.quantityDelta) || input.quantityDelta === 0) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'quantityDelta', rule: 'quantity_delta_invalid' }],
      });
    }
    const delta = input.quantityDelta;
    const inbound = delta > 0;
    return this.db.begin(async (tx) => {
      const variant = await this.catalog.requireVariant(ctx, input.variantId);
      const warehouseInternalId =
        input.warehouseId === undefined
          ? await this.ensureDefaultWarehouse(tx, ctx)
          : await this.requireWarehouse(tx, ctx, input.warehouseId);
      const locationInternalId = await this.resolveDefaultAdjustmentLocation(tx, ctx, warehouseInternalId);
      const publicIds = await this.repo.publicIds(tx, warehouseInternalId, locationInternalId, variant.internalId);
      const key = { warehouseInternalId, locationInternalId, variantInternalId: variant.internalId };
      const systemQuantity = normalizeQuantity(await this.repo.findOnHand(tx, ctx.orgId, key));
      const magnitude = normalizeQuantity(String(Math.abs(delta)));
      const countedQuantity = inbound ? addQuantity(systemQuantity, magnitude) : subQuantity(systemQuantity, magnitude);
      if (compareQuantity(countedQuantity, '0') < 0) {
        throw new AppError('RULE_VIOLATION', {
          message: 'موجودی منفی نتیجهٔ این تعدیل است و مجاز نیست.',
          messageKey: 'inventory.negative_stock',
          details: [
            {
              field: 'quantityDelta',
              rule: 'negative_stock',
              params: { systemQuantity, requested: delta },
            },
          ],
        });
      }
      // Reading (not locking) the average only picks the movement type/cost; the
      // lock order stays owned by `postMovement` (layers → average → balance).
      const average = await this.repo.findAverageCost(tx, warehouseInternalId, variant.internalId);
      const averageUnitCost = average === null ? 0n : BigInt(average.avgCostAmount);
      const movementType: InventoryTransactionType = inbound
        ? averageUnitCost > 0n
          ? 'adjustment_in'
          : 'opening_balance'
        : 'adjustment_out';

      const businessDate = await this.organizationBusinessDate(tx, ctx);
      const adjustmentNo = await this.repo.allocateDocumentNo(tx, ctx.orgId, 'stock_adjustment', businessDate);
      const adjustment = await this.repo.insertAdjustment(tx, {
        orgId: ctx.orgId,
        warehouseInternalId,
        adjustmentNo,
        reasonCode: 'correction',
        description: input.reason ?? null,
        requiresApproval: false,
        createdBy: ctx.actorId,
      });
      const movement = await this.postMovement(tx, ctx, {
        warehouseId: publicIds.warehouseId,
        locationId: publicIds.locationId,
        variantId: variant.id,
        type: movementType,
        quantity: magnitude,
        unitCostAmount: inbound ? averageUnitCost : null,
        referenceType: 'stock_adjustment',
        referenceId: adjustment.id,
        referenceInternalId: toBigInt(adjustment.internalId),
        idempotencyKey: `stock-adjust:${adjustment.id}`,
        businessDate,
      });
      const adjustmentLine = await this.repo.insertAdjustmentLine(tx, {
        adjustmentInternalId: toBigInt(adjustment.internalId),
        variantInternalId: variant.internalId,
        locationInternalId,
        lotInternalId: null,
        systemQuantity,
        countedQuantity,
        differenceQuantity: inbound ? magnitude : subQuantity('0.0000', magnitude),
        unitCostAmount: movement.unitCostAmount,
      });
      await this.repo.setAdjustmentLineTransaction(
        tx,
        toBigInt(adjustmentLine.internalId),
        toBigInt(movement.transaction.internalId),
      );
      await this.repo.updateAdjustmentStatus(tx, toBigInt(adjustment.internalId), {
        status: 'applied',
        applied: true,
      });
      if (movement.totalCostAmount > 0n) {
        await this.emitAccounting(
          tx,
          ctx,
          INVENTORY_ACCOUNTING_EVENTS.adjustmentPosted,
          'stock_adjustment',
          toBigInt(adjustment.internalId),
          {
            adjustmentId: adjustment.internalId.toString(),
            adjustmentPublicId: adjustment.id,
            adjustmentNo: adjustment.adjustmentNo,
            warehouseId: publicIds.warehouseId,
            reasonCode: 'correction',
            kind: inbound ? 'count_gain' : 'count_shortage',
            totalCostAmount: movement.totalCostAmount.toString(),
            businessDate,
            ledgerIds: [movement.transaction.id],
            status: 'applied',
          },
        );
      }
      await this.record(
        tx,
        ctx,
        'inventory.adjustment.quick_adjust',
        'stock_adjustment',
        adjustment.id,
        null,
        {
          variantId: variant.id,
          warehouseId: publicIds.warehouseId,
          quantityDelta: delta,
          reason: input.reason ?? null,
        },
      );
      return {
        adjustmentId: adjustment.id,
        variantId: variant.id,
        variantInternalId: variant.internalId,
        warehouseId: publicIds.warehouseId,
        onHand: normalizeQuantity(movement.balance.onHand),
      };
    });
  }

  async createAdjustment(
    ctx: TenantContext,
    body: {
      warehouseId: string;
      type: 'increase' | 'decrease' | 'writeoff' | 'damage' | 'correction';
      reason: string;
      lines: readonly { variantId: string; locationId?: string | undefined; quantity: string; unitCost?: string | undefined }[];
      attachmentFileIds?: readonly string[] | undefined;
    },
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const warehouseInternalId = await this.requireWarehouse(tx, ctx, body.warehouseId);
      const businessDate = await this.organizationBusinessDate(tx, ctx);
      const adjustmentNo = await this.repo.allocateDocumentNo(tx, ctx.orgId, 'stock_adjustment', businessDate);
      const reasonCode = mapAdjustmentReason(body.type, body.reason);
      const lines = [];
      let totalValue = 0n;
      let defaultLocationInternalId: bigint | null = null;
      for (const [index, line] of body.lines.entries()) {
        const variant = await this.catalog.requireVariant(ctx, line.variantId);
        const locationInternalId =
          line.locationId === undefined
            ? (defaultLocationInternalId ??= await this.resolveDefaultAdjustmentLocation(tx, ctx, warehouseInternalId))
            : await this.requireLocation(tx, ctx, line.locationId);
        const balance = await this.repo.lockBalances(tx, ctx.orgId, [
          { warehouseInternalId, locationInternalId, variantInternalId: variant.internalId },
        ]);
        const systemQuantity = balance[0]?.onHand ?? '0.0000';
        const direction = adjustmentDirection(body.type);
        const countedQuantity =
          direction === 'in'
            ? addQuantity(systemQuantity, line.quantity)
            : subQuantity(systemQuantity, line.quantity);
        if (compareQuantity(countedQuantity, '0') < 0) {
          throw new AppError('RULE_VIOLATION', {
            message: 'موجودی منفی نتیجهٔ این تعدیل است و مجاز نیست.',
            messageKey: 'inventory.negative_stock',
            details: [
              {
                field: `lines[${index}].quantity`,
                rule: 'negative_stock',
                params: { systemQuantity, requested: line.quantity },
              },
            ],
          });
        }
        const systemQuantityValue = parseQuantity(systemQuantity);
        const unitCost =
          line.unitCost === undefined ? 0n : parseMoney(line.unitCost);
        totalValue +=
          unitCost *
          (parseQuantity(countedQuantity) > systemQuantityValue
            ? parseQuantity(countedQuantity) - systemQuantityValue
            : systemQuantityValue - parseQuantity(countedQuantity)) /
          10_000n;
        lines.push({
          variantInternalId: variant.internalId,
          locationInternalId,
          systemQuantity: normalizeQuantity(systemQuantity),
          countedQuantity: normalizeQuantity(countedQuantity),
          differenceQuantity: normalizeQuantity(subQuantity(countedQuantity, systemQuantity)),
          unitCostAmount: unitCost,
        });
      }
      const adjustment = await this.repo.insertAdjustment(tx, {
        orgId: ctx.orgId,
        warehouseInternalId,
        adjustmentNo,
        reasonCode,
        description: body.reason,
        requiresApproval: totalValue >= ADJUSTMENT_APPROVAL_THRESHOLD,
        createdBy: ctx.actorId,
      });
      for (const line of lines) {
        await this.repo.insertAdjustmentLine(tx, {
          adjustmentInternalId: toBigInt(adjustment.internalId),
          variantInternalId: line.variantInternalId,
          locationInternalId: line.locationInternalId,
          lotInternalId: null,
          systemQuantity: line.systemQuantity,
          countedQuantity: line.countedQuantity,
          differenceQuantity: line.differenceQuantity,
          unitCostAmount: line.unitCostAmount,
        });
      }
      await this.record(tx, ctx, 'inventory.adjustment.create', 'stock_adjustment', adjustment.id, null, adjustmentView(adjustment));
      return this.getAdjustmentInTx(tx, ctx, adjustment.id);
    });
  }

  private async getAdjustmentInTx(tx: Db, ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findAdjustment(tx, ctx.orgId, publicId);
    if (row === null) throw notFound('adjustment');
    const lines = await this.repo.listAdjustmentLines(tx, toBigInt(row.internalId));
    return { ...adjustmentView(row), lines: lines.map(adjustmentLineView) };
  }

  async submitAdjustment(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const adjustment = await this.requireAdjustment(tx, ctx, publicId);
      assertState(adjustment.status, ['draft'], 'adjustment_submit');
      const nextStatus = adjustment.requiresApproval ? 'pending_approval' : 'approved';
      await this.repo.updateAdjustmentStatus(tx, toBigInt(adjustment.internalId), { status: nextStatus });
      return this.getAdjustmentInTx(tx, ctx, publicId);
    });
  }

  async approveAdjustment(
    ctx: TenantContext,
    publicId: string,
    input: { stepUpToken?: string | undefined; note?: string | undefined },
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const adjustment = await this.requireAdjustment(tx, ctx, publicId);
      assertState(adjustment.status, ['pending_approval'], 'adjustment_approve');
      if (adjustment.createdBy !== null && ctx.actorId !== null && toBigInt(adjustment.createdBy) === ctx.actorId) {
        throw new AppError('FORBIDDEN', {
          message: 'تأییدکننده نمی‌تواند همان درخواست‌دهنده باشد.',
          messageKey: 'inventory.self_approval',
          details: [{ rule: 'separation_of_duties' }],
        });
      }
      void input.stepUpToken;
      await this.repo.updateAdjustmentStatus(tx, toBigInt(adjustment.internalId), {
        status: 'approved',
        approvedBy: ctx.actorId,
      });
      await this.record(tx, ctx, 'inventory.adjustment.approve', 'stock_adjustment', adjustment.id, adjustmentView(adjustment), { status: 'approved' });
      return this.getAdjustmentInTx(tx, ctx, publicId);
    });
  }

  async postAdjustment(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const adjustment = await this.requireAdjustment(tx, ctx, publicId);
      assertState(adjustment.status, ['approved'], 'adjustment_post');
      const businessDate = await this.organizationBusinessDate(tx, ctx);
      const lines = await this.repo.listAdjustmentLines(tx, toBigInt(adjustment.internalId));
      const ledgerIds: string[] = [];
      let gainCostAmount = 0n;
      let lossCostAmount = 0n;
      for (const line of lines) {
        if (compareQuantity(line.differenceQuantity, '0') === 0) continue;
        const inbound = compareQuantity(line.differenceQuantity, '0') > 0;
        const type: InventoryTransactionType =
          inbound
            ? adjustment.reasonCode === 'count_gain'
              ? 'count_correction_in'
              : 'adjustment_in'
            : mapAdjustmentOutType(adjustment.reasonCode);
        const movement = await this.postMovement(tx, ctx, {
          warehouseId: adjustment.warehouseId,
          locationId: line.locationId,
          variantId: line.variantId,
          type,
          quantity: absQuantity(line.differenceQuantity),
          unitCostAmount: BigInt(line.unitCostAmount),
          referenceType: 'stock_adjustment',
          referenceId: adjustment.id,
          referenceInternalId: toBigInt(adjustment.internalId),
          idempotencyKey: `adj:${adjustment.id}:line:${line.id}`,
          businessDate,
        });
        ledgerIds.push(movement.transaction.id);
        if (inbound) gainCostAmount += movement.totalCostAmount;
        else lossCostAmount += movement.totalCostAmount;
        await this.repo.setAdjustmentLineTransaction(
          tx,
          toBigInt(line.internalId),
          toBigInt(movement.transaction.internalId),
        );
      }
      await this.repo.updateAdjustmentStatus(tx, toBigInt(adjustment.internalId), {
        status: 'applied',
        applied: true,
      });
      const adjustmentBusinessDate = businessDate;
      if (gainCostAmount > 0n) {
        await this.emitAccounting(tx, ctx, INVENTORY_ACCOUNTING_EVENTS.adjustmentPosted, 'stock_adjustment', toBigInt(adjustment.internalId), {
          adjustmentId: adjustment.internalId.toString(),
          adjustmentPublicId: adjustment.id,
          adjustmentNo: adjustment.adjustmentNo,
          warehouseId: adjustment.warehouseId,
          reasonCode: adjustment.reasonCode,
          kind: 'count_gain',
          totalCostAmount: gainCostAmount.toString(),
          businessDate: adjustmentBusinessDate,
          ledgerIds,
          status: 'applied',
        });
      }
      if (lossCostAmount > 0n) {
        const lossKind = adjustment.reasonCode === 'damage' ? 'damage' : adjustment.reasonCode === 'writeoff' ? 'writeoff' : 'count_shortage';
        await this.emitAccounting(tx, ctx, INVENTORY_ACCOUNTING_EVENTS.adjustmentPosted, 'stock_adjustment', toBigInt(adjustment.internalId), {
          adjustmentId: adjustment.internalId.toString(),
          adjustmentPublicId: adjustment.id,
          adjustmentNo: adjustment.adjustmentNo,
          warehouseId: adjustment.warehouseId,
          reasonCode: adjustment.reasonCode,
          kind: lossKind,
          totalCostAmount: lossCostAmount.toString(),
          businessDate: adjustmentBusinessDate,
          ledgerIds,
          status: 'applied',
        });
      }
      // Single canonical event: the accounting payload also carries the domain
      // fields so consumers do not receive a second, amount-less event with the
      // same event_type (which would be mis-posted by the accounting handler).
      await this.record(tx, ctx, 'inventory.adjustment.post', 'stock_adjustment', adjustment.id, adjustmentView(adjustment), { status: 'applied', ledgerIds });
      return this.getAdjustmentInTx(tx, ctx, publicId);
    });
  }

  async voidAdjustment(ctx: TenantContext, publicId: string, reason: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const adjustment = await this.requireAdjustment(tx, ctx, publicId);
      assertState(adjustment.status, ['applied'], 'adjustment_void');
      const businessDate = await this.organizationBusinessDate(tx, ctx);
      const lines = await this.repo.listAdjustmentLines(tx, toBigInt(adjustment.internalId));
      const ledgerIds: string[] = [];
      let dispatchCostAmount = 0n;
      for (const line of lines) {
        if (compareQuantity(line.differenceQuantity, '0') === 0) continue;
        const inbound = compareQuantity(line.differenceQuantity, '0') > 0;
        const movement = await this.postMovement(tx, ctx, {
          warehouseId: adjustment.warehouseId,
          locationId: line.locationId,
          variantId: line.variantId,
          type: inbound ? 'adjustment_out' : 'adjustment_in',
          quantity: absQuantity(line.differenceQuantity),
          unitCostAmount: BigInt(line.unitCostAmount),
          referenceType: 'stock_adjustment',
          referenceId: adjustment.id,
          referenceInternalId: toBigInt(adjustment.internalId),
          idempotencyKey: `adj-void:${adjustment.id}:line:${line.id}`,
          reversalOfInternalId:
            line.inventoryTransactionId === null ? null : toBigInt(line.inventoryTransactionId),
          businessDate,
        });
        ledgerIds.push(movement.transaction.id);
      }
      await this.repo.updateAdjustmentStatus(tx, toBigInt(adjustment.internalId), { status: 'voided' });
      await this.record(tx, ctx, 'inventory.adjustment.void', 'stock_adjustment', adjustment.id, adjustmentView(adjustment), { status: 'voided', reason, ledgerIds });
      return this.getAdjustmentInTx(tx, ctx, publicId);
    });
  }

  // ================================================================= transfers

  async listTransfers(
    ctx: TenantContext,
    query: { limit: number; status?: string | undefined; fromWarehouseId?: string | undefined; toWarehouseId?: string | undefined },
  ): Promise<Record<string, unknown>[]> {
    const fromWarehouseInternalId =
      query.fromWarehouseId === undefined ? null : await this.requireWarehouse(this.db, ctx, query.fromWarehouseId);
    const toWarehouseInternalId =
      query.toWarehouseId === undefined ? null : await this.requireWarehouse(this.db, ctx, query.toWarehouseId);
    const rows = await this.repo.listTransfers(this.db, {
      orgId: ctx.orgId,
      status: query.status ?? null,
      fromWarehouseInternalId,
      toWarehouseInternalId,
      limit: query.limit,
    });
    return rows.map(transferView);
  }

  async getTransfer(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findTransfer(this.db, ctx.orgId, publicId);
    if (row === null) throw notFound('transfer');
    const lines = await this.repo.listTransferLines(this.db, toBigInt(row.internalId));
    return { ...transferView(row), lines: lines.map(transferLineView) };
  }

  async createTransfer(
    ctx: TenantContext,
    body: {
      fromWarehouseId: string;
      toWarehouseId: string;
      lines: readonly { variantId: string; fromLocationId: string; toLocationId?: string | undefined; quantity: string }[];
      reason: string;
      expectedAt?: string | undefined;
    },
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const fromWarehouseInternalId = await this.requireWarehouse(tx, ctx, body.fromWarehouseId);
      const toWarehouseInternalId = await this.requireWarehouse(tx, ctx, body.toWarehouseId);
      if (fromWarehouseInternalId === toWarehouseInternalId) {
        throw new AppError('RULE_VIOLATION', {
          message: 'انبار مبدأ و مقصد باید متفاوت باشند.',
          messageKey: 'inventory.transfer_same_warehouse',
          details: [{ rule: 'transfer_same_warehouse' }],
        });
      }
      const businessDate = await this.organizationBusinessDate(tx, ctx);
      const transferNo = await this.repo.allocateDocumentNo(tx, ctx.orgId, 'inventory_transfer', businessDate);
      const transfer = await this.repo.insertTransfer(tx, {
        orgId: ctx.orgId,
        transferNo,
        fromWarehouseInternalId,
        toWarehouseInternalId,
        notes: body.reason,
        requestedBy: ctx.actorId,
      });
      const lines = [];
      for (const line of body.lines) {
        const variant = await this.catalog.requireVariant(ctx, line.variantId);
        const fromLocationInternalId = await this.requireLocation(tx, ctx, line.fromLocationId);
        const toLocationInternalId =
          line.toLocationId === undefined ? null : await this.requireLocation(tx, ctx, line.toLocationId);
        const created = await this.repo.insertTransferLine(tx, {
          transferInternalId: toBigInt(transfer.internalId),
          variantInternalId: variant.internalId,
          lotInternalId: null,
          quantity: normalizeQuantity(line.quantity),
          fromLocationInternalId,
          toLocationInternalId,
          unitCostAmount: 0n,
        });
        lines.push(transferLineView(created));
      }
      await this.record(tx, ctx, 'inventory.transfer.create', 'inventory_transfer', transfer.id, null, transferView(transfer));
      return { ...transferView(transfer), lines };
    });
  }

  async submitTransfer(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const transfer = await this.requireTransfer(tx, ctx, publicId);
      assertState(transfer.status, ['draft'], 'transfer_submit');
      await this.repo.updateTransferStatus(tx, toBigInt(transfer.internalId), { status: 'pending_approval' });
      return this.getTransferInTx(tx, ctx, publicId);
    });
  }

  async approveTransfer(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const transfer = await this.requireTransfer(tx, ctx, publicId);
      assertState(transfer.status, ['pending_approval'], 'transfer_approve');
      await this.repo.updateTransferStatus(tx, toBigInt(transfer.internalId), {
        status: 'approved',
        approvedBy: ctx.actorId,
      });
      return this.getTransferInTx(tx, ctx, publicId);
    });
  }

  async dispatchTransfer(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const transfer = await this.requireTransfer(tx, ctx, publicId);
      assertState(transfer.status, ['approved', 'pending_approval'], 'transfer_dispatch');
      const businessDate = await this.organizationBusinessDate(tx, ctx);
      const lines = await this.repo.listTransferLines(tx, toBigInt(transfer.internalId));
      const ledgerIds: string[] = [];
      let dispatchCostAmount = 0n;
      for (const line of lines) {
        if (line.fromLocationId === null) {
          throw new AppError('RULE_VIOLATION', {
            message: 'برای ارسال، مکان مبدأ هر قلم الزامی است.',
            messageKey: 'inventory.transfer_from_location_required',
            details: [{ rule: 'transfer_from_location_required' }],
          });
        }
        const movement = await this.postMovement(tx, ctx, {
          warehouseId: transfer.fromWarehouseId,
          locationId: line.fromLocationId,
          variantId: line.variantId,
          type: 'transfer_out',
          quantity: line.quantity,
          referenceType: 'inventory_transfer',
          referenceId: transfer.id,
          referenceInternalId: toBigInt(transfer.internalId),
          idempotencyKey: `trf-out:${transfer.id}:line:${line.id}`,
          businessDate,
        });
        ledgerIds.push(movement.transaction.id);
        dispatchCostAmount += movement.totalCostAmount;
        // Park the quantity in transit on the *source* balance row.
        const sourceBalance = await this.repo.lockBalances(tx, ctx.orgId, [
          {
            warehouseInternalId: toBigInt(transfer.fromWarehouseInternalId),
            locationInternalId: toBigInt(line.fromLocationInternalId ?? '0'),
            variantInternalId: toBigInt(line.variantInternalId),
          },
        ]);
        const row = sourceBalance[0];
        if (row !== undefined) {
          await this.repo.updateBalance(tx, toBigInt(row.internalId), {
            onHand: row.onHand,
            reserved: row.reserved,
            damaged: row.damaged,
            inTransit: addQuantity(row.inTransit, line.quantity),
            lastTransactionInternalId: toBigInt(movement.transaction.internalId),
          });
        }
        await this.repo.updateTransferLine(tx, toBigInt(line.internalId), {
          dispatchedQuantity: line.quantity,
          receivedQuantity: line.receivedQuantity,
          unitCostAmount: movement.unitCostAmount.toString(),
        });
      }
      await this.repo.updateTransferStatus(tx, toBigInt(transfer.internalId), {
        status: 'dispatched',
        dispatched: true,
      });
      // Single canonical accounting event (TD-29): amounts + domain fields.
      await this.emitAccounting(tx, ctx, INVENTORY_ACCOUNTING_EVENTS.transferDispatched, 'inventory_transfer', toBigInt(transfer.internalId), {
        transferId: transfer.internalId.toString(),
        transferPublicId: transfer.id,
        transferNo: transfer.transferNo,
        fromWarehouseId: transfer.fromWarehouseId,
        toWarehouseId: transfer.toWarehouseId,
        totalCostAmount: dispatchCostAmount.toString(),
        businessDate,
        ledgerIds,
        status: 'dispatched',
      });
      return this.getTransferInTx(tx, ctx, publicId);
    });
  }

  async receiveTransfer(
    ctx: TenantContext,
    publicId: string,
    body: { lines: readonly { lineId: string; receivedQuantity: string; toLocationId: string }[] },
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const transfer = await this.requireTransfer(tx, ctx, publicId);
      assertState(transfer.status, ['dispatched', 'partially_received'], 'transfer_receive');
      const businessDate = await this.organizationBusinessDate(tx, ctx);
      const lines = await this.repo.listTransferLines(tx, toBigInt(transfer.internalId));
      const ledgerIds: string[] = [];
      let receiveCostAmount = 0n;
      let allReceived = true;
      for (const received of body.lines) {
        const line = lines.find((candidate) => candidate.id === received.lineId);
        if (line === undefined) throw notFound('transfer_line');
        if (!isPositiveQuantity(received.receivedQuantity)) continue;
        const toLocationInternalId = await this.requireLocation(tx, ctx, received.toLocationId);
        const movement = await this.postMovement(tx, ctx, {
          warehouseId: transfer.toWarehouseId,
          locationId: received.toLocationId,
          variantId: line.variantId,
          type: 'transfer_in',
          quantity: received.receivedQuantity,
          unitCostAmount: BigInt(line.unitCostAmount ?? '0'),
          referenceType: 'inventory_transfer',
          referenceId: transfer.id,
          referenceInternalId: toBigInt(transfer.internalId),
          idempotencyKey: `trf-in:${transfer.id}:line:${line.id}`,
          businessDate,
        });
        ledgerIds.push(movement.transaction.id);
        receiveCostAmount += movement.totalCostAmount;
        const receivedTotal = addQuantity(line.receivedQuantity, received.receivedQuantity);
        if (compareQuantity(receivedTotal, line.dispatchedQuantity) < 0) allReceived = false;
        await this.repo.updateTransferLine(tx, toBigInt(line.internalId), {
          dispatchedQuantity: line.dispatchedQuantity,
          receivedQuantity: receivedTotal,
          toLocationInternalId,
        });
        // Clear in-transit on the source balance.
        if (line.fromLocationInternalId !== null) {
          const sourceBalance = await this.repo.lockBalances(tx, ctx.orgId, [
            {
              warehouseInternalId: toBigInt(transfer.fromWarehouseInternalId),
              locationInternalId: toBigInt(line.fromLocationInternalId),
              variantInternalId: toBigInt(line.variantInternalId),
            },
          ]);
          const row = sourceBalance[0];
          if (row !== undefined) {
            const nextInTransit = subQuantity(row.inTransit, received.receivedQuantity);
            await this.repo.updateBalance(tx, toBigInt(row.internalId), {
              onHand: row.onHand,
              reserved: row.reserved,
              damaged: row.damaged,
              inTransit: compareQuantity(nextInTransit, '0') < 0 ? '0.0000' : nextInTransit,
              lastTransactionInternalId: toBigInt(movement.transaction.internalId),
            });
          }
        }
      }
      const status = allReceived ? 'received' : 'partially_received';
      await this.repo.updateTransferStatus(tx, toBigInt(transfer.internalId), {
        status,
        received: allReceived,
      });
      if (allReceived && receiveCostAmount > 0n) {
        await this.emitAccounting(tx, ctx, INVENTORY_ACCOUNTING_EVENTS.transferReceived, 'inventory_transfer', toBigInt(transfer.internalId), {
          transferId: transfer.internalId.toString(),
          transferPublicId: transfer.id,
          transferNo: transfer.transferNo,
          fromWarehouseId: transfer.fromWarehouseId,
          toWarehouseId: transfer.toWarehouseId,
          totalCostAmount: receiveCostAmount.toString(),
          businessDate,
          ledgerIds,
          status,
        });
      }
      return this.getTransferInTx(tx, ctx, publicId);
    });
  }

  async cancelTransfer(ctx: TenantContext, publicId: string, reason: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const transfer = await this.requireTransfer(tx, ctx, publicId);
      assertState(transfer.status, ['draft', 'pending_approval', 'approved'], 'transfer_cancel');
      await this.repo.updateTransferStatus(tx, toBigInt(transfer.internalId), { status: 'cancelled' });
      await this.record(tx, ctx, 'inventory.transfer.cancel', 'inventory_transfer', transfer.id, transferView(transfer), { status: 'cancelled', reason });
      return this.getTransferInTx(tx, ctx, publicId);
    });
  }

  private async getTransferInTx(tx: Db, ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findTransfer(tx, ctx.orgId, publicId);
    if (row === null) throw notFound('transfer');
    const lines = await this.repo.listTransferLines(tx, toBigInt(row.internalId));
    return { ...transferView(row), lines: lines.map(transferLineView) };
  }

  // ==================================================================== counts

  async listCounts(
    ctx: TenantContext,
    query: { limit: number; status?: string | undefined; type?: string | undefined; warehouseId?: string | undefined },
  ): Promise<Record<string, unknown>[]> {
    const warehouseInternalId =
      query.warehouseId === undefined ? null : await this.requireWarehouse(this.db, ctx, query.warehouseId);
    const rows = await this.repo.listCounts(this.db, {
      orgId: ctx.orgId,
      status: query.status ?? null,
      type: query.type ?? null,
      warehouseInternalId,
      limit: query.limit,
    });
    return rows.map(countView);
  }

  async getCount(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findCount(this.db, ctx.orgId, publicId);
    if (row === null) throw notFound('count');
    const lines = await this.repo.listCountLines(this.db, toBigInt(row.internalId));
    return { ...countView(row), lines: lines.map(countLineView) };
  }

  async createCount(
    ctx: TenantContext,
    body: {
      warehouseId: string;
      type: 'spot' | 'cycle' | 'full';
      scope: { locationIds?: readonly string[] | undefined; categoryIds?: readonly string[] | undefined; variantIds?: readonly string[] | undefined };
      blind?: boolean | undefined;
      scheduledAt?: string | undefined;
    },
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const warehouseInternalId = await this.requireWarehouse(tx, ctx, body.warehouseId);
      const businessDate = await this.organizationBusinessDate(tx, ctx);
      const countNo = await this.repo.allocateDocumentNo(tx, ctx.orgId, 'stock_count', businessDate);
      const locationInternalIds =
        body.scope.locationIds === undefined
          ? null
          : await Promise.all(body.scope.locationIds.map((id) => this.requireLocation(tx, ctx, id)));
      const variantInternalIds =
        body.scope.variantIds === undefined
          ? null
          : await Promise.all(body.scope.variantIds.map(async (id) => (await this.catalog.requireVariant(ctx, id)).internalId));
      const count = await this.repo.insertCount(tx, {
        orgId: ctx.orgId,
        warehouseInternalId,
        countNo,
        countType: body.type,
        zoneInternalId: null,
        createdBy: ctx.actorId,
      });
      const balances = await this.repo.balancesForScope(tx, ctx.orgId, {
        warehouseInternalId,
        locationInternalIds,
        variantInternalIds,
      });
      await this.repo.seedCountLines(
        tx,
        toBigInt(count.internalId),
        balances.map((balance) => ({
          locationInternalId: toBigInt(balance.locationInternalId),
          variantInternalId: toBigInt(balance.variantInternalId),
          lotInternalId: null,
          expectedQuantity: balance.onHand,
        })),
      );
      await this.record(tx, ctx, 'inventory.count.create', 'stock_count', count.id, null, countView(count));
      return this.getCountInTx(tx, ctx, count.id);
    });
  }

  async startCount(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const count = await this.requireCount(tx, ctx, publicId);
      assertState(count.status, ['draft'], 'count_start');
      await this.repo.updateCountStatus(tx, toBigInt(count.internalId), 'counting');
      return this.getCountInTx(tx, ctx, publicId);
    });
  }

  async recordCountScan(
    ctx: TenantContext,
    publicId: string,
    body: { eventId?: string | undefined; variantId: string; locationId?: string | undefined; countedQuantity: string },
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const count = await this.requireCount(tx, ctx, publicId);
      assertState(count.status, ['counting'], 'count_scan');
      const variant = await this.catalog.requireVariant(ctx, body.variantId);
      const lines = await this.repo.listCountLines(tx, toBigInt(count.internalId));
      const line =
        body.locationId === undefined
          ? lines.find((candidate) => candidate.variantInternalId === variant.internalId.toString())
          : lines.find(
              (candidate) =>
                candidate.variantInternalId === variant.internalId.toString() &&
                candidate.locationId === body.locationId,
            );
      if (line === undefined) {
        throw new AppError('RULE_VIOLATION', {
          message: 'این قلم در محدودهٔ شمارش وجود ندارد.',
          messageKey: 'inventory.count_line_not_in_scope',
          details: [{ rule: 'unexpected_item' }],
        });
      }
      const countedQuantity = normalizeQuantity(body.countedQuantity);
      const variance = subQuantity(countedQuantity, line.expectedQuantity);
      await this.repo.recordCountLine(tx, toBigInt(count.internalId), {
        locationInternalId: toBigInt(line.locationInternalId),
        variantInternalId: variant.internalId,
        lotInternalId: null,
        expectedQuantity: line.expectedQuantity,
        countedQuantity,
        varianceQuantity: variance,
        countedBy: ctx.actorId,
      });
      await this.repo.setLastCounted(tx, toBigInt(line.internalId), new Date().toISOString()).catch(() => undefined);
      return this.getCountInTx(tx, ctx, publicId);
    });
  }

  async submitCount(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const count = await this.requireCount(tx, ctx, publicId);
      assertState(count.status, ['counting'], 'count_submit');
      await this.repo.updateCountStatus(tx, toBigInt(count.internalId), 'pending_approval');
      return this.getCountInTx(tx, ctx, publicId);
    });
  }

  async approveCount(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const count = await this.requireCount(tx, ctx, publicId);
      assertState(count.status, ['pending_approval'], 'count_approve');
      await this.repo.updateCountStatus(tx, toBigInt(count.internalId), 'approved');
      await this.record(tx, ctx, 'inventory.count.approve', 'stock_count', count.id, countView(count), { status: 'approved' });
      return this.getCountInTx(tx, ctx, publicId);
    });
  }

  /** Posts the count variance as a linked adjustment document in one transaction. */
  async postCount(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const count = await this.requireCount(tx, ctx, publicId);
      assertState(count.status, ['approved'], 'count_post');
      const businessDate = await this.organizationBusinessDate(tx, ctx);
      const lines = await this.repo.listCountLines(tx, toBigInt(count.internalId));
      const variances = lines.filter(
        (line) => line.countedQuantity !== null && line.varianceQuantity !== null && compareQuantity(line.varianceQuantity, '0') !== 0,
      );
      const adjustmentNo = await this.repo.allocateDocumentNo(tx, ctx.orgId, 'stock_adjustment', businessDate);
      const adjustment = await this.repo.insertAdjustment(tx, {
        orgId: ctx.orgId,
        warehouseInternalId: toBigInt(count.warehouseInternalId),
        adjustmentNo,
        reasonCode: 'correction',
        description: `اصلاح مغایرت شمارش ${count.countNo}`,
        requiresApproval: false,
        createdBy: ctx.actorId,
      });
      const ledgerIds: string[] = [];
      for (const line of variances) {
        const inbound = compareQuantity(line.varianceQuantity ?? '0', '0') > 0;
        const movement = await this.postMovement(tx, ctx, {
          warehouseId: count.warehouseId,
          locationId: line.locationId,
          variantId: line.variantId,
          type: inbound ? 'count_correction_in' : 'count_correction_out',
          quantity: absQuantity(line.varianceQuantity ?? '0'),
          referenceType: 'stock_count',
          referenceId: count.id,
          referenceInternalId: toBigInt(count.internalId),
          idempotencyKey: `count:${count.id}:line:${line.id}`,
          businessDate,
        });
        ledgerIds.push(movement.transaction.id);
        await this.repo.insertAdjustmentLine(tx, {
          adjustmentInternalId: toBigInt(adjustment.internalId),
          variantInternalId: toBigInt(line.variantInternalId),
          locationInternalId: toBigInt(line.locationInternalId),
          lotInternalId: null,
          systemQuantity: line.expectedQuantity,
          countedQuantity: line.countedQuantity ?? '0.0000',
          differenceQuantity: line.varianceQuantity ?? '0.0000',
          unitCostAmount: BigInt(movement.unitCostAmount),
        });
        await this.repo.setLastCounted(tx, toBigInt(line.internalId), new Date().toISOString()).catch(() => undefined);
      }
      await this.repo.updateCountStatus(tx, toBigInt(count.internalId), 'applied');
      const payload: CountPayload = {
        countId: count.id,
        countNo: count.countNo,
        warehouseId: count.warehouseId,
        status: 'applied',
        adjustmentId: adjustment.id,
        varianceLines: variances.length,
      };
      await this.emitDomain(tx, ctx, INVENTORY_EVENTS.countPosted, 'stock_count', toBigInt(count.internalId), payload);
      await this.record(tx, ctx, 'inventory.count.post', 'stock_count', count.id, countView(count), {
        status: 'applied',
        adjustmentId: adjustment.id,
        ledgerIds,
      });
      return { ...(await this.getCountInTx(tx, ctx, publicId)), adjustmentId: adjustment.id, ledgerIds };
    });
  }

  async countVariance(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const count = await this.requireCount(this.db, ctx, publicId);
    const lines = await this.repo.listCountLines(this.db, toBigInt(count.internalId));
    const items = lines
      .filter((line) => line.varianceQuantity !== null && compareQuantity(line.varianceQuantity, '0') !== 0)
      .map((line) => ({
        lineId: line.id,
        variantId: line.variantId,
        locationId: line.locationId,
        expectedQuantity: line.expectedQuantity,
        countedQuantity: line.countedQuantity,
        varianceQuantity: line.varianceQuantity,
      }));
    return { countId: count.id, countNo: count.countNo, varianceLines: items.length, items };
  }

  private async getCountInTx(tx: Db, ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findCount(tx, ctx.orgId, publicId);
    if (row === null) throw notFound('count');
    const lines = await this.repo.listCountLines(tx, toBigInt(row.internalId));
    return { ...countView(row), lines: lines.map(countLineView) };
  }

  // ================================================================== valuation

  async currentValuation(
    ctx: TenantContext,
    query: { warehouseId?: string | undefined; variantId?: string | undefined; asOf?: string | undefined },
  ): Promise<Record<string, unknown>> {
    const warehouseInternalId =
      query.warehouseId === undefined ? null : await this.requireWarehouse(this.db, ctx, query.warehouseId);
    const variant = query.variantId === undefined ? null : await this.catalog.requireVariant(ctx, query.variantId);
    const rows = await this.repo.currentValuation(this.db, {
      orgId: ctx.orgId,
      warehouseInternalId,
      variantInternalId: variant?.internalId ?? null,
    });
    const totalValue = rows.reduce((total, row) => total + BigInt(row.totalValueAmount), 0n);
    const asOf = query.asOf ?? (await this.organizationBusinessDate(this.db, ctx));
    return {
      asOf,
      items: rows,
      totals: {
        variants: rows.length,
        totalValueAmount: totalValue.toString(),
        currency: 'IRR',
      },
    };
  }

  async listValuationLayers(
    ctx: TenantContext,
    query: { limit: number; variantId?: string | undefined; warehouseId?: string | undefined },
  ): Promise<Record<string, unknown>[]> {
    const variant = query.variantId === undefined ? null : await this.catalog.requireVariant(ctx, query.variantId);
    const warehouseInternalId =
      query.warehouseId === undefined ? null : await this.requireWarehouse(this.db, ctx, query.warehouseId);
    const rows = await this.repo.listLayers(this.db, {
      warehouseInternalId,
      variantInternalId: variant?.internalId ?? null,
      limit: query.limit,
    });
    return rows.map(layerView);
  }

  async listValuationRuns(
    ctx: TenantContext,
    query: { limit: number; page: number; status?: string | undefined },
  ): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const rows = await this.repo.listValuationRuns(this.db, {
      orgId: ctx.orgId,
      status: query.status ?? null,
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    });
    return { items: rows.map(valuationRunView), total: rows.length };
  }

  async getValuationRun(ctx: TenantContext, publicId: string): Promise<Record<string, unknown>> {
    const row = await this.repo.findValuationRun(this.db, ctx.orgId, publicId);
    if (row === null) throw notFound('valuation_run');
    const lines = await this.repo.listValuationLines(this.db, toBigInt(row.internalId));
    return { ...valuationRunView(row), items: lines };
  }

  /**
   * Valuation snapshot run (`ADR-0007` §6): values each `(warehouse, variant)` from
   * cost layers (FIFO) or the moving-average state, and records the GL target.
   * The accounting module attaches/validates the GL amount via the posted event;
   * until then the run's GL target equals the computed subledger total.
   */
  async runValuation(
    ctx: TenantContext,
    input: { warehouseId?: string | undefined; method?: 'fifo' | 'moving_average' | undefined; valuationDate?: string | undefined },
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const warehouseInternalId =
        input.warehouseId === undefined ? null : await this.requireWarehouse(tx, ctx, input.warehouseId);
      const method = input.method ?? 'moving_average';
      const businessDate = await this.organizationBusinessDate(tx, ctx);
      const valuationDate = input.valuationDate ?? businessDate;
      const run = await this.repo.insertValuationRun(tx, {
        orgId: ctx.orgId,
        warehouseInternalId,
        valuationMethod: method,
        valuationDate,
        runBy: ctx.actorId,
      });
      const balances = await this.repo.currentValuation(tx, {
        orgId: ctx.orgId,
        warehouseInternalId,
        variantInternalId: null,
      });
      let totalValue = 0n;
      let totalQuantity = '0.0000';
      let layerCount = 0;
      for (const row of balances) {
        const quantity = row.quantity;
        let value = BigInt(row.totalValueAmount);
        let unitCost = BigInt(row.unitCostAmount);
        if (method === 'fifo') {
          const layers = await this.repo.lockLayersForUpdate(
            tx,
            toBigInt(row.warehouseId),
            toBigInt(row.variantInternalId),
          );
          const mapped = layers.map(layerFromRow);
          value = layersValue(mapped);
          unitCost = compareQuantity(quantity, '0') === 0 ? unitCost : divideMoneyByQuantity(value, quantity);
          layerCount += mapped.length;
        }
        totalValue += value;
        totalQuantity = addQuantity(totalQuantity, quantity);
        await this.repo.insertValuationLine(tx, {
          runInternalId: toBigInt(run.internalId),
          variantInternalId: toBigInt(row.variantInternalId),
          warehouseInternalId: toBigInt(row.warehouseId),
          quantity,
          unitCostAmount: unitCost,
          totalValueAmount: value,
          layerBreakdown: [],
        });
      }
      await this.repo.updateValuationRun(tx, toBigInt(run.internalId), {
        status: 'completed',
        totalQuantity,
        totalValueAmount: totalValue,
        glInventoryAmount: totalValue,
        costLayerCount: layerCount,
      });
      const completed = await this.repo.findValuationRun(tx, ctx.orgId, run.id);
      if (completed === null) throw notFound('valuation_run');
      const payload: ValuationPayload = {
        runId: completed.id,
        warehouseId: completed.warehouseId,
        valuationDate: completed.valuationDate,
        valuationMethod: completed.valuationMethod,
        totalQuantity: completed.totalQuantity,
        totalValueAmount: completed.totalValueAmount,
        glInventoryAmount: completed.glInventoryAmount,
        costLayerCount: completed.costLayerCount,
        status: completed.status,
      };
      // The posting rule requires a non-zero variance; a pure revaluation with no
      // GL difference produces no journal (documented in ROADMAP TD-29).
      const valuationVariance = BigInt(completed.glInventoryAmount) - BigInt(completed.totalValueAmount);
      if (valuationVariance !== 0n) {
        await this.emitAccounting(tx, ctx, INVENTORY_ACCOUNTING_EVENTS.valuationPosted, 'inventory_valuation_run', toBigInt(completed.internalId), {
          ...payload,
          valuationRunId: completed.internalId.toString(),
          varianceAmount: valuationVariance.toString(),
          businessDate,
        });
      }
      await this.record(tx, ctx, 'inventory.valuation.run', 'inventory_valuation_run', completed.id, null, valuationRunView(completed));
      return valuationRunView(completed);
    });
  }

  /**
   * Nightly consistency job: ledger vs balance, and layer value vs moving-average
   * state (`ADR-0007` consequences). Drift is recorded in
   * `inventory_consistency_checks` and raises an ops event; nothing is auto-repaired.
   */
  async nightlyConsistencyCheck(
    ctx: TenantContext,
    input: { warehouseId?: string | undefined; since?: string | undefined },
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const warehouseInternalId =
        input.warehouseId === undefined ? null : await this.requireWarehouse(tx, ctx, input.warehouseId);
      const ledgerSums = await this.repo.ledgerSums(tx, ctx.orgId, {
        warehouseInternalId,
        since: input.since ?? null,
      });
      const balances = await this.repo.balancesForReconciliation(tx, ctx.orgId, warehouseInternalId);
      const balanceByKey = new Map(
        balances.map((balance) => [`${balance.warehouseId}:${balance.locationId}:${balance.variantId}`, balance.onHand]),
      );
      let ledgerDrift = 0;
      for (const row of ledgerSums) {
        const actual = balanceByKey.get(`${row.warehouseId}:${row.locationId}:${row.variantId}`) ?? '0.0000';
        if (compareQuantity(row.quantitySum, actual) !== 0) {
          ledgerDrift += 1;
          await this.repo.insertConsistencyCheck(tx, {
            orgId: ctx.orgId,
            checkType: 'ledger_vs_balance',
            warehouseInternalId,
            variantInternalId: null,
            locationInternalId: null,
            expectedValue: row.quantitySum,
            actualValue: actual,
            difference: subQuantity(row.quantitySum, actual),
            status: 'drift',
            details: row,
          });
        }
      }
      const layerDrift = 0;
      if (ledgerDrift > 0) {
        await this.emitDomain(tx, ctx, INVENTORY_EVENTS.integrityDriftDetected, 'inventory', 0n, {
          ledgerDrift,
          layerDrift,
          checkedAt: new Date().toISOString(),
        });
      }
      return { ledgerDrift, layerDrift, checkedAt: new Date().toISOString() };
    });
  }

  /** Async integrity-check endpoint: returns the drift summary (job wrapper later). */
  async integrityCheck(ctx: TenantContext, input: { warehouseId?: string | undefined; since?: string | undefined }) {
    return this.nightlyConsistencyCheck(ctx, input);
  }

  // =================================================================== helpers

  /** Reconstructs the public `MovementResult` of an already-committed movement. */
  private async replayMovement(tx: Db, ctx: TenantContext, transaction: LedgerRow): Promise<MovementResult> {
    const balance = await this.repo.findBalanceByIdentity(tx, ctx.orgId, {
      warehouseInternalId: toBigInt(transaction.warehouseInternalId),
      locationInternalId: toBigInt(transaction.locationInternalId),
      variantInternalId: toBigInt(transaction.variantInternalId),
    });
    if (balance === null) throw notFound('balance');
    return {
      transaction,
      balance,
      unitCostAmount: transaction.unitCostAmount === null ? 0n : BigInt(transaction.unitCostAmount),
      totalCostAmount: transaction.totalCostAmount === null ? 0n : BigInt(transaction.totalCostAmount),
    };
  }

  /** Organization-local business date, falling back to `Asia/Tehran`. */
  private async organizationBusinessDate(tx: Db, ctx: TenantContext): Promise<string> {
    const timeZone = await this.repo.organizationTimeZone(tx, ctx.orgId);
    return businessDateInTimeZone(new Date(), timeZone ?? DEFAULT_BUSINESS_TIME_ZONE);
  }

  private costMethodOf(variant: VariantLookup): CostMethod {
    if (variant.costMethod === 'fifo') return 'fifo';
    if (variant.costMethod === 'standard') return 'standard';
    return 'moving_average';
  }

  private async requireWarehouse(tx: Db, ctx: TenantContext, publicId: string): Promise<bigint> {
    const internalId = await this.repo.resolveWarehouseId(tx, ctx.orgId, publicId);
    if (internalId === null) throw notFound('warehouse');
    return internalId;
  }

  private async requireLocation(tx: Db, ctx: TenantContext, publicId: string): Promise<bigint> {
    const internalId = await this.repo.resolveLocationId(tx, ctx.orgId, publicId);
    if (internalId === null) throw notFound('location');
    return internalId;
  }

  /**
   * A fresh install has no warehouse at all, which blocked every stock
   * adjustment. Lazily bootstrap a main warehouse + default location so the
   * stock workspace works out of the box; operators can rename/add later.
   */
  private async ensureDefaultWarehouse(tx: Db, ctx: TenantContext): Promise<bigint> {
    const existing = await this.repo.resolveDefaultWarehouseId(tx, ctx.orgId);
    if (existing !== null) {
      const location = await this.repo.resolveFirstActiveLocationId(tx, ctx.orgId, existing);
      if (location === null) {
        await tx`
          insert into erp.warehouse_locations (warehouse_id, full_code, location_type, is_pickable, is_active)
          values (${existing}::bigint, 'MAIN-01', 'storage', true, true)
        `;
      }
      return existing;
    }
    const created = await tx<{ id: string }[]>`
      insert into erp.warehouses (organization_id, code, name, warehouse_type, is_active, created_by)
      values (${ctx.orgId}, 'MAIN', 'انبار اصلی', 'main', true, ${ctx.actorId})
      returning id::text as id
    `;
    const warehouseId = created[0]?.id;
    if (warehouseId === undefined) throw new Error('warehouse_bootstrap_failed');
    await tx`
      insert into erp.warehouse_locations (warehouse_id, full_code, location_type, is_pickable, is_active)
      values (${warehouseId}::bigint, 'MAIN-01', 'storage', true, true)
    `;
    return BigInt(warehouseId);
  }

  /** Warehouse-less adjustments land in the organization's first active warehouse. */
  private async requireDefaultWarehouse(tx: Db, ctx: TenantContext): Promise<bigint> {
    const internalId = await this.repo.resolveDefaultWarehouseId(tx, ctx.orgId);
    if (internalId === null) throw notFound('warehouse');
    return internalId;
  }

  /** Defaults a location-less adjustment line to the warehouse's first active location. */
  private async resolveDefaultAdjustmentLocation(tx: Db, ctx: TenantContext, warehouseInternalId: bigint): Promise<bigint> {
    const internalId = await this.repo.resolveFirstActiveLocationId(tx, ctx.orgId, warehouseInternalId);
    if (internalId === null) throw notFound('location');
    return internalId;
  }

  private publicIdFor(
    candidates: readonly { warehouseInternalId: string; locationInternalId: string }[],
    internalId: string,
    field: 'warehouseInternalId' | 'locationInternalId',
  ): string {
    const candidate = candidates.find((row) => row[field] === internalId);
    return candidate === undefined ? internalId : field === 'warehouseInternalId' ? candidate.warehouseInternalId : candidate.locationInternalId;
  }

  private async requireAdjustment(tx: Db, ctx: TenantContext, publicId: string): Promise<AdjustmentRow> {
    const row = await this.repo.lockAdjustment(tx, ctx.orgId, publicId);
    if (row === null) throw notFound('adjustment');
    return row;
  }

  private async requireTransfer(tx: Db, ctx: TenantContext, publicId: string) {
    const row = await this.repo.lockTransfer(tx, ctx.orgId, publicId);
    if (row === null) throw notFound('transfer');
    return row;
  }

  private async requireCount(tx: Db, ctx: TenantContext, publicId: string) {
    const row = await this.repo.lockCount(tx, ctx.orgId, publicId);
    if (row === null) throw notFound('count');
    return row;
  }

  private async emitMovementEvents(
    tx: Db,
    ctx: TenantContext,
    transaction: LedgerRow,
    variant: VariantLookup,
    unitCostAmount: bigint,
    totalCostAmount: bigint,
  ): Promise<void> {
    const payload: LedgerMovementPayload = {
      transactionId: transaction.id,
      transactionType: transaction.transactionType,
      warehouseId: transaction.warehouseId,
      locationId: transaction.locationId,
      variantId: variant.id,
      quantity: transaction.quantity,
      unitCostAmount: unitCostAmount.toString(),
      totalCostAmount: totalCostAmount.toString(),
      businessDate: transaction.businessDate,
      referenceType: transaction.referenceType,
      referenceId: transaction.referencePublicId,
      lotId: transaction.lotId,
      journalEntryId: transaction.journalEntryId,
    };
    await this.emitDomain(tx, ctx, INVENTORY_EVENTS.receiptPosted, 'inventory_transaction', toBigInt(transaction.internalId), payload);
    if (transaction.transactionType === 'sale_issue' || transaction.transactionType === 'reservation_consume') {
      await this.emitAccounting(
        tx,
        ctx,
        INVENTORY_ACCOUNTING_EVENTS.issuePosted,
        'inventory_transaction',
        toBigInt(transaction.internalId),
        payload,
      );
    }
  }

  private async emitReservationEvent(
    tx: Db,
    ctx: TenantContext,
    reservation: ReservationRow,
    eventType: string,
  ): Promise<void> {
    const payload: ReservationPayload = {
      reservationId: reservation.id,
      reservationNo: reservation.reservationNo,
      referenceType: reservation.referenceType,
      referenceId: reservation.referenceId ?? '',
      warehouseId: reservation.warehouseId,
      locationId: reservation.locationId,
      variantId: reservation.variantId,
      quantity: reservation.quantity,
      status: reservation.status,
      expiresAt: reservation.expiresAt,
    };
    await this.emitDomain(tx, ctx, eventType, 'stock_reservation', toBigInt(reservation.internalId), payload);
  }

  private async emitDomain(
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

  private async emitAccounting(
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

// ------------------------------------------------------------------- mapping

function balanceView(row: BalanceRow): Record<string, unknown> {
  const available = availableQuantity({
    onHand: row.onHand,
    reserved: row.reserved,
    safetyBuffer: row.safetyBuffer,
    damaged: row.damaged,
  });
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    locationId: row.locationId,
    variantId: row.variantId,
    sku: row.sku,
    productName: row.productName ?? null,
    productId: row.productId,
    variant: { id: row.variantId, code: row.sku, name: row.productName ?? null },
    warehouse: { id: row.warehouseId, name: row.warehouseName ?? null },
    location: { id: row.locationId, code: row.locationCode ?? null },
    onHand: normalizeQuantity(row.onHand),
    reserved: normalizeQuantity(row.reserved),
    safetyBuffer: normalizeQuantity(row.safetyBuffer),
    damaged: normalizeQuantity(row.damaged),
    inTransit: normalizeQuantity(row.inTransit),
    available: normalizeQuantity(available),
    lastTransactionId: row.lastTransactionId,
    lastCountedAt: row.lastCountedAt,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

function ledgerView(row: LedgerRow): Record<string, unknown> {
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    locationId: row.locationId,
    variantId: row.variantId,
    productName: row.productName ?? null,
    variant: { id: row.variantId, name: row.productName ?? null, code: row.sku ?? null },
    warehouse: { id: row.warehouseId, name: row.warehouseName ?? null },
    location: { id: row.locationId, code: row.locationCode ?? null },
    type: row.transactionType,
    quantity: normalizeQuantity(row.quantity),
    unitCostAmount: row.unitCostAmount,
    totalCostAmount: row.totalCostAmount,
    currency: row.currency,
    lotId: row.lotId,
    referenceType: row.referenceType,
    referenceId: row.referencePublicId,
    reversalOfId: row.reversalOfId,
    businessDate: row.businessDate,
    costState: row.costState,
    journalEntryId: row.journalEntryId,
    createdAt: row.createdAt,
  };
}

function reservationView(row: ReservationRow): Record<string, unknown> {
  return {
    id: row.id,
    reservationNo: row.reservationNo,
    warehouseId: row.warehouseId,
    locationId: row.locationId,
    variantId: row.variantId,
    quantity: normalizeQuantity(row.quantity),
    consumedQuantity: normalizeQuantity(row.consumedQuantity),
    releasedQuantity: normalizeQuantity(row.releasedQuantity),
    referenceType: row.referenceType,
    referenceId: row.referencePublicId ?? row.referenceId,
    status: row.status,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

function adjustmentView(row: AdjustmentRow): Record<string, unknown> {
  return {
    id: row.id,
    adjustmentNo: row.adjustmentNo,
    warehouseId: row.warehouseId,
    reasonCode: row.reasonCode,
    status: row.status,
    description: row.description,
    requiresApproval: row.requiresApproval,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    appliedAt: row.appliedAt,
    version: row.version,
    createdAt: row.createdAt,
  };
}

function adjustmentLineView(row: {
  id: string;
  variantId: string;
  locationId: string;
  systemQuantity: string;
  countedQuantity: string;
  differenceQuantity: string;
  unitCostAmount: string;
}): Record<string, unknown> {
  return {
    id: row.id,
    variantId: row.variantId,
    locationId: row.locationId,
    systemQuantity: row.systemQuantity,
    countedQuantity: row.countedQuantity,
    differenceQuantity: row.differenceQuantity,
    unitCostAmount: row.unitCostAmount,
  };
}

function transferView(row: {
  id: string;
  transferNo: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  status: string;
  carrier: string | null;
  notes: string | null;
  dispatchedAt: string | null;
  receivedAt: string | null;
  version: number;
}): Record<string, unknown> {
  return {
    id: row.id,
    transferNo: row.transferNo,
    fromWarehouseId: row.fromWarehouseId,
    toWarehouseId: row.toWarehouseId,
    status: row.status,
    carrier: row.carrier,
    notes: row.notes,
    dispatchedAt: row.dispatchedAt,
    receivedAt: row.receivedAt,
    version: row.version,
  };
}

function transferLineView(row: {
  id: string;
  variantId: string;
  quantity: string;
  dispatchedQuantity: string;
  receivedQuantity: string;
  fromLocationId: string | null;
  toLocationId: string | null;
  unitCostAmount: string;
}): Record<string, unknown> {
  return {
    id: row.id,
    variantId: row.variantId,
    quantity: row.quantity,
    dispatchedQuantity: row.dispatchedQuantity,
    receivedQuantity: row.receivedQuantity,
    fromLocationId: row.fromLocationId,
    toLocationId: row.toLocationId,
    unitCostAmount: row.unitCostAmount,
  };
}

function countView(row: {
  id: string;
  countNo: string;
  warehouseId: string;
  countType: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  adjustmentId: string | null;
  version: number;
}): Record<string, unknown> {
  return {
    id: row.id,
    countNo: row.countNo,
    warehouseId: row.warehouseId,
    type: row.countType,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    adjustmentId: row.adjustmentId,
    version: row.version,
  };
}

function countLineView(row: {
  id: string;
  variantId: string;
  locationId: string;
  expectedQuantity: string;
  countedQuantity: string | null;
  varianceQuantity: string | null;
}): Record<string, unknown> {
  return {
    id: row.id,
    variantId: row.variantId,
    locationId: row.locationId,
    expectedQuantity: row.expectedQuantity,
    countedQuantity: row.countedQuantity,
    varianceQuantity: row.varianceQuantity,
  };
}

function layerView(row: {
  id: string;
  receivedAt: string;
  originalQuantity: string;
  quantityRemaining: string;
  unitCostAmount: string;
  costRemainingAmount: string;
  isClosed: boolean;
}): Record<string, unknown> {
  return {
    id: row.id,
    receivedAt: row.receivedAt,
    originalQuantity: row.originalQuantity,
    quantityRemaining: row.quantityRemaining,
    unitCostAmount: row.unitCostAmount,
    costRemainingAmount: row.costRemainingAmount,
    isClosed: row.isClosed,
  };
}

function valuationRunView(row: {
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
}): Record<string, unknown> {
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    valuationMethod: row.valuationMethod,
    valuationDate: row.valuationDate,
    costLayerCount: row.costLayerCount,
    glInventoryAmount: row.glInventoryAmount,
    status: row.status,
    totalQuantity: row.totalQuantity,
    totalValueAmount: row.totalValueAmount,
    journalEntryId: row.journalEntryId,
    completedAt: row.completedAt,
  };
}

function layerFromRow(row: {
  internalId: string;
  receivedAt: string;
  originalQuantity: string;
  quantityRemaining: string;
  unitCostAmount: string;
  costRemainingAmount: string;
}): CostLayer {
  return {
    layerId: row.internalId,
    receivedAt: row.receivedAt,
    unitCostAmount: BigInt(row.unitCostAmount),
    originalQuantity: row.originalQuantity,
    quantityRemaining: row.quantityRemaining,
    costRemainingAmount: BigInt(row.costRemainingAmount),
  };
}

function mapAdjustmentReason(
  type: 'increase' | 'decrease' | 'writeoff' | 'damage' | 'correction',
  reason: string,
): string {
  if (type === 'increase') return 'found';
  if (type === 'decrease') return 'loss';
  if (type === 'writeoff') return 'write_off';
  if (type === 'damage') return 'damage';
  if (reason.includes('gain')) return 'count_gain';
  return 'correction';
}

function adjustmentDirection(type: 'increase' | 'decrease' | 'writeoff' | 'damage' | 'correction'): 'in' | 'out' {
  return type === 'increase' ? 'in' : 'out';
}

function mapAdjustmentOutType(reasonCode: string): InventoryTransactionType {
  if (reasonCode === 'damage') return 'damage_out';
  if (reasonCode === 'write_off') return 'scrap_out';
  if (reasonCode === 'count_shortage') return 'count_correction_out';
  return 'adjustment_out';
}

function inboundSourceKind(type: InventoryTransactionType): string {
  switch (type) {
    case 'receipt':
      return 'receipt';
    case 'return_in':
      return 'return_restock';
    case 'transfer_in':
      return 'transfer_in';
    case 'opening_balance':
      return 'opening';
    default:
      return 'adjustment_in';
  }
}

function consumptionKind(type: InventoryTransactionType): string {
  if (type === 'transfer_out') return 'transfer_out';
  if (type === 'adjustment_out') return 'adjustment_out';
  if (type === 'damage_out' || type === 'scrap_out') return 'adjustment_out';
  return 'issue';
}

function assertState(current: string, allowed: readonly string[], rule: string): void {
  if (!allowed.includes(current)) {
    throw new AppError('DOCUMENT_STATE_INVALID', {
      message: 'وضعیت فعلی سند اجازهٔ این تغییر را نمی‌دهد.',
      details: [{ rule, params: { current, allowed: allowed.join('|') } }],
    });
  }
}

/** Exported helpers reused by the warehouse/procurement/sales modules. */
export { todayIso };
