/**
 * Minimal, dependency-free `.xlsx` reader/writer for the merge workbench.
 *
 * Why not `exceljs`/`xlsx`: neither package is installed anywhere in the
 * workspace (`package.json` of `@saman/api` has no spreadsheet library and the
 * store has no copy). Rather than adding a heavy dependency for two endpoints,
 * this file emits and reads the small subset of OOXML that Excel/LibreOffice
 * accept:
 *
 * - writer: an uncompressed (stored) ZIP container with the four required parts
 *   and inline strings — no shared-string table, no stylesheet beyond the
 *   mandatory one.
 * - reader: central-directory ZIP parsing (stored + deflate) and a tolerant
 *   `sheet1.xml` scanner that understands shared strings, inline strings and
 *   plain numbers.
 *
 * The merge import only needs two text columns, so the tolerance of a full
 * spreadsheet engine (formulas, dates, styles) is deliberately out of scope.
 */
import { inflateRawSync } from 'node:zlib';

/* ------------------------------------------------------------------ CRC32 -- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = ((CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* -------------------------------------------------------------------- ZIP -- */

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

const DOS_TIME = 0;
const DOS_DATE = 0x21; // 1980-01-01
const FLAG_UTF8 = 0x0800;

/** Builds a valid ZIP archive with every entry stored (method 0). */
function zipStore(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + entry.data.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

interface ZipReadEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly localOffset: number;
}

/** Reads the central directory (works for files produced by Excel and by us). */
function zipEntries(buffer: Buffer): ZipReadEntry[] {
  let eocd = -1;
  const stop = Math.max(0, buffer.length - 0xffff - 22);
  for (let index = buffer.length - 22; index >= stop; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) return [];

  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries: ZipReadEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    entries.push({ name, method, compressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function zipRead(buffer: Buffer, entry: ZipReadEntry): Buffer {
  const header = entry.localOffset;
  if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== 0x04034b50) return Buffer.alloc(0);
  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) {
    try {
      return inflateRawSync(data);
    } catch {
      return Buffer.alloc(0);
    }
  }
  return Buffer.alloc(0);
}

/* ------------------------------------------------------------------- XML -- */

function escapeXml(value: string): string {
  return (
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // XML 1.0 forbids most control characters outright; replace them with spaces.
      .replace(/\p{Cc}/gu, ' ')
  );
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** `A` → 0, `AB` → 27. Unknown references fall back to 0. */
function columnIndex(reference: string): number {
  let index = 0;
  for (const char of reference) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index > 0 ? index - 1 : 0;
}

function columnLetter(index: number): string {
  let value = index + 1;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

/* ---------------------------------------------------------------- writer -- */

export interface XlsxColumn {
  readonly header: string;
  readonly width?: number;
}

export interface XlsxSheet {
  readonly name: string;
  readonly columns: readonly XlsxColumn[];
  readonly rows: readonly (readonly (string | number | null)[])[];
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function sheetXml(sheet: XlsxSheet): string {
  const rows: string[] = [];
  const headerCells = sheet.columns
    .map(
      (column, index) =>
        `<c r="${columnLetter(index)}1" t="inlineStr"><is><t>${escapeXml(column.header)}</t></is></c>`,
    )
    .join('');
  rows.push(`<row r="1">${headerCells}</row>`);

  sheet.rows.forEach((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const cells = row
      .map((value, columnIndexInRow) => {
        if (value === null) return '';
        const reference = `${columnLetter(columnIndexInRow)}${rowNumber}`;
        if (typeof value === 'number' && Number.isFinite(value)) {
          return `<c r="${reference}"><v>${value}</v></c>`;
        }
        return `<c r="${reference}" t="inlineStr"><is><t>${escapeXml(String(value))}</t></is></c>`;
      })
      .join('');
    rows.push(`<row r="${rowNumber}">${cells}</row>`);
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

/** Serializes a single-sheet workbook to `.xlsx` bytes. */
export function buildXlsx(sheet: XlsxSheet): Buffer {
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheet.name.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  return zipStore([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(WORKBOOK_RELS, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml(sheet), 'utf8') },
  ]);
}

/* ---------------------------------------------------------------- reader -- */

function sharedStrings(xml: string): string[] {
  const values: string[] = [];
  const itemPattern = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match: RegExpExecArray | null;
  while ((match = itemPattern.exec(xml)) !== null) {
    const body = match[1] ?? '';
    const textPattern = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let text = '';
    let piece: RegExpExecArray | null;
    while ((piece = textPattern.exec(body)) !== null) {
      text += decodeXml(piece[1] ?? '');
    }
    values.push(text);
  }
  return values;
}

function cellValue(attributes: string, body: string, strings: readonly string[]): string {
  const type = /\bt="([^"]+)"/.exec(attributes)?.[1];
  if (type === 'inlineStr') {
    const textPattern = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let text = '';
    let piece: RegExpExecArray | null;
    while ((piece = textPattern.exec(body)) !== null) {
      text += decodeXml(piece[1] ?? '');
    }
    return text;
  }
  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
  if (raw === undefined) return '';
  if (type === 's') {
    const index = Number.parseInt(raw, 10);
    return Number.isFinite(index) ? (strings[index] ?? '') : '';
  }
  return decodeXml(raw);
}

/**
 * Returns the rows of the first worksheet as plain strings, preserving column
 * positions (empty cells become `''`). Unreadable or non-xlsx input → `[]` so
 * the caller can report a single validation error.
 */
export function readXlsxRows(buffer: Buffer): string[][] {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) return [];
  const entries = zipEntries(buffer);
  if (entries.length === 0) return [];

  const stringsEntry = entries.find((entry) => entry.name === 'xl/sharedStrings.xml');
  const strings =
    stringsEntry === undefined ? [] : sharedStrings(zipRead(buffer, stringsEntry).toString('utf8'));

  const sheetEntry =
    entries.find((entry) => entry.name === 'xl/worksheets/sheet1.xml') ??
    entries.find((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name));
  if (sheetEntry === undefined) return [];

  const xml = zipRead(buffer, sheetEntry).toString('utf8');
  const rows: string[][] = [];
  const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowPattern.exec(xml)) !== null) {
    const body = rowMatch[1] ?? '';
    const cells: string[] = [];
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellPattern.exec(body)) !== null) {
      const attributes = cellMatch[1] ?? '';
      const reference = /\br="([A-Z]+)\d+"/.exec(attributes)?.[1];
      const index = reference === undefined ? cells.length : columnIndex(reference);
      while (cells.length < index) cells.push('');
      cells[index] = cellValue(attributes, cellMatch[2] ?? '', strings);
    }
    rows.push(cells);
  }

  return rows;
}
