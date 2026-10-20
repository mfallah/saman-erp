/**
 * Transaction helper. `postgres.js` transaction handles lack `begin`, while the
 * seam exports `Db` as the pool type; this one contained cast keeps repositories
 * honest without `any`.
 */
import type { Db } from '../../../common/contracts';

export type Queryable = Db;

export async function withTransaction<T>(db: Db, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const result = await db.begin(async (tx) => fn(tx as unknown as Queryable));
  return result as T;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

export function asString(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

export function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

export function asRecord(value: unknown): Record<string, unknown> {
  // postgres.js may hand back `jsonb` as a JSON string (driver/PgBouncer
  // dependent); parse it instead of silently returning an empty object.
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}
