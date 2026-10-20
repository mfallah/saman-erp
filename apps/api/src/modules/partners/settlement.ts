/**
 * Channel settlement arithmetic (`R1-accounting` B-03/M-12, `DATA-MODEL §2.14`).
 *
 * `net_payable = gross − commission − fee − returns − tax`. Confirmation compares
 * the document against its own order/fee lines, records a variance when outside
 * tolerance, and **never** creates revenue — revenue was recognised at invoice.
 */
import { AppError } from '@saman/shared';

export interface SettlementAmounts {
  readonly grossSalesAmount: bigint;
  readonly commissionAmount: bigint;
  readonly feeAmount: bigint;
  readonly returnAmount: bigint;
  readonly taxAmount: bigint;
  readonly netPayableAmount: bigint;
}

export type SettlementLineType = 'sale' | 'commission' | 'fee' | 'return' | 'shipping' | 'penalty' | 'tax' | 'adjustment';

export interface SettlementLine {
  readonly lineType: SettlementLineType;
  /** Signed amount in the settlement's own convention (sales positive). */
  readonly amount: bigint;
}

export function expectedNetPayable(amounts: Omit<SettlementAmounts, 'netPayableAmount'>): bigint {
  return amounts.grossSalesAmount - amounts.commissionAmount - amounts.feeAmount - amounts.returnAmount - amounts.taxAmount;
}

/** Validates the stored net against the formula. */
export function assertSettlementNet(amounts: SettlementAmounts): void {
  const expected = expectedNetPayable(amounts);
  if (expected !== amounts.netPayableAmount) {
    throw new AppError('RULE_VIOLATION', {
      details: [
        {
          rule: 'settlement_net_mismatch',
          params: {
            expected: expected.toString(),
            actual: amounts.netPayableAmount.toString(),
          },
        },
      ],
      message: 'مبلغ خالص قابل پرداخت تسویه با فرمول تسویه برابر نیست.',
    });
  }
}

export interface SettlementReconciliation {
  readonly netDifference: bigint;
  readonly grossDifference: bigint;
  readonly withinTolerance: boolean;
  readonly varianceAmount: bigint;
}

/**
 * Reconciles the settlement header against its lines and compares the document
 * net to the line-derived net. `tolerance` defaults to zero (exact settlement).
 */
export function reconcileSettlement(
  amounts: SettlementAmounts,
  lines: readonly SettlementLine[],
  tolerance = 0n,
): SettlementReconciliation {
  assertSettlementNet(amounts);
  const lineGross = lines
    .filter((line) => line.lineType === 'sale')
    .reduce((total, line) => total + line.amount, 0n);
  const lineCommission = lines
    .filter((line) => line.lineType === 'commission')
    .reduce((total, line) => total + line.amount, 0n);
  const lineFees = lines
    .filter((line) => line.lineType === 'fee' || line.lineType === 'shipping' || line.lineType === 'penalty')
    .reduce((total, line) => total + line.amount, 0n);
  const lineReturns = lines
    .filter((line) => line.lineType === 'return')
    .reduce((total, line) => total + line.amount, 0n);
  const lineTax = lines
    .filter((line) => line.lineType === 'tax')
    .reduce((total, line) => total + line.amount, 0n);

  const lineNet = lineGross - lineCommission - lineFees - lineReturns - lineTax;
  const netDifference = amounts.netPayableAmount - lineNet;
  const grossDifference = amounts.grossSalesAmount - lineGross;
  const varianceAmount = netDifference;
  const withinTolerance =
    (netDifference <= tolerance && netDifference >= -tolerance) &&
    (grossDifference <= tolerance && grossDifference >= -tolerance);
  return { netDifference, grossDifference, withinTolerance, varianceAmount };
}

/**
 * The settlement posting must never credit a sales-revenue account. This helper
 * is used by the service as a defensive assertion over the accounting draft.
 */
export function assertNoRevenueReRecognition(accountCodes: readonly string[]): void {
  const revenue = accountCodes.find((code) => code.startsWith('4-1-01'));
  if (revenue !== undefined) {
    throw new AppError('RULE_VIOLATION', {
      details: [{ rule: 'settlement_must_not_recognise_revenue', params: { accountCode: revenue } }],
      message: 'در سند تسویه کانال نباید درآمد فروش مجدداً شناسایی شود.',
    });
  }
}
