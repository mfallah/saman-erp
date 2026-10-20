/**
 * Invoice arithmetic with an explicit rounding contract (`R1-accounting` B-12,
 * ADR-0013).
 *
 * `net = ROUND_HALF_UP(qty × unitPrice) − lineDiscount`
 * `tax = ROUND_HALF_UP(net × rate)`
 * `gross = net + tax`
 *
 * Header totals are **sums of stored line amounts**; a header discount is
 * distributed by largest remainder (never re-added twice) and any residual
 * created by rounding to the document step goes to `5-2-14-001`.
 */
import { AppError, applyRate, multiplyByQuantity } from '@saman/shared';

export interface InvoiceLineInput {
  /** `numeric(18,4)` decimal string. */
  readonly quantity: string;
  /** Unit price in IRR. */
  readonly unitPrice: bigint;
  readonly lineDiscount?: bigint;
  /** Fractional VAT rate (`0.10` = 10%); absent/`0` = exempt. */
  readonly taxRate?: string;
  /** True when `unitPrice` already includes VAT (storefront display price). */
  readonly taxInclusive?: boolean;
}

export interface InvoiceLineAmounts {
  readonly netAmount: bigint;
  readonly taxAmount: bigint;
  readonly grossAmount: bigint;
}

function validationError(field: string, rule: string): AppError {
  return new AppError('VALIDATION_ERROR', {
    details: [{ field, rule }],
    message: 'مبلغ یا مقدار سطر فاکتور معتبر نیست.',
  });
}

/** Computes the three stored amounts of one invoice line. */
export function computeLineAmounts(input: InvoiceLineInput): InvoiceLineAmounts {
  const { quantity, unitPrice } = input;
  if (unitPrice < 0n) throw validationError('unitPrice', 'non_negative');

  let grossBase: bigint;
  try {
    grossBase = multiplyByQuantity(unitPrice, quantity);
  } catch {
    throw validationError('quantity', 'numeric_18_4');
  }

  const discount = input.lineDiscount ?? 0n;
  if (discount < 0n) throw validationError('lineDiscount', 'non_negative');

  const rate = input.taxRate ?? '0';
  if (input.taxInclusive && rate !== '0') {
    // price includes VAT: net = gross / (1 + rate)
    const denominator = 1_000_000n + scaledRate(rate);
    if (denominator <= 0n) throw validationError('taxRate', 'range');
    const netBeforeDiscount = roundDiv(grossBase * 1_000_000n, denominator);
    const netAmount = netBeforeDiscount - discount;
    if (netAmount < 0n) throw validationError('lineDiscount', 'exceeds_line');
    const grossAmount = grossBase - discount;
    return { netAmount, taxAmount: grossAmount - netAmount, grossAmount };
  }

  const netAmount = grossBase - discount;
  if (netAmount < 0n) throw validationError('lineDiscount', 'exceeds_line');
  const taxAmount = applyRate(netAmount, rate);
  return { netAmount, taxAmount, grossAmount: netAmount + taxAmount };
}

function scaledRate(rate: string): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/.test(rate.trim())) throw validationError('taxRate', 'decimal');
  const [whole, fraction = ''] = rate.trim().split('.');
  return BigInt(`${whole ?? '0'}${fraction.padEnd(6, '0')}`);
}

function roundDiv(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  let quotient = n / d;
  if ((n % d) * 2n >= d) quotient += 1n;
  return negative ? -quotient : quotient;
}

/**
 * Largest-remainder allocation of a header discount across line nets so the
 * per-line shares sum exactly to the header discount.
 */
export function allocateHeaderDiscount(
  lineNets: readonly bigint[],
  headerDiscount: bigint,
): readonly bigint[] {
  if (headerDiscount === 0n || lineNets.length === 0) return lineNets.map(() => 0n);
  if (headerDiscount < 0n) throw validationError('headerDiscount', 'non_negative');
  const totalNet = lineNets.reduce((acc, value) => acc + value, 0n);
  if (totalNet <= 0n) throw validationError('headerDiscount', 'no_taxable_base');
  if (headerDiscount > totalNet) throw validationError('headerDiscount', 'exceeds_subtotal');

  const allocations: bigint[] = lineNets.map(() => 0n);
  const remainders: Array<{ index: number; remainder: bigint }> = [];
  let assigned = 0n;
  lineNets.forEach((net, index) => {
    const exact = headerDiscount * net;
    const base = exact / totalNet;
    allocations[index] = base;
    assigned += base;
    remainders.push({ index, remainder: exact % totalNet });
  });
  let leftover = headerDiscount - assigned;
  remainders.sort((left, right) => {
    if (left.remainder === right.remainder) return left.index - right.index;
    return left.remainder > right.remainder ? -1 : 1;
  });
  for (const item of remainders) {
    if (leftover === 0n) break;
    allocations[item.index] = (allocations[item.index] ?? 0n) + 1n;
    leftover -= 1n;
  }
  return allocations;
}

export interface InvoiceHeaderInput {
  readonly headerDiscount?: bigint;
  readonly shipping?: bigint;
  /** Document rounding step (rials); `1` disables step rounding. */
  readonly roundTo?: bigint;
}

export interface InvoiceTotals {
  /** Σ line net (after line discounts, before header discount). */
  readonly subtotal: bigint;
  readonly taxTotal: bigint;
  readonly lineDiscountTotal: bigint;
  readonly headerDiscount: bigint;
  readonly revenueNet: bigint;
  readonly shipping: bigint;
  /** Σ gross before header discount and shipping. */
  readonly linesGross: bigint;
  /** Document grand total: `revenueNet + taxTotal + shipping + rounding`. */
  readonly grandTotal: bigint;
  /** Residual produced by rounding the payable to `roundTo` (may be negative). */
  readonly roundingAdjustment: bigint;
  readonly perLineHeaderDiscount: readonly bigint[];
}

/** Aggregates lines into document amounts; never double-counts tax. */
export function computeInvoiceTotals(
  lines: readonly InvoiceLineInput[],
  header: InvoiceHeaderInput = {},
): InvoiceTotals {
  if (lines.length === 0) throw validationError('lines', 'at_least_one');
  const amounts = lines.map((line) => computeLineAmounts(line));
  const subtotal = amounts.reduce((acc, line) => acc + line.netAmount, 0n);
  const taxTotal = amounts.reduce((acc, line) => acc + line.taxAmount, 0n);
  const linesGross = amounts.reduce((acc, line) => acc + line.grossAmount, 0n);
  const lineDiscountTotal = lines.reduce((acc, line) => acc + (line.lineDiscount ?? 0n), 0n);
  const headerDiscount = header.headerDiscount ?? 0n;
  const shipping = header.shipping ?? 0n;
  if (shipping < 0n) throw validationError('shipping', 'non_negative');

  const perLineHeaderDiscount = allocateHeaderDiscount(
    amounts.map((line) => line.netAmount),
    headerDiscount,
  );
  const revenueNet = subtotal - headerDiscount;
  const beforeRounding = revenueNet + taxTotal + shipping;
  const roundTo = header.roundTo ?? 1n;
  if (roundTo <= 0n) throw validationError('roundTo', 'positive');
  const rounded = roundDiv(beforeRounding, roundTo) * roundTo;
  return {
    subtotal,
    taxTotal,
    lineDiscountTotal,
    headerDiscount,
    revenueNet,
    shipping,
    linesGross,
    grandTotal: rounded,
    roundingAdjustment: rounded - beforeRounding,
    perLineHeaderDiscount,
  };
}
