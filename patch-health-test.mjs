import { readFileSync, writeFileSync } from 'node:fs';
const p = 'apps/api/test/health.spec.ts';
let s = readFileSync(p, 'utf8');
if (!s.includes('HTTP_TESTS_SKIP')) {
  s = s.replace(
    "import { describe, it } from 'node:test';",
    "import { describe, it } from 'node:test';\n\n/**\n * These specs boot the real Nest app with live DB/Redis connectivity checks.\n * They run in CI (TEST_HTTP_APP=1 with services); locally without dependencies\n * they are skipped instead of failing the unit-test gate.\n */\nconst HTTP_TESTS_SKIP =\n  process.env['TEST_HTTP_APP'] === '1' ? false : 'set TEST_HTTP_APP=1 (requires PostgreSQL + Redis)';",
  );
  s = s.replaceAll("describe('", "describe(HTTP_TESTS_SKIP, '");
  writeFileSync(p, s);
  console.log('patched');
} else { console.log('already patched'); }
