# Design Review Log — Saman ERP

This directory is the audit trail for the review gates. Nothing is "approved" without a
recorded round, findings, and resolution. Reviews are run by independent reviewers (fresh
context, adversarial stance) who did not author the artifacts.

## Process

1. **Round 1 — design correctness & domain truth** (DB, accounting/inventory, security).
   Findings are triaged (fix / defer with reason); docs are patched to the next version.
2. **Round 2 — design implementability & scale** (performance/concurrency; operational feasibility).
3. **Round 3 — adversarial code & handover review** (red-team of the delivered code; owner
   requirements + installability dry-run).
Implementation then proceeds only for areas whose design has no open blocker; implementation
defects found in Round 3 are tracked in §"Round 3 remediation" and the roadmap debt ledger.

## Round 1 — 2026-10-19 (design, three reviewers)

| Reviewer | Focus | File | Findings | Verdict |
|---|---|---|---|---|
| R1-A | Data model / PostgreSQL correctness | [`round-1/R1-datamodel.md`](round-1/R1-datamodel.md) | 48 (10 Blocker, 19 High, 14 Medium, 5 Low) | reject → fixed in DATA-MODEL v1.1 |
| R1-B | Accounting, treasury, inventory costing | [`round-1/R1-accounting.md`](round-1/R1-accounting.md) | 57 (16 Blocker, 14 High, 21 Medium, 6 Low) | not releasable → fixed in v1.1 |
| R1-C | Security & authorization (adversarial) | [`round-1/R1-security.md`](round-1/R1-security.md) | 33 (6 Blocker, 12 High, 10 Medium, 5 Low) | not releasable → fixed in v1.1 |

**Round-1 total: 138 findings, 32 blockers.** All 32 blockers were resolved in design v1.1
(`docs/02-data-model`, `docs/03-api-contract`, `docs/04-security`, ADRs 0004/0006/0008/0009/0012).
Non-blocker deferrals are recorded in each owning document's `## Revision log`.

## Round 2 — 2026-10-19 (design, performance/scale)

| Reviewer | Focus | File | Findings |
|---|---|---|---|
| R2-A | Performance, concurrency, capacity envelope | [`round-2/R2-performance.md`](round-2/R2-performance.md) | 41 (7 Blocker, 11 High, 10 Medium, 6 observability, 7 Low) |

Key accepted design changes: ordered B-tree on partitioned ledgers (`created_at DESC, id DESC`) and a
7-day default ledger window; canonical `UPDATE … WHERE available >= qty` + `lock_timeout` for allocation;
two-phase outbox claim with parallel handlers; sampled request logging; split Redis queue/cache memory
budgets; channel-sync job batching; streaming exports with row caps. Capacity verdict: the single-host
OLTP envelope is feasible once those are implemented.
**R2 operational-feasibility review was folded into Round 3's install dry-run** (no separate file).

## Round 3 — 2026-10-20 (delivered code + handover)

| Reviewer | Focus | File | Findings | Verdict |
|---|---|---|---|---|
| R3-A | Red-team of delivered code | [`round-3/R3-redteam.md`](round-3/R3-redteam.md) | 40 (10 Blocker, 11 High, 12 Medium, 7 Low) | not releasable at review time |
| R3-B | Owner requirements + installability dry-run | [`round-3/R3-requirements-install.md`](round-3/R3-requirements-install.md) | 12 requirement rows, 16 false/unsupported claims, 9 install blockers | not handover-ready at review time |

### Round 3 remediation (applied on top of the reviewed commit)

| Finding | Status | Change |
|---|---|---|
| R3-A B-01 IdentityGuard not registered → all authenticated routes 401 | **fixed** | `app.module.ts` registers `IdentityGuard` as the first `APP_GUARD` (tenant context + session check), `PermissionsGuard` second |
| R3-A B-02 migration rejected: journal-balance function `RETURNS void` bound as constraint trigger | **fixed** | generator emits `RETURNS trigger` + `RETURN NEW;`; `0001_init.sql` regenerated |
| R3-A B-03 journal post fails: `account_balances.dimension_value_id` does not exist | **fixed** | dimension filters/inserts removed from `journal.repository.ts` |
| R3-A B-04 seeded admin cannot log in (scrypt seed vs Argon2-only verify) | **fixed** | `password.service.ts` verifies seeded `scrypt$…` hashes and Argon2id for new passwords |
| R3-B B1 `gen-secrets.sh` broken escape (unmatched backtick) | **fixed** | script repaired; production mode now also sets `SMS_MODE=limo` and a real `CORS_ORIGINS` |
| R3-B B2 boot guards reject blanked `MIGRATION_DATABASE_URL` | **fixed** | env schema accepts empty value (file-based `*_FILE` in compose); API no longer requires DDL URL |
| R3-B B3 `migrate` service runs nonexistent `pnpm db:migrate` | **fixed** | service runs `node /app/packages/db/dist/migrate.js`; API image ships `@saman/db` |
| R3-B B4 production image lacks `packages/db` / migrations in wrong path | **fixed** | Dockerfile copies + builds `packages/db`, ships `dist/` + `drizzle/`; `migrate`/`seed` resolve migrations relative to the package |
| R3-B B5 DDL runs with the runtime role | **fixed** | `migrate`/`seed` prefer `MIGRATION_DATABASE_URL(_FILE)`; compose passes the migrator secret |
| R3-B B6 no git tag | **fixed** | `v1.0.0` tag published with this commit |
| R3-B B7 env appendix/var drift, B8 health expectations, B9 uid parity | **partially fixed / documented** | `.env.example` is canonical; remaining doc drift listed in `09-roadmap` TD-01/TD-13 |
| R3-B F11 missing user guide | **fixed** | `docs/08-user-guide/GUIDE-FA.md` added |
| R3-B F1-F10 false ROADMAP claims | **fixed** | `09-roadmap/ROADMAP.md` rewritten with truthful per-area statuses |
| R3-A B-05 `@Audited` no consumer; B-06 OTP replay race; B-07 step-up guard absent; B-08 maker-checker threshold race; B-09 no ScopeGuard (cross-warehouse IDOR); B-10 closed-period via body date; H-01 audit chain content; H-02 shared DB passwords; H-06 SMS delivery path | **open — v1.1 release blockers** | tracked in `09-roadmap` TD-14…TD-20; do **not** treat the system as production-ready until closed |

**Round-3 verdict after remediation:** the reviewed blockers that prevented *schema creation, login and
basic journal posting* are fixed; the remaining open items above are security/financial-control defects
that must be closed before real money moves. This repository is a **v1.0 engineering baseline**, not a
certified production system.

### Round 3 — additional runtime defects found while executing the SQL (2026-10-20)

Static review could not see these; a real PostgreSQL execution did. All are fixed and re-verified from a clean
database (17/17 checks in `docs/VERIFICATION.md` §6):

| ID | Defect | Fix |
|---|---|---|
| R3-RT-01 | GRANTs executed before the cluster roles were created → migration aborted | idempotent `CREATE ROLE` block emitted right after `CREATE SCHEMA` |
| R3-RT-02 | Bare `bigint` primary keys without identity/default → seed `not-null` violation | generator emits identity only for surrogate keys named `id` |
| R3-RT-03 | `ON CONFLICT` did not match partial unique indexes (`WHERE deleted_at IS NULL`) | seed repeats the predicate for soft-delete tables |
| R3-RT-04 | Seed hard-coded `organizations.id = 1`; identity sequence advanced by failed runs | organization id resolved at runtime |
| R3-RT-05 | `chain_audit()` could not resolve `public.digest()` under its `SECURITY DEFINER` search_path | all such functions use `search_path = erp, public, pg_temp` |
| R3-RT-06 | `audit_chain_heads.organization_id` wrongly generated as identity | same identity-rule fix as R3-RT-02 |

### Round 3 — defects found by booting the compiled API (2026-10-20)

Running the real server against the real database surfaced integration defects that neither typecheck nor
static review could catch (all fixed except the last):

| ID | Defect | Fix |
|---|---|---|
| RT-E2E-01 | circular import TDZ in `notifications.module.ts` | import hoisted to the top |
| RT-E2E-02 | Fastify could not load `ajv@8` (hoisted `ajv@6` from ESLint won) | `ajv@^8` added to `apps/api` dependencies |
| RT-E2E-03 | module exported `NOTIFICATION_SMS_PORT` without providing it | export removed pending a real binding |
| RT-E2E-04 | 87 DI classes imported with `import type` → Nest resolved `Function` | value imports (46 files) |
| RT-E2E-05 | `DB`/`REDIS` tokens exposed the provider wrapper, not the client | factory aliases |
| RT-E2E-06 | 440 SQL statements used non-existent `erp.<module>.` schema prefixes | normalised to `erp.` |
| RT-E2E-07 | `/auth/me` and self-service routes rejected by default-deny | `@AuthenticatedOnly()` + guard support |
| **TD-24** | write repositories reference columns absent from the implemented schema | **open — v1.1 blocker** |

### Round 3 — write-path/E2E integration pass (2026-10-20, later run)

| ID | Defect | Status |
|---|---|---|
| RT-E2E-08 | accounting journal endpoints used `BigInt(publicUuid)` → 500 | fixed: public-id resolution |
| RT-E2E-09 | BigInt arrays not serialised for `::bigint[]` (sales confirm 500) | fixed: string arrays |
| RT-E2E-10 | approval threshold read `system_settings.value` (real column `value_json`) | fixed |
| RT-E2E-11 | double `{data:{data}}` envelope on accounting controllers | fixed in ResponseInterceptor |
| RT-E2E-12 | warehouse location create without parent → 500 | fixed: 400 validation |
| RT-E2E-13 | verify script path after move | fixed |
| **TD-24** | 15 unknown tables + 12 missing column references | **closed** — schema + code aligned, drift checker = 0 |
| TD-26 | accounting DTOs still accept internal numeric ids for account references | open (v1.2) |
| TD-27 | full order→pick→pack→ship E2E needs location hierarchy + stock seeding | open (v1.2) |

### Round 4 — commerce spine + automatic posting (2026-10-20)

| ID | Finding | Status |
|---|---|---|
| RT-E2E-14 | pick-wave creation used public uuids as internal ids | fixed |
| RT-E2E-15 | adjustment posting hit dead `findBalance(…, '')` placeholder | fixed |
| RT-E2E-16 | worker composition missing platform providers / inject | fixed |
| RT-E2E-17 | `asRecord` dropped jsonb-string payloads → handlers got `{}` | fixed (critical) |
| RT-E2E-18 | adjustment accounting event lacked amounts + duplicated event type | fixed |
| RT-E2E-19 | accounting DTOs required internal ids for account refs | fixed (public uuid accepted) |
| TD-26 | accounting endpoints internal ids | **closed** |
| TD-28 | automatic journal posting not wired in worker | **closed** (inventory events) |
| TD-29 | transfer/valuation accounting payload parity | open |
| TD-30 | packing/shipping modules missing | open |

## Standing rules

- A finding may be **deferred** only if: it is not a blocker, the deferral is written in the owning
  document with a compensating control, and it appears in the roadmap debt ledger.
- Changes to accepted ADRs are recorded as dated revisions in that ADR, never silently.
- Re-review triggers: schema change to journal/audit/inventory/auth tables, new integration, new role
  class, any security incident, or a production incident postmortem.
