-- ============================================================================
-- Saman ERP — 0004_order_line_media.sql
-- Hand-written addendum to 0001_init.sql (not emitted by scripts/generate.mjs):
-- channel-supplied order-line media — the product title and image a channel
-- returns with an order row, kept on the line so the pick/pack station can show
-- an item that has no catalogue mapping yet.
-- Idempotent by construction (ADD COLUMN IF NOT EXISTS): the runner applies each
-- file once in a transaction (src/migrate.ts), and re-running the SQL directly
-- is a no-op. Target: PostgreSQL 16. Schema: erp.
-- ============================================================================
SET search_path TO erp, public;

-- ---------- channel-supplied order-line identity ----------
-- `external_title` is the row title exactly as the channel sent it (Digikala
-- `product_variant_title`); `image_url` is the row image, or the resolved
-- product/variant image when the line is mapped.
ALTER TABLE erp."sales_order_lines" ADD COLUMN IF NOT EXISTS "external_title" text;
ALTER TABLE erp."sales_order_lines" ADD COLUMN IF NOT EXISTS "image_url" text;

SET search_path TO public;
