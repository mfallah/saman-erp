#!/usr/bin/env node
/**
 * Offline structural validator for generated migration (no PostgreSQL server in this env).
 * Checks: duplicate columns, PK presence, FK targets/columns, index/trigger targets,
 * partition parents + default partitions, balanced parentheses/dollar quotes, required objects.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const sql = readFileSync(resolve(ROOT, '../drizzle/0001_init.sql'), 'utf8');
const { TABLES } = await import(pathToFileURL(resolve(ROOT, '../src/schema/spec.ts')).href);

const errors = [];
const stats = { specTables: TABLES.length, createTables: 0, partitioned: 0, defaultPartitions: 0, indexes: 0, triggers: 0, fks: 0, checks: 0, functions: 0, partitionsChildren: 0 };

const clean = sql.split('\n').map((l) => (l.trim().startsWith('--') ? '' : l)).join('\n');

const tables = new Map();
for (const m of clean.matchAll(/CREATE TABLE IF NOT EXISTS erp\."?([a-z_0-9]+)"? \(([\s\S]*?)\n\)( PARTITION BY RANGE \("created_at"\))?;/g)) {
  const name = m[1];
  const body = m[2];
  stats.createTables++;
  if (m[3]) stats.partitioned++;
  const cols = [];
  for (const line of body.split('\n')) {
    const cm = /^\s*"([a-z_0-9]+)"\s+[a-z]/.exec(line);
    if (cm) cols.push(cm[1]);
  }
  const dupes = [...new Set(cols.filter((c, i) => cols.indexOf(c) !== i))];
  if (dupes.length) errors.push(`${name}: duplicate column(s) ${dupes.join(',')}`);
  if (cols.length === 0) errors.push(`${name}: no columns parsed`);
  if (!/CONSTRAINT "pk_/.test(body)) errors.push(`${name}: no primary key constraint`);
  tables.set(name, { cols: new Set(cols), partitioned: Boolean(m[3]) });
}
for (const m of clean.matchAll(/CREATE TABLE IF NOT EXISTS erp\.([a-z_0-9]+)_default PARTITION OF erp\.([a-z_0-9]+) DEFAULT;/g)) {
  stats.defaultPartitions++;
  if (!tables.has(m[2])) errors.push(`default partition for unknown parent ${m[2]}`);
  else if (!tables.get(m[2]).partitioned) errors.push(`${m[2]} default partition but parent is not partitioned`);
}
for (const m of clean.matchAll(/CREATE TABLE IF NOT EXISTS erp\.([a-z_0-9]+)_p(\d{6}) PARTITION OF erp\.([a-z_0-9]+) FOR VALUES/g)) {
  stats.partitionsChildren++;
  if (!tables.get(m[3])?.partitioned) errors.push(`month partition ${m[1]} parent ${m[3]} not partitioned`);
}
for (const m of clean.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([a-z_0-9]+) ON erp\."?([a-z_0-9]+)"?/g)) {
  stats.indexes++;
  if (!tables.has(m[2])) errors.push(`index ${m[1]} on unknown table ${m[2]}`);
}
for (const m of clean.matchAll(/CREATE (?:CONSTRAINT )?TRIGGER ([a-z_0-9]+) (?:BEFORE|AFTER)[A-Za-z ]* ON erp\."?([a-z_0-9]+)"?/g)) {
  stats.triggers++;
  if (!tables.has(m[2])) errors.push(`trigger ${m[1]} on unknown table ${m[2]}`);
}
const tableNames = [...tables.keys()].sort((a, b) => b.length - a.length);
for (const m of clean.matchAll(/CONSTRAINT "(fk_[a-z_0-9]+)" FOREIGN KEY \("([a-z_0-9]+)"\) REFERENCES erp\."?([a-z_0-9]+)"? \(id\)/g)) {
  stats.fks++;
  const fk = m[1];
  const col = m[2];
  const target = m[3];
  const owner = tableNames.find((t) => fk.startsWith('fk_' + t + '_'));
  if (!owner) { errors.push(`fk ${fk}: cannot resolve owning table`); continue; }
  if (!tables.has(target)) errors.push(`fk ${fk} -> unknown table ${target}`);
  if (!tables.get(owner).cols.has(col)) errors.push(`fk ${fk}: column ${col} missing on ${owner}`);
}
for (const m of clean.matchAll(/CONSTRAINT "(ck_[a-z_0-9]+)" CHECK/g)) {
  stats.checks++;
  const owner = tableNames.find((t) => m[1].startsWith('ck_' + t + '_'));
  if (!owner) errors.push(`check ${m[1]}: cannot resolve owning table`);
}
for (const m of clean.matchAll(/CREATE OR REPLACE FUNCTION erp\.([a-z_0-9]+)/g)) stats.functions++;

let depth = 0; let inDollar = false;
for (let i = 0; i < clean.length - 1; i++) {
  if (clean[i] === '$' && clean[i + 1] === '$') { inDollar = !inDollar; i++; continue; }
  if (inDollar) continue;
  if (clean[i] === '(') depth++;
  else if (clean[i] === ')') depth--;
  if (depth < 0) { errors.push('unbalanced parentheses'); break; }
}
if (depth !== 0) errors.push(`unbalanced parentheses: ${depth}`);
if (inDollar) errors.push('unterminated dollar-quoted block');

for (const f of ['erp.set_updated_at', 'erp.bump_version', 'erp.allocate_document_no', 'erp.chain_audit', 'erp.maintain_partitions', 'erp.ensure_month_partition', 'erp.derive_journal_period']) {
  if (!sql.includes(`FUNCTION ${f}`)) errors.push(`missing function ${f}`);
}
for (const trig of ['trg_journal_entries_assert_balanced', 'trg_journal_lines_assert_balanced', 'trg_journal_entries_derive_period']) {
  if (!sql.includes(`TRIGGER ${trig}`)) errors.push(`missing trigger ${trig}`);
}
if (!/EXCLUDE USING gist/.test(sql)) errors.push('missing gist EXCLUDE constraints');
if (!/USING brin/.test(sql)) errors.push('missing BRIN indexes');
if (!/REVOKE DELETE, TRUNCATE ON ALL TABLES/.test(sql)) errors.push('missing app DELETE revoke');
if (!/FROM saman_readonly/.test(sql)) errors.push('missing readonly revokes');
if (!/CREATE EXTENSION IF NOT EXISTS btree_gist/.test(sql)) errors.push('missing btree_gist extension');

if (stats.createTables !== TABLES.length) errors.push(`table count mismatch: spec=${TABLES.length} sql=${stats.createTables}`);
for (const t of TABLES) if (!tables.has(t.name)) errors.push(`spec table missing from SQL: ${t.name}`);

console.log(JSON.stringify(stats));
if (errors.length) {
  console.error(`VALIDATION FAILED (${errors.length})`);
  for (const e of errors.slice(0, 40)) console.error('  - ' + e);
  process.exit(1);
}
console.log('VALIDATION OK');
