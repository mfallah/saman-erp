import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { TABLES } = await import(pathToFileURL(resolve(ROOT, 'src/schema/spec.ts')).href);
const doc = readFileSync(resolve(ROOT, '../../docs/02-data-model/DATA-MODEL.md'), 'utf8');
const names = new Set(TABLES.map((t) => t.name));
const ignored = new Set(['shareholders', 'shareholder_transactions']); // removed in v1.1
const listed = new Set();
for (const re of [/\*\*`([a-z_]+\.[a-z_0-9]+)`\*\*/g, /\*\*([a-z_]+\.[a-z_0-9]+)\*\* —/g]) {
  for (const m of doc.matchAll(re)) listed.add(m[1].split('.')[1]);
}
const deferred = [...listed].filter((t) => !names.has(t) && !ignored.has(t)).sort();
console.log(JSON.stringify({ docTables: listed.size, implemented: names.size, deferred }, null, 1));
