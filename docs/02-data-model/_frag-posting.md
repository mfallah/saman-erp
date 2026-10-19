### 6.10 Default settings, posting engine, closing, numbering, seed order

**Settings (34 keys, `system_settings`, seeded idempotently)**: `general.company_name`, `general.logo_file_id`, `general.timezone=Asia/Tehran`, `general.locale=fa-IR`, `general.date_display=jalali`, `general.currency=IRR` (read-only), `inventory.valuation_method=moving_average`, `inventory.allow_negative_stock=false` (immutable), `inventory.default_safety_stock=0`, `inventory.reservation_ttl_minutes=30`, `inventory.count_variance_threshold_percent=0.02`, `inventory.costing.precision=4`, `sales.default_price_list_id`, `sales.order_prefix=SLS`, `sales.require_approval_refund_above=50000000`, `sales.rounding_account=5-2-14-001`, `sales.header_discount_distribution=largest_remainder`, `fulfillment.default_carrier=POST`, `fulfillment.free_shipping_threshold=20000000`, `fulfillment.pick_wave_max_orders=50`, `fulfillment.shipping_revenue_account=4-1-04-001`, `pricing.rounding_mode=nearest_1000`, `pricing.minimum_margin_percent=0.05`, `pricing.auto_recalc_on_cost_change=true`, `accounting.auto_post_sales=true`, `accounting.auto_post_purchase=true`, `accounting.journal_approval_threshold=100000000`, `accounting.fiscal_year_start_month=1`, `accounting.tax_rate_default_id`, `accounting.legal_reserve_percent=0.05`, `accounting.legal_reserve_cap_percent=0.10`, `accounting.inventory_gl_account=1-1-04-001`, `accounting.grni_account=2-1-11-001`, `accounting.cogs_account=5-1-01-001`, `channels.stock_push_debounce_seconds=3`, `channels.stock_push_batch_size=200`, `notifications.sms_otp_provider=limo_sms`, `notifications.low_stock_alert=true`, `security.otp_ttl_seconds=120`, `security.session_absolute_days=7`, `security.max_login_failures=10`, `security.lockout_minutes=15`, `security.require_2fa_new_device=true`, `security.audit_retention_years=10`, `files.max_upload_mb=20`, `files.allowed_mime=image/jpeg,image/png,image/webp,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv`, `files.persist_http_bodies_in_prod=false`.
**Partition registry seed** (`platform.partitioned_tables_registry`): the five rows in §4.4 (inventory_transactions 6 hot/25 warm, audit_logs 12 hot/120 archive, api_request_logs 3, channel_api_calls 6, outbox_events 1) — all `is_enabled=true`.

#### 6.10.1 Posting architecture (decision: code-owned services + simple declarative rules)

Per R1-A B-10 / R1-D B-05, the engine is primarily **code-owned posting services** (`modules/accounting/posting/<event>.posting.ts`), because a correct sale/purchase/settlement requires multi-entry, conditional and resolver-driven logic no two-column rule table can express. `posting_rules`/`posting_rule_lines` remain for simple two-leg, operator-tunable mappings (expense→account, fee variants, minor variance) inside an immutable versioned `posting_rule_sets`; every journal stores `posting_rule_set_id` so any posted entry is reproducible. Each event service is unit-tested against the matrix below (`VAT-inclusive`, `VAT-exempt`, discounted, fractional-qty and reversal variants). **No `00x` placeholder exists**: channel-specific accounts resolve through `posting_rule_lines.account_resolver` → `1-1-08-001..004`, `4-1-01-001..005`, `5-2-03-001..003` (one row per active channel mapping).

#### 6.10.2 Event → Dr/Cr matrix (complete; every event in the `event_type` enum)

All amounts are `bigint` IRR; `R` = account resolver key resolved by the service to a concrete seeded account from §6.3 (never a wildcard). VAT legs apply only when the invoice carries a valid tax id/rate; exempt sales omit them.

| # | event_type | Debit | Credit | Notes |
|---|---|---|---|---|
| 1 | `sales.invoice.issued` (credit sale) | `1-1-03-001` AR gross | `R:channel_sales_account` net; `2-1-05-001` output VAT; `4-1-04-001` shipping recharge | COGS is **not** here |
| 2 | `inventory.issue.posted` (sale issue) | `5-1-01-001` COGS | `1-1-04-001` inventory | posted at stock issue, layers consumed (B-01); valuation cost from `inventory_cost_layers`/average |
| 3 | `sales.cash_sale` (POS/cash) | `1-1-01-003` cash / `1-1-01-005` POS clearing; `5-1-01-001` COGS | `4-1-01-005` sales net; `2-1-05-001` VAT; `1-1-04-001` inventory | cash sale = invoice + immediate payment in one tx |
| 4 | `sales.discount.applied` | `4-1-03-001` discount | `1-1-03-001` AR | only header-level discounts admitted post-issue |
| 5 | `sales.payment.received` | bank/cash/`1-1-07-001` cheque on hand | `1-1-03-001` AR | `unapplied_amount` stays in `1-1-03-004` customer credit if not allocated |
| 6 | `sales.return.received` (restock) | `4-1-02-001` return net; `2-1-05-001` VAT reversal; `1-1-04-001` inventory at original layer cost | `1-1-03-001` AR/customer credit; `5-1-01-001` COGS reversal | credit note (`customer_invoices.document_kind='credit_note'`) issued in the same tx; layers restored (B-11) |
| 7 | `sales.return.received` (scrap/damaged) | `4-1-02-001`; `2-1-05-001`; `5-1-03-002` damage loss | `1-1-03-001`; `1-1-04-001` | condition drives the second pair; no COGS reversal for scrap |
| 8 | `sales.refund.paid` | `1-1-03-001`/`2-1-06-001` customer credit | `1-1-01-002` bank / `1-1-01-003` cash | only against an issued credit note |
| 9 | `purchase.receipt.posted` (no invoice) | `1-1-04-001` inventory net landed cost; `1-1-06-001` input VAT **only if** tax invoice exists at receipt | `2-1-11-001` GRNI | AP is **never** credited at receipt (B-02) |
| 10 | `purchase.invoice.received` | `2-1-11-001` GRNI; `1-1-06-001` input VAT; `5-2-13-001`/`2-1-11-001` price variance | `2-1-01-001` AP | 3-way match: receipt qty vs invoice qty; price variance to `5-2-13-001` (or inventory if material and unissued, per policy) |
| 11 | `purchase.invoice.variance` | `5-2-13-001` (unfavourable) or `2-1-11-001` (favourable) | `2-1-01-001` / `5-2-13-001` | written at match time, not silently netted |
| 12 | `purchase.return.issued` | `2-1-01-001` AP; `1-1-06-001` input VAT reversal | `1-1-04-001` inventory; `5-2-13-001` variance | supplier credit note |
| 13 | `purchase.payment.paid` | `2-1-01-001` AP | `1-1-01-002` bank / `1-1-01-004` gateway clearing | allocation may target invoices or advances |
| 14 | `purchase.prepayment.paid` | `1-1-05-001` prepayment | `1-1-01-002` bank | later applied via `payment_allocations(document_type='supplier_prepayment')` |
| 15 | `channel.fee.accrued` | `5-2-03-00x` commission/fee expense (R per channel); `1-1-06-001` VAT on fee if recoverable | `2-1-10-001` fee payable channel | posts at sale/invoice time, not at settlement |
| 16 | `settlement.confirmed` | `1-1-09-001` settlement clearing / `1-1-01-002` bank; `2-1-10-001` fee payable (netting); `5-2-13-001` settlement variance; `2-1-05-001` VAT on fee if applicable | `1-1-08-001..004` channel receivable (R per channel) | **never credits sales revenue** (B-03); any residual → variance |
| 17 | `settlement.variance.recorded` | `5-2-13-001` variance | `1-1-08-00x` channel receivable | or reverse when negative |
| 18 | `shipping.cost.incurred` | `5-2-01-001` shipping expense (or capitalized to inventory as landed cost when inbound — H-14) | `1-1-01-002` bank / `2-1-01-001` AP | inbound landed cost path uses a cost adjustment to layers |
| 19 | `shipping.recharged` | `1-1-03-001` AR | `4-1-04-001` shipping revenue; `2-1-05-001` VAT if taxable | typically part of sales invoice |
| 20 | `inventory.adjustment.posted` (shortage/damage/expiry loss) | `5-1-02-001` count shortage / `5-1-03-001` waste / `5-1-03-002` damage (at layer cost) | `1-1-04-001` inventory | cost is mandatory from layers; zero-cost relief rejected (H-05) |
| 21 | `inventory.adjustment.posted` (gain) | `1-1-04-001` inventory | `5-1-02-002` count gain / `4-2-02-001` cash over | side flip is code-owned; no rule-table flip needed |
| 22 | `inventory.transfer.dispatched` | `1-1-10-001` inventory in transit | `1-1-04-001` inventory (source warehouse) | per warehouse sub-account resolver |
| 23 | `inventory.transfer.received` | `1-1-04-001` inventory (destination) | `1-1-10-001` in transit | layer moved with qty+cost (H-04) |
| 24 | `inventory.valuation.posted` | `1-1-04-001` inventory (adjustment) | `5-1-02-001`/`4-2-02-002` valuation variance | only for method change/year-end true-up |
| 25 | `cash.receipt.recorded` | cash session cash | `1-1-03-001` AR / revenue (cash sale handled in #3) | session variance below |
| 26 | `cash.session.closed` (over) | `1-1-01-003` cash | `4-2-02-001` cash over | variance amount |
| 27 | `cash.session.closed` (short) | `5-2-12-001` cash short | `1-1-01-003` cash | variance amount |
| 28 | `cheque.received` | `1-1-07-001` cheques on hand | `1-1-03-001` AR | direction=received |
| 29 | `cheque.deposited` | `1-1-07-002` cheques in collection | `1-1-07-001` cheques on hand | |
| 30 | `cheque.cleared` | `1-1-01-002` bank | `1-1-07-002` in collection (received) / `2-1-09-001` cheques payable (issued) | direction branches |
| 31 | `cheque.bounced` (before clear) | `1-1-03-001` AR | `1-1-07-001`/`002` cheque on hand/collection | |
| 32 | `cheque.bounced` (after clear) | `1-1-03-001` AR; `5-2-07-001` bank charges | `1-1-01-002` bank | **reverses the bank**, not a zero cheque account (B-13) |
| 33 | `cheque.endorsed` | `2-1-01-001` AP / expense | `1-1-07-001` cheques on hand | plus memo guarantee note to `endorsed_to` |
| 34 | `cheque.issued` | `2-1-01-001` AP (or expense) | `2-1-09-001` cheques payable | direction=issued |
| 35 | `cheque.issued.cleared` | `2-1-09-001` cheques payable | `1-1-01-002` bank | |
| 36 | `payment.advance.received` | `1-1-01-002` bank | `2-1-06-001` customer advance | later applied to invoices |
| 37 | `payment.allocated` | `2-1-06-001` customer advance | `1-1-03-001` AR | or supplier side: `2-1-01-001` ↔ `1-1-05-001` |
| 38 | `profit.distribution.approved` | `3-2-01-001` retained earnings | `2-1-08-001` dividends payable; `3-2-02-001` legal reserve; `2-1-13-001` withholding | **after** closing run; never debits current-period profit (B-08/B-09) |
| 39 | `dividend.paid` | `2-1-08-001` dividends payable | `1-1-01-002` bank | withholding applied here |
| 40 | `tax.vat.payment` | `2-1-05-001` VAT payable | `1-1-01-002` bank | |
| 41 | `tax.vat.refund` | `1-1-01-002` bank | `1-1-06-001` VAT receivable | |
| 42 | `expense.recognised` | `5-2-xx`/category account; `1-1-06-001` VAT if recoverable | `2-1-01-001` AP / bank | category→account seed |
| 43 | `expense.paid` | `2-1-01-001` AP | `1-1-01-002` bank | |
| 44 | `bad_debt.allowance` | `5-2-11-001` | `1-1-03-003` allowance | |
| 45 | `bad_debt.writeoff` | `1-1-03-003` allowance | `1-1-03-001` AR | direct write-off only with approval |
| 46 | `closing.income_summary` | revenue accounts (`4-*`) | `3-2-04-001` income summary; expenses (`5-*`) debited/credited symmetrically | run by `ClosingService`, posted with `entry_type='closing'` |
| 47 | `closing.retained_earnings` | `3-2-04-001` income summary | `3-2-01-001` retained; `3-2-02-001` legal reserve (5% until 10% of capital); `2-1-08-001` dividends (if declared) | policy configurable; loss reverses |
| 48 | `opening.balances.imported` | each asset/expense | each liability/equity/revenue; `3-1-01-001` opening equity for residual | migration path; `entry_type='opening'` |
| 49 | `fx.revaluation` (future) | `1-1-02-001` FX loss/asset | `4-2-02-002`/`5-2-07-001` FX gain/expense | v1 single-currency; schema ready (`fx_rate`) |

`inventory.issue.posted` is emitted by the inventory module in the same transaction that consumes cost layers and writes the ledger; `sales.invoice.issued` never posts COGS (B-01). Settlement never re-recognises revenue (B-03). All rows 1–49 are covered by integration tests with a VAT-enabled and a VAT-exempt variant.
#### 6.10.3 Period-close / year-end closing run (B-08, R1-D B-03)

`ClosingService.run(fiscalYearId)` in one transaction: (1) reject if any period is open, any journal unposted, or any inventory ledger row has `period_id` in a closing year without journal; (2) post `closing.income_summary` (all revenue/expense balances → income summary); (3) compute net profit; (4) post `closing.retained_earnings` (income summary → retained earnings, legal reserve appropriation capped at 10% of registered capital, remainder retained); (5) write `closing_runs` linked to the three entries; (6) set `fiscal_years.closing_run_id/status='closed'`; (7) generate next-year opening entries (`entry_type='opening'`) for all balance-sheet accounts with non-zero closing balances. `fiscal_year.close` is blocked until this run is `posted`. Profit distribution is allowed only against `3-2-01-001` after closing. Opening-balance import uses `entry_type='opening'` + `03-roadmap` path and is idempotent per `(fiscal_year, account)`.

#### 6.10.4 Document-number lifecycle (R1-D B-02)

All document numbers are allocated **at the finalizing transition only** (post/issue/confirm), never at draft creation: `journal_entries.entry_no`, `customer_invoices.invoice_no`, `sales_orders.order_no`, `purchase_orders.po_no`, `goods_receipts.receipt_no`, `shipments.shipment_no` are **nullable**; a partial unique index `... WHERE <no> IS NOT NULL` plus `CHECK (status = '<draft-state>' OR <no> IS NOT NULL)` makes unnumbered non-draft rows impossible. Allocation uses `erp.allocate_document_no()` (`SELECT … FOR UPDATE` on `numbering_sequences`, keyed `(organization_id, document_type, fiscal_year_id)`) in the same transaction as the status change; a voided/cancelled draft never consumes a number; the ADR-0014 gap-free guarantee applies to issued numbers per (type, fiscal year). Sequence rows are created per fiscal year (no counter copy) — `fiscal_year.create` inserts fresh rows with `next_value=1` (R1-D H-06).

#### 6.10.5 Seed order (FK-safe; R1-D B-09)

`organizations → currencies/fx_rates/holidays → permissions (412) → roles (8 system) → role_permissions → users (bootstrap superadmin, forced password change; password from `BOOTSTRAP_ADMIN_PASSWORD` env, never logged) → branches/departments → units_of_measure → unit_conversions → chart_of_accounts (173 manifest rows) → dimensions/values → fiscal_years (+periods, incl. 13 rules) → tax_rates → accounting_document_types → numbering_sequences (per type/year) → price_lists (+base items empty) → system_settings → warehouses/zones/aisles/racks/shelves/bins/locations → packing stations/devices → carriers/services/zones/rates → sales_channels/accounts (without credentials; `price_list_id` set) → posting_rule_sets + posting_rules (validated) → approval_workflows/steps → reporting/dashboard defs → partition registry`. Each step uses an idempotent natural key and is skipped in production for sample-only data (master data required to boot always seeds). Seed must succeed twice with identical counts (`seed-twice` test).
