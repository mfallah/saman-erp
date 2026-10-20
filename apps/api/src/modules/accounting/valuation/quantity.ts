/**
 * Exact quantity arithmetic for costing. Quantities are `numeric(18,4)` and are
 * represented as `bigint` scaled by 10,000 — no float ever touches a cost.
 */
import { AppError, roundHalfUp } from '@saman/shared';

export const QTY_SCALE = 10_000n;

const QTY_PATTERN = /^\d+(?:\.\d{1,4})?$/;

export type Qty = bigint;

export function parseQty(value: string | bigint | number): Qty {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidQty(String(value));
    return parseQty(value.toFixed(4));
  }
  const text = value.trim();
  if (!QTY_PATTERN.test(text)) throw invalidQty(value);
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * QTY_SCALE + BigInt(fraction.padEnd(4, '0'));
}

export function formatQty(quantity: Qty): string {
  const negative = quantity < 0n;
  const magnitude = negative ? -quantity : quantity;
  const whole = magnitude / QTY_SCALE;
  const fraction = (magnitude % QTY_SCALE).toString().padStart(4, '0').replace(/0+$/, '');
  const body = fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
  return negative ? `-${body}` : body;
}

export function addQty(left: Qty, right: Qty): Qty {
  return left + right;
}

export function subQty(left: Qty, right: Qty): Qty {
  return left - right;
}

/** `unitCost × quantity`, ROUND_HALF_UP to whole rials. */
export function costOf(unitCost: bigint, quantity: Qty): bigint {
  return roundHalfUp(unitCost * quantity, QTY_SCALE);
}

/** Safe division of a cost by a quantity (unit cost), ROUND_HALF_UP. */
export function unitCostOf(cost: bigint, quantity: Qty): bigint {
  if (quantity === 0n) throw invalidQty('0');
  return roundHalfUp(cost * QTY_SCALE, quantity);
}

function invalidQty(value: string): AppError {
  return new AppError('VALIDATION_ERROR', {
    details: [{ field: 'quantity', rule: 'numeric_18_4', params: { value } }],
    message: 'مقدار واردشده برای موجودی معتبر نیست.',
  });
}
