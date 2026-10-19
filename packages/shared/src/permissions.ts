/**
 * Permission-key registry and role templates (`API.md` §5, `ADR-0008`).
 *
 * The key list is generated from the API contract (see
 * `scripts/extract-permissions.mjs`) — never hand-typed. This module adds the
 * lookup helpers used by guards, seed code and the SPA menu builder, plus the
 * role templates of `API.md` §5.4 as seed convenience (roles are rows, not code).
 */
import {
  PERMISSION_KEYS,
  PERMISSION_REGISTRY_STATS,
  type PermissionKey,
} from './permissions.generated';

export { PERMISSION_KEYS, PERMISSION_REGISTRY_STATS };
export type { PermissionKey };

export type RoleName =
  | 'superadmin'
  | 'admin'
  | 'finance_manager'
  | 'accountant'
  | 'warehouse_manager'
  | 'warehouse_operator'
  | 'sales_agent'
  | 'viewer';

export const ROLE_NAMES = [
  'superadmin',
  'admin',
  'finance_manager',
  'accountant',
  'warehouse_manager',
  'warehouse_operator',
  'sales_agent',
  'viewer',
] as const satisfies readonly RoleName[];

export interface ParsedPermissionKey {
  /** Everything before the last dot (may itself contain dots). */
  readonly resource: string;
  /** Last dot segment. */
  readonly action: string;
}

export interface RoleTemplate {
  readonly name: RoleName;
  readonly descriptionFa: string;
  /** `is_system=true` roles are immutable in the database. */
  readonly isSystem: boolean;
  readonly permissions: readonly PermissionKey[];
}

export const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(PERMISSION_KEYS);

/** Total number of permission keys referenced by the v1 API. */
export const PERMISSION_COUNT = PERMISSION_KEYS.length;

/** Narrows an arbitrary string to a registered permission key. */
export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_KEY_SET.has(value);
}

/** Splits `accounting.journal.post` into `{ resource: 'accounting.journal', action: 'post' }`. */
export function parsePermissionKey(key: string): ParsedPermissionKey {
  const dot = key.lastIndexOf('.');
  if (dot <= 0 || dot === key.length - 1) {
    throw new RangeError(`invalid_permission_key:${JSON.stringify(key)}`);
  }
  return { resource: key.slice(0, dot), action: key.slice(dot + 1) };
}

/** Returns true when the key family (resource part) matches any prefix. */
function resourceStartsWith(key: PermissionKey, prefix: string): boolean {
  return key === prefix || key.startsWith(`${prefix}.`);
}

function keyResource(key: PermissionKey): string {
  return parsePermissionKey(key).resource;
}

function keyAction(key: PermissionKey): string {
  return parsePermissionKey(key).action;
}

function select(predicate: (key: PermissionKey) => boolean): PermissionKey[] {
  return PERMISSION_KEYS.filter(predicate);
}

function byFamily(...prefixes: readonly string[]): PermissionKey[] {
  return select((key) => prefixes.some((prefix) => resourceStartsWith(key, prefix)));
}

function byResource(...resources: readonly string[]): PermissionKey[] {
  return select((key) => resources.includes(keyResource(key)));
}

function byAction(...actions: readonly string[]): PermissionKey[] {
  return select((key) => actions.includes(keyAction(key)));
}

function unique(keys: readonly PermissionKey[]): PermissionKey[] {
  return [...new Set(keys)];
}

const ALL_KEYS: readonly PermissionKey[] = PERMISSION_KEYS;

const ADMIN_EXCLUDED: ReadonlySet<PermissionKey> = new Set([
  'identity.break_glass.use',
  'system.backup.run',
  ...byFamily('api_client'),
]);

const ACCOUNTANT_ACTIONS = new Set(['read', 'create', 'post', 'export', 'issue', 'run']);

const TREASURY_READ_RESOURCES = [
  'bank.account',
  'bank.statement',
  'cash',
  'cash.session',
  'cash.transaction',
  'cheque',
  'payment',
  'payment_method',
  'reconciliation',
  'settlement',
];

const VIEWER_EXCLUDED: ReadonlySet<PermissionKey> = new Set([
  'product.cost.read',
  'security_event.read',
  'audit.read',
  'audit.export',
  'api_client.read',
  'api_request_log.read',
  'accounting.balance.read',
  'accounting.ledger.read',
  'accounting.valuation.read',
  'profit.distribution.read',
  'report.read',
  'setting.read',
]);

function buildRoleTemplates(): Record<RoleName, RoleTemplate> {
  const superadmin = unique(ALL_KEYS);
  const admin = unique(ALL_KEYS.filter((key) => !ADMIN_EXCLUDED.has(key)));

  const financeManager = unique([
    ...byFamily('accounting', 'bank', 'cash', 'cheque', 'payment', 'payment_method', 'reconciliation'),
    ...byFamily('partner', 'shareholder', 'profit.distribution', 'settlement'),
    ...byFamily('report', 'dashboard', 'saved_filter', 'export'),
    'approval.workflow.read',
    'approval.workflow.manage',
    'approval.request.read',
    'product.cost.read',
    'currency.read',
  ]);

  const accountant = unique([
    ...select((key) => key.startsWith('accounting.') && ACCOUNTANT_ACTIONS.has(keyAction(key))),
    ...select(
      (key) =>
        TREASURY_READ_RESOURCES.includes(keyResource(key)) && keyAction(key) === 'read',
    ),
    'payment.create',
    'customer.invoice.read',
    ...byFamily('report'),
  ]);

  const warehouseManager = unique([
    ...byFamily('warehouse'),
    ...byResource(
      'inventory.balance',
      'inventory.ledger',
      'inventory.count',
      'inventory.adjust',
      'inventory.transfer',
      'inventory.lot',
      'inventory.serial',
      'inventory.unit',
      'inventory.valuation',
      'inventory.reserve',
    ),
    'inventory.count',
    'inventory.adjust',
    'inventory.transfer',
    'inventory.reserve',
    ...byFamily('goods.receipt'),
    'fulfillment.allocate',
    'barcode.read',
    'product.read',
    'report.read',
    'notification.template.read',
  ]);

  const warehouseOperator = unique([
    'warehouse.pick',
    'warehouse.pack',
    'warehouse.putaway',
    'warehouse.device',
    ...byResource('warehouse.pick', 'warehouse.pack', 'warehouse.putaway', 'warehouse.device'),
    'inventory.balance.read',
    'inventory.count',
    'barcode.read',
    'product.read',
  ]);

  const salesAgent = unique([
    ...byFamily('customer'),
    ...byFamily('sales.order'),
    'sales.refund.create',
    'product.read',
    'barcode.read',
    'report.read',
  ]);

  const viewer = unique(
    select((key) => keyAction(key) === 'read' && !VIEWER_EXCLUDED.has(key)),
  );

  return {
    superadmin: {
      name: 'superadmin',
      descriptionFa: 'مدیر ارشد سامانه با دسترسی کامل؛ قابل ویرایش نیست.',
      isSystem: true,
      permissions: superadmin,
    },
    admin: {
      name: 'admin',
      descriptionFa: 'مدیر کل سازمان؛ همهٔ دسترسی‌ها به‌جز دسترسی اضطراری و مدیریت کلیدهای API.',
      isSystem: true,
      permissions: admin,
    },
    finance_manager: {
      name: 'finance_manager',
      descriptionFa: 'مدیر مالی: حسابداری، خزانه، شرکا و گزارش‌ها؛ بدون تغییر موجودی.',
      isSystem: false,
      permissions: financeManager,
    },
    accountant: {
      name: 'accountant',
      descriptionFa: 'حسابدار: ثبت و مشاهدهٔ اسناد حسابداری و گزارش‌ها.',
      isSystem: false,
      permissions: accountant,
    },
    warehouse_manager: {
      name: 'warehouse_manager',
      descriptionFa: 'مدیر انبار: انبار، موجودی، شمارش و رسید کالا؛ بدون دسترسی به بهای تمام‌شده.',
      isSystem: false,
      permissions: warehouseManager,
    },
    warehouse_operator: {
      name: 'warehouse_operator',
      descriptionFa: 'انباردار: انجام چیدمان، برداشت و بسته‌بندی در انبارهای مجاز.',
      isSystem: false,
      permissions: warehouseOperator,
    },
    sales_agent: {
      name: 'sales_agent',
      descriptionFa: 'کارشناس فروش: مشتریان، سفارش‌های فروش و گزارش فروش.',
      isSystem: false,
      permissions: salesAgent,
    },
    viewer: {
      name: 'viewer',
      descriptionFa: 'ناظر: فقط مشاهدهٔ اطلاعات عمومی؛ بدون هزینه، امنیت و گزارش‌های مالی.',
      isSystem: false,
      permissions: viewer,
    },
  };
}

/** Role templates derived from `API.md` §5.4 (seed convenience). */
export const ROLE_TEMPLATES: Readonly<Record<RoleName, RoleTemplate>> = buildRoleTemplates();

/**
 * Returns true when **all** required keys are granted.
 * Used by the permissions guard for `@Permissions('a', 'b')` (AND semantics).
 */
export function hasPermission(
  granted: readonly string[],
  required: PermissionKey | readonly PermissionKey[],
): boolean {
  const requiredKeys = typeof required === 'string' ? [required] : required;
  if (requiredKeys.length === 0) {
    return true;
  }
  const grantedSet = new Set(granted);
  return requiredKeys.every((key) => grantedSet.has(key));
}

/** Returns true when at least one required key is granted (UI/menu helpers). */
export function hasAnyPermission(
  granted: readonly string[],
  required: PermissionKey | readonly PermissionKey[],
): boolean {
  const requiredKeys = typeof required === 'string' ? [required] : required;
  if (requiredKeys.length === 0) {
    return true;
  }
  const grantedSet = new Set(granted);
  return requiredKeys.some((key) => grantedSet.has(key));
}

/** Returns the permission keys of a role template that are not registered keys. */
export function validateRoleTemplates(
  templates: Readonly<Record<RoleName, RoleTemplate>> = ROLE_TEMPLATES,
): string[] {
  const problems: string[] = [];
  for (const role of ROLE_NAMES) {
    const template = templates[role];
    if (template === undefined) {
      problems.push(`missing role template: ${role}`);
      continue;
    }
    for (const key of template.permissions) {
      if (!isPermissionKey(key)) {
        problems.push(`role ${role} grants unknown permission: ${key}`);
      }
    }
  }
  const superadmin = templates.superadmin;
  if (superadmin.permissions.length !== PERMISSION_KEYS.length) {
    problems.push('superadmin must grant every registered permission');
  }
  return problems;
}
