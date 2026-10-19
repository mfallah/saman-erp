# ADR-0013 — Money, quantities & precision

**Status:** Accepted · **Date:** 1405-07-27

## Context

Iranian Rial has no practical minor unit in retail, but discounts, commissions, tax and unit costs produce fractions. JavaScript `number` cannot represent large money values exactly (and `float` in SQL is worse). Accounting must never round-trip through floats.

## Decision

- **Money**: `bigint` in **IRR** (rial), integer. JSON transport as **string** (`"12500000"`), parsed by `bigint` helpers; no `parseFloat` on money.
- **Quantities**: `numeric(18,4)`; **unit prices/costs**: `numeric(18,4)`; **rates/percentages**: `numeric(9,6)`.
- **Rounding**: only at defined boundaries (invoice line total, tax, settlement). `ROUND_HALF_UP` per Iranian accounting convention; intermediate values keep full precision. Rounding policy lives in one module (`money.ts`) with tests.
- **Currency**: org base `IRR`; `currencies` table + `fx_rate` columns exist for future multi-currency, but v1 assumes single currency and rejects documents with `currency <> base`.
- **Formatting**: UI formats with `Intl.NumberFormat('fa-IR')`; grouping and Persian digits only at render time.

## Consequences

- All DTOs/validators use a `MoneyString` zod type; arithmetic helpers (`add`, `mul`, `applyRate`, `round`) are the only allowed operations.
- Database reports sum `bigint`/`numeric` server-side; the SPA never sums raw strings.
