/**
 * Report/dashboard access rules (`API.md §4.14`, R1-security S-H-09).
 *
 * `report_definitions.required_permissions` is an **array** of registry keys; a
 * run or an export is allowed only when the actor holds every key (exact match,
 * no prefix logic). A dashboard is visible only when the actor holds the union of
 * its widgets' permissions — the strictest widget wins.
 */
import { AppError } from '@saman/shared';
import type { PermissionKey } from '@saman/shared';

export interface PermissionHolder {
  readonly permissions: readonly PermissionKey[];
}

export function hasPermission(holder: PermissionHolder, permission: string): boolean {
  return holder.permissions.includes(permission as PermissionKey);
}

export function hasAllPermissions(holder: PermissionHolder, required: readonly string[]): boolean {
  return required.every((permission) => hasPermission(holder, permission));
}

/** Throws `FORBIDDEN` with the missing keys (never leaks route internals). */
export function assertReportPermissions(
  holder: PermissionHolder,
  required: readonly string[],
  action: 'run' | 'export' | 'read',
): void {
  if (hasAllPermissions(holder, required)) return;
  const missing = required.filter((permission) => !hasPermission(holder, permission));
  throw new AppError('FORBIDDEN', {
    details: [{ rule: 'report_permission_required', params: { action, missing: missing.join(',') } }],
    message: 'برای اجرا یا خروجی این گزارش، دسترسی لازم را ندارید.',
  });
}

/** Strictest widget permission: union of every widget's requirement. */
export function dashboardRequiredPermissions(
  widgets: readonly { readonly requiredPermissionKey: string | null }[],
): readonly string[] {
  const required = new Set<string>();
  for (const widget of widgets) {
    if (widget.requiredPermissionKey !== null && widget.requiredPermissionKey.length > 0) {
      required.add(widget.requiredPermissionKey);
    }
  }
  return [...required];
}

/** Entity → permission mapping used by async exports (no silent leakage). */
export const EXPORT_ENTITY_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  products: ['product.read'],
  inventory: ['inventory.balance.read'],
  'inventory-ledger': ['inventory.ledger.read'],
  orders: ['sales.order.read'],
  customers: ['customer.read'],
  suppliers: ['supplier.read'],
  journal: ['accounting.journal.read'],
  ledger: ['accounting.ledger.read'],
  'trial-balance': ['accounting.balance.read'],
  payments: ['payment.read'],
  cheques: ['cheque.read'],
  partners: ['partner.read'],
  audit: ['audit.read'],
};

export function entityExportPermissions(entity: string): readonly string[] {
  const required = EXPORT_ENTITY_PERMISSIONS[entity];
  if (required === undefined) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'entity', rule: 'unsupported_export_entity', params: { entity } }],
      message: 'موجودیت درخواستی برای خروجی پشتیبانی نمی‌شود.',
    });
  }
  return required;
}

/** Export artifacts expire after 7 days (API §4.14). */
export const EXPORT_RETENTION_DAYS = 7;

export function isExportExpired(createdAtIso: string, now = new Date()): boolean {
  const created = new Date(createdAtIso);
  const ageMs = now.getTime() - created.getTime();
  return ageMs > EXPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

/** Sync reports are limited to a 5-second / 5,000-row budget (API §4.14). */
export const SYNC_REPORT_ROW_LIMIT = 5_000;

export function shouldRunAsync(requestedAsync: boolean, estimatedRows: number | undefined): boolean {
  if (requestedAsync) return true;
  if (estimatedRows === undefined) return false;
  return estimatedRows > SYNC_REPORT_ROW_LIMIT;
}
