/**
 * Vitest launcher for constrained Windows sandboxes.
 *
 * Running the `vitest` CLI on Windows makes Vite probe network drives through
 * `exec('net use')`; the sandbox denies spawning processes (EPERM). We patch that
 * probe (the EISDIR fallback Vite already understands) *before* loading Vitest,
 * and load Vitest through its real (pnpm store) path so Node can resolve its own
 * dependencies. The suite then runs with the `threads` pool (no process spawn).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const originalNativeRealpath = fs.realpathSync.native;
const workingDirectory = path.resolve(process.cwd());

fs.realpathSync.native = function patchedNativeRealpath(target, ...rest) {
  const resolved = path.resolve(String(target));
  if (resolved === workingDirectory) {
    const error = new Error(`EISDIR: illegal operation on a directory, realpath '${resolved}'`);
    error.code = 'EISDIR';
    throw error;
  }
  return originalNativeRealpath.call(fs.realpathSync, target, ...rest);
};

const cliEntry = fs.realpathSync(path.resolve(process.cwd(), 'node_modules/vitest/vitest.mjs'));
process.argv = [process.argv[0], cliEntry, 'run', ...process.argv.slice(2)];
await import(pathToFileURL(cliEntry).href);
