import { defineConfig } from 'vitest/config';
import { typescriptTransformPlugin } from './vite-plugins/typescript.ts';

/**
 * Vitest runs through the same in-process TypeScript transform as the build
 * (see `vite-plugins/typescript.ts`); the threads pool is used because the
 * sandbox denies `child_process` spawning (Vitest's default forks pool).
 */
export default defineConfig({
  plugins: [typescriptTransformPlugin()],
  esbuild: false,
  resolve: {
    preserveSymlinks: true,
    dedupe: ['react', 'react-dom', 'react-dom/client'],
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    restoreMocks: true,
    pool: 'threads',
    server: {
      deps: {
        // Inline the React-ecosystem packages so their `react` imports are
        // resolved by one Vite module graph (externalized copies can load a
        // second React instance in jsdom and hooks then see a null dispatcher).
        inline: true,
      },
    },
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
  },
});
