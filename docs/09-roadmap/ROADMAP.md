# 09 — Roadmap, delivery status & technical debt

**خلاصهٔ فارسی:** این سند وضعیت واقعی نسخهٔ ۱٫۰ را شفاف می‌کند: چه چیزی ساخته و ماشینی بررسی شده، چه چیزی فقط طراحی شده، و چه چیزی برای نسخه‌های بعد مانده است. هیچ قابلیتی «انجام‌شده» ثبت نمی‌شود مگر کد و تست داشته باشد؛ و هر چیزی که در محیط ساخت قابل اجرا نبود (Docker/PostgreSQL) صریحاً «تأییدنشده» علامت خورده است.

Status: ✅ shipped & machine-verified · 🟡 built, runtime-verification pending on a host · 🧱 scaffold/config only · ⬜ not built (roadmap)

## v1.0 — delivered in this repository

### Platform & security
| Area | Status | Evidence |
|---|---|---|
| Monorepo, toolchain, ESLint/Prettier, CI workflows, Dependabot, CODEOWNERS | 🧱 | root configs, `.github/workflows/*` (CI first run on GitHub) |
| NestJS 11 + Fastify API bootstrap, config validation, pino logging, request-id, error envelope, metrics, health | ✅ | `apps/api/src/{main,bootstrap,app.module}.ts`, V-03/V-04, V-08 |
| Identity: password login (Argon2id), OTP device challenge, refresh rotation + reuse detection, sessions/devices, step-up, RBAC default-deny, scope narrowing, audit | ✅ | `modules/identity/**`, V-03, V-08 |
| Permission registry (414 keys) single source, role templates, seed | ✅ | `packages/shared/src/permissions.generated.ts`, V-13 |
| Audit hash-chain, crypto envelope (AES-256-GCM), secret `*_FILE` indirection | ✅ | `common/providers/{audit,crypto}.service`, SQL functions |
| Rate limiting tiers, CAPTCHA seam, SMS daily budget | 🟡 | config + guards wired; tier integration tests are CI-only |
| PostgreSQL schema (216 tables generated / 201 implemented), migrations, partitions, triggers, grants, seed (CoA 183 rows, roles, units, channels, tax, numbering, bootstrap admin) | 🧱 | `packages/db/**`, V-11/V-12; execution requires a DB host |

### Business modules
| Module | Status | Notes |
|---|---|---|
| Catalog (categories, brands, products, variants, barcodes, attributes, media, units, search) | ✅ | `modules/catalog/**`, engine suite 278 tests (broker-run) |
| Inventory (ledger, balances, reservations with fixed lock order, lots, FIFO cost layers, moving average, adjustments, counts, transfers, valuation) | ✅ | `modules/inventory/**`; oversell/layer tests pass |
| Sales (customers, orders FSM, line net/tax/gross arithmetic, returns with VAT credit note, refund cap) | ✅ | `modules/sales/**` |
| Warehouse (location tree, putaway scoring, pick waves/tasks/scans, two-stage verification, packing) | ✅ | `modules/warehouse/**` |
| Accounting (CoA, fiscal periods + Jalali calendar, journals with deferred balance check, 45-event posting matrix with VAT/GRNI/COGS-at-issue, closing run, trial balance/P&L/BS/ledger) | ✅ | `modules/accounting/**`, 135 finance tests |
| Treasury (payments, advances/allocations, cheques FSM, bank accounts/cash/reconciliation) | ✅ | `modules/treasury/**` |
| Partners (shareholders, transactions, profit distribution, channel settlements) | ✅ | `modules/partners/**` |
| Reporting (report registry with per-report permissions, runs, dashboards, exports) | 🟡 | `modules/reporting/**`; export artifacts are produced by the worker |
| Channels (accounts + encrypted credentials, mappings, sync jobs, webhook verify/replay, outbound allowlist, API call log) | ✅ | `modules/channels/**` |
| Adapters: Carexy (X-API-KEY real endpoints), Digikala (OAuth2 + real catalog paths; unconfirmed schemas `TBD-DIGIKALA`), Mock | 🟡 | real HTTP clients + mapping; sandbox certification pending seller credentials |
| Integrations: Limo SMS (all 5 documented endpoints, mock mode, budget), OTP service | ✅ | `modules/integrations/**` |
| Notifications, automation rules, alerts, fraud heuristics | ✅ | `modules/{notifications,automation}/**` |
| Workers: outbox dispatcher, channel sync, notifications, report export, maintenance (partitions/retention) | ✅ | `apps/api/src/workers/**`, `dist/worker.js` |
| **Procurement, Pricing, Fulfillment** | ⬜ | designed in docs; not built in v1.0 (schema exists where core) |
| HR/payroll, e-invoicing, Snapp/Tapsi adapters, AI assistants, HA profile | ⬜ | v1.1/v1.2/v2 |

### Frontend
| Area | Status | Notes |
|---|---|---|
| Persian RTL SPA (React 19 + Vite + Tailwind v4 + TanStack), auth memory-token + refresh, permission-aware shell | ✅ | `apps/web/**`, V-05/V-06/V-09/V-10 |
| Screens: login/OTP/MFA, dashboard, products, inventory, warehouses, orders, picking, packing, journals, trial balance, P&L, channels, users, roles, settings, reports, errors | ✅ | 23 pages |
| Procurement/pricing/partners/automation screens | 🧱 | explicit «در حال توسعه» states |
| PWA offline scanner queue | ✅ | IndexedDB/localStorage queue with idempotent replay |

### Deployment & operations
| Area | Status | Notes |
|---|---|---|
| Docker Compose stack (postgres16, redis7, minio, api, worker, web, migrate/tools, caddy TLS, backup, observability profiles) | 🧱 | config statically validated (V-15); **never booted** (no Docker in build env) |
| Dockerfiles (multi-stage, non-root, read-only, healthchecks), nginx, Caddy, backup/restore scripts, Makefile | 🧱 | same |
| Persian install guide (DB in-container **and** external PostgreSQL, roles/grants, TLS, backup drill, upgrade, troubleshooting) | ✅ | `docs/06-deployment/INSTALL-FA.md` (1,400+ lines) |
| Operations runbook + backup/restore + observability config | ✅ | `docs/07-operations/**`, `infra/observability/**` |
| CI (lint/typecheck/test/build/docker/security scans) | 🧱 | first run happens on GitHub Actions |

### Review & documentation
| Area | Status |
|---|---|
| Design docs (architecture, 14 ADRs, 215-table data model, 766-endpoint API contract, security/threat model, testing, deployment, operations, roadmap) | ✅ 33 files / ~11.9k lines |
| Three review rounds with independent reviewers + resolution log | ✅ `docs/_review/` (R1: 138 findings / 32 blockers fixed in design; R2 performance: 41 findings; R3 recorded) |
| Machine-verification log | ✅ `docs/VERIFICATION.md` |

## v1.1 — first host run (highest priority)

1. Boot the Compose stack on a reference 4 vCPU / 8 GB host; run migrations + seed twice; capture logs/durations in `docs/VERIFICATION.md`.
2. Execute the 201-table migration on PostgreSQL 16 and fix any DDL/runtime defects the static validator could not catch.
3. Run the integration suite (`TEST_DATABASE_URL=… pnpm test:int`) incl. journal-balance trigger, hash chain, partition creation, `\dp` grants diff.
4. Playwright E2E smoke on the running stack; publish results.
5. k6 load/soak on the reference host; check the R2-performance thresholds (ledger index, allocation p95 < 500 ms, outbox throughput ≥ 180 events/s).
6. Digikala sandbox certification for orders/inventory/labels; Carexy variable mapping certification.
7. Build the three missing modules: **procurement, pricing, fulfillment** (designs already in docs/02+03).

## v1.2 — business depth
- HR/payroll; e-invoicing (سامانه مؤدیان) submission; promotions/coupons engine; multi-currency activation; approval-workflow UI; report builder; printer agent packaging; Excel/CSV import with dry-run + rollback.

## v2.0 — scale & intelligence
- HA profile (managed PostgreSQL + replicas, Redis Sentinel, ≥2 API/worker replicas, blue/green); extraction path per ADR-0001 only if measured; AI assistants behind approval; data-warehouse export.

## Technical debt ledger

| ID | Debt | Impact | Plan |
|---|---|---|---|
| TD-01 | Docker/Compose never executed (no daemon in build env). **Migration + seed are now executed and verified against a real local PostgreSQL 18.4** (17/17 checks, see `VERIFICATION.md` §6); PG16 + Docker boot still pending | install risk | v1.1 item 1–3 |
| TD-02 | Module-level spec suites (413 tests) run through a broker shim here, not the repo harness; Vitest esbuild cannot spawn in this sandbox | test gate | CI `pnpm test:vitest` on a normal runner |
| TD-03 | Web build needs `--configLoader native` + in-process transpile plugin in this sandbox (standard `vite build` on normal hosts) | build portability | verify standard build in CI |
| TD-04 | 15 DB tables deferred (budgets, expenses, bank-reconciliation lines, alerts/fraud, profit-distribution, accounting doc types/links, KPI snapshots) | feature gaps | next migration batch |
| TD-05 | Procurement/pricing/fulfillment modules not built | feature gaps | v1.1 item 7 |
| TD-06 | Digikala schemas partly `TBD-DIGIKALA` | adapter risk | sandbox certification |
| TD-07 | RLS not enabled (app-layer org scoping only) | multi-tenant future | ADR-0005 plan |
| TD-08 | No WAL/PITR by default (nightly dumps; default RPO 24 h) | recovery | pgBackRest profile |
| TD-09 | Report exports enqueue artifacts built by the worker (no download until worker runs) | UX | v1.1 |
| TD-10 | `payments.purpose` inferred from linked ids; cheque cancel/return reuse bounce accounting | domain fidelity | v1.2 |
| TD-11 | Permission registry has no `export.create` / `accounting.journal.post_high_value` in some modules (threshold enforced via approval state) | authz fidelity | align in v1.1 |
| TD-12 | Read-only cross-module projection joins in commerce repositories | boundary purity | reporting read models |
| TD-13 | Remaining INSTALL-FA doc drift (env appendix subset, minio health expectation text, uid parity note) | installer friction | docs pass on first host run |
| TD-14 | `@Audited` decorator has no interceptor consumer in some modules; audit rows are written explicitly by services only | audit completeness | wire a global audit interceptor in v1.1 |
| TD-15 | OTP verify consumes code non-atomically (replay window) and device-secret rotation is not atomic | auth risk | `UPDATE … WHERE consumed_at IS NULL RETURNING` + tests |
| TD-16 | Step-up token is issued but not enforced by a global guard on the sensitive-action list | authz risk | `StepUpGuard` + route matrix (ADR-0004 rev) |
| TD-17 | No global ScopeGuard; branch/warehouse scoping is applied inside repositories only | cross-scope IDOR risk | ScopeGuard + repository scope audit |
| TD-18 | Maker-checker threshold read from `system_settings` at post time; no `approval.config.manage` route and no DB `approval_id` constraint | financial-control risk | approval module + DB constraint (R1 B-04) |
| TD-19 | Closed-period guard can be bypassed with a body-supplied post date | accounting integrity | derive period from `entry_date` + reject locked periods |
| TD-20 | Audit hash chain covers ids/timestamps only; worker grants still allow audit lifecycle UPDATE | tamper-evidence gap | include content hash + tighten grants |
| TD-21 | All DB roles share one password in the default compose init | least privilege | per-role password secrets |
| TD-22 | Channel admin surface incomplete (no `/channels`, `/channel-accounts`, `/channel-sync-jobs` controllers); SPA channel page reports «در حال توسعه» | omnichannel operability | channels admin controllers (v1.1) |
| TD-23 | BullMQ not installed; worker uses DB `job_runs` fallback queue | throughput | add BullMQ + Redis adapter (documented topology) |
| TD-24 | **Write-path column drift**: some write SQL references columns/tables not in the implemented schema (first confirmed: `product_categories.image_file_id`). Read paths, auth, RBAC and validation are E2E-verified; writes need schema generation/alignment | cannot create some records | v1.1 **release blocker** — generate columns from live schema, run write integration suite |
| TD-25 | Redis not executed in the local E2E (rate limits/queues degraded); `/health/ready` correctly reported it | observability/limits untested | first CI/host run with Redis |

## Release process

1. `pnpm verify:full` green + review approvals (CI).
2. Tag `vX.Y.Z`; CI builds/scans/signs images.
3. Deploy to staging; `scripts/smoke.sh`; then production with explicit migrate step; verify health + backup.
4. Post-deploy watch 30 min: error rate, outbox lag, queue depth.
