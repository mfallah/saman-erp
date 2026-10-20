/**
 * Catalog domain-unit tests (`vitest`). The engine layer is pure, so these run
 * without Nest or PostgreSQL (test pyramid unit tier, `ARCHITECTURE.md` §15).
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '@saman/shared';

import {
  BARCODE_IDENTITY_SCOPE,
  gtinCheckDigit,
  identifyBarcodeType,
  isValidGtin,
  normalizeBarcode,
  resolveScannedBarcode,
  validateBarcodeValue,
} from '../engines/barcode.engine';
import { generateSku, isValidSku, nextAvailableSku, normalizeSku, stableToken } from '../engines/sku.engine';
import {
  ancestorIds,
  assertValidReparent,
  buildCategoryPath,
  buildCategoryTree,
  isDescendantPath,
  levelFromPath,
  reparentPath,
  subtreePattern,
} from '../engines/category-tree.engine';
import { foldPersian, normalizeSearchQuery, relevanceRank, toIlikePattern } from '../engines/search.engine';
import { assertAttributeValues, validateAttributeValues, type AttributeDefinition } from '../engines/attribute.engine';
import {
  assertReciprocalPair,
  convertQuantity,
  reciprocalFactor,
  resolveConversionFactor,
  toBaseQuantity,
} from '../engines/unit-conversion.engine';

describe('sku engine', () => {
  it('generates a deterministic, normalized sku', () => {
    const first = generateSku({ categoryCode: 'mob', nameEn: 'iPhone 15 Pro', sequence: 12 });
    const second = generateSku({ categoryCode: 'mob', nameEn: 'iPhone 15 Pro', sequence: 12 });
    expect(first).toBe(second);
    expect(first).toBe('MOB-IPHONE-15-PRO-000012');
    expect(isValidSku(first)).toBe(true);
  });

  it('transliterates persian-only names into a stable token', () => {
    const sku = generateSku({ categoryCode: 'کالا', nameFa: 'گوشی موبایل', sequence: 1 });
    expect(sku.startsWith('KALA-')).toBe(true);
    expect(sku).toContain('000001');
  });

  it('uses the stable hash when no latin token can be derived', () => {
    const sku = generateSku({ nameFa: '', sequence: 3 });
    expect(sku).toContain(stableToken(''));
    expect(isValidSku(sku)).toBe(true);
  });

  it('normalizes and rejects invalid skus', () => {
    expect(normalizeSku('  ab_12  ')).toBe('AB-12');
    expect(() => normalizeSku('')).toThrow(AppError);
    expect(() => normalizeSku('-x-')).toThrow(AppError);
  });

  it('suggests the next free sku on collision', () => {
    const taken = new Set(['A-1', 'A-1-2']);
    expect(nextAvailableSku('A-1', taken)).toBe('A-1-3');
    expect(nextAvailableSku('B-1', taken)).toBe('B-1');
  });
});

describe('barcode engine', () => {
  it('computes GS1 check digits', () => {
    expect(gtinCheckDigit('400638133393')).toBe(1);
    expect(isValidGtin('4006381333931')).toBe(true);
    expect(isValidGtin('4006381333932')).toBe(false);
  });

  it('validates gtin lengths and checksums with a typed error', () => {
    const ok = validateBarcodeValue('4006381333931', 'ean13');
    expect(ok.normalized).toBe('4006381333931');
    expect(ok.checksumValid).toBe(true);
    expect(() => validateBarcodeValue('4006381333932', 'ean13')).toThrow(AppError);
    expect(() => validateBarcodeValue('123456', 'ean13')).toThrow(AppError);
  });

  it('folds persian digits and infers numeric symbologies', () => {
    expect(normalizeBarcode('۴۰۰۶۳۸۱۳۳۳۹۳۱')).toBe('4006381333931');
    expect(identifyBarcodeType('4006381333931')).toBe('ean13');
    expect(identifyBarcodeType('12345678')).toBe('ean8');
    expect(identifyBarcodeType('ABC-123')).toBeNull();
  });

  it('resolves a scan to a variant-scoped identity, never a unit identity', () => {
    expect(BARCODE_IDENTITY_SCOPE).toBe('variant');
    const resolved = resolveScannedBarcode('4006381333931');
    expect(resolved.type).toBe('ean13');
    const internal = resolveScannedBarcode('INT-0001');
    expect(internal.type).toBe('internal');
  });

  it('rejects invalid internal and charset values', () => {
    expect(() => validateBarcodeValue('ab', 'internal')).toThrow(AppError);
    expect(() => validateBarcodeValue('bad code!!', 'internal')).toThrow(AppError);
  });
});

describe('category tree engine', () => {
  it('builds paths and levels', () => {
    expect(buildCategoryPath(null, 14)).toBe('/14/');
    expect(buildCategoryPath('/1/14/', 93)).toBe('/1/14/93/');
    expect(levelFromPath('/1/14/93/')).toBe(3);
    expect(ancestorIds('/1/14/93/', 93)).toEqual([1n, 14n]);
  });

  it('detects descendant paths and subtree patterns', () => {
    expect(isDescendantPath('/1/14/93/', '/1/14/')).toBe(true);
    expect(isDescendantPath('/1/15/', '/1/14/')).toBe(false);
    expect(subtreePattern('/1/14/')).toBe('/1/14%');
  });

  it('rejects cycles and self-parenting on move', () => {
    expect(() =>
      assertValidReparent({
        categoryId: 14n,
        categoryPath: '/1/14/',
        newParentId: 93n,
        newParentPath: '/1/14/93/',
      }),
    ).toThrow(AppError);
    expect(() =>
      assertValidReparent({
        categoryId: 14n,
        categoryPath: '/1/14/',
        newParentId: 14n,
        newParentPath: '/1/14/',
      }),
    ).toThrow(AppError);
  });

  it('rewrites a moved subtree path', () => {
    expect(reparentPath('/1/14/93/', '/1/14/', '/7/14/')).toBe('/7/14/93/');
    expect(() => reparentPath('/2/9/', '/1/14/', '/7/14/')).toThrow(RangeError);
  });

  it('flattens adjacency rows into a sorted tree', () => {
    const tree = buildCategoryTree([
      { id: 1n, parentId: null, code: 'B', name: 'B', level: 1, sortOrder: 2, isActive: true },
      { id: 2n, parentId: null, code: 'A', name: 'A', level: 1, sortOrder: 1, isActive: true },
      { id: 3n, parentId: 2n, code: 'A1', name: 'A1', level: 2, sortOrder: 1, isActive: true },
    ]);
    expect(tree.map((node) => node.code)).toEqual(['A', 'B']);
    expect(tree[0]?.children.map((child) => child.code)).toEqual(['A1']);
  });
});

describe('search engine', () => {
  it('folds arabic letters and persian digits', () => {
    expect(foldPersian('كتاب ۱۲۳')).toBe('کتاب 123');
    expect(foldPersian('  علي  ')).toBe('علی');
    expect(foldPersian('مـدیـریت')).toBe('مدیریت');
  });

  it('validates query length and builds ILIKE patterns', () => {
    expect(() => normalizeSearchQuery('a')).toThrow(AppError);
    expect(normalizeSearchQuery(' ab ')).toBe('ab');
    expect(normalizeSearchQuery(undefined)).toBeUndefined();
    expect(toIlikePattern('50%_off')).toBe('%50\\%\\_off%');
  });

  it('ranks exact codes before name matches', () => {
    expect(relevanceRank({ term: 'SKU-1', sku: 'SKU-1', name: 'Something' })).toBe(0);
    expect(relevanceRank({ term: 'sku', sku: 'SKU-1', name: 'Something' })).toBe(1);
    expect(relevanceRank({ term: 'some', sku: 'SKU-1', name: 'Something' })).toBe(2);
    expect(relevanceRank({ term: 'thing', sku: 'SKU-1', name: 'Something' })).toBe(3);
  });
});

describe('attribute engine', () => {
  const definitions: AttributeDefinition[] = [
    { id: 'color', code: 'color', dataType: 'enum', isRequired: true, isVariantAxis: true, values: [{ id: 'red', value: 'قرمز' }] },
    { id: 'size', code: 'size', dataType: 'enum', isRequired: true, isVariantAxis: true, values: [{ id: 'l', value: 'بزرگ' }] },
    { id: 'weight', code: 'weight', dataType: 'number', isRequired: false, isVariantAxis: false },
    { id: 'active', code: 'active', dataType: 'boolean', isRequired: false, isVariantAxis: false },
  ];

  it('normalizes valid values and computes the axis signature', () => {
    const result = validateAttributeValues(definitions, [
      { attributeId: 'color', valueId: 'red' },
      { attributeId: 'size', valueId: 'l' },
      { attributeId: 'weight', rawValue: '12.5' },
    ]);
    expect(result.issues).toEqual([]);
    expect(result.axisSignature).toBe('color=red|size=l');
  });

  it('reports required, unknown and invalid typed values', () => {
    const result = validateAttributeValues(definitions, [
      { attributeId: 'color', valueId: 'red' },
      { attributeId: 'nope', rawValue: 'x' },
      { attributeId: 'weight', rawValue: 'heavy' },
      { attributeId: 'active', rawValue: 'yes' },
    ]);
    const rules = result.issues.map((issue) => issue.rule);
    expect(rules).toContain('unknown_attribute');
    expect(rules).toContain('invalid_number');
    expect(rules).toContain('invalid_boolean');
    expect(rules).toContain('required_attribute_missing');
  });

  it('throws a validation error carrying details via the assert wrapper', () => {
    expect(() => assertAttributeValues(definitions, [])).toThrow(AppError);
  });
});

describe('unit conversion engine', () => {
  it('computes reciprocal factors and validates pairs', () => {
    expect(reciprocalFactor('12')).toBe('0.083333333333');
    expect(() => assertReciprocalPair('12', '0.083333333333')).not.toThrow();
    expect(() => assertReciprocalPair('12', '0.5')).toThrow(AppError);
  });

  it('converts quantities with rounding at the target precision', () => {
    expect(convertQuantity('2', '12', 0)).toBe('24');
    expect(convertQuantity('1.5', '12', 0)).toBe('18');
    expect(toBaseQuantity('0.5', '12', 4)).toBe('6.0000');
    expect(convertQuantity('1', '0.083333', 4)).toBe('0.0833');
  });

  it('resolves direct and two-hop conversion paths', () => {
    const edges = [
      { fromUnitId: 'carton', toUnitId: 'pack', factor: '12' },
      { fromUnitId: 'pack', toUnitId: 'pcs', factor: '6' },
    ];
    expect(resolveConversionFactor(edges, 'carton', 'pack')).toBe('12');
    expect(resolveConversionFactor(edges, 'carton', 'pcs')).toBe('72');
    expect(resolveConversionFactor(edges, 'pcs', 'carton')).toBeNull();
  });
});
