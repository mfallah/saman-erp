/// <reference types="vitest" />
/**
 * Vitest config for normal CI environments (`pnpm test:vitest`).
 *
 * The default `test` script uses `tsc` + Node's built-in runner because this
 * repository is also developed inside a sandbox that denies the process spawning
 * Vitest/Vite needs (esbuild service + worker pool). Both runners execute the
 * same `test/**/*.spec.ts` files.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
  },
});
