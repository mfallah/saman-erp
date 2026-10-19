import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * SPA dev/build configuration (ADR-0011).
 * - Same-origin `/api` in production; dev proxy to the reference API on :4000.
 * - Route-level code splitting is achieved with `lazyRouteComponent`.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
  build: {
    sourcemap: false,
    target: 'es2022',
    outDir: 'dist',
  },
});
