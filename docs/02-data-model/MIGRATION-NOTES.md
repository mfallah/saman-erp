# MIGRATION-NOTES — corrections to the supplied DDL & conventions actually used

Companion to `DATA-MODEL.md`. This file records **what we changed in the supplied `ERP_database_design_v1.sql`** and the mechanical rules the generated migrations follow, so backend agents can convert the 150-table reference without re-deriving decisions. The supplied file is a requirements sketch (not executable); it must never be copied verbatim.

Status: Accepted v1.0 · Owner: Database Architect · Last updated: 1405-07-27

---

## 1. Corrections to the supplied DDL (blocking)

| # | Supplied problem | Correction | Where |
|---|---|---|---|
| 1 | `"id" bigint NOT NULL DEFAULT GENERATED ALWAYS AS IDENTITY PRIMARY KEY` — invalid SQL | `id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY` (ordinary tables); `id bigint NOT NULL DEFAULT nextval('erp.<t>_id_seq')` + `PRIMARY KEY (id, created_at)` (partitioned tables, PG16 has no identity on partitioned tables) | DATA-MODEL §1.2, §4.2 |
| 2 | No triggers anywhere; `updated_at`/`version` dead columns | per-table `trg_<table>_updated_at` + `trg_<table>_version`; application never writes them | §1.7, §5.1 |
| 3 | No `UNIQUE` constraints at all (PK only) | named `uq_*` / unique indexes on every natural/business key (sku, code, order_no, invoice_no, external ids, balances tuple, event idempotency) | §2 (each table), §1.5 |
| 4 | No partitioning, no retention | five monthly partitioned tables, PK/unique include `created_at`, BRIN, default partition, auto-create + retention jobs | §4 |
| 5 | `deleted_at` on every table including ledgers/journals | soft delete only on master data; transactional rows voided/reversed; `BEFORE DELETE` guards | §1.3, §5.1 |
| 6 | Money `numeric(20,2)`, `numeric(30,2)`; percentages `numeric(8,4)`; `float` risk | money `bigint` IRR; qty `numeric(18,4)`; % `numeric(9,6)`; FX `numeric(12,6)`; no `float/real/money` | §1.4 |
| 7 | Permission registry undefined, no unique on `permissions.code` | `permissions.key` global unique, `resource`/`action` derived, 412 seeded keys | §2.2, §6.2 |
| 8 | `users` missing password hash, MFA, permission version | `identity.users` + `auth_sessions`, `user_devices`, `password_history`, `otp_challenges`, `login_attempts` | §2.2 |
| 9 | `inventory_balances` without unique tuple or non-negative CHECKS | `uq_inventory_balances_wh_loc_variant` + `ck_inventory_balances_nonnegative` (+ trigger) | §2.6 |
| 10 | Journal balance not enforced anywhere | header totals + deferred constraint trigger `trg_journal_lines_assert_balanced` | §2.12, §5.1 |
| 11 | `api_request_logs` stored full bodies | only `*_redacted` on 4xx/5xx; no secrets/PII | §2.1 |
| 12 | Channel-specific quirks would leak into core (`channel_price_*`, mixed `sales_channels`) | channel type vs account split; prices owned by `pricing`; external ids only in `channel_*_mappings` | §2.8, §2.11 |
| 13 | Missing FK indexes (`created_by`, `approved_by`, many composite paths) | every FK indexed; composite indexes per access path | §1.3, §3/§7 |
| 14 | Mixed quantity precision (`numeric(20,3)`), UoM without dimension/base | uniform `numeric(18,4)`; `units_of_measure.dimension/is_base` + conversions | §2.4, §6.4 |
| 15 | `check` as a domain noun with spelling drift (`checks`, `check_events`) | `treasury.cheques`, `treasury.cheque_events`, Iranian lifecycle (Sayad, deposit/clear/bounce/endorse) | §2.13 |
| 16 | Numbering off-by-one ambiguity (`current_value`) | `next_value` + `reset_policy` + gap-free `allocate_document_no` | §2.1, §6.7 |
| 17 | `permissions` org-scoped (tenants could fork permission semantics) | global registry + per-role grants; `is_system` immutability | §2.2 |
| 18 | No projection/invariant between ledger and balances | balance projection maintained in-transaction by service; nightly `inventory_consistency_checks` + alert | §2.6 |

## 2. Table-level rename / replacement map (old → new)

```
login_sessions              → identity.auth_sessions
product_batches             → inventory.inventory_lots           (FIFO cost layer: qty_remaining, cost_remaining_amount)
product_serials             → inventory.inventory_serials
location_product_rules      → warehouse.putaway_rules
warehouse_tasks             → dropped (putaway/pick/packing own execution)
warehouse_task_events       → dropped
order_reservations          → merged into inventory.stock_reservations
checks / check_events       → treasury.cheques / treasury.cheque_events
channel_api_credentials     → channels.channel_credentials       (AES-256-GCM envelope + key_version)
marketplace_fees            → pricing.channel_fee_rules
platform_commission_rules   → pricing.channel_fee_rules
channel_price_lists         → pricing.price_lists
channel_price_rules         → pricing.pricing_rules
channel_price_snapshots     → pricing.price_snapshots
audit_logs.user_id          → audit_logs.actor_user_id (+ actor_type)
numbering_sequences.current_value → next_value
sms_messages.cost           → sms_messages.cost_amount (bigint IRR)
```

45 net-new tables were added (see DATA-MODEL §7.3) after removing 4 reference tables and renaming 11: identity devices/scope/history/attempts, org currency+holidays, category attributes, inventory transfers(+lines)/consistency, wave↔order join, invoice/receipt lines, carrier services/zones/package contents, price list items, channel cursors/health/rate-limit, journal dimensions/posting rules/tax lines, bank/cash/sessions/reconciliation/allocation, partner ledger/profit/settlements, KPI snapshots, alerting, partition maintenance. Arithmetic: 150 − 4 + 45 = **191 tables** (DATA-MODEL §2 counts are normative). One documented exception to the standard block: `platform.partitioned_tables_registry` is a maintenance registry keyed by `parent_table text`, not a business aggregate (no `id`/`public_id`/`version`; rejected as a business table by review).

## 3. Naming & type conventions actually used (frozen)

- schema `erp` only; `public` only for extensions.
- Tables plural `snake_case`; columns singular `snake_case`; TS layer camelCase only.
- PK `id` bigint (+ `public_id uuid` external). FKs use `id`; APIs use `public_id`.
- Standard columns: `created_at`, `updated_at`, `created_by`, `updated_by`, `deleted_at` (master data only), `version`.
- Constraint names: `pk_<table>`, `fk_<table>_<column>`, `uq_<table>_<cols>`, `ck_<table>_<rule>`, `ix_<table>_<cols>`, `ix_<table>_<cols>_partial`, `trg_<table>_<purpose>`; all named (no anonymous constraints).
- Enumerations: `varchar(n) NOT NULL DEFAULT … CHECK (col IN (...))`; tokens are the shared enum vocabulary (DATA-MODEL §1.6). No PG `ENUM`.
- Money: `bigint` IRR with `_amount` suffix (`line_total_amount`, `unit_cost_amount`, `fee_amount`). JSON transport = string.
- Quantities: `numeric(18,4)`; percentages `numeric(9,6)` (0.100000 = 10%); FX `numeric(12,6)`; conversion factor `numeric(30,12)`; weights `integer` grams; dimensions `numeric(10,2)` cm.
- Time: instants `timestamptz` UTC; legal/accounting dates `date` (Gregorian civil day of the Jalali date, ADR-0014).
- JSONB only for raw payloads, settings, audit diff, event payload, rule DSL, snapshots — never for join/filter fields.
- `ON DELETE`: RESTRICT default; CASCADE only for pure child rows (lines, mappings, scans, join rows); SET NULL only for optional human attribution.
- High-risk multi-tenant relations use composite FKs `(organization_id, id)` (ADR-0005).

## 4. CI / migration lint queries (run in `db:lint` and in the migration test suite)

```sql
-- 4.1 every FK column must be indexed (leftmost column of some index)
SELECT c.conrelid::regclass AS table, a.attname AS column, c.conname AS fk
FROM pg_constraint c
JOIN LATERAL unnest(c.conkey) k(attnum) ON true
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
WHERE c.contype = 'f' AND c.connamespace = 'erp'::regnamespace
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid AND i.indkey[0] = k.attnum AND i.indisvalid)
ORDER BY 1, 2;   -- must return 0 rows

-- 4.2 no floating/decimal money columns
SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema = 'erp'
  AND data_type IN ('real','double precision','money')
  AND (column_name LIKE '%amount%' OR column_name LIKE '%price%' OR column_name LIKE '%cost%'
       OR column_name LIKE '%total%' OR column_name LIKE '%fee%' OR column_name LIKE '%value%');
  -- must return 0 rows; also assert every %_amount column is bigint:
SELECT table_name, column_name, data_type FROM information_schema.columns
WHERE table_schema='erp' AND column_name LIKE '%\_amount' AND data_type <> 'bigint';
  -- must return 0 rows

-- 4.3 no anonymous constraints
SELECT conrelid::regclass AS table, contype, conname FROM pg_constraint
WHERE connamespace = 'erp'::regnamespace
  AND conname !~ '^(pk|fk|uq|ck|ex|trg)_';   -- must return 0 rows

-- 4.4 partitioned tables: PK/unique must include the partition key (created_at)
SELECT c.conrelid::regclass AS table, c.conname, c.contype
FROM pg_constraint c JOIN pg_partitioned_table p ON p.partrelid = c.conrelid
WHERE c.contype IN ('p','u') AND NOT EXISTS (
  SELECT 1 FROM unnest(c.conkey) k WHERE k = (
    SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'created_at'))
  AND c.conrelid::regclass::text IN (
    'inventory_transactions','audit_logs','api_request_logs','channel_api_calls','outbox_events');
  -- must return 0 rows

-- 4.5 every table resolves to exactly one documented module/table name
SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'erp' AND c.relkind IN ('r','p') AND c.relname NOT LIKE '%\_p%';  -- expect 191 (+ registry parents counted; partitions excluded by relname LIKE '%_p20%')

-- 4.6 default partitions must stay empty (also exported as a metric/alert)
SELECT 'inventory_transactions', count(*) FROM erp.inventory_transactions_default
UNION ALL SELECT 'audit_logs', count(*) FROM erp.audit_logs_default
UNION ALL SELECT 'api_request_logs', count(*) FROM erp.api_request_logs_default
UNION ALL SELECT 'channel_api_calls', count(*) FROM erp.channel_api_calls_default
UNION ALL SELECT 'outbox_events', count(*) FROM erp.outbox_events_default;
  -- all rows must be 0

-- 4.7 permission registry parity: seed count must equal manifest count in packages/shared/permissions.ts
SELECT count(*) FILTER (WHERE is_system) AS seeded FROM erp.permissions;  -- expected 412

-- 4.8 no table has a money column typed numeric, and every qty column is numeric(18,4)
SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema='erp'
  AND ((column_name ~ '(quantity|on_hand|reserved|available|damaged|in_transit)')
       AND NOT (data_type='numeric' AND numeric_precision=18 AND numeric_scale=4))
  AND column_name NOT IN ('capacity_qty');  -- must return 0 rows
```

## 5. Seed-time guardrails

1. All seeds are idempotent upserts on natural keys; re-running `pnpm db:seed` twice produces identical row counts (test asserts counts for permissions/roles/CoA/units/tax/numbering/channels/settings).
2. Seed never overwrites operator-changed business rows: master seeds use `ON CONFLICT DO NOTHING`; settings use `ON CONFLICT DO UPDATE` **only** for `is_secret=false` and non-operator keys (list in DATA-MODEL §6.10).
3. CoA seed does not touch rows whose `code` exists; new accounts are additive. Re-numbering a seeded account is a data migration, not a seed.
4. `permissions` seed deletes only keys with `is_system=true` that no longer exist in the manifest **and** revokes them from roles first (transaction); role grants are then re-applied from the manifest.
5. Fiscal year + periods are created by the seed for the current year only; future years via `accounting.fiscal_year.create` (copies numbering sequences).
6. Seeds for sample warehouse tree/locations are dev/staging-safe: they are tagged by `is_system` seed marker in code and skipped when `APP_ENV=production` **except** master data required to boot (roles, permissions, CoA, units, tax, numbering, channels, settings).
7. No secrets are seeded: channel credentials, bank account numbers, API keys must be entered by an operator (encrypted on write).

## 6. Migration authoring rules

- One migration per numbered file, single transaction, forward-only; no `DROP` without a documented data migration + backup note.
- Tables created in module migrations (`0002`–`0016`) **without** FKs; FKs/checks/indexes in `0017`; partitions in `0018`; views/matviews in `0019`; seed in `0020`.
- Partitioned parents are created in their module migration but must not receive inserts until `0018` (tests/seed run after).
- Indexes created before seed for seeding speed; `ANALYZE` after seed.
- `EXPLAIN` in review for any query touching partitioned tables; all such queries must include a `created_at` bound (repository helpers default to a 90-day window for logs/ledger).
- Triggers created in the table's module migration (per-table) **and** re-verified in `0017` (idempotent `DROP TRIGGER IF EXISTS … CREATE TRIGGER`).
- Every migration ends with a `COMMENT ON TABLE`/`COMMENT ON COLUMN` for money and enum columns (helps `psql \d+` for operators).
- `DB_SCHEMA_VERSION` table row (created in `0001`) is bumped by the last statement of each migration; API refuses to boot when its code expects a newer schema (ADR-0012).
- Destructive operations (`DROP TABLE`, mass `UPDATE`) require a separate explicit migration file named `NNNN_data_*` and a backup checkpoint; never combine with schema DDL.

## 7. Known divergences accepted (do not "fix" in code review)

1. Polymorphic references (`reference_type/id`, `partner_type/id`, `journal_lines.partner_id`, `user_scopes.scope_id`, `inventory_transactions.reversal_of_id`) have no FK; integrity is service-enforced + reconciled nightly (documented exception to ADR-0003 §11).
2. `ck_sales_orders_paid` forbids order-level over-payment; over-payments belong to customer credit (`partner_transactions`). Finance sign-off required before changing.
3. `warehouse.warehouse_locations.full_code` is a stored denormalized code (fast scanner lookups), kept consistent by service; tree integrity is checked nightly rather than by recursive triggers.
4. `inventory_balances` stores `safety_buffer` and `damaged` so `available` never needs a join with settings; invariant `reserved <= on_hand` is a DB CHECK.
5. `audit_logs` is partitioned and therefore its `public_id` unique index is per-partition; global uniqueness is not needed (public_id is never used to fetch a single audit row by id — filters always carry a time window).
6. `product_barcodes.barcode` is globally unique (scan resolution) — duplicate manufacturer barcodes across variants are a data-quality error, reported by import validation instead of silently allowed.
7. `permissions` is not org-scoped; tenants cannot fork permission semantics (ADR-0008).
8. `account_balances` is a projection table, not a ledger: it can be rebuilt from `journal_lines` with `erp.rebuild_account_balances(period_id)` (worker-only); a rebuild is logged in `audit_logs`.
