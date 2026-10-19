# ADR-0008 — Authorization, separation of duties, approvals

**Status:** Accepted · **Date:** 1405-07-27

## Context

SRS defines 7 roles but role-only checks (`if role === 'admin'`) rot quickly. Finance and stock actions are high-risk: a warehouse operator must not see cost, an accountant must not adjust stock, and one person must not both create and approve a large manual journal.

## Decision

1. **Permissions are code-defined keys** (`resource.action`, e.g. `inventory.adjust`, `accounting.journal.post`, `channel.credential.write`) seeded into `permissions`; roles are rows with permission sets; `is_system` roles are immutable.
2. **Guards**: `@Permissions('a','b')` + `@Scope()`; default-deny (a route without a permission decorator fails CI lint).
3. **Field-level protection** for cost/price: serializers strip `cost`, `purchase_price`, `margin` unless the caller has `catalog.cost.read`.
4. **Scope narrowing**: token carries `branchIds`/`warehouseIds` where applicable; repositories apply them (warehouse operators see only assigned warehouses).
5. **Separation of duties**: `approval_workflows/steps/requests/actions`; policies for manual journal above threshold, write-off, refund, credential change, price rule activation. Requester ≠ approver enforced by DB constraint `requested_by <> approved_by`.
6. **Permission cache** in Redis keyed by `users.permissions_version`; role edits bump versions transactionally.
7. **Every permission denial is audited** (`audit_logs` action `access.denied`) with route + actor.

## Revision — 2026-10-19 (R1 review B-04, H-01, B-06)

1. **No privilege amplification**: role create/update/assign, user-role assignment and scope widening reject any requested permission/scope that is not a subset of the actor's effective permissions (`403 FORBIDDEN_PERMISSION_ESCALATION`), require step-up, and are audited. System roles are immutable (`SYSTEM_ROLE_IMMUTABLE`).
2. **Approval configuration is protected**: thresholds and workflow definitions are changed only via `approval.config.manage` (superadmin), with step-up + two-person approval and a versioned snapshot. `setting.update` cannot alter approval thresholds.
3. **Posting rights are split**: `accounting.journal.post` (within threshold) vs `accounting.journal.post_high_value` (above threshold, must reference an approved `approval_request`, cannot be self-approved). Enforcement is in the service layer, not the UI.
4. **Single permission registry**: `packages/shared/permissions.ts` is generated from `API.md §5.2`; there is no second hand-maintained list. CI enforces bidirectional parity route↔registry with no prefix matching.

## Consequences

- Adding a feature requires seed permission → role template → UI menu entry (single source: `packages/shared/permissions.ts`).
- Seeds are idempotent and run on every deploy (`pnpm db:seed`).
