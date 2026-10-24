/**
 * Printable label layout (`DATA-MODEL` §2.4, `ADR-0007` §5).
 *
 * Two pure renderers live here — one label and one A4 sheet of labels — plus the
 * deterministic internal-barcode rule. Everything is built as an SVG **string**:
 * no DOM, no external asset and no `eval`, so the same code runs in the Nest API
 * and in a unit test. Every dynamic text value is XML-escaped and control
 * characters are stripped before it reaches the markup.
 */
import { AppError } from '@saman/shared';

import { gtinCheckDigit } from './barcode.engine';
import { encodeCode128 } from './code128.engine';

/** Supported internal barcode symbologies for the generate endpoint. */
export const LABEL_SYMBOLOGIES = ['code128', 'ean13'] as const;
export type LabelSymbology = (typeof LABEL_SYMBOLOGIES)[number];

/** GS1 in-store range used for organization-generated codes (`20`–`29`). */
const INTERNAL_PREFIX = '29';
const INTERNAL_DIGITS = 10;

/** What a single printed label needs to carry. */
export interface VariantLabel {
  readonly barcode: string;
  readonly sku: string;
  readonly productName: string;
  readonly serial?: string | null;
}

/** Active barcode rows as the label picker needs them. */
export interface LabelBarcodeSource {
  readonly barcode: string;
  readonly isPrimary: boolean;
  readonly isActive: boolean;
}

const LABEL_WIDTH = 320;
const LABEL_HEIGHT = 180;
const LABEL_PADDING = 10;
const BARCODE_TOP = 12;
const BARCODE_HEIGHT = 62;
/** Code 128 requires a ≥10-module quiet zone on both sides. */
const QUIET_MODULES = 10;
const MAX_TEXT_LENGTH = 42;

/** A4 geometry in millimetres: 3 columns × 7 rows per page. */
const SHEET = {
  pageWidthMm: 210,
  pageHeightMm: 297,
  labelWidthMm: 60,
  labelHeightMm: 33.75,
  marginMm: 10,
  gapMm: 3,
  columns: 3,
  rows: 7,
} as const;

export const LABELS_PER_PAGE = SHEET.columns * SHEET.rows;

/** Hard cap on a single sheet request (prevents an unbounded SVG response). */
export const MAX_LABELS_PER_SHEET = 210;

/**
 * Deterministic internal barcode for a variant: `29` + a 10-digit numeric token
 * derived from the variant's public id (or the id itself when numeric), with the
 * GS1 check digit appended for `ean13` (13 digits total).
 *
 * The same variant always maps to the same value, so calling generate twice —
 * including after a rollback — never invents a second code.
 */
export function deriveInternalBarcode(variantPublicId: string, symbology: LabelSymbology): string {
  const body = `${INTERNAL_PREFIX}${variantNumericToken(variantPublicId)}`;
  return symbology === 'ean13' ? `${body}${gtinCheckDigit(body)}` : body;
}

/** Picks the barcode a label should print: primary → any active → fallback → derived. */
export function selectLabelBarcode(
  barcodes: readonly LabelBarcodeSource[],
  variantId: string,
  variantBarcode?: string | null,
): string {
  const active = barcodes.filter((barcode) => barcode.isActive);
  const primary = active.find((barcode) => barcode.isPrimary) ?? active[0];
  if (primary !== undefined && primary.barcode.length > 0) {
    return primary.barcode;
  }
  if (variantBarcode !== undefined && variantBarcode !== null && variantBarcode.trim().length > 0) {
    return variantBarcode.trim();
  }
  return deriveInternalBarcode(variantId, 'code128');
}

/** Escapes XML text and drops characters XML 1.0 cannot represent. */
export function escapeXml(value: string): string {
  return stripXmlInvalidChars(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** XML 1.0 allows tab/LF/CR; every other C0 control and DEL is stripped. */
function stripXmlInvalidChars(value: string): string {
  let cleaned = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const allowedControl = code === 0x09 || code === 0x0a || code === 0x0d;
    if ((code < 0x20 && !allowedControl) || code === 0x7f) continue;
    cleaned += char;
  }
  return cleaned;
}

/** One label as an SVG document (`image/svg+xml`), barcode encoded as Code 128. */
export function renderLabelSvg(label: VariantLabel): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${LABEL_WIDTH}" height="${LABEL_HEIGHT}" viewBox="0 0 ${LABEL_WIDTH} ${LABEL_HEIGHT}" role="img" aria-label="${escapeXml(`label ${label.sku}`)}">`,
    renderLabelBody(label),
    '</svg>',
  ].join('\n');
}

/**
 * A4 label sheet: one `<svg>` per label nested in an outer page-coordinate SVG
 * that grows by one A4 page per `LABELS_PER_PAGE` labels. The sheet URL is what
 * the print modal embeds; page slicing happens in the print document.
 */
export function renderLabelSheetSvg(labels: readonly VariantLabel[]): string {
  if (labels.length === 0) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'labels', rule: 'label_sheet_empty' }],
    });
  }
  if (labels.length > MAX_LABELS_PER_SHEET) {
    throw new AppError('VALIDATION_ERROR', {
      details: [
        {
          field: 'labels',
          rule: 'label_sheet_too_large',
          params: { max: MAX_LABELS_PER_SHEET, requested: labels.length },
        },
      ],
    });
  }

  const pages = Math.ceil(labels.length / LABELS_PER_PAGE);
  const sheetHeightMm = SHEET.pageHeightMm * pages;
  const parts: string[] = [];
  for (const [index, label] of labels.entries()) {
    const page = Math.floor(index / LABELS_PER_PAGE);
    const slot = index % LABELS_PER_PAGE;
    const column = slot % SHEET.columns;
    const row = Math.floor(slot / SHEET.columns);
    const x = SHEET.marginMm + column * (SHEET.labelWidthMm + SHEET.gapMm);
    const y = page * SHEET.pageHeightMm + SHEET.marginMm + row * (SHEET.labelHeightMm + SHEET.gapMm);
    parts.push(
      `<svg x="${fmt(x)}" y="${fmt(y)}" width="${fmt(SHEET.labelWidthMm)}" height="${fmt(SHEET.labelHeightMm)}" viewBox="0 0 ${LABEL_WIDTH} ${LABEL_HEIGHT}" preserveAspectRatio="xMidYMid meet" overflow="hidden">`,
      renderLabelBody(label),
      '</svg>',
    );
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET.pageWidthMm}mm" height="${fmt(sheetHeightMm)}mm" viewBox="0 0 ${SHEET.pageWidthMm} ${fmt(sheetHeightMm)}">`,
    `<rect x="0" y="0" width="${SHEET.pageWidthMm}" height="${fmt(sheetHeightMm)}" fill="#ffffff" />`,
    ...parts,
    '</svg>',
  ].join('\n');
}

/** Label content in the 320×180 coordinate space shared by both renderers. */
function renderLabelBody(label: VariantLabel): string {
  const encoding = encodeCode128(label.barcode);
  const scale = (LABEL_WIDTH - LABEL_PADDING * 2) / (encoding.modules + QUIET_MODULES * 2);
  const bars = encoding.bars
    .map((bar) => {
      const x = LABEL_PADDING + (QUIET_MODULES + bar.x) * scale;
      return `<rect x="${fmt(x)}" y="${BARCODE_TOP}" width="${fmt(bar.width * scale)}" height="${BARCODE_HEIGHT}" />`;
    })
    .join('');
  const serial =
    label.serial === undefined || label.serial === null || label.serial.trim().length === 0
      ? null
      : label.serial.trim();

  return [
    `<rect x="0" y="0" width="${LABEL_WIDTH}" height="${LABEL_HEIGHT}" fill="#ffffff" stroke="#cbd5e1" stroke-width="1" />`,
    `<g fill="#0f172a">${bars}</g>`,
    `<text x="${LABEL_WIDTH / 2}" y="105" text-anchor="middle" font-family="'Segoe UI', Tahoma, sans-serif" font-size="17" font-weight="700" direction="ltr">${escapeXml(truncate(label.sku))}</text>`,
    `<text x="${LABEL_WIDTH / 2}" y="130" text-anchor="middle" font-family="'Vazirmatn', Tahoma, sans-serif" font-size="13" direction="rtl">${escapeXml(truncate(label.productName))}</text>`,
    serial === null
      ? ''
      : `<text x="${LABEL_WIDTH / 2}" y="151" text-anchor="middle" font-family="'Segoe UI', Tahoma, sans-serif" font-size="12" direction="ltr">${escapeXml(`SN: ${truncate(serial)}`)}</text>`,
    `<text x="${LABEL_WIDTH / 2}" y="170" text-anchor="middle" font-family="'Segoe UI', Tahoma, sans-serif" font-size="10" fill="#475569" direction="ltr">${escapeXml(truncate(label.barcode))}</text>`,
  ].join('');
}

/** Truncates by code point (never splits a surrogate pair) and marks the cut. */
function truncate(value: string, maxLength: number = MAX_TEXT_LENGTH): string {
  const normalized = value.trim();
  const chars = [...normalized];
  return chars.length <= maxLength ? normalized : `${chars.slice(0, maxLength - 1).join('')}…`;
}

/** 10-digit numeric token: the id itself when numeric, otherwise a stable 64-bit hash. */
function variantNumericToken(variantPublicId: string): string {
  const trimmed = variantPublicId.trim();
  if (/^\d+$/.test(trimmed)) {
    return trimmed.slice(-INTERNAL_DIGITS).padStart(INTERNAL_DIGITS, '0');
  }
  return stableDecimalHash(trimmed, INTERNAL_DIGITS);
}

/** FNV-1a (64-bit) folded into a zero-padded decimal string — deterministic and pure. */
function stableDecimalHash(value: string, digits: number): string {
  const offset = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let hash = offset;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  const modulo = 10n ** BigInt(digits);
  return (hash % modulo).toString().padStart(digits, '0');
}

/** Compact SVG number (two fractional digits, no trailing zeros). */
function fmt(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Math.round(value * 100) / 100);
}
