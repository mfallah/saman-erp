/**
 * Payment allocation rules (`R1-accounting` B-14): Σ allocations ≤ payment amount
 * and `allocated + unapplied = amount` at all times.
 */
import { AppError } from '@saman/shared';

export const ALLOCATION_DOCUMENT_TYPES = [
  'customer_invoice',
  'supplier_invoice',
  'refund',
  'expense',
  'journal_entry',
  'profit_distribution',
  'sales_order',
  'purchase_order',
  'customer_credit',
  'supplier_prepayment',
  'partner_capital',
] as const;
export type AllocationDocumentType = (typeof ALLOCATION_DOCUMENT_TYPES)[number];

export interface AllocationRequest {
  readonly documentType: AllocationDocumentType;
  readonly documentId: bigint;
  readonly amount: bigint;
}

export interface AllocationState {
  readonly paymentAmount: bigint;
  readonly allocations: readonly { readonly documentType: string; readonly documentId: bigint; readonly amount: bigint }[];
}

export function allocatedTotal(state: AllocationState): bigint {
  return state.allocations.reduce((total, allocation) => total + allocation.amount, 0n);
}

export function unappliedAmount(state: AllocationState): bigint {
  return state.paymentAmount - allocatedTotal(state);
}

/**
 * Validates a new allocation (or a batch) against the payment amount. The same
 * document may be allocated once; a second allocation must be summed by callers
 * or will be rejected as a duplicate.
 */
export function assertAllocationsWithinPayment(
  state: AllocationState,
  requested: readonly AllocationRequest[],
): void {
  if (requested.length === 0) return;
  for (const allocation of requested) {
    if (allocation.amount <= 0n) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'amount', rule: 'positive', params: { documentId: allocation.documentId.toString() } }],
        message: 'مبلغ تخصیص باید بزرگ‌تر از صفر باشد.',
      });
    }
    if (!ALLOCATION_DOCUMENT_TYPES.includes(allocation.documentType)) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'documentType', rule: 'unsupported', params: { value: allocation.documentType } }],
        message: 'نوع سند تخصیص پشتیبانی نمی‌شود.',
      });
    }
    const duplicate = state.allocations.find(
      (existing) =>
        existing.documentType === allocation.documentType && existing.documentId === allocation.documentId,
    );
    if (duplicate !== undefined) {
      throw new AppError('CONFLICT', {
        details: [{ rule: 'allocation_duplicate', params: { documentId: allocation.documentId.toString() } }],
        message: 'این سند قبلاً به پرداخت تخصیص داده شده است.',
      });
    }
  }

  const requestedTotal = requested.reduce((total, allocation) => total + allocation.amount, 0n);
  const available = unappliedAmount(state);
  if (requestedTotal > available) {
    throw new AppError('RULE_VIOLATION', {
      details: [
        {
          rule: 'allocation_exceeds_amount',
          params: {
            requested: requestedTotal.toString(),
            available: available.toString(),
            paymentAmount: state.paymentAmount.toString(),
          },
        },
      ],
      message: 'جمع تخصیص‌ها از مبلغ پرداخت بیشتر است.',
    });
  }

  const afterTotal = allocatedTotal(state) + requestedTotal;
  if (afterTotal + (state.paymentAmount - afterTotal) !== state.paymentAmount) {
    throw new AppError('RULE_VIOLATION', { details: [{ rule: 'allocation_invariant' }] });
  }
}

/** Splits an advance into the amount applied to documents and the remainder. */
export function applyAllocations(
  state: AllocationState,
  requested: readonly AllocationRequest[],
): { readonly allocations: readonly AllocationRequest[]; readonly unapplied: bigint } {
  assertAllocationsWithinPayment(state, requested);
  const allocations = [...state.allocations, ...requested];
  return { allocations: requested, unapplied: state.paymentAmount - allocatedTotal({ ...state, allocations }) };
}
