/**
 * Thin database façade.
 *
 * `@saman/db` (Drizzle schema, migrations, seed, transaction helpers) is owned by
 * the database teammate and is not published yet. Feature modules must import the
 * `DB` token from `../common/contracts`; when `packages/db` lands this file
 * becomes the single re-export point (add `"@saman/db": "workspace:*"` to
 * `apps/api/package.json` and re-export its schema/types here) so no feature code
 * changes.
 */
export const DB_SCHEMA = 'erp' as const;

/** Schema-qualified table name helper (kept for future `@saman/db` integration). */
export function tableName(table: string): string {
  return `${DB_SCHEMA}.${table}`;
}
