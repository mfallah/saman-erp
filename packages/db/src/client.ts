/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * postgres.js client.
 *
 * `postgres` is a runtime dependency; it is loaded through CJS `require` so the
 * package still type-checks and builds in the offline profile where the package
 * registry is unreachable (dependency installation is verified separately by ops).
 */
declare const require: (id: string) => unknown;

export interface Sql {
  <T = any>(strings: TemplateStringsArray, ...values: any[]): Promise<T>;
  unsafe<T = any>(query: string, params?: unknown[]): Promise<T>;
  begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  end(opts?: { timeout?: number }): Promise<void>;
}
export type Db = Sql;

type PostgresFactory = (url: string, opts?: Record<string, unknown>) => Sql;
let factory: PostgresFactory | undefined;

function loadPostgres(): PostgresFactory {
  if (factory) return factory;
  try {
    factory = require('postgres') as PostgresFactory;
  } catch {
    throw new Error("DATABASE_DRIVER_MISSING: install the 'postgres' package (pnpm install) to use @saman/db at runtime");
  }
  return factory;
}

/** Create the process-wide postgres.js client. One pool per process (ARCHITECTURE §6). */
export function createDb(url = process.env.DATABASE_URL, opts: Record<string, unknown> = {}): Sql {
  if (!url) throw new Error('DATABASE_URL is required');
  const postgres = loadPostgres();
  return postgres(url, {
    max: Number(process.env.DB_POOL_MAX ?? 20),
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: true,
    onnotice: () => undefined,
    ...opts,
  });
}

export const DB_ROLES = ['saman_migrator', 'saman_app', 'saman_worker', 'saman_readonly'] as const;
