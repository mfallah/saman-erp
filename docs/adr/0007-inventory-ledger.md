# ADR-0007 — Inventory ledger & reservation concurrency

**Status:** Accepted · **Date:** 1405-07-27

## Context

Overselling is the #1 omnichannel failure. The supplied design has `inventory_balances` and `inventory_transactions` but no concurrency policy. Two simultaneous orders for the last unit must not both succeed. Physical stock must stay reconcilable with the accounting valuation. The spec also requires unit-level traceability only where needed (barcode ≠ physical identity).

## Decision

1. **Append-only ledger** `inventory_transactions` (one row per movement; type, qty signed, unit cost, source document, location, lot/serial). Never updated except `voided_at` metadata; corrections are new reversal rows.
2. **Balance projection** `inventory_balances` (unique `(warehouse_id, variant_id, location_id)`), maintained **in the same transaction** as the ledger insert by a domain service (not a DB trigger — trigger would hide business rules and break testability; the invariant is enforced by tests + `CHECK (on_hand >= 0 AND reserved >= 0 AND available >= 0)`).
3. **Reservation** `stock_reservations` rows (`active → consumed | released | expired`), created inside the allocation transaction:
   ```sql
   -- fixed lock order to avoid deadlock
   SELECT id, on_hand, reserved FROM inventory_balances
    WHERE warehouse_id = $1 AND variant_id = ANY($2)
    ORDER BY variant_id, location_id FOR UPDATE;
   ```
   Then: assert `available >= requested` for every line, insert reservations, `UPDATE balances SET reserved = reserved + qty`. **All-or-nothing per order.** On conflict → `RULE_VIOLATION INSUFFICIENT_STOCK` with per-line availability.
4. **Stock semantics**: `available = on_hand - reserved - safety_buffer` (per-channel buffer supported); channels receive `available`, never `on_hand`.
5. **Traceability**: `product_barcodes` identify a variant; `inventory_units` (internal `inventory_code`, optional lot/serial) identify physical units when `track_serial`/`track_unit` is on. Not every unit gets a row — only tracked SKUs.
6. **Valuation**: FIFO layers (`inventory_lots.cost_remaining`) or moving average per `(variant, warehouse)`, chosen per company setting; valuation runs snapshot the result (`inventory_valuation_runs/lines`) for accounting.
7. **Concurrency tests are mandatory**: 100 parallel allocators on quantity 1 → exactly 1 success; concurrent receipt + sale preserves `on_hand = Σ ledger`.

## Consequences

- Balance updates are hot rows; mitigated by narrow rows, fixed lock order, short transactions, and batching receipts.
- The `CHECK` constraint makes negative stock impossible even under bugs.
- Ledger + balance can drift only through a bug; a nightly consistency job compares `Σ ledger` vs balances and alerts.

## Alternatives rejected

- Computing stock from `SUM(ledger)` on every request — correct but too slow at 2M rows/day.
- DB triggers for balance maintenance — hidden logic, hard to test, poor debuggability.
- Optimistic `UPDATE … WHERE available >= qty` — viable, but multi-line orders need atomic all-or-nothing, and error reporting per line is better with explicit locks.
