/**
 * Deterministic SKU generation and normalization (`DATA-MODEL` §2.4
 * `catalog.product_variants.sku`, globally unique).
 *
 * A SKU is a stable, human-recognizable stock-keeping key. It is generated once
 * and never reused; the generator is pure so the same input always yields the
 * same SKU (reproducible imports, idempotent seed and tests).
 */
import { AppError } from '@saman/shared';

const SKU_PATTERN = /^[A-Z0-9](?:[A-Z0-9-]{0,98}[A-Z0-9])$/;
const MAX_SKU_LENGTH = 100;
const LATIN_FOLD: Readonly<Record<string, string>> = {
  '\u064a': 'Y', // ي
  '\u0649': 'Y', // ى
  '\u0643': 'K', // ك
  '\u06a9': 'K', // ک
  '\u06cc': 'Y', // ی
  '\u06af': 'G', // گ
  '\u0686': 'CH', // چ
  '\u067e': 'P', // پ
  '\u0698': 'ZH', // ژ
  '\u0622': 'A',
  '\u0623': 'A',
  '\u0625': 'E',
  '\u0627': 'A',
  '\u0628': 'B',
  '\u062a': 'T',
  '\u062b': 'S',
  '\u062c': 'J',
  '\u062d': 'H',
  '\u062e': 'KH',
  '\u062f': 'D',
  '\u0630': 'Z',
  '\u0631': 'R',
  '\u0632': 'Z',
  '\u0633': 'S',
  '\u0634': 'SH',
  '\u0635': 'S',
  '\u0636': 'Z',
  '\u0637': 'T',
  '\u0638': 'Z',
  '\u0639': 'A',
  '\u063a': 'GH',
  '\u0641': 'F',
  '\u0642': 'GH',
  '\u0644': 'L',
  '\u0645': 'M',
  '\u0646': 'N',
  '\u0647': 'H',
  '\u0648': 'V',
  '\u0629': 'H',
  '\u06c0': 'H',
};

/** Folds Persian/Arabic letters and digits into an ASCII-safe uppercase token. */
export function latinizeToken(input: string): string {
  const folded = [...input].map((char) => LATIN_FOLD[char] ?? char).join('');
  return folded
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Stable 32-bit FNV-1a hash rendered as 8 uppercase hex characters. */
export function stableToken(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

export interface GenerateSkuInput {
  /** Human category code (e.g. `MOB`); used as the leading segment. */
  categoryCode?: string;
  nameFa?: string;
  nameEn?: string;
  /** Per-organization monotonic variant sequence. */
  sequence: number;
  separator?: string;
}

/**
 * Generates a deterministic SKU: `<CATEGORY>-<NAME-TOKEN>-<NNNNNN>`.
 *
 * A Persian-only name is transliterated; when no latin token can be derived the
 * stable hash keeps the SKU deterministic and collision-resistant. The result is
 * always within `varchar(100)` and matches the normalized SKU pattern.
 */
export function generateSku(input: GenerateSkuInput): string {
  if (!Number.isInteger(input.sequence) || input.sequence < 0) {
    throw new RangeError('sku_sequence_must_be_non_negative_integer');
  }
  const separator = input.separator ?? '-';
  const parts: string[] = [];

  const category = input.categoryCode === undefined ? '' : latinizeToken(input.categoryCode);
  if (category !== '') {
    parts.push(category.slice(0, 12));
  }

  const rawName = input.nameEn ?? input.nameFa ?? '';
  const nameToken = latinizeToken(rawName);
  if (nameToken !== '') {
    parts.push(nameToken.slice(0, 32).replace(/-+$/g, ''));
  } else if (parts.length === 0) {
    parts.push(stableToken(rawName));
  }

  parts.push(input.sequence.toString().padStart(6, '0'));

  const sku = parts.filter((part) => part.length > 0).join(separator).slice(0, MAX_SKU_LENGTH);
  return normalizeSku(sku);
}

/** Trims, uppercases and collapses separators; returns the canonical SKU form. */
export function normalizeSku(input: string): string {
  const normalized = input
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!SKU_PATTERN.test(normalized)) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'sku', rule: 'invalid_sku_format' }],
    });
  }
  return normalized;
}

/** Returns true when a supplied SKU already matches the normalized pattern. */
export function isValidSku(input: string): boolean {
  return SKU_PATTERN.test(input);
}

/**
 * Suggests the next free SKU when a collision is found: appends `-2`, `-3`, ...
 * Deterministic given the set of taken SKUs.
 */
export function nextAvailableSku(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`.slice(0, MAX_SKU_LENGTH);
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  throw new AppError('RULE_VIOLATION', {
    message: 'تولید شناسهٔ یکتای کالا ممکن نشد؛ لطفاً شناسه را دستی وارد کنید.',
    messageKey: 'catalog.sku_exhausted',
    details: [{ rule: 'sku_exhausted' }],
  });
}
