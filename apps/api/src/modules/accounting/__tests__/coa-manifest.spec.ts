/** CoA manifest integrity, contra signs and posting-account postability (B-04/B-05). */
import { describe, expect, it } from 'vitest';
import {
  COA_L3,
  COA_L4,
  COA_L5_TEMPLATES,
  COA_L6_TEMPLATES,
  COA_MANIFEST_COUNTS,
  assertManifestIntegrity,
  assertPostingAccountsPostable,
  buildCoaManifest,
  costCenterAccountCode,
  projectAccountCode,
} from '../coa/coa-manifest';
import { ACCOUNTS } from '../posting/accounts';

describe('CoA manifest', () => {
  it('contains the documented rows and every count assertion passes', () => {
    const validation = assertManifestIntegrity();
    expect(validation.rowCount).toBe(5 + 10 + 60 + 94);
    expect(COA_MANIFEST_COUNTS.total).toBe(5 + 10 + 60 + 94 + 8 + 6);
    expect(validation.postableCount).toBe(94);
    expect(validation.contraCount).toBe(12); // 6 contra rows + their inherited L4 children
  });

  it('exposes the published L3/L4 row counts exactly once', () => {
    expect(COA_L3).toHaveLength(60);
    expect(COA_L4).toHaveLength(94);
    expect(COA_L5_TEMPLATES).toHaveLength(8);
    expect(COA_L6_TEMPLATES).toHaveLength(6);
  });

  it('marks every contra row with the opposite normal balance', () => {
    const rows = buildCoaManifest();
    const contraCodes = rows.filter((row) => row.nature === 'contra').map((row) => row.code);
    expect(contraCodes.sort()).toEqual(
      ['1-1-03-003', '1-2-02', '1-2-02-001', '1-2-02-002', '1-2-05', '1-2-05-001', '3-1-02', '3-1-02-001', '4-1-02', '4-1-02-001', '4-1-03', '4-1-03-001'].sort(),
    );
    for (const row of rows.filter((entry) => entry.nature === 'contra')) {
      const natural = row.accountType === 'asset' || row.accountType === 'expense' ? 'debit' : 'credit';
      expect(row.normalBalance, row.code).not.toBe(natural);
    }
  });

  it('keeps every non-L4 row non-postable and every L4 row postable', () => {
    for (const row of buildCoaManifest()) {
      expect(row.isPostable, row.code).toBe(row.accountLevel >= 4);
    }
  });

  it('resolves every posting-rule account to a seeded, postable account', () => {
    expect(() => assertPostingAccountsPostable()).not.toThrow();
    const rows = new Map(buildCoaManifest().map((row) => [row.code, row]));
    expect(rows.get(ACCOUNTS.grni)?.nameFa).toContain('GRNI');
    expect(rows.get(ACCOUNTS.allowanceDoubtful)?.normalBalance).toBe('credit');
    expect(rows.get(ACCOUNTS.retainedEarnings)?.accountType).toBe('equity');
  });

  it('materialises L5 and L6 template codes hierarchically', () => {
    expect(costCenterAccountCode('4-1-01-001', '02')).toBe('4-1-01-001-02');
    expect(projectAccountCode('4-1-01-001-02', '004')).toBe('4-1-01-001-02-004');
  });
});
