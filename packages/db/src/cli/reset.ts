import { createDb } from '../client.js';
import { migrate } from '../migrate.js';
import { seed } from '../seed.js';

/**
 * DESTRUCTIVE dev/test utility: drop the `erp` schema and the migration ledger,
 * then re-run migrations + seed. Requires `--yes` in non-development environments.
 *   pnpm --filter @saman/db reset -- --yes
 */
async function main(): Promise<void> {
  const yes = process.argv.includes('--yes') || process.env.APP_ENV === 'development';
  if (!yes) {
    console.error('[reset] refusing: pass --yes (or APP_ENV=development). This DROPS schema erp.');
    process.exit(2);
  }
  const sql = createDb();
  try {
    console.log('[reset] dropping schema erp ...');
    await sql.unsafe('DROP SCHEMA IF EXISTS erp CASCADE');
    await sql.unsafe('DROP TABLE IF EXISTS public.schema_migrations');
  } finally {
    await sql.end({ timeout: 5 });
  }
  const { applied } = await migrate();
  console.log(`[reset] migrations applied: ${applied.length}`);
  await seed();
  console.log('[reset] done');
}

main().catch((err) => {
  console.error('[reset] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
