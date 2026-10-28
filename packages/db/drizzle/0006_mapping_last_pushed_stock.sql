-- ============================================================================
-- Saman ERP — 0006_mapping_last_pushed_stock.sql
-- Hand-written addendum to 0001_init.sql (not emitted by scripts/generate.mjs):
-- the last stock quantity actually accepted by the channel for a mapped variant,
-- so `push_inventory` can send only what changed instead of the whole catalogue
-- on every receipt (the Carexy 429 storm of 2026-10-28).
--
-- `NULL` means "never pushed for this mapping"; a mapping with a NULL value is
-- only included when the computed available quantity is positive, so a brand-new
-- zero-stock variant does not generate a partner call.
--
-- Idempotent by construction (ADD COLUMN IF NOT EXISTS): the runner applies each
-- file once in a transaction (packages/db/src/migrate.ts), and re-running the SQL
-- directly is a no-op. Target: PostgreSQL 16. Schema: erp.
-- ============================================================================
SET search_path TO erp, public;

ALTER TABLE erp."channel_product_mappings"
  ADD COLUMN IF NOT EXISTS "last_pushed_stock" numeric(18,4);

COMMENT ON COLUMN erp."channel_product_mappings"."last_pushed_stock" IS
  'Last available quantity accepted by the channel for this mapping; NULL = never pushed.';

SET search_path TO public;
