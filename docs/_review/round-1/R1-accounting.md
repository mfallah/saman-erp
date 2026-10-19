# R1 — Accounting, Treasury & Inventory Costing Review

**Reviewer:** independent domain reviewer (Iranian accounting / inventory costing / treasury)
**Scope:** `00-overview/README.md`, `01-architecture/ARCHITECTURE.md`, ADR-0007/0013/0014, `02-data-model/DATA-MODEL.md` (accounting, treasury, partners, pricing, inventory valuation, sales/returns, procurement, CoA seed), `03-api-contract/API.md` §4.4/§4.9/§4.11–4.13, and source requirements (`carexy-doc.txt` §3-5, AMS §1; `project-doc.txt` §63–83).
**Basis:** Iranian double-entry practice, standard 8 (inventory), VAT/مؤدیان realities, and the project's own invariants (G5, ADR-0007, ADR-0013).

> This review is about whether the specified books can be *correct and auditable*, not whether the schema is elegant. Findings below are ordered by whether they can produce wrong money or non-compliant books.

---

## Blockers

### B-01 — Sale posting omits output VAT and recognises COGS at the wrong event
- **Evidence:** `DATA-MODEL §6.10` `SALE-ON-CREDIT`: debit `gross_amount`, credit `net_amount`; no VAT-payable leg. `SALE-ON-PAYMENT` is only Dr bank / Cr receivable, so a payment-only cash sale never recognises revenue, VAT or COGS. `sales_order_lines.line_total_amount` includes `tax_amount` (`§2.9`), while `sales_orders.grand_total_amount = subtotal − discount + tax + shipping`. `inventory.issue.posted` is an allowed event (`§2.12`) but has no rule.
- **Wrong outcome:** If `gross_amount` includes VAT the entry is unbalanced by the VAT amount; if it does not, output VAT is understated. Revenue/AR are wrong, and COGS is posted when the invoice is issued rather than when stock is issued. A payment-only cash sale shows bank/AR movement with no revenue at all.
- **Exact fix:** Define the sale event payload as `net`, `discount`, `tax`, `shipping`, `gross` and post: **Dr AR (gross) / Cr sales revenue (net) / Cr VAT payable (tax) / Cr shipping revenue (if recharged)**; post **Dr COGS / Cr inventory at stock issue**, not at invoice. Route cash sales through invoice → payment, or add an explicit `sales.cash_sale` rule. Add tests for taxable, exempt/zero-rated, discounted and tax-inclusive cases.

### B-02 — Purchase receipt credits AP directly; no GRNI and no supplier-invoice posting
- **Evidence:** `DATA-MODEL §6.10` `PURCHASE-ON-RECEIPT`: Dr inventory / Cr supplier payable at goods receipt. `purchase.invoice.received` exists in the event enum (`§2.12`) but has no seeded rule, while `supplier_invoices.journal_entry_id` exists (`§2.7`). `goods_receipt_lines.tax_amount` exists but is ignored by the rule.
- **Wrong outcome:** AP is recognised before the invoice; the later invoice either duplicates AP or is never posted; input VAT is missing; PO/receipt/invoice price differences have no account; goods received not invoiced cannot be reconciled at period end.
- **Exact fix:** At receipt: **Dr inventory (net landed cost) + Dr VAT receivable (only when a valid tax invoice exists) / Cr GRNI (goods received not invoiced)**. At supplier invoice: **Dr GRNI + Dr VAT receivable + Dr/Cr purchase-price variance / Cr AP**. Add a 3-way-match status and a GRNI aging report.

### B-03 — Settlement re-recognises revenue and double-counts channel receivable
- **Evidence:** `DATA-MODEL §6.10` `SETTLEMENT`: Dr channel receivable / Cr sales revenue; fee legs “per SALE-FEE”. `channel_settlements` already contains `gross_sales_amount`, `commission_amount`, `fee_amount`, `return_amount`, `tax_amount`, `net_payable_amount` (`§2.14`).
- **Wrong outcome:** Revenue and channel receivable are recognised twice (once at invoice, once at settlement); fees are not netted against the receivable; returns, penalties and VAT in the settlement are ignored. Channel profit is overstated.
- **Exact fix:** Recognise revenue only at sale: **Dr channel receivable / Cr revenue + VAT**. At settlement: **Dr settlement clearing/bank + Dr commission/fee expense (+ Dr VAT on fee, if recoverable) + Dr penalty/return adjustments / Cr channel receivable**; post any residual to a settlement-variance account. Never credit sales revenue at settlement.

### B-04 — Contra accounts have no explicit normal balance; returns/discounts and accumulated depreciation will have the wrong sign
- **Evidence:** `DATA-MODEL §2.12` requires `account_type`, `normal_balance` and `nature` (`operational|contra|suspense|control`), but the CoA seed (`§6.3`) gives only codes/names for L3/L4 and says type/normal balance is “shown per level-3/4 row” without showing it. `4-1-02` (برگشت از فروش), `4-1-03` (تخفیفات فروش), `1-2-02` (استهلاک انباشته), `1-1-03-003` (ذخیره مطالبات مشکوک‌الوصول) and `3-1-02` (سرمایه پرداخت‌نشده) are contra accounts.
- **Wrong outcome:** If a seed derives `normal_balance` from `account_type`, returns and discounts *increase* income, accumulated depreciation *increases* assets, and the allowance for doubtful debts increases receivables. Trial balance may still balance, but P&L and balance sheet are materially wrong.
- **Exact fix:** Seed explicit `account_type`, `normal_balance` and `nature='contra'` for every contra row; make reports derive signs from `normal_balance`, not from `account_type`; add a CI test that each contra row’s normal balance is opposite its natural side.

### B-05 — CoA seed is internally inconsistent and posting rules point at accounts that do not exist
- **Evidence:** `DATA-MODEL §6.3` claims 129 rows (`5+10+38+62+8+6`), but the L3 list contains 39 rows plus 9 continuation rows (`5-2-02`…`5-2-10`) = 48, not 38. There is no L4 child for `5-2-06` depreciation, `5-2-07` financial/bank charges, `5-2-08` income tax, `5-2-09` rent or `5-2-10` other; `5-1-02` is named “کسری و ضایعات” but its only L4 is “کسری انبار” (no waste/damage). `§6.10` uses `1-1-08-00x`, `4-1-01-00x` and `5-2-03-00x`, which are not real account codes.
- **Wrong outcome:** The seed cannot match its own count; postable operating-expense accounts are missing; posting rules either fail or are implemented with wildcard logic that can pick the wrong channel/expense account. The resulting CoA is not a complete legal ledger.
- **Exact fix:** Publish an exact CoA manifest (code, name, type, normal balance, nature, postable) and assert its count in CI. Add explicit L4 accounts for depreciation, bank charges, income tax, rent, other expense, waste/damage, GRNI, settlement clearing, withholding tax and channel-specific receivables. Replace every `00x` with an explicit account or an account-resolver key.

### B-06 — `inventory_balances` permits negative `available`
- **Evidence:** `DATA-MODEL §2.6` defines `available = on_hand − reserved − safety_buffer − damaged`; the only relevant checks are `reserved <= on_hand` and `damaged <= on_hand`. There is no check that `reserved + safety_buffer + damaged <= on_hand`. ADR-0007 §4 says channels receive `available` and allocation must never oversell.
- **Wrong outcome:** Example: on_hand = 10, reserved = 10, damaged = 0, safety_buffer = 5 → `available = −5`. Every component passes its CHECK, but the channel is told “−5” or the service may clamp it, and allocation tests can pass while the availability invariant is broken.
- **Exact fix:** Add `CHECK (reserved + safety_buffer + damaged <= on_hand)` and assert `available >= 0` in the allocation service. Add the 100-parallel-allocator test with non-zero safety buffers and damaged stock.

### B-07 — FIFO/average-cost model is not a cost-layer ledger and cannot support returns, transfers or reversals
- **Evidence:** `DATA-MODEL §2.6` `inventory_lots` is unique on `(warehouse_id, variant_id, lot_no)`, so two receipts with the same supplier lot number merge into one layer. The FIFO order uses `received_at`, but `inventory_lots` has no `received_at` column. There is no layer-consumption table; `inventory_transactions` has one `unit_cost_amount` and no lot/layer detail. ADR-0007 §6 says “FIFO layers (`inventory_lots.cost_remaining`) or moving average per `(variant, warehouse)`”, but the schema has no per-warehouse moving-average balance; `product_cost_history.avg_cost_amount` is per variant only (`§2.4`).
- **Wrong outcome:** FIFO COGS is wrong whenever a lot number repeats; a sale spanning layers is recorded at one blended unit cost with no audit trail; a return cannot restore the exact layers that were consumed; a transfer cannot move a layer to another warehouse; a reversal cannot restore layer quantities/costs. GL inventory and the physical/ledger inventory drift.
- **Exact fix:** Introduce append-only `inventory_cost_layers` (one row per receipt line, with `received_at`, `qty_received`, `qty_remaining`, `unit_cost`, `cost_remaining`) and `inventory_layer_consumptions` (issue line ↔ layer, qty, cost). Keep `inventory_lots` as physical batch metadata only. Add `inventory_average_costs` per `(warehouse_id, variant_id)` with the moving-average state. Link return/transfer lines to the original layer(s). Reconcile `Σ layer value = GL inventory` nightly.

### B-08 — No closing-entry or opening-balance design; a fiscal year can close with P&L accounts still open
- **Evidence:** `DATA-MODEL §2.12` has `fiscal_years.retained_earnings_entry_id` and `journal_entries.entry_type='closing'`, but specifies no closing run, no income-summary account, no legal-reserve appropriation and no opening-entry generation. `API §4.11` close only checks “no open periods, no unposted journals”. `PROFIT-DIST` debits `3-2-04` (current-period profit) before any closing entry exists.
- **Wrong outcome:** Revenue and expense accounts carry balances into the next year; retained earnings/current profit are wrong; the balance sheet does not balance; profit distribution can be approved against an unclosed, unaudited profit figure.
- **Exact fix:** Define a closing service: close revenue/expense to an income-summary account, transfer net profit/loss to retained earnings (`3-2-01`), appropriate legal reserve (`3-2-02`, 5% of net profit until 10% of capital, configurable), then allow distribution from retained earnings only. Generate next-year opening entries for all balance-sheet accounts and block `fiscal_year.close` until the closing run posts. Add an open-balance import path for migration.

### B-09 — Journal period is not tied to the journal date; fiscal years and periods can overlap
- **Evidence:** `DATA-MODEL §2.12` `journal_entries` stores both `entry_date` and `period_id`/`fiscal_year_id` with no constraint that the date lies in the period or that the period belongs to the fiscal year. `fiscal_years` has `UQ (organization_id, start_date, end_date)` (only identical ranges), not an overlap exclusion. `accounting_periods` has `UQ (fiscal_year_id, start_date)` but no end-date/range exclusion. `period_no` is checked `1..12` while the comment says a 13th adjustment period is allowed.
- **Wrong outcome:** A journal dated in a closed period can be posted into an open period; two fiscal years/periods can overlap, so “which period owns this date?” is ambiguous; the 13th adjustment period is rejected by the CHECK. Trial balance by period and statutory period reports are unreliable.
- **Exact fix:** Add `EXCLUDE USING gist` range constraints on fiscal years and periods; a trigger/composite FK that derives `period_id` from `entry_date` and verifies `fiscal_year_id`; allow `period_no <= 13` with explicit rules for period 13; reject posting if either the derived period or the supplied period is closed/locked.

### B-10 — The posting-rule schema cannot express the rules the seed describes
- **Evidence:** `DATA-MODEL §2.12` `posting_rule_lines` has a fixed `account_id`, fixed `side`, one `amount_expression` and only `dimension_rule_json`; there is no condition, no account resolver, no multi-entry grouping and no rule-level balance check. `§6.10` then describes a “second pair” (COGS), “or credit if gain” (stock gain), and channel-specific `00x` accounts. It says “8 rules” but the table lists 15, and `purchase.invoice.received`, `inventory.issue.posted` and `inventory.valuation.posted` have no rule.
- **Wrong outcome:** The engine cannot post a sale with revenue + VAT + COGS, cannot flip sides for stock gains, cannot select a channel-specific account, and cannot split one event into multiple journals. Implementers will either hard-code the logic (contradicting “data-driven”) or ship incomplete auto-posting.
- **Exact fix:** Either (a) replace the rule table with a versioned DSL supporting conditions, account resolvers, multiple entries per event and a mandatory balanced-rule validator, or (b) explicitly make posting services code-owned and keep `posting_rules` only for simple, fixed two-leg rules. In either case, seed and test every event in the matrix below; add `rule_version_id` to journals.

### B-11 — Returns and refunds cannot produce a VAT credit note; output VAT is overstated
- **Evidence:** `DATA-MODEL §2.9` `return_lines` has `refund_amount` but no `tax_rate_id`, `tax_amount` or net amount. `tax_documents.document_type` (`§2.12`) has `sales_vat|purchase_vat|vat_return|withholding|export_summary` but no credit-note/return type. `§6.10` `REFUND` has no VAT leg. `customer_invoices.tax_document_id` is a single link.
- **Wrong outcome:** A returned sale reduces revenue/AR but not output VAT; the business overpays VAT and cannot issue a legally correct credit note (اصلاحی/برگشت). Partial returns cannot be tied to the original invoice’s tax rate.
- **Exact fix:** Add net/tax/gross fields and a tax-rate snapshot to `return_lines`; add `sales_return_vat`/`credit_note` tax-document types and a link to the original invoice; post **Dr sales returns (net) + Dr VAT payable (tax) / Cr AR or customer credit/refund payable**; issue the credit note in the same transaction as the return receipt.

### B-12 — Invoice arithmetic is not well-defined for fractional quantities and double-counts tax
- **Evidence:** `DATA-MODEL §2.9` `sales_order_lines` CHECK is `line_total_amount = quantity * unit_price_amount − discount_amount + tax_amount`, where `quantity` is `numeric(18,4)` and `unit_price_amount`/`line_total_amount` are `bigint`. The doc admits “may require rounding” but says the CHECK is exact. `sales_orders.grand_total_amount = subtotal − discount + tax + shipping`, while line totals already include tax. The same pattern exists on purchase/customer invoice lines. ADR-0013 says round only at invoice line/tax/settlement but defines no algorithm or remainder account.
- **Wrong outcome:** A line with quantity `1.5` and price `100` produces `150` (ok), but `1.3333 × 100` produces a fraction that can never equal a `bigint`, so the insert fails. If the service rounds the line total, the header may add tax again, double-counting it. Multi-line invoices cannot distribute a header discount or rounding remainder deterministically.
- **Exact fix:** Store separate `net_amount`, `tax_amount` and `gross_amount` per line, all `bigint`. Define `net = round_half_up(qty × unit_price) − discount`, `tax = round_half_up(net × rate)`, `gross = net + tax`. Header `subtotal = Σ net`, `tax = Σ tax`, `grand = subtotal − header_discount + tax + shipping`; distribute header discount/rounding by largest-remainder and post the residual to a rounding account. Add property tests for fractional quantities and 0/1/2-decimal rates.

### B-13 — Cheque lifecycle is incomplete and the bounce rule is wrong after clearing
- **Evidence:** `DATA-MODEL §2.13` statuses are `received|in_custody|deposited|cleared|bounced|endorsed|returned|cancelled`; there is no `issued` status, yet `direction` includes `issued` and the default status is `received`. `endorsedTo` is accepted by `API §4.12` but there is no `endorsed_to` column. `§6.10` has no rule for deposit, endorsement or issued cheques; `CHEQUE-BOUNCED` is Dr AR / Cr cheque receivable even after the cheque has been cleared and the bank has been debited.
- **Wrong outcome:** An issued cheque is recorded as “received”; a deposited cheque never moves from “cheque on hand” to “cheque in collection”; an endorsed cheque has no payee and no liability; a post-clear bounce debits a zero cheque-receivable account instead of reversing the bank, so cash and AR are both wrong.
- **Exact fix:** Add `issued`, `in_custody`, `deposited`, `cleared`, `bounced`, `endorsed`, `returned`, `cancelled` as a proper state machine per direction, with allowed transitions. Add `endorsed_to`, `endorsement_date`, `bank_account_id` at deposit, `cleared_bank_transaction_id`. Post: receipt Dr cheques on hand / Cr AR; deposit Dr cheques in collection / Cr cheques on hand; clear Dr bank / Cr cheques in collection; bounce before clear Dr AR / Cr cheques on hand/collection; bounce after clear Dr AR / Cr bank; endorsement Dr AP / Cr cheques on hand (plus a guarantee memo); issued Dr AP / Cr cheques payable; issued cleared Dr cheques payable / Cr bank.

### B-14 — Payments, advances and clearing accounts are not modeled; allocations can exceed the payment
- **Evidence:** `DATA-MODEL §2.13` `payments` has no `unapplied_amount`, no advance/credit balance and no `purchase_order_id`; `payment_allocations.document_type` has no `sales_order`/`purchase_order`, and there is no CHECK that `Σ allocations <= payment.amount`. `payment_methods` has no `gl_account_id` although `API §4.12` accepts one. There are no gateway/POS/COD clearing accounts in the CoA. `cash_transactions` has no `session_id`.
- **Wrong outcome:** Customer overpayments and supplier prepayments are either forced into AR/AP or lost; a payment can be allocated beyond its amount; gateway receipts hit bank before settlement; cash cannot be reconciled by shift. AR/AP and cash are misstated.
- **Exact fix:** Add `unapplied_amount`/`customer_credit` and `supplier_prepayment` handling; allow allocation to orders and advances; enforce `Σ allocations <= amount` and `allocated + unapplied = amount` in the DB/service; add `gl_account_id` to payment methods and explicit clearing accounts for gateway/POS/COD; add `cash_sessions` with opening/closing/count/variance and link `cash_transactions.session_id`.

### B-15 — API surfaces have no corresponding tables: cash sessions, bank statements and partner master
- **Evidence:** `API §4.12` exposes `/treasury/cash-sessions`, `/treasury/bank-accounts/{id}/statement-imports`, `/treasury/bank-statements/{id}` and `statementId`; `API §4.13` exposes `/partners` CRUD with `type`, `profitSharePercent`, `glAccountId`. `DATA-MODEL §2.13` has 11 treasury tables but no `cash_sessions` or `bank_statements`; `§2.14` has no `partners` table at all (only shareholders and partner_accounts). Source `project-doc §77` explicitly requires `partners`, `partner_shares`, `partner_capital`, `partner_current_accounts`.
- **Wrong outcome:** The API contract cannot be implemented without inventing schema; cash reconciliation and shareholder/partner capital tracking are not auditable; “partner” is overloaded between `shareholders`, `partner_accounts` and API `partners`.
- **Exact fix:** Add `treasury.cash_sessions` (open/close, counted, variance, user), `treasury.bank_statements`/`bank_statement_lines` (import batch, opening/closing, status), and `partners.partners` + `partner_shares` + `partner_capital`/`partner_current_accounts` (or explicitly map API partner to shareholder and drop the generic endpoint). Link `bank_reconciliations` to `statement_id` and `period_id`.

### B-16 — Inventory and accounting can diverge when a period is closed
- **Evidence:** `inventory_transactions` has `business_date` but no `period_id` (`§2.6`); `goods_receipts` posts inventory and stores `journal_entry_id` (`§2.7`); period lock is enforced only in accounting (`§2.12`, ADR-0014). There is no shared “posting guard” that checks the accounting period before writing the ledger. `inventory.issue.posted` has no rule.
- **Wrong outcome:** A receipt/issue can commit to the inventory ledger while its journal fails with `PERIOD_CLOSED`; inventory on hand and GL inventory diverge, and the nightly consistency job will report drift that cannot be repaired without a manual journal.
- **Fix:** Resolve the accounting period and lock it (`FOR SHARE`) before any inventory write; write ledger, balance, journal and outbox in one transaction; reject the whole operation if the period is closed. Add a reconciliation test that tries to receive into a closed period and asserts zero ledger rows.

---

## High

### H-01 — The “6-level” CoA does not match the source’s six levels, and party detail accounts are missing
- **Evidence:** Source `carexy-doc §3-5-1` defines levels as group → subgroup → کل → معین → تفصیلی → cost center. `DATA-MODEL §6.3` defines group → کل → معین → تفصیلی → cost center → project. Customer/supplier/shareholder detail is not a CoA node; it is a polymorphic `journal_lines.partner_type/partner_id` (`§2.12`).
- **Wrong outcome:** If the statutory ledger requires a تفصیلی account per customer/supplier/partner, the books cannot produce it directly; subledger reports depend on a polymorphic field with no FK and no per-party account code. The claimed six-level structure is a different model from the source.
- **Exact fix:** Either align to the source (L4 معین, L5 تفصیلی per party, L6 cost center) or explicitly document the chosen 4+2 analytical model and add a per-party detail account/code table that reconciles to the AR/AP control accounts. Do not call both “the Iranian 6-level structure” without a mapping table.

### H-02 — Valuation method can be overridden per variant, but the run is one method per warehouse/date; no change policy
- **Evidence:** `org.organizations.valuation_method` and `system_settings.inventory.valuation_method` (`§2.3`, `§6.10`), `product_variants.cost_method` can be `inherit|moving_average|fifo` (`§2.4`), and `inventory_valuation_runs` has one `valuation_method` per `(org, warehouse, date)` (`§2.6`). There is no policy for changing method.
- **Wrong outcome:** A warehouse run cannot contain both FIFO and moving-average variants; the report either ignores the variant override or silently values some variants with the wrong method. Changing the method has no prospective/retrospective rule and no restatement, so comparability and audits break.
- **Exact fix:** Make method a valuation-policy dimension per variant and allow a run to group by method, or remove per-variant overrides in v1. Define method-change policy (prospective from a date, approval, recompute opening layers/average, disclose the effect) and store the policy version on the run.

### H-03 — Backdated receipts/issues are allowed without cutoff, restatement or layer ordering rule
- **Evidence:** `inventory_transactions.business_date` defaults to `current_date` and can be any date; FIFO layers are created at posting time; `inventory_lots` has no `received_at`/business date column (`§2.6`). No job revalues issues that occurred before a backdated receipt.
- **Wrong outcome:** A receipt dated last month but posted today creates a layer after sales already consumed older layers, so COGS for the earlier period is wrong and inventory value at period end is wrong. Two reports of the same historical date disagree.
- **Fix:** Store `received_at`/`business_date` on layers; reject backdated receipts before the last posted issue/valuation unless an explicit revaluation run is approved; revalue affected issues and post the delta to COGS/inventory; lock inventory periods together with accounting periods.

### H-04 — Transfers have no accounting and no ledger-backed in-transit state
- **Evidence:** `inventory_transfers` has no `journal_entry_id` (`§2.6`); `inventory_balances.in_transit` exists but there is no `transfer_in_transit` ledger type; `inventory_transfer_lines` has one `lot_id` and no destination layer; `inventory_transactions` types only `transfer_out|transfer_in`.
- **Wrong outcome:** Dispatch reduces source on-hand but does not record an in-transit asset; receive increases destination without a corresponding relief; the `in_transit` projection cannot reconcile to `Σ ledger`; FIFO layers cannot move between warehouses.
- **Fix:** Add `transfer_out` (Dr inventory in transit / Cr inventory source) and `transfer_in` (Dr inventory destination / Cr inventory in transit), with a transfer clearing account, destination layer creation and partial-receipt handling. Include in-transit in the nightly ledger-vs-balance check.

### H-05 — Stock adjustments can relieve inventory at zero cost; damage/waste/gain are not separated
- **Evidence:** `stock_adjustment_lines.unit_cost_amount` defaults to 0 and is optional (`§2.6`); `5-1-02` is “کسری و ضایعات” but its only L4 is “کسری انبار”; `INVENTORY-ADJ` flips sides in prose but the rule schema cannot (`§6.10`).
- **Wrong outcome:** A write-off of 100 units at cost 1,000,000 can post Dr shrinkage 0 / Cr inventory 0, leaving inventory overstated and loss understated; damaged/expired/scrap goods are all booked to “shortage”; stock gains are credited to an expense with no separate gain disclosure.
- **Fix:** Require valuation cost from the layer/average at the adjustment date; add separate L4 accounts for damage, expiry, scrap, theft/loss, count shortage and count gain; post loss and gain as separate events; add approval thresholds and a cost-gated adjustment API.

### H-06 — Supplier invoice 3-way match, duplicate control and price/quantity variance are absent
- **Evidence:** `supplier_invoices` has `purchase_order_id` and lines link to `goods_receipt_lines` (`§2.7`), but there is no match status, matched quantity, price variance, tolerance or duplicate-invoice check beyond `(supplier_id, invoice_no)`. `PURCHASE-ON-RECEIPT` already credits AP.
- **Wrong outcome:** The same receipt can be invoiced twice under different supplier invoice numbers; over-invoicing and short-delivery are not detected; price differences are buried in AP/inventory; GRNI cannot be cleared.
- **Fix:** Add `supplier_invoice_matches` (invoice line ↔ receipt line, matched qty/amount, tolerance, status), a duplicate check on supplier + invoice no + amount/date, variance accounts (price/quantity), and a hard block on posting an unmatched invoice above tolerance.

### H-07 — Tax rates have no GL mapping; fee VAT, expense VAT and withholding cannot be posted correctly
- **Evidence:** `tax_rates` (`§2.12`) has no `input_account_id`/`output_account_id`/`payable_account_id`; posting rules hard-code `1-1-06-001` and `2-1-05-001`. `channel_fee_rules` has `vat_on_fee` (`§2.8`) but no tax rate/amount; `expenses` has `tax_amount` but no `tax_rate_id` (`§2.12`); there is no withholding-tax payable L4.
- **Wrong outcome:** Exempt, zero-rated, 9%/10% and withholding rates all post to the same VAT accounts; fee VAT is ignored; expense input VAT cannot be separated; withholding tax has no liability account. VAT returns and supplier/customer tax reconciliation are wrong.
- **Fix:** Add tax-account mapping per tax rate/type (input VAT, output VAT, withholding payable, VAT receivable/refundable); store `tax_rate_id` and `tax_amount` on expense/fee lines; post fee VAT and expense input VAT explicitly; add a withholding-tax payable account and a certificate/return report.

### H-08 — Customer invoices lack the legal seller/buyer snapshot and credit-note structure required for Iranian tax invoices
- **Evidence:** `customer_invoices` (`§2.9`) has `buyer_name`, `buyer_national_id`, `buyer_economic_code`, but no seller legal name/economic code/national ID snapshot, no invoice type (normal/return/credit), no per-rate tax breakdown at header, no `tax_id` validation. `tax_documents` has only one `tax_amount` header (`§2.12`).
- **Wrong outcome:** Re-printing an old invoice after the organization’s legal details change produces a non-compliant invoice; B2B invoices can lack the buyer’s economic code; credit notes cannot reference the original invoice correctly; VAT audit trails are incomplete.
- **Fix:** Snapshot seller and buyer legal identifiers on the invoice; add `invoice_type` and `original_invoice_id`; store tax breakdown by rate (taxable, rate, tax) on the invoice/tax document; validate Iranian national ID/economic code formats; include the tax ID in the printed/exported invoice.

### H-09 — Profit distribution omits legal reserve, withholding, loss offset and rounding; ownership can be inconsistent
- **Evidence:** `profit_distribution_runs`/`lines` (`§2.14`) only have `total_profit_amount`, `ownership_percent_snapshot` and `share_amount`; no legal reserve, withholding tax, accumulated-loss offset, dividend payment link or remainder distribution. `shareholders.ownership_percent` has no sum-to-100 constraint (`§2.14`); `shareholder_transactions` has no effective-dated share history. `PROFIT-DIST` debits current profit before closing (`§6.10`).
- **Wrong outcome:** Distributing 100% of profit without the 5% legal reserve is illegal under the Iranian Commercial Code; dividend withholding (where applicable) is not withheld; losses are not offset; rounding can leave the sum of shares ≠ total profit; ownership can total 90% or 110%; a distribution can be posted before the year is closed.
- **Fix:** Build a distribution policy: close the year first, offset accumulated losses, appropriate legal reserve (5% until 10% of capital, configurable), apply withholding tax by shareholder type, distribute the remainder by largest-remainder so the sum equals the distributable amount, and link each line to a dividend payment. Enforce ownership sum = 100% and keep effective-dated share history.

### H-10 — Partner capital/current/profit accounts are not separable; customer credit/advance accounts are missing
- **Evidence:** `partner_accounts` (`§2.14`) has `partner_type`, `partner_id`, `account_id`, `opening_balance_amount`, `current_balance_amount` but no `account_type` (capital/current/profit), while `API §4.13` requires `type: "capital"|"current"|"profit"`. Source `project-doc §77–78` requires separate `partner_capital`, `partner_current_accounts`, drawings and loans. `customers` has no account/credit/transaction table; only `total_spent_amount`.
- **Wrong outcome:** Capital, current account, drawings, loans and profit share are mixed in one balance; a partner’s capital cannot be reconciled to the capital account; customer overpayments/credits have no home. Partner statements and equity notes are wrong.
- **Fix:** Add `account_type` to partner accounts (or separate `partner_capital`/`partner_current_accounts` tables); link shareholder transactions to the specific partner account and payment; add customer accounts/credit/transactions (or explicitly use AR subledger with `unapplied_amount`) and post advances to the seeded prepayment/customer-credit accounts.

### H-11 — Posted journals and posted inventory documents can be voided without a reversal
- **Evidence:** `journal_entries` has `voided_at`/`void_reason` and status `voided` (`§2.12`), but no constraint that a posted entry must have a reversal; `API §4.11` exposes reverse but also a `void` permission. `goods_receipts` has status `cancelled` but no `voided_at`/`reversal_of_id`; `stock_adjustments` has `voided` status but no reversal link (`§2.6`).
- **Wrong outcome:** A posted journal can be marked void without reversing `account_balances`, leaving the ledger and trial balance inconsistent; a posted receipt can be cancelled while its inventory/journal remain; the audit trail cannot prove which entry reversed which.
- **Fix:** Make posted documents immutable except through a reversal service; add `reversal_entry_id`/`reversal_of_id` on every posted document; forbid `voided` on a posted journal unless a posted reversal exists; add DB triggers/tests; log reopen/reversal events.

### H-12 — Journal header totals can disagree with journal lines
- **Evidence:** `journal_entries` has `total_debit_amount`/`total_credit_amount` with `ck_journal_entries_balanced`, but the deferred trigger is described as checking “entry totals” on line insert/update (`§2.12`); it is not specified to recompute the header. A header can be inserted with 0/0 and lines with 100/100; the CK passes.
- **Wrong outcome:** Reports that use header totals (journal book, daily totals, reconciliation) show zero or stale amounts while the GL lines are correct; auditors cannot rely on the document header.
- **Fix:** Recompute header totals from lines in the deferred trigger (or a service) and enforce `total_debit = total_credit = Σ lines`; add a DB check/trigger and a test that tries to insert mismatched headers.

### H-13 — `account_balances` supports only one dimension value per account/period; multi-dimension reports will double-count or miss amounts
- **Evidence:** `account_balances` has a single `dimension_value_id` and unique `(period, account, dimension_value_id)` (`§2.12`), while `journal_line_dimensions` allows one row per dimension per line (cost center, project, channel, partner). A line can carry several dimensions.
- **Wrong outcome:** To reflect a line with cost center + project + channel, the posting service must either write multiple balance rows (then summing by account double-counts) or pick one dimension (then other reports are incomplete). Channel/cost-center P&L and balance sheet slices are wrong.
- **Fix:** Either derive dimension reports from `journal_lines`/`journal_line_dimensions` and keep `account_balances` only for account totals, or key balances by a dimension-set/hash and define non-additive reporting rules. Add a test with a line carrying three dimensions.

### H-14 — Landed cost, customs/duty and inbound freight are not capitalised into inventory
- **Evidence:** `purchase_orders` has `shipping_amount` and `tax_amount` (`§2.7`), `goods_receipt_lines` has only `unit_cost_amount`/`tax_amount`; there is no landed-cost document or allocation. `SHIPPING-COST` expenses shipping (`§6.10`); `product_cost_history` claims “purchase/landed cost history” but has no component fields (`§2.4`).
- **Wrong outcome:** Imported goods are valued below cost; freight/duty/customs are expensed immediately; COGS and inventory are understated; margin by channel/product is overstated.
- **Fix:** Add `landed_cost_documents`/`landed_cost_allocations` (freight, duty, customs, insurance, clearing) allocated by quantity/value/weight to receipt lines/layers; capitalise to inventory and COGS; add clearing accounts for unpaid landed costs; expose the components in cost history.

---

## Medium

### M-01 — Fiscal-year/period overlap and the 13th period
- **Evidence:** `fiscal_years` unique only on the exact `(start_date,end_date)`; `accounting_periods` unique only on `(fiscal_year_id,start_date)`; `period_no` CHECK `1..12` while the text allows 13 (`§2.12`). **Outcome:** overlapping years/periods; 13th period rejected. **Fix:** range exclusion constraints, `period_no <= 13`, explicit period-13 rules, and a calendar-generation test for Jalali leap years.

### M-02 — Tax-rate windows can overlap and the default rate is not constrained to VAT
- **Evidence:** `tax_rates` has `effective_from/to` but no exclusion constraint and no check that `is_default` is a VAT rate (`§2.12`); API uses `rate`, while the model uses `rate_percent` with 0.10 = 10% (`API §4.11`). **Outcome:** two rates valid on the same date; a withholding rate can become the default sales tax; clients sending `10` are rejected or misread. **Fix:** exclusion constraint by org/type, default-rate check, and an explicit “rate as decimal fraction” contract/test.

### M-03 — CoA parent/level integrity is not enforced
- **Evidence:** `chart_of_accounts.parent_id` has no constraint that the parent belongs to the same organization or is exactly one level above; only `code_depth = account_level` and no self-parent (`§2.12`). **Outcome:** cross-org or skipped-level trees; reports roll up incorrectly. **Fix:** composite FK `(organization_id,parent_id)`, trigger checking `parent.account_level = child.account_level − 1`, and a tree-integrity test.

### M-04 — AR/AP/inventory control accounts are not reconciled to subledgers
- **Evidence:** Journal lines use polymorphic `partner_type/partner_id` with no FK (`§2.12`); `partner_accounts` has a CoA link but no nightly reconciliation spec beyond a passing mention; no `customer_accounts`/`supplier_accounts` subledger. **Outcome:** control account balance ≠ sum of customer/supplier/partner balances; receivables aging and partner statements disagree with the GL. **Fix:** define control-account nature, per-party subledger tables/views, and a nightly reconciliation with an exception queue.

### M-05 — FIFO lot ordering references a nonexistent column and mixes FEFO with FIFO
- **Evidence:** `inventory_lots` has no `received_at`; FIFO allocation says `ORDER BY expiry_date NULLS LAST, received_at` (`§2.6`); ADR-0007 §6 says FIFO, not FEFO. **Outcome:** query fails or uses `created_at` implicitly; expiry-first ordering is FEFO and can produce a different COGS than the declared FIFO policy. **Fix:** add `received_at`/`business_date`; make FEFO an explicit per-variant policy with its own disclosure; test layer order.

### M-06 — Lot cost/quantity residual is not constrained
- **Evidence:** `inventory_lots` CHECK only `qty_remaining <= qty_received` and `cost_remaining_amount <= unit_cost * qty_received` (`§2.6`); no equality or rounding rule. **Outcome:** a lot can have zero quantity but positive remaining cost (or vice versa), so inventory value and quantity diverge. **Fix:** require `cost_remaining = round(qty_remaining × unit_cost)` within a defined tolerance, and write off the residual on depletion.

### M-07 — Inventory transaction cost fields are optional/unchecked
- **Evidence:** `inventory_transactions.unit_cost_amount` is nullable; `total_cost_amount` is “qty × unit_cost rounded” but has no CHECK (`§2.6`). **Outcome:** issues/write-offs can post with null/zero cost; `total_cost` can disagree with qty × unit cost. **Fix:** make cost mandatory for value-moving types, add CHECK/total recompute, and reject zero cost for stock issues.

### M-08 — Reservations have no consumption link
- **Evidence:** `stock_reservations` has `status` but no `consumed_transaction_id`/`consumed_at` link to the ledger (`§2.6`). **Outcome:** cannot prove which reservation became which issue; expiry/release and reserved balance can drift. **Fix:** add `consumed_inventory_transaction_id`, enforce one consumption, and reconcile active reservations to `reserved`.

### M-09 — Bank transaction direction check is tautological and statement import has no header
- **Evidence:** `ck_bank_transactions_direction` has the same `direction IN ('debit','credit')` on both sides (`§2.13`); `import_batch_id` is a varchar, no `bank_statements` table. **Outcome:** direction semantics are undocumented and unvalidated; imports cannot be audited or re-opened. **Fix:** define bank vs book perspective, constrain valid combos, add statement header/line tables and import batch status.

### M-10 — Reconciliation can match the same statement line twice and has no outstanding-items model
- **Evidence:** `bank_reconciliation_lines` unique only `(reconciliation_id, bank_transaction_id)` (`§2.13`); `bank_reconciliations` has no `statement_id`/`period_id`; no outstanding cheques/deposits-in-transit table. **Outcome:** the same line can be matched in two reconciliations; the reconciliation difference is unexplained; outstanding cheques are not reported. **Fix:** unique `(bank_transaction_id)` for active matches, link statement/period, add outstanding-items and a difference-explanation table.

### M-11 — Payment allocations lack DB-level sum/org constraints; refunds can exceed the return
- **Evidence:** `payment_allocations` has no `organization_id` and no sum check (`§2.13`); `refunds.amount` is independent of `return_lines.refund_amount` (`§2.9`). **Outcome:** allocation can exceed payment; a refund can exceed the returned value; cross-org document IDs can be linked. **Fix:** add org/composite FKs, `Σ allocations <= payment.amount`, `refund.amount <= Σ return line refund`, and service/DB tests.

### M-12 — Channel settlement net formula and paid amount are not enforced
- **Evidence:** `channel_settlements` has gross/commission/fee/return/tax/net but no CHECK that net equals the deduction formula and no `paid_amount`/payment link (`§2.14`); settlement lines have a signed-ambiguous `amount`. **Outcome:** a settlement can confirm with a net payable that does not reconcile to its lines; partial payments cannot be tracked. **Fix:** add a net-formula CHECK, line sign convention, `paid_amount`/`payment_id`, and a reconciliation tolerance.

### M-13 — Tax documents are not uniquely linked to invoices and lack a taxable-amount header
- **Evidence:** `tax_documents` has no unique `(document_type, party, invoice)` link and no header `taxable_amount`; only lines have taxable/tax (`§2.12`); `customer_invoices.tax_document_id` is a single nullable link. **Outcome:** duplicate tax documents per invoice; VAT return totals require ad-hoc summing; a reissued invoice can orphan the old tax document. **Fix:** add unique invoice/return link, header taxable amount, status transitions, and a one-active-document rule.

### M-14 — `entry_date` vs `business_date` is ambiguous and inventory has no period id
- **Evidence:** `journal_entries` has both dates with no rule which drives the period/report (`§2.12`); `inventory_transactions` has only `business_date` (`§2.6`). **Outcome:** legal date, posting date and report date can diverge; inventory movements cannot be grouped by accounting period. **Fix:** define `entry_date` as the legal/accounting date, `business_date` as the source document date, derive the period from `entry_date`, and add `period_id` (or a period guard) to inventory transactions.

### M-15 — Header and line discounts can double-count
- **Evidence:** `sales_orders` has `discount_amount` and lines also have `discount_amount`; `grand_total = subtotal − discount + tax` (`§2.9`); no rule says whether `subtotal` is before or after line discounts. **Outcome:** a line discount is deducted twice (once in the line, once in the header). **Fix:** define `subtotal = Σ net line after line discount`, header discount separate, and allocate header discount across lines for tax.

### M-16 — Cash variances have no dedicated account or session model
- **Evidence:** `API §4.12` cash-session close accepts `varianceAccountId?`, but the data model has no cash sessions and no cash-over/short account (`§2.13`); `cash_transactions.balance_after_amount` has a nonnegative CHECK. **Outcome:** cash shortages/overages cannot be posted consistently; the API’s variance account has no schema counterpart, and the nonnegative physical-cash check cannot represent the accounting variance. **Fix:** add cash sessions, a cash-over/short account, and post variance separately from the cash movement.

### M-17 — Reopen/close actions lack a dedicated audit trail
- **Evidence:** `fiscal_years`/`accounting_periods` store only `closed_at/closed_by`, no `reopened_at/by/reason` (`§2.12`); `API §4.11` allows reopen with a reason. **Outcome:** the reason and actor for a reopen are only in the generic audit log; period status history is lost. **Fix:** add a period-status history table or append-only events, and require a reason + approval for reopen.

### M-18 — Shareholder ownership sum and effective-dated history are not enforced
- **Evidence:** `shareholders.ownership_percent` has only a per-row range check (`§2.14`); `API §4.13` validates “sum > 100” only in the endpoint; `shareholder_transactions.share_count` is not an effective-dated ownership table. **Outcome:** ownership can total <100% or >100%; profit distribution uses an inconsistent base; ownership changes cannot be reconstructed. **Fix:** add a DB-level sum check/trigger per org, effective-dated `shareholder_ownership` rows, and a profit-run validation.

### M-19 — Loss distribution and negative profit are not handled
- **Evidence:** `profit_distribution_runs.total_profit_amount` may be negative (`§2.14`), but `distributed_amount` defaults to 0 and `profit_distribution_lines.share_amount`/`paid_amount` semantics for losses are undefined; `PROFIT-DIST` only describes a debit to current profit. **Outcome:** a loss year cannot be allocated to partners; the run may show zero distributed and leave the loss unallocated. **Fix:** define loss allocation to partner current accounts/retained earnings, separate `loss_share`, and prevent dividend payment in a loss year without approval.

### M-20 — Purchase returns/allowances and bad-debt write-offs have no rules/accounts
- **Evidence:** CoA has no purchase-return/allowance account (`§6.3`); `supplier_invoices` has `voided` but no return/credit-note document (`§2.7`); the allowance for doubtful debts account exists (`1-1-03-003`) but no posting rule/aging process (`§6.10`). **Outcome:** supplier returns/credits are booked as negative purchases without VAT reversal; doubtful debts are never provided/written off. **Fix:** add purchase-return/credit-note documents and accounts, VAT reversal, and a bad-debt allowance/write-off rule tied to aging.

### M-21 — No rounding/remainder account or distribution policy
- **Evidence:** ADR-0013 says round at invoice line/tax/settlement but defines no remainder distribution or residual account; `pricing` rounds to `nearest_1000` while accounting rounds to rial (`§2.8`, ADR-0013). **Outcome:** multi-line discounts/tax/settlement differences are plugged into an arbitrary line; P&L/receivables differ by a few rials per document; reconciliation breaks. **Fix:** define largest-remainder allocation, a rounding gain/loss account, and tests for 1/3/7-line invoices and percentage fees.

---

## Low

### L-01 — CoA code length may be insufficient for long cost-center/project codes
- **Evidence:** `chart_of_accounts.code` is `varchar(40)` (`§2.12`); L6 codes combine four segments plus cost center and project codes. **Outcome:** long project/cost-center codes truncate or fail. **Fix:** size to the maximum documented code or use numeric segment IDs with a display code.

### L-02 — API `rate` vs model `rate_percent` can be misread by 100×
- **Evidence:** `API §4.11` accepts `rate`, while `tax_rates.rate_percent` stores `0.100000` for 10% (`§2.12`). **Outcome:** a client sending `10` is rejected by the 0–1 check or, if coercion is loose, creates a 1000% rate. **Fix:** name the API field `ratePercent` or document/validate the decimal-fraction convention with examples.

### L-03 — Cheque event amounts are nullable
- **Evidence:** `cheque_events.amount` is nullable (`§2.13`). **Outcome:** partial endorsement/deposit events cannot be reconciled; event history totals may not equal the cheque amount. **Fix:** require amount for value-moving events and constrain `Σ events <= cheque.amount` for partial events.

### L-04 — `standard` cost appears in history but not in the org/variant enums
- **Evidence:** `product_cost_history.cost_method` allows `standard` (`§2.4`), while `organizations.valuation_method` and `product_variants.cost_method` allow only `moving_average|fifo` (`§2.3`, `§2.4`). **Outcome:** standard-cost rows cannot be produced by the configured method; reports see an unreachable method. **Fix:** remove `standard` from v1 or add it consistently with a revaluation policy.

### L-05 — Tax-document status uses the generic document vocabulary
- **Evidence:** `tax_documents.status` uses `document_status` (`draft|pending_approval|approved|posted|voided`) (`§2.12`), but the API issues/voids tax documents, not “posts” them. **Outcome:** ambiguous status semantics; a “posted” tax document may not mean issued to the tax authority. **Fix:** use `draft|issued|voided|replaced` for tax documents and document the transition.

### L-06 — `fiscal_years.retained_earnings_entry_id` is a single entry
- **Evidence:** one FK for retained earnings (`§2.12`), while closing may require income-summary, legal-reserve and distribution entries. **Outcome:** cannot link all closing/appropriation entries to the year. **Fix:** add a `fiscal_year_closing_runs` table with links to each closing/appropriation journal.

---

## Missing posting rules matrix

The following matrix is the minimum event set for the stated business. “Status” is against `DATA-MODEL §6.10` and `§2.12`.

| # | Event | Required debit | Required credit | Status |
|---|---|---|---|---|
| 1 | Credit sale invoice (taxable) | AR gross; COGS at issue | Sales revenue net; VAT payable; inventory | **Wrong** — no VAT leg, COGS at invoice |
| 2 | Cash sale | Cash/bank/clearing; COGS | Sales revenue; VAT payable; inventory | **Absent** — only AR collection exists |
| 3 | Sales discount / header discount | Sales discount (contra-revenue) or reduced revenue; VAT adjustment | AR | **Absent** — no allocation/tax treatment |
| 4 | Sales return (restock) | Sales returns; VAT payable; inventory at original cost | AR/customer credit; COGS | **Wrong** — no VAT, no original-layer cost |
| 5 | Sales return (scrap/damaged) | Sales returns; VAT payable; inventory loss (if owned) | AR/customer credit; inventory | **Absent** — no condition-specific rule |
| 6 | Refund of paid invoice | AR/customer credit or refund payable | Bank/cash | **Wrong/partial** — no link to return/VAT |
| 7 | Goods receipt (no invoice) | Inventory net landed cost | GRNI | **Wrong** — credits AP directly |
| 8 | Supplier invoice | GRNI; VAT receivable; price variance | AP | **Absent** — event exists, no rule |
| 9 | Purchase return/credit note | AP/GRNI; VAT receivable reversal | Inventory; price variance | **Absent** |
| 10 | Supplier payment | AP | Bank/cash | Present, but no allocation/advance handling |
| 11 | Supplier prepayment | Supplier prepayment | Bank/cash | **Absent** |
| 12 | Customer collection | Bank/cash/cheque on hand | AR | Present, but no unapplied/advance handling |
| 13 | Commission/fee accrual | Commission/fee expense; VAT on fee (if recoverable) | Fee payable/channel receivable | **Partial** — no VAT, no netting |
| 14 | Shipping cost | Shipping expense or inventory landed cost | Bank/AP | **Partial** — no recharge/landed-cost split |
| 15 | Shipping recharged to customer | AR | Shipping revenue; VAT (if taxable) | **Absent** |
| 16 | Stock loss/write-off | Shrinkage/damage/expiry loss at valuation cost | Inventory | **Partial** — cost optional, one shortage account |
| 17 | Stock gain | Inventory at valuation cost | Shrinkage gain/other income | **Wrong** — side flip not representable |
| 18 | Transfer dispatch | Inventory in transit | Inventory source | **Absent** |
| 19 | Transfer receive | Inventory destination | Inventory in transit | **Absent** |
| 20 | Cheque received | Cheques on hand | AR | Present |
| 21 | Cheque deposited | Cheques in collection | Cheques on hand | **Absent** |
| 22 | Cheque cleared | Bank | Cheques in collection | Present (but skips deposit) |
| 23 | Cheque bounced before clear | AR | Cheques on hand/collection | **Wrong** — uses cheque receivable after clear too |
| 24 | Cheque bounced after clear | AR; bank charges | Bank | **Absent** |
| 25 | Cheque endorsed | AP (or expense) | Cheques on hand | **Absent** |
| 26 | Cheque issued | AP | Cheques payable | **Absent** |
| 27 | Issued cheque cleared | Cheques payable | Bank | **Absent** |
| 28 | Channel settlement | Settlement clearing/bank; fee/commission/penalty/return; VAT on fee | Channel receivable | **Wrong** — credits sales again |
| 29 | Settlement variance | Settlement variance | Channel receivable (or reverse) | **Absent** |
| 30 | Profit distribution (appropriation) | Retained earnings | Legal reserve; dividends payable; withholding tax payable | **Wrong/partial** — debits current profit, no reserve/withholding |
| 31 | Dividend payment | Dividends payable | Bank | **Absent** |
| 32 | VAT payment/refund | VAT payable (payment) / bank (refund) | Bank / VAT receivable | **Absent** |
| 33 | Bad-debt allowance/write-off | Bad-debt expense/allowance | AR/allowance | **Absent** |
| 34 | Cash over/short | Cash (over) / cash-over-short (short) | Cash-over-short / cash | **Absent** |
| 35 | Opening balances | Each asset/expense | Each liability/equity/revenue; opening equity | **Absent** |
| 36 | Closing entries | Revenue; income summary | Income summary; expenses; retained earnings | **Absent** |
| 37 | FX gain/loss (future) | FX loss / asset | Asset / FX gain | **Absent** — v1 single currency, but schema has `fx_rate` |

---

## Verdict

**Not ready for implementation sign-off.** The architecture and most entity coverage are strong, but the accounting/treasury/costing specification has **16 blockers** that would produce unbalanced, understated or non-compliant books: missing VAT/COGS legs, AP recognised at receipt with no GRNI, settlement double-counting revenue, contra-account sign errors, an incomplete CoA with non-existent posting codes, a permissive inventory availability check, a FIFO model that is not a layer ledger, no closing/opening process, period/date integrity gaps, a posting-rule engine that cannot express its own seed, no VAT credit notes, ambiguous invoice arithmetic, an incomplete cheque lifecycle, and missing payment-advance/cash/bank-statement structures.

The highest-risk pattern is **internal contradiction**: the prose describes correct Iranian practice (GRNI-like accrual, VAT, FIFO, cheque lifecycle) while the schema and seed encode a simpler, wrong model. Implementers following the schema will build the wrong books; implementers following the prose will not have tables/columns to do it.

**Recommendation:** freeze feature work on accounting/treasury, fix B-01 through B-16 first (starting with B-01/B-02/B-03/B-04/B-05), publish an exact CoA + posting-rule manifest, and re-review with a test matrix that proves: every event balances; VAT is separately stated and reversible; inventory subledger = GL; no posting into a closed period; cheque/bank balances reconcile; and closing produces a balanced balance sheet.

---

*Reviewer’s note: this file is the only file written by this review; no project document was modified.*
