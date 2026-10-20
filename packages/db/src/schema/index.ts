/**
 * Typed schema manifest (single source of truth for DDL, seed and future ORM adapters).
 *
 * NOTE (v1.1, offline build): the build environment has no network access and
 * `drizzle-orm`/`drizzle-kit` are not present in the pnpm store, so the schema is
 * expressed as a framework-neutral typed manifest and the SQL migration is generated
 * from it (`drizzle/0001_init.sql`). A Drizzle adapter can be generated 1:1 from this
 * manifest when the dependency becomes installable — see MIGRATION-STATUS.md.
 */
export { TABLES, type TableSpec } from './spec.js';
