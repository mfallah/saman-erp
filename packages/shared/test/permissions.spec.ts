import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it } from 'node:test';

import { expect } from './expect';

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

/** Resolves the API contract from source (`test/`) or compiled (`dist-test/test/`) layouts. */
function findApiContract(): string {
  const candidates = [
    join(__dirname, '..', '..', '..', '..', 'docs', '03-api-contract', 'API.md'),
    join(__dirname, '..', '..', '..', 'docs', '03-api-contract', 'API.md'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(`API contract not found in: ${candidates.join(', ')}`);
  }
  return found;
}

/** Reads the first fenced ```text block after a heading. */
function textBlockAfter(markdown: string, heading: string): string {
  const headingIndex = markdown.indexOf(heading);
  if (headingIndex === -1) throw new Error(`API.md heading not found: ${heading}`);
  const fenceStart = markdown.indexOf('```text', headingIndex);
  const contentStart = markdown.indexOf('\n', fenceStart) + 1;
  const fenceEnd = markdown.indexOf('```', contentStart);
  return markdown.slice(contentStart, fenceEnd);
}

/** Independent re-implementation of the generator extraction (drift guard): §5.2 ∪ §5.3.1. */
function extractContractKeys(markdown: string): string[] {
  const keys = new Set<string>();
  for (const line of textBlockAfter(markdown, '### 5.2 Registry').split('\n')) {
    const row = line.trim();
    if (row.length === 0) continue;
    const match = /^([a-z][a-z0-9_.]*):\s*(.+)$/.exec(row);
    if (match === null) throw new Error(`unparsable registry row: ${row}`);
    for (const action of (match[2] as string).split(',')) {
      const trimmed = action.trim();
      if (trimmed.length > 0) keys.add(`${match[1]}.${trimmed}`);
    }
  }
  for (const line of textBlockAfter(markdown, '### 5.3.1 Exact delta').split('\n')) {
    const key = line.trim();
    if (key.length > 0) keys.add(key);
  }
  return [...keys].sort();
}

describe('permission registry', () => {
  it('contains exactly the keys referenced by the API contract', () => {
    const markdown = readFileSync(findApiContract(), 'utf8');
    expect([...PERMISSION_KEYS]).toEqual(extractContractKeys(markdown));
    expect(PERMISSION_COUNT).toBe(extractContractKeys(readFileSync(findApiContract(), "utf8")).length);
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
      expect(isPermissionKey(key)).toBe(true);
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
    expect(parsePermissionKey('inventory.adjust')).toEqual({
      resource: 'inventory',
      action: 'adjust',
    });
    expect(() => parsePermissionKey('nodots')).toThrow();
    expect(() => parsePermissionKey('.leading')).toThrow();
    expect(() => parsePermissionKey('trailing.')).toThrow();
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
    expect(hasPermission(ROLE_TEMPLATES.warehouse_manager.permissions, 'product.cost.read')).toBe(false);
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
    expect(
      hasPermission(['inventory.adjust', 'inventory.count'], ['inventory.adjust', 'inventory.count']),
    ).toBe(true);
    expect(hasPermission(['inventory.adjust'], ['inventory.adjust', 'inventory.count'])).toBe(false);
    expect(hasPermission([], [])).toBe(true);
  });

  it('supports any-of checks for menus', () => {
    expect(
      hasAnyPermission(['inventory.adjust'], ['inventory.adjust', 'accounting.journal.post']),
    ).toBe(true);
    expect(hasAnyPermission([], ['inventory.adjust', 'accounting.journal.post'])).toBe(false);
  });
});
