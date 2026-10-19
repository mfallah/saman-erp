# ADR-0005 — Organization scoping & tenancy

**Status:** Accepted · **Date:** 1405-07-27

## Context

The schema is org-aware (`organization_id` on most tables). V1 serves one company (Carexy Shop) but must not paint us into a corner; a future SaaS/group-of-companies scenario is plausible. PostgreSQL RLS is available but complicates pooling/migrations and is easy to bypass accidentally.

## Decision

- **Single database, shared schema**, `organization_id` on every business aggregate root (and on children via parent).
- **Repo-layer enforcement**: all repositories take a `TenantContext` (`orgId`, `actorId`, `branchScope`, `warehouseScope`) and every query is scoped by it. A code-review rule + test forbids `db.select().from(x)` outside repository helpers.
- **No RLS in v1**; a documented migration path to RLS exists: enable policies when a second tenant is onboarded (policies keyed on `current_setting('app.org_id')`), plus a `saman_app` role that cannot bypass.
- Cross-org references are impossible by construction: FKs point to rows already scoped; composite FKs `(organization_id, id)` are used on the highest-risk relations (inventory, orders, journal).

## Consequences

- Slightly more verbose repositories; big win in simplicity and performance for v1.
- Group-level consolidation (multi-org reporting) can be added as a reporting concern.

## Alternatives rejected

- **Database per tenant** — migration/backup fan-out, wasteful for one company.
- **RLS-only** — not a substitute for app-level authorization; still need scoping for error messages and performance.
