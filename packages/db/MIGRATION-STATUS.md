# @saman/db — implementation status (v1.1, offline profile)

Status: **core spine implemented and verified in the offline build environment.** 201 of the 215 documented tables are generated; 15 are explicitly deferred (see §4). No PostgreSQL server is available in this environment, so migration *execution* is unverified; everything that can be checked offline is checked (§3).

## 1. What exists

```
packages/db/
  package.json                  @saman/db, scripts: build/generate/migrate/seed/create-admin/reset/typecheck/validate:sql
  tsconfig.json                 extends ../../tsconfig.base.json (strict), emits dist/*.js + .d.ts
  drizzle.config.ts             Drizzle-kit config placeholder (see §2 deviation)
  drizzle/0001_init.sql         1,348-line hand-shaped migration generated from the schema manifest
  scripts/generate.mjs          schema manifest → SQL + permission registry + CoA manifest
  scripts/validate-sql.mjs      offline structural SQL validator (no server needed)
  scripts/deferred.mjs          doc-vs-implementation table diff
  src/schema/spec.ts            201-table typed manifest (single source of truth for DDL/seed)
  src/generated/permissions.ts  414 keys generated from docs/03-api-contract/API.md §5.2
  src/generated/coa.ts          169-row CoA manifest generated from DATA-MODEL §6.3
  src/client.ts                 postgres.js client (lazy CJS load; clear error when driver absent)
  src/migrate.ts                forward-only SQL migration runner + checksum drift protection
  src/seed.ts                   idempotent seed: org, permissions(414), 8 roles+grants, CoA, units,
                                conversions, tax rates, fiscal year+periods, numbering, price list,
                                channels/accounts, settings, partition registry, enum values, admin
  src/crypto.ts                 bootstrap password hashing (scrypt) + sha256 helper
  src/cli/create-admin.ts       create/reset admin account (role assign, permissions_version bump)
  src/cli/reset.ts              destructive reset (--yes): drop erp → migrate → seed
  src/index.ts                  public exports
```

Migration contents: `pgcrypto` + `btree_gist`; schema `erp`; 201 tables with named `pk_/fk_/uq_/ck_/ix_` constraints; 127 FKs; 33 CHECKs; 319 indexes incl. BRIN on the 5 partitioned parents; 5 partitioned parents + default + 2 future month partitions each; `set_updated_at`/`bump_version` triggers on all mutable tables; deferred `CONSTRAINT TRIGGER` enforcing journal balance at COMMIT; `derive_journal_period` trigger; `EXCLUDE USING gist` fiscal-year/period non-overlap; `allocate_document_no`; `chain_audit` (SECURITY DEFINER); `ensure_month_partition`/`maintain_partitions`/`drain_default_partition` (SECURITY DEFINER, identifier-safe, advisory-locked, worker-only EXECUTE); grants manifest (app no DELETE, readonly revoked from secret/PII tables).

## 2. Deviations from the original task-6 spec (honest)

1. **Drizzle-orm / drizzle-kit are not installed and cannot be installed here** (`pnpm install --offline` fails: `ERR_PNPM_NO_OFFLINE_META Failed to resolve postgres@>=3.4.9`; registry.npmjs.org is unreachable). The schema is therefore a typed, framework-neutral manifest (`src/schema/spec.ts`) and the SQL migration is generated deterministically from it (`scripts/generate.mjs`), instead of Drizzle `pgTable` objects. `drizzle.config.ts` documents the exact path to switch when the dependency is installable (generate Drizzle schema 1:1 from the manifest). `pnpm --filter @saman/db build` is green without network.
2. `postgres` (runtime driver) is declared in `package.json` but not installed; `client.ts` loads it lazily and throws `DATABASE_DRIVER_MISSING` with a clear message. Install is a normal `pnpm install` on a networked host.
3. Bootstrap/reset password hashing is **scrypt** (offline, dependency-free) with an explicit format (`scrypt$N$r$p$salt$hash`). Production should migrate to Argon2id (ADR-0004) — the seed marks `must_change_password=true` and `create-admin` never returns secrets beyond the printed one-time password in the CLI.
4. `drizzle-kit generate` was not run (dependency unavailable); `drizzle/0001_init.sql` is hand-shaped and covered by `scripts/validate-sql.mjs` instead.

## 3. Verification evidence (exact commands run in this environment)

| Command | Result |
|---|---|
| `node --experimental-strip-types scripts/generate.mjs` | `wrote drizzle/0001_init.sql (1348 lines)`, `permissions.ts (414 keys)`, `coa.ts (169 rows: {"L1":5,"L2":10,"L3":60,"L4":94})` — exit 0; second run produces identical SHA-256 (deterministic) |
| `node scripts/validate-sql.mjs` | `{"specTables":201,"createTables":201,"partitioned":5,"defaultPartitions":5,"indexes":319,"triggers":314,"fks":127,"checks":33,"functions":10,"partitionsChildren":10}` → **VALIDATION OK** (no duplicate columns, no unresolved FK/index/trigger tables, PKs present, balanced parens/dollar quotes, required functions/triggers/partitions/grants present) |
| `node <typescript>/bin/tsc -p tsconfig.json` (`pnpm --filter @saman/db build` equivalent) | exit 0; `dist/` contains 11 emitted modules (`index.js`, `migrate.js`, `seed.js`, `client.js`, `crypto.js`, `cli/*.js`, `schema/*.js`, `generated/*.js`) + 11 `.d.ts`. In this partially-installed workspace the TS binary and `@types/node` are resolved from `apps/api/node_modules` via `typeRoots` fallbacks; a normal `pnpm install` restores the default resolution. |
| `node -e "require('./dist/index.js')"` runtime smoke | `tables 200→201, perms 414, coa {"L1":5,"L2":10,"L3":60,"L4":94}`, `verifyPassword(hashPassword('x')) === true` |
| `pnpm install --ignore-scripts` | **blocked offline** (registry unreachable; see §2). `pnpm-lock.yaml` is also stale vs `packages/shared/package.json` (another owner's scope) — recorded here rather than edited outside `packages/db/**`. |

**Not verified here (requires PostgreSQL):** migration execution, trigger/constraint runtime behaviour, seed against a real DB, `EXPLAIN` on partitioned queries, grants (`\dp`) diff. These are the first CI steps once a DB is available (`docker compose up -d postgres && pnpm db:migrate && pnpm db:seed` twice, then the invariant tests in `docs/05-testing/TESTING.md`).

## 4. DEFERRED tables (not in `0001_init.sql` yet)

Implemented: 201. Documented: 215 (the doc contains one duplicated reference block for `posting_rule_sets`; unique = 214). Deferred (15), all in accounting/reporting/automation, additive and non-blocking for the core spine:

`accounting_document_types`, `accounting_document_links`, `budgets`, `budget_lines`, `expense_categories`, `expenses`, `bank_reconciliations`, `bank_reconciliation_lines`, `business_rules`, `alert_rules`, `alert_events`, `fraud_flags`, `profit_distribution_runs`, `profit_distribution_lines`, `dashboard_kpi_snapshots`.

Reason: they are leaves of the accounting/reporting/automation modules that depend on implementation choices in those services (report SQL templates, approval-config flow, alert engine) and do not block identity/catalog/inventory/sales/procurement/fulfillment/treasury/channels/platform construction. **Status: DEFERRED with owner = accounting/reporting implementation phase (P4/P6); next migration `0002_accounting_reporting.sql` will add them (the manifest generator already supports them; add specs, run `pnpm --filter @saman/db generate`).**

Also deferred (non-schema): matviews/views from DATA-MODEL §5.4 (own migration `0003_views.sql` when query shapes are final — the doc defines them, no schema drift), and the `saman_*` role passwords/LOGIN grants (migration creates NOLOGIN roles; ops sets credentials via `ALTER ROLE ... PASSWORD`).

## 5. How to finish on a networked/PostgreSQL host

```bash
pnpm install --ignore-scripts            # installs postgres driver (+ drizzle if added later)
pnpm --filter @saman/db generate         # regenerate SQL from manifest (deterministic)
pnpm --filter @saman/db build            # tsc
export DATABASE_URL=postgres://saman_migrator@localhost:5432/saman
pnpm --filter @saman/db migrate          # applies drizzle/0001_init.sql in one transaction
pnpm --filter @saman/db seed             # prints bootstrap admin credentials once
pnpm --filter @saman/db create-admin -- --username ops --mobile 09121234567 --role admin
pnpm --filter @saman/db reset -- --yes   # dev only
```
