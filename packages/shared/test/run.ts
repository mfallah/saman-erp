/**
 * Spawn-free test runner.
 *
 * `npm test` compiles `src` + `test` with `tsc` and then executes this file.
 * Each `*.spec` registers its cases with Node's built-in test runner
 * (`node:test`) and assertions use Jest's standalone `expect` — no esbuild,
 * Vite or worker processes are started, which keeps the suite runnable inside
 * restricted sandboxes. `vitest.config.ts` is kept for normal CI environments
 * (`pnpm test:vitest`).
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const testDirectory = __dirname;

async function main(): Promise<void> {
  const specs = readdirSync(testDirectory)
    .filter((file) => file.endsWith('.spec.js'))
    .sort();
  for (const spec of specs) {
     
    await import(join(testDirectory, spec));
  }
}

void main();
