/**
 * Cost-layer (FIFO) and moving-average valuation (`R1-accounting` B-07,
 * ADR-0007 §6, `DATA-MODEL §2.17`).
 *
 * Layers are append-only; a consumption names the layer it drew from, so a
 * return can restore the exact layers and a reversal can post a compensating
 * layer instead of rewriting history. Both functions here are pure and fully
 * covered by unit tests.
 */
import { AppError, roundHalfUp } from '@saman/shared';
import { QTY_SCALE, costOf, formatQty, parseQty } from './quantity';
import type { Qty } from './quantity';

export interface CostLayer {
  readonly id: bigint;
  /** ISO timestamp of the receipt; FIFO orders by `(receivedAt, id)`. */
  readonly receivedAt: string;
  readonly qtyRemaining: string;
  readonly unitCostAmount: bigint;
  readonly costRemainingAmount: bigint;
}

export interface LayerConsumption {
  readonly layerId: bigint;
  readonly quantity: string;
  readonly costAmount: bigint;
  readonly closesLayer: boolean;
}

export interface FifoResult {
  readonly consumptions: readonly LayerConsumption[];
  readonly totalCost: bigint;
  readonly consumedQuantity: string;
  /** Quantity that could not be satisfied from layers (must be zero in v1). */
  readonly shortfallQuantity: string;
}

function compareLayers(left: CostLayer, right: CostLayer): number {
  if (left.receivedAt < right.receivedAt) return -1;
  if (left.receivedAt > right.receivedAt) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

/**
 * Consumes `quantity` from the oldest layers first. When a layer is fully
 * consumed the entire `costRemainingAmount` is taken (never a rounded residual),
 * so `Σ layer value = Σ consumptions + remaining value` always holds exactly.
 */
export function consumeFifo(
  layers: readonly CostLayer[],
  quantity: string | bigint,
  options: { readonly allowShortfall?: boolean } = {},
): FifoResult {
  const requested = parseQty(quantity);
  if (requested <= 0n) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'quantity', rule: 'positive' }],
      message: 'مقدار مصرف باید بزرگ‌تر از صفر باشد.',
    });
  }

  const ordered = [...layers].sort(compareLayers);
  const consumptions: LayerConsumption[] = [];
  let remaining = requested;
  let totalCost = 0n;

  for (const layer of ordered) {
    if (remaining === 0n) break;
    const available = parseQty(layer.qtyRemaining);
    if (available <= 0n) continue;

    const take = available <= remaining ? available : remaining;
    const closes = take === available;
    const cost = closes
      ? layer.costRemainingAmount
      : roundHalfUp(layer.costRemainingAmount * take, available);
    consumptions.push({
      layerId: layer.id,
      quantity: formatQty(take),
      costAmount: cost,
      closesLayer: closes,
    });
    totalCost += cost;
    remaining -= take;
  }

  if (remaining !== 0n && options.allowShortfall !== true) {
    throw new AppError('INSUFFICIENT_STOCK', {
      details: [
        {
          rule: 'cost_layers_insufficient',
          params: { requested: formatQty(requested), shortfall: formatQty(remaining) },
        },
      ],
      message: 'لایه‌های بهای تمام‌شده برای این خروج کافی نیست.',
    });
  }

  return {
    consumptions,
    totalCost,
    consumedQuantity: formatQty(requested - remaining),
    shortfallQuantity: formatQty(remaining),
  };
}

export interface AverageState {
  readonly qtyOnHand: string;
  readonly avgCostAmount: bigint;
  readonly totalValueAmount: bigint;
}

/** Moving-average inbound: recomputes the average cost per (warehouse, variant). */
export function applyAverageInbound(
  state: AverageState,
  inboundQuantity: string,
  inboundCost: bigint,
): AverageState {
  const qty = parseQty(state.qtyOnHand);
  const inbound = parseQty(inboundQuantity);
  if (inbound < 0n || inboundCost < 0n) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'inboundQuantity', rule: 'non_negative' }],
      message: 'ورود موجودی با مقدار یا بهای منفی مجاز نیست.',
    });
  }
  const newQty = qty + inbound;
  const newValue = state.totalValueAmount + inboundCost;
  const avgCost = newQty === 0n ? 0n : roundHalfUp(newValue * QTY_SCALE, newQty);
  return {
    qtyOnHand: formatQty(newQty),
    avgCostAmount: avgCost,
    totalValueAmount: newValue,
  };
}

/** Moving-average outbound: cost = qty × average, residual cleared on depletion. */
export function consumeAverage(
  state: AverageState,
  quantity: string,
): { readonly costAmount: bigint; readonly next: AverageState } {
  const requested = parseQty(quantity);
  const available = parseQty(state.qtyOnHand);
  if (requested <= 0n) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'quantity', rule: 'positive' }],
      message: 'مقدار مصرف باید بزرگ‌تر از صفر باشد.',
    });
  }
  if (requested > available) {
    throw new AppError('INSUFFICIENT_STOCK', {
      details: [{ rule: 'average_insufficient', params: { available: state.qtyOnHand } }],
      message: 'موجودی برای این خروج کافی نیست.',
    });
  }
  const remainingQty = available - requested;
  const cost =
    remainingQty === 0n
      ? state.totalValueAmount
      : roundHalfUp(state.totalValueAmount * requested, available);
  const remainingValue = state.totalValueAmount - cost;
  return {
    costAmount: cost,
    next: {
      qtyOnHand: formatQty(remainingQty),
      avgCostAmount: remainingQty === 0n ? 0n : roundHalfUp(remainingValue * QTY_SCALE, remainingQty),
      totalValueAmount: remainingValue,
    },
  };
}

export interface VariantValuationRow {
  readonly warehouseId: bigint;
  readonly productVariantId: bigint;
  readonly quantity: string;
  readonly unitCostAmount: bigint;
  readonly valueAmount: bigint;
}

export interface ValuationSummary {
  readonly totalValue: bigint;
  readonly totalQuantity: string;
  readonly lineCount: number;
}

/** Aggregates valuation lines; line value must equal round(qty × unit cost). */
export function summariseValuation(rows: readonly VariantValuationRow[]): ValuationSummary {
  let totalValue = 0n;
  let totalQuantity = 0n;
  for (const row of rows) {
    const qty = parseQty(row.quantity);
    totalQuantity += qty;
    const expected = qty === 0n ? 0n : costOf(row.unitCostAmount, qty);
    if (expected !== row.valueAmount) {
      throw new AppError('RULE_VIOLATION', {
        details: [
          {
            rule: 'valuation_line_value_mismatch',
            params: {
              warehouseId: row.warehouseId.toString(),
              variantId: row.productVariantId.toString(),
              expected: expected.toString(),
              actual: row.valueAmount.toString(),
            },
          },
        ],
        message: 'ارزش سطر ارزش‌گذاری با مقدار × بهای واحد برابر نیست.',
      });
    }
    totalValue += row.valueAmount;
  }
  return { totalValue, totalQuantity: formatQty(totalQuantity), lineCount: rows.length };
}

/**
 * GL reconciliation: `Σ cost layers = GL inventory account`. A non-zero variance
 * is reported (never silently posted) and only a run inside tolerance may post.
 */
export function reconcileWithGl(
  ledgerValue: bigint,
  glInventoryBalance: bigint,
): { readonly variance: bigint; readonly reconciles: boolean } {
  const variance = ledgerValue - glInventoryBalance;
  return { variance, reconciles: variance === 0n };
}

/** Structural validation of a persisted layer (mirrors the DB CHECKs). */
export function assertLayerIntegrity(layer: CostLayer): void {
  const qty = parseQty(layer.qtyRemaining);
  if (qty < 0n) throw new AppError('RULE_VIOLATION', { details: [{ rule: 'layer_qty_negative' }] });
  if (layer.costRemainingAmount < 0n) {
    throw new AppError('RULE_VIOLATION', { details: [{ rule: 'layer_cost_negative' }] });
  }
  if (qty === 0n && layer.costRemainingAmount !== 0n) {
    throw new AppError('RULE_VIOLATION', {
      details: [{ rule: 'layer_depleted_with_residual_cost', params: { layerId: layer.id.toString() } }],
      message: 'لایه مصرف‌شده نباید بهای باقیمانده داشته باشد.',
    });
  }
}
