/**
 * Purchasing row mapping helpers.
 *
 * `@saman/db` is not published yet, so purchasing talks raw `postgres.js` through
 * this small structural interface instead of leaking `as any` (same rationale as
 * `inventory/inventory.pg-support.ts` and `catalog/pg-support.ts`).
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

/** Money columns (`bigint` IRR) are transported as integer strings (`ADR-0013`). */
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

export function validation(field: string, rule: string, message?: string, messageKey?: string): AppError {
  return new AppError('VALIDATION_ERROR', {
    ...(message === undefined ? {} : { message }),
    ...(messageKey === undefined ? {} : { messageKey }),
    details: [{ field, rule }],
  });
}

/** True for a Postgres unique-violation (`23505`), used for retry/conflict mapping. */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as Record<string, unknown>)['code'] === '23505';
}
