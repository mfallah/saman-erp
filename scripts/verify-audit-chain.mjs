#!/usr/bin/env node
/**
 * Audit-chain verifier (TD-20) — read-only.
 *
 * Walks `erp.audit_logs` per organization in chain order, recomputes every hash
 * from the stored content and checks the links plus the anchor in
 * `erp.audit_chain_heads`.
 *
 * Canonical input (v2):
 *   sha256( prev_hash || '|' || erp.audit_row_canonical(id, created_at) )
 *
 * `erp.audit_row_canonical` is defined by migration 0003 and returns a stable
 * jsonb text of every audited content column (jsonb sorts keys deterministically).
 * The verifier never trusts the stored `entry_hash`; it only compares.
 *
 * Usage:
 *   node scripts/verify-audit-chain.mjs            # DATABASE_URL from env or .env
 *   node scripts/verify-audit-chain.mjs --verbose
 *
 * Exit codes: 0 = PASS, 1 = FAIL, 2 = cannot verify (no connection).
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const VERBOSE = process.argv.includes('--verbose');

function loadEnvFile() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match === null) continue;
    const [, key, raw] = match;
    if (process.env[key] !== undefined) continue;
    let value = raw.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function main() {
  loadEnvFile();
  const url = (process.env.DATABASE_URL ?? '').trim();
  if (url === '') {
    console.error('FAIL: DATABASE_URL is not set (env or repo .env). Cannot verify the chain.');
    process.exit(2);
  }

  let postgres;
  try {
    ({ default: postgres } = await import('postgres'));
  } catch (error) {
    console.error('FAIL: the `postgres` package is not installed at the repo root.', error.message);
    process.exit(2);
  }

  const sql = postgres(url, { max: 1, connect_timeout: 10, idle_timeout: 5 });
  try {
    const result = await sql.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;

      const fnRows = await tx`
        select to_regprocedure('erp.audit_row_canonical(bigint,timestamptz)') is not null as present`;
      const hasV2 = fnRows[0]?.present === true;
      if (!hasV2) {
        console.log('WARN: erp.audit_row_canonical is missing (migration 0003 not applied); falling back to legacy v1 hashes.');
      }

      const orgRows = await tx`
        select organization_id::text as org
          from erp.audit_chain_heads
        union
        select distinct organization_id::text as org
          from erp.audit_logs
         order by org`;

      if (orgRows.length === 0) {
        return { pass: true, orgs: 0, rows: 0, hasV2, fail: null };
      }

      let total = 0;
      for (const { org } of orgRows) {
        const headRows = await tx`
          select coalesce(last_audit_id::text, '') as last_id,
                 coalesce(last_row_hash, '') as last_hash,
                 coalesce(chain_version, 1) as chain_version
            from erp.audit_chain_heads
           where organization_id = ${org}::bigint`;
        const head = headRows[0] ?? null;

        const rows = await tx`
          select id::text as id,
                 created_at::text as created_at_text,
                 coalesce(prev_hash, '') as prev_hash,
                 coalesce(entry_hash, '') as entry_hash,
                 hash_seq,
                 ${hasV2
                   ? tx`erp.audit_row_canonical(id, created_at)`
                   : tx`null::text`} as canonical
            from erp.audit_logs
           where organization_id = ${org}::bigint
             and entry_hash is not null
           order by hash_seq asc, id asc`;

        const unchained = await tx`
          select id::text as id
            from erp.audit_logs
           where organization_id = ${org}::bigint
             and entry_hash is null
           order by created_at asc, id asc
           limit 1`;

        if (unchained.length > 0) {
          return {
            pass: false,
            orgs: orgRows.length,
            rows: total,
            hasV2,
            fail: {
              id: unchained[0].id,
              org,
              reason: 'row_is_not_chained (entry_hash is null)',
            },
          };
        }

        let previousHash = null;
        let previousSeq = null;
        let lastId = null;
        let lastHash = null;

        for (const row of rows) {
          total += 1;
          const seq = row.hash_seq === null ? null : Number(row.hash_seq);

          if (previousHash !== null && row.prev_hash !== previousHash) {
            return {
              pass: false,
              orgs: orgRows.length,
              rows: total,
              hasV2,
              fail: { id: row.id, org, reason: `prev_hash mismatch (expected ${previousHash}, got ${row.prev_hash || '<empty>'})` },
            };
          }
          if (previousSeq !== null && seq !== previousSeq + 1) {
            return {
              pass: false,
              orgs: orgRows.length,
              rows: total,
              hasV2,
              fail: { id: row.id, org, reason: `hash_seq gap (${previousSeq} -> ${seq})` },
            };
          }

          const canonical = hasV2
            ? (row.canonical ?? '')
            : `${row.id}|${row.created_at_text}`;
          const expected = sha256(`${row.prev_hash}|${canonical}`);
          if (expected !== row.entry_hash) {
            return {
              pass: false,
              orgs: orgRows.length,
              rows: total,
              hasV2,
              fail: { id: row.id, org, reason: `entry_hash mismatch (expected ${expected}, got ${row.entry_hash})` },
            };
          }

          if (VERBOSE) {
            console.log(`  ok org=${org} id=${row.id} seq=${row.hash_seq}`);
          }
          previousHash = row.entry_hash;
          previousSeq = seq;
          lastId = row.id;
          lastHash = row.entry_hash;
        }

        if (head !== null) {
          if (head.last_id !== (lastId ?? '')) {
            return {
              pass: false,
              orgs: orgRows.length,
              rows: total,
              hasV2,
              fail: { id: lastId ?? head.last_id, org, reason: `chain head last_audit_id mismatch (head ${head.last_id || '<empty>'}, last row ${lastId ?? '<none>'})` },
            };
          }
          if (head.last_hash !== (lastHash ?? '')) {
            return {
              pass: false,
              orgs: orgRows.length,
              rows: total,
              hasV2,
              fail: { id: lastId ?? head.last_id, org, reason: 'chain head last_row_hash does not match the last row hash' },
            };
          }
        } else if (lastId !== null) {
          return {
            pass: false,
            orgs: orgRows.length,
            rows: total,
            hasV2,
            fail: { id: lastId, org, reason: 'missing audit_chain_heads anchor' },
          };
        }

        if (VERBOSE) {
          console.log(`  org=${org} verified rows=${rows.length} head=${head?.last_id ?? '<none>'}`);
        }
      }

      return { pass: true, orgs: orgRows.length, rows: total, hasV2, fail: null };
    });

    if (result.pass) {
      const mode = result.hasV2 ? 'v2 (full content)' : 'legacy v1 (ids/timestamps only)';
      console.log(`PASS audit chain verified: orgs=${result.orgs} rows=${result.rows} canonical=${mode}`);
      process.exit(0);
    }

    console.log('FAIL audit chain broken');
    console.log(`first broken id: ${result.fail.id}`);
    console.log(`organization: ${result.fail.org}`);
    console.log(`reason: ${result.fail.reason}`);
    console.log(`checked rows before failure: ${result.rows}`);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('FAIL: verifier error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
