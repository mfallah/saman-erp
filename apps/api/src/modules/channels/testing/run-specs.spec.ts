/**
 * Spawn-free spec runner for this module (the sandbox rejects `node --test`
 * child processes and Vitest/esbuild workers). Imports each spec in-process with
 * Node's built-in test runner; exits non-zero on failure.
 *
 * Usage: node --import tsx src/modules/channels/testing/run-specs.ts
 */
void (async () => {
  await import('../domain/webhook-signature.spec');
  await import('../adapters/carexy/carexy.adapter.spec');
  await import('../adapters/digikala/digikala.adapter.spec');
})();
