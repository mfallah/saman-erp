"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_test_1 = require("node:test");
const expect_1 = require("./expect");
const permissions_1 = require("../src/permissions");
/** Resolves the API contract from source (`test/`) or compiled (`dist-test/test/`) layouts. */
function findApiContract() {
    const candidates = [
        (0, node_path_1.join)(__dirname, '..', '..', '..', '..', 'docs', '03-api-contract', 'API.md'),
        (0, node_path_1.join)(__dirname, '..', '..', '..', 'docs', '03-api-contract', 'API.md'),
    ];
    const found = candidates.find((candidate) => (0, node_fs_1.existsSync)(candidate));
    if (found === undefined) {
        throw new Error(`API contract not found in: ${candidates.join(', ')}`);
    }
    return found;
}
/** Reads the first fenced ```text block after a heading. */
function textBlockAfter(markdown, heading) {
    const headingIndex = markdown.indexOf(heading);
    if (headingIndex === -1)
        throw new Error(`API.md heading not found: ${heading}`);
    const fenceStart = markdown.indexOf('```text', headingIndex);
    const contentStart = markdown.indexOf('\n', fenceStart) + 1;
    const fenceEnd = markdown.indexOf('```', contentStart);
    return markdown.slice(contentStart, fenceEnd);
}
/** Independent re-implementation of the generator extraction (drift guard): §5.2 ∪ §5.3.1. */
function extractContractKeys(markdown) {
    const keys = new Set();
    for (const line of textBlockAfter(markdown, '### 5.2 Registry').split('\n')) {
        const row = line.trim();
        if (row.length === 0)
            continue;
        const match = /^([a-z][a-z0-9_.]*):\s*(.+)$/.exec(row);
        if (match === null)
            throw new Error(`unparsable registry row: ${row}`);
        for (const action of match[2].split(',')) {
            const trimmed = action.trim();
            if (trimmed.length > 0)
                keys.add(`${match[1]}.${trimmed}`);
        }
    }
    for (const line of textBlockAfter(markdown, '### 5.3.1 Exact delta').split('\n')) {
        const key = line.trim();
        if (key.length > 0)
            keys.add(key);
    }
    return [...keys].sort();
}
(0, node_test_1.describe)('permission registry', () => {
    (0, node_test_1.it)('contains exactly the keys referenced by the API contract', () => {
        const markdown = (0, node_fs_1.readFileSync)(findApiContract(), 'utf8');
        (0, expect_1.expect)([...permissions_1.PERMISSION_KEYS]).toEqual(extractContractKeys(markdown));
        (0, expect_1.expect)(permissions_1.PERMISSION_COUNT).toBe(extractContractKeys((0, node_fs_1.readFileSync)(findApiContract(), "utf8")).length);
        (0, expect_1.expect)(permissions_1.PERMISSION_REGISTRY_STATS.total).toBe(permissions_1.PERMISSION_KEYS.length);
    });
    (0, node_test_1.it)('is sorted and free of duplicates', () => {
        const sorted = [...permissions_1.PERMISSION_KEYS].sort();
        (0, expect_1.expect)([...permissions_1.PERMISSION_KEYS]).toEqual(sorted);
        (0, expect_1.expect)(new Set(permissions_1.PERMISSION_KEYS).size).toBe(permissions_1.PERMISSION_KEYS.length);
    });
    (0, node_test_1.it)('keeps the separation-of-duties and sensitive keys from the contract', () => {
        for (const key of [
            'inventory.adjust',
            'inventory.adjust.approve',
            'inventory.adjust.post',
            'accounting.journal.post',
            'accounting.journal.approve',
            'product.cost.read',
            'identity.break_glass.use',
            'channel.credential.write',
            'user.scope.assign',
            'fulfillment.allocate',
            'warehouse.pick',
            'warehouse.pick.read',
        ]) {
            (0, expect_1.expect)((0, permissions_1.isPermissionKey)(key)).toBe(true);
        }
        // §5.3.2 alias/reserved keys are deliberately not seeded (not referenced by any route).
        (0, expect_1.expect)((0, permissions_1.isPermissionKey)('warehouse.pick.execute')).toBe(false);
        (0, expect_1.expect)((0, permissions_1.isPermissionKey)('auth.login')).toBe(false);
        (0, expect_1.expect)((0, permissions_1.isPermissionKey)('setting.secret.read')).toBe(false);
    });
    (0, node_test_1.it)('parses resource and action from the last dot segment', () => {
        (0, expect_1.expect)((0, permissions_1.parsePermissionKey)('accounting.journal.post')).toEqual({
            resource: 'accounting.journal',
            action: 'post',
        });
        (0, expect_1.expect)((0, permissions_1.parsePermissionKey)('inventory.adjust')).toEqual({
            resource: 'inventory',
            action: 'adjust',
        });
        (0, expect_1.expect)(() => (0, permissions_1.parsePermissionKey)('nodots')).toThrow();
        (0, expect_1.expect)(() => (0, permissions_1.parsePermissionKey)('.leading')).toThrow();
        (0, expect_1.expect)(() => (0, permissions_1.parsePermissionKey)('trailing.')).toThrow();
    });
});
(0, node_test_1.describe)('role templates (API.md §5.4)', () => {
    (0, node_test_1.it)('are valid subsets of the registry', () => {
        (0, expect_1.expect)((0, permissions_1.validateRoleTemplates)()).toEqual([]);
    });
    (0, node_test_1.it)('defines every documented role', () => {
        (0, expect_1.expect)(permissions_1.ROLE_NAMES).toHaveLength(8);
        for (const role of permissions_1.ROLE_NAMES) {
            (0, expect_1.expect)(permissions_1.ROLE_TEMPLATES[role].permissions.length).toBeGreaterThan(0);
        }
    });
    (0, node_test_1.it)('grants all keys to superadmin and keeps admin exceptions', () => {
        (0, expect_1.expect)(permissions_1.ROLE_TEMPLATES.superadmin.permissions).toHaveLength(permissions_1.PERMISSION_COUNT);
        (0, expect_1.expect)((0, permissions_1.hasPermission)(permissions_1.ROLE_TEMPLATES.admin.permissions, 'api_client.create')).toBe(false);
        (0, expect_1.expect)((0, permissions_1.hasPermission)(permissions_1.ROLE_TEMPLATES.admin.permissions, 'identity.break_glass.use')).toBe(false);
        (0, expect_1.expect)((0, permissions_1.hasPermission)(permissions_1.ROLE_TEMPLATES.admin.permissions, 'accounting.journal.post')).toBe(true);
    });
    (0, node_test_1.it)('enforces separation of duties and cost visibility', () => {
        (0, expect_1.expect)((0, permissions_1.hasPermission)(permissions_1.ROLE_TEMPLATES.finance_manager.permissions, 'inventory.adjust')).toBe(false);
        (0, expect_1.expect)((0, permissions_1.hasPermission)(permissions_1.ROLE_TEMPLATES.finance_manager.permissions, 'inventory.count')).toBe(false);
        (0, expect_1.expect)((0, permissions_1.hasPermission)(permissions_1.ROLE_TEMPLATES.finance_manager.permissions, 'product.cost.read')).toBe(true);
        (0, expect_1.expect)((0, permissions_1.hasPermission)(permissions_1.ROLE_TEMPLATES.warehouse_manager.permissions, 'product.cost.read')).toBe(false);
        (0, expect_1.expect)((0, permissions_1.hasPermission)(permissions_1.ROLE_TEMPLATES.warehouse_operator.permissions, 'product.cost.read')).toBe(false);
        (0, expect_1.expect)((0, permissions_1.hasPermission)(permissions_1.ROLE_TEMPLATES.viewer.permissions, 'product.cost.read')).toBe(false);
        (0, expect_1.expect)((0, permissions_1.hasPermission)(permissions_1.ROLE_TEMPLATES.viewer.permissions, 'security_event.read')).toBe(false);
        (0, expect_1.expect)((0, permissions_1.hasPermission)(permissions_1.ROLE_TEMPLATES.warehouse_operator.permissions, 'warehouse.pick')).toBe(true);
        (0, expect_1.expect)((0, permissions_1.hasPermission)(permissions_1.ROLE_TEMPLATES.sales_agent.permissions, 'sales.order.create')).toBe(true);
    });
});
(0, node_test_1.describe)('permission checks', () => {
    (0, node_test_1.it)('requires every key for @Permissions (AND semantics)', () => {
        (0, expect_1.expect)((0, permissions_1.hasPermission)(['inventory.adjust', 'inventory.count'], ['inventory.adjust', 'inventory.count'])).toBe(true);
        (0, expect_1.expect)((0, permissions_1.hasPermission)(['inventory.adjust'], ['inventory.adjust', 'inventory.count'])).toBe(false);
        (0, expect_1.expect)((0, permissions_1.hasPermission)([], [])).toBe(true);
    });
    (0, node_test_1.it)('supports any-of checks for menus', () => {
        (0, expect_1.expect)((0, permissions_1.hasAnyPermission)(['inventory.adjust'], ['inventory.adjust', 'accounting.journal.post'])).toBe(true);
        (0, expect_1.expect)((0, permissions_1.hasAnyPermission)([], ['inventory.adjust', 'accounting.journal.post'])).toBe(false);
    });
});
