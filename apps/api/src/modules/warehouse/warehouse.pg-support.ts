/**
 * Warehouse row-mapping helpers (same structural `Db` pattern as the other
 * commerce modules — see `catalog/pg-support.ts` for the rationale).
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

export type BigIntish = string | number | bigint;

export function toBigInt(value: BigIntish | null | undefined): bigint {
  if (value === null || value === undefined) throw new RangeError('expected_non_null_bigint');
  return typeof value === 'bigint' ? value : BigInt(value);
}

export function toBigIntOrNull(value: BigIntish | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'bigint' ? value : BigInt(value);
}

export function toText(value: BigIntish | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'bigint' ? value.toString() : String(value);
}

import { AppError } from '@saman/shared';

export function notFound(entity: string): AppError {
  return new AppError('NOT_FOUND', {
    message: `مورد درخواستی (${entity}) یافت نشد.`,
    details: [{ rule: 'not_found', params: { entity } }],
  });
}
