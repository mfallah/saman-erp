# Verification evidence (v1.0 build)

**خلاصهٔ فارسی:** این سند «چه چیزی واقعاً تست شد» را از «چه چیزی فقط طراحی/بازبینی شده» جدا می‌کند.
هدف: هیچ ادعای سبزی بدون خروجی فرمان ثبت نشود.

Build environment: Windows 11 sandbox · Node 22.18 · pnpm 11.6 · **no Docker daemon** · **no PostgreSQL server** ·
child-process spawning with piped stdio is denied for Node tools (esbuild/Vite/Vitest cannot spawn services).
These constraints are why some checks are marked *not verified here*.

---

## 1. Checks executed in this environment

| # | Check | Command (from repo root) | Result |
|---|---|---|---|
| V-01 | Shared contracts typecheck + build | `node node_modules/typescript/lib/tsc.js -p packages/shared/tsconfig.json` | **exit 0** |
| V-02 | Database package typecheck + build | `node node_modules/typescript/lib/tsc.js -p packages/db/tsconfig.json` | **exit 0** (11 JS + 11 d.ts in `dist/`) |
| V-03 | API typecheck | `node node_modules/typescript/lib/tsc.js -p apps/api/tsconfig.json --noEmit` | **0 errors** |
| V-04 | API compile (emit) | `node node_modules/typescript/lib/tsc.js -p apps/api/tsconfig.build.json` | **exit 0**; `dist/main.js` + `dist/worker.js` produced |
| V-05 | Web typecheck | `node node_modules/typescript/lib/tsc.js -p apps/web/tsconfig.json --noEmit` | **0 errors** |
| V-06 | Web production build | `cd apps/web && node ../../node_modules/vite/bin/vite.js build --configLoader native` | **exit 0**, 1,921 modules, 11.3 s, 25 lazy chunks, `dist/` emitted (review-agent executed; sandbox-adapted config) |
| V-07 | Shared unit tests | `tsc -p packages/shared/tsconfig.test.json && node packages/shared/dist-test/test/run.js` | **43 pass / 0 fail** (16 suites) |
| V-08 | API platform tests | `tsc -p apps/api/tsconfig.test.json && node apps/api/dist-test/test/run.js` | **20 pass / 0 fail**; HTTP/DB-dependent specs skipped unless `TEST_HTTP_APP=1` |
| V-09 | Web unit tests | `cd apps/web && node ../../node_modules/vitest/vitest.mjs run --configLoader native` | **28 pass / 0 fail** (6 files) |
| V-10 | Web lint | `node .../eslint/bin/eslint.js apps/web --max-warnings=0` | **exit 0** |
| V-11 | SQL generation determinism | `node --experimental-strip-types packages/db/scripts/generate.mjs` (twice) | identical SHA-256; 1,348-line `drizzle/0001_init.sql`, 414 permission keys, CoA manifest |
| V-12 | SQL static validation | `packages/db/scripts/validate-sql` (in-package) | **VALIDATION OK** — 201 tables, 5 partitioned parents + default partitions, 319 indexes, 314 triggers, 127 FKs, 33 CHECKs, 10 functions |
| V-13 | Permission registry parity | registry generated from `docs/03-api-contract/API.md §5.2` vs `docs/02-data-model/DATA-MODEL.md §6.2` | **414/414 exact**, 131/131 resource lines identical |
| V-14 | Domain engine suites (broker-run shim) | module `__tests__` executed with a vitest-compatible shim outside the repo | **commerce 278 pass / 0 fail** (allocation/oversell, FIFO layers, sales FSM, warehouse scans) · **finance 135 pass / 0 fail** (45-event posting matrix, VAT/GRNI/settlement, closing, cheque FSM, rounding) |
| V-15 | YAML/Compose static validation | `python scripts/validate-config.py` (review-agent) | all compose/dev/prod, workflows, prometheus/alert/Grafana YAML parsed; contract assertions pass |
| V-16 | Repo hygiene | `git status`, secrets scan (`gitleaks` config present) | no `.env`, no secrets committed; `.env.example` placeholders only |

## 2. NOT verified in this environment (must be the first CI/host run)

| Area | Why | First-run command |
|---|---|---|
| `docker compose config -q` / `docker build` / stack boot | no Docker daemon | CI job `compose-config` + `docker-build`; host: `docker compose up -d --build` |
| Migration execution against PostgreSQL | no server | `docker compose --profile tools run --rm migrate` |
| Seed idempotency (`db:seed` twice) | needs DB | `... run --rm migrate pnpm db:seed` (twice) |
| Constraint/trigger runtime (journal balance, hash chain, partitions, `\dp` grants) | needs DB | integration suite `TEST_DATABASE_URL=... pnpm test:int` |
| Full E2E (login → product → stock → order → pick/pack → journal → trial balance) | needs running stack | Playwright CI job |
| k6 load/soak thresholds | needs reference host | `k6 run tests/load/*` on 4 vCPU/8 GB |
| Digikala sandbox certification | needs seller credentials | adapter `TBD-DIGIKALA` endpoints stay feature-flagged |

## 3. What this build is

- **280** TypeScript files / ~51.6k lines in `apps/api` (15 controllers, **324 routes**, 42 services, 33 repositories, 30 spec files)
- **88** files / **23** screens in `apps/web` (React 19 + Vite, Persian RTL)
- **216** tables in generated SQL (**201** implemented in `packages/db`, 15 deferred per `MIGRATION-STATUS.md`)
- **33** documentation files / ~11.9k lines; 3-round review trail in `docs/_review/`
- Docker/Compose/CI/reverse-proxy/backup/monitoring configuration and a Persian installation guide

## 4. Release gate for the owner's server

```bash
# 1) install (per docs/06-deployment/INSTALL-FA.md)
cp .env.example .env && ./scripts/gen-secrets.sh          # fill DOMAIN, CMS secrets
docker compose up -d --build
docker compose --profile tools run --rm migrate
docker compose --profile tools run --rm migrate pnpm db:seed
# 2) verify
curl -fsS http://127.0.0.1:8080/health/live
curl -fsS http://127.0.0.1:8080/health/ready
./scripts/smoke.sh                                       # login + RBAC + health
# 3) backup drill
docker compose --profile backup up -d backup && ./scripts/restore-drill.sh
```

A green result of §4 on the target host is the acceptance criterion for v1.0 deployment; §1 is what has
been machine-verified so far.


---

## 5. Post-review remediation (2026-10-20, after Round-3)

Round-3 found four code-level release blockers. Fixes applied and re-verified:

| Fix | Change | Evidence |
|---|---|---|
| R3-A B-01 | `IdentityGuard` registered as the first global `APP_GUARD` (session/permission-version check + tenant context); `PermissionsGuard` second | `apps/api/src/app.module.ts`; full API typecheck/build **0 errors** |
| R3-A B-02 | Journal-balance function now `RETURNS trigger` (`RETURN NEW;`), SQL regenerated | `packages/db/drizzle/0001_init.sql`; generator deterministic |
| R3-A B-03 | Removed nonexistent `account_balances.dimension_value_id` from journal posting SQL | `journal.repository.ts`; grep count 0 |
| R3-A B-04 | Password verification accepts seeded `scrypt$…` hashes **and** Argon2id | `password.service.ts` |
| R3-B B1–B5 | `gen-secrets.sh` parse error fixed; production `SMS_MODE=limo`/real origin; API image ships `@saman/db`; `migrate` service runs compiled runner; `migrate`/`seed` resolve `MIGRATION_DATABASE_URL(_FILE)` and the package-relative `drizzle/` dir | `scripts/gen-secrets.sh`, `infra/docker/api.Dockerfile`, `docker-compose.yml`, `packages/db/src/{migrate,seed}.ts` |
| R3-B F11 | Persian user guide added | `docs/08-user-guide/GUIDE-FA.md` |
| R3-B F1–F10 | Roadmap statuses rewritten truthfully; 11 new debt entries (TD-13…TD-23) for remaining gaps | `docs/09-roadmap/ROADMAP.md` |

Final machine-verified state after remediation (commands from §1, re-run):

```text
shared typecheck/build ........ exit 0
db typecheck/build ............ exit 0
api typecheck ................. 0 errors
api production build .......... exit 0 (dist/main.js, dist/worker.js)
web typecheck ................. 0 errors
shared unit tests ............. 43 pass / 0 fail
api platform tests ............ 20 pass / 0 fail
sql generation ................ deterministic (1,348-line migration, 414 permission keys)
```

**Still not verified here:** Docker stack boot, PostgreSQL migration/seed execution, E2E, load tests.
**Open release blockers (not security-certified):** TD-14…TD-21 in `09-roadmap/ROADMAP.md`.


---

## 6. Real PostgreSQL execution (2026-10-20)

Because the build environment has no Docker, a **local PostgreSQL 18.4 cluster** (binaries obtained via npm,
`initdb` + `postgres` on port 55432, trust auth, throw-away data dir) was used to execute the delivered
migration and seed for real. Script: [`scripts/verify-db.cjs`](../scripts/verify-db.cjs) (17 automated checks).

```text
$ MIGRATION_DATABASE_URL=postgres://postgres@127.0.0.1:55432/saman_verify node packages/db/dist/migrate.js
[migrate] applied 0001_init.sql
[migrate] done: applied=1 skipped=0

$ node packages/db/dist/seed.js        # run twice
[seed] done {permissions:414, chart_of_accounts:169, grants:1209, periods:12, channels:6, users:1, ...}

$ node scripts/verify-db.cjs
PASS  schema erp tables >= 200 — 216
PASS  helper functions >= 8 — 10
PASS  triggers attached >= 300 — 323
PASS  partitioned parents = 5 / partition children >= 15 — 5 / 111
PASS  saman_app has NO DELETE grant — 0
PASS  saman_readonly cannot read secret tables — 0
PASS  permissions seeded = 414
PASS  chart of accounts >= 160 — 169
PASS  role grants > 700 — 1209
PASS  bootstrap admin exists — admin
PASS  seeded admin password verifies via API password service — scrypt path OK
PASS  unbalanced posted journal rejected at commit — JOURNAL_UNBALANCED: entry 1 debit 200 <> credit 100
PASS  availability CHECK reserved+safety_buffer+damaged <= on_hand — ck_inventory_balances_available
PASS  audit hash chain executes — chained=1, hashed=1
PASS  worker can execute partition maintenance
PASS  journal balance constraint triggers exist
SUMMARY: 17/17 checks passed
```

### Runtime defects found by executing the SQL (and fixed in this commit)

These could **not** be found by static validation; all were fixed in `packages/db` and re-verified from scratch
on a clean database:

1. **Grants ran before the cluster roles existed** → `role "saman_worker" does not exist`. The migration now
   emits an idempotent `CREATE ROLE` block directly after `CREATE SCHEMA`.
2. **`permissions.id` (and other bare `bigint pk` columns) had no identity/default** → seed failed with a
   `not-null` violation. The generator now emits `GENERATED ALWAYS AS IDENTITY` for surrogate keys named `id`
   only (named PKs such as `audit_chain_heads.organization_id` stay caller-supplied).
3. **`ON CONFLICT (organization_id, code)` did not match partial unique indexes** (`…_active … WHERE deleted_at
   IS NULL`) → seed failed. Seed now repeats the partial-index predicate for soft-deleted master data, and
   leaves non-soft-delete tables (e.g. `fiscal_years`) without it.
4. **Seed assumed `organizations.id = 1`** while a rolled-back earlier seed advanced the identity sequence →
   FK violation on `roles.organization_id`. Seed now resolves the organization id from the database.
5. **`chain_audit()` could not resolve `digest()`** because its `SECURITY DEFINER` search_path omitted `public`
   (pgcrypto) → audit chain failed at runtime. All such functions now use `SET search_path = erp, public, pg_temp`.
6. **`audit_chain_heads.organization_id` was generated as identity** while `chain_audit()` inserts it explicitly
   → fixed by the same identity-rule change as (2).

**Compatibility note:** execution was verified on PostgreSQL **18.4** (the only binaries obtainable offline);
the target remains PostgreSQL **16**, so a PG16 run is still required in CI/release (tracked in ROADMAP TD-01).

### Still not executed here

Docker/Compose boot, Redis-backed paths (rate limits/queues), full API boot + HTTP login against the DB,
Playwright E2E and k6 load tests. Those remain the first items of the v1.1 verification round.
