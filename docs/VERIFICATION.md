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


---

## 7. Live API end-to-end against the real database (2026-10-20)

The compiled API (`apps/api/dist/main.js`) was booted against the verified PostgreSQL cluster
(`DATABASE_URL` → `saman_app` role, `MIGRATION_DATABASE_URL` → `saman_migrator`) with
`APP_ENV=development`, `SMS_MODE=mock`, and no Redis (Redis-backed rate limits/queues were disabled or
degraded; `/health/ready` correctly reports `redis` down).

```text
GET  /health/live                    200  {"status":"ok"}
GET  /health/version                 200  {name,version,env,commit}
POST /api/v1/auth/login              202  {mfaRequired:true, challengeId, methods:["otp_sms"]}
POST /api/v1/auth/otp/verify         200  {accessToken, refresh cookie, user}
GET  /api/v1/auth/me                 200  real user + 414-permission set
GET  /api/v1/products                200  {data:[], pagination}
GET  /api/v1/inventory/balances      200  {data:[], cursor pagination}
GET  /api/v1/audit-logs              200  real audit rows (from the earlier verification insert)
GET  /api/v1/roles                   200  seeded system roles
GET  /api/v1/settings                200  seeded settings
POST /api/v1/categories              500  ← schema-drift defect (see below)
POST /api/v1/products                400  correct Zod validation error (nameFa/categoryId/variants/unitId)
```

**Proven by this run:** configuration boot-guards, Fastify pipeline, default-deny guard, JWT + OTP + device
challenge flow, session/permission loading from PostgreSQL, tenant context, RBAC-protected reads, pagination
envelopes, Persian error envelopes with `requestId`, real SQL against every read path exercised, and the
audit read model.

### Defects found by running the compiled API (fixed in this commit)

| ID | Symptom | Root cause | Fix |
|---|---|---|---|
| RT-E2E-01 | `Cannot access 'notifications_service_2' before initialization` at boot | import placed after the decorator that uses the token | import moved to the top (`notifications.module.ts`) |
| RT-E2E-02 | `Cannot find module 'ajv/dist/jtd'` | `ajv@6` hoisted for ESLint shadowing Fastify's required `ajv@8` | `ajv@^8` declared in `apps/api` dependencies |
| RT-E2E-03 | `Nest cannot export a provider that is not part of the module` | `NOTIFICATION_SMS_PORT` exported without a provider | export removed until a real SMS port binding lands |
| RT-E2E-04 | `Nest can't resolve dependencies … Function at index[3]` | 87 constructor-injected classes imported with `import type` (no runtime metadata) | converted to value imports across 46 files |
| RT-E2E-05 | `this.sql is not a function` on login | `DB`/`REDIS` tokens aliased the provider wrapper via `useExisting` | factories expose `provider.client` |
| RT-E2E-06 | `cross-database references … "erp.inventory.inventory_balances"` | 440 SQL statements used per-module schema prefixes that do not exist | normalised to the single `erp.` schema |
| RT-E2E-07 | `403 missing_permission_metadata` on `/auth/me` | self-service routes declare no business permission | new `@AuthenticatedOnly()` + guard support, applied to the auth controller |
| RT-E2E-08 | `column "image_file_id" of relation "product_categories" does not exist` on category create | write repositories were authored against an assumed column set; implemented schema differs | **OPEN — see TD-24** |

### Known open defect class (v1.1)

**TD-24 — write-path column drift.** Read paths, auth, RBAC and validation are verified end-to-end, but
several *write* SQL statements reference columns/tables that differ from the implemented schema (first
confirmed case: `product_categories.image_file_id`; the entity expects `image_file_id`, the migration
defines `name/name_en/path/level/sort_order/is_active/external_hint`). This must be closed by generating
repository column lists from the live schema (or moving the remaining modules to the typed `@saman/db`
client) and by running a write-path integration suite. It is tracked as **TD-24 / v1.1 release blocker**.


---

## 8. Schema-drift closure + write-path E2E (2026-10-20, later run)

### 8.1 New tool: `scripts/check-sql-schema.cjs`

Static typecheck cannot see SQL column drift. The new checker extracts every literal
`insert into erp.<table> (...)` and `update erp.<table> set ...` statement from the API sources and
compares the referenced columns with a live database's `information_schema`:

```text
before:  unknown tables: 15, statements with missing columns: 9  (12 column refs)
after :  unknown tables:  0, statements with missing columns: 0  (0 column refs)
         scanned 284 files, 303 insert/update statements, schema tables 226
```

### 8.2 Schema completion (10 tables + 6 columns)

Added to `packages/db/src/schema/spec.ts` and regenerated `drizzle/0001_init.sql`
(**226 tables**, previously 216):

- partners: `shareholders`, `shareholder_transactions`, `profit_distribution_runs`, `profit_distribution_lines`
- treasury: `bank_reconciliations`, `bank_reconciliation_lines`
- automation: `alert_rules`, `alert_events`, `fraud_flags`
- accounting: `accounting_document_links`
- columns: `product_categories.image_file_id`, `partner_accounts.account_type`, `refunds.customer_id`,
  `bank_accounts.branch_id`, `payments.executed_by/executed_at`, `export_jobs.finished_at`
- code aligned to existing columns where they already existed (`export_jobs.entity_type/filter_json/output_file_id`,
  `report_runs.output_file_id`), reservations/retention use `stock_reservations`, raw webhook bodies are not stored.

### 8.3 Fresh-database verification after the schema change

```text
create database saman_v5 → migrate 0001_init.sql (226 tables) → seed (idempotent)
scripts/verify-db.cjs .................. 17/17 checks PASS
scripts/check-sql-schema.cjs ........... 0 drift
```

### 8.4 Write-path end-to-end (real HTTP against the live DB)

```text
POST /api/v1/auth/login                202  MFA challenge
POST /api/v1/auth/otp/verify           200  access token
POST /api/v1/categories                201  real category (code/name/path/level)
POST /api/v1/products                  201  product + variant (`PRD-…`, slug, variant SKU)
GET  /api/v1/products/:id              200
POST /api/v1/customers                 201  customer with generated customer_no
POST /api/v1/warehouses                201  warehouse with generated code
POST /api/v1/users                     201  admin user created (must_change_password)
POST /api/v1/accounting/journal-entries 201 draft journal (balanced)
POST …/journal-entries/:id/submit      201 → status `pending_approval`
POST …/journal-entries/:id/approve     403 "تأییدکننده نمیتواند ایجادکننده باشد"  ← maker-checker works
POST /api/v1/sales-orders              201  draft order
POST …/sales-orders/:id/submit         200  submitted
POST …/sales-orders/:id/confirm        422  INSUFFICIENT_STOCK (correct: reservation path ran, no stock yet)
DB after writes: products/variants/customer/warehouse/user rows present,
                 audit_logs incremented, outbox_events incremented (7 events)
```

### 8.5 Defects found and fixed in this run

| ID | Defect | Fix |
|---|---|---|
| RT-E2E-08 | `accounting` journal endpoints converted the URL uuid with `BigInt()` → 500 on every submit/post/reverse/update | `JournalService.resolveId()` resolves `public_id → id`; 12 controller call sites updated |
| RT-E2E-09 | `sales confirm` 500: `any(${bigintArray}::bigint[])` — postgres.js does not serialise BigInt arrays into a Postgres array | arrays mapped to strings before interpolation (inventory, warehouse, valuation) |
| RT-E2E-10 | journal post 500: approval-threshold query selected `system_settings.value` (column is `value_json`) | query fixed to `value_json #>> '{}'` |
| RT-E2E-11 | double response envelope `{data:{data:…}}` on accounting endpoints | ResponseInterceptor merges controller-level envelopes |
| RT-E2E-12 | warehouse location create with missing parent → 500 invalid uuid | explicit `VALIDATION_ERROR` "انتخاب مکان والد الزامی است" |
| RT-E2E-13 | `verify-db.cjs` broke after being moved into `scripts/` | require resolved relative to `__dirname` |

**Still open (next round):** accounting endpoints accept *internal* numeric ids for account references in
some DTOs (contract says public uuid) — tracked as TD-26; full order→pick→pack→ship flow needs stock seeded
via the location hierarchy (TD-27); Docker/Redis still unverified (TD-01/TD-25).


---

## 9. Full commerce spine + automatic journal posting (2026-10-20, round 2)

### 9.1 Stock and reservation chain (real HTTP + PostgreSQL)

```text
warehouse hierarchy seeded (zone → aisle → rack → shelf → bin → location)
POST /inventory/adjustments            201  ADJ-2026-000002 (draft)
POST …/adjustments/:id/submit          200  approved (auto, no approval needed)
POST …/adjustments/:id/post            200  applied
GET  /inventory/balances               200  on_hand = 10.0000, location + SKU correct
DB: inventory_transactions = 1, inventory_balances = 1

POST /sales-orders                     201  draft
POST …/sales-orders/:id/submit         200
POST …/sales-orders/:id/confirm        200  orderNo SLS-2026-000001, reservation created (stock_reservations = 1)
POST /pick-waves                       201  WAV-000001
POST /pick-waves/:id/release           200  released
POST /pick-tasks/:id/start             200
POST /pick-tasks/:id/scans             200  task → picked (barcode verified against product_barcodes)
```

`confirm` with no stock correctly returns **422 INSUFFICIENT_STOCK** — the reservation
planner is real, not a stub.

### 9.2 Automatic double-entry posting from the outbox

The worker now wires `PostingService` into the outbox dispatcher and posts
inventory accounting events transactionally:

```text
event 32  inventory.adjustment.posted  (kind=count_gain, totalCostAmount=160000)
→ worker handler → PostingService.postEventIsolated
→ journal JV-1405-000001  entry_date 2026-10-20  Dr 160,000 / Cr 160,000
   source_type=stock_adjustment  description «تعدیل موجودی (count_gain)»
→ account_balances rows = 2
→ outbox row processed, no dead-letter
```

### 9.3 Defects found and fixed in this round

| ID | Defect | Root cause | Fix |
|---|---|---|---|
| RT-E2E-14 | `POST /pick-waves` 500 | warehouse passed **public uuid** to `toBigInt` and to `listReservations(sourceId)` which expects internal key | `SalesService.resolveOrderId()` + internal source id |
| RT-E2E-15 | `POST /inventory/adjustments/:id/post` 500 | dead `findBalance(tx, orgId, '')` placeholder calls in `postMovement` | removed dead calls |
| RT-E2E-16 | worker would not boot | `WorkerModule` did not import `PlatformModule`/`ConfigModule`/`LoggingModule`; `PostingService` missing from inject list (`undefined.postEventIsolated`) | imports + inject fixed |
| RT-E2E-17 | every outbox handler saw `{}` payload | `asRecord()` returned `{}` for a `jsonb` **string** (driver-dependent) | parse JSON strings in `asRecord` |
| RT-E2E-18 | adjustment events unpostable | emitter sent `{adjustmentId, ledgerIds}` without amounts, and emitted a second amount-less domain event with the **same** event type; posting rule also rejects a uuid in `adjustmentId` (`optionalId` needs an internal id) | single canonical event with `adjustmentId` (internal), `kind`, `totalCostAmount`, `businessDate`, domain fields |
| RT-E2E-19 | accounting journal endpoints used internal numeric ids | `Id = /^\d+$/` in accounting DTOs | `resolveAccountId()` accepts public uuid **and** legacy numeric; 12 controller call sites resolved public ids |

### 9.4 Still open

- transfer/valuation accounting events still emit domain payloads with the same event type
  (same class as RT-E2E-18) — **TD-29**.
- packing/shipping/label endpoints do not exist yet (pick is the last implemented step) — **TD-30**.
- Docker/Redis/PG16 on a real host still unexecuted — TD-01/TD-25.


---

## 10. Step-up enforcement, atomic OTP and transfer accounting (2026-10-20, round 3)

### 10.1 Step-up guard (global, fail-closed)

`@RequireStepUp(action)` + `StepUpGuard` registered as the third global guard.
The proof must be a `step_up` JWT bound to the caller and the current session,
carry the exact action, and be at most 300 s old.

```text
POST /accounting/journal-entries/:id/approve   without header → 401 STEP_UP_REQUIRED
POST /accounting/journal-entries/:id/post      without header → 401 STEP_UP_REQUIRED
POST /auth/step-up {action, password}          → 200 stepUpToken
POST …/approve  with x-step-up-token            → guard passes → 403 (SoD: approver ≠ creator)
POST …/post     with approve-action token       → 401 STEP_UP_REQUIRED (action mismatch)
```

Decorated routes: journal approve/post/reverse, adjustment approve/post/void,
user reset-password/roles, settings update.

### 10.2 OTP single-use (atomic)

`consumeOtpChallenge()` is a conditional `UPDATE … WHERE consumed_at IS NULL
AND status IN ('pending','verified') RETURNING id`; a losing concurrent request
gets `OTP_INVALID`.

```text
verify correct code            → 200 access token
replay the same challenge      → 422 OTP_INVALID
```

### 10.3 Inter-warehouse transfer accounting (TD-29)

Dispatch stores the movement unit cost on the line, the receipt reuses it, and
each side emits one canonical accounting event:

```text
TRF-2026-000002: submit → approve → dispatch → receive   all 200
line unit_cost_amount = 113636
JV-1405-000003  ارسال بین انبارها (کالای در راه)   Dr 113,636
JV-1405-000004  دریافت بین انبارها                 Dr 113,636   (goods-in-transit cleared)
outbox: all processed
```

Valuation runs now only emit an accounting event when the GL variance is non-zero
(the rule rejects a zero variance by design); noted as TD-31 (variance needs a
prior-GL snapshot to be meaningful).

### 10.4 Still open

- ScopeGuard (branch/warehouse row-level enforcement) — TD-32.
- Packing/shipping modules — TD-30.
- Docker/Redis/PG16 host verification — TD-01/TD-25.


---

## 11. Fulfillment: packing → shipment → dispatch → delivery (2026-10-20, round 4)

New module `sales/fulfillment` (8 endpoints) over the already-modelled
`packing_tasks`, `packing_scans`, `shipments`, `shipment_packages`,
`shipment_package_lines`, `shipment_events` tables.

```text
POST /fulfillment/packing-tasks {orderId}        201  task pending, order → picking
POST /fulfillment/packing-tasks/:id/scans        200  barcode accepted (product_barcodes)
POST /fulfillment/packing-tasks/:id/complete     201  shipment SHP-2026-000001, package PKG-E2E-1, order → packed
POST /fulfillment/shipments/:id/dispatch         200  sale_issue ledger row, reservation released, order → shipped
POST /fulfillment/shipments/:id/deliver          200  shipment delivered (tracking TRK-12345), order → delivered

DB after: sales_orders.status = delivered
          shipments.status = delivered, tracking_code = TRK-12345
          inventory_transactions(sale_issue) = 1
          posted journal JV-1405-000005  «خروج موجودی و شناسایی بهای تمامشده»  Dr 227,272
```

That closes the loop **order → reserve → pick → pack → ship → COGS journal →
deliver**, with the accounting entry produced by the worker from the inventory
event (not by the controller).

### 11.1 Defects found and fixed in this round

| ID | Defect | Root cause | Fix |
|---|---|---|---|
| RT-E2E-23 | `create packing task` 500 | `setOrderStatus` wrote non-existent `shipped_at`/`delivered_at` on `sales_orders` | status/fulfillment_status/version only; shipment timestamps live on `shipments` |
| RT-E2E-24 | `create packing task` 500 | outbox requires the internal bigint aggregate id; public uuid rejected | emit internal ids, public ids stay in payload |
| RT-E2E-25 | `dispatch` 500 | repository joined `erp.carriers` (real table: `shipping_carriers`) | table name corrected |
| RT-E2E-26 | shipment status flow | new module had no schema-drift checks | `scripts/check-sql-schema.cjs` re-run: **0 drift** |

### 11.2 Still open

- ScopeGuard (branch/warehouse row-level enforcement) — TD-32.
- Procurement & pricing modules — TD-33.
- Docker/Redis/PG16 host verification — TD-01/TD-25.
- Carrier rate selection / label PDF — TD-34.
