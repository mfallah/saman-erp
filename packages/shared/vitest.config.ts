/**
 * Vitest config for `@saman/shared`.
 *
 * `pool: 'threads'` keeps the suite inside the process (no child-process spawn),
 * which is required in the constrained CI sandbox; see `scripts/vitest-preload.cjs`.
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
