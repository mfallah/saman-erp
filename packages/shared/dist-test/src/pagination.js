"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OffsetPaginationQuery = exports.CursorPaginationQuery = exports.PaginationMode = exports.MAX_IN_VALUES = exports.MAX_SORT_KEYS = exports.MAX_OFFSET = exports.MAX_PER_PAGE = exports.DEFAULT_PER_PAGE = exports.DEFAULT_PAGE = exports.MAX_LIMIT = exports.MIN_LIMIT = exports.DEFAULT_UI_LIMIT = exports.DEFAULT_LIMIT = void 0;
exports.encodeCursor = encodeCursor;
exports.decodeCursor = decodeCursor;
exports.buildCursorMeta = buildCursorMeta;
exports.buildOffsetMeta = buildOffsetMeta;
exports.toSqlOffset = toSqlOffset;
exports.parseSortParam = parseSortParam;
exports.parseInFilter = parseInFilter;
/**
 * Pagination, filtering and sorting primitives (`API.md` §1.5–§1.7).
 *
 * Two modes are part of each endpoint contract: opaque keyset cursors for
 * high-volume append-only resources and offset paging for small admin lists.
 * Cursor payloads are base64url JSON bound to the caller's filter/sort set by the
 * feature module; this module only owns the envelope, limits and safety guards.
 */
const zod_1 = require("zod");
const errors_1 = require("./errors");
exports.DEFAULT_LIMIT = 50;
exports.DEFAULT_UI_LIMIT = 25;
exports.MIN_LIMIT = 1;
exports.MAX_LIMIT = 500;
exports.DEFAULT_PAGE = 1;
exports.DEFAULT_PER_PAGE = 25;
exports.MAX_PER_PAGE = 200;
/** Deep offsets are rejected instead of scanning `OFFSET 900000`. */
exports.MAX_OFFSET = 10_000;
exports.MAX_SORT_KEYS = 3;
exports.MAX_IN_VALUES = 100;
exports.PaginationMode = zod_1.z.enum(['cursor', 'offset']);
/** Query schema for cursor-paginated endpoints (`?limit=&cursor=&direction=`). */
exports.CursorPaginationQuery = zod_1.z.object({
    limit: zod_1.z.coerce.number().int().min(exports.MIN_LIMIT).max(exports.MAX_LIMIT).default(exports.DEFAULT_LIMIT),
    cursor: zod_1.z.string().min(1).max(2048).optional(),
    direction: zod_1.z.enum(['forward', 'backward']).default('forward'),
});
/** Query schema for offset-paginated endpoints (`?page=&perPage=&sort=`). */
exports.OffsetPaginationQuery = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(exports.DEFAULT_PAGE),
    perPage: zod_1.z.coerce.number().int().min(exports.MIN_LIMIT).max(exports.MAX_PER_PAGE).default(exports.DEFAULT_PER_PAGE),
    sort: zod_1.z.string().max(200).optional(),
});
const CURSOR_JSON = /^[A-Za-z0-9_-]+$/;
/** Encodes an opaque cursor payload as base64url (no padding). */
function encodeCursor(payload) {
    if (!payload.id || !payload.sortKey) {
        throw new RangeError('invalid_cursor_payload');
    }
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
/** Decodes and validates an opaque cursor; tampering maps to `VALIDATION_ERROR`. */
function decodeCursor(cursor) {
    if (!CURSOR_JSON.test(cursor)) {
        throw new errors_1.AppError('VALIDATION_ERROR', {
            details: [{ field: 'cursor', rule: 'invalid_cursor' }],
        });
    }
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    }
    catch {
        throw new errors_1.AppError('VALIDATION_ERROR', {
            details: [{ field: 'cursor', rule: 'invalid_cursor' }],
        });
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new errors_1.AppError('VALIDATION_ERROR', {
            details: [{ field: 'cursor', rule: 'invalid_cursor' }],
        });
    }
    const candidate = parsed;
    if (typeof candidate['sortKey'] !== 'string' || typeof candidate['id'] !== 'string') {
        throw new errors_1.AppError('VALIDATION_ERROR', {
            details: [{ field: 'cursor', rule: 'invalid_cursor' }],
        });
    }
    const payload = { sortKey: candidate['sortKey'], id: candidate['id'] };
    if (typeof candidate['scope'] === 'string') {
        return { ...payload, scope: candidate['scope'] };
    }
    return payload;
}
/** Builds the `meta.pagination` object for a cursor list. */
function buildCursorMeta(limit, options = {}) {
    return {
        mode: 'cursor',
        limit,
        ...(options.nextCursor === undefined ? {} : { nextCursor: options.nextCursor }),
        ...(options.prevCursor === undefined ? {} : { prevCursor: options.prevCursor }),
        hasMore: options.hasMore ?? options.nextCursor !== undefined,
    };
}
/** Builds the `meta.pagination` object for an offset list. */
function buildOffsetMeta(page, perPage, total) {
    return {
        mode: 'offset',
        page,
        perPage,
        totalPages: total === 0 ? 0 : Math.ceil(total / perPage),
        total,
    };
}
/** Converts offset paging into SQL `LIMIT`/`OFFSET`, rejecting deep offsets. */
function toSqlOffset(query) {
    const offset = (query.page - 1) * query.perPage;
    if (offset > exports.MAX_OFFSET) {
        throw new errors_1.AppError('RULE_VIOLATION', {
            message: 'پیمایش بیش از حد عمیق است؛ از فیلترها استفاده کنید.',
            messageKey: 'pagination.deep_offset_not_allowed',
            details: [{ rule: 'deep_offset_not_allowed', params: { maxOffset: exports.MAX_OFFSET } }],
        });
    }
    return { limit: query.perPage, offset };
}
/**
 * Parses `?sort=-createdAt,name` against an endpoint whitelist.
 * Unknown fields are rejected (`400 VALIDATION_ERROR`) to avoid injection by
 * construction; at most `MAX_SORT_KEYS` keys are accepted.
 */
function parseSortParam(sort, allowed, fallback = [{ field: 'createdAt', direction: 'desc' }]) {
    if (sort === undefined || sort.trim() === '') {
        return [...fallback];
    }
    const parts = sort
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    if (parts.length === 0 || parts.length > exports.MAX_SORT_KEYS) {
        throw new errors_1.AppError('VALIDATION_ERROR', {
            details: [{ field: 'sort', rule: 'invalid_sort', params: { maxKeys: exports.MAX_SORT_KEYS } }],
        });
    }
    return parts.map((part) => {
        const descending = part.startsWith('-');
        const field = descending ? part.slice(1) : part;
        if (!allowed.includes(field)) {
            throw new errors_1.AppError('VALIDATION_ERROR', {
                details: [{ field: 'sort', rule: 'unknown_sort_field', params: { field } }],
            });
        }
        return { field, direction: descending ? 'desc' : 'asc' };
    });
}
/** Normalizes a `filter[field][in]=a,b,c` comma list, enforcing the cap. */
function parseInFilter(value, allowed) {
    const values = value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    if (values.length === 0 || values.length > exports.MAX_IN_VALUES) {
        throw new errors_1.AppError('VALIDATION_ERROR', {
            details: [{ field: 'filter', rule: 'invalid_in_filter', params: { maxValues: exports.MAX_IN_VALUES } }],
        });
    }
    if (allowed !== undefined && values.some((item) => !allowed.includes(item))) {
        throw new errors_1.AppError('VALIDATION_ERROR', {
            details: [{ field: 'filter', rule: 'unknown_filter_value' }],
        });
    }
    return values;
}
