# Audit chain integrity (TD-20)

## Canonical hash input (v2)

`erp.audit_logs` is append-only and hash-chained per organization by
`erp.chain_audit()`. Since migration `0003_audit_chain_content.sql` each link is:

```
entry_hash = sha256( prev_hash || '|' || erp.audit_row_canonical(id, created_at) )
```

`erp.audit_row_canonical` returns a stable `jsonb` text of **every audited content
column** — id, public id, created at (UTC, microseconds), organization, actor
(user id/type/label/api client), entity (type/id/public id), action, `old_data`,
`new_data`, `diff`, IP, user-agent hash, request id, trace id and severity.
`jsonb` sorts object keys deterministically, so the payload is canonical without
relying on JS key order. Only chain metadata (`prev_hash`, `entry_hash`,
`hash_seq`) is excluded; it is covered by the links and the head anchor instead.

The previous chain hashed only `(prev, id, created_at)`, so edits to `action` or
the change payload were invisible. Migration 0003 re-chains existing rows under
v2 (it resets `prev_hash`/`entry_hash`/`hash_seq` and re-anchors the head).

## Verifier

```
# read-only; DATABASE_URL from env or repo .env
node scripts/verify-audit-chain.mjs
node scripts/verify-audit-chain.mjs --verbose
```

It walks rows per organization in `hash_seq` order, recomputes every hash from
stored content, checks `prev_hash` links, `hash_seq` continuity, that the last
row matches `erp.audit_chain_heads`, and that no row is left unchained. Output is
`PASS …` (exit 0) or `FAIL …` with `first broken id` and reason (exit 1). Exit 2
means it could not connect. If migration 0003 is not applied it falls back to the
legacy v1 formula and says so.

Tampering with any covered column (for example changing `action` on one row)
produces `FAIL audit chain broken` with that row id.

## Privileges

Migration 0003 narrows the worker role:

| role | audit_logs | audit_chain_heads |
|---|---|---|
| `saman_app` | SELECT, INSERT (no UPDATE/DELETE, per 0001) | SELECT |
| `saman_worker` | SELECT, INSERT (UPDATE/DELETE/TRUNCATE revoked, including existing partitions; new partitions are created without worker write grants) | SELECT only (INSERT/UPDATE/DELETE/TRUNCATE revoked) |
| `saman_readonly` | no access (revoked in 0001) | no grant |
| `saman_migrator` / owner | full (DDL owner) | full |

`erp.chain_audit()` and `erp.audit_row_canonical()` are `SECURITY DEFINER`
functions, so the worker can still advance the chain without direct table write
grants.

### What remains

- The **database owner / `saman_migrator`** can still UPDATE/DELETE audit rows and
  rewrite `audit_chain_heads`. A hash chain cannot defend against a superuser with
  DDL rights; real tamper evidence needs the head (or periodic checkpoints)
  pushed to an external append-only store (object storage/WORM or a separate
  database) — not implemented here.
- Rows inserted by a role that holds `INSERT` but never runs `chain_audit()` stay
  unchained; the verifier reports `row_is_not_chained` as FAIL. Chain advancement
  is performed by the worker; a stopped worker leaves a verifiable gap, which is
  intentional (visible, not silent).
- `trusted` local connections in development bypass role separation by design.
- `0001_init.sql` shows migration checksum drift in some pre-existing local
  databases; it was not modified by this change (new migrations only).
