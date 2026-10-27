-- ============================================================================
-- Saman ERP — 0002_channel_commerce.sql
-- Hand-written addendum to 0001_init.sql (not emitted by scripts/generate.mjs):
-- channel commerce extensions — product imagery, per-channel product costs,
-- product-merge audit log and warehouse pack tasks.
-- Idempotent by construction (IF NOT EXISTS / guarded grants): the runner applies
-- each file once in a transaction (src/migrate.ts), and re-running the SQL
-- directly is a no-op. Target: PostgreSQL 16. Schema: erp.
-- ============================================================================
SET search_path TO erp, public;

-- ---------- channel-supplied product imagery ----------
-- Digikala returns `image_src` (and a nested `product.image`) on the seller
-- product list; the import keeps the first https URL here.
ALTER TABLE erp."products" ADD COLUMN IF NOT EXISTS "image_url" text;
ALTER TABLE erp."product_variants" ADD COLUMN IF NOT EXISTS "image_url" text;

-- ---------- per channel×variant economics (pulled from the channel) ----------
-- The commission rate differs per product/category and is only known from the
-- channel API, so it is cached here per (account, variant) and refreshed by
-- `POST /channel-accounts/:id/digikala/sync-commissions`.
CREATE TABLE IF NOT EXISTS erp."channel_product_costs" (
  "id" bigint GENERATED ALWAYS AS IDENTITY,
  "public_id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" bigint NOT NULL,
  "channel_account_id" bigint NOT NULL,
  "product_variant_id" bigint NOT NULL,
  "commission_percent" numeric(6,3),
  "other_fees" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pk_channel_product_costs" PRIMARY KEY ("id"),
  CONSTRAINT "uq_channel_product_costs_public_id" UNIQUE ("public_id"),
  CONSTRAINT "uq_channel_product_costs_channel_account_id_product_variant_id" UNIQUE ("channel_account_id","product_variant_id"),
  CONSTRAINT "fk_channel_product_costs_organization_id" FOREIGN KEY ("organization_id") REFERENCES erp."organizations" (id) ON DELETE RESTRICT,
  CONSTRAINT "fk_channel_product_costs_channel_account_id" FOREIGN KEY ("channel_account_id") REFERENCES erp."channel_accounts" (id) ON DELETE CASCADE,
  CONSTRAINT "fk_channel_product_costs_product_variant_id" FOREIGN KEY ("product_variant_id") REFERENCES erp."product_variants" (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_channel_product_costs_organization_id ON erp."channel_product_costs" ("organization_id");
CREATE INDEX IF NOT EXISTS ix_channel_product_costs_product_variant_id ON erp."channel_product_costs" ("product_variant_id");

-- ---------- product merge audit trail (append-only) ----------
-- One row per merge: the snapshot keeps the source product as it was, so the
-- merge can be explained (and audited) after the source row is soft-deleted.
CREATE TABLE IF NOT EXISTS erp."product_merge_log" (
  "id" bigint GENERATED ALWAYS AS IDENTITY,
  "public_id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" bigint NOT NULL,
  "target_product_id" bigint NOT NULL,
  "source_product_id" bigint NOT NULL,
  "snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_by" bigint,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pk_product_merge_log" PRIMARY KEY ("id"),
  CONSTRAINT "uq_product_merge_log_public_id" UNIQUE ("public_id"),
  CONSTRAINT "fk_product_merge_log_organization_id" FOREIGN KEY ("organization_id") REFERENCES erp."organizations" (id) ON DELETE RESTRICT,
  CONSTRAINT "fk_product_merge_log_target_product_id" FOREIGN KEY ("target_product_id") REFERENCES erp."products" (id) ON DELETE RESTRICT,
  CONSTRAINT "fk_product_merge_log_source_product_id" FOREIGN KEY ("source_product_id") REFERENCES erp."products" (id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS ix_product_merge_log_organization_id_created_at ON erp."product_merge_log" ("organization_id","created_at");
CREATE INDEX IF NOT EXISTS ix_product_merge_log_target_product_id ON erp."product_merge_log" ("target_product_id");
CREATE INDEX IF NOT EXISTS ix_product_merge_log_source_product_id ON erp."product_merge_log" ("source_product_id");

-- ---------- warehouse pack tasks ----------
CREATE TABLE IF NOT EXISTS erp."pack_tasks" (
  "id" bigint GENERATED ALWAYS AS IDENTITY,
  "public_id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" bigint NOT NULL,
  "order_id" bigint NOT NULL,
  "package_no" varchar(40),
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "assigned_to" bigint,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "closed_at" timestamptz,
  CONSTRAINT "pk_pack_tasks" PRIMARY KEY ("id"),
  CONSTRAINT "uq_pack_tasks_public_id" UNIQUE ("public_id"),
  CONSTRAINT "fk_pack_tasks_organization_id" FOREIGN KEY ("organization_id") REFERENCES erp."organizations" (id) ON DELETE RESTRICT,
  CONSTRAINT "fk_pack_tasks_order_id" FOREIGN KEY ("order_id") REFERENCES erp."sales_orders" (id) ON DELETE CASCADE,
  CONSTRAINT "fk_pack_tasks_assigned_to" FOREIGN KEY ("assigned_to") REFERENCES erp."users" (id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS ix_pack_tasks_organization_id_status ON erp."pack_tasks" ("organization_id","status");
CREATE INDEX IF NOT EXISTS ix_pack_tasks_order_id ON erp."pack_tasks" ("order_id");
CREATE INDEX IF NOT EXISTS ix_pack_tasks_assigned_to_status ON erp."pack_tasks" ("assigned_to","status");
-- PostgreSQL has no `CREATE TRIGGER IF NOT EXISTS`; guard it so the file re-runs.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_pack_tasks_updated_at' AND tgrelid = 'erp.pack_tasks'::regclass
  ) THEN
    CREATE TRIGGER trg_pack_tasks_updated_at BEFORE UPDATE ON erp."pack_tasks"
      FOR EACH ROW EXECUTE FUNCTION erp.set_updated_at();
  END IF;
END $$;

-- ---------- repair: `settings.pricing` was written as a jsonb *string* ----------
-- The pricing writer stringified the policy before casting to jsonb, so
-- `settings->'pricing'` is a JSON string instead of an object. Unwrap it once;
-- the guard keeps a malformed value (and every non-object settings row) intact.
UPDATE erp.channel_accounts
   SET settings = jsonb_set(settings, '{pricing}', (settings->>'pricing')::jsonb)
 WHERE jsonb_typeof(settings) = 'object'
   AND jsonb_typeof(settings->'pricing') = 'string'
   AND btrim(settings->>'pricing') ~ '^(\{|\[)';

-- ============================================================================
-- Grants manifest (same shape as 0001: app = no DELETE; readonly = read only).
-- Guarded because a managed cluster has no saman_* roles (the migration runner
-- strips role/GRANT lines there anyway).
-- ============================================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saman_app') THEN
    GRANT SELECT, INSERT, UPDATE ON erp.channel_product_costs, erp.product_merge_log, erp.pack_tasks TO saman_app;
    GRANT SELECT ON erp.channel_product_costs, erp.product_merge_log, erp.pack_tasks TO saman_readonly;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA erp TO saman_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saman_worker') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON erp.channel_product_costs, erp.product_merge_log, erp.pack_tasks TO saman_worker;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA erp TO saman_worker;
  END IF;
END $$;

SET search_path TO public;
