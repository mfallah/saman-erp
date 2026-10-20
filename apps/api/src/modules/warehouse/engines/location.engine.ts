/**
 * Warehouse location & slotting engine (`API.md` §4.5, `DATA-MODEL` §2.5).
 *
 * The physical hierarchy is fixed: `warehouse → zone → aisle → rack → shelf → bin
 * → location`. Location codes are human-scannable (`A-01-R1-1-01`). This module is
 * pure: code generation, tree validation, putaway suggestion scoring and pick
 * route ordering are unit-tested without a database.
 */
import { AppError } from '@saman/shared';

export const LOCATION_NODE_TYPES = ['zone', 'aisle', 'rack', 'shelf', 'bin', 'location'] as const;
export type LocationNodeType = (typeof LOCATION_NODE_TYPES)[number];

const CODE_PART = /^[A-Z0-9]{1,10}$/;
const FULL_CODE = /^[A-Z0-9]{1,10}(?:-[A-Z0-9]{1,10}){2,6}$/;

/** Expected parent node type for each level (root zone has no parent). */
const PARENT_TYPE: Readonly<Record<LocationNodeType, LocationNodeType | null>> = {
  zone: null,
  aisle: 'zone',
  rack: 'aisle',
  shelf: 'rack',
  bin: 'shelf',
  location: 'bin',
};

export function expectedParentType(nodeType: LocationNodeType): LocationNodeType | null {
  return PARENT_TYPE[nodeType];
}

/** Rejects a node created under a parent of the wrong hierarchy level. */
export function assertValidLocationParent(nodeType: LocationNodeType, parentType: LocationNodeType | null): void {
  const expected = expectedParentType(nodeType);
  if (expected === null) {
    if (parentType !== null) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'ناحیه (zone) نمی‌تواند والد داشته باشد.',
        messageKey: 'warehouse.zone_requires_root',
        details: [{ field: 'parentId', rule: 'zone_requires_root' }],
      });
    }
    return;
  }
  if (parentType !== expected) {
    throw new AppError('VALIDATION_ERROR', {
      message: 'سطح مکانی انتخاب‌شده با والد سازگار نیست.',
      messageKey: 'warehouse.location_parent_type_invalid',
      details: [{ field: 'parentId', rule: 'location_parent_type_invalid', params: { expected, actual: parentType ?? 'none' } }],
    });
  }
}

export interface LocationCodeParts {
  readonly zoneCode: string;
  readonly aisleCode: string;
  readonly rackCode: string;
  readonly shelfCode: string;
  readonly binCode: string;
}

/** Validates one code segment (`[A-Z0-9]{1,10}`). */
export function assertCodePart(value: string, field: string): string {
  const normalized = value.trim().toUpperCase();
  if (!CODE_PART.test(normalized)) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field, rule: 'invalid_location_code_part' }],
    });
  }
  return normalized;
}

/**
 * Generates the leaf location full code from its chain:
 * `{zone}-{aisle}-{rack}-{shelfLevel}-{bin}` → e.g. `A-01-R1-2-07`
 * (`DATA-MODEL` §2.5 sample codes use exactly this shape).
 */
export function generateLocationCode(parts: LocationCodeParts): string {
  const zone = assertCodePart(parts.zoneCode, 'zoneCode');
  const aisle = normalizeAisle(parts.aisleCode);
  const rack = assertCodePart(parts.rackCode, 'rackCode');
  const shelf = assertCodePart(parts.shelfCode, 'shelfCode');
  const bin = assertCodePart(parts.binCode, 'binCode');
  const code = `${zone}-${aisle}-${rack}-${shelf}-${bin}`;
  if (!FULL_CODE.test(code)) {
    throw new AppError('VALIDATION_ERROR', { details: [{ field: 'code', rule: 'invalid_location_code' }] });
  }
  return code;
}

function normalizeAisle(code: string): string {
  const trimmed = code.trim().toUpperCase();
  if (/^\d{1,2}$/.test(trimmed)) return `0${trimmed}`.slice(-2);
  return assertCodePart(trimmed, 'aisleCode');
}

export function isValidLocationCode(code: string): boolean {
  return FULL_CODE.test(code.toUpperCase());
}

/** Scanner barcode defaults to the full code but can be an independent value. */
export function normalizeLocationBarcode(value: string | null | undefined, fullCode: string): string {
  if (value === null || value === undefined || value.trim() === '') return fullCode;
  return value.trim().toUpperCase();
}

/** Location pick priority: lower number = picked earlier (route order). */
export function pickSequence(input: { pickPriority: number; fullCode: string }): string {
  return `${String(input.pickPriority).padStart(5, '0')}|${input.fullCode}`;
}

export interface PickTaskLike {
  readonly taskId: string;
  readonly locationFullCode: string;
  readonly pickPriority: number;
  readonly sequenceNo: number;
}

/** Orders pick tasks by location pick priority, then code, then line sequence. */
export function orderPickTasks<T extends PickTaskLike>(tasks: readonly T[]): T[] {
  return [...tasks].sort((left, right) => {
    if (left.pickPriority !== right.pickPriority) return left.pickPriority - right.pickPriority;
    if (left.locationFullCode !== right.locationFullCode) {
      return left.locationFullCode < right.locationFullCode ? -1 : 1;
    }
    return left.sequenceNo - right.sequenceNo;
  });
}

/** Assigns wave route step numbers after ordering (1-based). */
export function assignPickRoute<T extends PickTaskLike>(tasks: readonly T[]): (T & { routeStep: number })[] {
  return orderPickTasks(tasks).map((task, index) => ({ ...task, routeStep: index + 1 }));
}

// ------------------------------------------------------------ putaway engine

export const PUTAWAY_WEIGHTS = {
  abcMatch: 40,
  freeCapacity: 30,
  proximity: 20,
  pickFace: 10,
} as const;

export interface PutawayCandidate {
  readonly locationId: string;
  readonly fullCode: string;
  /** Zone ABC class (`A|B|C`) or null for non-storage zones. */
  readonly abcClass: string | null;
  /** Free capacity in the variant's base unit; null = unlimited. */
  readonly freeCapacity: string | null;
  /** Higher = closer to the receiving door / lower travel time (0–100). */
  readonly proximityScore: number;
  readonly isPickFace: boolean;
  /** Existing quantity of the same variant already in this bin (consolidation). */
  readonly sameVariantQuantity?: string | undefined;
  readonly allowed?: boolean | undefined;
  readonly ruleReason?: string | undefined;
}

export interface PutawaySuggestion {
  readonly locationId: string;
  readonly fullCode: string;
  readonly score: number;
  readonly reason: string;
}

/**
 * Scores candidate bins for a receipt line:
 * **ABC match (40) + free capacity (30) + proximity (20) + pick-face (10)**, then
 * prefers consolidating with existing stock of the same variant. Disallowed bins
 * are excluded; a bin without enough free capacity is excluded when the quantity
 * is known. Deterministic tie-break on location id.
 */
export function suggestPutaway(
  input: {
    readonly variantAbcClass: string | null;
    readonly quantity: string;
  },
  candidates: readonly PutawayCandidate[],
): PutawaySuggestion[] {
  const requested = Number(input.quantity);
  const suggestions: PutawaySuggestion[] = [];
  for (const candidate of candidates) {
    if (candidate.allowed === false) continue;
    if (candidate.freeCapacity !== null) {
      const free = Number(candidate.freeCapacity);
      if (Number.isFinite(requested) && requested > free) continue;
    }
    let score = 0;
    const reasons: string[] = [];
    if (input.variantAbcClass !== null && candidate.abcClass === input.variantAbcClass) {
      score += PUTAWAY_WEIGHTS.abcMatch;
      reasons.push('abc_match');
    }
    if (candidate.freeCapacity !== null) {
      const free = Math.max(0, Math.min(100, Number(candidate.freeCapacity)));
      score += Math.round((free / 100) * PUTAWAY_WEIGHTS.freeCapacity);
      reasons.push('free_capacity');
    } else {
      score += PUTAWAY_WEIGHTS.freeCapacity;
      reasons.push('unlimited_capacity');
    }
    score += Math.round((Math.max(0, Math.min(100, candidate.proximityScore)) / 100) * PUTAWAY_WEIGHTS.proximity);
    if (candidate.isPickFace) {
      score += PUTAWAY_WEIGHTS.pickFace;
      reasons.push('pick_face');
    }
    if (candidate.sameVariantQuantity !== undefined && Number(candidate.sameVariantQuantity) > 0) {
      reasons.push('consolidate');
    }
    suggestions.push({
      locationId: candidate.locationId,
      fullCode: candidate.fullCode,
      score,
      reason: reasons.join('+'),
    });
  }
  return suggestions.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.fullCode < right.fullCode ? -1 : left.fullCode > right.fullCode ? 1 : 0;
  });
}

// --------------------------------------------------------- scan verification

export type ScanRejectionRule =
  | 'wrong_product'
  | 'wrong_location'
  | 'wrong_quantity'
  | 'task_not_started'
  | 'task_completed';

export interface ScanVerificationInput {
  readonly taskStatus: 'pending' | 'in_progress' | 'picked' | 'short' | 'exception' | 'cancelled';
  /** Scanned location barcode (putaway/pick). */
  readonly scannedLocationCode?: string | null;
  readonly expectedLocationCode: string;
  readonly scannedBarcode: string;
  readonly expectedBarcode: string;
  readonly scannedQuantity: string;
  readonly remainingQuantity: string;
  /** `null`/`undefined` = unknown barcode (wrong product). */
  readonly resolvedVariantId: string | null;
  readonly expectedVariantId: string;
}

export interface ScanVerificationResult {
  readonly accepted: boolean;
  readonly rule?: ScanRejectionRule;
  readonly messageFa?: string;
}

/**
 * Two-stage scan verification: **location first, then product barcode, then
 * quantity**. Rejecting with a specific rule is what lets the scanner UI lock the
 * workflow (`API.md` §4.5: `wrong_location`, `wrong_product`, `wrong_quantity`).
 */
export function verifyScan(input: ScanVerificationInput): ScanVerificationResult {
  if (input.taskStatus === 'pending') {
    return { accepted: false, rule: 'task_not_started', messageFa: 'ابتدا تسک را شروع کنید.' };
  }
  if (input.taskStatus === 'picked' || input.taskStatus === 'cancelled') {
    return { accepted: false, rule: 'task_completed', messageFa: 'این تسک دیگر قابل اسکن نیست.' };
  }
  if (
    input.scannedLocationCode !== null &&
    input.scannedLocationCode !== undefined &&
    normalizeCode(input.scannedLocationCode) !== normalizeCode(input.expectedLocationCode)
  ) {
    return {
      accepted: false,
      rule: 'wrong_location',
      messageFa: 'بارکد مکان اسکن‌شده با مکان مورد انتظار یکسان نیست.',
    };
  }
  if (input.resolvedVariantId === null || input.resolvedVariantId !== input.expectedVariantId) {
    return {
      accepted: false,
      rule: 'wrong_product',
      messageFa: 'کالای اسکن‌شده با کالای مورد انتظار یکسان نیست.',
    };
  }
  if (normalizeCode(input.scannedBarcode) === '') {
    return { accepted: false, rule: 'wrong_product', messageFa: 'بارکد نامعتبر است.' };
  }
  const scanned = Number(input.scannedQuantity);
  const remaining = Number(input.remainingQuantity);
  if (!Number.isFinite(scanned) || scanned <= 0) {
    return { accepted: false, rule: 'wrong_quantity', messageFa: 'مقدار اسکن‌شده معتبر نیست.' };
  }
  if (Number.isFinite(remaining) && scanned > remaining) {
    return {
      accepted: false,
      rule: 'wrong_quantity',
      messageFa: 'مقدار اسکن‌شده بیش از مقدار باقی‌ماندهٔ تسک است.',
    };
  }
  return { accepted: true };
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

/** Pack-stage verification (order → product → package) used by packing tasks. */
export function verifyPackingStage(input: {
  stage: 'order' | 'product' | 'package';
  scannedCode: string;
  expectedOrderBarcode: string;
  expectedVariantBarcode?: string | null;
  scannedChannelMatches?: boolean;
}): ScanVerificationResult {
  if (input.stage === 'order') {
    if (normalizeCode(input.scannedCode) !== normalizeCode(input.expectedOrderBarcode)) {
      return { accepted: false, rule: 'wrong_product', messageFa: 'بارکد سفارش با سفارش مورد انتظار یکسان نیست.' };
    }
    return { accepted: true };
  }
  if (input.stage === 'product') {
    if (input.expectedVariantBarcode === null || input.expectedVariantBarcode === undefined) {
      return { accepted: false, rule: 'wrong_product', messageFa: 'کالای مورد انتظار مشخص نیست.' };
    }
    if (normalizeCode(input.scannedCode) !== normalizeCode(input.expectedVariantBarcode)) {
      return { accepted: false, rule: 'wrong_product', messageFa: 'کالای اسکن‌شده با کالای سفارش یکسان نیست.' };
    }
    if (input.scannedChannelMatches === false) {
      return { accepted: false, rule: 'wrong_product', messageFa: 'کانال سفارش با بسته‌بندی همخوانی ندارد.' };
    }
    return { accepted: true };
  }
  return normalizeCode(input.scannedCode).length > 0
    ? { accepted: true }
    : { accepted: false, rule: 'wrong_quantity', messageFa: 'بارکد بسته معتبر نیست.' };
}

/** Package/label label number: deterministic per shipment/package counter. */
export function labelNumber(prefix: string, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError('invalid_label_sequence');
  }
  return `${prefix.toUpperCase()}-${String(sequence).padStart(6, '0')}`;
}
