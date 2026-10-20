/**
 * Profit distribution policy (`R1-accounting` H-09/B-08): only after the year is
 * closed, legal reserve capped at 10% of capital, withholding by shareholder
 * type, and a largest-remainder split so Σ shares equals the distributable
 * amount exactly. A loss year allocates loss shares instead of dividends.
 */
import { AppError, applyRate, splitProportionally } from '@saman/shared';

export interface OwnershipShare {
  readonly shareholderId: bigint;
  /** Fraction of ownership (`0.400000` = 40%). */
  readonly ownershipPercent: string;
}

export interface DistributionPolicy {
  readonly legalReservePercent: string;
  readonly legalReserveCapPercent: string;
  readonly registeredCapital: bigint;
  readonly existingLegalReserve?: bigint;
  /** Withholding on dividends, e.g. `0` or `0.05`. */
  readonly withholdingPercent?: string;
}

export interface DistributionLine {
  readonly shareholderId: bigint;
  readonly ownershipPercent: string;
  /** Positive for a profit distribution, negative for a loss allocation. */
  readonly shareAmount: bigint;
  readonly withholdingAmount: bigint;
}

export interface DistributionComputation {
  readonly distributableProfit: bigint;
  readonly legalReserve: bigint;
  readonly withholdingTotal: bigint;
  readonly dividendsTotal: bigint;
  readonly loss: boolean;
  readonly lines: readonly DistributionLine[];
}

/** Basis points (10^-6) so percentages stay integers. */
function toScaled(percent: string): bigint {
  const value = percent.trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'ownershipPercent', rule: 'decimal_fraction' }],
      message: 'درصد مالکیت معتبر نیست.',
    });
  }
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

/** Ownership must total 100% (within one basis point of tolerance). */
export function assertOwnershipTotals(shares: readonly OwnershipShare[]): void {
  if (shares.length === 0) {
    throw new AppError('RULE_VIOLATION', {
      details: [{ rule: 'no_ownership_shares' }],
      message: 'برای توزیع سود، سهامدار فعال وجود ندارد.',
    });
  }
  let total = 0n;
  for (const share of shares) total += toScaled(share.ownershipPercent);
  const variance = total - 1_000_000n;
  if (variance > 1n || variance < -1n) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'ownershipPercent', rule: 'sum_must_equal_100', params: { total: (Number(total) / 1_000_000).toFixed(6) } }],
      message: 'جمع درصد مالکیت سهامداران باید دقیقاً ۱۰۰٪ باشد.',
    });
  }
}

/**
 * Computes the appropriation and the per-shareholder amounts.
 *
 * `distributableProfit` is the retained-earnings balance available after the
 * closing run (never a current-period estimate). For a loss year the loss is
 * allocated pro-rata and no dividend/withholding is produced.
 */
export function computeDistribution(input: {
  readonly distributableProfit: bigint;
  readonly shares: readonly OwnershipShare[];
  readonly policy: DistributionPolicy;
}): DistributionComputation {
  assertOwnershipTotals(input.shares);
  const profit = input.distributableProfit;

  if (profit <= 0n) {
    const weights = input.shares.map((share) => toScaled(share.ownershipPercent));
    const shares = splitProportionally(-profit, weights);
    return {
      distributableProfit: profit,
      legalReserve: 0n,
      withholdingTotal: 0n,
      dividendsTotal: 0n,
      loss: true,
      lines: input.shares.map((share, index) => ({
        shareholderId: share.shareholderId,
        ownershipPercent: share.ownershipPercent,
        shareAmount: -(shares[index] ?? 0n),
        withholdingAmount: 0n,
      })),
    };
  }

  const existingReserve = input.policy.existingLegalReserve ?? 0n;
  const reserveCap = applyRate(input.policy.registeredCapital, input.policy.legalReserveCapPercent);
  const reserveRoom = reserveCap - existingReserve;
  const candidateReserve = applyRate(profit, input.policy.legalReservePercent);
  const legalReserve = reserveRoom <= 0n ? 0n : candidateReserve < reserveRoom ? candidateReserve : reserveRoom;

  const withholdingPercent = input.policy.withholdingPercent ?? '0';
  const withholdingTotal = applyRate(profit - legalReserve, withholdingPercent);
  const dividendsTotal = profit - legalReserve - withholdingTotal;

  const weights = input.shares.map((share) => toScaled(share.ownershipPercent));
  const dividendShares = splitProportionally(dividendsTotal, weights);
  const withholdingShares = splitProportionally(withholdingTotal, weights);

  return {
    distributableProfit: profit,
    legalReserve,
    withholdingTotal,
    dividendsTotal,
    loss: false,
    lines: input.shares.map((share, index) => ({
      shareholderId: share.shareholderId,
      ownershipPercent: share.ownershipPercent,
      shareAmount: dividendShares[index] ?? 0n,
      withholdingAmount: withholdingShares[index] ?? 0n,
    })),
  };
}

/** Guard used by the service before creating a run. */
export function assertClosedYear(params: {
  readonly fiscalYearStatus: string;
  readonly closingRunStatus: string | undefined;
  readonly retainedBalance: bigint;
}): void {
  if (params.fiscalYearStatus !== 'closed') {
    throw new AppError('FISCAL_YEAR_CLOSED', {
      details: [{ rule: 'year_must_be_closed_before_distribution', params: { status: params.fiscalYearStatus } }],
      message: 'توزیع سود تنها پس از بستن سال مالی امکان‌پذیر است.',
    });
  }
  if (params.closingRunStatus !== 'posted') {
    throw new AppError('RULE_VIOLATION', {
      details: [{ rule: 'closing_run_required' }],
      message: 'اجرای بستن سال مالی باید ثبت شده باشد.',
    });
  }
  if (params.retainedBalance <= 0n) {
    throw new AppError('RULE_VIOLATION', {
      details: [{ rule: 'no_distributable_retained_earnings' }],
      message: 'سود انباشته قابل توزیع وجود ندارد.',
    });
  }
}
