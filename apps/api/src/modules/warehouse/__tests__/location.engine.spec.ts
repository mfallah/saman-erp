/**
 * Warehouse engine tests: location code generation, hierarchy validation,
 * putaway scoring, pick-route ordering and two-stage scan verification.
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '@saman/shared';

import {
  assignPickRoute,
  assertValidLocationParent,
  expectedParentType,
  generateLocationCode,
  isValidLocationCode,
  labelNumber,
  normalizeLocationBarcode,
  orderPickTasks,
  suggestPutaway,
  verifyPackingStage,
  verifyScan,
  type PickTaskLike,
  type PutawayCandidate,
} from '../engines/location.engine';

describe('location codes & hierarchy', () => {
  it('generates the documented A-01-R1-1-01 shape', () => {
    expect(
      generateLocationCode({ zoneCode: 'A', aisleCode: '1', rackCode: 'R1', shelfCode: '1', binCode: '01' }),
    ).toBe('A-01-R1-1-01');
    expect(isValidLocationCode('A-01-R1-1-01')).toBe(true);
    expect(isValidLocationCode('A-01')).toBe(false);
  });

  it('rejects invalid code parts', () => {
    expect(() =>
      generateLocationCode({ zoneCode: 'A!', aisleCode: '1', rackCode: 'R1', shelfCode: '1', binCode: '01' }),
    ).toThrow(AppError);
  });

  it('enforces the fixed hierarchy parent types', () => {
    expect(expectedParentType('zone')).toBeNull();
    expect(expectedParentType('aisle')).toBe('zone');
    expect(expectedParentType('location')).toBe('bin');
    expect(() => assertValidLocationParent('zone', null)).not.toThrow();
    expect(() => assertValidLocationParent('aisle', 'zone')).not.toThrow();
    expect(() => assertValidLocationParent('aisle', 'rack')).toThrow(AppError);
    expect(() => assertValidLocationParent('zone', 'bin')).toThrow(AppError);
  });

  it('normalizes the scanner barcode', () => {
    expect(normalizeLocationBarcode(null, 'A-01-R1-1-01')).toBe('A-01-R1-1-01');
    expect(normalizeLocationBarcode(' bc-a1 ', 'A-01-R1-1-01')).toBe('BC-A1');
  });
});

describe('putaway suggestion engine', () => {
  const candidates: PutawayCandidate[] = [
    { locationId: '1', fullCode: 'A-01-R1-1-01', abcClass: 'A', freeCapacity: '50', proximityScore: 90, isPickFace: true, allowed: true },
    { locationId: '2', fullCode: 'B-01-R1-1-01', abcClass: 'B', freeCapacity: '90', proximityScore: 50, isPickFace: true, allowed: true },
    { locationId: '3', fullCode: 'C-01-R1-1-01', abcClass: 'C', freeCapacity: '0', proximityScore: 10, isPickFace: false, allowed: true },
    { locationId: '4', fullCode: 'C-01-R2-1-01', abcClass: 'C', freeCapacity: '100', proximityScore: 100, isPickFace: true, allowed: false },
  ];

  it('scores ABC match, capacity, proximity and pick-face; excludes disallowed/overflow bins', () => {
    const suggestions = suggestPutaway({ variantAbcClass: 'A', quantity: '10' }, candidates);
    expect(suggestions.map((suggestion) => suggestion.locationId)).toEqual(['1', '2']);
    expect(suggestions[0]?.reason).toContain('abc_match');
    expect(suggestions.some((suggestion) => suggestion.locationId === '4')).toBe(false);
  });

  it('returns an empty list when no bin can hold the quantity', () => {
    expect(suggestPutaway({ variantAbcClass: 'A', quantity: '1000' }, candidates)).toEqual([]);
  });
});

describe('pick route ordering', () => {
  const tasks: PickTaskLike[] = [
    { taskId: 't1', locationFullCode: 'C-01-R1-1-01', pickPriority: 30, sequenceNo: 1 },
    { taskId: 't2', locationFullCode: 'A-02-R1-1-01', pickPriority: 10, sequenceNo: 2 },
    { taskId: 't3', locationFullCode: 'A-01-R1-1-01', pickPriority: 10, sequenceNo: 3 },
  ];

  it('orders by pick priority then location code', () => {
    expect(orderPickTasks(tasks).map((task) => task.taskId)).toEqual(['t3', 't2', 't1']);
  });

  it('assigns sequential route steps', () => {
    expect(assignPickRoute(tasks).map((task) => task.routeStep)).toEqual([1, 2, 3]);
  });

  it('produces deterministic label numbers', () => {
    expect(labelNumber('lbl', 7)).toBe('LBL-000007');
    expect(() => labelNumber('lbl', 0)).toThrow(RangeError);
  });
});

describe('scan verification (two-stage)', () => {
  const base = {
    taskStatus: 'in_progress' as const,
    scannedLocationCode: 'A-01-R1-1-01',
    expectedLocationCode: 'A-01-R1-1-01',
    scannedBarcode: '4006381333931',
    expectedBarcode: '4006381333931',
    scannedQuantity: '1',
    remainingQuantity: '2',
    resolvedVariantId: 'variant-1',
    expectedVariantId: 'variant-1',
  };

  it('accepts a fully matching scan', () => {
    expect(verifyScan(base).accepted).toBe(true);
  });

  it('rejects a wrong location first', () => {
    const result = verifyScan({ ...base, scannedLocationCode: 'B-01-R1-1-01' });
    expect(result.accepted).toBe(false);
    expect(result.rule).toBe('wrong_location');
  });

  it('rejects a wrong product with a specific rule', () => {
    const result = verifyScan({ ...base, resolvedVariantId: 'variant-2' });
    expect(result.rule).toBe('wrong_product');
    expect(verifyScan({ ...base, resolvedVariantId: null }).rule).toBe('wrong_product');
  });

  it('rejects over-picking and unstarted/complete tasks', () => {
    expect(verifyScan({ ...base, scannedQuantity: '5' }).rule).toBe('wrong_quantity');
    expect(verifyScan({ ...base, taskStatus: 'pending' }).rule).toBe('task_not_started');
    expect(verifyScan({ ...base, taskStatus: 'picked' }).rule).toBe('task_completed');
  });

  it('verifies packing stages order → product → package', () => {
    expect(
      verifyPackingStage({ stage: 'order', scannedCode: 'ORD-1', expectedOrderBarcode: 'ORD-1' }).accepted,
    ).toBe(true);
    expect(
      verifyPackingStage({ stage: 'order', scannedCode: 'ORD-2', expectedOrderBarcode: 'ORD-1' }).rule,
    ).toBe('wrong_product');
    expect(
      verifyPackingStage({
        stage: 'product',
        scannedCode: 'BC-1',
        expectedOrderBarcode: 'ORD-1',
        expectedVariantBarcode: 'BC-2',
      }).rule,
    ).toBe('wrong_product');
  });
});
