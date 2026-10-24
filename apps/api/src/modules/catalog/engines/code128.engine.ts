/**
 * Minimal pure-TypeScript **Code 128** encoder (`ADR-0007` §5, label printing).
 *
 * No dependency, no canvas: the encoder returns the bar runs in *module* units so
 * an SVG renderer can lay them out at any physical size. Code Set B covers the
 * printable ASCII range used by every barcode in this system (internal numeric
 * codes, GTINs and alphanumeric manufacturer codes), and the check symbol uses
 * the standard modulo-103 rule with `START B = 104` and `STOP = 106`.
 *
 * Reference: ISO/IEC 15417. Each symbol is 11 modules wide (the stop symbol is
 * 13) and every pattern is a run-length string starting with a bar.
 */
import { AppError } from '@saman/shared';

const START_B = 104;
const STOP = 106;
const CHECK_MODULUS = 103;

/** Longest value a single label can carry; matches `product_barcodes.barcode`. */
export const CODE128_MAX_LENGTH = 50;

/**
 * Run-length patterns of symbol values 0…106 (11 modules each; value 106 is the
 * 13-module stop pattern). Widths alternate bar/space, starting with a bar.
 */
const PATTERNS: readonly string[] = [
  '212222',
  '222122',
  '222221',
  '121223',
  '121322',
  '131222',
  '122213',
  '122312',
  '132212',
  '221213',
  '221312',
  '231212',
  '112232',
  '122132',
  '122231',
  '113222',
  '123122',
  '123221',
  '223211',
  '221132',
  '221231',
  '213212',
  '223112',
  '312131',
  '311222',
  '321122',
  '321221',
  '312212',
  '322112',
  '322211',
  '212123',
  '212321',
  '232121',
  '111323',
  '131123',
  '131321',
  '112313',
  '132113',
  '132311',
  '211313',
  '231113',
  '231311',
  '112133',
  '112331',
  '132131',
  '113123',
  '113321',
  '133121',
  '313121',
  '211331',
  '231131',
  '213113',
  '213311',
  '213131',
  '311123',
  '311321',
  '331121',
  '312113',
  '312311',
  '332111',
  '314111',
  '221411',
  '431111',
  '111224',
  '111422',
  '121124',
  '121421',
  '141122',
  '141221',
  '112214',
  '112412',
  '122114',
  '122411',
  '142112',
  '142211',
  '241211',
  '221114',
  '413111',
  '241112',
  '134111',
  '111242',
  '121142',
  '121241',
  '114212',
  '124112',
  '124211',
  '411212',
  '421112',
  '421211',
  '212141',
  '214121',
  '412121',
  '111143',
  '111341',
  '131141',
  '114113',
  '114311',
  '411113',
  '411311',
  '113141',
  '114131',
  '311141',
  '411131',
  '211412',
  '211214',
  '211232',
  '2331112',
];

/** One bar in module units: `[x, x + width)` across the symbol sequence. */
export interface Code128Bar {
  readonly x: number;
  readonly width: number;
}

export interface Code128Encoding {
  /** Normalized value that was encoded. */
  readonly value: string;
  /** Total width of all symbols in modules (no quiet zone). */
  readonly modules: number;
  readonly bars: readonly Code128Bar[];
  /** Encoded check symbol value (for debugging/tests). */
  readonly checkSymbol: number;
}

/**
 * Encodes `rawValue` in Code Set B.
 *
 * Throws `VALIDATION_ERROR` when the value is empty, longer than
 * `CODE128_MAX_LENGTH` or contains characters outside printable ASCII — a barcode
 * that cannot be encoded must fail loudly instead of printing a label that will
 * not scan.
 */
export function encodeCode128(rawValue: string): Code128Encoding {
  const value = rawValue.trim();
  if (value.length === 0) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'barcode', rule: 'code128_value_required' }],
    });
  }
  if (value.length > CODE128_MAX_LENGTH) {
    throw new AppError('VALIDATION_ERROR', {
      details: [
        {
          field: 'barcode',
          rule: 'code128_value_too_long',
          params: { maxLength: CODE128_MAX_LENGTH },
        },
      ],
    });
  }

  const dataValues: number[] = [];
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint > 0x7e) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'barcode', rule: 'code128_charset_invalid' }],
      });
    }
    dataValues.push(codePoint - 0x20);
  }

  const checkSymbol = code128CheckSymbol(dataValues);
  const symbols: number[] = [START_B, ...dataValues, checkSymbol, STOP];

  let modules = 0;
  const bars: Code128Bar[] = [];
  for (const symbol of symbols) {
    const pattern = PATTERNS[symbol];
    if (pattern === undefined) {
      throw new RangeError(`code128_symbol_out_of_range:${symbol}`);
    }
    for (let index = 0; index < pattern.length; index += 1) {
      const digit = pattern[index];
      if (digit === undefined) {
        throw new RangeError('code128_pattern_truncated');
      }
      const width = Number(digit);
      if (index % 2 === 0) {
        bars.push({ x: modules, width });
      }
      modules += width;
    }
  }

  return { value, modules, bars, checkSymbol };
}

/** Modulo-103 check symbol over the data values (start symbol weighted 1). */
export function code128CheckSymbol(dataValues: readonly number[]): number {
  let sum = START_B;
  for (let index = 0; index < dataValues.length; index += 1) {
    const value = dataValues[index];
    if (value === undefined) {
      throw new RangeError('code128_data_value_missing');
    }
    sum += value * (index + 1);
  }
  return sum % CHECK_MODULUS;
}
