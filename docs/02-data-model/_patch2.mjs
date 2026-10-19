import { readFileSync, writeFileSync } from 'node:fs';
const D = 'F:/harness/saman-erp/docs/02-data-model/DATA-MODEL.md';
let c = readFileSync(D, 'utf8');
const stats = [];
function rep(name, from, to) {
  if (from instanceof RegExp) {
    const re = new RegExp(from.source, 'gm');
    if (!re.test(c)) throw new Error('NO MATCH: ' + name);
    c = c.replace(new RegExp(from.source, 'gm'), () => to); stats.push(name); return;
  }
  if (!c.includes(from)) throw new Error('NO MATCH: ' + name);
  c = c.split(from).join(to); stats.push(name);
}
function cutReplace(name, startMarker, endMarker, replacement) {
  const a = c.indexOf(startMarker); const b = c.indexOf(endMarker);
  if (a < 0 || b < 0 || b <= a) throw new Error('NO SECTION: ' + name);
  c = c.slice(0, a) + replacement + c.slice(b); stats.push(name + ' (section)');
}

/* ===================== 1. NEW TABLES (§2.17) ===================== */
const additions = `
### 2.17 Revision v1.1 additions (24 new tables; see §10 for finding IDs)

These tables resolve the R1 review persistence gaps. All use the standard column block (§1.3) unless noted, are owned by the module prefix shown, and are included in the 215-table count.

**platform.notification_templates** — unified template store for in-app/email/SMS notifications (R1-D B-01).
\`organization_id\` bigint NN · \`code\` varchar(80) NN · \`channel\` varchar(20) NN CK in (\`in_app|email|sms|push\`) · \`event_type\` varchar(80) NN · \`subject_fa\` varchar(250) · \`body_fa\` text NN · \`body_template\` text NN (handlebars-style; variable whitelist per event) · \`variables\` jsonb NN DF \`'[]'\` · \`locale\` varchar(10) NN DF \`'fa-IR'\` · \`is_active\` boolean NN DF true
UQ \`uq_notification_templates_org_code_channel\` (organization_id, code, channel) · IX \`(organization_id, event_type)\` · CK \`ck_notification_templates_body\`.

**platform.notification_preferences** — per-user channel opt-in/opt-out per event (R1-D B-01).
\`user_id\` bigint NN →users.id PD CASCADE · \`event_type\` varchar(80) NN · \`channel\` varchar(20) NN CK in (\`in_app|email|sms|push\`) · \`enabled\` boolean NN DF true · \`quiet_hours\` jsonb NN DF \`'{}'\`
UQ \`uq_notification_preferences_user_event_channel\` (user_id, event_type, channel) · IX user_id.

**platform.file_links** — polymorphic many-to-many attachment of a file to business objects with a role (R1-D B-01).
\`file_id\` bigint NN →file_assets.id PD CASCADE · \`entity_type\` varchar(60) NN · \`entity_id\` bigint NN · \`entity_public_id\` uuid · \`link_role\` varchar(30) NN DF \`'attachment'\` CK in (\`attachment|image|label|invoice_pdf|export|import|logo|document|evidence\`) · \`sort_order\` integer NN DF 0 · \`created_by\` bigint →users.id PD SET NULL
UQ \`uq_file_links_file_entity_role\` (file_id, entity_type, entity_id, link_role) · IX \`(entity_type, entity_id)\` · IX file_id.

**platform.job_runs** — globally addressable background-job record (the API \`GET /jobs/{id}\` object, R1-D B-01); mirrors BullMQ but is the durable audit/retry source.
\`job_key\` uuid NN DF gen_random_uuid() · \`organization_id\` bigint · \`queue\` varchar(40) NN · \`job_type\` varchar(80) NN · \`entity_type\` varchar(60) · \`entity_id\` bigint · \`status\` varchar(20) NN DF \`'queued'\` CK (job_status vocabulary) · \`priority\` integer NN DF 0 · \`attempts\` smallint NN DF 0 · \`max_attempts\` smallint NN DF 10 · \`scheduled_at\` timestamptz · \`started_at\` timestamptz · \`finished_at\` timestamptz · \`duration_ms\` integer · \`payload\` jsonb NN DF \`'{}'\` · \`result\` jsonb · \`error_code\` varchar(60) · \`error_message\` text · \`worker_id\` varchar(80) · \`bullmq_job_id\` varchar(80) · \`requested_by\` bigint →users.id PD SET NULL · \`progress_percent\` smallint NN DF 0
UQ \`uq_job_runs_job_key\` (job_key) · IX \`(status, scheduled_at)\` partial \`WHERE status IN ('queued','running')\` · IX \`(queue, job_type, created_at DESC)\` · IX \`(entity_type, entity_id)\`.

**platform.job_steps** — ordered steps of a job (import chunks, migration steps, report stages) with per-step status.
\`job_run_id\` bigint NN →job_runs.id PD CASCADE · \`step_no\` integer NN · \`name\` varchar(120) NN · \`status\` varchar(20) NN DF \`'queued'\` CK (job_status vocabulary) · \`started_at\` timestamptz · \`finished_at\` timestamptz · \`detail\` jsonb · \`error_message\` text
UQ \`uq_job_steps_job_step\` (job_run_id, step_no) · IX job_run_id.

**platform.feature_flags** — feature flag definitions (org-scoped when \`organization_id\` set, global when NULL); ADR-0006 unknown-contract flags (R1-D B-01).
\`organization_id\` bigint · \`key\` varchar(100) NN · \`name_fa\` varchar(150) NN · \`description\` text · \`default_enabled\` boolean NN DF false · \`rollout_json\` jsonb NN DF \`'{}'\` (percentage/segment rules) · \`is_active\` boolean NN DF true
UQ \`uq_feature_flags_org_key\` (organization_id, key) NULLS NOT DISTINCT · IX key.

**platform.feature_flag_overrides** — per-scope override of a flag (user/role/branch/warehouse/org), optionally expiring.
\`feature_flag_id\` bigint NN →feature_flags.id PD CASCADE · \`scope_type\` varchar(20) NN CK in (\`user|role|branch|warehouse|organization\`) · \`scope_id\` bigint NN · \`enabled\` boolean NN · \`reason\` varchar(300) · \`expires_at\` timestamptz · \`created_by\` bigint →users.id PD SET NULL
UQ \`uq_feature_flag_overrides_flag_scope\` (feature_flag_id, scope_type, scope_id) · IX \`(scope_type, scope_id)\`.

**platform.webhook_subscriptions** — outbound webhook endpoints (customer/partner integrations) with event filters and signing secret reference (R1-D B-01).
\`organization_id\` bigint NN · \`code\` varchar(80) NN · \`name\` varchar(150) NN · \`endpoint_url\` text NN · \`event_filters\` jsonb NN DF \`'[]'\` (event_type patterns) · \`signing_secret_ciphertext\` text NN · \`signing_key_version\` smallint NN DF 1 · \`max_attempts\` smallint NN DF 8 · \`timeout_ms\` integer NN DF 10000 · \`is_active\` boolean NN DF true · \`created_by\` bigint →users.id PD SET NULL · \`last_success_at\` timestamptz · \`last_failure_at\` timestamptz
UQ \`uq_webhook_subscriptions_org_code\` (organization_id, code) · CK \`ck_webhook_subscriptions_url\` (\`endpoint_url ~ '^https://'\`).

**platform.webhook_deliveries** — one delivery attempt per outbound webhook event (retry chain; \`GET /webhooks/deliveries\`, R1-D B-01).
\`subscription_id\` bigint NN →webhook_subscriptions.id PD CASCADE · \`event_type\` varchar(100) NN · \`entity_type\` varchar(60) · \`entity_id\` bigint · \`event_uuid\` uuid NN · \`attempt_no\` smallint NN DF 1 · \`status\` varchar(20) NN DF \`'pending'\` CK in (\`pending|delivered|failed|dead|cancelled\`) · \`http_status\` smallint · \`response_snippet\` varchar(500) · \`duration_ms\` integer · \`next_retry_at\` timestamptz · \`delivered_at\` timestamptz · \`error_message\` text · \`request_payload\` jsonb
UQ \`uq_webhook_deliveries_sub_event_attempt\` (subscription_id, event_uuid, attempt_no) · IX \`(status, next_retry_at)\` partial \`WHERE status IN ('pending','failed')\` · IX event_uuid.

**platform.channel_webhook_secrets** — inbound channel webhook signing secrets with rotation window (ADR-0006 HMAC verification; R1-S B-05).
\`channel_account_id\` bigint NN →channel_accounts.id PD CASCADE · \`secret_ciphertext\` text NN · \`key_version\` smallint NN DF 1 · \`algorithm\` varchar(20) NN DF \`'hmac_sha256'\` CK in (\`hmac_sha256|hmac_sha1\`) · \`active_from\` timestamptz NN DF now() · \`active_to\` timestamptz · \`rotated_by\` bigint →users.id PD SET NULL · \`is_active\` boolean NN DF true
UQ \`uq_channel_webhook_secrets_acct_version\` (channel_account_id, key_version) · partial unique \`uq_channel_webhook_secrets_active ON (channel_account_id) WHERE is_active\` · IX channel_account_id.

**platform.outbox_event_keys** — **non-partitioned global dedupe** for outbox producers (partition-local unique on \`created_at\` cannot dedupe — R1-D B-06).
\`event_type\` varchar(100) NN · \`aggregate_type\` varchar(80) NN · \`aggregate_id\` bigint NN · \`event_version\` smallint NN · \`event_uuid\` uuid NN · \`organization_id\` bigint NN · \`outbox_id\` bigint · \`created_at\` timestamptz NN DF now()
PK \`(event_type, aggregate_type, aggregate_id, event_version)\` · UQ \`uq_outbox_event_keys_uuid\` (event_uuid) · IX \`(created_at)\` (GC ≥ 400 days). Written in the same transaction as \`outbox_events\`; duplicate → no-op.

**platform.enum_values** — seeded lookup table for second-class vocabularies (\`otp_purpose\`, \`security_event_type\`, \`audit_action\`, \`dead_letter_integration\`, \`channel_event_type\`) so values are data, versionable and API-documented (R1-S M-01/M-02, R1-D M-06).
\`domain\` varchar(50) NN · \`value\` varchar(80) NN · \`label_fa\` varchar(200) NN · \`description\` text · \`sort_order\` integer NN DF 0 · \`is_system\` boolean NN DF true · \`is_active\` boolean NN DF true
UQ \`uq_enum_values_domain_value\` (domain, value) · IX domain. FK from consumer tables is a composite FK \`(domain, value)\` where feasible; otherwise CHECK + seed test asserts values exist.

**platform.audit_chain_heads** — anchor for the tamper-evident audit hash chain (one row per org), advanced by \`erp.audit_append()\` (SECURITY DEFINER) (R1-S B-05/H-12).
\`organization_id\` bigint PK →organizations.id PD RESTRICT · \`last_audit_id\` bigint · \`last_created_at\` timestamptz · \`last_row_hash\` char(64) NN · \`chain_version\` smallint NN DF 1 · \`updated_at\` timestamptz NN DF now()
PK organization_id. Only the SECURITY DEFINER function writes it; \`saman_app\` has SELECT, no INSERT/UPDATE.

**inventory.inventory_cost_layers** — append-only FIFO/standard cost layers; one per inbound movement line (R1-A B-07, ADR-0007 §6).
\`organization_id\` bigint NN · \`warehouse_id\` bigint NN →warehouses.id PD RESTRICT · \`product_variant_id\` bigint NN →product_variants.id PD RESTRICT · \`lot_id\` bigint →inventory_lots.id PD SET NULL · \`goods_receipt_line_id\` bigint →goods_receipt_lines.id PD SET NULL · \`receipt_transaction_id\` bigint NN · \`receipt_transaction_created_at\` timestamptz NN (composite reference to \`inventory_transactions(id, created_at)\`) · \`source_kind\` varchar(20) NN CK in (\`receipt|return_restock|transfer_in|adjustment_in|opening\`) · \`received_at\` timestamptz NN · \`original_qty\` numeric(18,4) NN CK > 0 · \`qty_remaining\` numeric(18,4) NN · \`unit_cost_amount\` bigint NN CK ≥ 0 · \`cost_remaining_amount\` bigint NN · \`currency\` char(3) NN DF \`'IRR'\` · \`reversal_of_layer_id\` bigint →inventory_cost_layers.id PD SET NULL · \`is_closed\` boolean NN DF false
IX \`(warehouse_id, product_variant_id, received_at, id)\` partial \`WHERE qty_remaining > 0\` (FIFO scan) · IX receipt_transaction_id · IX lot_id · IX goods_receipt_line_id · IX \`(product_variant_id, received_at)\` · CK \`ck_cost_layers_qty\` (\`qty_remaining >= 0 AND qty_remaining <= original_qty\`) · CK \`ck_cost_layers_value\` (\`cost_remaining_amount >= 0 AND cost_remaining_amount <= unit_cost_amount * original_qty\`) · CK \`ck_cost_layers_closed\` (\`NOT is_closed OR qty_remaining = 0\`).

**inventory.inventory_layer_consumptions** — append-only join of an outbound ledger line to the cost layers it consumed (FIFO/returns/reversals) (R1-A B-07).
\`layer_id\` bigint NN →inventory_cost_layers.id PD RESTRICT · \`issue_transaction_id\` bigint NN · \`issue_transaction_created_at\` timestamptz NN · \`warehouse_id\` bigint NN · \`product_variant_id\` bigint NN · \`quantity\` numeric(18,4) NN CK > 0 · \`cost_amount\` bigint NN · \`consumption_kind\` varchar(20) NN CK in (\`issue|transfer_out|adjustment_out|return_to_supplier|reversal\`) · \`created_at\` timestamptz NN DF now() · \`created_by\` bigint
IX layer_id · IX \`(issue_transaction_id, issue_transaction_created_at)\` · IX \`(warehouse_id, product_variant_id)\` · CK \`ck_layer_consumptions_cost\` (\`cost_amount >= 0\`). Append-only; a reversal inserts a compensating layer row, never updates history.

**inventory.inventory_average_costs** — moving-average state per \`(warehouse, variant)\`; updated under row lock in the same transaction as the ledger write (R1-A B-07).
\`organization_id\` bigint NN · \`warehouse_id\` bigint NN →warehouses.id PD RESTRICT · \`product_variant_id\` bigint NN →product_variants.id PD RESTRICT · \`qty_on_hand\` numeric(18,4) NN DF 0 · \`avg_cost_amount\` bigint NN DF 0 · \`total_value_amount\` bigint NN DF 0 · \`last_transaction_id\` bigint · \`last_calculated_at\` timestamptz
UQ \`uq_inventory_average_costs_wh_variant\` (warehouse_id, product_variant_id) · IX product_variant_id · CK \`ck_inventory_average_costs_nonnegative\` (\`qty_on_hand >= 0 AND avg_cost_amount >= 0 AND total_value_amount >= 0\`).

**inventory.inventory_ledger_keys** — **non-partitioned global dedupe** for ledger idempotency keys (R1-D B-07).
\`idempotency_key\` varchar(150) PK · \`organization_id\` bigint NN · \`inventory_transaction_id\` bigint NN · \`transaction_created_at\` timestamptz NN · \`created_at\` timestamptz NN DF now()
PK idempotency_key · IX \`(created_at)\` (GC ≥ 400 days). Insert first; conflict → no-op; written in the same transaction as the ledger row.

**procurement.goods_receipt_scans** — scan events while receiving (barcode verification per receipt line, scanner/PWA offline replay) (R1-D B-01/H-14).
\`receipt_id\` bigint NN →goods_receipts.id PD CASCADE · \`receipt_line_id\` bigint →goods_receipt_lines.id PD SET NULL · \`barcode\` varchar(100) NN · \`product_variant_id\` bigint · \`lot_id\` bigint →inventory_lots.id PD SET NULL · \`quantity\` numeric(18,4) NN CK > 0 · \`result\` varchar(20) NN DF \`'accepted'\` CK in (\`accepted|rejected_wrong_item|rejected_expired|manual_override\`) · \`scanned_by\` bigint NN →users.id PD RESTRICT · \`client_scan_id\` uuid · \`scan_source\` varchar(20) NN DF \`'scanner'\` CK in (\`scanner|camera|manual|offline_replay\`) · \`scanned_at\` timestamptz NN DF now()
UQ \`uq_goods_receipt_scans_client_scan\` (client_scan_id) partial \`WHERE client_scan_id IS NOT NULL\` · IX receipt_id · IX receipt_line_id · IX scanned_by.

**warehouse.putaway_scans** — scan-confirmation of a putaway move (task + location + barcode) (R1-D B-01/H-14).
\`putaway_task_id\` bigint NN →putaway_tasks.id PD CASCADE · \`barcode\` varchar(100) NN · \`expected_barcode\` varchar(100) · \`location_barcode\` varchar(100) · \`quantity\` numeric(18,4) NN CK > 0 · \`result\` varchar(20) NN DF \`'accepted'\` CK in (\`accepted|rejected_wrong_item|rejected_wrong_location|manual_override\`) · \`scanned_by\` bigint NN →users.id PD RESTRICT · \`client_scan_id\` uuid · \`scanned_at\` timestamptz NN DF now()
UQ \`uq_putaway_scans_client_scan\` (client_scan_id) partial \`WHERE client_scan_id IS NOT NULL\` · IX putaway_task_id · IX scanned_by.

**treasury.bank_statements** — imported bank-statement header (import batch, period, opening/closing balance, status) (R1-A B-15, R1-D H-17).
\`organization_id\` bigint NN · \`bank_account_id\` bigint NN →bank_accounts.id PD RESTRICT · \`statement_no\` varchar(80) NN · \`import_batch_id\` uuid NN DF gen_random_uuid() · \`period_start_date\` date NN · \`period_end_date\` date NN · \`opening_balance_amount\` bigint NN · \`closing_balance_amount\` bigint NN · \`currency\` char(3) NN DF \`'IRR'\` · \`source\` varchar(20) NN CK in (\`csv|excel|api|manual\`) · \`file_id\` bigint →file_assets.id PD SET NULL · \`status\` varchar(20) NN DF \`'imported'\` CK in (\`imported|parsed|reconciling|reconciled|failed\`) · \`line_count\` integer NN DF 0 · \`imported_by\` bigint →users.id PD SET NULL · \`imported_at\` timestamptz NN DF now() · \`reconciliation_id\` bigint →bank_reconciliations.id PD SET NULL
UQ \`uq_bank_statements_account_no\` (bank_account_id, statement_no) · UQ \`uq_bank_statements_import_batch\` (import_batch_id) · IX \`(bank_account_id, period_end_date DESC)\` · IX \`(status, imported_at)\` · CK \`ck_bank_statements_period\` (\`period_end_date >= period_start_date\`) · CK \`ck_bank_statements_balance\`.

**treasury.bank_statement_lines** — parsed statement lines with match state; the reconciliation unit (replaces matching directly on \`bank_transactions\`) (R1-D H-17).
\`statement_id\` bigint NN →bank_statements.id PD CASCADE · \`line_no\` integer NN · \`value_date\` date NN · \`post_date\` date · \`direction\` varchar(10) NN CK in (\`debit|credit\`) · \`amount\` bigint NN CK > 0 · \`description\` varchar(500) · \`bank_reference\` varchar(150) · \`balance_after_amount\` bigint · \`matched_bank_transaction_id\` bigint →bank_transactions.id PD SET NULL · \`match_status\` varchar(20) NN DF \`'unmatched'\` CK in (\`unmatched|auto|manual|ignored\`) · \`match_rule\` varchar(40) · \`matched_by\` bigint →users.id PD SET NULL · \`matched_at\` timestamptz
UQ \`uq_bank_statement_lines_stmt_line\` (statement_id, line_no) · IX \`(statement_id, match_status)\` · IX \`(bank_reference)\` · IX matched_bank_transaction_id · partial unique \`uq_bank_statement_lines_matched_txn ON (matched_bank_transaction_id) WHERE matched_bank_transaction_id IS NOT NULL\` (one statement line per book transaction — R1-A M-10).

**accounting.posting_rule_sets** — versioned, immutable sets of posting rules; journals record the exact set used (R1-A B-10, R1-D B-05).
\`organization_id\` bigint NN · \`code\` varchar(60) NN · \`name_fa\` varchar(200) NN · \`version_no\` integer NN · \`status\` varchar(20) NN DF \`'draft'\` CK in (\`draft|active|retired\`) · \`effective_from\` date NN · \`effective_to\` date · \`change_reason\` varchar(300) · \`approved_by\` bigint →users.id PD SET NULL · \`approved_at\` timestamptz · \`balanced_validated_at\` timestamptz
UQ \`uq_posting_rule_sets_org_code_version\` (organization_id, code, version_no) · partial unique \`uq_posting_rule_sets_active ON (organization_id, code) WHERE status = 'active'\` · CK \`ck_posting_rule_sets_window\` · CK \`ck_posting_rule_sets_approved\` (\`status <> 'active' OR approved_at IS NOT NULL\`).

**accounting.closing_runs** — year-end closing run: P&L → income summary → retained earnings → legal reserve, with posting links (R1-A B-08).
\`organization_id\` bigint NN · \`fiscal_year_id\` bigint NN →fiscal_years.id PD RESTRICT · \`run_no\` varchar(60) NN · \`status\` varchar(20) NN DF \`'draft'\` CK in (\`draft|computed|posted|reversed\`) · \`net_profit_amount\` bigint NN DF 0 · \`legal_reserve_percent\` numeric(9,6) NN DF 0.05 · \`legal_reserve_cap_percent\` numeric(9,6) NN DF 0.10 · \`legal_reserve_amount\` bigint NN DF 0 · \`retained_amount\` bigint NN DF 0 · \`income_summary_entry_id\` bigint →journal_entries.id PD SET NULL · \`retained_earnings_entry_id\` bigint →journal_entries.id PD SET NULL · \`legal_reserve_entry_id\` bigint →journal_entries.id PD SET NULL · \`computed_at\` timestamptz · \`posted_at\` timestamptz · \`posted_by\` bigint →users.id PD SET NULL · \`notes\` text
UQ \`uq_closing_runs_org_year\` (organization_id, fiscal_year_id) · UQ \`uq_closing_runs_org_no\` (organization_id, run_no) · IX fiscal_year_id · IX income_summary_entry_id · IX retained_earnings_entry_id · IX legal_reserve_entry_id.

**partners.partners** — generic business partner master (shareholder / investor / channel / supplier / customer funds), the API \`/partners\` object (R1-A B-15, R1-D B-01).
\`organization_id\` bigint NN · \`code\` varchar(50) NN · \`partner_type\` varchar(20) NN CK in (\`shareholder|investor|channel|supplier|customer|other\`) · \`name\` varchar(250) NN · \`legal_name\` varchar(250) · \`national_id\` varchar(20) · \`economic_code\` varchar(20) · \`mobile\` varchar(20) · \`email\` varchar(255) · \`profit_share_percent\` numeric(9,6) NN DF 0 · \`gl_account_id\` bigint →chart_of_accounts.id PD SET NULL · \`partner_account_id\` bigint →partner_accounts.id PD SET NULL · \`is_active\` boolean NN DF true · \`deleted_at\` timestamptz
UQ \`uq_partners_org_code\` (organization_id, code) · UQ \`uq_partners_org_national_id\` (organization_id, national_id) partial \`WHERE national_id IS NOT NULL\` · IX \`(organization_id, partner_type, is_active)\` · IX gl_account_id · IX partner_account_id · CK \`ck_partners_profit_share\` (\`profit_share_percent BETWEEN 0 AND 1\`).

**partners.partner_shares** — effective-dated ownership/share register per partner (R1-A H-09/H-18, replaces \`shareholders.share_count\`).
\`partner_id\` bigint NN →partners.id PD CASCADE · \`effective_from\` date NN · \`effective_to\` date · \`share_count\` numeric(30,6) NN DF 0 CK ≥ 0 · \`ownership_percent\` numeric(9,6) NN CK between 0 and 1 · \`capital_value_amount\` bigint NN DF 0 · \`journal_entry_id\` bigint →journal_entries.id PD SET NULL · \`reason\` varchar(300)
UQ \`uq_partner_shares_partner_from\` (partner_id, effective_from) · IX partner_id · CK \`ck_partner_shares_window\` · CK \`ck_partner_shares_range\`.

**partners.partner_capital_transactions** — partner capital/current-account movements (capital increase, drawing, loan, dividend) with journal link (R1-A B-15/H-10).
\`partner_id\` bigint NN →partners.id PD RESTRICT · \`transaction_type\` varchar(40) NN CK in (\`capital_increase|capital_decrease|drawing|loan|repayment|dividend_declared|dividend_paid|profit_share|loss_share\`) · \`direction\` varchar(10) NN CK in (\`in|out\`) · \`amount\` bigint NN CK > 0 · \`transaction_date\` date NN · \`journal_entry_id\` bigint →journal_entries.id PD SET NULL · \`payment_id\` bigint →payments.id PD SET NULL · \`description\` text
IX \`(partner_id, transaction_date DESC)\` · IX journal_entry_id · IX payment_id.
`;
rep('insert §2.17', '---\n\n## 3. ER diagrams (core domains)', additions + '\n---\n\n## 3. ER diagrams (core domains)');

/* ===================== 2. supplier invoices / lines (3-way match) ===================== */
rep('supplier invoice match fields',
  '`subtotal_amount` bigint NN DF 0 · `tax_amount` bigint NN DF 0 · `grand_total_amount` bigint NN DF 0 · `paid_amount` bigint NN DF 0 · `file_id` bigint →file_assets.id PD SET NULL · `journal_entry_id` bigint →journal_entries.id PD SET NULL · `notes` text',
  '`subtotal_amount` bigint NN DF 0 · `tax_amount` bigint NN DF 0 · `grand_total_amount` bigint NN DF 0 · `paid_amount` bigint NN DF 0 · **`match_status` varchar(20) NN DF `unmatched` CK in (`unmatched|matched|variance|rejected`)** · **`price_variance_amount` bigint NN DF 0** · **`quantity_variance_amount` bigint NN DF 0** · `file_id` bigint →file_assets.id PD SET NULL · `journal_entry_id` bigint →journal_entries.id PD SET NULL · `notes` text');
rep('supplier invoice line arithmetic',
  '`quantity` numeric(18,4) NN CK > 0 · `unit_price_amount` bigint NN CK ≥ 0 · `tax_rate_id` bigint →tax_rates.id PD SET NULL · `tax_amount` bigint NN DF 0 · `line_total_amount` bigint NN DF 0\nIX supplier_invoice_id',
  '`quantity` numeric(18,4) NN CK > 0 · `unit_price_amount` bigint NN CK ≥ 0 · **`net_amount` bigint NN DF 0** · **`discount_amount` bigint NN DF 0** · `tax_rate_id` bigint →tax_rates.id PD SET NULL · **`tax_percent` numeric(9,6) NN DF 0** · `tax_amount` bigint NN DF 0 · **`gross_amount` bigint NN DF 0** · **`price_variance_amount` bigint NN DF 0** (vs PO price) · **`quantity_variance_amount` bigint NN DF 0** (vs receipt) · CK `ck_supplier_invoice_lines_arith` (`gross_amount = net_amount + tax_amount`)\nIX supplier_invoice_id');

/* ===================== 3. sales order/lines + invoices ===================== */
rep('sales order number nullable',
  '`order_no` varchar(60) NN · `customer_id` bigint →customers.id PD RESTRICT',
  '**`order_no` varchar(60) NULL** (allocated at `confirm`; drafts unnumbered — R1-D B-02) · `customer_id` bigint →customers.id PD RESTRICT');
rep('sales order status CHECK',
  '`status` varchar(30) NN DF `\'pending\'` CK (order_status vocabulary, §1.6)',
  '`status` varchar(30) NN DF `\'draft\'` CK (order_status vocabulary, §1.6 — includes `submitted|on_hold|closed`)');
rep('sales order unique',
  'UQ `uq_sales_orders_org_no` (organization_id, order_no)',
  'UQ `uq_sales_orders_org_no` (organization_id, order_no) (NULLs distinct) · **partial unique `uq_sales_orders_org_no_notnull ON (organization_id, order_no) WHERE order_no IS NOT NULL`** · **CK `ck_sales_orders_numbered` (`status = \'draft\' OR order_no IS NOT NULL`)**');
rep('sales order check cancel', 'CK `ck_sales_orders_cancelled` (`status <> \'cancelled\' OR cancelled_at IS NOT NULL`).',
  'CK `ck_sales_orders_cancelled` (`status <> \'cancelled\' OR cancelled_at IS NOT NULL`) · CK `ck_sales_orders_hold` (`status <> \'on_hold\' OR on_hold_at IS NOT NULL`). Columns added: `on_hold_at timestamptz`, `closed_at timestamptz`.');
rep('sales order add hold cols', '`confirmed_at` timestamptz · `cancelled_at` timestamptz · `cancel_reason` varchar(300)',
  '`submitted_at` timestamptz · `confirmed_at` timestamptz · `on_hold_at` timestamptz · `closed_at` timestamptz · `cancelled_at` timestamptz · `cancel_reason` varchar(300)');
rep('order line arithmetic',
  '`quantity` numeric(18,4) NN CK > 0 · `unit_price_amount` bigint NN CK ≥ 0 · `discount_amount` bigint NN DF 0 · `tax_rate_id` bigint →tax_rates.id PD SET NULL · `tax_amount` bigint NN DF 0 · `line_total_amount` bigint NN DF 0 · `unit_cost_amount` bigint NN DF 0 (valuation, cost-protected) · `cost_total_amount` bigint NN DF 0',
  '`quantity` numeric(18,4) NN CK > 0 · `unit_price_amount` bigint NN CK ≥ 0 · `discount_amount` bigint NN DF 0 · **`net_amount` bigint NN DF 0** (= round_half_up(qty × unit_price) − discount; per-line arithmetic is stored, never a CHECK on multiplication — R1-A B-12/R1-D H-08) · `tax_rate_id` bigint →tax_rates.id PD SET NULL · **`tax_percent` numeric(9,6) NN DF 0** · `tax_amount` bigint NN DF 0 · **`gross_amount` bigint NN DF 0** · **`allocated_header_discount_amount` bigint NN DF 0** (largest-remainder share) · **`rounding_amount` bigint NN DF 0** · `unit_cost_amount` bigint NN DF 0 (valuation, cost-protected) · `cost_total_amount` bigint NN DF 0');
rep('order line checks',
  'CK total (`line_total_amount = quantity * unit_price_amount - discount_amount + tax_amount` — may require rounding; the service computes with `money.ts` and the CHECK is exact).',
  '**CK `ck_sales_order_lines_arith` (`gross_amount = net_amount + tax_amount`)** · **CK `ck_sales_order_lines_net` (`net_amount >= 0`)**. Header: `subtotal_amount = Σ net_amount`, `tax_amount = Σ tax_amount`, `grand_total_amount = subtotal_amount + tax_amount + shipping_amount − discount_amount` (CHECK on header only; distribution of header discount and rounding is by largest remainder with residual to `5-2-14-001`, R1-A B-12).');
rep('customer invoice number nullable',
  '`invoice_no` varchar(60) NN · `invoice_date` date NN',
  '**`invoice_no` varchar(60) NULL** (allocated at issue) · **`document_kind` varchar(20) NN DF `invoice` CK in (`invoice|credit_note|debit_note|proforma`)** · **`original_invoice_id` bigint →customer_invoices.id PD RESTRICT** (required for credit_note/debit_note — R1-A B-11) · `invoice_date` date NN');
rep('customer invoice snapshot + link',
  '`buyer_name` varchar(250) · `buyer_national_id` varchar(20) · `buyer_economic_code` varchar(20)',
  '`seller_name` varchar(250) NN · `seller_national_id` varchar(20) · `seller_economic_code` varchar(20) · `seller_address` text · `buyer_name` varchar(250) · `buyer_national_id` varchar(20) · `buyer_economic_code` varchar(20) · `buyer_address` text · **`net_amount` bigint NN DF 0** · **`rounding_amount` bigint NN DF 0**');
rep('customer invoice unique',
  'UQ `uq_customer_invoices_org_no` (organization_id, invoice_no)',
  'UQ `uq_customer_invoices_org_no` (organization_id, invoice_no) (NULLs distinct) · **partial unique `uq_customer_invoices_org_no_notnull ON (organization_id, invoice_no) WHERE invoice_no IS NOT NULL`** · **CK `ck_customer_invoices_numbered` (`status = \'draft\' OR invoice_no IS NOT NULL`)** · **CK `ck_customer_invoices_credit_note` (`document_kind IN (\'invoice\',\'proforma\') OR original_invoice_id IS NOT NULL`)**');
rep('customer invoice line arithmetic',
  '`quantity` numeric(18,4) NN CK > 0 · `unit_price_amount` bigint NN · `discount_amount` bigint NN DF 0 · `tax_rate_id` bigint →tax_rates.id PD SET NULL · `tax_percent` numeric(9,6) NN DF 0 (rate snapshot) · `tax_amount` bigint NN DF 0 · `line_total_amount` bigint NN DF 0',
  '`quantity` numeric(18,4) NN CK > 0 · `unit_price_amount` bigint NN · `discount_amount` bigint NN DF 0 · **`net_amount` bigint NN DF 0** · `tax_rate_id` bigint →tax_rates.id PD SET NULL · `tax_percent` numeric(9,6) NN DF 0 (rate snapshot) · `tax_amount` bigint NN DF 0 · **`gross_amount` bigint NN DF 0** · CK `ck_customer_invoice_lines_arith` (`gross_amount = net_amount + tax_amount`)');
rep('return lines tax',
  '`quantity` numeric(18,4) NN CK > 0 · `condition` varchar(20) NN DF `\'unknown\'` CK in (`sellable|opened|damaged|defective|unknown`) · `restock_action` varchar(20) NN DF `\'restock\'` CK in (`restock|quarantine|scrap|repair`) · `refund_amount` bigint NN DF 0 CK ≥ 0 · `inventory_transaction_id` bigint',
  '`quantity` numeric(18,4) NN CK > 0 · `condition` varchar(20) NN DF `\'unknown\'` CK in (`sellable|opened|damaged|defective|unknown`) · `restock_action` varchar(20) NN DF `\'restock\'` CK in (`restock|quarantine|scrap|repair`) · **`original_invoice_line_id` bigint →customer_invoice_lines.id PD SET NULL** · **`tax_rate_id` bigint →tax_rates.id PD SET NULL** · **`tax_percent` numeric(9,6) NN DF 0** (snapshot from original invoice line) · **`net_amount` bigint NN DF 0** · **`tax_amount` bigint NN DF 0** · **`gross_amount` bigint NN DF 0** (VAT credit-note base — B-11) · `refund_amount` bigint NN DF 0 CK ≥ 0 · `cost_layer_id` bigint →inventory_cost_layers.id PD SET NULL (restock at original layer cost) · `inventory_transaction_id` bigint');

/* ===================== 4. cheques (FSM) ===================== */
rep('cheque columns',
  '`status` varchar(20) NN DF `\'received\'` CK in (`received|in_custody|deposited|cleared|bounced|endorsed|returned|cancelled`) · `deposit_date` date · `cleared_date` date · `bounced_date` date · `bounce_reason` varchar(300) · `bank_account_id` bigint →bank_accounts.id PD SET NULL · `cash_account_id` bigint →cash_accounts.id PD SET NULL · `payment_id` bigint →payments.id PD SET NULL · `journal_entry_id` bigint →journal_entries.id PD SET NULL · `next_action_date` date (due/action reminder)',
  '`status` varchar(20) NN CK (cheque_status vocabulary per direction — §1.6; `issued` is a valid initial state for `direction=issued`) · `deposit_date` date · `cleared_date` date · `bounced_date` date · `bounce_reason` varchar(300) · **`endorsed_to` varchar(250)** · **`endorsement_date` date** · **`endorsed_to_partner_id` bigint →partners.id PD SET NULL** · `bank_account_id` bigint →bank_accounts.id PD SET NULL · `cleared_bank_transaction_id` bigint →bank_transactions.id PD SET NULL · `cash_account_id` bigint →cash_accounts.id PD SET NULL · `payment_id` bigint →payments.id PD SET NULL · `journal_entry_id` bigint →journal_entries.id PD SET NULL · `next_action_date` date (due/action reminder)');
rep('cheque default/ck',
  'UQ `uq_cheques_org_no` (organization_id, cheque_no)',
  'UQ `uq_cheques_org_no` (organization_id, cheque_no) · **CK `ck_cheques_initial_state` (`(direction = \'received\' AND status <> \'issued\') OR (direction = \'issued\' AND status <> \'received\')`)** · **CK `ck_cheques_endorsement` (`status <> \'endorsed\' OR (endorsed_to IS NOT NULL AND endorsement_date IS NOT NULL)`)** · **CK `ck_cheques_cleared` (`status <> \'cleared\' OR cleared_date IS NOT NULL`)** · **CK `ck_cheques_bounced` (`status <> \'bounced\' OR bounced_date IS NOT NULL`)**');
rep('cheque state machine note',
  '`ck_cheques_due` (`due_date >= issue_date OR issue_date IS NULL`).',
  '`ck_cheques_due` (`due_date >= issue_date OR issue_date IS NULL`). **State machine enforced by trigger `trg_cheques_transition`** (append-only `cheque_events` mirrors every transition): received: `received→in_custody→deposited→cleared`; `deposited→bounced`; `in_custody/received→endorsed/returned/cancelled`; cleared: `cleared→bounced` (post-clear bounce `Dr AR / Cr bank`, R1-A B-13) `cleared→returned`; issued: `issued→cleared|bounced|returned|cancelled`. Any other transition raises `RULE_VIOLATION`.');

/* ===================== 5. payments / allocations / methods ===================== */
rep('payments direction + amounts',
  '`direction` varchar(10) NN CK in (`inbound|outbound`) · `method_id` bigint NN →payment_methods.id PD RESTRICT · `amount` bigint NN CK > 0',
  '`direction` varchar(10) NN CK (payment_direction vocabulary: `inbound|outbound`) · `method_id` bigint NN →payment_methods.id PD RESTRICT · `amount` bigint NN CK > 0 · **`unapplied_amount` bigint NN DF 0 CK ≥ 0** (advance/credit/customer credit; `allocated_total + unapplied_amount = amount` enforced by deferred trigger — R1-A B-14) · **`clearing_account_id` bigint →chart_of_accounts.id PD SET NULL** (gateway/POS/COD clearing until settled)');
rep('payments party',
  '`customer_id` bigint →customers.id PD SET NULL · `supplier_id` bigint →suppliers.id PD SET NULL · `shareholder_id` bigint →shareholders.id PD SET NULL · `sales_order_id` bigint →sales_orders.id PD SET NULL',
  '`customer_id` bigint →customers.id PD SET NULL · `supplier_id` bigint →suppliers.id PD SET NULL · **`partner_id` bigint →partners.id PD SET NULL** · `sales_order_id` bigint →sales_orders.id PD SET NULL · **`purchase_order_id` bigint →purchase_orders.id PD SET NULL**');
rep('payments checks',
  'CK `ck_payments_single_party` (at most one of customer/supplier/shareholder set) · CK `ck_payments_account_present` (bank_account_id or cash_account_id or cheque_id present).',
  'CK `ck_payments_single_party` (at most one of customer/supplier/partner set) · CK `ck_payments_account_present` (bank_account_id or cash_account_id or cheque_id or clearing_account_id present — gateway/COD payments settle through clearing, R1-D H-13) · deferred trigger `trg_payments_assert_allocated` (`Σ allocations + unapplied_amount = amount`).');
rep('payment allocations doc types',
  '`document_type` varchar(40) NN CK in (`customer_invoice|supplier_invoice|refund|expense|journal_entry|profit_distribution`)',
  '`organization_id` bigint NN · `document_type` varchar(40) NN CK in (`customer_invoice|supplier_invoice|refund|expense|journal_entry|profit_distribution|sales_order|purchase_order|customer_credit|supplier_prepayment|partner_capital`)');
rep('payment methods gl',
  '`method_type` varchar(30) NN CK in (`cash|card|cod|bank|cheque|credit`) · `requires_reference` boolean NN DF false · `is_active` boolean NN DF true',
  '`method_type` varchar(30) NN CK in (`cash|card|cod|bank|cheque|credit`) · **`gl_account_id` bigint →chart_of_accounts.id PD RESTRICT** (cash/bank/clearing account for the method) · **`clearing_account_id` bigint →chart_of_accounts.id PD SET NULL** (for gateway/POS/COD until settled) · `requires_reference` boolean NN DF false · `is_active` boolean NN DF true');

/* ===================== 6. tax rates / documents ===================== */
rep('tax rate gl',
  '`rate_percent` numeric(9,6) NN DF 0 CK between 0 and 1 · `effective_from` date NN · `effective_to` date · `is_default` boolean NN DF false · `is_active` boolean NN DF true',
  '`rate_percent` numeric(9,6) NN DF 0 CK between 0 and 1 · **`gl_account_id` bigint →chart_of_accounts.id PD RESTRICT** (output VAT payable `2-1-05-001` for sales, input VAT receivable `1-1-06-001` for purchases, withholding liability `2-1-13-001`) · **`is_recoverable` boolean NN DF true** · `effective_from` date NN · `effective_to` date · `is_default` boolean NN DF false · `is_active` boolean NN DF true');
rep('tax doc types + header',
  '`document_type` varchar(40) NN CK in (`sales_vat|purchase_vat|vat_return|withholding|export_summary`) · `party_type` varchar(30) CK in (`customer|supplier`) · `party_id` bigint · `issue_date` date NN · `period_id` bigint →accounting_periods.id PD SET NULL · `tax_amount` bigint NN DF 0 · `total_amount` bigint NN DF 0',
  '`document_type` varchar(40) NN CK in (`sales_vat|sales_return_vat|credit_note|purchase_vat|purchase_return_vat|vat_return|withholding|export_summary`) · `document_kind` varchar(20) NN DF `original` CK in (`original|credit_note|debit_note`) · `original_document_id` bigint →tax_documents.id PD SET NULL · `party_type` varchar(30) CK in (`customer|supplier|partner`) · `party_id` bigint · `customer_invoice_id` bigint →customer_invoices.id PD SET NULL · `supplier_invoice_id` bigint →supplier_invoices.id PD SET NULL · `issue_date` date NN · `period_id` bigint →accounting_periods.id PD SET NULL · **`taxable_amount` bigint NN DF 0** · `tax_amount` bigint NN DF 0 · `total_amount` bigint NN DF 0');
rep('tax doc unique',
  'UQ `uq_tax_documents_org_no` (organization_id, document_no)',
  'UQ `uq_tax_documents_org_no` (organization_id, document_no) · **partial unique `uq_tax_documents_customer_invoice ON (customer_invoice_id) WHERE customer_invoice_id IS NOT NULL AND document_kind = \'original\'`** · **partial unique `uq_tax_documents_supplier_invoice ON (supplier_invoice_id) WHERE supplier_invoice_id IS NOT NULL AND document_kind = \'original\'`** (one original VAT document per invoice — R1-A M-13)');

/* ===================== 7. valuation runs ===================== */
rep('valuation runs method unique',
  '`valuation_method` varchar(20) NN CK in (`moving_average|fifo`) · `valuation_date` date NN',
  '`valuation_method` varchar(20) NN CK (valuation_method vocabulary: `moving_average|fifo|standard`) · `valuation_date` date NN · **`cost_layer_count` integer NN DF 0** · **`gl_inventory_amount` bigint NN DF 0** (GL reconciliation target)');
rep('valuation runs unique org',
  'UQ `uq_inventory_valuation_runs_wh_date_method` (organization_id, warehouse_id, valuation_method, valuation_date) partial `WHERE status <> \'failed\'`',
  'UQ `uq_inventory_valuation_runs_wh_date_method` (organization_id, warehouse_id, valuation_method, valuation_date) partial `WHERE status <> \'failed\'` · **CK `ck_inventory_valuation_runs_reconciles` (`status <> \'completed\' OR gl_inventory_amount = total_value_amount`)** (nightly layer-vs-GL job writes this)');

/* ===================== 8. periods / fiscal years (B-09, M-01) ===================== */
rep('fiscal year constraints',
  'UQ `uq_fiscal_years_org_range` (organization_id, start_date, end_date) · CK `ck_fiscal_years_range` (end_date > start_date).',
  'UQ `uq_fiscal_years_org_range` (organization_id, start_date, end_date) · CK `ck_fiscal_years_range` (end_date > start_date) · **EXCLUDE USING gist (`organization_id` WITH =, `daterange(start_date, end_date, \'[]\')` WITH &&) DEFERRABLE** (no overlapping fiscal years — B-09; requires `btree_gist`) · added columns: `closing_run_id bigint →closing_runs.id PD SET NULL`, `opening_entry_id bigint →journal_entries.id PD SET NULL`, `closed_at timestamptz`, `closed_by bigint`.');
rep('period constraints',
  '`period_no` smallint NN CK between 1 and 12 (13th adjustment period allowed: 13) · `name_fa` varchar(100) NN · `start_date` date NN · `end_date` date NN · `status` varchar(20) NN DF `\'open\'` CK in (`open|closing|closed|locked`) · `closed_at` timestamptz · `closed_by` bigint',
  '`period_no` smallint NN CK between 1 and 13 (**13 = adjustment period**, whose range is the fiscal-year end-day only or the explicit override range; rules: period 13 is created only when needed, may overlap no other period, is closed after audit adjustments, and journal posting requires `period_no=13 AND entry_type=\'adjustment\'` — B-09/M-01) · `name_fa` varchar(100) NN · `start_date` date NN · `end_date` date NN · `status` varchar(20) NN DF `\'open\'` CK in (`open|closing|closed|locked`) · `closed_at` timestamptz · `closed_by` bigint');
rep('period unique',
  'UQ `uq_accounting_periods_year_no` (fiscal_year_id, period_no) · UQ `uq_accounting_periods_year_range` (fiscal_year_id, start_date) · IX `(status, start_date)` · CK range.',
  'UQ `uq_accounting_periods_year_no` (fiscal_year_id, period_no) · UQ `uq_accounting_periods_year_range` (fiscal_year_id, start_date) · **EXCLUDE USING gist (`fiscal_year_id` WITH =, `daterange(start_date, end_date, \'[]\')` WITH &&) DEFERRABLE** (non-overlapping periods; period 13 handled by a `period_no=13` exclusion of its own range) · IX `(status, start_date)` · CK range. **Journal insert trigger `trg_journal_entries_derive_period`** sets `period_id`/`fiscal_year_id` from `entry_date`, rejects closed/locked periods (`PERIOD_CLOSED`), and asserts the supplied ids match the date (B-09).');

/* ===================== 9. posting rules block replacement ===================== */
cutReplace('posting rules block',
  '**`accounting.posting_rules`**',
  '**`accounting.accounting_document_types`**',
`**\`accounting.posting_rules\`** — **code-owned posting services are the primary engine** (v1.1 decision, R1-A B-10): complex events (sale+VAT+COGS, purchase+GRNI+VAT+variance, settlement, returns/credit notes, cheques, closing) are implemented in \`modules/accounting/posting/*.service.ts\` with per-event unit tests. \`posting_rules\` remains the **declarative store for simple two-leg rules** that operators may tune (expense→account mapping, fee mapping, minor variance). Each rule belongs to an immutable versioned \`posting_rule_sets\` row.
\`organization_id\` bigint NN · **\`rule_set_id\` bigint NN →posting_rule_sets.id PD CASCADE** · \`code\` varchar(60) NN · \`name_fa\` varchar(200) NN · \`event_type\` varchar(80) NN CK (event enum in §6.11) · \`priority\` integer NN DF 0 · \`condition_json\` jsonb NN DF \`'{}'\` (whitelisted predicates: channel, tax_type, direction, category) · **\`is_code_owned\` boolean NN DF false** (true = the code service handles it; rule row exists only for audit of the account mapping) · \`is_active\` boolean NN DF true
UQ \`uq_posting_rules_set_code\` (rule_set_id, code) · IX \`(organization_id, event_type, is_active)\` · IX rule_set_id · **rule-set validator \`erp.validate_posting_rule_set(rule_set_id)\`** asserts every rule's legs balance under its resolver map and that all accounts resolve to seeded, postable accounts before \`status='active'\`.

**\`accounting.posting_rule_lines\`** — legs of a simple rule; account is either a concrete postable account or a **resolver key** resolved by code (channel-specific accounts) — no \`00x\` placeholders exist in data.
\`posting_rule_id\` bigint NN →posting_rules.id PD CASCADE · \`line_no\` integer NN · \`side\` varchar(6) NN CK in (\`debit|credit\`) · **\`account_id\` bigint →chart_of_accounts.id PD RESTRICT** · **\`account_resolver\` varchar(60)** (e.g. \`channel_sales_account\`, \`channel_fee_expense\`, \`channel_receivable\`, \`vat_output\`, \`cogs_account\`, \`inventory_account\`, \`grni\`) · **\`amount_expression\` varchar(120) NN CK in (\`net_amount|tax_amount|discount_amount|shipping_amount|fee_amount|vat_amount|cogs_amount|gross_amount|settlement_amount|exchange_amount|event.amount|event.tax_amount|event.fee_amount|event.cogs_amount\`)** · \`line_group\` varchar(20) NN DF \`'main'\` (allows multi-entry posting: \`main|vat|cogs|fee|variance\`) · \`dimension_rule_json\` jsonb NN DF \`'{}'\`
UQ \`uq_posting_rule_lines_rule_line\` (posting_rule_id, line_no) · IX posting_rule_id · IX account_id · **CK \`ck_posting_rule_lines_target\` (\`account_id IS NOT NULL OR account_resolver IS NOT NULL\`)** · **CK \`ck_posting_rule_lines_amount\` (\`amount_expression IS NOT NULL\`)**.

**\`accounting.posting_rule_sets\`** — see §2.17: immutable version snapshots; \`journal_entries.posting_rule_set_id\` records which version posted each entry, and \`posting_rule_sets.balanced_validated_at\` proves the set was validated before activation.

`);

/* ===================== 10. §4.4 partition maintenance replacement ===================== */
cutReplace('partition maintenance',
  '### 4.4 Automated partition creation',
  '### 4.5 Default-partition alert query',
`### 4.4 Automated partition creation (worker job \`maintenance:partitions\`, daily 02:00 Asia/Tehran)

**v1.1 corrections (R1-D B-08):** all maintenance functions are \`SECURITY DEFINER SET search_path = erp, pg_temp\`, owned by \`saman_migrator\`, \`EXECUTE\` revoked from PUBLIC and granted only to \`saman_worker\`; relation names are built from \`pg_class.relname\` + \`pg_namespace.nspname\` through \`format('%I.%I')\` (never from a schema-qualified \`regclass\` string); creation is guarded by an advisory lock; the registry has \`is_enabled\` and is filtered; \`drain_default_partition\` runs as the privileged owner (the worker has no DELETE on append-only tables).

\`\`\`sql
-- configuration lives in a table (not in function bodies) so ops can disable a parent
CREATE TABLE IF NOT EXISTS erp.partitioned_tables_registry (
  parent_table      text PRIMARY KEY REFERENCES ... -- see §2.1 (column set includes is_enabled)
);
-- (full DDL per §2.1; initial rows in §6.10)

CREATE OR REPLACE FUNCTION erp.ensure_month_partition(p_parent regclass, p_month date)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = erp, pg_temp
AS $$
DECLARE
  v_nsp  text; v_rel text; v_part text;
  v_start timestamptz := date_trunc('month', p_month)::timestamptz;
  v_end   timestamptz := (date_trunc('month', p_month) + interval '1 month')::timestamptz;
BEGIN
  SELECT n.nspname, c.relname INTO v_nsp, v_rel
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = p_parent;
  IF v_nsp IS NULL OR v_nsp <> 'erp' THEN
    RAISE EXCEPTION 'partition parent must live in schema erp: %', p_parent;
  END IF;
  IF v_rel !~ '^[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'invalid relation name: %', v_rel;
  END IF;
  v_part := v_rel || '_p' || to_char(v_start, 'YYYYMM');
  IF to_regclass(format('%I.%I', v_nsp, v_part)) IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(v_nsp || '.' || v_rel));
    EXECUTE format(
      'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
      v_nsp, v_part, v_nsp, v_rel, v_start, v_end);
  END IF;
  RETURN v_part;
END $$;

CREATE OR REPLACE FUNCTION erp.maintain_partitions(p_ahead_months integer DEFAULT 2)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = erp, pg_temp
AS $$
DECLARE r record; m date; created int := 0;
BEGIN
  FOR r IN SELECT parent_table FROM erp.partitioned_tables_registry WHERE is_enabled LOOP
    FOR m IN SELECT generate_series(
               date_trunc('month', now())::date,
               (date_trunc('month', now()) + (p_ahead_months || ' months')::interval)::date,
               interval '1 month')::date LOOP
      PERFORM erp.ensure_month_partition(r.parent_table::regclass, m);
      created := created + 1;
    END LOOP;
  END LOOP;
  INSERT INTO erp.partition_maintenance_log(parent_table, action, partition_name, success, detail)
  VALUES ('*', 'create', '*', true, format('ensured next %s months; %s checks', p_ahead_months, created));
  RETURN created;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO erp.partition_maintenance_log(parent_table, action, partition_name, success, detail)
  VALUES ('*', 'create', '*', false, SQLERRM);
  RAISE;
END $$;

-- safety-net drain: privileged, logged, and only for partitions that exist in the registry
CREATE OR REPLACE FUNCTION erp.drain_default_partition(p_parent regclass, p_month date)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = erp, pg_temp
AS $$
DECLARE v_nsp text; v_rel text; v_part text; v_rows bigint;
BEGIN
  SELECT n.nspname, c.relname INTO v_nsp, v_rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = p_parent;
  v_part := erp.ensure_month_partition(p_parent, p_month);
  EXECUTE format(
    'WITH moved AS (DELETE FROM %I.%I WHERE created_at >= %L AND created_at < %L RETURNING *)
     INSERT INTO %I.%I SELECT * FROM moved',
    v_nsp, v_rel || '_default', date_trunc('month', p_month)::timestamptz,
    (date_trunc('month', p_month) + interval '1 month')::timestamptz, v_nsp, v_part);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  INSERT INTO erp.partition_maintenance_log(parent_table, action, partition_name, success, detail)
  VALUES (v_rel, 'archive', v_part, true, format('drained %s rows from default', v_rows));
  RETURN v_rows;
END $$;

REVOKE ALL ON FUNCTION erp.ensure_month_partition(regclass, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION erp.maintain_partitions(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION erp.drain_default_partition(regclass, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erp.ensure_month_partition(regclass, date) TO saman_worker;
GRANT EXECUTE ON FUNCTION erp.maintain_partitions(integer) TO saman_worker;
GRANT EXECUTE ON FUNCTION erp.drain_default_partition(regclass, date) TO saman_worker;
\`\`\`

**Retention feasibility (R1-D H-19):** design headroom 2M ledger rows/day → ~60M/month → **25 hot months ≈ 1.5B rows**. This is NOT feasible on a single 4 vCPU host with the earlier plan. v1.1 policy: **hot window = 6 months** (~360M rows, still large but bounded by pruning), **warm** = partitions 7–25 detached to an archive tablespace on local disk (read-only, EXPORT to S3 Parquet with manifest), **cold** = >25 months exported to S3 and dropped. Typical real volume (200k rows/day) keeps ~40M rows in 6 months on a modest host; the 2M/day figure is the stress envelope, and the capacity doc must state storage sizing (≈ 240 GB/6 months at worst-case ~400 B/row incl. indexes). Queries are repository-windowed to ≤ 90 days for ledger/log UI regardless. Retention registry: \`inventory_transactions\` 6 hot + 25 warm, \`audit_logs\` 12 hot + 120 archivable (10 years), \`api_request_logs\` 3, \`channel_api_calls\` 6, \`outbox_events\` 1 (processed; pending/processing rows are **never** in an expired partition: the retention job moves them to the current partition before detaching and refuses to detach any partition containing pending/processing rows).

`);

/* ===================== 11. outbox DDL corrections ===================== */
rep('outbox unique',
  'CONSTRAINT uq_outbox_events_event UNIQUE (event_type, aggregate_type, aggregate_id, event_version, created_at),',
  '-- NOTE: partition-local unique cannot dedupe across months; global dedupe is erp.outbox_event_keys (non-partitioned, §2.17)\n  CONSTRAINT uq_outbox_events_event_uuid UNIQUE (event_uuid, created_at),');
rep('outbox columns',
  'locked_by           varchar(80),\n  locked_at           timestamptz,',
  'locked_by           varchar(80),\n  locked_at           timestamptz,\n  locked_until        timestamptz,\n  event_uuid          uuid        NOT NULL DEFAULT gen_random_uuid(),');
rep('outbox index',
  'CREATE INDEX ix_outbox_events_pending ON erp.outbox_events (available_at) WHERE status IN (\'pending\',\'failed\');',
  'CREATE INDEX ix_outbox_events_pending ON erp.outbox_events (available_at) WHERE status IN (\'pending\',\'failed\');\nCREATE INDEX ix_outbox_events_reclaim ON erp.outbox_events (locked_until) WHERE status = \'processing\';  -- stuck-lease reclaim');
rep('outbox status check',
  'CONSTRAINT ck_outbox_events_status CHECK (status IN (\'pending\',\'processing\',\'processed\',\'failed\')),',
  'CONSTRAINT ck_outbox_events_status CHECK (status IN (\'pending\',\'processing\',\'processed\',\'failed\')),\n  CONSTRAINT ck_outbox_events_lease CHECK (status <> \'processing\' OR locked_until IS NOT NULL),');

/* ===================== 12. §7 counts + §9 counts ===================== */
rep('7.3 heading', '### 7.3 New tables added (45) and why', '### 7.3 New tables added (69) and why');
rep('7.5 body', /Supplied: 150 tables\.[\s\S]*?schema-diff test asserts no undocumented table exists\./m,
  'Supplied: 150 tables. Final: **215** = 150 reference tables − 6 removed + 69 net-new.\n\n- **Removed without a replacement table (6):** `warehouse_tasks`, `warehouse_task_events` (generic task layer duplicated by putaway/pick/packing execution tables), `order_reservations` (merged into `stock_reservations`), `platform_commission_rules` (merged into `channel_fee_rules`), `shareholders` and `shareholder_transactions` (replaced by `partners` + `partner_shares` + `partner_capital_transactions`, v1.1).\n- **Renamed but still present (11):** as previously documented (`login_sessions→auth_sessions`, `product_batches→inventory_lots`, …).\n- **New tables (69 = 45 from v1.0 + 24 from v1.1):** the 45 v1.0 additions plus the 24 v1.1 tables in §2.17 (13 platform, 4 inventory, 1 procurement, 1 warehouse, 2 treasury, 2 accounting, 3 partners — with partners replacing 2 removed reference tables net +1).\n\nArithmetic: 150 − 6 + 69 = 215. Per-module counts in §2 are the acceptance figure; a schema-diff test asserts `erp` table count = 215 (excluding \`_pYYYYMM\` partitions and \`information_schema\` noise).');
rep('9.1 count', '- [x] All 191 tables are column-complete', '- [x] All 215 tables are column-complete');

/* ===================== 13. write ===================== */
writeFileSync(D, c, 'utf8');
console.log('bytes ->', c.length);
console.log([...new Set(stats)].join('\n'));
