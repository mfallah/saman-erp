/**
 * Persistence helpers shared by the accounting repositories.
 *
 * Money crosses the SQL boundary as `text` (never `number`) and is converted to
 * `bigint` in one place. `DB` is injected as the `postgres.js` client; every
 * mutation takes the caller's transaction so multi-step flows stay atomic
 * (ARCHITECTURE §6).
 */
import type { Sql, TransactionSql } from 'postgres';
import { AppError } from '@saman/shared';
import type { Db } from '../../../common/contracts';

export type SqlClient = Sql;

/**
 * A query surface that is either the pool or an open transaction. Multi-step
 * flows take the caller's `TransactionSql`; single reads may use the pool.
 */
export type SqlSession = Sql | TransactionSql;

/**
 * The foundation `AUDIT`/`EVENT_BUS` ports type their `tx` parameter as the pool
 * `Sql` (`common/contracts.ts`), while a transaction is a `TransactionSql`. At
 * runtime both are postgres.js query surfaces, so this narrow adapter keeps the
 * cast in exactly one place instead of at every call site.
 */
export function asDb(session: SqlSession): Db {
  return session as unknown as Db;
}

export function parseMoneyText(value: string | null): bigint {
  if (value === null || value === '') return 0n;
  return BigInt(value);
}

export function parseMoneyTextOr(value: string | null, fallback: bigint): bigint {
  if (value === null || value === '') return fallback;
  return BigInt(value);
}

export function moneyParam(value: bigint): string {
  return value.toString();
}

export function idParam(value: bigint): string {
  return value.toString();
}

export function notFound(entityFa: string): AppError {
  return new AppError('NOT_FOUND', { message: `${entityFa} یافت نشد.` });
}

export function conflict(messageFa: string): AppError {
  return new AppError('CONFLICT', { message: messageFa });
}

export interface Pagination {
  readonly limit: number;
  readonly offset: number;
}

export function normalisePagination(input: { readonly limit?: number; readonly offset?: number }): Pagination {
  const limit = input.limit === undefined ? 50 : Math.min(Math.max(input.limit, 1), 200);
  const offset = input.offset === undefined ? 0 : Math.max(input.offset, 0);
  return { limit, offset };
}

/** ISO date (YYYY-MM-DD) guard used before writing a `date` column. */
export function assertIsoDate(value: string, field = 'date'): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field, rule: 'iso_date' }],
      message: 'تاریخ واردشده معتبر نیست.',
    });
  }
  return value;
}
