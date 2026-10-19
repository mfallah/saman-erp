/**
 * Money & quantity formatting/parsing (ADR-0013).
 *
 * Money is an integer amount of IRR transported as a decimal string. It is
 * parsed to `bigint` and formatted by hand (grouping + Persian digits) so that
 * values larger than `Number.MAX_SAFE_INTEGER` never lose precision.
 * The SPA never does arithmetic on floats; the helpers below are the only
 * sanctioned operations.
 */

const PERSIAN_ZERO = 0x06f0;
const ARABIC_ZERO = 0x0660;
const GROUP_SEPARATOR = '\u066c'; // ٬ Arabic thousands separator, Persian convention

/** Converts Persian/Arabic-Indic digits inside a string to ASCII digits. */
export function toLatinDigits(input: string): string {
  let out = '';
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= PERSIAN_ZERO && code <= PERSIAN_ZERO + 9) {
      out += String(code - PERSIAN_ZERO);
    } else if (code >= ARABIC_ZERO && code <= ARABIC_ZERO + 9) {
      out += String(code - ARABIC_ZERO);
    } else {
      out += char;
    }
  }
  return out;
}

/** Converts ASCII digits inside a string to Persian digits for rendering. */
export function toPersianDigits(input: string): string {
  let out = '';
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x30 && code <= 0x39) {
      out += String.fromCodePoint(PERSIAN_ZERO + (code - 0x30));
    } else {
      out += char;
    }
  }
  return out;
}

export class MoneyParseError extends Error {
  constructor(input: string) {
    super(`مقدار پولی نامعتبر است: ${input}`);
    this.name = 'MoneyParseError';
  }
}

/**
 * Parses user/API money input into `bigint` rial.
 * Accepts Persian/Arabic digits, `٬`/`,`/spaces as separators and a leading
 * minus sign. Rejects decimals (rial has no minor unit in JSON).
 */
export function parseMoney(input: string | number | bigint): bigint {
  if (typeof input === 'bigint') {
    return input;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      throw new MoneyParseError(String(input));
    }
    return BigInt(input);
  }
  const normalized = toLatinDigits(input)
    .trim()
    .replace(/[\s\u066c,\u200c]/g, '')
    .replace(/\u2212/g, '-');
  if (!/^-?\d+$/.test(normalized)) {
    throw new MoneyParseError(input);
  }
  return BigInt(normalized);
}

export interface FormatMoneyOptions {
  /** Suffix rendered after the number; default `ریال`. Pass `''` to omit. */
  readonly unit?: string;
  /** Render a `+` for positive values (deltas/KPIs). */
  readonly signed?: boolean;
  /** Convert ASCII digits to Persian digits; default true. */
  readonly persianDigits?: boolean;
  /** Use the Persian thousands separator; default true. */
  readonly grouping?: boolean;
}

function groupAscii(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP_SEPARATOR);
}

/**
 * Formats a money value for display, e.g. `formatMoney('12500000')` →
 * `"۱۲٬۵۰۰٬۰۰۰ ریال"`. Never goes through `Number`, so precision is preserved.
 */
export function formatMoney(
  value: string | number | bigint,
  options: FormatMoneyOptions = {},
): string {
  const {
    unit = 'ریال',
    signed = false,
    persianDigits = true,
    grouping = true,
  } = options;
  const amount = parseMoney(value);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const digits = grouping ? groupAscii(absolute.toString()) : absolute.toString();
  let rendered = persianDigits ? toPersianDigits(digits) : digits;
  if (negative) {
    rendered = `\u2212${rendered}`;
  } else if (signed && amount > 0n) {
    rendered = `+${rendered}`;
  }
  return unit === '' ? rendered : `${rendered} ${unit}`;
}

/** Formats a quantity/price decimal string with at most 4 fraction digits. */
export function formatQuantity(value: string | number, fractionDigits = 4): string {
  const numeric = typeof value === 'number' ? value : Number(toLatinDigits(value));
  if (!Number.isFinite(numeric)) {
    return toPersianDigits(String(value));
  }
  return new Intl.NumberFormat('fa-IR', {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: 0,
  }).format(numeric);
}

/** Formats a plain integer/count with Persian grouping. */
export function formatNumber(value: number | string, fractionDigits = 0): string {
  const numeric = typeof value === 'number' ? value : Number(toLatinDigits(String(value)));
  if (!Number.isFinite(numeric)) {
    return toPersianDigits(String(value));
  }
  return new Intl.NumberFormat('fa-IR', {
    maximumFractionDigits: fractionDigits,
  }).format(numeric);
}

/** Formats a decimal rate (e.g. `"0.090000"`) as a Persian percentage. */
export function formatPercent(rate: string | number, fractionDigits = 2): string {
  const numeric = typeof rate === 'number' ? rate : Number(toLatinDigits(rate));
  if (!Number.isFinite(numeric)) {
    return toPersianDigits(String(rate));
  }
  return new Intl.NumberFormat('fa-IR', {
    style: 'percent',
    maximumFractionDigits: fractionDigits,
  }).format(numeric);
}

function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new MoneyParseError('تقسیم بر صفر');
  }
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * Multiplies a money amount by a decimal rate string (`"0.09"`) with
 * ROUND_HALF_UP at `rateScale` (6 by default, matching numeric(9,6)).
 */
export function multiplyByRate(
  amount: string | bigint,
  rate: string,
  rateScale = 6,
): bigint {
  const base = parseMoney(amount);
  const normalized = toLatinDigits(rate).trim();
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) {
    throw new MoneyParseError(rate);
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = match[2] ?? '0';
  const fractionRaw = match[3] ?? '';
  const fraction = (fractionRaw + '0'.repeat(rateScale)).slice(0, rateScale);
  const scaled = BigInt(`${whole}${fraction}`) * sign;
  return divideHalfUp(base * scaled, 10n ** BigInt(rateScale));
}

/** Adds two money values exactly. */
export function addMoney(a: string | bigint, b: string | bigint): bigint {
  return parseMoney(a) + parseMoney(b);
}

/** Subtracts `b` from `a` exactly. */
export function subtractMoney(a: string | bigint, b: string | bigint): bigint {
  return parseMoney(a) - parseMoney(b);
}

/** Sums a list of money values exactly. */
export function sumMoney(values: readonly (string | bigint)[]): bigint {
  return values.reduce<bigint>((total, value) => total + parseMoney(value), 0n);
}

/** True when a string is a valid integer money representation. */
export function isMoneyLike(value: string): boolean {
  try {
    parseMoney(value);
    return true;
  } catch {
    return false;
  }
}
