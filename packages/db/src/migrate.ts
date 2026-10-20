import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDb } from './client.js';

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? resolve(process.cwd(), 'drizzle');

/**
 * Forward-only SQL migration runner.
 * - one transaction per migration file (files may also contain their own BEGIN/COMMIT-free SQL);
 * - applied versions tracked in public.schema_migrations with checksum;
 * - refuses to run if an applied migration's checksum changed (drift protection).
 */
export async function migrate(url = process.env.DATABASE_URL): Promise<{ applied: string[]; skipped: string[] }> {
  const sql = createDb(url);
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await sql`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL DEFAULT 0
    )`;
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    if (files.length === 0) throw new Error('no .sql migrations in ' + MIGRATIONS_DIR);
    const rows = await sql<{ version: string; checksum: string }[]>`SELECT version, checksum FROM public.schema_migrations`;
    const already = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const file of files) {
      const body = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex');
      const prev = already.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`MIGRATION_DRIFT: ${file} changed after being applied`);
        skipped.push(file);
        continue;
      }
      const started = Date.now();
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO public.schema_migrations (version, checksum, duration_ms) VALUES (${file}, ${checksum}, ${Date.now() - started})`;
      });
      applied.push(file);
      console.log(`[migrate] applied ${file}`);
    }
    return { applied, skipped };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/* eslint-disable @typescript-eslint/no-var-requires */
declare const require: NodeJS.Require;
declare const module: NodeJS.Module;

if (require.main === module) {
  migrate()
    .then(({ applied, skipped }) => console.log(`[migrate] done: applied=${applied.length} skipped=${skipped.length}`))
    .catch((err) => {
      console.error('[migrate] FAILED:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
