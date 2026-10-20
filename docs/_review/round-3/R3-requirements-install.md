# Round 3 — Owner requirements coverage & installability dry-run

Reviewer: independent product/QA reviewer (fresh context) · Date: 2026-10-20
Scope: the **delivered working tree** at `F:\harness\saman-erp` (commit `3453e53`, branch `main`, 73 uncommitted deletions of build artifacts), not the design documents.
Method: read every required doc; then verified each claim against code, SQL, Compose, scripts and the actual runtime artifacts. Docker is **not installed in this environment**, so Compose/`up` claims are assessed statically and against file content; everything else below was executed or read directly.

Evidence base (counts measured in this repository):

| Fact | Value | How measured |
|---|---|---|
| API module directories | 15 (`apps/api/src/modules/*`), all 15 imported in `app.module.ts` | directory + import list |
| `@Controller` classes | **31** in 15 `*.controller.ts` files | grep `@Controller(` |
| Route decorators (`@Get/@Post/…`) | **324** | grep |
| Endpoints documented in `docs/03-api-contract/API.md` §4 | **766** | grep rows `` | `GET /…` `` |
| DB tables in delivered migration | **201** base tables (+15 partition children = 216 `CREATE TABLE`) | `packages/db/drizzle/0001_init.sql` |
| Tables declared deferred | **15** (accounting/reporting/automation leaves) | `packages/db/MIGRATION-STATUS.md` §4 |
| Migration files | **1** (`0001_init.sql`, 5,729 lines) | `packages/db/drizzle/` |
| API spec files exist | 31 (4 under `apps/api/test`, 27 under `src/modules/**/__tests__` + `workers`) | glob |
| API tests actually executed by `pnpm test` | **4 files / 20 tests** (`tsconfig.test.json` includes only `test/**/*.ts`) | ran `node dist-test/test/run.js` → 20 pass, exit 0 |
| Web screens | 23 page files, 24 routes: 19 real + 4 "coming soon" + forbidden | `apps/web/src/router.tsx` |
| Git release tags | **none** (`git tag` is empty) | `git tag` |

---

## Requirements coverage

Owner requirement → delivered?

| # | Owner requirement | Delivered? | Evidence |
|---|---|---|---|
| R1 | Persian omnichannel ERP for Carexy Shop, target `erp.carexy.shop` | **partial** | Persian/RTL SPA exists (`apps/web`, Vazirmatn, `dir="rtl"`), domain strings are Persian; but only 19 of the planned screens work end-to-end and 9 of the 19 API groups in the contract have no controller (§Gaps). `APP_URL`/`DOMAIN`/Caddy are wired for `erp.carexy.shop` (`docker-compose.yml:378`, `infra/nginx/Caddyfile`). |
| R2 | 10k+ SKUs, high daily transactions | **partial** | Schema is designed for it (BRIN + monthly partitions, 319 indexes, 201 tables in `packages/db/drizzle/0001_init.sql`; `docs/02-data-model/DATA-MODEL.md`). No load/perf evidence exists: `docs/09-roadmap/ROADMAP.md:30` marks load evidence 🟡 "results pending"; no k6 scripts are present in the repo. |
| R3 | Full Docker deployment on own server | **partial / not runnable** | Complete 12-service Compose stack + Dockerfiles + nginx/Caddy/MinIO/backup/observability configs exist (`docker-compose.yml`, `infra/**`). It **cannot be brought up as documented** — see §Install blockers (B1–B7). Docs themselves admit no `docker compose config/up` was ever executed (`docs/06-deployment/DEPLOYMENT.md:6`, `INSTALL-FA.md:9`). |
| R4 | PostgreSQL install + connection documented | **yes (docs) / partial (execution)** | Strongest part of the delivery: two topologies (Compose §8, external/managed §9), 5-role least-privilege model, `ALTER DEFAULT PRIVILEGES`, pg_hba/TLS, tuning, backup/restore. But the runtime role used by the delivered migration code is wrong (§B5) and the init contract text points at a non-existent `01-init.sh` (`INSTALL-FA.md:544`; actual file is `init/01-init.sql`). |
| R5 | Security | **partial** | Helmet/CSP/HSTS/rate-limit/CSRF/refresh-rotation, default-deny permission guard (`apps/api/src/config/env.schema.ts:324`, `common/guards/permissions.guard.ts`), prod boot-guards that refuse weak secrets, `SECURITY.md` + `THREAT-MODEL.md`, non-root read-only containers. Gaps: no RLS (declared TD-02), no users/roles/session-revocation API (so RBAC cannot be administered at runtime), `pg_hba.conf` allows `0.0.0.0/0` scram (fine only because no port is published). |
| R6 | Private GitHub repo | **no / unverifiable** | `origin` is `https://github.com/mfallah/saman-erp.git` (public URL form); no evidence of privacy, no release tag, no signed CI run. A non-expert cannot clone a private repo without credentials — the install guide assumes `git clone` over HTTPS with no auth step (`INSTALL-FA.md:242`). |
| R7 | API docs for Carexy / Digikala / Limo SMS used | **yes (docs)** | `API.md` §8.2 Carexy (`X-API-KEY`), §8.3 Digikala OAuth2 (264-endpoint catalog), §8.4 Limo (`ApiKey` header); adapters and `limo.client.ts` implement the header/flow. Digikala mapping is contract-pinned only (roadmap v1.1 item 3). |
| R8 | Inventory/WMS | **partial (best module)** | Ledger, balances, reservations, transfers, adjustments, counts (`inventory.controller.ts`), location tree/putaway/pick-tasks/waves/packing (`warehouse.controller.ts`, 5 controllers' worth of routes), FIFO engine + specs. No lot/serial admin UI, no cycle-count UI, no scanner routes beyond pick/pack pages. |
| R9 | Orders | **partial** | `sales.controller.ts` (customers, sales-orders, invoices, returns, refunds) + `OrdersListPage`/`OrderDetailPage`; but no allocation/shipment/fulfilment API, no order-creation screen, channel order ingestion has no sync-job API. |
| R10 | Channels | **partial / mostly absent** | Accounts/credentials/mappings/sync-job/webhook contracts documented (51 endpoints, `API.md` §4.10) and adapters exist, but the only channel controller in the repo is the **inbound webhook receiver** (`channel-webhook.controller.ts`). `ChannelsPage` calls `GET /channels`, `/channels/health`, `/channel-sync-jobs` — none exist server-side (grep: 0 hits). |
| R11 | Accounting | **yes (strongest backend)** | 4 controllers / 92 documented endpoints' worth of CoA, periods, journals, posting, tax, valuation, closing + 8 report endpoints; `JournalCreatePage`, `TrialBalancePage`, `ProfitLossPage`. No balance-sheet/cash-flow screens. |
| R12 | Professional docs | **partial** | 15 numbered docs + 14 ADRs + review records — genuinely professional in structure. Undermined by false status claims and dangling links (see §False claims). `README.md:59` links `docs/08-user-guide/GUIDE-FA.md`, which **does not exist**. |

Summary: **2 yes, 8 partial, 1 no, 1 unverifiable** (docs-only yes for R4/R7). The code that exists is generally well-structured (config validation, guards, ledger, accounting), but the delivered surface is roughly **42 % of the documented API contract** (324 implemented route decorators vs 766 contracted endpoints).

---

## Install blockers

Dry-run of `docs/06-deployment/INSTALL-FA.md`, followed literally, against the files in the repo. Ordered by the step where a non-expert gets stuck. Each item is a hard stop unless marked *(cosmetic)*.

### B1 — Step ۶.۱ `./scripts/gen-secrets.sh` cannot even be parsed (blocker #1)
`scripts/gen-secrets.sh:126` contains a literal broken escape:

```
  replace_key JWT_ACCESS_SECRET              ""`n  replace_key MIGRATION_DATABASE_URL          ""
```

The raw bytes are `""` + backtick + `n` (verified by reading the file as text). Bash opens a command substitution at that backtick and never closes it → `unexpected EOF while looking for matching \``, **no `.env`, no `secrets/`**. Everything after step 6 depends on that output. (bash itself is unavailable in this review sandbox — WSL stub returns E_ACCESSDENIED — so this is proven from the literal source, not by execution.)

### B2 — Even with B1 fixed, `api`/`worker` refuse to start: production-only boot guards fail
`gen-secrets.sh:124-131` blanks the "crown" values in production. Three of them make `loadConfig()` throw:

1. `MIGRATION_DATABASE_URL=""` — the Zod field is `z.string().refine(isPostgresUrl)` with a **default that only applies to `undefined`, not `""`** (`apps/api/src/config/env.schema.ts:137-140`). Reproduced by calling the compiled loader:
   `loadConfig({… MIGRATION_DATABASE_URL: ''})` → `Invalid environment configuration. - migrationDatabaseUrl: postgres:// URL expected`.
   The API does not read `MIGRATION_DATABASE_URL_FILE` instead — it *does* support `_FILE`, but Compose only sets that variable on `migrate`, not on `api`/`worker`.
2. `SMS_MODE=mock` is left untouched by `gen-secrets.sh` (it is only changed in `--dev` mode, line 118), while `assertProductionSafety` requires `SMS_MODE=limo` (`env.schema.ts:330-332`) → `Refusing to start: SMS_MODE must be "limo" in production`.
3. `CORS_ORIGINS=https://erp.example.com` is never replaced, and `.example.com` is in `PLACEHOLDER_ORIGIN` (`env.schema.ts:317,374`) → `CORS_ORIGINS contains a wildcard or placeholder origin`.
   The script's closing "still required from the operator" list (lines 166-170) mentions **none** of these three — the operator is told only about DOMAIN/LIMO/CAREXY/ADMIN mobile.

Result: `docker compose up -d api` → crash-loop; INSTALL-FA §17's row "`api` مدام restart میشود" points at env validation but not at these three causes.

### B3 — Step ۱۰ `migrate`/`seed` script does not exist in the image
`docker-compose.yml:337` runs `pnpm db:migrate` with the image `WORKDIR /app/apps/api` (`infra/docker/api.Dockerfile:65`). `apps/api/package.json` scripts are `dev/build/start/typecheck/test/test:vitest/test:watch` — **no `db:migrate`, no `db:seed`** → `ERR_PNPM_NO_SCRIPT No script named 'db:migrate'`. The root `package.json` does define them (`pnpm --filter @saman/db migrate`) but nothing in the image invokes it, and the same applies to `INSTALL-FA.md:838` (`… run --rm migrate pnpm db:seed`) and `README.md:25-26` (`docker compose exec api pnpm db:migrate`).

### B4 — The prod image never ships `packages/db`; the Docker build fails before that
`@saman/api` depends on `@saman/db` (`apps/api/package.json:38`, lockfile importer at `pnpm-lock.yaml:65`). Both Dockerfiles copy only `apps/{api,web}/package.json` + `packages/shared/package.json` before `pnpm install --frozen-lockfile` (`infra/docker/api.Dockerfile:31-36`, `web.Dockerfile:27-32`). pnpm resolves workspaces from `pnpm-workspace.yaml`, so a missing `packages/db/package.json` means `@saman/db@workspace:*` is unresolvable → install aborts. Even if it were copied, the `prod` stage only copies `packages/shared` (`api.Dockerfile:58`), so `@saman/db` runtime code and `@saman/db/dist/migrate.js` would be absent.

### B5 — Migration content is in the wrong place and uses the wrong role
- `MIGRATIONS_DIR = process.cwd()/drizzle` (`packages/db/src/migrate.ts:6`). In the image cwd is `/app/apps/api`, and `api.Dockerfile:61` copies `apps/api/drizzle` — that directory is **empty in the repo** (`Get-ChildItem apps/api/drizzle` → 0 files). The only migration is `packages/db/drizzle/0001_init.sql`.
- `migrate()`/`seed()` default to `process.env.DATABASE_URL` and have no `MIGRATION_DATABASE_URL` / `_FILE` handling (`packages/db/src/migrate.ts:14`, `seed.ts:171`). The `migrate` service supplies only `MIGRATION_DATABASE_URL_FILE=/run/secrets/migration_db_url` and `.env` carries `DATABASE_URL` for `saman_app` → even a fixed script would run DDL as the **DML-only role** and hit `permission denied for schema erp` (`INSTALL-FA.md:1291` documents the symptom but not this cause).

### B6 — Step ۵ `git checkout v1.0.0` fails: no tags are published
`git tag` → empty. Identical problem at `INSTALL-FA.md:244` (`git checkout v1.0.0`), §15.2 (`git checkout v1.1.0`) and §15.3 rollback (`git checkout v1.0.0`); §18.2 asks the installer to record `git describe --tags`. Also note the working tree has 73 uncommitted deletions, so the delivered folder ≠ the commit — a clone of `origin` is not byte-identical to what was reviewed.

### B7 — `env`-file contract mismatches (INSTALL-FA §6.3 claims to document *every* variable)
Variables present in `.env.example` but **absent from INSTALL-FA §6.3 and from its "complete .env" appendix** (12): `LOG_BODIES`, `TLS_TERMINATED_AT_EDGE`, `TRUST_PROXY_CIDRS`, `FEATURE_STRICT_LOGIN_MODE`, `BREAK_GLASS_USER`, `FEATURE_BREAK_GLASS`, `FEATURE_INVENTORY_FREEZE`, `FEATURE_ACCOUNTING_FREEZE`, `CAPTCHA_PROVIDER`, `CAPTCHA_SITE_KEY`, `CAPTCHA_SECRET_KEY`, `SMS_DAILY_BUDGET`. The doc's own verification step §6.4 (`diff .env.example .env`) therefore cannot pass against the appendix.
Variables in the loader but in neither file: `METRICS_TOKEN`, `GIT_SHA`, `HOST` (`env.schema.ts:96,196,200`) — defaulted, harmless, but the "single source of truth" claim (`env.schema.ts:5-6`) is false.
Role/password duplication: `.env.example:137` defines `POSTGRES_PASSWORD`, but Compose uses `POSTGRES_PASSWORD_FILE=/run/secrets/db_password` (`docker-compose.yml:75`) — `POSTGRES_PASSWORD` is never passed to the container. It only works because `gen-secrets.sh` writes the same value to both. The documented manual path (`INSTALL-FA.md:266`, "create eight files by hand") does not say the content of `secrets/db_password` must equal the password embedded in `DATABASE_URL`/`MIGRATION_DATABASE_URL`.
`BOOTSTRAP_ADMIN_PASSWORD` minimum: doc says ≥12 chars (`INSTALL-FA.md:433`), schema enforces `min(8)` (`env.schema.ts:214`).

### B8 — Health/acceptance checks that cannot show what the doc promises
- §7 expects `docker compose ps` to show `minio` as **healthy**; the Compose service deliberately has **no healthcheck** (`docker-compose.yml:145-150`) → the step's stated expectation is unachievable. Same for `docker compose ps minio # انتظار: healthy` (`INSTALL-FA.md:519`).
- §7 `docker compose exec -T redis redis-cli -a "$REDIS_PASSWORD" ping` — the host shell export block (§6.5) reads `.env`, where production mode has **blanked** `REDIS_PASSWORD`; and `redis` runs with `requirepass` from the secret file. The documented one-liner therefore authenticates with an empty password.
- §7 `docker compose run --rm --entrypoint sh minio-init -c 'mc alias set … "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"'` relies on shell variables in the *host* shell being passed through `docker compose run`; `minio-init` has `env_file: .env` (which does contain both), so this one can work — but only if the operator executed §6.5 in the same shell.
- §8.2 says the init script is `infra/docker/postgres/init/01-init.sh`; the real file is `01-init.sql` (the contract list in §1 is correct). *(cosmetic, but a literal follower looks for a missing file.)*

### B9 — Backup path assumptions
`backup` runs as uid 1000 and `gen-secrets.sh:156-163` chowns `secrets/*` to `1000:1000` **only when run as root**; the guide runs it as `saman` (step 5). If `saman` is not uid 1000 (common on an existing server), the containers cannot read `/run/secrets/*` and the API fails with `cannot read secret file`. The script itself warns, but the guide doesn't make uid parity a checked precondition. Additionally `INSTALL-FA.md:1136` states the four `BACKUP_MIRROR_S3_*` keys "are not yet in .env.example" — they are (` .env.example:125-128`), so the doc is stale here.

---

## False or unsupported claims

| # | Claim (file:line) | Reality |
|---|---|---|
| F1 | `ROADMAP.md:19` **Procurement ✅ shipped & tested** | No procurement module, controller, service or route exists (`@Controller` list has no suppliers/purchase-orders; `GET /purchase-orders` → 0 source hits). The SPA route `/procurement` renders `ComingSoonPage` (`router.tsx:65-70`). |
| F2 | `ROADMAP.md:21` **Fulfillment ✅** | No fulfilment/shipments/packages/labels module or route (`shipments` → 0 hits). |
| F3 | `ROADMAP.md:22` **Pricing ✅** | No pricing module/controller; `/pricing` is `ComingSoonPage` (`router.tsx:71-76`). |
| F4 | `ROADMAP.md:28` **"Admin SPA: all main screens ✅"** | 4 of 24 routes are explicit placeholders; and `UsersPage`, `RolesPage`, `SettingsPage`, `ChannelsPage` call `/users`, `/roles`, `/settings/{group}`, `/organization`, `/channels`, `/channels/health`, `/channel-sync-jobs` — **none of these routes exist** in the API (no `@Controller('users'|'roles'|'settings'|'organization'|'channels')`). Those screens render errors against a live API. |
| F5 | `ROADMAP.md:11` "3 review rounds recorded in `docs/_review/`" | `docs/_review/REVIEW-LOG.md:37-39` says "Round 2 — pending", "Round 3 — pending"; only round-1 findings and one round-2 file (`R2-performance.md`, not indexed in the log) exist. |
| F6 | `ROADMAP.md:12` "Docker topology ✅ — compose config-validated" | `DEPLOYMENT.md:6` and `:604` say the opposite: no `docker compose config/build/up` was ever executed, the CI `compose-config` job is "pending first CI run". `INSTALL-FA.md:9` repeats the disclaimer. Cannot both be true. |
| F7 | `ROADMAP.md:13` "PostgreSQL schema + migrations + partitions + seed ✅" | Seed/migrate cannot run in the delivered image (B3–B5); migration execution is explicitly "unverified" in `MIGRATION-STATUS.md` §3. |
| F8 | `ROADMAP.md:17` "concurrency tests incl. oversell race" | No concurrency/oversell test exists (the inventory spec is a pure engine unit test; `tsconfig.test.json` excludes it from the test script anyway — see F9). |
| F9 | `ROADMAP.md` / `TESTING` framing of a tested codebase | 27 API spec files under `src/modules/**` and `src/workers/**` are **never executed by any npm script**: `apps/api/tsconfig.test.json` includes only `test/**/*.ts`, `test/run.ts` only reads `test/`, and `vitest.config.ts` includes only `test/**/*.spec.ts`. `pnpm test` for the API = 20 tests in 4 files. |
| F10 | `README.md:15` "نسخهٔ ۱.۰.۰" / §"شامل کل سیستم" | There is no `v1.0.0` tag, and the repo implements 324 of 766 contracted endpoints with 9 of 19 API groups controller-less. |
| F11 | `README.md:59` User guide `✅ فارسی` linking `docs/08-user-guide/GUIDE-FA.md` | File and directory do not exist (dangling link). |
| F12 | `MIGRATION-STATUS.md` §1/§3 "`drizzle/0001_init.sql` 1,348-line … 319 indexes, 314 triggers" | The delivered file is **5,729 lines** with 216 `CREATE TABLE` statements — the evidence table was not regenerated after the migration was rewritten, so its "exact commands run" evidence no longer describes the shipped artifact. |
| F13 | `INSTALL-FA.md:1136` offsite keys "not yet in `.env.example`" | They are present at `.env.example:125-128`. |
| F14 | `INSTALL-FA.md:254` "no variable outside `.env.example` is used in this document" | The appendix uses only a subset, but the doc also invents `config_file`-adjacent `postgresql.conf` flags and `caddi` staging flags — minor; more importantly the 12 variables of B7 are omitted from the tables while §6.3 claims completeness. |
| F15 | `README.md:22-27` Quick start (clone → `cp .env.example` → `up` → `exec api pnpm db:migrate`) | Fails at 4 points: `cp` leaves `CHANGE_ME` placeholders that the production guards reject; `docker compose exec api pnpm db:migrate` → no such script; `api` requires the `tools` profile for migration; admin credentials are not printed anywhere. |
| F16 | `ROADMAP.md:24` Accounting ✅ "auto-posting" | Auto-posting rules are partly present, but `posting_rule_sets` depend on tables in the deferred list (`business_rules`, `accounting_document_types`, `accounting_document_links`), so the claim exceeds what the shipped schema can store. |

Honest claims that *are* true (for balance): the deployment docs explicitly disclaim Docker validation; `INSTALL-FA.md` disclaims "tested"; `MIGRATION-STATUS.md` openly lists deviations (no Drizzle, scrypt instead of Argon2id) and 15 deferred tables.

---

## Gaps

Blocking gaps for the owner (Carexy Shop, 10k SKUs, real operations):

1. **Installation is not executable** — B1–B6 mean a non-expert cannot reach the login page from a clean Ubuntu host, regardless of skill. The guide is good prose wrapped around artifacts that do not line up (script syntax, role/URL wiring, image contents, missing tag).
2. **No user/role/settings/organization administration API** — the ERP cannot be operated: no way to create team users, assign the 8 seeded roles, revoke sessions, or edit org settings through the product. `UsersPage`/`RolesPage`/`SettingsPage` exist in the SPA and call endpoints that return 404. (`seed` can create exactly one admin.)
3. **Channel operations are read-only documentation** — no `/channels`, `/channel-sync-jobs`, credential CRUD or mapping endpoints; `ChannelsPage` cannot configure Carexy/Digikala, so "omnichannel" is not operable end-to-end. Carexy/Digikala adapters exist but no scheduler/job surface to drive them.
4. **No procurement / pricing / fulfillment** — the owner cannot buy stock, set price lists, or ship an order (no shipments/packages/labels). Sales orders can be listed but not created, allocated, picked-to-shipment, or settled.
5. **Migration/seed pipeline unusable** — one SQL file, wrong role, wrong directory, empty `apps/api/drizzle`, no `db:*` scripts in the API image; seed creates 8 roles/414 permissions/CoA but nothing can drive it in Docker.
6. **Data-model coverage** — 201 of 214 unique documented tables (15 deferred: `accounting_document_types`, `accounting_document_links`, `budgets`, `budget_lines`, `expense_categories`, `expenses`, `bank_reconciliations`, `bank_reconciliation_lines`, `business_rules`, `alert_rules`, `alert_events`, `fraud_flags`, `profit_distribution_runs`, `profit_distribution_lines`, `dashboard_kpi_snapshots`). Deferred is honest in `MIGRATION-STATUS.md`, but `ROADMAP.md` still marks the owning modules ✅.
7. **No operational evidence** — no load test artifacts (k6 profiles are referenced but absent), no Playwright config/`test:e2e` script, no CI run artifacts, no restore drill, no RPO ≤ 15 min (PITR only promised for v1.1), no uptime/monitoring proof.

Does `ROADMAP.md` honestly list the gaps? **Partly.** It honestly lists TD-01 (Docker unverified), TD-02 (no RLS), TD-03 (Digikala TBD), TD-06 (no PITR), load evidence 🟡, and the v1.2/v2 items. It **does not** list: missing procurement/pricing/fulfilment despite ✅ rows, missing users/roles/settings/organization API, missing channel CRUD/sync API, the 27 unexecuted API spec files, the absent `08-user-guide`, or the install blockers above. A reader of the roadmap would conclude the product is installable and feature-complete except for load evidence — which is the opposite of the delivered state. Where the roadmap and the deployment docs disagree (F6), the more pessimistic one (deployment docs) is the accurate one.

---

## Verdict

**Not acceptable for handover; cannot be installed by a non-expert.**

- Requirements coverage: **2 fully (R4 docs, R7 docs), 8 partial, 1 no (private-repo/release), 1 unverifiable.** The engineering artifacts that exist are respectable (production-grade config validation with fail-fast guards, least-privilege DB roles, partitioned ledger schema, accounting journal machinery, hardened Compose), but the delivered product is a well-documented **subset**: 324 of 766 contracted endpoints, 9 of 19 API groups without a controller, 4 of 24 SPA routes as placeholders.
- Installability: **fail at step ۶.۱** and at least five further hard stops before the login page (B1–B6), plus two acceptance checks that can never pass as written (B8). The guide's honesty about "Docker not executed" is commendable but does not compensate for artifacts that are internally inconsistent (script syntax error, blanked required env, image missing its DB package, no tag).
- Claims: **16 false/misleading claims**, including four ✅ "shipped" modules with zero code (F1–F4), a "3 review rounds recorded" statement contradicted by the review log (F5), and a "compose config-validated" statement contradicted by the deployment doc (F6).

Minimum bar to re-review as installable (in order): fix `gen-secrets.sh` and let it emit a boot-valid production `.env` (SMS_MODE, CORS_ORIGINS, non-blank migration URL or `_FILE` on api/worker); add `db:migrate`/`db:seed` entrypoints to the API image and ship `packages/db` (manifest + dist + `drizzle/`) with `MIGRATION_DATABASE_URL` respected; publish a `v1.0.0` tag; make `docker compose config && up` + `migrate` + `seed` + `/health/ready` + Persian login one recorded acceptance run (§18.2); then implement or explicitly de-scope users/roles/settings/organization and channel CRUD so the UI's existing screens do not 404. Correct `ROADMAP.md` §v1.0 to match the code before any customer sees it.
