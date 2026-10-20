/**
 * Inventory costing engine (`ADR-0007` §6, `R1-A B-07`, `R1-D H-08/M-06`).
 *
 * Two cost methods are supported per variant/company setting:
 * - **FIFO** via append-only `inventory_cost_layers` consumed oldest-first;
 * - **moving average** via `inventory_average_costs` per `(warehouse, variant)`.
 *
 * Layers are always maintained for inbound movements (so FIFO, returns,
 * transfers and reversals stay auditable); the moving-average state is updated
 * in the same transaction. Amounts are `bigint` IRR, quantities `numeric(18,4)`.
 */
import { AppError, roundHalfUp } from '@saman/shared';

import {
  addQuantity,
  compareQuantity,
  divideMoneyByQuantity,
  formatQuantity,
  isPositiveQuantity,
  isZeroQuantity,
  minQuantity,
  multiplyMoneyByQuantity,
  normalizeQuantity,
  parseQuantity,
  subQuantity,
} from './quantity.engine';

export type CostMethod = 'fifo' | 'moving_average' | 'standard';

export interface CostLayer {
  readonly layerId: string;
  readonly receivedAt: string;
  readonly unitCostAmount: bigint;
  readonly originalQuantity: string;
  readonly quantityRemaining: string;
  readonly costRemainingAmount: bigint;
}

export interface LayerConsumption {
  readonly layerId: string;
  readonly quantity: string;
  readonly costAmount: bigint;
}

export interface LayerConsumptionResult {
  readonly consumptions: readonly LayerConsumption[];
  readonly totalCostAmount: bigint;
  readonly consumedQuantity: string;
  readonly remainingLayers: readonly CostLayer[];
}

/** FIFO order: oldest receipt first, layer id as a stable tiebreaker. */
export function sortLayersFifo(layers: readonly CostLayer[]): CostLayer[] {
  return [...layers].sort((left, right) => {
    const leftTime = new Date(left.receivedAt).getTime();
    const rightTime = new Date(right.receivedAt).getTime();
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.layerId < right.layerId ? -1 : left.layerId > right.layerId ? 1 : 0;
  });
}

/** FEFO order: earliest lot expiry first, FIFO as tiebreaker (`R1-A M-05`). */
export function sortLayersFefo(layers: readonly (CostLayer & { expiryDate?: string | null })[]): CostLayer[] {
  return [...layers].sort((left, right) => {
    const leftExpiry = left.expiryDate ?? null;
    const rightExpiry = right.expiryDate ?? null;
    if (leftExpiry !== null && rightExpiry === null) return -1;
    if (leftExpiry === null && rightExpiry !== null) return 1;
    if (leftExpiry !== null && rightExpiry !== null && leftExpiry !== rightExpiry) {
      return leftExpiry < rightExpiry ? -1 : 1;
    }
    return sortLayersFifo([left, right])[0] === left ? -1 : 1;
  });
}

/**
 * Consumes `quantity` from layers oldest-first.
 *
 * Cost per consumption is `unit_cost × qty` (ROUND_HALF_UP); when a layer is
 * fully depleted its remaining cost is consumed exactly, writing off any residual
 * rounding to keep `Σ layer value = total inventory value` (`R1-A M-06`).
 */
export function consumeLayersFifo(
  layers: readonly CostLayer[],
  quantity: string,
  options: { allowPartial?: boolean } = {},
): LayerConsumptionResult {
  const requested = parseQuantity(quantity);
  if (requested <= 0n) {
    throw new RangeError('consumption_quantity_must_be_positive');
  }
  const ordered = sortLayersFifo(layers);
  const available = ordered.reduce(
    (total, layer) => addQuantity(total, layer.quantityRemaining),
    '0.0000',
  );
  if (compareQuantity(available, quantity) < 0 && options.allowPartial !== true) {
    throw new AppError('INSUFFICIENT_STOCK', {
      message: 'موجودی لایه‌های بهای تمام‌شده برای این خروج کافی نیست.',
      details: [
        { rule: 'insufficient_cost_layers', params: { requested: normalizeQuantity(quantity), available } },
      ],
    });
  }

  let outstanding = normalizeQuantity(quantity);
  const consumptions: LayerConsumption[] = [];
  const remainingLayers: CostLayer[] = [];

  for (const layer of ordered) {
    if (!isPositiveQuantity(outstanding)) {
      remainingLayers.push(layer);
      continue;
    }
    if (!isPositiveQuantity(layer.quantityRemaining)) {
      remainingLayers.push(layer);
      continue;
    }
    const take = minQuantity(layer.quantityRemaining, outstanding);
    const fullyConsumed = compareQuantity(take, layer.quantityRemaining) === 0;
    const cost = fullyConsumed
      ? layer.costRemainingAmount
      : minBigInt(multiplyMoneyByQuantity(layer.unitCostAmount, take), layer.costRemainingAmount);
    consumptions.push({ layerId: layer.layerId, quantity: take, costAmount: cost });
    outstanding = formatQuantity(parseQuantity(subQuantity(outstanding, take)));
    remainingLayers.push({
      ...layer,
      quantityRemaining: formatQuantity(parseQuantity(subQuantity(layer.quantityRemaining, take))),
      costRemainingAmount: layer.costRemainingAmount - cost,
    });
  }

  if (isPositiveQuantity(outstanding) && options.allowPartial !== true) {
    throw new AppError('INSUFFICIENT_STOCK', {
      details: [{ rule: 'insufficient_cost_layers', params: { remaining: outstanding } }],
    });
  }

  const totalCostAmount = consumptions.reduce((total, consumption) => total + consumption.costAmount, 0n);
  return {
    consumptions,
    totalCostAmount,
    consumedQuantity: formatQuantity(parseQuantity(subQuantity(quantity, outstanding))),
    remainingLayers,
  };
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

/** Moving-average state (`inventory_average_costs`). */
export interface AverageCostState {
  readonly quantityOnHand: string;
  readonly unitCostAmount: bigint;
  readonly totalValueAmount: bigint;
}

export const EMPTY_AVERAGE: AverageCostState = {
  quantityOnHand: '0.0000',
  unitCostAmount: 0n,
  totalValueAmount: 0n,
};

/**
 * Applies an inbound movement to the moving-average state:
 * `newAvg = (oldValue + qty×unitCost) / (oldQty + qty)`.
 */
export function applyReceiptToAverage(
  state: AverageCostState,
  input: { quantity: string; unitCostAmount: bigint },
): AverageCostState {
  if (!isPositiveQuantity(input.quantity)) {
    throw new RangeError('receipt_quantity_must_be_positive');
  }
  const quantity = addQuantity(state.quantityOnHand, input.quantity);
  const totalValue = state.totalValueAmount + multiplyMoneyByQuantity(input.unitCostAmount, input.quantity);
  return {
    quantityOnHand: quantity,
    unitCostAmount: divideMoneyByQuantity(totalValue, quantity),
    totalValueAmount: totalValue,
  };
}

/**
 * Applies an outbound movement at the current moving average. When the last unit
 * leaves, the residual value is written off so quantity and value stay coupled.
 */
export function applyIssueToAverage(state: AverageCostState, quantity: string): AverageCostState {
  if (compareQuantity(quantity, state.quantityOnHand) > 0) {
    throw new AppError('INSUFFICIENT_STOCK', {
      details: [{ rule: 'insufficient_average_quantity', params: { quantity, onHand: state.quantityOnHand } }],
    });
  }
  const issueCost = multiplyMoneyByQuantity(state.unitCostAmount, quantity);
  const quantityOnHand = subQuantity(state.quantityOnHand, quantity);
  if (isZeroQuantity(quantityOnHand)) {
    return { quantityOnHand: formatQuantity(0n), unitCostAmount: state.unitCostAmount, totalValueAmount: 0n };
  }
  const totalValueAmount = state.totalValueAmount - issueCost;
  return {
    quantityOnHand: normalizeQuantity(quantityOnHand),
    unitCostAmount: divideMoneyByQuantity(totalValueAmount, quantityOnHand),
    totalValueAmount,
  };
}

/**
 * Unit cost for an issue under the configured method. FIFO uses the layer result;
 * moving average uses the current state. Standard cost is rejected in v1 writes
 * unless an explicit standard cost is provided (`R1-A A-L-04`).
 */
export function resolveIssueCost(input: {
  method: CostMethod;
  quantity: string;
  layers?: readonly CostLayer[];
  average?: AverageCostState;
  standardCostAmount?: bigint | null;
}): { unitCostAmount: bigint; totalCostAmount: bigint; layerResult?: LayerConsumptionResult } {
  if (input.method === 'fifo') {
    if (input.layers === undefined) {
      throw new RangeError('fifo_issue_requires_layers');
    }
    const result = consumeLayersFifo(input.layers, input.quantity);
    return {
      unitCostAmount: divideMoneyByQuantity(result.totalCostAmount, input.quantity),
      totalCostAmount: result.totalCostAmount,
      layerResult: result,
    };
  }
  if (input.method === 'standard') {
    if (input.standardCostAmount === undefined || input.standardCostAmount === null) {
      throw new RangeError('standard_issue_requires_standard_cost');
    }
    return {
      unitCostAmount: input.standardCostAmount,
      totalCostAmount: multiplyMoneyByQuantity(input.standardCostAmount, input.quantity),
    };
  }
  const average = input.average ?? EMPTY_AVERAGE;
  const totalCostAmount = multiplyMoneyByQuantity(average.unitCostAmount, input.quantity);
  return { unitCostAmount: average.unitCostAmount, totalCostAmount };
}

/**
 * Layer integrity (`R1-A M-06`): `qty_remaining ∈ [0, original]`,
 * `cost_remaining ≤ unitCost × original`, and a closed layer has zero quantity.
 */
export function assertLayerIntegrity(layer: CostLayer): void {
  if (compareQuantity(layer.quantityRemaining, '0') < 0) {
    throw new AppError('RULE_VIOLATION', {
      message: 'باقی‌ماندهٔ مقدار لایهٔ بهای تمام‌شده منفی است.',
      messageKey: 'inventory.layer_quantity_invalid',
      details: [{ rule: 'layer_quantity_invalid', params: { layerId: layer.layerId } }],
    });
  }
  if (compareQuantity(layer.quantityRemaining, layer.originalQuantity) > 0) {
    throw new AppError('RULE_VIOLATION', {
      message: 'باقی‌ماندهٔ لایه بیش از مقدار اولیه است.',
      messageKey: 'inventory.layer_quantity_invalid',
      details: [{ rule: 'layer_quantity_invalid', params: { layerId: layer.layerId } }],
    });
  }
  const maxCost = multiplyMoneyByQuantity(layer.unitCostAmount, layer.originalQuantity);
  if (layer.costRemainingAmount > maxCost) {
    throw new AppError('RULE_VIOLATION', {
      message: 'باقی‌ماندهٔ ارزش لایه بیش از سقف مجاز است.',
      messageKey: 'inventory.layer_value_invalid',
      details: [{ rule: 'layer_value_invalid', params: { layerId: layer.layerId } }],
    });
  }
}

/** `Σ qty × unit_cost` across layers for a variant/warehouse. */
export function layersValue(layers: readonly CostLayer[]): bigint {
  return layers.reduce(
    (total, layer) => total + multiplyMoneyByQuantity(layer.unitCostAmount, layer.quantityRemaining),
    0n,
  );
}

export function layersQuantity(layers: readonly CostLayer[]): string {
  return layers.reduce((total, layer) => addQuantity(total, layer.quantityRemaining), '0.0000');
}

/**
 * Nightly layer-vs-average reconciliation (`ADR-0007`, `R1-A B-07`): the layer
 * book and the moving-average state must agree, otherwise GL inventory drifts.
 */
export function reconcileLayersWithAverage(
  layers: readonly CostLayer[],
  average: AverageCostState,
  toleranceAmount = 1n,
): { layerValue: bigint; averageValue: bigint; drift: bigint; reconciled: boolean } {
  const layerValue = layersValue(layers);
  const averageValue = average.totalValueAmount;
  const drift = layerValue - averageValue;
  const magnitude = drift < 0n ? -drift : drift;
  return { layerValue, averageValue, drift, reconciled: magnitude <= toleranceAmount };
}

/** Inbound valuation cost for a layer: explicit cost, else average, else reject. */
export function resolveInboundCost(input: {
  unitCostAmount?: bigint | null;
  average?: AverageCostState;
  allowZero?: boolean;
}): bigint {
  const cost = input.unitCostAmount ?? input.average?.unitCostAmount ?? 0n;
  if (cost === 0n && input.allowZero !== true) {
    throw new AppError('RULE_VIOLATION', {
      message: 'بهای تمام‌شدهٔ صفر برای ورود کالا مجاز نیست.',
      messageKey: 'inventory.zero_inbound_cost',
      details: [{ rule: 'zero_inbound_cost' }],
    });
  }
  return cost;
}

/**
 * Applies an outbound movement at its actual issue cost (FIFO total or moving
 * average total). Keeping the value movement identical to the layer consumption
 * keeps `Σ layer value = average state value` reconciled (`R1-A B-07`).
 */
export function applyIssueCostToAverage(
  state: AverageCostState,
  quantity: string,
  totalCostAmount: bigint,
): AverageCostState {
  if (compareQuantity(quantity, state.quantityOnHand) > 0) {
    throw new AppError('INSUFFICIENT_STOCK', {
      details: [{ rule: 'insufficient_average_quantity', params: { quantity, onHand: state.quantityOnHand } }],
    });
  }
  const quantityOnHand = subQuantity(state.quantityOnHand, quantity);
  if (isZeroQuantity(quantityOnHand)) {
    return { quantityOnHand: formatQuantity(0n), unitCostAmount: state.unitCostAmount, totalValueAmount: 0n };
  }
  const totalValueAmount = state.totalValueAmount - totalCostAmount;
  const nonNegativeTotal = totalValueAmount < 0n ? 0n : totalValueAmount;
  return {
    quantityOnHand: normalizeQuantity(quantityOnHand),
    unitCostAmount: divideMoneyByQuantity(nonNegativeTotal, quantityOnHand),
    totalValueAmount: nonNegativeTotal,
  };
}

/**
 * Consumes layer **quantities** FIFO at a uniform unit cost (moving-average
 * method): the value relieved from every layer equals `qty × avgCost`, with the
 * rounding residual absorbed by the last consumption. This keeps
 * `Σ layer value = average state value` while the ledger cost follows the moving
 * average rather than historical layer prices (`R1-A B-07`).
 */
export function consumeLayersAtUnitCost(
  layers: readonly CostLayer[],
  quantity: string,
  unitCostAmount: bigint,
): LayerConsumptionResult {
  const requested = parseQuantity(quantity);
  if (requested <= 0n) {
    throw new RangeError('consumption_quantity_must_be_positive');
  }
  const ordered = sortLayersFifo(layers);
  const available = ordered.reduce(
    (total, layer) => addQuantity(total, layer.quantityRemaining),
    '0.0000',
  );
  if (compareQuantity(available, quantity) < 0) {
    throw new AppError('INSUFFICIENT_STOCK', {
      message: 'موجودی لایه‌های بهای تمام‌شده برای این خروج کافی نیست.',
      details: [
        { rule: 'insufficient_cost_layers', params: { requested: normalizeQuantity(quantity), available } },
      ],
    });
  }
  let outstanding = normalizeQuantity(quantity);
  const consumptions: LayerConsumption[] = [];
  const remainingLayers: CostLayer[] = [];
  const target = multiplyMoneyByQuantity(unitCostAmount, quantity);
  let assigned = 0n;
  for (const layer of ordered) {
    if (!isPositiveQuantity(outstanding)) {
      remainingLayers.push(layer);
      continue;
    }
    if (!isPositiveQuantity(layer.quantityRemaining)) {
      remainingLayers.push(layer);
      continue;
    }
    const take = minQuantity(layer.quantityRemaining, outstanding);
    const fullyConsumed = compareQuantity(take, layer.quantityRemaining) === 0;
    const remainingOutstanding = subQuantity(outstanding, take);
    const cost = isZeroQuantity(remainingOutstanding)
      ? target - assigned
      : minBigInt(multiplyMoneyByQuantity(unitCostAmount, take), layer.costRemainingAmount);
    consumptions.push({ layerId: layer.layerId, quantity: take, costAmount: cost });
    assigned += cost;
    outstanding = formatQuantity(parseQuantity(remainingOutstanding));
    remainingLayers.push({
      ...layer,
      quantityRemaining: formatQuantity(parseQuantity(subQuantity(layer.quantityRemaining, take))),
      costRemainingAmount: layer.costRemainingAmount - cost,
    });
    void fullyConsumed;
  }
  const totalCostAmount = consumptions.reduce((total, consumption) => total + consumption.costAmount, 0n);
  return {
    consumptions,
    totalCostAmount,
    consumedQuantity: formatQuantity(parseQuantity(subQuantity(quantity, outstanding))),
    remainingLayers,
  };
}

/** Averages a list of unit costs weighted by quantity (landed-cost allocation). */
export function weightedAverageCost(
  entries: readonly { quantity: string; unitCostAmount: bigint }[],
): bigint {
  let totalValue = 0n;
  let totalQuantity = '0.0000';
  for (const entry of entries) {
    totalValue += multiplyMoneyByQuantity(entry.unitCostAmount, entry.quantity);
    totalQuantity = addQuantity(totalQuantity, entry.quantity);
  }
  return divideMoneyByQuantity(totalValue, totalQuantity);
}

/** Rounding helper re-exported for tests that assert the accounting convention. */
export function roundMoneyHalfUp(numerator: bigint, denominator: bigint): bigint {
  return roundHalfUp(numerator, denominator);
}
