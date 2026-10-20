/** Profit distribution policy: reserve cap, withholding, largest remainder, loss. */
import { describe, expect, it } from 'vitest';
import { assertOwnershipTotals, computeDistribution } from '../profit-distribution';

const policy = {
  legalReservePercent: '0.05',
  legalReserveCapPercent: '0.10',
  registeredCapital: 1_000_000_000n,
};

const shares = [
  { shareholderId: 1n, ownershipPercent: '0.5' },
  { shareholderId: 2n, ownershipPercent: '0.3' },
  { shareholderId: 3n, ownershipPercent: '0.2' },
];

describe('profit distribution', () => {
  it('splits the distributable profit by largest remainder so the sum is exact', () => {
    const result = computeDistribution({ distributableProfit: 1_000_000n, shares, policy });
    const total = result.lines.reduce((sum, line) => sum + line.shareAmount, 0n);
    expect(total).toBe(result.dividendsTotal);
    expect(result.legalReserve).toBe(50_000n);
    expect(result.dividendsTotal).toBe(950_000n);
    expect(result.lines.map((line) => line.shareAmount)).toEqual([475_000n, 285_000n, 190_000n]);
  });

  it('distributes an odd amount without losing a rial', () => {
    const odd = [
      { shareholderId: 1n, ownershipPercent: '0.333333' },
      { shareholderId: 2n, ownershipPercent: '0.333333' },
      { shareholderId: 3n, ownershipPercent: '0.333334' },
    ];
    const result = computeDistribution({ distributableProfit: 100n, shares: odd, policy });
    expect(result.dividendsTotal).toBe(95n);
    expect(result.lines.reduce((sum, line) => sum + line.shareAmount, 0n)).toBe(95n);
  });

  it('appropriates the legal reserve and withholds tax before splitting', () => {
    const result = computeDistribution({
      distributableProfit: 10_000_000n,
      shares,
      policy: { ...policy, withholdingPercent: '0.05' },
    });
    expect(result.legalReserve).toBe(500_000n);
    expect(result.withholdingTotal).toBe(475_000n);
    expect(result.dividendsTotal).toBe(9_025_000n);
    expect(
      result.lines.reduce((sum, line) => sum + line.shareAmount + line.withholdingAmount, 0n),
    ).toBe(result.distributableProfit - result.legalReserve);
  });

  it('caps the reserve at 10% of registered capital', () => {
    const result = computeDistribution({
      distributableProfit: 100_000_000n,
      shares,
      policy: { ...policy, registeredCapital: 10_000_000n, existingLegalReserve: 900_000n },
    });
    expect(result.legalReserve).toBe(100_000n);
  });

  it('handles a loss year by allocating loss shares and no dividends', () => {
    const result = computeDistribution({ distributableProfit: -300_000n, shares, policy });
    expect(result.loss).toBe(true);
    expect(result.dividendsTotal).toBe(0n);
    expect(result.lines.reduce((sum, line) => sum + line.shareAmount, 0n)).toBe(-300_000n);
    expect(result.lines.every((line) => line.withholdingAmount === 0n)).toBe(true);
  });

  it('rejects ownership that does not total 100%', () => {
    expect(() =>
      assertOwnershipTotals([
        { shareholderId: 1n, ownershipPercent: '0.5' },
        { shareholderId: 2n, ownershipPercent: '0.4' },
      ]),
    ).toThrow();
    expect(() => assertOwnershipTotals([])).toThrow();
  });
});
