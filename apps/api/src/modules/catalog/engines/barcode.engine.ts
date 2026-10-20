/**
 * Barcode identity & validation (`ADR-0007` §5, `DATA-MODEL` §2.4
 * `catalog.product_barcodes`).
 *
 * **Identity scope:** a manufacturer barcode (GTIN/EAN/UPC) identifies a
 * *variant* — the sellable/stockable SKU — **not** a physical unit. Two physical
 * phones of the same variant share one barcode; unit-level identity comes from
 * `inventory.inventory_units.inventory_code`. Validation must therefore never
 * treat a barcode as a serial number.
 */
import { AppError } from '@saman/shared';

export const BARCODE_TYPES = ['ean13', 'ean8', 'upc', 'code128', 'code39', 'qr', 'internal'] as const;
export type BarcodeType = (typeof BARCODE_TYPES)[number];

export const BARCODE_SOURCES = ['manufacturer', 'internal', 'channel', 'supplier'] as const;
export type BarcodeSource = (typeof BARCODE_SOURCES)[number];

/** Identity scope of a barcode: always the variant, never a physical unit. */
export const BARCODE_IDENTITY_SCOPE = 'variant' as const;
export type BarcodeIdentityScope = typeof BARCODE_IDENTITY_SCOPE;

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Folds Persian/Arabic-Indic digits to ASCII and strips separators/spaces. */
export function normalizeBarcode(raw: string): string {
  const folded = [...raw.trim()]
    .map((char) => {
      const fa = PERSIAN_DIGITS.indexOf(char);
      if (fa >= 0) return String(fa);
      const ar = ARABIC_DIGITS.indexOf(char);
      if (ar >= 0) return String(ar);
      return char;
    })
    .join('');
  return folded.replace(/[\s-]+/g, '');
}

/** GS1 modulo-10 check digit for the supplied data digits. */
export function gtinCheckDigit(dataDigits: string): number {
  if (!/^\d+$/.test(dataDigits)) {
    throw new RangeError('gtin_data_must_be_digits');
  }
  let sum = 0;
  let weight = 3;
  for (let index = dataDigits.length - 1; index >= 0; index -= 1) {
    sum += Number(dataDigits[index]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  const remainder = sum % 10;
  return remainder === 0 ? 0 : 10 - remainder;
}

export function isValidGtin(value: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(value)) {
    return false;
  }
  const check = Number(value[value.length - 1]);
  return gtinCheckDigit(value.slice(0, -1)) === check;
}

/** Infers the barcode type from the digit length; only unambiguous cases map. */
export function identifyBarcodeType(value: string): BarcodeType | null {
  const normalized = normalizeBarcode(value);
  if (/^\d{13}$/.test(normalized)) return 'ean13';
  if (/^\d{12}$/.test(normalized)) return 'upc';
  if (/^\d{8}$/.test(normalized)) return 'ean8';
  return null;
}

export interface BarcodeValidation {
  readonly normalized: string;
  readonly type: BarcodeType;
  readonly checksumValid: boolean;
}

const NUMERIC_LENGTHS: Readonly<Record<string, number>> = {
  ean13: 13,
  ean8: 8,
  upc: 12,
};

/**
 * Validates a barcode value against its declared type.
 *
 * - numeric symbologies (`ean13`/`ean8`/`upc`) must have the exact length and a
 *   valid GS1 check digit;
 * - `code128`/`code39`/`qr` accept 4–50 printable ASCII characters;
 * - `internal` accepts 4–50 alphanumerics (organization-generated codes).
 *
 * Throws `VALIDATION_ERROR` with a machine-readable `rule` for the caller.
 */
export function validateBarcodeValue(rawValue: string, declaredType: BarcodeType): BarcodeValidation {
  const normalized = normalizeBarcode(rawValue);
  if (normalized.length < 4 || normalized.length > 50) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'barcode', rule: 'barcode_length_invalid' }],
    });
  }

  const expectedLength = NUMERIC_LENGTHS[declaredType];
  if (expectedLength !== undefined) {
    if (!/^\d+$/.test(normalized) || normalized.length !== expectedLength) {
      throw new AppError('VALIDATION_ERROR', {
        details: [
          {
            field: 'barcode',
            rule: 'barcode_length_invalid',
            params: { type: declaredType, expectedLength },
          },
        ],
      });
    }
    const checksumValid = isValidGtin(normalized);
    if (!checksumValid) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'barcode', rule: 'barcode_checksum_invalid' }],
      });
    }
    return { normalized, type: declaredType, checksumValid };
  }

  if (declaredType === 'code128' || declaredType === 'code39' || declaredType === 'qr') {
    if (!/^[\x20-\x7E]+$/.test(normalized)) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'barcode', rule: 'barcode_charset_invalid' }],
      });
    }
    return { normalized, type: declaredType, checksumValid: true };
  }

  // internal
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'barcode', rule: 'barcode_charset_invalid' }],
    });
  }
  return { normalized, type: declaredType, checksumValid: true };
}

/**
 * A scan is resolved to a variant. When the caller declares a type, the value
 * must validate for that type; otherwise the type is inferred and checked.
 */
export function resolveScannedBarcode(rawValue: string, declaredType?: BarcodeType): BarcodeValidation {
  if (declaredType !== undefined) {
    return validateBarcodeValue(rawValue, declaredType);
  }
  const normalized = normalizeBarcode(rawValue);
  const inferred = identifyBarcodeType(normalized);
  if (inferred !== null) {
    return validateBarcodeValue(normalized, inferred);
  }
  return validateBarcodeValue(normalized, 'internal');
}

/**
 * Only one **primary** barcode is allowed per variant; changing it must clear
 * the previous primary in the same transaction (enforced by the repository).
 */
export function assertPrimaryUniqueness(
  variantBarcodes: readonly { barcode: string; isPrimary: boolean }[],
): void {
  const primaries = variantBarcodes.filter((barcode) => barcode.isPrimary);
  if (primaries.length > 1) {
    throw new AppError('RULE_VIOLATION', {
      message: 'برای هر تنوع کالا فقط یک بارکد اصلی مجاز است.',
      messageKey: 'catalog.primary_barcode_conflict',
      details: [{ rule: 'primary_barcode_conflict' }],
    });
  }
}
