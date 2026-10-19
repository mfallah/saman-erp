import { readFileSync, writeFileSync } from 'node:fs';

const P = 'F:/harness/saman-erp/docs/02-data-model/DATA-MODEL.md';
let c = readFileSync(P, 'utf8');
const before = c.length;
const stats = [];
function rep(name, from, to, { regex = false, count = 1 } = {}) {
  if (regex) {
    const re = new RegExp(from, 'gm');
    const n = (c.match(re) || []).length;
    if (n < 1) throw new Error('NO MATCH: ' + name);
    c = c.replace(re, () => to);
    stats.push(`${name}: ${n}`);
  } else {
    if (!c.includes(from)) throw new Error('NO MATCH: ' + name);
    c = c.split(from).join(to);
    stats.push(`${name}: ok`);
  }
}

// ---------- counts ----------
rep('intro count', '۱۹۱ جدول', '۲۱۵ جدول');
rep('inventory header', '## 2. Table inventory (191 tables, 16 module groups)', '## 2. Table inventory (215 tables, 16 module groups)');
rep('module counts', `| 2.1 platform | 21 | 2.9 sales | 10 |
| 2.2 identity | 11 | 2.10 fulfillment | 9 |
| 2.3 org | 6 | 2.11 channels | 16 |
| 2.4 catalog | 18 | 2.12 accounting | 24 |
| 2.5 warehouse | 17 | 2.13 treasury | 12 |
| 2.6 inventory | 16 | 2.14 partners | 8 |
| 2.7 procurement | 7 | 2.15 reporting | 5 |
| 2.8 pricing | 7 | 2.16 automation | 4 |`,
`| 2.1 platform | 34 | 2.9 sales | 10 |
| 2.2 identity | 11 | 2.10 fulfillment | 9 |
| 2.3 org | 6 | 2.11 channels | 16 |
| 2.4 catalog | 18 | 2.12 accounting | 26 |
| 2.5 warehouse | 18 | 2.13 treasury | 14 |
| 2.6 inventory | 20 | 2.14 partners | 9 |
| 2.7 procurement | 8 | 2.15 reporting | 5 |
| 2.8 pricing | 7 | 2.16 automation | 4 |`);
rep('2.1 heading', '### 2.1 Module `platform` — settings, audit, files, notifications, jobs, outbox (21 tables)', '### 2.1 Module `platform` — settings, audit, files, notifications, jobs, webhooks, flags (34 tables)');
rep('2.5 heading', '### 2.5 Module `warehouse` — location tree, putaway, picking, packing, devices (17 tables)', '### 2.5 Module `warehouse` — location tree, putaway, picking, packing, devices (18 tables)');
rep('2.6 heading', '### 2.6 Module `inventory` — ledger, balances, reservations, lots, units, counts, adjustments, transfers, valuation (16 tables)', '### 2.6 Module `inventory` — ledger, balances, cost layers, reservations, lots, units, counts, adjustments, transfers, valuation (20 tables)');
rep('2.7 heading', '### 2.7 Module `procurement` — suppliers, PO, receipts, supplier invoices (7 tables)', '### 2.7 Module `procurement` — suppliers, PO, receipts, scans, supplier invoices (8 tables)');
rep('2.12 heading', '### 2.12 Module `accounting` — 6-level CoA, dimensions, periods, journals, balances, tax, approvals, budgets, expenses (24 tables)', '### 2.12 Module `accounting` — CoA, dimensions, periods, journals, posting rule sets, closing, tax, approvals, budgets, expenses (26 tables)');
rep('2.13 heading', '### 2.13 Module `treasury` — payments, bank/cash accounts, cash sessions, reconciliation, cheques (12 tables)', '### 2.13 Module `treasury` — payments, bank/cash accounts, cash sessions, statements, reconciliation, cheques (14 tables)');
rep('2.14 heading', '### 2.14 Module `partners` — shareholders, partner ledger, profit distribution, channel settlements (8 tables)', '### 2.14 Module `partners` — partners/shares, capital & current ledger, profit distribution, channel settlements (9 tables)');

// ---------- 1.6 enum vocabularies (single shared source, v1.1) ----------
rep('enum vocabulary',
  'Values are `varchar` + `CHECK (... IN (...))`; seeds/API must use these exact tokens. The full lists per column are given in each table\'s `CK` note; the shared vocabularies are: `document_status` = `draft|pending_approval|approved|posted|voided`; `order_status` = `draft|pending|confirmed|allocated|picking|packed|shipped|delivered|completed|cancelled|returned`; `payment_status` = `unpaid|partially_paid|paid|refunded|overpaid`; `fulfillment_status` = `unfulfilled|allocated|picking|packed|partially_shipped|shipped|delivered|cancelled`; `sync_status` = `pending|syncing|synced|failed|skipped`; `job_status` = `queued|running|succeeded|failed|dead|cancelled`.',
  '**v1.1 rule (R1-D B-10):** the vocabulary is defined **once** in `packages/shared/enums.ts`; migration CHECKs are generated from that file and a CI test asserts `pg_get_constraintdef` tokens equal the shared constants. API aliases are normalized in the DTO layer (never stored). Shared vocabularies: `document_status` = `draft|submitted|pending_approval|approved|posted|voided`; `order_status` = `draft|submitted|confirmed|allocated|picking|packed|shipped|delivered|closed|cancelled|on_hold|returned`; `payment_status` = `unpaid|partially_paid|paid|refunded|overpaid`; `fulfillment_status` = `unfulfilled|allocated|picking|packed|partially_shipped|shipped|delivered|cancelled`; `payment_direction` = `inbound|outbound` (API `in|out` mapped in DTO); `sync_status` = `pending|syncing|synced|failed|skipped`; `job_status` = `queued|running|succeeded|failed|dead|cancelled`; `valuation_method` = `moving_average|fifo|standard` (API `weighted_average` maps to `moving_average` in the adapter); `cheque_status` per direction = received: `received|in_custody|deposited|cleared|bounced|endorsed|returned|cancelled`; issued: `issued|cleared|bounced|returned|cancelled`.');

// ---------- inventory_balances checks (B-06) ----------
rep('balances checks',
  'CK `ck_inventory_balances_nonnegative` (`on_hand >= 0 AND reserved >= 0 AND safety_buffer >= 0 AND damaged >= 0 AND in_transit >= 0`); CK `ck_inventory_balances_reserved_le_onhand` (`reserved <= on_hand`); CK `ck_inventory_balances_damaged_le_onhand` (`damaged <= on_hand`).',
  'CK `ck_inventory_balances_nonnegative` (`on_hand >= 0 AND reserved >= 0 AND safety_buffer >= 0 AND damaged >= 0 AND in_transit >= 0`); **CK `ck_inventory_balances_available_nonnegative` (`reserved + safety_buffer + damaged <= on_hand`)** — makes `available = on_hand - reserved - safety_buffer - damaged` provably ≥ 0 in the database (R1-A B-06 / R1-D B-07); CK `ck_inventory_balances_reserved_le_onhand`, `ck_inventory_balances_damaged_le_onhand` retained as readable narrower guards. `available` is **computed in queries/views, never stored** (no drift). Allocation service additionally asserts `available >= requested` per line (ADR-0007 §3) and the 100-allocator test uses non-zero buffers/damaged stock.');
rep('balances last sentence',
  '**Availability formula** (service): `available = on_hand - reserved - safety_buffer - damaged`; channels never see `on_hand` (ADR-0007 §4).',
  '**Availability formula:** `available = on_hand - reserved - safety_buffer - damaged` (exposed by `v_inventory_availability`); channels never see `on_hand` (ADR-0007 §4). Negative availability is impossible: DB CHECK above + allocation assertion + test.');

// ---------- inventory_transactions: period + journal + global dedupe ----------
rep('inv tx columns',
  '`voided_at` timestamptz · `voided_by` bigint · `void_reason` varchar(300) · `business_date` date NN DF `current_date` · `created_by` bigint',
  '`voided_at` timestamptz · `voided_by` bigint · `void_reason` varchar(300) · `business_date` date NN DF `current_date` · **`period_id` bigint NN →accounting_periods.id PD RESTRICT** (derived from `business_date` by trigger, locked `FOR SHARE` before write — B-16) · **`journal_entry_id` bigint →journal_entries.id PD SET NULL** (set when the posting service commits in the same tx) · **`cost_state` varchar(20) NN DF `\'pending\'` CK in (`pending|layered|averaged|reversed`)** (costing completion marker) · `created_by` bigint');
rep('inv tx unique',
  'UQ `uq_inventory_transactions_idempotency` (idempotency_key, created_at) partial `WHERE idempotency_key IS NOT NULL` ·',
  'UQ `uq_inventory_transactions_idempotency_created` (idempotency_key, created_at) partial `WHERE idempotency_key IS NOT NULL` (local dedupe only; **global** dedupe is enforced by the non-partitioned `inventory_ledger_keys` table written in the same transaction — R1-D B-07) · IX `(period_id)` · IX journal_entry_id ·');

// ---------- inventory_lots -> physical batch metadata only ----------
const lotsStart = c.indexOf('**`inventory.inventory_lots`**');
const lotsEnd = c.indexOf('**`inventory.inventory_serials`**');
if (lotsStart < 0 || lotsEnd < 0) throw new Error('lots block markers');
c = c.slice(0, lotsStart) + `**\`inventory.inventory_lots\`** — **physical batch/lot metadata only** (v1.1, R1-A B-07): supplier batch, expiry, provenance. Cost is carried by \`inventory_cost_layers\`, never by lots; repeated supplier lot numbers across receipts are allowed and do not merge cost.
\`organization_id\` bigint NN · \`product_variant_id\` bigint NN →product_variants.id PD RESTRICT · \`warehouse_id\` bigint NN →warehouses.id PD RESTRICT · \`lot_no\` varchar(100) NN · \`batch_barcode\` varchar(120) · \`manufacture_date\` date · \`expiry_date\` date · \`supplier_id\` bigint →suppliers.id PD SET NULL · \`goods_receipt_line_id\` bigint →goods_receipt_lines.id PD SET NULL · \`status\` varchar(20) NN DF \`'available'\` CK in (\`available|quarantine|expired|depleted|blocked\`) · \`expiry_alert_at\` timestamptz
UQ \`uq_inventory_lots_receipt_lot\` (goods_receipt_line_id, lot_no) (one lot row per receipt line+lot; many receipts may share a supplier lot_no) · UQ \`uq_inventory_lots_batch_barcode\` (batch_barcode) partial \`WHERE batch_barcode IS NOT NULL\` · IX product_variant_id · IX \`(warehouse_id, expiry_date)\` partial \`WHERE status = 'available'\` · IX supplier_id · IX goods_receipt_line_id · CK \`ck_inventory_lots_expiry\` (\`expiry_date IS NULL OR manufacture_date IS NULL OR expiry_date >= manufacture_date\`). FEFO/FIFO ordering now lives on cost layers.

` + c.slice(lotsEnd);

// ---------- journal_entries (B-03, B-09, B-10, B-02) ----------

const jeStart = c.indexOf('**`accounting.journal_entries`**');
const jeEnd = c.indexOf('**`accounting.journal_lines`**');
if (jeStart < 0 || jeEnd < 0) throw new Error('journal block markers');
c = c.slice(0, jeStart) + `**\`accounting.journal_entries\`** — journal header (سند حسابداری). Number allocated **only at post** (nullable in draft, gap-free on posting — R1-D B-02); period is **derived from \`entry_date\`** by trigger (R1-A B-09); posted rows are immutable, corrections are reversal entries. May be linked to the exact posting rule version used.
\`organization_id\` bigint NN · \`fiscal_year_id\` bigint NN →fiscal_years.id PD RESTRICT · \`period_id\` bigint NN →accounting_periods.id PD RESTRICT (trigger-derived; must match \`entry_date\`) · **\`entry_no\` varchar(60) NULL** · \`entry_date\` date NN · \`business_date\` date NN (must equal \`entry_date\` in v1) · \`entry_type\` varchar(20) NN DF \`'normal'\` CK in (\`normal|opening|adjustment|reversal|closing|auto\`) · \`source_type\` varchar(50) · \`source_id\` bigint · \`source_public_id\` uuid · **\`source_event_uuid\` uuid** (idempotent posting from an outbox event) · \`description\` text NN · \`status\` varchar(20) NN DF \`'draft'\` CK (document_status vocabulary) · \`posted_at\` timestamptz · \`posted_by\` bigint →users.id PD SET NULL · \`reversal_of_id\` bigint →journal_entries.id PD RESTRICT · \`voided_at\` timestamptz · \`void_reason\` varchar(300) · \`total_debit_amount\` bigint NN DF 0 · \`total_credit_amount\` bigint NN DF 0 · \`approval_request_id\` bigint →approval_requests.id PD SET NULL · **\`posting_rule_set_id\` bigint →posting_rule_sets.id PD SET NULL** (version of the rule set that produced the entry, NULL for manual)
UQ \`uq_journal_entries_org_no\` (organization_id, entry_no) (NULLs distinct; partial unique below) · **partial unique \`uq_journal_entries_org_no_notnull ON (organization_id, entry_no) WHERE entry_no IS NOT NULL\`** · **UQ \`uq_journal_entries_source_event\` (source_event_uuid) partial \`WHERE source_event_uuid IS NOT NULL\`** (exactly-once posting) · IX \`(period_id, entry_date)\` · IX \`(source_type, source_id)\` · IX \`(status, entry_date DESC)\` · IX fiscal_year_id · IX reversal_of_id · IX posting_rule_set_id · **CK \`ck_journal_entries_numbered\` (\`status NOT IN ('posted','approved') OR entry_no IS NOT NULL\`)** · CK \`ck_journal_entries_balanced\` (\`total_debit_amount = total_credit_amount\`) · CK \`ck_journal_entries_posted\` (\`status <> 'posted' OR posted_at IS NOT NULL\`) · CK \`ck_journal_entries_reversal\` · CK \`ck_journal_entries_totals_nonnegative\`. **Balance is enforced at COMMIT by deferred constraint trigger \`trg_journal_entries_assert_balanced\` on \`journal_entries\`** (R1-D B-03): for \`status='posted'\` asserts ≥2 lines, \`Σ debit = Σ credit = total_debit_amount = total_credit_amount > 0\`; stale/empty headers are impossible.

` + c.slice(jeEnd);

// ---------- journal_lines checks ----------
rep('journal lines checks',
  'CK `ck_journal_lines_one_side` (`(debit_amount > 0 AND credit_amount = 0) OR (credit_amount > 0 AND debit_amount = 0) OR (debit_amount = 0 AND credit_amount = 0)` — zero lines rejected by service) · CK `ck_journal_lines_signed` (`debit_amount = 0 OR credit_amount = 0`). Deferred constraint trigger `trg_journal_entries_assert_balanced` checks entry totals on `AFTER INSERT OR UPDATE` of lines (`DEFERRABLE INITIALLY DEFERRED`).',
  'CK `ck_journal_lines_one_side` (`(debit_amount > 0 AND credit_amount = 0) OR (credit_amount > 0 AND debit_amount = 0)`) — **zero/zero lines are rejected in the DB** (R1-D B-03) · CK `ck_journal_lines_nonnegative` (`debit_amount >= 0 AND credit_amount >= 0`). Deferred constraint trigger `trg_journal_entries_assert_balanced` (on `journal_entries`, `DEFERRABLE INITIALLY DEFERRED`) validates the whole entry at COMMIT; it also fires for an entry inserted with zero lines.');

// ---------- refunds: credit note link ----------
rep('refund credit note', '`payment_id` bigint →payments.id PD SET NULL · `approval_request_id` bigint →approval_requests.id PD SET NULL · `approved_by` bigint →users.id PD SET NULL · `processed_at` timestamptz · `journal_entry_id` bigint →journal_entries.id PD SET NULL · `reason` text', '`payment_id` bigint →payments.id PD SET NULL · `approval_request_id` bigint →approval_requests.id PD SET NULL · `approved_by` bigint →users.id PD SET NULL · `processed_at` timestamptz · `journal_entry_id` bigint →journal_entries.id PD SET NULL · **`credit_note_id` bigint →customer_invoices.id PD SET NULL** (VAT credit note issued in the same tx — B-11) · `reason` text');

// ---------- write ----------
writeFileSync(P, c, 'utf8');
console.log('bytes', before, '->', c.length);
console.log(stats.join('\n'));
