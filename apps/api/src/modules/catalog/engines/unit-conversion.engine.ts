/**
 * Units of measure & conversions (`DATA-MODEL` §2.4 `catalog.unit_conversions`).
 *
 * Conversions are directed rows (`from → to`, `factor`); the service seeds the
 * reciprocal pair so `factor(a→b) × factor(b→a) = 1`. Quantity arithmetic is
 * decimal-string based (never floats, `ADR-0013`) and rounds only at the
 * declared UoM precision (`decimal_precision`, 0–4).
 */
import { AppError, roundHalfUp } from '@saman/shared';

export const UOM_DIMENSIONS = ['count', 'mass', 'volume', 'length', 'area', 'time', 'package'] as const;
export type UomDimension = (typeof UOM_DIMENSIONS)[number];

const DECIMAL_PATTERN = /^-?\d+(?:\.\d{1,12})?$/;

interface Rational {
  numerator: bigint;
  denominator: bigint;
}

function parseDecimal(value: string, pattern: RegExp): Rational {
  const trimmed = value.trim();
  if (!pattern.test(trimmed)) {
    throw new RangeError(`invalid_decimal:${value}`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const dot = unsigned.indexOf('.');
  const whole = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fraction = dot === -1 ? '' : unsigned.slice(dot + 1);
  const numerator = BigInt(`${whole}${fraction}` || '0');
  const denominator = 10n ** BigInt(fraction.length);
  return { numerator: negative ? -numerator : numerator, denominator };
}

function formatDecimal(numerator: bigint, denominator: bigint, precision: number): string {
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const scaled = magnitude * 10n ** BigInt(precision);
  const rounded = roundHalfUp(scaled, denominator);
  const digits = rounded.toString().padStart(precision + 1, '0');
  const whole = digits.slice(0, digits.length - precision) || '0';
  const fraction = precision === 0 ? '' : `.${digits.slice(digits.length - precision)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** Trims insignificant trailing zeros (`"72.000000000000"` → `"72"`). */
function trimDecimal(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}

/** Validates a conversion factor decimal string (`numeric(30,12)`, > 0). */
export function assertValidFactor(factor: string): string {
  const parsed = parseDecimal(factor, DECIMAL_PATTERN);
  if (parsed.numerator <= 0n) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'factor', rule: 'factor_must_be_positive' }],
    });
  }
  return factor.trim();
}

/**
 * A conversion pair is exact when the product of the two factors is 1 within a
 * tolerance of 1e-9 (the reciprocal is stored with up to 12 decimals).
 */
export function isReciprocalPair(
  factor: string,
  reverseFactor: string,
  tolerance = 1e-9,
): boolean {
  const left = parseDecimal(factor, DECIMAL_PATTERN);
  const right = parseDecimal(reverseFactor, DECIMAL_PATTERN);
  // |a*b - 1| <= tolerance  ⇔  |an*bn - ad*bd| <= tolerance*ad*bd
  const productNumerator = left.numerator * right.numerator - left.denominator * right.denominator;
  const productDenominator = left.denominator * right.denominator;
  const difference = Number(productNumerator) / Number(productDenominator);
  return Math.abs(difference) <= tolerance;
}

export function assertReciprocalPair(factor: string, reverseFactor: string): void {
  if (!isReciprocalPair(factor, reverseFactor)) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'factor', rule: 'conversion_pair_not_reciprocal' }],
    });
  }
}

/** Computes the reciprocal factor string with up to 12 decimal places. */
export function reciprocalFactor(factor: string): string {
  const parsed = parseDecimal(factor, DECIMAL_PATTERN);
  if (parsed.numerator === 0n) {
    throw new RangeError('division_by_zero');
  }
  // reciprocal = 1 / (n/d) = d/n, rounded to 12 decimals.
  return formatDecimal(parsed.denominator, parsed.numerator, 12);
}

/**
 * Converts a quantity between two units using a factor (`from → to`).
 * Rounds half-up to the target unit's `decimal_precision`.
 */
export function convertQuantity(quantity: string, factor: string, precision = 0): string {
  const amount = parseDecimal(quantity, DECIMAL_PATTERN);
  const conversion = parseDecimal(factor, DECIMAL_PATTERN);
  const numerator = amount.numerator * conversion.numerator;
  const denominator = amount.denominator * conversion.denominator;
  return formatDecimal(numerator, denominator, precision);
}

/** Base quantity of a non-base unit (`qty × factor` into the base unit). */
export function toBaseQuantity(quantity: string, factorToBase: string, precision = 4): string {
  return convertQuantity(quantity, factorToBase, precision);
}

export interface ConversionEdge {
  readonly fromUnitId: string;
  readonly toUnitId: string;
  readonly factor: string;
}

/**
 * Resolves a direct or single-hop conversion factor between two units.
 * Returns `null` when no path exists (the service then rejects the operation),
 * guaranteeing cross-dimension conversions cannot silently corrupt quantities.
 */
export function resolveConversionFactor(
  edges: readonly ConversionEdge[],
  fromUnitId: string,
  toUnitId: string,
): string | null {
  if (fromUnitId === toUnitId) return '1';
  for (const edge of edges) {
    if (edge.fromUnitId === fromUnitId && edge.toUnitId === toUnitId) return edge.factor;
  }
  // Two-hop: from → hub → to
  for (const first of edges) {
    if (first.fromUnitId !== fromUnitId) continue;
    for (const second of edges) {
      if (second.fromUnitId === first.toUnitId && second.toUnitId === toUnitId) {
        const product = parseDecimal(first.factor, DECIMAL_PATTERN);
        const other = parseDecimal(second.factor, DECIMAL_PATTERN);
        return trimDecimal(
          formatDecimal(product.numerator * other.numerator, product.denominator * other.denominator, 12),
        );
      }
    }
  }
  return null;
}

/**
 * A dimension is valid for a unit; count units must have precision 0
 * (`ck_units_of_measure_precision`).
 */
export function assertValidPrecision(dimension: UomDimension, precision: number): void {
  if (!Number.isInteger(precision) || precision < 0 || precision > 4) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'decimalPrecision', rule: 'precision_out_of_range' }],
    });
  }
  if (dimension === 'count' && precision !== 0) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'decimalPrecision', rule: 'count_unit_requires_zero_precision' }],
    });
  }
}
