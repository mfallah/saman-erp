/**
 * Pagination helpers shared by controllers (`API.md` §1.5).
 *
 * The primitives live in `@saman/shared`; this module adds the controller-level
 * page shape so feature modules do not re-invent response metadata.
 */
import {
  buildCursorMeta,
  buildOffsetMeta,
  toSqlOffset,
  type CursorPaginationQuery,
  type OffsetPaginationQuery,
  type PaginationMeta,
} from '@saman/shared';

export {
  CursorPaginationQuery,
  OffsetPaginationQuery,
  buildCursorMeta,
  buildOffsetMeta,
  toSqlOffset,
};
export type { PaginationMeta };

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly meta: PaginationMeta;
}

export interface OffsetPage<T> {
  readonly items: readonly T[];
  readonly meta: PaginationMeta;
}

/** Builds a cursor page envelope from a fetched batch (caller adds `limit + 1`). */
export function cursorPage<T>(
  rows: readonly T[],
  query: CursorPaginationQuery,
  toCursor: (row: T) => string,
): CursorPage<T> {
  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const last = items.at(-1);
  return {
    items,
    meta: buildCursorMeta(query.limit, {
      hasMore,
      ...(hasMore && last !== undefined ? { nextCursor: toCursor(last) } : {}),
    }),
  };
}

/** Builds an offset page envelope from a fetched batch and a known total. */
export function offsetPage<T>(
  rows: readonly T[],
  query: OffsetPaginationQuery,
  total: number,
): OffsetPage<T> {
  return { items: rows, meta: buildOffsetMeta(query.page, query.perPage, total) };
}
