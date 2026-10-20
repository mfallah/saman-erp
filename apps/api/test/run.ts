/**
 * Spawn-free test runner (same approach as `@saman/shared`).
 *
 * `npm test` compiles `src` + `test` with `tsc` and runs every compiled `*.spec`
 * file in-process with Node's built-in test runner and Jest's standalone
 * `expect`. `vitest.config.ts` remains for normal CI environments
 * (`pnpm test:vitest`), where esbuild/worker spawning is available.
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
