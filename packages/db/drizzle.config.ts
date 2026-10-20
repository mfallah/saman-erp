/**
 * Placeholder Drizzle Kit configuration.
 *
 * It is intentionally excluded from `tsc` (package tsconfig includes only src/**).
 * When `drizzle-kit` becomes installable in this offline-profile workspace, the
 * generated Drizzle schema files (produced 1:1 from `src/schema/spec.ts`) can be
 * pointed at by this config:
 *
 *   pnpm --filter @saman/db add -D drizzle-kit drizzle-orm
 *   pnpm --filter @saman/db exec drizzle-kit generate
 *
 * Until then, `pnpm --filter @saman/db generate` produces `drizzle/0001_init.sql`
 * directly from the manifest (deterministic, hand-shaped: triggers, partitions,
 * grants, EXCLUDE constraints).
 */
export default {
  schema: './src/schema/**/*.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  schemaFilter: ['erp'],
  casing: 'snake_case',
  verbose: true,
  strict: true,
};
