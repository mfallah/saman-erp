import { AppError } from '@saman/shared';

/**
 * Minimal structural database interface for commerce modules.
 *
 * `postgres.js` exposes `Sql`/`TransactionSql` with a generic parameter type that
 * makes `bigint` parameters unusable (`ParameterOrFragment<never>`) and makes a
 * transaction non-assignable to the pool type. Instead of leaking `as any` (which
 * the quality bar forbids), commerce repositories depend on this small structural
 * interface: the tagged-template call, `unsafe`, and `begin`. The injected
 * `postgres.js` pool satisfies it at runtime and the transaction callback is typed
 * as the same interface, so no casts are needed inside business code.
 *
 * When `@saman/db` publishes typed query helpers this file becomes a re-export.
 */

/** Result of a query: rows are whatever the caller's row interface says. */
export interface Queryable {
  <T = Record<string, unknown>>(
    template: TemplateStringsArray,
    ...parameters: readonly unknown[]
  ): PromiseLike<T>;
  unsafe<T = Record<string, unknown>>(query: string, parameters?: readonly unknown[]): PromiseLike<T>;
}

/** Pool + transaction capability used by services. */
export interface Db extends Queryable {
  begin<T>(callback: (tx: Db) => T | Promise<T>): Promise<T>;
}

/** Narrows an injected pool/transaction to the commerce `Db` interface. */
export function asDb(value: unknown): Db {
  return value as Db;
}

/** Shape of an `int8`/`numeric` column as returned by postgres.js. */
export type BigIntish = string | number | bigint;
export type Timestampish = Date | string;

export function toBigInt(value: BigIntish | null | undefined): bigint {
  if (value === null || value === undefined) throw new RangeError('expected_non_null_bigint');
  return typeof value === 'bigint' ? value : BigInt(value);
}

export function toBigIntOrNull(value: BigIntish | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'bigint' ? value : BigInt(value);
}

export function toIso(value: Timestampish | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toIsoRequired(value: Timestampish): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Converts a `numeric`/`bigint` column to its integer-string transport form. */
export function moneyString(value: BigIntish | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'bigint' ? value.toString() : String(value);
}

export function requireRow<T>(row: T | undefined, error: AppError): T {
  if (row === undefined) throw error;
  return row;
}

export function notFound(entity: string): AppError {
  return new AppError('NOT_FOUND', {
    message: `مورد درخواستی (${entity}) یافت نشد.`,
    details: [{ rule: 'not_found', params: { entity } }],
  });
}

export function conflict(rule: string, params?: Record<string, string>): AppError {
  return new AppError('CONFLICT', {
    message: 'مقداری تکراری است و با داده‌های موجود تعارض دارد.',
    details: [{ rule, ...(params === undefined ? {} : { params }) }],
  });
}

/** Maps a PostgreSQL unique-violation (`23505`) to a stable field conflict error. */
export function mapUniqueViolation(error: unknown, entity: string, field: string): never {
  const code = textProperty(error, 'code');
  if (code === '23505') {
    throw new AppError('CONFLICT', {
      message: 'مقداری تکراری است و با داده‌های موجود تعارض دارد.',
      messageKey: 'error.conflict',
      details: [{ field, rule: `${entity}_${field}_conflict` }],
    });
  }
  throw error;
}

function textProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** Server "now" as an ISO timestamp for payloads/audit (clock stays server-side). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Reads `If-Match: "7"` style header into a numeric version (or undefined). */
export function parseIfMatch(header: string | undefined): number | undefined {
  if (header === undefined) return undefined;
  const match = /^"?(\d+)"?$/.exec(header.trim());
  return match === null ? undefined : Number(match[1]);
}

export function versionConflict(currentVersion: number, providedVersion: number): AppError {
  return new AppError('VERSION_CONFLICT', {
    details: [
      {
        rule: 'version_conflict',
        params: { currentVersion, providedVersion },
      },
    ],
  });
}
