/**
 * TD-16 — single source of truth for the step-up matrix.
 *
 * Every route whose `@Permissions(...)` includes one of the keys below MUST also
 * carry `@RequireStepUp('<permission key>')`. The startup self-check
 * (`StepUpCoverageService`) fails the gap into the log at boot, and the test
 * suite asserts the module has no uncovered sensitive route.
 *
 * Keys are `resource.action`; the matrix matches the full permission key, so a
 * read of the same resource never requires step-up.
 */

/** Sensitive `resource` → the mutating actions that must be step-up gated. */
export const STEP_UP_SENSITIVE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  /* financial postings, approvals and reversals */
  'accounting.journal': ['approve', 'post', 'post_high_value', 'reverse'],
  'accounting.fiscal_year': ['close', 'reopen'],
  'accounting.period': ['close', 'reopen'],
  'accounting.valuation': ['post', 'run'],
  'accounting.document': ['issue', 'void'],
  'approval': ['act'],
  'approval.config': ['manage'],
  'approval.workflow': ['manage'],

  /* payment / cash transactions */
  payment: ['create', 'update', 'submit', 'approve', 'execute', 'void', 'allocate'],
  cheque: ['issue', 'deposit', 'clear', 'bounce', 'endorse', 'cancel'],
  'cash.session': ['open', 'close'],
  'cash.transaction': ['create'],

  /* credit limit, invoices and refunds */
  'customer.credit': ['update'],
  'customer.invoice': ['issue', 'void'],
  'sales.refund': ['approve', 'pay', 'void'],
  'sales.return': ['approve'],

  /* stock postings that move value */
  'inventory.adjust': ['approve', 'post'],
  'inventory.count': ['approve', 'post'],
  'inventory.transfer': ['approve'],

  /* user / role / permission changes */
  user: ['create', 'update', 'delete', 'reset_password'],
  'user.scope': ['assign'],
  role: ['create', 'update', 'delete', 'assign'],
  permission: ['create', 'update', 'delete'],

  /* channel credentials */
  'channel.credential': ['write', 'rotate', 'delete'],
} as const;

/** `true` when exercising this permission must be protected by step-up. */
export function isSensitivePermission(permission: string): boolean {
  const dot = permission.lastIndexOf('.');
  if (dot <= 0 || dot === permission.length - 1) return false;
  const resource = permission.slice(0, dot);
  const action = permission.slice(dot + 1);
  return STEP_UP_SENSITIVE_PERMISSIONS[resource]?.includes(action) === true;
}

/** The subset of `permissions` that requires step-up (empty = not sensitive). */
export function sensitivePermissions(permissions: readonly string[]): readonly string[] {
  return permissions.filter(isSensitivePermission);
}

/** Human-readable matrix, used by the startup self-check log and tests. */
export function stepUpMatrixEntries(): ReadonlyArray<readonly [string, readonly string[]]> {
  return Object.entries(STEP_UP_SENSITIVE_PERMISSIONS);
}
