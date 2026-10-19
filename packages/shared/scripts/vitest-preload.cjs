/**
 * Vitest preload shim for constrained Windows sandboxes.
 *
 * Vite probes network drives once on Windows via `exec('net use')`; the sandbox
 * denies spawning child processes (EPERM), which would abort every test run.
 * Vite catches `EISDIR` from `fs.realpathSync.native(cwd)` and falls back to the
 * plain implementation without spawning anything, so we surface exactly that
 * error for the process working directory and leave every other path untouched.
 *
 * Loaded with `node --require` before Vite/Vitest is imported (see package.json).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const originalNative = fs.realpathSync.native;
const workingDirectory = path.resolve(process.cwd());

fs.realpathSync.native = function patchedNativeRealpath(target, ...rest) {
  try {
    const resolved = path.resolve(String(target));
    if (resolved === workingDirectory) {
      const error = new Error(
        `EISDIR: illegal operation on a directory, realpath '${resolved}'`,
      );
      error.code = 'EISDIR';
      throw error;
    }
  } catch (error) {
    if (error instanceof Error && error.code === 'EISDIR') {
      throw error;
    }
  }
  return originalNative.call(fs.realpathSync, target, ...rest);
};
