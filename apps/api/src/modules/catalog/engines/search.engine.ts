/**
 * Persian-aware search normalization (`API.md` §1.6).
 *
 * Free-text search folds Arabic/Persian letter variants (`ي→ی`, `ك→ک`), removes
 * diacritics/tatweel, folds Persian and Arabic-Indic digits to ASCII, collapses
 * whitespace and lowercases Latin text. The same folding function is used to
 * normalize the query *and* to build the stored search columns at write time, so
 * a search always matches regardless of the keyboard layout the customer used.
 */
import { AppError } from '@saman/shared';

const LETTER_FOLD: Readonly<Record<string, string>> = {
  '\u064a': '\u06cc', // ي → ی
  '\u0649': '\u06cc', // ى → ی
  '\u0626': '\u06cc',
  '\u0643': '\u06a9', // ك → ک
  '\u0629': '\u0647', // ة → ه
  '\u06c0': '\u0647', // ۀ → ه
  '\u0623': '\u0627',
  '\u0625': '\u0627',
  '\u0622': '\u0627',
  '\u0624': '\u0648',
};

const DIACRITICS = /[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]/g;
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export const MIN_SEARCH_LENGTH = 2;
export const MAX_SEARCH_LENGTH = 100;

/** Folds digits, letters, diacritics and whitespace for matching. */
export function foldPersian(input: string): string {
  const folded = [...input]
    .map((char) => {
      const fa = PERSIAN_DIGITS.indexOf(char);
      if (fa >= 0) return String(fa);
      const ar = ARABIC_DIGITS.indexOf(char);
      if (ar >= 0) return String(ar);
      return LETTER_FOLD[char] ?? char;
    })
    .join('');
  return folded
    .replace(DIACRITICS, '')
    .replace(/\u200c/g, ' ') // zero-width non-joiner → space
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Normalizes an *optional* query; `undefined`/empty stays undefined. */
export function normalizeSearchQuery(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const folded = foldPersian(raw);
  if (folded.length === 0) return undefined;
  if (folded.length < MIN_SEARCH_LENGTH || folded.length > MAX_SEARCH_LENGTH) {
    throw new AppError('VALIDATION_ERROR', {
      details: [
        {
          field: 'q',
          rule: 'invalid_search_length',
          params: { min: MIN_SEARCH_LENGTH, max: MAX_SEARCH_LENGTH },
        },
      ],
    });
  }
  return folded;
}

/** ILIKE pattern for a folded term (`%term%`, escaped for LIKE metacharacters). */
export function toIlikePattern(foldedTerm: string): string {
  const escaped = foldedTerm.replace(/[\\%_]/g, (match) => `\\${match}`);
  return `%${escaped}%`;
}

/** Builds a digit/letter folded key for a SKU or barcode lookup. */
export function foldCode(raw: string): string {
  return foldPersian(raw).replace(/\s+/g, '');
}

/** Tokenizes a query into normalized search words (max 8). */
export function searchTokens(raw: string | undefined | null): string[] {
  const folded = normalizeSearchQuery(raw);
  if (folded === undefined) return [];
  return folded.split(' ').filter((token) => token.length > 0).slice(0, 8);
}

/**
 * Rankings are computed server-side: an exact code match wins, then a
 * prefix match, then a contains match; ties fall back to `-createdAt`.
 */
export function relevanceRank(input: {
  term: string;
  sku?: string | null;
  barcode?: string | null;
  name?: string | null;
}): number {
  const term = foldCode(input.term);
  const sku = input.sku === null || input.sku === undefined ? '' : foldCode(input.sku);
  const barcode = input.barcode === null || input.barcode === undefined ? '' : foldCode(input.barcode);
  const name = input.name === null || input.name === undefined ? '' : foldPersian(input.name);
  if (sku === term || barcode === term) return 0;
  if (sku.startsWith(term) || barcode.startsWith(term)) return 1;
  if (name.startsWith(term)) return 2;
  if (name.includes(term)) return 3;
  return 4;
}
