# 00 — Product Overview & Scope

**خلاصهٔ فارسی:** سند حاضر تعریف محصول «سامان ERP»، دامنهٔ نسخهٔ ۱٫۰، اهداف مقیاس (بیش از ۱۰٬۰۰۰ کالا و تراکنش روزانهٔ بالا) و مرزهای نسخهٔ اول را مشخص می‌کند. منبع نیازمندی‌ها، مستندات فاز صفر پروژه (SRS، سند معماری، DDL و Dictionary) و مستندات API کانال‌ها است. هر تصمیم مهم در `docs/adr/` ثبت شده است.

Status: **Engineering baseline v1.0** · Owner: Lead Architect · Last updated: 1405-07-27

---

## 1. Problem statement

**Carexy Shop** (`https://carexy.shop` — the owner's second business) sells through its own storefront (Carexy API) and marketplaces (Digikala today; Snapp Shop / Tapsi Shop later). The ERP is targeted at `https://erp.carexy.shop` and must become the single system of record for:

1. **Product master** — 10,000+ SKUs, variants, manufacturer barcodes, attributes, media, per-channel mappings.
2. **Inventory truth** — one append-only ledger per warehouse/location, reservations that never oversell, FIFO/weighted-average valuation.
3. **Warehouse execution** — putaway, wave picking, barcode-verified picking/packing, labels, cycle counts.
4. **Omnichannel orders** — ingest from every channel, one canonical order model, allocate → pick → pack → ship → settle.
5. **Channel sync** — push stock/prices, pull orders, tolerate partner outages, never duplicate an order.
6. **Accounting & treasury** — double-entry journals generated from business events, Iranian chart-of-accounts structure, periods, cheques, partners' profit share.

The ERP owns the data; channels are producers/consumers. **No channel may dictate the internal model** (`ADR-0006`).

## 2. Goals (v1.0)

| # | Goal | Measure |
|---|---|---|
| G1 | Single source of truth for catalog + stock | 100% of stock mutations through the ledger; zero direct `UPDATE quantity` paths |
| G2 | No overselling | reservations are transactional; invariant tested under 100 concurrent allocators |
| G3 | Ship the right item | two-stage scan verification (pick + pack) with server-side SKU/barcode match |
| G4 | Channel-agnostic core | adding a channel = new adapter package, zero core changes |
| G5 | Accounting correctness | every posted journal balances; corrections only via reversal |
| G6 | Deployable on one server | `docker compose up` on a 4 vCPU / 8 GB host, HTTPS-ready |
| G7 | Secure by default | no secret in repo; RBAC on every endpoint; audit trail on every sensitive write |
| G8 | Operable | health checks, metrics, structured logs, backup/restore runbook, RPO ≤ 15 min, RTO ≤ 1 h |

## 3. Scale targets (design envelope)

| Dimension | v1 target | Design headroom |
|---|---|---|
| SKUs | 10,000+ | 100,000 |
| Warehouses | 1–3 | N (hierarchical locations) |
| Orders | 5,000/day | 50,000/day |
| Inventory ledger rows | 200,000/day | 2M/day (monthly partitions + BRIN) |
| Concurrent users | 500 | 2,000 (stateless API replicas) |
| p95 API latency (read) | < 200 ms | — |
| p95 API latency (write) | < 500 ms | — |
| Channel stock propagation | < 5 s (debounced, batched) | — |
| Uptime | 99.9% (single node + monitoring) | HA profile documented |

Capacity reasoning is in `01-architecture/ARCHITECTURE.md` §11.

## 4. Personas & roles

Roles are seeded and permission-driven (`RBAC`, not hard-coded role checks):

`superadmin` · `admin` (مدیر کل) · `finance_manager` (مدیر مالی) · `accountant` (حسابدار) · `warehouse_manager` (مدیر انبار) · `warehouse_operator` (انباردار) · `sales_agent` (کارشناس فروش) · `viewer` (مهمان/ناظر)

Warehouse operators must never see cost/price. Finance must never mutate stock directly. Separation of duties is enforced by permission matrix + approval workflow (`ADR-0008`).

## 5. In scope — v1.0

**Identity & platform:** password + OTP (Limo SMS), refresh-token rotation, device tracking, session revocation, RBAC + scope, audit log, settings, file storage (S3/MinIO), notifications, idempotency, outbox, health/metrics.

**Organization:** organization profile, branches, departments.

**Catalog:** categories (tree), brands, products, variants, barcodes (manufacturer + internal), attributes/values, media, units of measure + conversions, price/cost history.

**Inventory & WMS:** warehouse hierarchy `warehouse → zone → aisle → rack → shelf → bin → location`, putaway suggestions, inventory balances + ledger, reservations, lots/batches, serials, unit-level traceability, adjustments, transfers, cycle counts, reorder rules.

**Sales & fulfillment:** customers, sales orders (manual + channel), order state machine, allocation, pick waves/tasks/scans, packing stations/tasks/scans, packages, shipping labels, shipments, returns/refunds.

**Procurement:** suppliers, purchase orders, goods receipts, supplier invoices.

**Pricing:** price lists, pricing rules (markup/commission/tax/margin guard), price calculation runs and snapshots, marketplace fees.

**Channels:** channel accounts + encrypted credentials, product/variant/inventory/price mappings, sync jobs, raw payload archive, webhook events, API call log. **Adapters shipped:** Carexy (API key), Digikala (OAuth2 client-credentials, real endpoint catalog from OpenAPI), Mock adapter for tests.

**Accounting:** Iranian 6-level chart of accounts, fiscal years/periods with lock, journal entries/lines with balance enforcement, auto-posting rules for sales/purchase/inventory/returns/fees/shipping, accounting dimensions, trial balance, journal book, ledger, P&L, balance sheet, inventory valuation runs (FIFO + weighted average), tax rates/documents, budgets.

**Treasury & partners:** payments, bank accounts, cash, cheques + cheque events, bank reconciliation, partner accounts, shareholders, transactions, profit distribution, channel settlements.

**Frontend:** Persian RTL admin SPA — login/OTP, dashboard, catalog, inventory, warehouse operations (mobile-first scanner flows), orders, procurement, pricing, channels, accounting, treasury, partners, reports, users/roles, settings.

## 6. Out of scope — v1.0 (explicit)

- Payroll / HR (needs Iranian labour-law specifics; separate module)
- Full e-invoicing (سامانه مؤدیان) submission — export formats only
- AI pricing/inventory assistants (`ADR-0011` keeps the seam; not shipped)
- Microservices / Kafka / Elasticsearch (`ADR-0001`)
- Multi-tenant SaaS billing (schema is org-aware, but provisioning is single-tenant in v1)
- Snapp Shop / Tapsi Shop adapters (interface + mock stub only; contracts unavailable)
- Native mobile apps (PWA scanner flows instead)

## 7. Success criteria (release gate)

1. `docker compose up -d --build` on a clean Ubuntu 24.04 host reaches `healthy` for all services, then `db:migrate && db:seed` succeeds.
2. `pnpm verify` (lint + typecheck + unit + integration) is green in CI and locally.
3. E2E smoke: login → create product → receive stock → create order → allocate → pick scan → pack scan → label → ship → auto journal → trial balance balanced.
4. Concurrent allocation test (100 parallel) never oversells.
5. Security checklist in `docs/04-security/SECURITY.md` §9 signed off; dependency audit clean at `high`.
6. Backup/restore rehearsal restores a dump into a fresh container and passes the smoke test.

## 8. Source documents

| Input | Use |
|---|---|
| `سند پروژه erp کرکسی شاپ.docx` (246 sections) | Master design spec: domains, engines, invariants |
| `ERP_database_design_v1.sql` (150 tables) | Reference DDL; corrected/reshaped in `packages/db` |
| `ERP_database_dictionary_v1.md` | Column-level reference |
| `db erp.docx` | DB design rationale (barcode model, adapters, ledger) |
| `erpcarexy.docx` / `erpcarexy.pdf` | SRS v1, RBAC roles, CoA structure, UI mockups, prior test plan |
| `دیجی‌کالا api.docx` | Real Digikala endpoint catalog + scopes (264 APIs) |
| `لیمو اس ام اس.docx` | Limo SMS REST contract (`ApiKey` header) |
| Carexy adapter endpoints (SRS §50) | `X-API-KEY` products/inventories/storages |

Conflict resolution rule: **real API docs > master spec > SRS > AI-generated samples.** Where documents disagree (e.g. microservices vs modular monolith), the ADR records the decision and the reasoning.
