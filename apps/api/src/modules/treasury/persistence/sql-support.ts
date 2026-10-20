/**
 * Treasury persistence helpers (mirrors the accounting module's adapter so the
 * two modules share no internal files — table/module ownership stays exclusive).
 */
import type { Sql, TransactionSql } from 'postgres';
import { AppError } from '@saman/shared';
import type { Db } from '../../../common/contracts';

export type SqlSession = Sql | TransactionSql;

/** Adapter for the foundation ports whose `tx` parameter is typed as the pool. */
export function asDb(session: SqlSession): Db {
  return session as unknown as Db;
}

export function notFound(entityFa: string): AppError {
  return new AppError('NOT_FOUND', { message: `${entityFa} یافت نشد.` });
}

export function conflict(messageFa: string): AppError {
  return new AppError('CONFLICT', { message: messageFa });
}

export function validation(messageFa: string, field?: string, rule?: string): AppError {
  return new AppError('VALIDATION_ERROR', {
    ...(field === undefined ? {} : { details: [{ field, rule: rule ?? 'invalid' }] }),
    message: messageFa,
  });
}
