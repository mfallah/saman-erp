# Design Review Log — Saman ERP

This directory is the audit trail for the mandatory design-review gate. Nothing is
"approved" without a recorded round, findings, and resolution. Reviews are run by
independent reviewers (fresh context, adversarial stance) who did not author the docs.

## Process

1. **Round 1 — correctness & domain truth** (DB shape, accounting/inventory logic, security/authz).
2. **Round 2 — implementability & scale** (API↔DB↔tests consistency, performance/concurrency, ops/deploy).
3. **Round 3 — red team & requirements gap** (exploitation attempts, source-document coverage, "fresh engineer can implement").
After each round: findings are triaged (fix / defer with reason), docs are patched to the next version, and the disposition is recorded below. Only after Round 3 with zero open blockers does implementation of that area continue (foundation work may proceed in parallel where reviews cannot invalidate it).

## Round 1 — 2026-10-19

| Reviewer | Focus | File | Findings | Verdict |
|---|---|---|---|---|
| R1-A | Data model / PostgreSQL correctness | [`round-1/R1-datamodel.md`](round-1/R1-datamodel.md) | 48 (10 Blocker, 19 High, 14 Medium, 5 Low) | reject |
| R1-B | Accounting, treasury, inventory costing | [`round-1/R1-accounting.md`](round-1/R1-accounting.md) | 57 (16 Blocker, 14 High, 21 Medium, 6 Low) | not releasable |
| R1-C | Security & authorization (adversarial) | [`round-1/R1-security.md`](round-1/R1-security.md) | 33 (6 Blocker, 12 High, 10 Medium, 5 Low) | not releasable |

**Round-1 total: 138 findings, 32 blockers.** All 32 blockers are design-fixed in v1.1; non-blocker deferrals are recorded in each owning document's `## Revision log`.

### Disposition summary

| Finding group | Resolution | Patched in |
|---|---|---|
| R1-B B-01…B-07 (sale/purchase VAT & COGS, GRNI, settlement, contra accounts, CoA manifest, negative available, FIFO layers) | fixed in design: versioned posting rule sets + complete Dr/Cr matrix, GRNI/clearing/VAT accounts, exact CoA manifest with asserted count, balance check constraint, cost-layer ledger | DATA-MODEL v1.1 |
| R1-B B-08…B-14 (closing entries, period ranges, posting DSL, return VAT credit notes, invoice rounding, cheque FSM, payment allocation/clearing) | fixed in design | DATA-MODEL v1.1 |
| R1-C B-01 (phase status claimed shipped) | fixed: ARCHITECTURE §17 statuses are now honest; SECURITY §9 requires per-control evidence links | ARCHITECTURE v1.1 |
| R1-C B-02…B-04 (device trust keyed on client fingerprint, password-reset policy, maker-checker bypass) | fixed in API + DB + SECURITY | API v1.1, DATA-MODEL v1.1, SECURITY v1.1 |
| R1-C B-05 (audit not tamper-evident) | fixed: hash chain, SECURITY DEFINER chain function, grant manifest, 10-year retention | DATA-MODEL/SECURITY v1.1 |
| R1-C B-06 (permission registry drift 314 vs 412) | fixed: single generated registry in `packages/shared/permissions.ts`, docs reference it | API/DATA-MODEL v1.1 |
| R1-C High/Medium (H-01…H-12, M-01…M-08) | fixed or explicitly deferred with compensating control (see security doc revision log) | SECURITY v1.1, API v1.1 |
| R1-B High/Medium/Low | fixed where schema/posting-relevant; UX/report polish items deferred to roadmap | DATA-MODEL v1.1 |

## Round 2 — pending

## Round 3 — pending

## Standing rules

- A finding may be **deferred** only if: it is not a blocker, the deferral is written in the owning document with a compensating control, and it appears in `09-roadmap/ROADMAP.md` technical-debt ledger.
- Any change to an accepted ADR is recorded as a dated revision in that ADR, never silently.
- Re-review triggers: schema change to journal/audit/inventory/auth tables, new integration, new role class, any security incident.
