
---

## 10. Revision log — round-1 review resolutions (v1.1)

Source reviews: `docs/_review/round-1/R1-accounting.md`, `R1-datamodel.md`, `R1-security.md`. Status legend: **FIXED** (schema/text changed in this revision), **DEFERRED** (reason given; owner), **OUT-OF-SCOPE** (belongs to another owned document/teammate, noted so it is not silently dropped). Every ID from the three reviews appears below.

### 10.1 R1-accounting (A) resolutions

| ID | Status | Resolution / reason |
|---|---|---|
| A-B-01 | FIXED | §6.10.2 #1–3: sale posts AR gross / revenue net / output VAT / shipping revenue; COGS at stock issue (#2) from cost layers; cash sale (#3). |
| A-B-02 | FIXED | #9–11: receipt → inventory + input VAT (if invoice) / **GRNI**; supplier invoice → GRNI + VAT + price variance / AP; 3-way match columns + status. |
| A-B-03 | FIXED | #16: settlement debits clearing/bank + fee expense + returns/penalties, credits channel receivable; never revenue; residual → variance (#17). |
| A-B-04 | FIXED | §6.3 contra override table with explicit `nature='contra'` and opposite normal balance for `1-2-02`, `1-2-05`, `3-1-02`, `4-1-02`, `4-1-03`, `1-1-03-003`; CI sign test. |
| A-B-05 | FIXED | §6.3 exact manifest (counts asserted: 5/10/59/85/8/6 = 173); every `00x` replaced by seeded accounts or resolver keys (no placeholder). |
| A-B-06 | FIXED | `ck_inventory_balances_available_nonnegative` (`reserved+safety_buffer+damaged <= on_hand`); `available` computed, not stored; allocation assertion + test. |
| A-B-07 | FIXED | §2.17 + §2.6: `inventory_cost_layers`, `inventory_layer_consumptions`, `inventory_average_costs`; lots are physical batch metadata only; returns/transfers/reversals reference layers; nightly layer-vs-GL job (`gl_inventory_amount`). |
| A-B-08 | FIXED | §6.10.3 closing run: income summary → retained earnings → legal reserve (5%, cap 10% capital), opening entries, close blocked until posted; `accounting.closing_runs`. |
| A-B-09 | FIXED | gist EXCLUDE on fiscal years/periods; trigger derives `period_id` from `entry_date`, rejects closed/locked; period 13 rules. |
| A-B-10 | FIXED | §6.10.1: code-owned posting services for complex events; `posting_rule_sets` versioned; `posting_rules` only simple two-leg with resolver keys; journals store `posting_rule_set_id`; 49-event matrix. |
| A-B-11 | FIXED | `return_lines` net/tax/gross + tax snapshot + original invoice line; `customer_invoices.document_kind='credit_note'` + `original_invoice_id`; matrix #6–8; `tax_documents.document_type` credit-note variants. |
| A-B-12 | FIXED | Per-line stored `net_amount`/`tax_amount`/`gross_amount` (bigint) + arithmetic CHECK `gross=net+tax`; header totals are sums; header discount/rounding by largest remainder to `5-2-14-001`; exact multiplication CHECK removed (R1-D H-08). |
| A-B-13 | FIXED | Cheque FSM incl. `issued`; `endorsed_to`, `endorsement_date`, `bank_account_id`, `cleared_bank_transaction_id`; transition trigger; matrix #28–35 incl. post-clear bounce via bank. |
| A-B-14 | FIXED | `payments.unapplied_amount` + `clearing_account_id`; allocations to orders/advances; deferred allocation-sum trigger; `payment_methods.gl_account_id`/clearing; `cash_sessions` + `cash_transactions.cash_session_id`. |
| A-B-15 | FIXED | `treasury.cash_sessions` (v1.0), `treasury.bank_statements` + `bank_statement_lines` (§2.17), `partners.partners` + `partner_shares` + `partner_capital_transactions` (§2.17). |
| A-B-16 | FIXED | `inventory_transactions.period_id` (trigger-derived, `FOR SHARE` locked before write) + `journal_entry_id`; one transaction writes ledger/balance/journal/outbox; closed period rejects whole op. |
| A-H-01 | DEFERRED | Party detail accounts: modeled through `partner_accounts`/`dimension_values` (level 5) plus `partners.gl_account_id`; separate per-party CoA rows are not seeded (thousands of rows); reason documented, revisit if statutorily required. |
| A-H-02 | FIXED | `valuation_method` only on org (single policy) with per-variant `cost_method` as override; valuation run unique `(org,warehouse,method,date)`; method change requires valuation run + approval. |
| A-H-03 | DEFERRED | Backdated receipt/issue cutoff: service rejects `business_date` in a closed/locked period (B-16) but explicit restatement/cutoff workflow is deferred to P4 hardening (owner: finance-lead). |
| A-H-04 | FIXED | Transfers: matrix #22–23 with in-transit account + layer move (`1-1-10-001`); `inventory_transfers` dispatch/receive states already exist. |
| A-H-05 | FIXED | Write-off at layer cost (matrix #20–21), separate waste/damage/count-gain accounts (`5-1-02`, `5-1-03`, `5-1-02-002`). |
| A-H-06 | FIXED | Supplier invoice 3-way match: `match_status`, `price_variance_amount`, `quantity_variance_amount`, line-level variance; duplicate control `supplier_id+invoice_no`. |
| A-H-07 | FIXED | `tax_rates.gl_account_id` + `is_recoverable`; fee VAT and withholding accounts in CoA (`2-1-05-001`, `1-1-06-001`, `2-1-13-001`). |
| A-H-08 | FIXED | Customer invoice legal seller/buyer snapshot fields (seller/buyer name, national id, economic code, address); credit-note structure. |
| A-H-09 | FIXED | `partner_shares` effective-dated ownership; profit distribution after closing with legal reserve + withholding (matrix #38); rounding via 5-2-14-001. |
| A-H-10 | FIXED | Partners + capital transactions separate; customer credit `1-1-03-004`; supplier prepayment `1-1-05-001`; partner current accounts. |
| A-H-11 | DEFERRED | Void-vs-reverse enforcement for *all* posted docs: triggers prevent DELETE; reversal entry fields exist; a per-module service check + tests lands with P3/P4 implementation (owner: backend-core). |
| A-H-12 | FIXED | Deferred constraint trigger on `journal_entries` validates lines, sums and header totals at COMMIT; zero/zero lines rejected. |
| A-H-13 | FIXED | `account_balances` is one row per account×period (no single dimension column); per-dimension reports aggregate `journal_line_dimensions` joined to `journal_lines` (no double counting). |
| A-H-14 | DEFERRED | Landed cost/customs: v1 capitalizes inbound freight by adjusting the receipt cost layer before inventory issue (service path); dedicated landed-cost document table deferred (owner: finance-lead). |
| A-M-01 | FIXED | Period 13 rules; gist exclusions; fiscal-year/period derivation trigger. |
| A-M-02 | FIXED | Tax rate windows: `effective_from/to` per rate; default constrained to one per org via partial unique; `ck_tax_rates_window`; default must be `tax_type='vat'` (added constraint note in seed validation). |
| A-M-03 | FIXED | CoA integrity: `account_level` 1–6, code-depth CHECK, parent-level CHECK, seed validator `erp.validate_coa_seed()`. |
| A-M-04 | DEFERRED | AR/AP/inventory control-account reconciliation reports: schema supports (partner_accounts, layers, GL); report implementations land in P4 (owner: finance-lead). |
| A-M-05 | FIXED | FIFO ordering now on `inventory_cost_layers(received_at, id)` with FEFO tie-break by lot expiry in service; nonexistent-column reference removed. |
| A-M-06 | FIXED | Layer residual constraints `qty_remaining <= original_qty`, cost bound, closed flag. |
| A-M-07 | FIXED | Ledger cost fields: `unit_cost_amount`/`total_cost_amount` required on cost-bearing types (service) + `cost_state`; zero-cost relief rejected. |
| A-M-08 | FIXED | Reservation consumption: `stock_reservations` gains `consumed_qty`/`released_qty`/`consumed_transaction_id` (partial consumption). |
| A-M-09 | FIXED | Bank statement import has header (`bank_statements`) + lines; `bank_transactions` direction CHECK de-tautologised. |
| A-M-10 | FIXED | Statement line ↔ book transaction is 1:1 via partial unique; outstanding-items model via unmatched lines + `bank_reconciliation_lines`. |
| A-M-11 | FIXED | Allocation `Σ ≤ amount` via deferred trigger; org column added; refund ≤ return enforced by service + refund/return link. |
| A-M-12 | FIXED | Settlement net formula documented in §6.10.2 #16–17; `net_payable_amount` CHECK (header) added in seed validation. |
| A-M-13 | FIXED | One original tax document per invoice via partial unique; `taxable_amount` header; credit-note links. |
| A-M-14 | FIXED | `entry_date = business_date` rule (v1) + inventory `period_id`; both trigger-derived. |
| A-M-15 | FIXED | Line/header discount separation (`allocated_header_discount_amount`); header discount distributed, never double-counted. |
| A-M-16 | FIXED | Cash variance accounts (`5-2-12-001`, `4-2-02-001`) + `cash_sessions` variance columns. |
| A-M-17 | DEFERRED | Reopen/close audit trail: covered by `audit_logs` + `closing_runs`; a dedicated period-action log table deferred (owner: finance-lead). |
| A-M-18 | FIXED | `partner_shares` effective-dated ownership + CI sum check (validate sum of active ownership = 100% per org). |
| A-M-19 | FIXED | Loss distribution: `closing_runs` handles negative profit; distribution blocked when retained earnings ≤ 0 (service rule, matrix #38). |
| A-M-20 | DEFERRED | Purchase returns/allowances and bad-debt rules: accounts exist (`2-1-01-001`, `5-2-11-001`, matrix #12/#44/#45); purchase-return document table deferred (owner: procurement implementation). |
| A-M-21 | FIXED | Rounding/remainder account `5-2-14-001` + largest-remainder distribution policy setting. |
| A-L-01 | FIXED | CoA code widened to `varchar(60)` for L5/L6 codes. |
| A-L-02 | FIXED | API `rate` vs `rate_percent` documented in `enums.ts` (`rate_percent` stores fraction; API converts ×100 at DTO edge). |
| A-L-03 | FIXED | `cheque_events.amount` required for amount-bearing events (service) + `ck_cheque_events_amount` note. |
| A-L-04 | FIXED | `standard` added to `valuation_method`; `product_cost_history.cost_method` aligned. |
| A-L-05 | FIXED | Tax document status uses `document_status` vocabulary (default `issued` is a valid token). |
| A-L-06 | FIXED | `fiscal_years.retained_earnings_entry_id` replaced by `closing_runs` links (multiple entries). |

### 10.2 R1-datamodel (D) resolutions

| ID | Status | Resolution / reason |
|---|---|---|
| D-B-01 | FIXED | §2.17 adds notification templates/preferences, file links, job runs/steps, feature flags/overrides, webhook subscriptions/deliveries, channel webhook secrets, bank statements/lines, goods-receipt scans, putaway scans, generic partners; §6.2 false table-less mappings removed. |
| D-B-02 | FIXED | §6.10.4 numbering lifecycle: nullable numbers + partial unique + `status<>draft OR number IS NOT NULL` CHECK on orders, invoices, journals, POs, receipts, shipments. |
| D-B-03 | FIXED | Deferred constraint trigger on `journal_entries` at COMMIT; zero/zero lines rejected; draft deletion replaced by `cancelled`/`voided` (no DELETE endpoint; `BEFORE DELETE` guards exempt only drafts by policy = delete endpoint removed). |
| D-B-04 | FIXED | §6.3 exact manifest with all mandatory columns, postable L4s, contra rows, L6 parent = L5, asserted counts. |
| D-B-05 | FIXED | No `00x`; concrete accounts/resolvers; VAT legs added; rule count = 49 events (matrix). |
| D-B-06 | FIXED | Non-partitioned `outbox_event_keys` global dedupe; `event_uuid`; `locked_until` + reclaim index; retention refuses to drop partitions with pending/processing rows. |
| D-B-07 | FIXED | Non-partitioned `inventory_ledger_keys` global dedupe; balance combined CHECK; explicit test combination. |
| D-B-08 | FIXED | §4.4 SECURITY DEFINER functions, identifier validation, `format('%I.%I')`, advisory lock, registry `is_enabled`, privileged drain, grants to worker only. |
| D-B-09 | FIXED | §6.10.5 FK-safe seed order incl. users/bootstrap superadmin, price lists, accounting_document_types; seed-twice test. |
| D-B-10 | FIXED | §1.6 single shared vocabulary (submitted/on_hold/closed, document `submitted`, `inbound|outbound` direction, `weighted_average→moving_average`, cheque `issued`). |
| D-H-01 | FIXED | Soft-delete: all natural unique keys on master data are partial `WHERE deleted_at IS NULL` (rule in §1.3; enforced when implementing unique indexes). |
| D-H-02 | DEFERRED | Composite `(organization_id, id)` FKs on all high-risk relations: policy restated in §1.5 and applied to inventory/orders/journals during migration 0017; full audit matrix deferred to implementation PR (owner: backend-core). |
| D-H-03 | DEFERRED | Child FK to partitioned ledger: children store `(transaction_id, transaction_created_at)` for composite reference; real FK from children to partitioned parent is validated in migration dry-run (owner: backend-core). |
| D-H-04 | FIXED | `stock_reservations` partial consumption columns (`consumed_qty`, `released_qty`, `consumed_transaction_id`) + CHECK `consumed+released <= quantity`; order dedupe via `idempotency_key`. |
| D-H-05 | FIXED | Retention/prune jobs: worker has DELETE only on `outbox_event_keys`, `inventory_ledger_keys`, `idempotency_keys`, expired sessions/OTP through SECURITY DEFINER functions; append-only tables never DELETEd (partition DETACH for retention). |
| D-H-06 | FIXED | Fiscal-year numbering: fresh `numbering_sequences` rows per fiscal year (`next_value=1`), no counter copy; §6.10.4. |
| D-H-07 | FIXED | Money/weight policy violations fixed: `capacity_weight_kg` → `capacity_weight_grams integer`; width/dimension numerics only for non-money; all weights integer grams. |
| D-H-08 | FIXED | Exact multiplication CHECK removed; stored net/tax/gross + arithmetic CHECK only. |
| D-H-09 | FIXED | `product_media` CHECK allows either owner (product or variant) and service sets product_id; no contradictory rule. |
| D-H-10 | FIXED | Period 13 allowed (`period_no BETWEEN 1 AND 13`) with rules. |
| D-H-11 | FIXED | `tax_documents.status` uses `document_status` tokens; default `issued` valid. |
| D-H-12 | FIXED | Cheque `issued` state + direction-dependent initial status + FSM trigger. |
| D-H-13 | FIXED | Payment direction vocabulary + clearing account satisfies account-presence CHECK for gateway/COD. |
| D-H-14 | FIXED | WMS: location tree columns exist; `user_devices.device_secret_hash`; device secret; `goods_receipt_scans`, `putaway_scans` add scan events. |
| D-H-15 | FIXED | Procurement/pricing/channel fields: 3-way match columns, supplier line net/tax/gross, fee VAT fields, channel webhook secrets/subs; remaining API-only fields mapped in the implementation PR. |
| D-H-16 | FIXED | Returns/invoices/refunds link documents (`original_invoice_id`, `credit_note_id`, `original_invoice_line_id`, `cost_layer_id`). |
| D-H-17 | FIXED | `bank_statements` + `bank_statement_lines`; reconciliation references statement lines. |
| D-H-18 | FIXED | Valuation run unique per `(org,warehouse,method,date)`; method vocabulary includes API `weighted_average` mapping. |
| D-H-19 | FIXED | Retention feasibility rewritten (§4.4): 6-month hot + warm archive + S3 cold with explicit sizing; pending rows protected. |
| D-M-01 | FIXED | `uq_idempotency_keys_org_scope_key` → `(organization_id, actor_user_id, scope, key)`; order idempotency key TTL documented (24 h + 400-day keys GC). |
| D-M-02 | DEFERRED | `products.attributes_json` stays for search/display; filterable attributes must be promoted to `product_variant_attributes` (filter API uses the normalized tables); migration rule documented, promotion job deferred to P2. |
| D-M-03 | FIXED | Alert lifecycle: `alert_events` gains `assigned_to`, `note`, `acknowledged_at` (event lifecycle). |
| D-M-04 | FIXED | API client rotation fields exist; `file_assets` gains `scan_status`, `quarantine_path`, `uploaded_by`, `ready_at`; `api_clients.rotated_at`. |
| D-M-05 | FIXED | `integration_dead_letters.integration` becomes open `varchar` validated against `enum_values` domain (accepts `partition_maintenance` and future integrations). |
| D-M-06 | FIXED | Secondary vocabularies moved to `platform.enum_values` seeded lookup (OTP purpose, security event, dead-letter integration, audit action, channel event). |
| D-M-07 | FIXED | Sample channel accounts have idempotent natural key `(channel_id, external_account_id)`/`(channel_id, name)` — seed uses code. |
| D-M-08 | FIXED | Holidays unique key includes `organization_id`. |
| D-M-09 | DEFERRED | `allow_negative_stock` removed from settings; negative stock is structurally impossible (DB CHECK), so no flag is offered in v1 (owner: docs). |
| D-M-10 | FIXED | `account_balances` update lock order documented: fiscal_year→period→account_id ascending `FOR UPDATE`, journal lines aggregate before update (no deadlock). |
| D-M-11 | FIXED | Ledger sign rule documented: `quantity` sign is derived from `transaction_type` (negative for out types); service validates + CHECK on type/sign matrix in the posting service; note added in §2.6. |
| D-M-12 | FIXED | FIFO ordering column exists (`inventory_cost_layers.received_at`). |
| D-M-13 | FIXED | `bank_transactions.direction` CHECK simplified to `(debit|credit)`; statement side lives in `bank_statement_lines`. |
| D-M-14 | FIXED | Weight policy: capacity weights in integer grams. |
| D-L-01 | FIXED | Location code format unified on `A-12-R3-2-07` throughout; `full_code` CHECK documented. |
| D-L-02 | FIXED | Registry DDL includes `is_enabled` (referenced from §2.1; §4.4 filters it). |
| D-L-03 | FIXED | `ck_currencies_single_base` renamed/described as partial unique index `uq_currencies_one_base`. |
| D-L-04 | FIXED | `saved_filters` is platform-owned; reporting endpoints read it via platform service (ownership note added). |
| D-L-05 | FIXED | Self-review claims in §9.1 rewritten to reference this log and the actual assertions (no stronger claims than evidence). |

### 10.3 R1-security (S) resolutions

| ID | Status | Resolution / reason |
|---|---|---|
| S-B-01 | OUT-OF-SCOPE | Delivery-phase status/evidence ledger is an ARCHITECTURE/SECURITY document fix (owner: security-lead/lead). No schema impact. |
| S-B-02 | FIXED | `user_devices.device_secret_hash` (server-issued 32-byte secret, hashed), `secret_issued_at`, `secret_rotated_at`; trust bypass requires the secret cookie; fingerprint demoted to display label. |
| S-B-03 | OUT-OF-SCOPE | Password-reset policy is API/SECURITY (owner: api-architect/security-lead). Schema: `otp_challenges` purpose vocabulary extended via `enum_values` (`password_reset`, `step_up`, `mfa`, `breakglass`). |
| S-B-04 | DEFERRED | Approval thresholds/workflow edits must be approval-governed (new `approval.config.manage` key + 2-person approval); pipeline belongs to identity/accounting implementation; `journal_entries.approval_request_id` + DB trigger validating above-threshold post is specified in §6.10.3 and lands in P4 (owner: accounting implementation). |
| S-B-05 | FIXED | `audit_logs` gains `prev_hash`, `entry_hash`, `hash_seq`, `actor_label`; `platform.audit_chain_heads`; `erp.chain_audit(batch)` SECURITY DEFINER owned by migrator, EXECUTE to worker, no UPDATE grant; verifier job with independent read path; `event_type`/`actor_type` vocabularies extended via enum_values; hourly `audit_mismatch` event. |
| S-B-06 | FIXED | Single permission registry: `packages/shared/permissions.ts` generated from API.md §5.2 (412 keys); §6.2 is now a reference + verbatim copy, role manifests rewritten to exact keys; no prefix matching; bidirectional CI parity. |
| S-H-01 | OUT-OF-SCOPE | Privilege-escalation guard/step-up endpoints (owner: api-architect/backend-core). |
| S-H-02 | OUT-OF-SCOPE | Export entity→permission mapping is API contract (owner: api-architect). |
| S-H-03 | FIXED | Webhook signature parameters removed from mutable settings: header/algorithm are adapter constants; only `channel_webhook_secrets` (encrypted, rotated) is configurable, gated by `channel.credential.write` + approval; settings override rejected. |
| S-H-04 | FIXED | Outbound webhook destinations restricted to a seeded allowlist table (in `webhook_subscriptions` validated by service against `enum_values`/config); cost fields excluded from outbound payload schema; subscription changes require step-up + audit. |
| S-H-05 | DEFERRED | Presigned-upload hardening (S3 POST policy, pending-object lifecycle, mandatory scan, per-user in-flight cap) is API/storage implementation (owner: api-architect/devops); schema columns `scan_status`, `quarantine_path`, `ready_at` added now. |
| S-H-06 | DEFERRED | File-download entity-scope check is API behavior (owner: api-architect); `file_links` provides the relation needed. |
| S-H-07 | OUT-OF-SCOPE | Rate-limit tiers are API contract (owner: api-architect). |
| S-H-08 | OUT-OF-SCOPE | Voice-OTP/sms budget is API/provider policy (owner: api-architect). |
| S-H-09 | FIXED | Per-report permissions: `report_definitions.required_permissions text[]` (array of registry keys) + dashboards inherit strictest widget permission; widget `query_definition` is a closed template enum (no free SQL). |
| S-H-10 | FIXED | Channel payload archives: `channel_webhook_events`/`channel_api_calls` store only allowlisted fields (no headers at all, no customer PII; IDs/hashes only); `raw_body` nullable and disabled in production (`files.persist_http_bodies_in_prod=false`); raw view requires step-up. |
| S-H-11 | OUT-OF-SCOPE | Docker secrets/keyring handling is deployment (owner: devops-lead). |
| S-H-12 | FIXED | §5.5 grants manifest rewritten: `saman_readonly` gets **views/matviews only** (no base tables); `saman_app` gets no DELETE except via SECURITY DEFINER prune functions; credential/hash/PII tables revoked; CI diffs `\dp` against manifest. |
| S-M-01 | FIXED | OTP purpose/security event vocabularies are seeded `platform.enum_values` lookup rows with full lists; FK-validated where feasible; insert test per endpoint purpose/event. |
| S-M-02 | FIXED | Idempotency unique includes `actor_user_id`; replay lookup includes actor; cross-actor test specified. |
| S-M-03 | FIXED | Inbound webhook replay: `channel_webhook_events` unique `(account, external_event_id)` (already); event id included in MAC input per API contract; timestamp mandatory (no flag) — contract fix noted for API owner, schema unchanged. |
| S-M-04 | OUT-OF-SCOPE | XLSX decompression caps and PDF renderer sandbox (owner: workers/api). |
| S-M-05 | OUT-OF-SCOPE | Egress allowlist hard-coding (owner: channels implementation/devops). |
| S-M-06 | OUT-OF-SCOPE | API-client auth scheme (owner: api-architect); schema fields already present. |
| S-M-07 | OUT-OF-SCOPE | Break-glass workflow (owner: security-lead); `identity.break_glass` key exists. |
| S-M-08 | OUT-OF-SCOPE | Rate tiers (owner: api-architect). |
| S-M-09 | OUT-OF-SCOPE | Scope-denial 403/404 rule (owner: api-architect). |
| S-M-10 | OUT-OF-SCOPE | Scope-change token invalidation (owner: api-architect/identity impl). |
| S-L-01 | OUT-OF-SCOPE | Log redaction rules (owner: security-lead). |
| S-L-02 | OUT-OF-SCOPE | Header hygiene/CSP (owner: security-lead). |
| S-L-03 | OUT-OF-SCOPE | Dependency pinning (owner: devops). |
| S-L-04 | OUT-OF-SCOPE | Backup encryption key custody (owner: devops). |
| S-L-05 | OUT-OF-SCOPE | Pen-test scope (owner: qa-lead). |

### 10.4 Verification added to the migration/seed test suite

`pnpm --filter @saman/db test` (implementation phase) must assert: table count 215; CoA manifest counts (5/10/59/85/8/6) and every posting-rule account postable; every `event_type` in §6.10.2 has a posting handler test; outbox/ledger dedupe tables exist and are non-partitioned; balance CHECK rejects `on_hand=10,reserved=10,safety_buffer=1`; deferred journal trigger rejects empty/unbalanced entries; gist exclusions reject overlapping periods; grants manifest (`\dp`) matches §5.5; seed-twice idempotency; permission registry parity (412/412) with `packages/shared/permissions.ts`.

