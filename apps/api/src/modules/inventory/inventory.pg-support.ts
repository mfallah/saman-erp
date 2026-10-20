/**
 * Inventory row mapping helpers. `@saman/db` is not published yet, so inventory
 * SQL is raw `postgres.js` with local row interfaces (like catalog).
 */
import { AppError } from '@saman/shared';

/**
 * Structural query interface (see `catalog/pg-support.ts` for the rationale):
 * `postgres.js` generics make `bigint` parameters unusable and a transaction is
 * not assignable to the pool type, so commerce repositories depend on this small
 * interface instead of leaking `as any`.
 */
export interface Queryable {
  <T = Record<string, unknown>>(
    template: TemplateStringsArray,
    ...parameters: readonly unknown[]
  ): PromiseLike<T>;
  unsafe<T = Record<string, unknown>>(query: string, parameters?: readonly unknown[]): PromiseLike<T>;
}

export interface Db extends Queryable {
  begin<T>(callback: (tx: Db) => T | Promise<T>): Promise<T>;
}

export function asDb(value: unknown): Db {
  return value as Db;
}
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

export function moneyString(value: BigIntish | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'bigint' ? value.toString() : String(value);
}

export function notFound(entity: string): AppError {
  return new AppError('NOT_FOUND', {
    message: `مورد درخواستی (${entity}) یافت نشد.`,
    details: [{ rule: 'not_found', params: { entity } }],
  });
}

export function conflict(rule: string): AppError {
  return new AppError('CONFLICT', { details: [{ rule }] });
}

export function mapUniqueViolation(error: unknown, rule: string): never {
  const code =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>)['code'] : undefined;
  if (code === '23505') {
    throw new AppError('CONFLICT', { details: [{ rule }] });
  }
  throw error;
}

export function parseIfMatch(header: string | undefined): number | undefined {
  if (header === undefined) return undefined;
  const match = /^"?(\d+)"?$/.exec(header.trim());
  return match === null ? undefined : Number(match[1]);
}

export function versionConflict(currentVersion: number, providedVersion: number): AppError {
  return new AppError('VERSION_CONFLICT', {
    details: [{ rule: 'version_conflict', params: { currentVersion, providedVersion } }],
  });
}

export function nowIso(): string {
  return new Date().toISOString();
}
