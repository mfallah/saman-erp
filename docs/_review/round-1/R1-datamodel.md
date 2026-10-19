# R1 — Independent data-model review

**Reviewer:** Independent senior PostgreSQL / data-architecture reviewer (not an author of these documents)  
**Scope:** `docs/00-overview`, `docs/01-architecture`, ADR-0003/0007/0009/0013/0014 (other ADRs skimmed), `docs/02-data-model/DATA-MODEL.md`, `MIGRATION-NOTES.md`, and the alias/registry/state-machine cross-check against `docs/03-api-contract/API.md` §4–§5. Reference material: `ERP_database_dictionary_v1.md`, `ERP_database_design_v1.sql` (reference only; its invalid syntax is not reported), and `carexy-doc.txt` §§1-1, 1-2, 2, 3-5.  
**Date:** 2026-10-19 (1405-07-27)  
**Snapshot:** documents were being edited during this review; findings are against the 18:51 +0330 worktree state (`DATA-MODEL.md` 2,377 lines / 191-table version).  
**Verdict:** **Reject** — the model is not implementable as a single schema without schema/API changes.

**Passed checks (not repeated below):** all 16 ARCHITECTURE §4 module groups have at least one owned table; the permission registry now matches API §5 exactly (412/412 keys, no delta); money is overwhelmingly `bigint`; all five declared partitioned parents use `RANGE(created_at)` and a `(id, created_at)` PK.

---

## Blockers

### B-01 — API features have no persistence objects
**Evidence:** API §4 defines `notification-templates` (§4.15, lines 1150–1154), `notification-preferences` (1148–1149), `files/{id}/links` (1178–1179), `GET /jobs` and `/jobs/{id}` (1232–1236), `feature-flags` (1188–1189), `bank-statements` (1032–1035), `goods-receipts/{id}/scans` (707), `putaway/tasks/{id}/scans` (640), inbound `channel-webhook-subscriptions` (895–900), outbound webhooks (1271–1276), and generic `partners` (1071–1074). `DATA-MODEL.md` §2.1, §2.7, §2.14 and §5.3 contain no equivalent tables; §6.2 (line 1995) explicitly claims these are “keys with no dedicated table” and maps them to `sms_templates`, `bank_transactions`, `outbox_events`, and `file_assets.owner_entity_type/id`. Those objects lack the required fields: `sms_templates` has no notification channel/subject/event; `bank_transactions` has no statement header/import file/status; `outbox_events` has no subscription URL/secret/event filters/delivery attempts; `file_assets` has one owner, not multiple links with a `role`.
**Why it breaks:** the endpoints cannot be implemented without inventing schema outside the authoritative document; `GET /jobs/{id}` has no common job key across the five job tables, and `notification.template` cannot serve email/in-app templates.
**Exact fix:** add at minimum `platform.notification_templates`, `platform.notification_preferences`, `platform.file_links`, `platform.jobs` (or a globally keyed `job_runs` view plus a shared `job_id`), `platform.feature_flags`, `platform.webhook_subscriptions`, `platform.webhook_deliveries`, `treasury.bank_statements` (header/import metadata), `procurement.goods_receipt_scans`, `warehouse.putaway_scans`, and a `partners.partners` master (or an explicit `shareholder_type` extension plus code for investor/channel partners). Add the missing fields to `sms_templates` only if it is intentionally the unified template store; otherwise remove the false mapping. Update §2/§7 counts and the 191-table assertion.

### B-02 — Draft documents cannot be created because numbers are `NOT NULL`, yet numbering is only allocated at posting
**Evidence:** `journal_entries.entry_no varchar(60) NN` (DATA-MODEL line 776) while API `POST /accounting/journal-entries` creates a draft (API 942) and `POST …/post` “assigns document number” (948). The same pattern exists for `customer_invoices.invoice_no NN` (line 620) with API create-draft (764) and issue-allocates-number (766), and for `sales_orders.order_no NN` (608) with draft creation (745). `allocate_document_no` is defined as the only allocator (line 109; §5.3).
**Why it breaks:** either every draft must consume a number (creating gaps on abandoned drafts, contradicting ADR-0014’s gap-free claim) or the insert violates `NOT NULL`; there is no third legal state. The design cannot support both “draft without number” and “gap-free issued numbers.”
**Exact fix:** choose one policy and encode it: make `entry_no`/`invoice_no` nullable until finalization, add `UNIQUE` partial indexes `WHERE entry_no IS NOT NULL` / `WHERE invoice_no IS NOT NULL`, allocate in the same transaction as the post/issue transition, and add a deferred check that every `status IN ('posted','issued')` row has a number. If numbers must be allocated at create, remove “gap-free” from ADR-0014 and document that cancelled drafts burn numbers.

### B-03 — Journal balance is not enforced for empty entries or for header totals
**Evidence:** `journal_entries.total_debit_amount`/`total_credit_amount` default to `0` (line 776) and `ck_journal_entries_balanced` only checks `total = total` (line 777), so an empty or stale header passes. The deferred trigger is attached to `journal_lines` “AFTER INSERT OR UPDATE/DELETE” and checks line sums (lines 779–781, 1764); it never fires for an entry that is created and posted with zero lines. `ck_journal_lines_one_side` explicitly allows `(0,0)` (line 781). API `DELETE /accounting/journal-entries/{id}` deletes a draft (945), while §5.1/§5.2 says all document tables get `BEFORE DELETE` guards and are never deleted.
**Why it breaks:** a posted journal can have `0=0` header totals, no lines, and still satisfy every DB constraint; a journal can also have correct line sums but a stale header total. Both violate G5 (every posted journal balances) and break trial-balance reconciliation. The delete endpoint will either be blocked by the trigger or hard-delete a document the model says is immutable.
**Exact fix:** add a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `journal_entries` (not only `journal_lines`) that, when `status='posted'`, asserts `count(lines) >= 2`, `sum(debit)=sum(credit)`, `sum(debit)=total_debit_amount`, `sum(credit)=total_credit_amount`, and `total_debit_amount > 0`. Reject `(0,0)` lines via CHECK (`debit_amount + credit_amount > 0`). Decide draft deletion explicitly: either allow `DELETE` only for `status='draft'` and exempt it from the guard, or remove the endpoint and use `voided`/cancelled.

### B-04 — The CoA seed is internally inconsistent and cannot produce postable accounts
**Evidence:** §6.3 says 38 L3 rows and 129 total (line 1999), but the L3 table has 39 rows (through `5-2-01`) and the “continued” list adds nine more, i.e. 48 L3 rows; 5+10+48+62+8+6 = 139, not 129 (lines 2026–2070). L4 has 62 rows but no children for `5-2-06`…`5-2-10` (ends at `5-2-05-001`, line 2137). L1 has `account_type`/`normal_balance`, but L2/L3/L4 tables list only code/name/parent (lines 2013, 2028, 2074); `account_type` and `normal_balance` are `NOT NULL` (line 756). `is_postable` defaults to `false` (756), and no L4 row sets it to `true`; therefore every posting rule’s account is non-postable. `nature` is never seeded, so contra accounts (`1-2-02`, `3-1-02`, `4-1-02`, `4-1-03`) are recorded as ordinary income/asset/equity rather than contra. L5/L6 are counted as seeded rows but the text says they are created lazily (1999, 2139–2143); L6 uses `parent_id = L4`, skipping L5.
**Why it breaks:** the seed either fails on `NOT NULL` or produces a chart with no postable account; daily sales/COGS/returns postings fail or post to the wrong normal balance; P&L and balance-sheet presentation is wrong for returns, discounts, accumulated depreciation, and unpaid capital; the advertised 129-row count is false.
**Exact fix:** rewrite §6.3 as an executable seed with every mandatory column (`account_type`, `normal_balance`, `nature`, `is_postable`, `currency`, `organization_id`) on every row; set `is_postable=true` for the 62 L4 rows; mark `1-2-02`, `3-1-02`, `4-1-02`, `4-1-03` as `nature='contra'` with the correct normal side; add L4 children for `5-2-06`…`5-2-10` or explicitly declare those L3 groups non-postable; recompute and state the true count (currently 48 L3 / 62 L4 / 139 total if L5/L6 templates are excluded); make L6’s parent the L5 row, not L4.

### B-05 — Posting rules reference non-existent accounts and are unbalanced for VAT
**Evidence:** §6.10 uses placeholders `4-1-01-00x`, `5-2-03-00x`, `1-1-08-00x` (lines 2214, 2216, 2225), but §6.3 contains only concrete codes such as `4-1-01-001`…`005`, `5-2-03-001/002`, `1-1-08-001/002`; no `00x` row can satisfy the FK. `SALE-ON-CREDIT` debits AR `gross_amount` and credits sales `net_amount`, then adds COGS/inventory legs, but never credits VAT payable (line 2214); with any positive VAT the entry is unbalanced. The section says “8 rules” but lists 14 (lines 2208–2225). `SALES-RETURN` similarly omits the VAT reversal.
**Why it breaks:** seeding the rules fails on account FKs or the first VAT sale fails `JOURNAL_UNBALANCED`; the auto-posting engine cannot satisfy G5 for the normal Iranian VAT case.
**Exact fix:** replace every `00x` with a concrete seeded account per channel (e.g. `4-1-01-001`…`005`, `5-2-03-001/002`, `1-1-08-001/002`); add a VAT leg `2-1-05-001` (or input VAT `1-1-06-001`) to sale, purchase, and return rules; make each rule’s expected debit/credit difference zero and add an integration test for a VAT-inclusive sale/return; correct the “8 rules” count.

### B-06 — Outbox idempotency and retention are both broken
**Evidence:** `uq_outbox_events_event` includes `created_at` (line 169) and the partition key is `created_at`; the claim “unique constraint makes the producer idempotent” (line 114) is false because two retries in different transactions get different `created_at`. Retention is one month (line 1405; registry `1` at 1674) and says “pending rows always kept (they are in the current month partition)” — pending/processing rows older than a month are in an expired partition and will be dropped. `status='processing'` has no lease/reclaim predicate: the pending index only covers `pending|failed` (line 169), and there is no `locked_until`/reclaim query.
**Why it breaks:** duplicate events can be produced after a retry; a stuck event is silently deleted, losing a business event; a worker crash after setting `processing` leaves the row invisible to every dispatcher forever.
**Exact fix:** add an unpartitioned global dedupe table `outbox_event_keys(event_type, aggregate_type, aggregate_id, event_version)` with a real PK/unique, or carry a producer-generated `event_uuid` with a global unique index; before dropping/detaching a partition, move or block on any `pending|processing` rows; add `locked_until timestamptz` and a reclaim path (`status='processing' AND locked_until < now()`) with the partial index covering it. Deduplicate on the natural key, not on `created_at`.

### B-07 — Inventory dedupe and availability invariants do not hold in the database
**Evidence:** `uq_inventory_transactions_idempotency` is `(idempotency_key, created_at)` (line 469; DDL 1490), so the same `gr:123:line:4` in a later transaction is accepted. `inventory_balances` CHECKs only individual columns and `reserved <= on_hand` (line 465); it does not check `reserved + safety_buffer + damaged <= on_hand`, although availability is computed as that subtraction (line 465). Example: `on_hand=10, reserved=10, safety_buffer=1` passes every CHECK and yields `available=-1`; channel push then publishes negative stock.
**Why it breaks:** a retried receipt/sale can double-post the ledger; the “negative stock is impossible” claim in ADR-0007 is false, violating G2 and the channel contract that channels never see negative available.
**Exact fix:** add a global unpartitioned ledger dedupe table keyed by the business `idempotency_key` (or make the key globally unique outside the partitioned table); add `CHECK (reserved + safety_buffer + damaged <= on_hand)` to `inventory_balances` (or a generated `available` column with `CHECK (available >= 0)`) and test the exact combination; keep the service check but do not describe it as DB-enforced until the combined CHECK exists.

### B-08 — Partition maintenance cannot run as the worker and constructs invalid relation names
**Evidence:** §1.1 says maintenance functions are `SECURITY DEFINER` owned by `saman_migrator` (line 19), but the actual `ensure_month_partition`/`maintain_partitions`/`drain_default_partition` DDL has no `SECURITY DEFINER` (lines 1677–1731). `saman_worker` has no CREATE on schema `erp` (§5.5, line 1807). `v_name := format('%I_p%', p_parent::regclass::text) || to_char(...)` (1682) yields e.g. `"erp.inventory_transactions"_p202610` when `regclass` renders schema-qualified; `CREATE TABLE erp.%I` then quotes that whole string. `drain_default_partition` performs `DELETE` (1725–1728) even though append-only tables grant no DELETE. `partitioned_tables_registry` has `is_enabled` (224) but the DDL omits it (1663–1668) and `maintain_partitions` ignores it (1697).
**Why it breaks:** the first daily maintenance job fails with “permission denied for schema erp” or an invalid identifier; the default partition grows until inserts fail; the drain function cannot delete rows. 
**Exact fix:** declare all three functions `SECURITY DEFINER SET search_path = erp, pg_temp`, owned by `saman_migrator`, with `REVOKE EXECUTE ... FROM PUBLIC` and grant only to `saman_worker`; build names from `pg_class.relname`/`pg_namespace.nspname` with `format('%I.%I', nspname, relname || '_p' || to_char(...))`; use a session advisory lock around create; add `is_enabled` to the registry DDL and filter on it; handle drain via a privileged function and log it.

### B-09 — Seed order violates FK dependencies and omits bootstrap users and price lists
**Evidence:** seed order is `permissions → roles → role_permissions → organizations → …` (line 1836). `roles.organization_id` is `NOT NULL` with an FK to organizations (line 241); `role_permissions.role_id` refers to roles. No `identity.users` seed is listed at all. `channel_accounts.price_list_id` references `price_lists` (690), but `price_lists` is absent from the seed order and no price-list seed is specified. `accounting_document_types` is also absent.
**Why it breaks:** the seed cannot insert roles before organizations; even if reordered, there is no superadmin login, no default price list for channel accounts, and no document-type registry for numbering/approval; `db:seed` cannot reach the release-gate login.
**Exact fix:** reorder to `organizations → permissions → roles → role_permissions → users (bootstrap superadmin with forced password change) → branches/units/CoA → fiscal year/periods → tax/settings → price_lists → numbering/document_types → warehouses → carriers → channels/accounts → posting rules → workflows → reports`; add idempotent seeds for `users`, `price_lists`, and `accounting_document_types`; make each seed's natural key explicit.

### B-10 — API state machines and the DB CHECK vocabularies disagree
**Evidence:** API order state is `draft → submitted → confirmed → allocated → picking → packed → shipped → delivered → closed`, plus `cancelled`, `on_hold`, per-line `returned` (API 727). DATA-MODEL `order_status` is `draft|pending|confirmed|allocated|picking|packed|shipped|delivered|completed|cancelled|returned` (line 80) — no `submitted`, `on_hold`, or `closed`; `pending`/`completed` are extra. API journal flow is `draft → submitted → approved → posted` (913); `document_status` has `pending_approval` but no `submitted` (80). API payment uses `direction: "out"|"in"` (1017); the table CHECK is `inbound|outbound` (860). API valuation uses `weighted_average` (972); the table CHECK is `moving_average` (516). API cheque lifecycle starts `issued` (1012); `cheques.status` has no `issued` and defaults to `received` (896).
**Why it breaks:** normal API transitions (`submit`, `hold`, `close`, create issued cheque, run weighted-average valuation) will violate DB CHECKs; the API and DB cannot both be correct.
**Exact fix:** define one shared `enums.ts` and one migration CHECK per vocabulary; pick the API tokens or the DB tokens, not both. Concretely: add `submitted`, `on_hold`, `closed` (and timestamps) to orders or map `submit→pending_approval`, `hold→on_hold`; add `submitted` to document_status; use `inbound|outbound` in the API or change the CHECK; map `weighted_average` to `moving_average` in one adapter and document it; add `issued` to the cheque status CHECK and make the default direction-dependent.

---

## High

### H-01 — Unique keys on soft-deleted master data prevent reuse
**Evidence:** `users` has `uq_users_org_username`, `uq_users_org_mobile`, `uq_users_org_email ... WHERE email IS NOT NULL` with no `deleted_at IS NULL` (line 235); the API soft-deletes users (API 430-ish). Same pattern for `product_categories.code` (312), `brands.lower(name)` (316), `units_of_measure.code` (320), `products.product_no/slug` (327), `product_variants.sku` (331), `product_attributes.code` (339), `warehouses.code` (389), `customers.customer_no/mobile` (600), `suppliers.code` (532), `chart_of_accounts.code` (756), `price_lists.code` (566), `sales_channels.code` (685), and others. `uq_product_variants_default ... WHERE is_default` and `uq_product_media_primary ... WHERE is_primary` do not filter `deleted_at` either, so a soft-deleted default blocks a new default.
**Why it breaks:** a deleted employee's mobile/username, a retired SKU, or a deleted warehouse code can never be reused; normal “delete and recreate” operations fail with a unique violation that the API reports as `CONFLICT`.
**Exact fix:** make natural-key unique indexes partial on `WHERE deleted_at IS NULL` for every soft-deleted master table; for identifiers that must never be reused (barcode, national ID, order/invoice number), keep the global unique and document the intentional exception. Add `AND deleted_at IS NULL` to the `is_default`/`is_primary` partial indexes. Add a migration test that soft-deletes and recreates a product/user/warehouse.

### H-02 — “Every FK indexed” and the composite-FK claim are not true
**Evidence:** §1.3 says every FK column gets an index (line 47), and MIGRATION-NOTES §4.1 makes it a zero-row lint gate. The table specs omit indexes for many FKs, e.g. `inventory_transactions.serial_id/inventory_unit_id/created_by/updated_by` (468), `sales_orders.branch_id` (608), `organizations.default_tax_rate_id/logo_file_id` (282), `supplier_invoices.file_id` (551), `expenses.file_id` (848), `profit_distribution_runs.approval_request_id` (919), `channel_settlements.file_id` (932), `journal_entries.approval_request_id` (776), `security_events.session_id` (152). Separately, §1.5 promises composite FKs `(organization_id, id)` (line 74) and `inventory_balances` claims `(organization_id, warehouse_id) → warehouses` (464), but `warehouses` has only a single-column PK and no documented `UNIQUE (organization_id, id)`; that composite FK cannot be created.
**Why it breaks:** the 0017 lint gate will fail (or the index claim is false), and the composite FK either fails migration or is silently omitted, so cross-org links remain possible.
**Exact fix:** add the missing leftmost indexes for every FK, including the standard `created_by`/`updated_by`/`approved_by` columns; add `UNIQUE (organization_id, id)` to every aggregate root that is the target of a composite FK (`warehouses`, `organizations`, etc.) and list the composite FK explicitly, or remove the claim and use single-column FKs plus repository scoping. Re-run MIGRATION-NOTES §4.1 and publish the zero-row result.

### H-03 — Child references to the partitioned ledger have no FK and can silently orphan history
**Evidence:** `stock_adjustment_lines.inventory_transaction_id` (496), `goods_receipt_lines.inventory_transaction_id` (548), and `return_lines.inventory_transaction_id` (632) are plain `bigint` with no FK; the ledger PK is `(id, created_at)` and the model says external FKs use `id` (23). `inventory_transactions.reversal_of_id` is also a plain `bigint` (468). The ledger’s own `lot_id`, `serial_id`, and `inventory_unit_id` FKs use `ON DELETE SET NULL` (1461–1466), so deleting a lot/serial/unit erases the traceability link from an immutable financial ledger row.
**Why it breaks:** a posted adjustment/receipt/return can point at a deleted or wrong ledger row; a “reversal” can point at nothing; lot/serial traceability is lost precisely where it is needed for warranty/returns/audit.
**Exact fix:** carry `inventory_transaction_created_at` in each child and use a composite FK `(inventory_transaction_id, inventory_transaction_created_at) → inventory_transactions(id, created_at)`, or use the immutable `reference_public_id`/`ledger_public_id` as the link with a global unique registry. Change ledger lot/serial/unit FKs to `RESTRICT` and forbid hard-deleting those masters; if `SET NULL` is intentional, document it as a formal exception and add a consistency check. Add the same treatment for `reversal_of_id` (self-composite FK or service-enforced with a nightly check).

### H-04 — Reservations cannot model partial consumption or deduplicate an order
**Evidence:** `stock_reservations` has one `quantity`, no `consumed_quantity`/`released_quantity`, no `sales_order_line_id`, and no unique active key per reference (488–489). Allocation creates “reservations” but a partial shipment/partial cancellation cannot reduce the reserved quantity without mutating the original row; a retried allocation can insert a second active row for the same order line.
**Why it breaks:** `reserved` can drift from the sum of active reservations on partial fulfilment; the 100-parallel-allocator test can pass while a duplicate request double-reserves; the `reservations_vs_reserved` nightly check cannot explain partials.
**Exact fix:** add `consumed_quantity numeric(18,4)`, `released_quantity numeric(18,4)`, and `sales_order_line_id`, with `CHECK (consumed_quantity + released_quantity <= quantity)`; add a partial unique index `(reference_type, reference_id, product_variant_id, location_id) WHERE status='active'` (or a dedicated `allocation_id`); make consumption increment `consumed_quantity` and release increment `released_quantity` in the same transaction as the balance update; add a consistency check that `sum(quantity - consumed - released) = reserved`.

### H-05 — Retention/prune jobs cannot delete the rows they are specified to delete
**Evidence:** §5.5 gives `saman_app`/`saman_worker` no DELETE on business or append-only tables (1658–1667); §5.6 allows only UPDATE on a short list. Yet `login_attempts` is retained 180 days and “worker trims” (270), `auth_sessions`/`otp_challenges`/`idempotency_keys` are purged by `fn_purge_expired_idempotency` (1785-ish), `channel_webhook_events` is “pruned by worker” (735), and `notifications` is dismissed by `DELETE` (API 1147). None of these have DELETE grants or partitions, and the purge function is not declared `SECURITY DEFINER`.
**Why it breaks:** tables grow without bound; the purge function fails with permission denied; a “successful” retention job never actually deletes, so the 90/180-day promises are false.
**Exact fix:** either partition these tables and drop partitions with a privileged maintenance role, or grant column-scoped/row-scoped DELETE to a dedicated `saman_retention` role and make the purge functions `SECURITY DEFINER`; add a test asserting row counts drop; add explicit `deleted_at`/dismissed semantics for notifications instead of DELETE if the append-only rule is meant to apply.

### H-06 — Fiscal-year numbering reset is unspecified and probably copies the old counter
**Evidence:** `reset_policy='fiscal_year'` (200) but §6.7 says a new fiscal year “copies the rows” (2192) and never says `next_value` is reset; `allocate_document_no` only increments (201). The formatter is described as `PREFIX-YYYY-000123` (109) but the function receives `fiscal_year_id`, not the Jalali `fiscal_years.code` (`1405`); no join/format source is specified.
**Why it breaks:** the first invoice of 1406 can be `INV-1406-000124` (or the first journal `JV-1406-000988`) instead of `000001`; if the function uses the Gregorian year, every displayed number is wrong. This is a legal/document-control defect, not cosmetic.
**Exact fix:** on fiscal-year creation, insert each sequence with `next_value=1`, `fiscal_year_id=new`, and the same prefix; have `allocate_document_no` join `fiscal_years` and format `prefix || '-' || fiscal_years.code || '-' || lpad(next_value::text, padding, '0')`; add tests for 1404→1405 and 1405→1406; make `fiscal_year_id` `NOT NULL`.

### H-07 — Several “money” and weight values violate the declared type policy
**Evidence:** `inventory_consistency_checks.expected_value/actual_value/difference` are `numeric(18,4)` (524) although the same row can compare money (`lot_cost_remaining`, `ledger_vs_balance` value) and quantities; `automation.alert_rules.threshold_value` and `alert_events.metric_value` are `numeric(18,6)` (974, 978) and can represent `sales_amount`/`inventory_value`; `warehouse_bins.capacity_weight_kg` is `numeric(18,4)` (410) although ADR-0013/MIGRATION-NOTES mandate integer grams. The CI lint only checks `%_amount` and a set of quantity names, so all three escape it.
**Why it breaks:** money can pick up fractional rials or lose exactness through a generic numeric path; the lint gives false assurance; weight conversions become inconsistent with `shipping_rates`/`shipments` integer grams.
**Exact fix:** split the consistency columns into `expected_qty/actual_qty/difference_qty numeric(18,4)` and `expected_amount/actual_amount/difference_amount bigint` (or store both in typed JSON with a discriminator and a check); replace `threshold_value`/`metric_value` with `threshold_amount bigint` plus a metric-type discriminator or `threshold_quantity numeric(18,4)`; change `capacity_weight_kg` to `capacity_weight_grams integer`; extend the lint to flag any `numeric` column whose name contains `amount|price|cost|total|fee|value`.

### H-08 — The exact line-total CHECK will reject valid fractional quantities
**Evidence:** `sales_order_lines.line_total_amount = quantity * unit_price_amount - discount_amount + tax_amount` (613), with `quantity numeric(18,4)` and money `bigint`. For `quantity=0.3333`, `unit_price=100`, the exact product is `33.33`, but `line_total_amount` is an integer; any rounded value (33 or 34) fails the CHECK. The note says “the CHECK is exact,” which makes the problem explicit.
**Why it breaks:** any sale of a fractional unit (kg, meter, liter) fails at insert; the service cannot satisfy both exact arithmetic and integer money.
**Exact fix:** compute the line total in `numeric` with a documented rounding boundary, then either store `line_total_amount bigint` and drop the exact CHECK (use a tolerance or a generated `numeric` comparison) or store `line_total_amount numeric(18,4)` and convert to bigint only at invoice/journal boundaries. Add a test with 0.3333 kg and a 3-decimal price.

### H-09 — `product_media` requires both owners, contradicting its own CHECK
**Evidence:** `product_media.product_id bigint NN` and `variant_id bigint NN` (355–357), while `ck_product_media_owner` says `product_id IS NOT NULL OR variant_id IS NOT NULL` and the text says “service always sets product_id.” A product-level image cannot have `variant_id` NULL because the column is NOT NULL; a variant-level image must also carry a product id.
**Why it breaks:** the API’s product media flow (`POST /products/{id}/media`, API 495) cannot insert a product-only row, and the dual ownership invites inconsistent product/variant pairs.
**Exact fix:** make both nullable and add `CHECK (num_nonnulls(product_id, variant_id) = 1)`; if a variant image should also belong to its product, add a separate `product_id` denormalization with a composite FK or derive it via the variant. Replace the partial unique primary index with `(product_id) WHERE is_primary AND product_id IS NOT NULL` and a separate variant primary index.

### H-10 — The 13th adjustment period is explicitly allowed but rejected by the CHECK
**Evidence:** `period_no smallint NN CK between 1 and 12 (13th adjustment period allowed: 13)` (772). The parenthetical contradicts the check; any insert with `period_no=13` fails.
**Why it breaks:** year-end adjustment entries cannot be posted in the 13th period, forcing them into period 12 and corrupting the monthly close.
**Exact fix:** change the CHECK to `period_no BETWEEN 1 AND 13`; add a uniqueness/overlap rule for the 13th period and test closing/reopening it.

### H-11 — `tax_documents.status` defaults to a token outside `document_status`
**Evidence:** `tax_documents.status ... DF 'issued' CK (document_status vocabulary)` (796); `document_status` is `draft|pending_approval|approved|posted|voided` (80) and does not contain `issued`. The same paragraph says “document_status vocabulary,” so a literal implementation rejects the default on every insert.
**Why it breaks:** no tax document can be created with the documented default; the VAT export path is blocked.
**Exact fix:** add `issued` to `document_status` (if tax documents share it) or give `tax_documents` its own explicit status list; align `tax_documents.document_type` with API 965–970 (`sales_vat|purchase_vat|...` vs invoice/credit-note/return) at the same time.

### H-12 — Issued cheques cannot enter their documented initial state
**Evidence:** `cheques.direction IN ('received','issued')`, `status ... DF 'received' CK in (received|in_custody|deposited|cleared|bounced|endorsed|returned|cancelled)` (896); API says cheques follow `issued → endorsed → deposited → cleared | bounced | cancelled` (1012) and `POST /treasury/cheques` registers either direction (1047). There is no `issued` status.
**Why it breaks:** an issued cheque is stored as `received` (semantically wrong) or the insert must use a status not in the list; cheque aging/reminders and the journal rule `cheque.received` cannot distinguish payable from receivable.
**Exact fix:** add `issued` to the status CHECK; make the default a function of direction (`received` for received, `issued` for issued) or require status in the API; add a CHECK that received/issued lifecycle states are compatible with direction; add `issued_at`.

### H-13 — Payment status/direction and the account-presence CHECK block gateway payments
**Evidence:** `payments.direction CK in ('inbound','outbound')` (860) vs API `"out"|"in"` (1017); `payments.status` only `pending|confirmed|cleared|bounced|voided` (860) while API has `submit/approve/execute` (1020–1022); `ck_payments_account_present` requires a bank/cash/cheque account (861), but the API explicitly supports `method:"gateway"` with only optional bank/cash IDs (1017).
**Why it breaks:** a gateway payment draft has no account row and fails the CHECK; submitted/approved/executed payments have no representable status; API clients using `out`/`in` fail the CHECK.
**Exact fix:** align direction tokens; add `pending_approval|approved|executed|failed` (or a separate `approval_status`); relax `ck_payments_account_present` to allow `gateway|credit` until execution, or require a gateway clearing account; add `executed_at` and `gateway_reference` if not covered by `reference_no`.

### H-14 — WMS schema cannot represent the API’s location tree, device secrets, or scan events
**Evidence:** API `POST /warehouses/{id}/locations` accepts `parentId` and `type: zone|aisle|rack|shelf|bin|location` (626), but the model has separate `warehouse_zones`/`aisles`/`racks`/`shelves`/`bins` tables and `warehouse_locations` only as a leaf with `bin_id NN` (413–414); there is no `parent_id`, `type`, or `capacity` on the leaf. API `POST /warehouse/devices` returns a one-time secret and `rotate-key` (672–675), but `warehouse_devices` has no `secret_hash`, `revoked_at`, or station binding (453). API `POST /putaway/tasks/{id}/scans` accepts `eventId` (640) and `POST /goods-receipts/{id}/scans` accepts `eventId` (707), but there are no putaway/goods-receipt scan tables. API packing scans carry `stage` and weight (666–668), while `packing_scans` has only variant/barcode/qty (449).
**Why it breaks:** the single-tree endpoints cannot create or patch a zone/aisle/rack through `warehouse_locations`; device secrets cannot be stored or rotated; offline scan replay has no idempotency key; packing verification cannot record the order/package/weight stages the API requires.
**Exact fix:** either adopt one `warehouse_locations` tree table with `parent_id`, `location_type`, `capacity_qty`, `capacity_weight_grams` and a self-FK (and keep the typed tables as views), or add a `location_node` table that maps each typed node and expose `parent_id`; add `secret_hash`, `secret_rotated_at`, `revoked_at`, `station_id` to devices; add `putaway_scans`/`goods_receipt_scans` with `(client_event_id)` unique; add `stage`, `expected_weight_grams`, `actual_weight_grams`, `verification_result` to packing scans/tasks.

### H-15 — Procurement, pricing, and channel tables lack fields required by their endpoints
**Evidence:** `goods_receipts` has no `supplier_id` (544), but API accepts `supplierId?` for blind receipts (704); `product_reorder_rules` has `min_qty/max_qty/reorder_qty` but no `reorder_point` or `lead_time_days` (379), both required by API 719; `price_lists` has no `valid_from/valid_to` (566), required by API 827; `pricing_rules` has no `rule_type`, `scope` JSON, or `value` (574), while API 836 sends `type` + `scope{categoryIds,brandIds,variantIds,channelCode}` + `value`; `channel_fee_rules` has no `tiers` (590), while API 848 accepts `tiers`; `channel_inventory_mappings` has no `external_inventory_id`, `external_storage_id`, or `mode` (702), while API 884 requires them for Carexy/Digikala; `channel_sync_jobs` has no `scope`, `progress`, or per-item errors (726), while API 890–894 requires them.
**Why it breaks:** the endpoints cannot persist the request; price rules with multiple scopes cannot be represented by the single `category_id/variant_id/brand_id` columns; Digikala storage mapping and channel sync progress are impossible.
**Exact fix:** add the columns/tables listed; for pricing, either normalize `pricing_rule_scopes` and `channel_fee_tiers` or store the API `scope`/`tiers` in typed JSON with a promotion path for filters; add `sync_job_errors` keyed `(sync_job_id, item_key)` and `progress_total/progress_processed`; add `external_inventory_id/external_storage_id/mode` to inventory mappings.

### H-16 — Returns/invoices/refunds cannot link the documents the API creates
**Evidence:** `customer_invoices` has `order_id` but no `return_id` (620), while API `POST /customer-invoices` accepts `orderId?` **or** `returnId?` (764). `returns` has no `resolution` field (628) while API sends `resolution` (770). `refunds` has only `return_id`, no `order_id` for goodwill refunds (636), while API accepts `orderId?` (778); `refunds.method` uses `bank_transfer|customer_credit` (636) while API sends `bank|store_credit` (778).
**Why it breaks:** invoice-from-return cannot be stored; the return resolution is lost; goodwill refunds cannot be linked; the method value fails the CHECK.
**Exact fix:** add `return_id` to `customer_invoices` with a CHECK that exactly one of `order_id/return_id` is set; add `resolution` to `returns` with a CHECK; add `order_id` to `refunds` and the same one-of check; align method tokens with the API (or map in the DTO); add `return_line_id` to `customer_invoice_lines` if invoice lines can originate from returns.

### H-17 — Bank statement import and reconciliation cannot be represented
**Evidence:** API has `bank-statements` list/detail/lines and `statement-imports` (1032–1035), plus `POST /treasury/reconciliations` with `statementId` and `periodId` (1057). The model has only `bank_transactions` with a free-text `import_batch_id` (884) and `bank_reconciliations` keyed by `(account, period_start_date, period_end_date)` with no `statement_id` or `period_id` (888–889). There is no statement header/file/status/line-count table.
**Why it breaks:** an imported statement cannot be listed, reopened, or reconciled as a unit; a reconciliation cannot point at its statement or accounting period; API `GET /bank-statements/{id}` has no row to return.
**Exact fix:** add `treasury.bank_statements` (`id`, `bank_account_id`, `file_id`, `format`, `period_start/end`, `status`, `line_count`, `imported_by`, `imported_at`) and `bank_statement_lines` (or make `bank_transactions` a child with `statement_id`); add `statement_id` and `period_id` to `bank_reconciliations`; keep the date range as a derived/check field.

### H-18 — Valuation runs allow duplicate rows and use a method name the API does not send
**Evidence:** `inventory_valuation_runs` has nullable `warehouse_id` and `UQ (organization_id, warehouse_id, valuation_method, valuation_date)` without `NULLS NOT DISTINCT` (516–517), so multiple all-warehouse runs for the same date/method are allowed. `valuation_method` is `moving_average|fifo` (516), while API sends `weighted_average` (972); there is no `period_id` although API filters by `periodId` (971–972).
**Why it breaks:** the uniqueness constraint does not prevent duplicate global valuation runs; a valid API request for weighted average fails the CHECK; valuation cannot be tied to the accounting period it posts into.
**Exact fix:** add `UNIQUE NULLS NOT DISTINCT (organization_id, warehouse_id, valuation_method, valuation_date)` (or make `warehouse_id` NOT NULL and use a separate all-warehouse run type); accept `weighted_average` as an alias in one mapping layer or change the DB token; add `period_id` and a FK to `accounting_periods`.

### H-19 — The 25-month hot ledger retention is not feasible at the stated 2M rows/day headroom
**Evidence:** `inventory_transactions` retains 25 months hot (line 1401), on a “single server, 4 vCPU / 8 GB” target (overview G6, line 31) with a 2M rows/day design headroom (overview §3, line 42). 2M × 730 = 1.46B rows before indexes; the table has seven indexes plus a BRIN (1479–1492), and queries are partitioned on `created_at` while accounting/reporting uses `business_date` (468). `audit_logs` separately retains 7 years (1402).
**Why it breaks:** the hot set alone is hundreds of GB to >1 TB; autovacuum, index bloat, backup/RTO, and p95 queries cannot be sustained on 8 GB, and `business_date` ranges cannot prune the `created_at` partitions. The capacity plan is therefore not credible at the stated headroom even if the 200k/day v1 target is fine.
**Exact fix:** set the hot window from measured volume (e.g. 3–6 months at 2M/day), detach/archive earlier, and keep only a narrow recent index set hot; either partition by `business_date` (if legal-date queries dominate) or require `created_at` bounds in every ledger query and add a `business_date` BRIN/btree per partition; publish a sizing calculation for rows/bytes/indexes per month and a restore/RTO test at the chosen retention.

---

## Medium

### M-01 — HTTP idempotency scope omits the actor, and order idempotency never expires
**Evidence:** `uq_idempotency_keys_org_scope_key (organization_id, scope, key)` (165) — two users in one org using the same `Idempotency-Key` for the same route collide, and the second replays the first user’s response. `sales_orders.idempotency_key` is permanently unique per org (609), while the HTTP contract says 24 h retention (ARCHITECTURE §8, API 235–249).
**Why it breaks:** cross-user data leakage/incorrect replay; a client reusing a key after 24 h gets a false duplicate order.
**Exact fix:** add `actor_type/actor_id` (or `api_client_id`) to `idempotency_keys` and its unique key; remove or TTL-scope `sales_orders.idempotency_key` (e.g. store the request hash and allow reuse after 24 h, or use a separate `channel_order_mappings` natural key). Add tests for two users, same key.

### M-02 — `products.attributes_json` is filterable data in JSONB
**Evidence:** `products.attributes_json jsonb NN DF '{}'` is described as “denormalized searchable attributes, promoted columns used for filters” (327). ADR-0003 §12 forbids JSONB for fields that need joins/filters. The API filters only a few promoted fields today, but category-attribute filtering is a stated product need (category attributes, Digikala mapping).
**Why it breaks:** attribute filters/search will either scan JSONB or silently miss values; promoted columns do not exist for all attributes.
**Exact fix:** either explicitly scope `attributes_json` to display/search only and add a normalized `product_attribute_values`/EAV query path for filters, or promote the filterable attributes to typed columns/indexes. Document the chosen path and add a query-plan test.

### M-03 — Alert occurrences have no lifecycle events, assignee, or note
**Evidence:** `automation.alert_events` has `status`, `acknowledged_by`, but no `assignee_user_id`, `note`, or child event table (978); API `POST /alerts/{id}/acknowledge` accepts `note?`, `assigneeUserId?` (1227) and `GET /alerts/{id}/events` returns lifecycle events (1228).
**Why it breaks:** acknowledgement notes/assignments are lost, and the events endpoint has nothing to read.
**Exact fix:** add `assignee_user_id`, `acknowledgement_note`, and an append-only `alert_event_actions(alert_event_id, action, user_id, note, acted_at)` table; or treat `alert_events` as immutable and add `alert_occurrences` for state.

### M-04 — API client rotation and file upload readiness are not modelled
**Evidence:** API `POST /api-clients/{id}/rotate-secret` promises a 24 h old-secret overlap (1200); `api_clients` stores only one `secret_hash` (156). API file upload has a two-step `complete` with checksum/size verification and `file_not_ready` (1171–1176); `file_assets` has `sha256`, `scan_status`, but no `upload_status`/`verified_at`/`completed_at` (180).
**Why it breaks:** rotation either invalidates the old secret immediately (breaking clients) or cannot be implemented; a file cannot be distinguished as pending upload vs ready vs quarantined.
**Exact fix:** add `api_client_secrets(client_id, secret_hash, valid_from, valid_to, rotated_at)` or `previous_secret_hash/previous_valid_until`; add `upload_status (pending|uploaded|verified|quarantined|deleted)`, `verified_at`, `completed_at` to `file_assets`; gate download on `upload_status='verified' AND scan_status IN ('clean','skipped')`.

### M-05 — `integration_dead_letters.integration` cannot accept the maintenance failure it is supposed to record
**Evidence:** the CHECK is written as `IN ('carexy','digikala','limo_sms','carrier:*' free with prefix)` (172); §4.4 says a partition-maintenance failure inserts `integration='partition_maintenance'` (1734). `partition_maintenance` is not in the list, and `IN` cannot express a `carrier:*` prefix.
**Why it breaks:** the critical alert path fails with a CHECK violation exactly when partitions are broken, hiding the outage.
**Exact fix:** use a lookup table `integration_types(code)` or a CHECK `integration IN ('carexy','digikala','limo_sms','partition_maintenance') OR integration LIKE 'carrier:%'`; add a `source`/`operation` field instead of overloading `integration`.

### M-06 — Secondary enum vocabularies drift from the API
**Evidence:** `tax_rates.tax_type` has `income|excise|duty|exempt` but API 962 sends `other`; `product_attributes.data_type` has `enum|color` but API 497 sends `select|multiselect`; `product_barcodes.barcode_type` has `ean13|ean8|code128|code39` but API 534 sends `gtin13|gtin8|ean`; `warehouses.warehouse_type` has `returns` but API 619 sends `return`; `channel_sync_jobs.job_type` has `push_inventory` but API 890 sends `inventory_push`; `printer_jobs.status` has `queued|printing|printed|failed|cancelled` while API 1253 documents `pending|printed|failed`.
**Why it breaks:** normal create/update calls fail CHECKs; adapters must guess aliases; reports group different tokens.
**Exact fix:** centralize all these lists in `packages/shared/enums.ts` and generate both the CHECKs and the API DTOs from it; add an enum-parity test that fails on any API token absent from the DB list.

### M-07 — Sample channel accounts have no idempotent natural key
**Evidence:** `channel_accounts` unique key is `(channel_id, external_account_id) WHERE external_account_id IS NOT NULL` (691); the seed accounts `carexy-main`, `digikala-main`, `mock-test` (2016) have no documented `external_account_id`. Re-running the seed cannot upsert them by name, and there is no `(organization_id, name)` unique.
**Why it breaks:** `pnpm db:seed` twice creates duplicate accounts, violating MIGRATION-NOTES §5.1 and making channel mappings ambiguous.
**Exact fix:** add a stable `code`/`account_key` with `UNIQUE (organization_id, code)`, or seed with explicit `external_account_id` values and use that key; add a seed count assertion for channel accounts.

### M-08 — Holiday uniqueness is not org-scoped
**Evidence:** `org.holidays` `UQ (holiday_date, title_fa)` (302) but the table has `organization_id` (301). In a multi-org schema, the same date/title in two orgs collides; `organization_id` is nullable, so global rows also exist.
**Why it breaks:** the second org cannot seed the same official holiday; date calculations become org-dependent by accident.
**Exact fix:** use `UNIQUE (organization_id, holiday_date, title_fa)` with `organization_id NOT NULL`, or a partial unique for global rows plus a separate org override table; add `branch_id` if branch-specific holidays are supported by the API (holiday `branchId?`, API 476).

### M-09 — `allow_negative_stock` is a dead setting
**Evidence:** `organizations.allow_negative_stock boolean NN DF false` (282) and `system_settings.inventory.allow_negative_stock=false` (2206) exist, but `inventory_balances` CHECKs make any negative impossible (465) and the setting is “immutable in v1.”
**Why it breaks:** operators can set a flag that has no effect; if negative stock is ever required for a repair/opening flow, the DB cannot represent it; the documentation implies a capability that does not exist.
**Exact fix:** remove the setting and document “negative stock is structurally impossible,” or implement it as a per-warehouse exception with a separate `allow_negative` flag and a conditional CHECK/trigger; do not leave a dead boolean in the org profile.

### M-10 — Account-balance posting has no fixed lock order
**Evidence:** `account_balances` is updated per journal line (787–789); ARCHITECTURE §6 fixes lock order for inventory and numbering but not for `(period_id, account_id, dimension_value_id)`. Two journals with the same accounts in different line orders can deadlock.
**Why it breaks:** concurrent postings can deadlock and retry-storm during close; the retry wrapper may mask it but throughput suffers.
**Exact fix:** sort journal lines by `(period_id, account_id, dimension_value_id)` before updating balances, or acquire all balance rows in one `SELECT ... ORDER BY ... FOR UPDATE` before applying lines; document the order in ARCHITECTURE §6 and test with reversed line order.

### M-11 — Ledger quantity sign is not tied to transaction type
**Evidence:** `inventory_transactions.quantity numeric(18,4) NN CK <> 0` (468), with types such as `receipt`, `sale_issue`, `transfer_out`. Nothing prevents a negative `receipt` or a positive `sale_issue`.
**Why it breaks:** a service bug can invert a movement and still satisfy the ledger CHECK; the nightly `Σ quantity` check may still “pass” for the wrong sign, and valuation/FIFO layers become wrong.
**Exact fix:** add a CHECK mapping sign to type, e.g. `(transaction_type IN ('receipt','adjustment_in','transfer_in','return_in','count_correction_in','opening_balance') AND quantity > 0) OR (transaction_type IN ('sale_issue','reservation_consume','adjustment_out','transfer_out','damage_out','scrap_out','count_correction_out') AND quantity < 0)`; add a test for each type.

### M-12 — FIFO ordering references a column that does not exist
**Evidence:** `inventory_lots` has no `received_at`; it has standard `created_at`, `manufacture_date`, `expiry_date` (471–473). The FIFO allocation says `ORDER BY expiry_date NULLS LAST, received_at` (473).
**Why it breaks:** the query does not compile or silently uses a different column; FIFO order is not deterministic for equal expiry dates.
**Exact fix:** add `received_at timestamptz NOT NULL DEFAULT now()` (or use `created_at` explicitly) and index `(warehouse_id, product_variant_id, expiry_date, received_at)`; use `FOR UPDATE SKIP LOCKED` with a documented lot order to avoid deadlocks.

### M-13 — The bank-transaction direction CHECK is a tautology
**Evidence:** `ck_bank_transactions_direction` is `(source='statement' AND direction IN ('debit','credit')) OR (source<>'statement' AND direction IN ('debit','credit'))` (885), which is equivalent to `direction IN ('debit','credit')` regardless of source; the prose claims “statements use bank perspective, documented,” but the constraint does not encode it.
**Why it breaks:** a statement row can use the book perspective (or vice versa) and reconcile with the wrong sign; the constraint gives false assurance.
**Exact fix:** define one perspective explicitly (e.g. `direction` always bank perspective for `source='statement'`, book perspective otherwise) and add a CHECK or, better, store `signed_amount bigint` computed from perspective and constrain sign by source; add reconciliation tests for both directions.

### M-14 — `capacity_weight_kg numeric` conflicts with the weight policy
**Evidence:** `warehouse_bins.capacity_weight_kg numeric(18,4)` (410), while ADR-0013/MIGRATION-NOTES §3 require integer grams for weights and `shipments.weight_grams` is integer.
**Why it breaks:** capacity checks compare kg decimals with gram integers; rounding differences can reject a valid putaway.
**Exact fix:** rename to `capacity_weight_grams integer` and convert seed/API values at the edge; add a CI lint for `%_weight_kg`.

---

## Low

### L-01 — Warehouse/location code formats are inconsistent across docs
**Evidence:** §2.5 says `A-12-R3-2-07` (386), the seed uses `A-01-R1-1-01` (2021), and API §4.5 uses `TEH-A-03-02-01` (614). The format is not a single grammar; `ck_warehouse_locations_full_code_format` has no published regex.
**Why it breaks:** scanner/barcode generators and imports can produce codes the CHECK rejects or that differ from the documented hierarchy.
**Exact fix:** publish one regex/grammar (including warehouse prefix, zone/aisle/rack/shelf/bin widths) in ADR/§2.5 and use it in the CHECK, seed, and API examples.

### L-02 — The registry DDL in §4.4 omits `is_enabled`
**Evidence:** `platform.partitioned_tables_registry` has `is_enabled` (224), but the `CREATE TABLE` in §4.4 has only four columns (1663–1668) and the `INSERT` supplies four values. `maintain_partitions` does not filter `is_enabled` (1697).
**Why it breaks:** an operator cannot disable a table; the “exact DDL” differs from the model; `CREATE TABLE IF NOT EXISTS` silently keeps whichever shape exists.
**Exact fix:** add `is_enabled boolean NOT NULL DEFAULT true` to the DDL/INSERT and `WHERE is_enabled` in the loop; add a migration test against the documented shape.

### L-03 — `ck_currencies_single_base` is a partial unique index, not a CHECK
**Evidence:** `currencies` says `CK ck_currencies_single_base` but then describes `partial unique index uq_currencies_one_base ON (is_base) WHERE is_base` (294). A CHECK cannot enforce uniqueness.
**Why it breaks:** a migration author following the label may write an invalid/unenforceable constraint; the single-base invariant may not exist.
**Exact fix:** call it `uq_currencies_one_base` and define it as a partial unique index; remove the `ck_` prefix.

### L-04 — `saved_filters` is owned by `platform` but exposed under reporting
**Evidence:** table is `platform.saved_filters` (203), API §4.14 reporting endpoints are `/saved-filters` (API 1115-ish) and permission module mapping says report/dashboard → reporting (1993).
**Why it breaks:** module ownership is ambiguous; future extraction of reporting would leave a reporting feature in platform; access control/policy review is split.
**Exact fix:** move to `reporting.saved_filters` or document a deliberate shared-platform ownership and add it to the report module's table list.

### L-05 — Self-review claims are stronger than the evidence
**Evidence:** §9.1 claims all 190 (now 191) tables are “column-complete” and every FK indexed (2350–2361), while B-01/H-02/H-14 show missing columns and indexes.
**Why it breaks:** reviewers and backend agents may treat the checklist as a gate and skip the actual lint; the document overstates readiness.
**Exact fix:** change the checklist to “verified by the following queries/tests” and attach results; remove unconditional checkmarks until `db:lint` and the API contract tests run green.

---

## Open questions

1. **CoA level taxonomy:** `carexy-doc.txt` §1-1 (lines 205–212) defines L1 group, L2 subgroup, L3 کل, L4 معین, L5 تفصیلی, L6 cost center; §2-1 (lines 1732–1743) defines four levels + optional cost center/project. DATA-MODEL uses L1 group, L2 کل, L3 معین, L4 تفصیلی, L5 cost center, L6 project. Which is normative for finance? The seed must follow one; the current model follows the later 4+2 text, not the earlier six-level table.
2. **Gap-free numbering versus drafts:** should a draft consume a number (simple, but gaps) or should numbers be nullable until posting (as API 948 says)? This decision determines B-02 and H-06.
3. **`allow_negative_stock`:** is there any legitimate negative-stock flow (opening/repair/consignment)? If not, delete the setting; if yes, define the exception and the corresponding CHECK.
4. **Partner master:** should `partners` be a generic master (shareholder/investor/channel) or is `shareholders` the only v1 entity? API 1071–1072 currently promises investor/channel types.
5. **Outbound webhooks:** are subscriptions part of v1? API 1271–1276 says yes, but the data model maps them to `outbox_events`; if v1 only needs delivery logging, say so and remove the subscription endpoints.
6. **Audit/inventory retention:** 25 months of 2M/day ledger rows on a single 8 GB host is ~1.5B rows; is that really the v1 target or only a design headroom? If the latter, set the hot window to 3–6 months and archive earlier.

---

## Verdict

**Reject.** The document is strong on intent and many conventions, but it is not yet an implementable schema: at least ten API surfaces have no persistence, document numbering cannot represent drafts and gap-free issuance simultaneously, journal balance is not enforced for empty/stale headers, the CoA seed cannot create postable accounts, posting rules reference non-existent accounts, outbox/ledger idempotency is broken by the partition key, and the partition maintenance function cannot run as the documented worker. Fix B-01 through B-10 and the High items that affect normal writes (H-12, H-13, H-14, H-16, H-17) before re-review; a second review should re-run the permission/registry parity, the FK-index lint, the CoA seed, and a concurrent allocation + outbox crash test against a real PostgreSQL 16 instance.
