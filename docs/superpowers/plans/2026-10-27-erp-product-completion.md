# Saman ERP — Product Completion Plan (deep pass)

**Goal:** turn the current half-working ERP into the operational product the sales/warehouse team can run daily: channel orders with real line items, one pricing policy per sales channel with Digikala per-product commission, working pick/pack stations, product merge workbench, product images, and a visible warehouse hierarchy.

**Evidence gathered 2026-10-27 (production DB):**
- `sales_orders = 5` but `sales_order_lines = 0` → orders are useless (root cause: channel mapping ids were wrong; order line variant lookup fails).
- `pick_tasks = 0` → pick/pack stations empty by construction.
- `warehouse_locations = 3`, `warehouse_zones = 7` → created zones never appear in the locations list (UI lists only `warehouse_locations`).
- `products` has **no image column** → images cannot be shown.
- `channel_accounts.settings.pricing` is stored as a **JSON string** (double encoded) → policy reader is fragile.
- Digikala mapping ids (`external_variant_id` 864101…) are not real variant ids (82653385), so stock/price pushes and order-line matching fail until remapped.

## Workstreams (parallel, disjoint file scopes)

### A. Data + channel foundations (backend)
1. Migration `00xx_channel_commerce.sql`:
   - `erp.products.image_url text`, `erp.product_variants.image_url text`
   - `erp.channel_product_costs` (account_id, product_variant_id, commission_percent numeric(6,3), other_fees jsonb, fetched_at, unique(account_id, product_variant_id))
   - `erp.product_merge_log` (id, org, target_product_id, source_product_id, snapshot jsonb, created_by, created_at)
   - `erp.pack_tasks` (id, public_id, order_id, package_no, status, assigned_to, created_at, closed_at)
2. Digikala adapter: capture `image_src` → `imageUrl`; fetch commission via `product-creation/be-seller/{product_id}` during import and persist to `channel_product_costs`.
3. Cursor/backfill: an admin `POST /channel-accounts/:id/digikala/backfill-orders` that re-pulls the last 7 days and re-emits order events (idempotent).
4. Fix double-encoded `settings.pricing` on write and read both shapes.

### B. Pricing: one policy per channel
- New endpoint set `GET/PUT /pricing/channels/:accountId/policy`, `POST /pricing/channels/:accountId/apply` (compute all mapped variants + push prices).
- Policy fields: `costSource`, `marginPercent`, `processingFee`, `shippingFee`, `commissionMode` (`product|fixed|percent`), `commissionPercent`, `fixedCommission`, `vatPercent`, `rounding`, `autoApply`, `autoPush`.
- Digikala formula: `(cost + processing + shipping + margin) / (1 - commission)`; commission = `channel_product_costs.commission_percent` when `commissionMode='product'`.
- Carexy: `cost + margin`.
- Frontend: replace `PricingRulesPage` + policy menu with a single `ChannelsPricingPage` (one card per channel account).

### C. Orders + pick/pack
- Order detail: `GET /sales-orders/:id` returns lines with product/variant/quantity/price; UI modal/page shows them.
- Pick station: auto-assign pick tasks (already coded) verified + pick scans decrement/confirm.
- Pack station: create `pack_tasks` when all lines of an order are picked; pack UI lists orders ready to pack, allows package creation, label print, and marks order `ready_to_ship`; status mapped per channel.

### D. Product merge workbench
- Backend: `GET /products/merge/candidates` (fuzzy name similarity, pg_trgm), `POST /products/merge/batch`, `GET /products/merges` (log), `POST /products/merges/:id/undo`, `GET /products/merge/export.xlsx`, `POST /products/merge/import.xlsx`.
- Merge must repoint mappings, keep inventory intact, and trigger price/stock push for the surviving product.
- Frontend: `/merge` workbench page.

### E. UI: warehouse hierarchy, images, order detail
- `WarehousesPage`: show hierarchy (zones/aisles/racks/shelves/bins) **and** locations in the list; parent selector works.
- Product images: render `image_url` in products list/detail (hotlinked, not uploaded).
- `OrdersPage`: line count + detail drawer.

## Verification gates
- `tsc` api+web exit 0.
- Local API against production DB: orders have lines, pick tasks created, pricing apply writes price_list_items, merge candidates non-empty, locations list shows zones.
- Deploy once, verify boot + job success.
