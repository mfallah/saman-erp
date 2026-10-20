/**
 * Sales row-mapping helpers. `@saman/db` is not published yet, so sales SQL is raw
 * `postgres.js` with local row interfaces (same pattern as catalog/inventory).
 */
import { AppError } from '@saman/shared';

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

export type BigIntish = string | number | bigint;

export function toBigInt(value: BigIntish | null | undefined): bigint {
  if (value === null || value === undefined) throw new RangeError('expected_non_null_bigint');
  return typeof value === 'bigint' ? value : BigInt(value);
}

export function toBigIntOrNull(value: BigIntish | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'bigint' ? value : BigInt(value);
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

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
