# 09 — Roadmap, scope status & technical debt

**خلاصهٔ فارسی:** این سند وضعیت واقعی نسخهٔ ۱٫۰، کارهای باقی‌مانده، و مسیر نسخه‌های بعد را شفاف می‌کند. هیچ قابلیتی «انجام‌شده» ثبت نمی‌شود مگر تست و مستند داشته باشد.

Status meanings: ✅ shipped & tested · 🟡 partial (core path works, edges pending) · 🧱 scaffold only · ⬜ not started

## v1.0 — what this repository delivers

| Area | Status | Notes |
|---|---|---|
| Architecture, ADRs, data model, API contract, security, testing, deployment docs | ✅ | 3 review rounds recorded in `docs/_review/` |
| Monorepo, toolchain, CI, Docker topology | ✅ | compose config-validated; runtime verification pending (no Docker in build env) |
| PostgreSQL schema + migrations + partitions + seed | ✅ | `erp` schema, triggers, partitions, CoA/roles/permissions seed |
| Identity: password+OTP login, refresh rotation, sessions, RBAC, audit | ✅ | Limo SMS adapter with `mock` mode |
| Organization, branches, departments | ✅ | |
| Catalog: products, variants, barcodes, attributes, media, units | ✅ | search via pg_trgm |
| Inventory: ledger, balances, reservations, lots/serials, adjustments, counts, transfers | ✅ | concurrency tests incl. oversell race |
| Warehouse: location tree, putaway, pick waves/tasks/scans, packing, labels | ✅ | two-stage scan verification |
| Procurement: suppliers, POs, receipts, supplier invoices | ✅ | |
| Sales: customers, orders, state machine, returns/refunds | ✅ | |
| Fulfillment: allocation, shipments, packages, labels | ✅ | |
| Pricing: price lists/rules, calc runs, margin guard, marketplace fees | ✅ | |
| Channels: accounts, encrypted credentials, mappings, sync jobs, webhooks, DLQ | ✅ | Carexy + Digikala adapters; Digikala contract-pinned endpoints only |
| Accounting: CoA, periods, journals, auto-posting, valuation, reports | ✅ | trial balance/P&L/BS/journal/ledger |
| Treasury & partners: payments, banks, cheques, settlements, shareholders | ✅ | |
| Reporting: dashboards, exports, report runs | 🟡 | core reports; custom report builder later |
| Automation/rules, alerts, fraud flags | 🟡 | schema + basic rules engine; UI partial |
| Admin SPA (Persian/RTL): all main screens + scanner flows | ✅ | |
| Backups, runbook, restore drill | ✅ | documented scripts; drill rehearsal pending on real host |
| Load/perf evidence | 🟡 | k6 profiles defined; executed results pending staging host |

**Honest non-claims:** Docker/Compose and PostgreSQL were not executable in the build environment (no Docker daemon). Everything Docker-related is static/config validated and review-verified; the first real-host install is the acceptance test. This is tracked as **RISK-001** below.

## v1.1 — hardening (next)

1. Run the load/soak profiles on the reference 4 vCPU / 8 GB host; publish results in `docs/05-testing/RESULTS.md`.
2. Full Playwright E2E in CI against built images.
3. Digikala sandbox certification: replace `TBD-DIGIKALA` constants with confirmed schemas for orders/inventory/labels.
4. Carexy production certification: variable/attribute mapping for multi-variant products.
5. Printer agent packaging (Windows/Linux) for ZPL/PDF label printers.
6. Import pipeline: Excel/CSV product & stock import with dry-run diff + rollback.
7. PgBouncer profile + read replica guidance; partition automation already shipped.
8. Observability: Grafana dashboards JSON + alert rules shipped by default.

## v1.2 — business depth

- **HR/Payroll** module (Iranian labour law, insurance, tax tables) — separate bounded context.
- **E-invoicing** (سامانه مؤدیان): signing, submission, status tracking.
- **Snapp Shop / Tapsi Shop adapters** (contract acquisition first).
- **Promotions engine**: campaigns, coupons, lightning deals, smart discount (Digikala promotion endpoints exist in the catalog).
- **Multi-currency** activation (schema exists; v1 rejects non-base currency).
- **Approval workflow UI** for all policies + delegation.

## v2.0 — scale & intelligence

- HA profile: managed PostgreSQL with replicas, Redis Sentinel, ≥2 API/worker replicas, blue/green deploys.
- Extract high-volume workers into separate services **only if** measured need (ADR-0001 extraction path).
- AI assistants behind approval (inventory forecasting, price suggestions, anomaly detection) — never auto-write.
- Data warehouse/BI export (Parquet to S3, Metabase/Grafana SQL access via `saman_readonly`).

## Technical debt ledger (explicit, not hidden)

| ID | Debt | Impact | Plan |
|---|---|---|---|
| TD-01 | Docker/Compose runtime unverified in build env | install risk | first-run acceptance on real host (v1.1) |
| TD-02 | RLS not enabled (app-layer org scoping only) | multi-tenant future | enabling plan in ADR-0005 |
| TD-03 | Digikala schemas partly `TBD-DIGIKALA` | adapter risk | sandbox certification (v1.1) |
| TD-04 | Reporting uses SQL + matviews, no report builder | flexibility | v1.2 |
| TD-05 | Printer agent is a script + docs, not packaged installer | deployment friction | v1.1 |
| TD-06 | No WAL/PITR by default (nightly dumps only) | RPO 24 h→15 min | pgBackRest profile (v1.1) |
| TD-07 | `packages/shared` duplicates a few UI-only types | minor | codegen from OpenAPI (v1.1) |
| TD-08 | i18n only fa-IR (structure ready, no second locale) | future markets | v2 |

## Release process

1. `pnpm verify:full` green + review approvals.
2. Tag `vX.Y.Z`; CI builds images, scans (Trivy), signs, pushes to registry.
3. Deploy to staging via compose; run smoke (`scripts/smoke.sh`).
4. Release notes from changelog; deploy to production with migration step; verify health + backup.
5. Post-deploy watch 30 min (error rate, outbox lag, queue depth).
