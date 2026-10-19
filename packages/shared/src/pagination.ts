/**
 * Pagination, filtering and sorting primitives (`API.md` §1.5–§1.7).
 *
 * Two modes are part of each endpoint contract: opaque keyset cursors for
 * high-volume append-only resources and offset paging for small admin lists.
 * Cursor payloads are base64url JSON bound to the caller's filter/sort set by the
 * feature module; this module only owns the envelope, limits and safety guards.
 */
import { z } from 'zod';

import { AppError } from './errors';

export const DEFAULT_LIMIT = 50;
export const DEFAULT_UI_LIMIT = 25;
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 500;

export const DEFAULT_PAGE = 1;
export const DEFAULT_PER_PAGE = 25;
export const MAX_PER_PAGE = 200;

/** Deep offsets are rejected instead of scanning `OFFSET 900000`. */
export const MAX_OFFSET = 10_000;

export const MAX_SORT_KEYS = 3;
export const MAX_IN_VALUES = 100;

export const PaginationMode = z.enum(['cursor', 'offset']);
export type PaginationMode = z.infer<typeof PaginationMode>;

/** Query schema for cursor-paginated endpoints (`?limit=&cursor=&direction=`). */
export const CursorPaginationQuery = z.object({
  limit: z.coerce.number().int().min(MIN_LIMIT).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).max(2048).optional(),
  direction: z.enum(['forward', 'backward']).default('forward'),
});
export type CursorPaginationQuery = z.infer<typeof CursorPaginationQuery>;

/** Query schema for offset-paginated endpoints (`?page=&perPage=&sort=`). */
export const OffsetPaginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(DEFAULT_PAGE),
  perPage: z.coerce.number().int().min(MIN_LIMIT).max(MAX_PER_PAGE).default(DEFAULT_PER_PAGE),
  sort: z.string().max(200).optional(),
});
export type OffsetPaginationQuery = z.infer<typeof OffsetPaginationQuery>;

export interface CursorPaginationMeta {
  mode: 'cursor';
  limit: number;
  nextCursor?: string;
  prevCursor?: string;
  hasMore: boolean;
}

export interface OffsetPaginationMeta {
  mode: 'offset';
  page: number;
  perPage: number;
  totalPages: number;
  total: number;
}

export type PaginationMeta = CursorPaginationMeta | OffsetPaginationMeta;

export interface CursorPayload {
  /** Value of the primary sort key for the last/next row. */
  sortKey: string;
  /** Stable tiebreaker: the resource's public UUID. */
  id: string;
  /** Filter/sort fingerprint to reject cross-filter cursor reuse. */
  scope?: string;
}

const CURSOR_JSON = /^[A-Za-z0-9_-]+$/;

/** Encodes an opaque cursor payload as base64url (no padding). */
export function encodeCursor(payload: CursorPayload): string {
  if (!payload.id || !payload.sortKey) {
    throw new RangeError('invalid_cursor_payload');
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Decodes and validates an opaque cursor; tampering maps to `VALIDATION_ERROR`. */
export function decodeCursor(cursor: string): CursorPayload {
  if (!CURSOR_JSON.test(cursor)) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'cursor', rule: 'invalid_cursor' }],
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'cursor', rule: 'invalid_cursor' }],
    });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'cursor', rule: 'invalid_cursor' }],
    });
  }
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate['sortKey'] !== 'string' || typeof candidate['id'] !== 'string') {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'cursor', rule: 'invalid_cursor' }],
    });
  }
  const payload: CursorPayload = { sortKey: candidate['sortKey'], id: candidate['id'] };
  if (typeof candidate['scope'] === 'string') {
    return { ...payload, scope: candidate['scope'] };
  }
  return payload;
}

/** Builds the `meta.pagination` object for a cursor list. */
export function buildCursorMeta(
  limit: number,
  options: { nextCursor?: string; prevCursor?: string; hasMore?: boolean } = {},
): CursorPaginationMeta {
  return {
    mode: 'cursor',
    limit,
    ...(options.nextCursor === undefined ? {} : { nextCursor: options.nextCursor }),
    ...(options.prevCursor === undefined ? {} : { prevCursor: options.prevCursor }),
    hasMore: options.hasMore ?? options.nextCursor !== undefined,
  };
}

/** Builds the `meta.pagination` object for an offset list. */
export function buildOffsetMeta(page: number, perPage: number, total: number): OffsetPaginationMeta {
  return {
    mode: 'offset',
    page,
    perPage,
    totalPages: total === 0 ? 0 : Math.ceil(total / perPage),
    total,
  };
}

/** Converts offset paging into SQL `LIMIT`/`OFFSET`, rejecting deep offsets. */
export function toSqlOffset(query: OffsetPaginationQuery): { limit: number; offset: number } {
  const offset = (query.page - 1) * query.perPage;
  if (offset > MAX_OFFSET) {
    throw new AppError('RULE_VIOLATION', {
      message: 'پیمایش بیش از حد عمیق است؛ از فیلترها استفاده کنید.',
      messageKey: 'pagination.deep_offset_not_allowed',
      details: [{ rule: 'deep_offset_not_allowed', params: { maxOffset: MAX_OFFSET } }],
    });
  }
  return { limit: query.perPage, offset };
}

export interface SortKey {
  field: string;
  direction: 'asc' | 'desc';
}

/**
 * Parses `?sort=-createdAt,name` against an endpoint whitelist.
 * Unknown fields are rejected (`400 VALIDATION_ERROR`) to avoid injection by
 * construction; at most `MAX_SORT_KEYS` keys are accepted.
 */
export function parseSortParam(
  sort: string | undefined,
  allowed: readonly string[],
  fallback: readonly SortKey[] = [{ field: 'createdAt', direction: 'desc' }],
): SortKey[] {
  if (sort === undefined || sort.trim() === '') {
    return [...fallback];
  }
  const parts = sort
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > MAX_SORT_KEYS) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'sort', rule: 'invalid_sort', params: { maxKeys: MAX_SORT_KEYS } }],
    });
  }
  return parts.map((part) => {
    const descending = part.startsWith('-');
    const field = descending ? part.slice(1) : part;
    if (!allowed.includes(field)) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'sort', rule: 'unknown_sort_field', params: { field } }],
      });
    }
    return { field, direction: descending ? 'desc' : 'asc' };
  });
}

/** Normalizes a `filter[field][in]=a,b,c` comma list, enforcing the cap. */
export function parseInFilter(value: string, allowed?: readonly string[]): string[] {
  const values = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (values.length === 0 || values.length > MAX_IN_VALUES) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'filter', rule: 'invalid_in_filter', params: { maxValues: MAX_IN_VALUES } }],
    });
  }
  if (allowed !== undefined && values.some((item) => !allowed.includes(item))) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'filter', rule: 'unknown_filter_value' }],
    });
  }
  return values;
}
