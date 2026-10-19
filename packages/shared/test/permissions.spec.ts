import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  PERMISSION_COUNT,
  PERMISSION_KEYS,
  PERMISSION_REGISTRY_STATS,
  ROLE_NAMES,
  ROLE_TEMPLATES,
  hasAnyPermission,
  hasPermission,
  isPermissionKey,
  parsePermissionKey,
  validateRoleTemplates,
} from '../src/permissions';
import { API_CONTRACT_PATH, extractPermissions } from '../scripts/extract-permissions.mjs';

describe('permission registry', () => {
  it('contains exactly the keys referenced by the API contract', () => {
    const markdown = readFileSync(API_CONTRACT_PATH, 'utf8');
    const { keys } = extractPermissions(markdown);
    expect([...PERMISSION_KEYS]).toEqual(keys);
    expect(PERMISSION_COUNT).toBe(412);
    expect(PERMISSION_REGISTRY_STATS.total).toBe(PERMISSION_KEYS.length);
  });

  it('is sorted and free of duplicates', () => {
    const sorted = [...PERMISSION_KEYS].sort();
    expect([...PERMISSION_KEYS]).toEqual(sorted);
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });

  it('keeps the separation-of-duties and sensitive keys from the contract', () => {
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
      expect(isPermissionKey(key), key).toBe(true);
    }
    // §5.3.2 alias/reserved keys are deliberately not seeded (not referenced by any route).
    expect(isPermissionKey('warehouse.pick.execute')).toBe(false);
    expect(isPermissionKey('auth.login')).toBe(false);
    expect(isPermissionKey('setting.secret.read')).toBe(false);
  });

  it('parses resource and action from the last dot segment', () => {
    expect(parsePermissionKey('accounting.journal.post')).toEqual({
      resource: 'accounting.journal',
      action: 'post',
    });
    expect(parsePermissionKey('inventory.adjust')).toEqual({ resource: 'inventory', action: 'adjust' });
    expect(() => parsePermissionKey('nodots')).toThrow(RangeError);
    expect(() => parsePermissionKey('.leading')).toThrow(RangeError);
    expect(() => parsePermissionKey('trailing.')).toThrow(RangeError);
  });
});

describe('role templates (API.md §5.4)', () => {
  it('are valid subsets of the registry', () => {
    expect(validateRoleTemplates()).toEqual([]);
  });

  it('defines every documented role', () => {
    expect(ROLE_NAMES).toHaveLength(8);
    for (const role of ROLE_NAMES) {
      expect(ROLE_TEMPLATES[role].permissions.length).toBeGreaterThan(0);
    }
  });

  it('grants all keys to superadmin and keeps admin exceptions', () => {
    expect(ROLE_TEMPLATES.superadmin.permissions).toHaveLength(PERMISSION_COUNT);
    expect(hasPermission(ROLE_TEMPLATES.admin.permissions, 'api_client.create')).toBe(false);
    expect(hasPermission(ROLE_TEMPLATES.admin.permissions, 'identity.break_glass.use')).toBe(false);
    expect(hasPermission(ROLE_TEMPLATES.admin.permissions, 'accounting.journal.post')).toBe(true);
  });

  it('enforces separation of duties and cost visibility', () => {
    expect(hasPermission(ROLE_TEMPLATES.finance_manager.permissions, 'inventory.adjust')).toBe(false);
    expect(hasPermission(ROLE_TEMPLATES.finance_manager.permissions, 'inventory.count')).toBe(false);
    expect(hasPermission(ROLE_TEMPLATES.finance_manager.permissions, 'product.cost.read')).toBe(true);
    expect(hasPermission(ROLE_TEMPLATES.warehouse_manager.permissions, 'product.cost.read')).toBe(
      false,
    );
    expect(hasPermission(ROLE_TEMPLATES.warehouse_operator.permissions, 'product.cost.read')).toBe(
      false,
    );
    expect(hasPermission(ROLE_TEMPLATES.viewer.permissions, 'product.cost.read')).toBe(false);
    expect(hasPermission(ROLE_TEMPLATES.viewer.permissions, 'security_event.read')).toBe(false);
    expect(hasPermission(ROLE_TEMPLATES.warehouse_operator.permissions, 'warehouse.pick')).toBe(true);
    expect(hasPermission(ROLE_TEMPLATES.sales_agent.permissions, 'sales.order.create')).toBe(true);
  });
});

describe('permission checks', () => {
  it('requires every key for @Permissions (AND semantics)', () => {
    expect(hasPermission(['inventory.adjust', 'inventory.count'], ['inventory.adjust', 'inventory.count'])).toBe(
      true,
    );
    expect(hasPermission(['inventory.adjust'], ['inventory.adjust', 'inventory.count'])).toBe(false);
    expect(hasPermission([], [])).toBe(true);
  });

  it('supports any-of checks for menus', () => {
    expect(hasAnyPermission(['inventory.adjust'], ['inventory.adjust', 'accounting.journal.post'])).toBe(true);
    expect(hasAnyPermission([], ['inventory.adjust', 'accounting.journal.post'])).toBe(false);
  });
});
