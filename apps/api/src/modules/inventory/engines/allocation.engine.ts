/**
 * Reservation & allocation engine (`ADR-0007` §3, `ARCHITECTURE.md` §6).
 *
 * Allocation is **all-or-nothing per order**: every line must be satisfiable
 * before a single reservation row is written, and locks are taken in a fixed
 * order (`variant`, then `warehouse`, then `location`) so concurrent allocators
 * cannot deadlock. The pure planner is what the 100-parallel-allocator test
 * asserts against; the service wraps it with `SELECT … FOR UPDATE` in that exact
 * order.
 */
import { AppError } from '@saman/shared';

import {
  addQuantity,
  compareQuantity,
  formatQuantity,
  isPositiveQuantity,
  minQuantity,
  normalizeQuantity,
  parseQuantity,
  subQuantity,
  sumQuantities,
} from './quantity.engine';
import { insufficientStock } from './ledger.engine';

export type AllocationStrategy = 'single_warehouse_first' | 'split_fewest_locations' | 'fifo';

export interface AllocationLine {
  readonly lineIndex: number;
  readonly variantId: string;
  readonly quantity: string;
}

export interface BalanceCandidate {
  readonly warehouseId: string;
  readonly locationId: string;
  readonly variantId: string;
  /** `on_hand − reserved − safety_buffer − damaged`, already computed. */
  readonly available: string;
}

export interface AllocationPlanLine {
  readonly lineIndex: number;
  readonly variantId: string;
  readonly warehouseId: string;
  readonly locationId: string;
  readonly quantity: string;
  readonly available: string;
}

export interface AllocationFailure {
  readonly lineIndex: number;
  readonly variantId: string;
  readonly requested: string;
  readonly available: string;
}

export interface AllocationPlan {
  readonly ok: boolean;
  readonly strategy: AllocationStrategy;
  readonly allocations: readonly AllocationPlanLine[];
  readonly failures: readonly AllocationFailure[];
  /** Fixed lock order key list the service must lock with `FOR UPDATE`. */
  readonly lockOrder: readonly { warehouseId: string; locationId: string; variantId: string }[];
}

function compareKeys(
  left: BalanceCandidate,
  right: BalanceCandidate,
  warehouseRank: ReadonlyMap<string, number>,
): number {
  const leftRank = warehouseRank.get(left.warehouseId) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = warehouseRank.get(right.warehouseId) ?? Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left.warehouseId !== right.warehouseId) return left.warehouseId < right.warehouseId ? -1 : 1;
  if (left.locationId !== right.locationId) return left.locationId < right.locationId ? -1 : 1;
  return 0;
}

/** Deterministic candidates order: variant asc, preferred warehouses, location asc. */
export function sortCandidates(
  candidates: readonly BalanceCandidate[],
  preferredWarehouseIds: readonly string[] = [],
): BalanceCandidate[] {
  const rank = new Map(preferredWarehouseIds.map((warehouseId, index) => [warehouseId, index]));
  return [...candidates].sort((left, right) => {
    if (left.variantId !== right.variantId) return left.variantId < right.variantId ? -1 : 1;
    return compareKeys(left, right, rank);
  });
}

function totalAvailable(candidates: readonly BalanceCandidate[]): string {
  return candidates.reduce(
    (total, candidate) => addQuantity(total, candidate.available),
    '0.0000',
  );
}

/** Sums requested quantity per variant across lines. */
export function requiredByVariant(lines: readonly AllocationLine[]): Map<string, string> {
  const required = new Map<string, string>();
  for (const line of lines) {
    required.set(line.variantId, addQuantity(required.get(line.variantId) ?? '0.0000', line.quantity));
  }
  return required;
}

/**
 * Plans an all-or-nothing allocation.
 *
 * `single_warehouse_first` prefers one warehouse that can satisfy every line, so
 * orders ship from a single parcel; only when no warehouse can do that does it
 * split across warehouses/locations (`API.md` §4.8 allocation strategy).
 */
export function planAllocation(
  lines: readonly AllocationLine[],
  candidates: readonly BalanceCandidate[],
  strategy: AllocationStrategy = 'single_warehouse_first',
  preferredWarehouseIds: readonly string[] = [],
): AllocationPlan {
  const required = requiredByVariant(lines);
  const byVariant = new Map<string, BalanceCandidate[]>();
  for (const candidate of candidates) {
    const list = byVariant.get(candidate.variantId) ?? [];
    list.push(candidate);
    byVariant.set(candidate.variantId, list);
  }

  const failures: AllocationFailure[] = [];
  for (const line of lines) {
    const available = totalAvailable(byVariant.get(line.variantId) ?? []);
    if (compareQuantity(available, line.quantity) < 0) {
      failures.push({
        lineIndex: line.lineIndex,
        variantId: line.variantId,
        requested: normalizeQuantity(line.quantity),
        available: normalizeQuantity(available),
      });
    }
  }
  if (failures.length > 0) {
    return {
      ok: false,
      strategy,
      allocations: [],
      failures,
      lockOrder: lockOrderFor(lines, candidates),
    };
  }

  if (strategy === 'single_warehouse_first') {
    const warehouses = new Set(candidates.map((candidate) => candidate.warehouseId));
    const ordered = [...warehouses].sort((left, right) => {
      const leftRank = preferredWarehouseIds.indexOf(left);
      const rightRank = preferredWarehouseIds.indexOf(right);
      const leftKey = leftRank === -1 ? Number.MAX_SAFE_INTEGER : leftRank;
      const rightKey = rightRank === -1 ? Number.MAX_SAFE_INTEGER : rightRank;
      if (leftKey !== rightKey) return leftKey - rightKey;
      return left < right ? -1 : 1;
    });
    for (const warehouseId of ordered) {
      const warehouseCandidates = candidates.filter((candidate) => candidate.warehouseId === warehouseId);
      if (canSatisfy(required, warehouseCandidates)) {
        return {
          ok: true,
          strategy: 'single_warehouse_first',
          allocations: allocateGreedy(lines, sortCandidates(warehouseCandidates, preferredWarehouseIds)),
          failures: [],
          lockOrder: lockOrderFor(lines, warehouseCandidates),
        };
      }
    }
  }

  const sorted = sortCandidates(candidates, preferredWarehouseIds);
  return {
    ok: true,
    strategy,
    allocations: allocateGreedy(lines, sorted),
    failures: [],
    lockOrder: lockOrderFor(lines, sorted),
  };
}

function canSatisfy(
  required: ReadonlyMap<string, string>,
  candidates: readonly BalanceCandidate[],
): boolean {
  for (const [variantId, quantity] of required) {
    const available = totalAvailable(candidates.filter((candidate) => candidate.variantId === variantId));
    if (compareQuantity(available, quantity) < 0) return false;
  }
  return true;
}

function allocateGreedy(
  lines: readonly AllocationLine[],
  candidates: readonly BalanceCandidate[],
): AllocationPlanLine[] {
  const remaining = candidates.map((candidate) => ({
    candidate,
    left: normalizeQuantity(candidate.available),
  }));
  const allocations: AllocationPlanLine[] = [];
  for (const line of [...lines].sort((left, right) => left.lineIndex - right.lineIndex)) {
    let outstanding = normalizeQuantity(line.quantity);
    for (const bucket of remaining) {
      if (bucket.candidate.variantId !== line.variantId) continue;
      if (!isPositiveQuantity(outstanding)) break;
      if (!isPositiveQuantity(bucket.left)) continue;
      const take = minQuantity(bucket.left, outstanding);
      if (!isPositiveQuantity(take)) continue;
      allocations.push({
        lineIndex: line.lineIndex,
        variantId: line.variantId,
        warehouseId: bucket.candidate.warehouseId,
        locationId: bucket.candidate.locationId,
        quantity: take,
        available: bucket.candidate.available,
      });
      bucket.left = formatQuantity(parseQuantity(subQuantity(bucket.left, take)));
      outstanding = formatQuantity(parseQuantity(subQuantity(outstanding, take)));
    }
    if (isPositiveQuantity(outstanding)) {
      throw new AppError('INSUFFICIENT_STOCK', {
        details: [
          {
            rule: 'insufficient_stock',
            params: { variantId: line.variantId, requested: line.quantity, available: '0.0000' },
          },
        ],
      });
    }
  }
  return allocations;
}

/** Fixed lock order (`ADR-0007` §3): variant asc, warehouse asc, location asc. */
export function lockOrderFor(
  lines: readonly AllocationLine[],
  candidates: readonly BalanceCandidate[],
): { warehouseId: string; locationId: string; variantId: string }[] {
  const variantIds = new Set(lines.map((line) => line.variantId));
  return [...candidates]
    .filter((candidate) => variantIds.has(candidate.variantId))
    .sort((left, right) => {
      if (left.variantId !== right.variantId) return left.variantId < right.variantId ? -1 : 1;
      if (left.warehouseId !== right.warehouseId) return left.warehouseId < right.warehouseId ? -1 : 1;
      return left.locationId < right.locationId ? -1 : 1;
    })
    .map((candidate) => ({
      warehouseId: candidate.warehouseId,
      locationId: candidate.locationId,
      variantId: candidate.variantId,
    }));
}

/** Throws `INSUFFICIENT_STOCK` with per-line details when the plan is not viable. */
export function assertAllocatable(plan: AllocationPlan): AllocationPlan {
  if (!plan.ok) {
    throw insufficientStock(plan.failures);
  }
  return plan;
}

/** Reservation rows are grouped by the plan's lines; quantities always positive. */
export function reservationLinesFromPlan(
  plan: AllocationPlan,
): { lineIndex: number; variantId: string; warehouseId: string; locationId: string; quantity: string }[] {
  return plan.allocations.map((allocation) => ({
    lineIndex: allocation.lineIndex,
    variantId: allocation.variantId,
    warehouseId: allocation.warehouseId,
    locationId: allocation.locationId,
    quantity: normalizeQuantity(allocation.quantity),
  }));
}

/** Reservation rows grouped exactly as `stock_reservations` expects. */
export function groupReservations(
  plan: AllocationPlan,
): { warehouseId: string; locationId: string; variantId: string; quantity: string }[] {
  const grouped = new Map<string, { warehouseId: string; locationId: string; variantId: string; quantity: string }>();
  for (const allocation of plan.allocations) {
    const key = `${allocation.warehouseId}:${allocation.locationId}:${allocation.variantId}`;
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, {
        warehouseId: allocation.warehouseId,
        locationId: allocation.locationId,
        variantId: allocation.variantId,
        quantity: normalizeQuantity(allocation.quantity),
      });
    } else {
      grouped.set(key, { ...existing, quantity: addQuantity(existing.quantity, allocation.quantity) });
    }
  }
  return [...grouped.values()].sort((left, right) => {
    if (left.variantId !== right.variantId) return left.variantId < right.variantId ? -1 : 1;
    if (left.warehouseId !== right.warehouseId) return left.warehouseId < right.warehouseId ? -1 : 1;
    return left.locationId < right.locationId ? -1 : 1;
  });
}

export interface ReservationState {
  readonly quantity: string;
  readonly consumedQuantity: string;
  readonly releasedQuantity: string;
  readonly status: 'active' | 'consumed' | 'released' | 'expired';
  readonly expiresAt: string | null;
}

/** Remaining consumable amount of a partially consumed reservation. */
export function reservationRemaining(state: ReservationState): string {
  return subQuantity(state.quantity, addQuantity(state.consumedQuantity, state.releasedQuantity));
}

/** Validates a consume/release request against the reservation state machine. */
export function assertReservationTransition(
  state: ReservationState,
  action: 'consume' | 'release' | 'expire',
  quantity?: string,
): string {
  if (state.status !== 'active') {
    throw new AppError('DOCUMENT_STATE_INVALID', {
      message: 'رزرو موجودی در وضعیت فعال نیست.',
      messageKey: 'inventory.reservation_state_invalid',
      details: [{ rule: 'reservation_state_invalid', params: { status: state.status } }],
    });
  }
  const remaining = reservationRemaining(state);
  if (action === 'consume' || action === 'release') {
    if (quantity === undefined) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'quantity', rule: 'required' }],
      });
    }
    if (compareQuantity(quantity, remaining) > 0) {
      throw new AppError('RULE_VIOLATION', {
        message: 'مقدار درخواستی بیش از باقی‌ماندهٔ رزرو است.',
        messageKey: 'inventory.reservation_exceeds_remaining',
        details: [
          { rule: 'reservation_exceeds_remaining', params: { remaining } },
        ],
      });
    }
    return normalizeQuantity(quantity);
  }
  return remaining;
}

/** True when an active reservation is past its TTL (sweep job releases it). */
export function isReservationExpired(state: ReservationState, now: Date): boolean {
  if (state.status !== 'active' || state.expiresAt === null) return false;
  return new Date(state.expiresAt).getTime() <= now.getTime();
}

/** Reservation TTL from settings (`inventory.reservation_ttl_minutes`). */
export function reservationExpiry(now: Date, ttlMinutes: number): string {
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    throw new RangeError('invalid_reservation_ttl');
  }
  return new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
}

/** Total requested quantity (for summaries/events). */
export function totalRequested(lines: readonly AllocationLine[]): string {
  return sumQuantities(lines.map((line) => line.quantity));
}
