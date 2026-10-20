import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { staticSpaHtmlPlugin } from './vite-plugins/static-spa-html.ts';
import { typescriptTransformPlugin } from './vite-plugins/typescript.ts';

/**
 * SPA dev/build configuration (ADR-0011).
 * - Same-origin `/api` in production; dev proxy to the reference API on :4000.
 * - Route-level code splitting is achieved with `lazyRouteComponent`.
 * - `esbuild: false` + `typescriptTransformPlugin()` keeps the build working in
 *   the sandboxed reference environment (no child-process spawning); the strict
 *   `tsc --noEmit` gate in `pnpm build` remains the type authority.
 */
export default defineConfig({
  plugins: [typescriptTransformPlugin(), react(), tailwindcss(), staticSpaHtmlPlugin()],
  esbuild: false,
  environments: {
    client: {
      // Never let Vite replace `process.env.*` with esbuild; the in-process
      // plugin handles NODE_ENV so dependency code does not trigger the define
      // transform (which spawns esbuild).
      keepProcessEnv: true,
    },
  },
  resolve: {
    // pnpm installs packages through directory junctions; resolving the real
    // path needs a `net use` child process on Windows (denied in sandboxes).
    preserveSymlinks: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: false,
        secure: false,
      },
    },
  },
  css: {
    // Tailwind v4 is handled by @tailwindcss/vite. An explicit empty PostCSS
    // config stops Vite from walking up to the repo-root package.json (which is
    // UTF-8-BOM encoded and cannot be JSON-parsed by postcss-load-config).
    postcss: { plugins: [] },
  },
  build: {
    sourcemap: false,
    target: 'es2022',
    outDir: 'dist',
    // esbuild is unavailable in the sandbox; ship unminified assets instead.
    minify: false,
    cssMinify: false,
    rollupOptions: {
      // Custom HTML emitter (`staticSpaHtmlPlugin`) is used instead of Vite's
      // HTML pipeline, which internally spawns esbuild for inline scripts.
      input: { main: resolve(process.cwd(), 'src/main.tsx') },
    },
  },
});
