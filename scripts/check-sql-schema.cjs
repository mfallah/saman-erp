#!/usr/bin/env node
/**
 * Schema-drift checker for Saman ERP repositories.
 *
 * Extracts literal column lists from `insert into erp.<table> (...)` and
 * `update erp.<table> set col = ...` statements in TypeScript sources and compares
 * them with the columns that actually exist in a live PostgreSQL database.
 * This catches the `erp.<module>.<table>` / renamed-column class of defects that
 * typecheck cannot see.
 *
 * Usage:
 *   node scripts/check-sql-schema.cjs                      # uses DATABASE_URL
 *   DATABASE_URL=postgres://... node scripts/check-sql-schema.cjs apps/api/src
 *
 * Exit code: 0 = no drift, 1 = drift found (CI gate).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const postgres = require('postgres');

const connectionString =
  process.env.DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:55432/saman_verify4';
const rootDir = process.argv[2] ?? path.join(__dirname, '..', 'apps', 'api', 'src');

/** @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Strip `${...}` interpolations so only literal SQL remains. */
function stripInterpolations(sql) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const two = sql.slice(i, i + 2);
    if (two === '${') {
      depth += 1;
      i += 1;
      continue;
    }
    if (depth > 0) {
      if (sql[i] === '}') depth -= 1;
      continue;
    }
    out += sql[i];
  }
  return out;
}

const COL = /"?([a-z_][a-z0-9_]*)"?/i;

function splitColumns(list) {
  return list
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = COL.exec(part);
      return m ? m[1].toLowerCase() : null;
    })
    .filter(Boolean);
}

function extract(file, source) {
  const refs = [];
  const text = source;

  // insert into [erp.]table (cols)
  const insertRe = /insert\s+into\s+(?:erp\.)?"?([a-z_][a-z0-9_]*)"?\s*\(([^)]*)\)/gi;
  for (let m = insertRe.exec(text); m; m = insertRe.exec(text)) {
    const before = source.slice(0, m.index);
    const line = before.split('\n').length;
    refs.push({ file, line, table: m[1].toLowerCase(), kind: 'insert', columns: splitColumns(stripInterpolations(m[2])) });
  }

  // update [erp.]table set a = ..., b = ...
  const updateRe = /update\s+(?:erp\.)?"?([a-z_][a-z0-9_]*)"?\s+set\s+([\s\S]*?)(?:\bwhere\b|`|$)/gi;
  for (let m = updateRe.exec(text); m; m = updateRe.exec(text)) {
    const before = source.slice(0, m.index);
    const line = before.split('\n').length;
    const setClause = stripInterpolations(m[2]);
    const cols = [...setClause.matchAll(/(?:^|,)\s*"?([a-z_][a-z0-9_]*)"?\s*=/gi)].map((x) => x[1].toLowerCase());
    if (cols.length) refs.push({ file, line, table: m[1].toLowerCase(), kind: 'update', columns: cols });
  }
  return refs;
}

(async () => {
  const files = walk(rootDir);
  const refs = files.flatMap((file) => extract(file, fs.readFileSync(file, 'utf8')));
  const sql = postgres(connectionString, { max: 1, connect_timeout: 10 });
  const rows = await sql`
    select table_name, column_name
      from information_schema.columns
     where table_schema = 'erp'`;
  const schema = new Map();
  for (const row of rows) {
    if (!schema.has(row.table_name)) schema.set(row.table_name, new Set());
    schema.get(row.table_name).add(row.column_name);
  }

  const drift = [];
  const unknownTables = [];
  for (const ref of refs) {
    const cols = schema.get(ref.table);
    if (!cols) {
      unknownTables.push(ref);
      continue;
    }
    const missing = ref.columns.filter((c) => !cols.has(c) && c !== ref.table);
    if (missing.length) drift.push({ ...ref, missing });
  }

  const rel = (f) => path.relative(path.join(__dirname, '..'), f);
  console.log(`scanned ${files.length} files, ${refs.length} insert/update statements, schema tables ${schema.size}`);
  console.log(`unknown tables: ${unknownTables.length}, statements with missing columns: ${drift.length}`);

  for (const item of unknownTables.slice(0, 40)) {
    console.log(`UNKNOWN TABLE  ${rel(item.file)}:${item.line}  ${item.table}`);
  }
  for (const item of drift.slice(0, 120)) {
    console.log(`MISSING COLUMNS ${rel(item.file)}:${item.line}  ${item.table} (${item.kind})  ->  ${item.missing.join(', ')}`);
  }
  const totalMissing = drift.reduce((n, d) => n + d.missing.length, 0);
  console.log(`\nTOTAL missing column references: ${totalMissing} in ${drift.length} statements`);
  await sql.end({ timeout: 1 });
  process.exit(drift.length === 0 && unknownTables.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('check-sql-schema failed:', e.message);
  process.exit(2);
});
