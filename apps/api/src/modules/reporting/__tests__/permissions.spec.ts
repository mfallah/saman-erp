/** Report/dashboard permission enforcement at run and export (S-H-09). */
import { describe, expect, it } from 'vitest';
import {
  assertReportPermissions,
  dashboardRequiredPermissions,
  entityExportPermissions,
  hasAllPermissions,
  isExportExpired,
  shouldRunAsync,
} from '../report-registry';
import type { PermissionKey } from '@saman/shared';

const holder = (permissions: string[]) => ({ permissions: permissions as PermissionKey[] });

describe('report permissions', () => {
  it('requires every key listed on the report definition', () => {
    const required = ['report.run', 'accounting.balance.read'];
    expect(hasAllPermissions(holder(['report.run']), required)).toBe(false);
    expect(hasAllPermissions(holder(['report.run', 'accounting.balance.read']), required)).toBe(true);
  });

  it('throws FORBIDDEN naming the missing keys', () => {
    expect(() =>
      assertReportPermissions(holder(['report.run']), ['report.run', 'accounting.ledger.read'], 'run'),
    ).toThrow(/دسترسی/);
  });

  it('never grants access by prefix', () => {
    expect(hasAllPermissions(holder(['accounting.ledger.read']), ['accounting.ledger.read.extra'])).toBe(false);
  });

  it('derives the strictest widget permission for a dashboard', () => {
    expect(
      dashboardRequiredPermissions([
        { requiredPermissionKey: 'report.read' },
        { requiredPermissionKey: null },
        { requiredPermissionKey: 'accounting.balance.read' },
      ]),
    ).toEqual(['report.read', 'accounting.balance.read']);
  });

  it('maps export entities to their read permission', () => {
    expect(entityExportPermissions('journal')).toEqual(['accounting.journal.read']);
    expect(entityExportPermissions('inventory')).toEqual(['inventory.balance.read']);
    expect(() => entityExportPermissions('secrets')).toThrow();
  });

  it('expires export artifacts after seven days', () => {
    const now = new Date('2026-01-10T00:00:00Z');
    expect(isExportExpired('2026-01-05T00:00:00Z', now)).toBe(false);
    expect(isExportExpired('2026-01-01T00:00:00Z', now)).toBe(true);
  });

  it('queues large reports asynchronously', () => {
    expect(shouldRunAsync(true, 1)).toBe(true);
    expect(shouldRunAsync(false, 10)).toBe(false);
    expect(shouldRunAsync(false, 10_000)).toBe(true);
  });
});
