/**
 * Exact Iranian 6-level chart-of-accounts manifest (`DATA-MODEL §6.3`).
 *
 * Inheritance rules (also applied by the seed generator):
 * - `account_type` from the L1 group (`1=asset 2=liability 3=equity 4=income 5=expense`);
 * - `normal_balance` from the L2 group, overridden by the contra table and by the
 *   explicit L3 rows;
 * - `nature='operational'` unless the row is contra;
 * - `is_postable=true` for every L4 row (L5/L6 rows are materialised lazily).
 *
 * The counts below are the counts of the manifest **rows that actually exist**.
 * They intentionally differ from the prose summary in `DATA-MODEL §6.3`
 * (`5/10/59/85/8/6 = 173`): the published L3 table lists 60 rows and the L4 fence
 * lists 94 rows, so the truthful manifest is 5/10/60/94/8/6 = 183 rows.
 */
import { COA_L3, COA_L4 } from './coa-levels.generated';

export { COA_L3, COA_L4 } from './coa-levels.generated';
import type { CoaLevel3Row, CoaLevel4Row } from './coa-levels.generated';
import { ACCOUNTS } from '../posting/accounts';

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type NormalBalance = 'debit' | 'credit';
export type AccountNature = 'operational' | 'contra' | 'suspense' | 'control';

export interface CoaRow {
  readonly code: string;
  readonly nameFa: string;
  readonly accountLevel: number;
  readonly parentCode: string | null;
  readonly accountType: AccountType;
  readonly normalBalance: NormalBalance;
  readonly nature: AccountNature;
  readonly isPostable: boolean;
  readonly currency: 'IRR';
}

export interface CoaGroupRow {
  readonly code: string;
  readonly nameFa: string;
  readonly accountType: AccountType;
  readonly normalBalance: NormalBalance;
}

export const COA_L1: readonly CoaGroupRow[] = [
  { code: '1', nameFa: 'دارایی‌ها', accountType: 'asset', normalBalance: 'debit' },
  { code: '2', nameFa: 'بدهی‌ها', accountType: 'liability', normalBalance: 'credit' },
  { code: '3', nameFa: 'حقوق صاحبان سرمایه', accountType: 'equity', normalBalance: 'credit' },
  { code: '4', nameFa: 'درآمدها', accountType: 'income', normalBalance: 'credit' },
  { code: '5', nameFa: 'هزینه‌ها', accountType: 'expense', normalBalance: 'debit' },
];

export const COA_L2: readonly CoaGroupRow[] = [
  { code: '1-1', nameFa: 'دارایی‌های جاری', accountType: 'asset', normalBalance: 'debit' },
  { code: '1-2', nameFa: 'دارایی‌های غیرجاری', accountType: 'asset', normalBalance: 'debit' },
  { code: '2-1', nameFa: 'بدهی‌های جاری', accountType: 'liability', normalBalance: 'credit' },
  { code: '2-2', nameFa: 'بدهی‌های بلندمدت', accountType: 'liability', normalBalance: 'credit' },
  { code: '3-1', nameFa: 'سرمایه', accountType: 'equity', normalBalance: 'credit' },
  { code: '3-2', nameFa: 'سود و اندوخته', accountType: 'equity', normalBalance: 'credit' },
  { code: '4-1', nameFa: 'درآمد عملیاتی', accountType: 'income', normalBalance: 'credit' },
  { code: '4-2', nameFa: 'سایر درآمدها', accountType: 'income', normalBalance: 'credit' },
  { code: '5-1', nameFa: 'بهای تمام‌شده کالای فروش‌رفته و ضایعات', accountType: 'expense', normalBalance: 'debit' },
  { code: '5-2', nameFa: 'هزینه‌های عملیاتی', accountType: 'expense', normalBalance: 'debit' },
];

export interface ContraOverride {
  readonly code: string;
  readonly normalBalance: NormalBalance;
  readonly nature: AccountNature;
  readonly reason: string;
}

/** Explicit contra rows (`B-04`): their normal side is opposite their group. */
export const CONTRA_OVERRIDES: readonly ContraOverride[] = [
  { code: '1-2-02', normalBalance: 'credit', nature: 'contra', reason: 'contra-asset' },
  { code: '3-1-02', normalBalance: 'debit', nature: 'contra', reason: 'contra-equity' },
  { code: '4-1-02', normalBalance: 'debit', nature: 'contra', reason: 'contra-revenue' },
  { code: '4-1-03', normalBalance: 'debit', nature: 'contra', reason: 'contra-revenue' },
  { code: '1-1-03-003', normalBalance: 'credit', nature: 'contra', reason: 'contra-asset' },
  { code: '2-1-08-001', normalBalance: 'credit', nature: 'operational', reason: 'normal liability (listed for explicitness)' },
  { code: '1-1-09', normalBalance: 'debit', nature: 'operational', reason: 'clearing asset (normal)' },
  { code: '2-1-12', normalBalance: 'credit', nature: 'operational', reason: 'clearing liability (normal)' },
];

/** L5 cost-center templates (`account_level=5`, parent = the L4 they extend). */
export const COA_L5_TEMPLATES: readonly { code: string; nameFa: string }[] = [
  { code: '01', nameFa: 'انبار مرکزی' },
  { code: '02', nameFa: 'فروش' },
  { code: '03', nameFa: 'بازاریابی' },
  { code: '04', nameFa: 'مالی' },
  { code: '05', nameFa: 'اداری' },
  { code: '06', nameFa: 'فناوری اطلاعات' },
  { code: '07', nameFa: 'پشتیبانی مشتریان' },
  { code: '08', nameFa: 'عمومی' },
];

/** L6 project templates (`account_level=6`, parent = the L5 row, not L4). */
export const COA_L6_TEMPLATES: readonly { code: string; nameFa: string }[] = [
  { code: '001', nameFa: 'توسعه فروشگاه' },
  { code: '002', nameFa: 'راه‌اندازی انبار جدید' },
  { code: '003', nameFa: 'یکپارچه‌سازی کانال' },
  { code: '004', nameFa: 'پروژه حسابداری' },
  { code: '005', nameFa: 'بهبود فرایند' },
  { code: '006', nameFa: 'بدون پروژه' },
];

/** Truthful row counts of the manifest (asserted by `assertManifestIntegrity`). */
export const COA_MANIFEST_COUNTS = {
  l1: 5,
  l2: 10,
  l3: 60,
  l4: 94,
  l5Templates: 8,
  l6Templates: 6,
  total: 5 + 10 + 60 + 94 + 8 + 6,
} as const;

const CONTRA_BY_CODE = new Map(CONTRA_OVERRIDES.map((row) => [row.code, row]));
const L2_BY_CODE = new Map(COA_L2.map((row) => [row.code, row]));
const L3_BY_CODE = new Map(COA_L3.map((row) => [row.code, row]));

export function accountTypeOf(code: string): AccountType {
  const group = code.split('-')[0];
  switch (group) {
    case '1':
      return 'asset';
    case '2':
      return 'liability';
    case '3':
      return 'equity';
    case '4':
      return 'income';
    case '5':
      return 'expense';
    default:
      throw new Error(`invalid_account_code:${code}`);
  }
}

export function normalBalanceOfL2(code: string): NormalBalance {
  const groupCode = code.split('-')[0] ?? code;
  if (!code.includes('-')) {
    const group = COA_L1.find((row) => row.code === groupCode);
    if (group === undefined) throw new Error("unknown_l1_group:" + code);
    return group.normalBalance;
  }
  const group = code.split('-').slice(0, 2).join('-');
  const row = L2_BY_CODE.get(group);
  if (!row) throw new Error(`unknown_l2_group:${code}`);
  return row.normalBalance;
}

function l3ParentOfL4(code: string): string {
  return code.split('-').slice(0, 3).join('-');
}

function natureFor(code: string): AccountNature {
  const override = CONTRA_BY_CODE.get(code);
  if (override) return override.nature;
  if (L3_BY_CODE.has(code) && L3_BY_CODE.get(code)?.nature === 'contra') return 'contra';
  const l3Parent = code.split('-').length === 4 ? l3ParentOfL4(code) : null;
  if (l3Parent) {
    const parent = L3_BY_CODE.get(l3Parent);
    if (parent?.nature === 'contra') return 'contra';
  }
  return 'operational';
}

function normalBalanceFor(code: string): NormalBalance {
  const override = CONTRA_BY_CODE.get(code);
  if (override) return override.normalBalance;
  const l3 = L3_BY_CODE.get(code);
  if (l3) return l3.normalBalance;
  const l3Parent = code.split('-').length === 4 ? l3ParentOfL4(code) : null;
  if (l3Parent) {
    const parent = L3_BY_CODE.get(l3Parent);
    if (parent) return parent.normalBalance;
  }
  return normalBalanceOfL2(code);
}

function toRow(
  code: string,
  nameFa: string,
  accountLevel: number,
  parentCode: string | null,
): CoaRow {
  return {
    code,
    nameFa,
    accountLevel,
    parentCode,
    accountType: accountTypeOf(code),
    normalBalance: normalBalanceFor(code),
    nature: natureFor(code),
    isPostable: accountLevel >= 4,
    currency: 'IRR',
  };
}

/** Flat, ordered manifest (parents always precede children). */
export function buildCoaManifest(): readonly CoaRow[] {
  const rows: CoaRow[] = [];
  for (const row of COA_L1) rows.push(toRow(row.code, row.nameFa, 1, null));
  for (const row of COA_L2) rows.push(toRow(row.code, row.nameFa, 2, row.code.split('-')[0] ?? null));
  for (const row of COA_L3) rows.push(toRow(row.code, row.nameFa, 3, row.parent));
  for (const row of COA_L4) rows.push(toRow(row.code, row.nameFa, 4, row.parent));
  return rows;
}

/** Materialises an L5 cost-center account code (`<L4>-<cc>`). */
export function costCenterAccountCode(l4Code: string, costCenterCode: string): string {
  return `${l4Code}-${costCenterCode}`;
}

/** Materialises an L6 project account code (`<L5>-<project>`). */
export function projectAccountCode(l5Code: string, projectCode: string): string {
  return `${l5Code}-${projectCode}`;
}

export interface ManifestValidation {
  readonly rowCount: number;
  readonly postableCount: number;
  readonly contraCount: number;
}

/**
 * CI validator (`erp.validate_coa_seed()` equivalent): counts, uniqueness,
 * parent integrity, code depth and contra sign correctness.
 */
export function assertManifestIntegrity(): ManifestValidation {
  const rows = buildCoaManifest();
  const seen = new Set<string>();
  const byCode = new Map(rows.map((row) => [row.code, row]));
  let postableCount = 0;
  let contraCount = 0;

  for (const row of rows) {
    if (seen.has(row.code)) throw new Error(`duplicate_coa_code:${row.code}`);
    seen.add(row.code);

    const depth = row.code.split('-').length;
    if (depth !== row.accountLevel) {
      throw new Error(`coa_depth_mismatch:${row.code}`);
    }
    if (row.accountLevel > 1) {
      const parent = row.parentCode === null ? undefined : byCode.get(row.parentCode);
      if (!parent) throw new Error(`coa_missing_parent:${row.code}`);
      if (parent.accountLevel !== row.accountLevel - 1) {
        throw new Error(`coa_parent_level_mismatch:${row.code}`);
      }
      if (parent.accountType !== row.accountType) {
        throw new Error(`coa_type_mismatch:${row.code}`);
      }
    }
    if (row.isPostable) postableCount += 1;
    if (row.nature === 'contra') {
      contraCount += 1;
      const groupSide = COA_L1.find((group) => group.accountType === row.accountType)?.normalBalance;
      if (groupSide === row.normalBalance) {
        throw new Error(`contra_sign_not_opposite:${row.code}`);
      }
    }
  }

  const countLevel = (level: number): number => rows.filter((row) => row.accountLevel === level).length;
  if (countLevel(1) !== COA_MANIFEST_COUNTS.l1) throw new Error('coa_l1_count_mismatch');
  if (countLevel(2) !== COA_MANIFEST_COUNTS.l2) throw new Error('coa_l2_count_mismatch');
  if (countLevel(3) !== COA_MANIFEST_COUNTS.l3) throw new Error('coa_l3_count_mismatch');
  if (countLevel(4) !== COA_MANIFEST_COUNTS.l4) throw new Error('coa_l4_count_mismatch');

  return { rowCount: rows.length, postableCount, contraCount };
}

/** Every account code used by posting rules must exist and be postable. */
export function assertPostingAccountsPostable(): void {
  const rows = buildCoaManifest();
  const byCode = new Map(rows.map((row) => [row.code, row]));
  for (const [key, code] of Object.entries(ACCOUNTS)) {
    const row = byCode.get(code);
    if (!row) throw new Error(`posting_account_missing:${key}:${code}`);
    if (!row.isPostable) throw new Error(`posting_account_not_postable:${key}:${code}`);
  }
}

export type { CoaLevel3Row, CoaLevel4Row };
