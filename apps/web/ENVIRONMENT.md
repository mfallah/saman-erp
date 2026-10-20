/**
 * Workspace note for the web package.
 *
 * Local environment requirements (see APP documentation):
 * - `pnpm install --ignore-scripts --shamefully-hoist` is required in the
 *   reference sandbox because Node cannot resolve transitive dependencies
 *   through pnpm's isolated directory junctions there.
 * - `pnpm_config_verify_deps_before_run=false` prevents pnpm 11 from silently
 *   running an isolated install before `pnpm build/test`.
 * - Vite runs with `--configLoader native` and an in-process TypeScript
 *   transform (`vite-plugins/typescript.ts`) because esbuild's service process
 *   cannot spawn in the sandbox.
 * - `pnpm test` (Vitest) is the CI gate; `pnpm test:node` runs the pure-utility
 *   tests with Node's built-in test runner where Vitest's worker pool is
 *   unavailable.
 */
export {};
