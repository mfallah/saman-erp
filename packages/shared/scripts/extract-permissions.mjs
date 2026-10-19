#!/usr/bin/env node
/**
 * Deterministically extracts the permission-key registry from
 * `docs/03-api-contract/API.md` (§5.2 authoritative registry + §5.3.1 delta keys
 * that the API references) and regenerates `src/permissions.generated.ts`.
 *
 * The registry is ~400 keys; it must never be hand-typed (`ADR-0008`). CI drift
 * is caught by `test/permissions.spec.ts`, which re-runs this extraction and
 * compares it with the committed generated module.
 *
 * Usage: pnpm --filter @saman/shared gen:permissions
 *        node scripts/extract-permissions.mjs --check   # exit 1 on drift
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository-root relative paths resolved from this script's location. */
export const API_CONTRACT_PATH = path.resolve(HERE, '../../../docs/03-api-contract/API.md');
export const GENERATED_PATH = path.resolve(HERE, '../src/permissions.generated.ts');

const REGISTRY_HEADING = '### 5.2 Registry';
const DELTA_HEADING = '### 5.3.1 Exact delta';
const RESOURCE_ROW = /^([a-z][a-z0-9_.]*):\s*(.+)$/;
const KEY_ROW = /^[a-z][a-z0-9_.]*\.[a-z][a-z0-9_]*$/;

/** Returns the contents of the first ```text block after `heading`. */
function codeBlockAfter(markdown, heading) {
  const headingIndex = markdown.indexOf(heading);
  if (headingIndex === -1) {
    throw new Error(`API.md heading not found: ${heading}`);
  }
  const fenceStart = markdown.indexOf('```text', headingIndex);
  if (fenceStart === -1) {
    throw new Error(`no text code block after heading: ${heading}`);
  }
  const contentStart = markdown.indexOf('\n', fenceStart) + 1;
  const fenceEnd = markdown.indexOf('```', contentStart);
  if (contentStart <= 0 || fenceEnd === -1) {
    throw new Error(`unterminated text code block after heading: ${heading}`);
  }
  return markdown.slice(contentStart, fenceEnd);
}

/**
 * Expands the §5.2 registry rows (`resource: action, action`) into full
 * `resource.action` keys. Returns keys in source order.
 */
export function extractRegistry(markdown) {
  const block = codeBlockAfter(markdown, REGISTRY_HEADING);
  const keys = [];
  const seen = new Set();
  const rows = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const row of rows) {
    const match = RESOURCE_ROW.exec(row);
    if (match === null) {
      throw new Error(`unparsable §5.2 registry row: ${JSON.stringify(row)}`);
    }
    const resource = match[1];
    const actions = match[2]
      .split(',')
      .map((action) => action.trim())
      .filter((action) => action.length > 0);
    if (actions.length === 0) {
      throw new Error(`registry row without actions: ${JSON.stringify(row)}`);
    }
    for (const action of actions) {
      const key = `${resource}.${action}`;
      if (seen.has(key)) {
        throw new Error(`duplicate permission key in §5.2: ${key}`);
      }
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/** Returns the §5.3.1 delta keys (one full key per line). */
export function extractDelta(markdown) {
  const block = codeBlockAfter(markdown, DELTA_HEADING);
  const keys = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const key of keys) {
    if (!KEY_ROW.test(key)) {
      throw new Error(`unparsable §5.3.1 delta key: ${JSON.stringify(key)}`);
    }
  }
  return keys;
}

/** Union of the §5.2 registry and §5.3.1 delta, sorted and deduplicated. */
export function extractPermissions(markdown = readFileSync(API_CONTRACT_PATH, 'utf8')) {
  const registry = extractRegistry(markdown);
  const delta = extractDelta(markdown);
  const union = new Set([...registry, ...delta]);
  const keys = [...union].sort();
  return { registry, delta, keys };
}

/** Renders the generated TypeScript module. */
export function renderGeneratedModule({ registry, delta, keys }) {
  const quote = (key) => `  '${key}',`;
  const lines = [
    '// AUTO-GENERATED FILE — DO NOT EDIT BY HAND.',
    '// Source of truth: docs/03-api-contract/API.md §5.2 (authoritative registry)',
    '// plus §5.3.1 (keys referenced by the API catalog that seed must add).',
    '// Regenerate: pnpm --filter @saman/shared gen:permissions',
    '// CI guard: packages/shared/test/permissions.spec.ts fails on drift.',
    '',
    '/** Every permission key referenced by the v1 API contract, sorted. */',
    'export const PERMISSION_KEYS = [',
    ...keys.map(quote),
    '] as const;',
    '',
    '/** Provenance counts, useful for seed/CI assertions. */',
    'export const PERMISSION_REGISTRY_STATS = {',
    `  registry: ${registry.length},`,
    `  delta: ${delta.length},`,
    `  total: ${keys.length},`,
    '} as const;',
    '',
    'export type PermissionKey = (typeof PERMISSION_KEYS)[number];',
    '',
  ];
  return lines.join('\n');
}

/** Writes the generated module; returns true when the file changed. */
export function writeGeneratedModule(source = API_CONTRACT_PATH, target = GENERATED_PATH) {
  const markdown = readFileSync(source, 'utf8');
  const extraction = extractPermissions(markdown);
  const content = renderGeneratedModule(extraction);
  let previous = '';
  try {
    previous = readFileSync(target, 'utf8');
  } catch {
    previous = '';
  }
  if (previous === content) {
    return { changed: false, extraction };
  }
  writeFileSync(target, content, 'utf8');
  return { changed: true, extraction };
}

const CHECK = process.argv.includes('--check');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (CHECK) {
    const extraction = extractPermissions();
    const current = readFileSync(GENERATED_PATH, 'utf8');
    if (current !== renderGeneratedModule(extraction)) {
      console.error('permissions registry drift: run `pnpm --filter @saman/shared gen:permissions`');
      process.exit(1);
    }
    console.log(`permissions registry is in sync (${extraction.keys.length} keys)`);
  } else {
    const { changed, extraction } = writeGeneratedModule();
    console.log(
      `${changed ? 'generated' : 'unchanged'} ${path.relative(process.cwd(), GENERATED_PATH)}: ` +
        `${extraction.keys.length} keys (${extraction.registry.length} registry + ${extraction.delta.length} delta)`,
    );
  }
}
