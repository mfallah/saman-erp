-- ============================================================================
-- TD-20: audit chain over the full normalized record content
-- ============================================================================
-- Before this migration `erp.chain_audit()` hashed only `(prev, id, created_at)`,
-- so tampering with `action`, `old_data`, `new_data`, actor, entity, etc. was not
-- detectable. The canonical input is now a stable jsonb object of every audited
-- content column (jsonb sorts object keys deterministically), hashed as
--
--   sha256( prev_hash || '|' || erp.audit_row_canonical(id, created_at) )
--
-- Chain metadata (`prev_hash`, `entry_hash`, `hash_seq`) is deliberately excluded
-- from the canonical payload and covered by the chain links instead.
-- ============================================================================

CREATE OR REPLACE FUNCTION erp.audit_row_canonical(p_id bigint, p_created_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = erp, public, pg_temp
AS $$
  SELECT jsonb_build_object(
           'v', 2,
           'id', a.id::text,
           'public_id', a.public_id::text,
           'created_at', to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           'organization_id', a.organization_id::text,
           'actor_user_id', a.actor_user_id::text,
           'actor_type', a.actor_type,
           'actor_label', a.actor_label,
           'api_client_id', a.api_client_id::text,
           'entity_type', a.entity_type,
           'entity_id', a.entity_id::text,
           'entity_public_id', a.entity_public_id::text,
           'action', a.action,
           'old_data', a.old_data,
           'new_data', a.new_data,
           'diff', a.diff,
           'ip_address', host(a.ip_address),
           'user_agent_hash', a.user_agent_hash,
           'request_id', a.request_id::text,
           'trace_id', a.trace_id,
           'severity', a.severity
         )::text
    FROM erp.audit_logs a
   WHERE a.id = p_id
     AND a.created_at = p_created_at
$$;

REVOKE ALL ON FUNCTION erp.audit_row_canonical(bigint, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erp.audit_row_canonical(bigint, timestamptz) TO saman_app, saman_worker, saman_readonly;

-- Per-organization chain (the previous implementation silently only chained org 1).
CREATE OR REPLACE FUNCTION erp.chain_audit(p_batch integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = erp, public, pg_temp
AS $$
DECLARE
  v_org bigint;
  r record;
  v_head record;
  v_prev char(64);
  v_seq bigint;
  v_hash char(64);
  v_next_id bigint;
  v_canonical text;
  n int := 0;
BEGIN
  FOR v_org IN
    SELECT DISTINCT organization_id
      FROM erp.audit_logs
     WHERE entry_hash IS NULL
     ORDER BY organization_id
  LOOP
    SELECT * INTO v_head
      FROM erp.audit_chain_heads
     WHERE organization_id = v_org
       FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO erp.audit_chain_heads(organization_id, last_row_hash, chain_version)
      VALUES (v_org, encode(digest('genesis:' || v_org::text, 'sha256'), 'hex'), 2)
      RETURNING * INTO v_head;
    END IF;

    v_prev := v_head.last_row_hash;
    v_seq := coalesce(v_head.last_audit_id, 0);
    v_next_id := NULL;

    FOR r IN
      SELECT id, created_at
        FROM erp.audit_logs
       WHERE organization_id = v_org
         AND entry_hash IS NULL
       ORDER BY created_at, id
       LIMIT p_batch
    LOOP
      v_seq := v_seq + 1;
      v_canonical := erp.audit_row_canonical(r.id, r.created_at);
      v_hash := encode(
        digest(coalesce(v_prev, '') || '|' || coalesce(v_canonical, ''), 'sha256'),
        'hex'
      );
      UPDATE erp.audit_logs
         SET prev_hash = v_prev,
             entry_hash = v_hash,
             hash_seq = v_seq
       WHERE id = r.id
         AND created_at = r.created_at;
      v_prev := v_hash;
      v_next_id := r.id;
      n := n + 1;
    END LOOP;

    IF v_next_id IS NOT NULL THEN
      UPDATE erp.audit_chain_heads
         SET last_audit_id = v_next_id,
             last_created_at = now(),
             last_row_hash = v_prev,
             chain_version = 2,
             updated_at = now()
       WHERE organization_id = v_org;
    END IF;
  END LOOP;

  RETURN n;
END $$;

REVOKE ALL ON FUNCTION erp.chain_audit(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erp.chain_audit(integer) TO saman_worker;

-- ---------------------------------------------------------------------------
-- Least privilege: the worker can INSERT audit rows but must never UPDATE or
-- DELETE them (nor re-anchor the chain head directly). `chain_audit` is
-- SECURITY DEFINER and keeps working without those grants.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saman_worker') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON erp.audit_logs FROM saman_worker';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON erp.audit_chain_heads FROM saman_worker';
    EXECUTE 'GRANT SELECT ON erp.audit_chain_heads TO saman_worker';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saman_app') THEN
    -- The app only appends audit rows; the chain head is written exclusively by
    -- the SECURITY DEFINER `chain_audit()` function.
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON erp.audit_chain_heads FROM saman_app';
    EXECUTE 'GRANT SELECT ON erp.audit_chain_heads TO saman_app';
  END IF;
END $$;

-- Existing audit partitions carry their own ACLs; new monthly partitions are
-- created by `ensure_month_partition`, which now tightens them at creation time.
DO $$ DECLARE
  r record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saman_worker') THEN
    FOR r IN
      SELECT c.oid::regclass AS rel
        FROM pg_class c
        JOIN pg_inherits i ON i.inhrelid = c.oid
       WHERE i.inhparent = 'erp.audit_logs'::regclass
    LOOP
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM saman_worker', r.rel);
    END LOOP;
  END IF;
END $$;

-- Keep future audit partitions restrictive: strip worker write privileges on
-- the partition right after creating it (DML through the parent is unaffected).
CREATE OR REPLACE FUNCTION erp.ensure_month_partition(p_parent regclass, p_month date)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, public, pg_temp AS $$
DECLARE v_nsp text; v_rel text; v_part text;
        v_start timestamptz := date_trunc('month', p_month)::timestamptz;
        v_end timestamptz := (date_trunc('month', p_month) + interval '1 month')::timestamptz;
BEGIN
  SELECT n.nspname, c.relname INTO v_nsp, v_rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = p_parent;
  IF v_nsp IS DISTINCT FROM 'erp' THEN RAISE EXCEPTION 'partition parent must be in erp: %', p_parent; END IF;
  IF v_rel !~ '^[a-z][a-z0-9_]*$' THEN RAISE EXCEPTION 'invalid relation name: %', v_rel; END IF;
  v_part := v_rel || '_p' || to_char(v_start, 'YYYYMM');
  IF to_regclass(format('%I.%I', v_nsp, v_part)) IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(v_nsp || '.' || v_rel));
    EXECUTE format('CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)', v_nsp, v_part, v_nsp, v_rel, v_start, v_end);
    IF v_rel = 'audit_logs' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saman_worker') THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I.%I FROM saman_worker', v_nsp, v_part);
    END IF;
  END IF;
  RETURN v_part;
END $$;

REVOKE ALL ON FUNCTION erp.ensure_month_partition(regclass, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erp.ensure_month_partition(regclass, date) TO saman_worker;

-- ---------------------------------------------------------------------------
-- Re-chain existing rows under the content-covering canonical form. The old
-- chain only bound ids/timestamps, so it carried no content evidence to
-- preserve; after this the head is re-anchored v2.
-- ---------------------------------------------------------------------------
UPDATE erp.audit_logs
   SET prev_hash = NULL,
       entry_hash = NULL,
       hash_seq = NULL;

DELETE FROM erp.audit_chain_heads;

DO $$ BEGIN
  WHILE erp.chain_audit(5000) > 0 LOOP
    -- chain all organizations in batches
  END LOOP;
END $$;
