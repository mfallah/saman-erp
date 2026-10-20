"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROLE_TEMPLATES = exports.PERMISSION_COUNT = exports.PERMISSION_KEY_SET = exports.ROLE_NAMES = exports.PERMISSION_REGISTRY_STATS = exports.PERMISSION_KEYS = void 0;
exports.isPermissionKey = isPermissionKey;
exports.parsePermissionKey = parsePermissionKey;
exports.hasPermission = hasPermission;
exports.hasAnyPermission = hasAnyPermission;
exports.validateRoleTemplates = validateRoleTemplates;
/**
 * Permission-key registry and role templates (`API.md` §5, `ADR-0008`).
 *
 * The key list is generated from the API contract (see
 * `scripts/extract-permissions.mjs`) — never hand-typed. This module adds the
 * lookup helpers used by guards, seed code and the SPA menu builder, plus the
 * role templates of `API.md` §5.4 as seed convenience (roles are rows, not code).
 */
const permissions_generated_1 = require("./permissions.generated");
Object.defineProperty(exports, "PERMISSION_KEYS", { enumerable: true, get: function () { return permissions_generated_1.PERMISSION_KEYS; } });
Object.defineProperty(exports, "PERMISSION_REGISTRY_STATS", { enumerable: true, get: function () { return permissions_generated_1.PERMISSION_REGISTRY_STATS; } });
exports.ROLE_NAMES = [
    'superadmin',
    'admin',
    'finance_manager',
    'accountant',
    'warehouse_manager',
    'warehouse_operator',
    'sales_agent',
    'viewer',
];
exports.PERMISSION_KEY_SET = new Set(permissions_generated_1.PERMISSION_KEYS);
/** Total number of permission keys referenced by the v1 API. */
exports.PERMISSION_COUNT = permissions_generated_1.PERMISSION_KEYS.length;
/** Narrows an arbitrary string to a registered permission key. */
function isPermissionKey(value) {
    return exports.PERMISSION_KEY_SET.has(value);
}
/** Splits `accounting.journal.post` into `{ resource: 'accounting.journal', action: 'post' }`. */
function parsePermissionKey(key) {
    const dot = key.lastIndexOf('.');
    if (dot <= 0 || dot === key.length - 1) {
        throw new RangeError(`invalid_permission_key:${JSON.stringify(key)}`);
    }
    return { resource: key.slice(0, dot), action: key.slice(dot + 1) };
}
/** Returns true when the key family (resource part) matches any prefix. */
function resourceStartsWith(key, prefix) {
    return key === prefix || key.startsWith(`${prefix}.`);
}
function keyResource(key) {
    return parsePermissionKey(key).resource;
}
function keyAction(key) {
    return parsePermissionKey(key).action;
}
function select(predicate) {
    return permissions_generated_1.PERMISSION_KEYS.filter(predicate);
}
function byFamily(...prefixes) {
    return select((key) => prefixes.some((prefix) => resourceStartsWith(key, prefix)));
}
function byResource(...resources) {
    return select((key) => resources.includes(keyResource(key)));
}
function unique(keys) {
    return [...new Set(keys)];
}
const ALL_KEYS = permissions_generated_1.PERMISSION_KEYS;
const ADMIN_EXCLUDED = new Set([
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
const VIEWER_EXCLUDED = new Set([
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
function buildRoleTemplates() {
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
        ...select((key) => TREASURY_READ_RESOURCES.includes(keyResource(key)) && keyAction(key) === 'read'),
        'payment.create',
        'customer.invoice.read',
        ...byFamily('report'),
    ]);
    const warehouseManager = unique([
        ...byFamily('warehouse'),
        ...byResource('inventory.balance', 'inventory.ledger', 'inventory.count', 'inventory.adjust', 'inventory.transfer', 'inventory.lot', 'inventory.serial', 'inventory.unit', 'inventory.valuation', 'inventory.reserve'),
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
    const viewer = unique(select((key) => keyAction(key) === 'read' && !VIEWER_EXCLUDED.has(key)));
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
exports.ROLE_TEMPLATES = buildRoleTemplates();
/**
 * Returns true when **all** required keys are granted.
 * Used by the permissions guard for `@Permissions('a', 'b')` (AND semantics).
 */
function hasPermission(granted, required) {
    const requiredKeys = typeof required === 'string' ? [required] : required;
    if (requiredKeys.length === 0) {
        return true;
    }
    const grantedSet = new Set(granted);
    return requiredKeys.every((key) => grantedSet.has(key));
}
/** Returns true when at least one required key is granted (UI/menu helpers). */
function hasAnyPermission(granted, required) {
    const requiredKeys = typeof required === 'string' ? [required] : required;
    if (requiredKeys.length === 0) {
        return true;
    }
    const grantedSet = new Set(granted);
    return requiredKeys.some((key) => grantedSet.has(key));
}
/** Returns the permission keys of a role template that are not registered keys. */
function validateRoleTemplates(templates = exports.ROLE_TEMPLATES) {
    const problems = [];
    for (const role of exports.ROLE_NAMES) {
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
    if (superadmin.permissions.length !== permissions_generated_1.PERMISSION_KEYS.length) {
        problems.push('superadmin must grant every registered permission');
    }
    return problems;
}
