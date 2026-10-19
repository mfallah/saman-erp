# 03 — API Contract (v1)

**خلاصهٔ فارسی:** این سند قرارداد رسمی API نسخهٔ ۱ سامان ERP است: قراردادهای سراسری (پاکت پاسخ، خطا، صفحه‌بندی، فیلتر، هم‌زمانی خوش‌بینانه، Idempotency، نرخ محدودیت، پول و تاریخ)، جریان‌های احراز هویت و نشست، کاتالوگ کامل Endpointها به تفکیک ماژول همراه با کلید دسترسی هر Endpoint، رجیستری کلیدهای دسترسی، قرارداد دریافت/ارسال Webhook، جریان فایل، نگاشت آداپتورهای Carexy/Digikala/Limo SMS، و راهبرد تولید OpenAPI و نسخه‌گذاری. همهٔ شناسه‌های عمومی `uuid` هستند و شناسهٔ عددی داخلی (`bigint`) هرگز در API ظاهر نمی‌شود.

Status: **Engineering baseline v1.0** · Owner: API Architect · Last updated: 1405-07-27
Sources of truth, in priority order: 1) this document for HTTP surface and permission keys, 2) `docs/02-data-model/DATA-MODEL.md` for persistence and seed, 3) ADRs for cross-cutting decisions, 4) real partner API documents (`carexy`, `digikala`, `limo-sms`). If this document and an adapter implementation disagree about a partner endpoint, the partner document wins and this document is patched.

---

## 0. Scope, audience, and normative language

- Audience: backend implementers, SPA client authors, channel-adapter authors, QA authoring contract tests, security reviewers.
- Normative words: **MUST**, **SHOULD**, **MAY** follow RFC 2119.
- The OpenAPI 3.1 document generated from Zod DTOs is a *derived artifact*. Where this document and the generated schema disagree, the generated schema is a bug and CI fails on OpenAPI diff (`ARCHITECTURE.md` §15).
- Every endpoint in §4 has: an **Auth class**, a **permission key**, a request contract, a response shape, and the important error codes. A route with no permission key is a CI lint failure (default-deny, `ADR-0008`).
- Modules in §4 map 1:1 to `ARCHITECTURE.md` §4. The coverage matrix in §11 proves no module is missing.

---

## 1. Global conventions

### 1.1 Base URL and transport

| Item | Rule |
|---|---|
| Base path | `/api/v1` (URI major version). No trailing slash; a trailing slash redirects `308` only for `GET`. |
| Host (production) | `https://erp.carexy.shop` — same origin for SPA and API (`ADR-0011`), so browser CORS is not used in production. |
| Host (development) | `http://localhost:4000/api/v1` (API listens on `PORT=4000`; the SPA dev server proxies `/api`). CORS applies only here, via `CORS_ORIGINS`. |
| Compose services | `postgres`, `redis`, `minio`, `api`, `worker`, `web`; only `web` (and the TLS proxy) is public by default. |
| Protocol | HTTPS only. Plain HTTP gets `308` to HTTPS at the edge. TLS 1.2+ (1.3 preferred). |
| Media type | `application/json; charset=utf-8` for all bodies except file transfer (§7) and metrics (§4.19). |
| Methods | `GET` read, `POST` create/action, `PUT` full replace (rare; only credentials/settings), `PATCH` partial update, `DELETE` soft-delete/revoke. No `HEAD` semantics beyond HTTP; no `OPTIONS` business logic. |
| Idempotent reads | `GET` and `HEAD` are safe; every other method is a mutation and needs a permission. |
| Case | JSON keys `camelCase`; query params `camelCase`; DB stays `snake_case` (mapping in repository layer). |
| Trailing/unknown params | Unknown query parameters are **rejected** with `VALIDATION_ERROR` when not in the endpoint whitelist (typo safety), except `_` cache-buster. |
| Nullability | Absent field ≠ null. `PATCH` semantics: absent = unchanged, explicit `null` = clear (only where field is nullable). |

### 1.2 Request tracing and correlation

| Header | Direction | Rule |
|---|---|---|
| `X-Request-ID` | in/out | If client sends a UUIDv4/v7 it is honored (validated); otherwise the server generates one. Echoed on every response and in the error envelope. Stored in `api_request_logs` and `audit_logs`. |
| `traceparent` / `tracestate` | in/out | W3C Trace Context. Propagated to outbound channel calls when `OTEL_ENABLED=true`. Malformed `traceparent` is ignored, not rejected. |
| `X-Correlation-ID` | in/out | Optional business correlation (e.g. an order import batch). Echoed; max 128 chars; safe-charset only. |
| Response header `X-Request-ID` | out | Always present, even on `500`. |
| `Server-Timing` | out | Emitted for `GET` when `APP_ENV != production`; never leaks SQL. |

### 1.3 Success envelope

Single resource:

```json
{
  "data": { "id": "0f0f6a2e-6f1e-4a3d-9a54-3a6b0f3c9c11", "version": 7 },
  "meta": { "requestId": "5c2a0b7e-8a3f-4b1e-9f0a-1d2c3b4a5e6f", "traceId": "4bf92f3577b34da6a3ce929d0e0e4736" }
}
```

Collection:

```json
{
  "data": [ { "id": "…" } ],
  "meta": {
    "requestId": "…",
    "pagination": { "mode": "cursor", "limit": 50, "nextCursor": "eyJr…", "hasMore": true },
    "total": 12345
  }
}
```

Rules:

- `data` is `null` only for `204` (which has no body) and for endpoints where "empty" is meaningful (`GET /auth/me` never returns null). A collection is `[]`, never `null`.
- `meta` is always present on non-`204` responses and carries `requestId`; `pagination` appears only on list endpoints.
- `total` is returned **only** for offset pagination or when cheap (`COUNT` estimate); cursor lists MUST NOT compute `total` (performance guard).
- No top-level `success` field: HTTP status is the success signal. (The legacy SRS sample in `project-doc.txt` §104 shows `success`; it is superseded by this contract.) Anonymous public health endpoints keep the envelope for consistency.

### 1.4 Error envelope and stable codes

```json
{
  "error": {
    "code": "RULE_VIOLATION",
    "message": "موجودی کافی برای این اقلام وجود ندارد.",
    "messageKey": "inventory.insufficient_stock",
    "details": [
      { "field": "lines[1].quantity", "rule": "insufficient_stock",
        "params": { "variantId": "…", "requested": "3", "available": "1" } }
    ],
    "requestId": "5c2a0b7e-8a3f-4b1e-9f0a-1d2c3b4a5e6f"
  }
}
```

| Field | Rule |
|---|---|
| `code` | Stable machine code from §1.4.1. Clients branch on this, never on `message`. |
| `message` | Persian, user-safe, ready to display. Never contains SQL, stack traces, secrets, internal ids, or partner raw payloads. |
| `messageKey` | Stable i18n key (`module.rule`); SPA may localize from this. |
| `details` | Array of field/rule/params objects. For `VALIDATION_ERROR` mirrors Zod issues (`path`, `code`, `params`). For domain rules carries structured context. |
| `requestId` | Same as `X-Request-ID`; support asks for this. |
| `retryAfter` | Integer seconds, present only for `429` and `503`; duplicated in `Retry-After` header. |
| `upstream` | Present only for channel faults; `{ "channel": "digikala", "httpStatus": 429, "retryable": true }` — never the raw body. |

#### 1.4.1 Error code registry (stable; additions are minor, renames are breaking)

| HTTP | `code` | When | Client action |
|---|---|---|---|
| 400 | `BAD_REQUEST` | Malformed JSON, invalid header syntax, unsupported method semantics | Fix request |
| 400 | `VALIDATION_ERROR` | Zod/schema validation failed (query, path, body) | Show field errors |
| 401 | `UNAUTHENTICATED` | Missing/invalid/expired access JWT | Refresh, then retry once |
| 401 | `TOKEN_EXPIRED` | Access token expired (distinguishable for UX) | Refresh |
| 401 | `MFA_REQUIRED` | Challenge outstanding; tokens not issued | Complete `/auth/mfa/verify` |
| 401 | `PERMISSIONS_CHANGED` | JWT `pv` < `users.permissions_version` | Silent refresh, re-render menus |
| 401 | `SESSION_REVOKED` | Session row revoked/expired | Force re-login |
| 401 | `REFRESH_TOKEN_REUSED` | Rotated token presented again | Family revoked; force re-login + security event |
| 401 | `STEP_UP_REQUIRED` | Sensitive action needs a fresh step-up token | Prompt password/OTP |
| 403 | `FORBIDDEN` | Authenticated but missing permission key | Hide/disable action |
| 403 | `SCOPE_DENIED` | Permission present but branch/warehouse scope excludes the target | Explain scope |
| 403 | `IP_NOT_ALLOWED` | Source IP outside org allowlist (admin/API clients) | Contact admin |
| 404 | `NOT_FOUND` | Resource absent, soft-deleted, or out of tenant scope (indistinguishable on purpose) | Show empty state |
| 405 | `METHOD_NOT_ALLOWED` | Route exists, verb does not | Bug |
| 409 | `CONFLICT` | Business uniqueness (SKU, barcode, code, doc number) | Resolve conflict |
| 409 | `VERSION_CONFLICT` | `If-Match` mismatch / stale `version` | Re-fetch and re-apply |
| 409 | `APPROVAL_REQUIRED` | Operation needs maker-checker approval; `details.approvalRequestId` returned | Route to approval |
| 409 | `APPROVAL_PENDING` | Same document already has a pending approval | Wait |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | Same `Idempotency-Key` request still executing | Retry after `Retry-After` |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Key reused with a different request body hash | Use a fresh key |
| 409 | `DOCUMENT_STATE_INVALID` | State machine rejects the transition (e.g. posted journal edit) | Reload document |
| 413 | `PAYLOAD_TOO_LARGE` | Body/upload over limit | Shrink or use file upload |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Wrong content type / unsupported file MIME | Fix content type |
| 422 | `RULE_VIOLATION` | Domain rule violated; sub-rule in `details[].rule` | Depends on sub-rule |
| 422 | `INSUFFICIENT_STOCK` | Reservation/allocation cannot be satisfied | Show per-line availability |
| 422 | `PERIOD_CLOSED` | Posting into a closed fiscal period | Choose an open period |
| 422 | `FISCAL_YEAR_CLOSED` | Document date outside open years | Adjust date |
| 422 | `JOURNAL_UNBALANCED` | Debit ≠ credit | Fix lines |
| 422 | `COST_CENTER_REQUIRED` | Dimension mandatory for account/rule | Add dimension |
| 422 | `PRICE_BELOW_MARGIN` | Margin guard blocks price | Override with approval |
| 422 | `CURRENT_PASSWORD_INVALID` | Password change/reset step-up failed | Retry |
| 422 | `PASSWORD_POLICY_VIOLATION` | zxcvbn/breach/reuse rule | Show policy |
| 422 | `OTP_INVALID` | Wrong OTP code | Retry |
| 422 | `OTP_EXPIRED` | TTL elapsed | Request a new code |
| 422 | `OTP_ATTEMPTS_EXCEEDED` | Max verify attempts | Request new code (rate-limited) |
| 422 | `OTP_RESEND_TOO_SOON` | Resend window not elapsed; `details.retryAfter` | Wait |
| 422 | `UPLOAD_UNSUPPORTED_TYPE` | Magic bytes ≠ declared type | Re-upload |
| 422 | `UPLOAD_CHECKSUM_MISMATCH` | `sha256` mismatch on file complete | Re-upload |
| 422 | `IMPORT_VALIDATION_FAILED` | Import batch has row errors; see `/imports/{id}/errors` | Fix rows |
| 423 | `RESOURCE_LOCKED` | Document locked by another process/user | Retry later |
| 428 | `PRECONDITION_REQUIRED` | `If-Match` required by policy but absent | Fetch `ETag`, retry |
| 429 | `RATE_LIMITED` | Limit exceeded | Honor `Retry-After` |
| 501 | `NOT_IMPLEMENTED` | Adapter capability not available (e.g. Digikala endpoint `TBD-DIGIKALA`) | Hide feature |
| 502 | `UPSTREAM_UNAVAILABLE` | Partner API error/timeout exhausted retries | Queue/notify |
| 502 | `UPSTREAM_INVALID_RESPONSE` | Partner returned schema-invalid payload | Alert |
| 503 | `SERVICE_DEGRADED` | Redis/DB dependency reduced; writes temporarily blocked | Retry after |
| 503 | `MAINTENANCE_MODE` | Org/global maintenance window | Show banner |
| 500 | `INTERNAL` | Unexpected server error (never leaks detail) | Report `requestId` |

HTTP mapping is fixed: `VALIDATION_ERROR` is `400` for malformed syntax and `422` for schema/domain semantics; the SPA treats both the same. `details[].rule` values are themselves stable and documented per endpoint in §4, e.g. `insufficient_stock`, `period_closed`, `version_conflict`, `document_state_invalid`.

### 1.5 Pagination

Two modes; the mode is part of the endpoint contract (`C` = cursor, `O` = offset, `C/O` = both). The list endpoint's `meta.pagination.mode` states which was used.

**Cursor** (default for high-volume, append-heavy, keyset-friendly resources):

```http
GET /api/v1/inventory/transactions?limit=100&cursor=eyJjcmVhdGVkQXQiOiIyMDI2LTA3LTE4VDE0OjMwOjAwWiIsImlkIjoiLi4uIn0
```

| Param | Rule |
|---|---|
| `limit` | 1–500, default 50 (default 25 for UI-heavy lists). |
| `cursor` | Opaque `base64url` of `{ sortKey: value, id: uuid }`. Tampering → `VALIDATION_ERROR`. Cursors are bound to the same filter/sort set and to the caller org; cross-filter reuse → `VALIDATION_ERROR`. |
| `direction` | `forward` (default) or `backward`; response carries `nextCursor`/`prevCursor` as applicable. |

**Offset** (small admin lists only; max `perPage` 200):

```http
GET /api/v1/users?page=2&perPage=25&sort=-createdAt
```

`meta.pagination = { mode: "offset", page, perPage, totalPages, total }`.

Rules:

- Stable sort is mandatory: every cursor endpoint appends a tiebreaker on `public_id` (or `id` internally, never exposed).
- Deep offset (`page * perPage > 10,000`) → `422 RULE_VIOLATION` rule `deep_offset_not_allowed` with a hint to use filters; prevents `OFFSET 900000` scans.
- List endpoints never return `null` pages; out-of-range offset returns `data: []` with `total`.

### 1.6 Filtering, sorting, search

- **Filter syntax**: `filter[field]=value`; operators as a nested object for range/set:
  `?filter[status]=posted&filter[createdAt][gte]=2026-04-01T00:00:00Z&filter[createdAt][lt]=2026-07-01T00:00:00Z&filter[channelCode][in]=carexy,digikala`.
- Supported operators: `eq` (implicit), `ne`, `gt`, `gte`, `lt`, `lte`, `in` (comma list, max 100), `contains` (text only, min 2 chars), `isNull` (`true|false`).
- **Whitelists**: each endpoint documents filterable fields in §4 as `F:` under the path. Any other field → `400 VALIDATION_ERROR`. No generic `filter[anything]` SQL passthrough, ever (injection-by-construction).
- **Sorting**: `?sort=-createdAt,name`; `-` = descending; max 3 keys; whitelist per endpoint (`S:`); default `-createdAt` where the table has it, otherwise `name`. Sorting on cost/price fields requires the cost permission.
- **Search**: `?q=` free text, 2–100 chars, diacritic-normalized, Persian/Arabic letter folding (`ي→ی`, `ك→ک`), digits folded; backed by `pg_trgm` on whitelisted searchable columns; results ordered by relevance then `-createdAt`. `q` is ignored on endpoints without `Q:`.
- **Date ranges**: filter by ISO dates/timestamps; on partitioned tables an unbounded range is rejected (`422` rule `date_range_required`) and the default window applies (ledger/logs/audit: last 31 days) — `ADR-0009`.
- **Jalali input**: report endpoints accept `?calendar=jalali&from=1405-04-01&to=1405-04-31` **in addition to** Gregorian `from`/`to`; API payloads always carry Gregorian dates (`ADR-0014`). See §4.15.
- **Repeatable params**: comma lists are preferred over repeated keys; repeated keys are accepted only for `include` and `fields` and are merged.

### 1.7 Sparse fields and includes

- `?fields=id,name,sku,status` — response projection whitelist; unknown field → `400`. Always includes `id`, `version` (if mutable), `createdAt` when requested. Cost fields are stripped before projection regardless of `fields`.
- `?include=customer,lines.variant` — eager-load whitelisted relations, max depth 2, max 5 include roots, 100 relations total per response; exceeding → `422` (prevents N+1 abuse).
- `?exclude=` for heavy-but-default fields (e.g. `lines` on order list).

### 1.8 Money, quantities, dates, locale

| Kind | JSON representation | Example | Notes |
|---|---|---|---|
| Money (IRR) | **string** integer | `"12500000"` | Never `number`, never float. `bigint` server-side (`ADR-0013`). |
| Quantity | string decimal(18,4) | `"3.0000"` | Strings avoid JS float drift; SPA uses decimal helpers. |
| Unit price / cost | string decimal(18,4) | `"1250000.0000"` | Cost fields are permission-gated. |
| Rate / percentage | string decimal(9,6) | `"0.090000"` (9%) | Tax, commission, discount. |
| Timestamps | ISO-8601 UTC with `Z` | `"2026-07-18T14:30:00Z"` | `timestamptz`; server clock only. |
| Business date | ISO date | `"2026-07-18"` | Gregorian civil day; Jalali is presentation (`ADR-0014`). |
| Jalali mirror | ISO date `YYYY-MM-DD` with `Calendar: jalali` header or field suffix `Jalali` | `"1405-04-27"` | Only in report responses/params. |
| Currency | ISO 4217 | `"IRR"` | v1 only `IRR`; other values → `422 rule currency_not_supported`. |
| Locale | `Accept-Language` | `fa-IR` default, `en-US` allowed | Affects `message` language only when i18n is enabled; error `code` never changes. |
| Digits | ASCII in JSON; Persian digits only in rendered `message` when configured | — | Round-trip safety. |

Response money fields always include a sibling `currency` where ambiguity exists (`price: "…", currency: "IRR"`). Aggregates computed server-side are strings too; the SPA never sums raw money strings (uses `money.ts`).

### 1.9 Public identifiers (no internal ids)

- Every resource in a URL or response uses `id` = **`public_id` UUID** (`ADR-0003`). Internal `bigint` ids never appear in any JSON, error, or log-visible header.
- Response objects may carry `ref` objects: `{ "customer": { "id": "…", "name": "…" } }` instead of raw FKs.
- Request bodies reference other aggregates by `*Id` UUID, never by code-only unless the endpoint documents a code lookup (e.g. `channelCode`).
- Codes/SKUs (`sku`, `barcode`, `code`, `documentNo`) are **not** identifiers in URLs; they are searchable/filterable attributes. `GET /products/lookup?barcode=…` is a search, not a resource path.
- IDs are validated as UUID (v4/v7) before hitting the DB; invalid → `400 VALIDATION_ERROR` with `path: ["id"]`.
- Deep links in the SPA (`/orders/:id`) use the same UUID; the SPA must never persist bigint ids in URLs, IndexedDB scan queues, or analytics.

### 1.10 Idempotency (`Idempotency-Key`)

| Rule | Detail |
|---|---|
| Scope | **Required** on every `POST` that creates a financial/stock/business document or moves money/stock (see §4 rows marked `IK`). Recommended on all `POST`. Ignored on `GET`/`DELETE`. |
| Format | 8–255 chars, `[A-Za-z0-9._:-]`; UUID recommended. Header name is exactly `Idempotency-Key`. |
| Storage | `idempotency_keys` table: `key`, `user_id`, `route`, `request_hash` (SHA-256 of canonical body+path), `status` (`in_progress`/`completed`), `response_status`, `response_body`, `created_at`, `expires_at`. Unique on `(user_id, route, key)`. |
| Retention | 24 h (`IDEMPOTENCY_TTL_HOURS`). Expired keys may be reused; expiry cleanup is a maintenance job. |
| Replay | Completed key + same hash → original status/body replayed with `Idempotent-Replay: true`; **no side effects**. |
| Conflict | Same key + different body hash → `409 IDEMPOTENCY_KEY_REUSED`. |
| Concurrency | Second in-flight request with same key → `409 IDEMPOTENCY_IN_PROGRESS` + `Retry-After: 1`. |
| Failure caching | Only `2xx` responses are cached. A `4xx/5xx` releases the key so the client may retry (except after a commit — the domain idempotency key, e.g. `channel:order:123`, still guards). |
| Webhook/jobs | Internal idempotency uses natural keys (`channel:order:{externalId}`, `webhook:{eventId}`) in addition to this header for external producers. |

SPA rule: generate the key at the moment the user clicks submit (not on render), reuse it for retries of the same logical action, discard on success/navigation.

### 1.11 Optimistic concurrency (`If-Match` / `version` / `ETag`)

- Every mutable resource exposes an integer `version` (bumped by DB trigger, `ADR-0003`) and returns it as **`ETag: "7"`** (quoted) on `GET` and on mutations.
- Mutating requests that can lose updates (`PATCH`, `PUT`, and domain actions like `post`, `approve`, `confirm`) **MUST** send `If-Match: "7"` when the endpoint policy is `If-Match required` (marked `IM` in §4). Others accept it optionally.
- Missing where required → `428 PRECONDITION_REQUIRED`. Mismatch → `409 VERSION_CONFLICT` with `details: { currentVersion, providedVersion }` and current `ETag` header so the SPA can auto-merge or ask the user.
- `GET` honors `If-None-Match` → `304` (no body) for list/detail caching of settings and reference data.
- Collections do not carry an entity ETag. Bulk endpoints return per-item versions.
- Action endpoints on documents (`POST /orders/{id}/confirm`) are still version-guarded: the body may omit version but must send `If-Match`; the action is rejected if the document changed since the caller loaded it.

### 1.12 Rate limits

Limits are enforced per authenticated user by default, sliding window in Redis, with per-IP fallback when Redis is down (`ARCHITECTURE.md` §13). Response headers on every request: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (epoch seconds), `RateLimit-Policy` (e.g. `read;w=60`). `429` includes `Retry-After`.

| Tier | Scope | Limit |
|---|---|---|
| `auth-login` | per `(IP, username)` | 10 / min; exponential delay after 5 |
| `auth-otp-request` | per mobile | 3 / 10 min, 5 / hour |
| `auth-otp-request-ip` | per IP | 10 / hour |
| `auth-otp-verify` | per challenge | 5 attempts total; 10 / 10 min per IP |
| `auth-refresh` | per session | 60 / hour |
| `auth-step-up` | per user | 10 / 15 min |
| `read` | per user | 600 / min |
| `write` | per user | 120 / min |
| `bulk` | per user | 12 / min (bulk create/update, imports) |
| `report` | per user | 30 / min; async exports 10 / min |
| `file-upload` | per user | 60 / hour; bytes cap per §7 |
| `webhook-in` | per channel account | 600 / min burst 1200; `429` is retried by partner |
| `metrics` | per scrape token/IP | 60 / min |
| `public-health` | per IP | 120 / min |

Special cases: login lockout after 10 failures/15 min (`423` while locked, Persian message); OTP abuse raises `security_events`; rate-limit hits are audited in aggregate (not per request) to avoid log storms.

### 1.13 Caching, compression, conditional requests

- `Cache-Control: no-store` on everything under `/auth/*`, `/webhooks/*`, and all authenticated business endpoints by default (sensitive). Public health/version: `public, max-age=10`.
- Reference data endpoints (settings, permissions registry, categories tree, units, tax rates) support `ETag` + `304`; SPA may cache in TanStack Query with `staleTime` and revalidate.
- `Cache-Control: no-cache` on list endpoints (must revalidate).
- Response compression: `gzip`/`br` for bodies > 1 KB, `Accept-Encoding` honored; compression disabled for file streams (already compressed) and for SSE.
- CDN is not part of v1 topology; the nginx layer may cache static SPA assets only.

### 1.14 Bulk and asynchronous operations

- **Synchronous bulk** (`POST …/bulk-*`, max 100 items): `200` with `data.results[]` per item `{ index, status, id?, error? }`, and `meta.failed`, `meta.succeeded`. Partial success is not a `4xx`.
- **Asynchronous** (imports, exports, reports, batch price/stock pushes, bulk label generation): `202 Accepted` + `Location: /api/v1/jobs/{jobId}` with body `{ data: { jobId, type, status: "queued", progress: 0 } }`.
- Job resource contract: `id`, `type`, `status` (`queued|running|succeeded|failed|cancelled|partial`), `progress { total, processed, failed }`, `resultRef` (download URL or affected ids), `errorsRef` (`/jobs/{id}/errors`), `createdAt`, `startedAt`, `finishedAt`, `requestedBy`.
- Polling: `GET /jobs/{id}`; SPA polls with backoff (1 s → 5 s → 15 s) or receives `notifications` for long jobs. No webhooks to the browser.
- Job idempotency: submitting the same import twice with the same file checksum within 10 minutes returns the existing job (`409`-free, `200` with same job) — `details.deduplicated: true`.
- Cancellation: `POST /jobs/{id}/cancel` is cooperative; already-committed chunks are not rolled back except for imports supporting `rollback` (§4.18).

### 1.15 Status codes and headers summary

| Status | Meaning in this API |
|---|---|
| `200` | Read success, action success, bulk with per-item results |
| `201` | Resource created; `Location` header with the resource URL |
| `202` | Async job accepted; `Location` header with job URL |
| `204` | Success with no body: logout, revoke, delete, read-all |
| `304` | Conditional GET hit |
| `400/401/403/404/405/409/413/415/422/423/428/429/500/501/502/503` | Per §1.4.1 |

Mutating responses include `ETag` (new version) and `X-Request-ID`. `Location` is absolute-path only (`/api/v1/...`), never absolute URL with host (proxy safety).

### 1.16 Persian messages, i18n, and anti-enumeration

- `message` is Persian by default (`fa-IR`), written for end users; `messageKey` is stable English for localization. Engineering docs and field names stay English.
- Anti-enumeration: `POST /auth/otp/request` always returns `202` with the same body whether or not the mobile exists (for `purpose=login`); `POST /auth/password/forgot` always `202`; resource lookups outside the caller's org return `404`, not `403`.
- `422` validation messages may be Persian, but `details[].path` is machine-readable.
- No stack traces, file paths, SQL, internal ids, partner payloads, tokens, or credential fingerprints beyond the last 4 characters in any error.

### 1.17 Browser security contract (CORS, CSRF, headers)

- Production is same-origin; `CORS_ALLOWED_ORIGINS` is an env allowlist (dev/staging only). No `Access-Control-Allow-Credentials: true` for foreign origins.
- Business endpoints authenticate **only** via `Authorization: Bearer` and are therefore not CSRF-able. The refresh cookie is `Path=/api/v1/auth`, `HttpOnly`, `Secure`, `SameSite=Lax` (`ADR-0004`).
- Cookie-authenticated endpoints (`/auth/refresh`, `/auth/logout`, `/auth/logout-all`) additionally require: `Origin` matching the allowlist, `X-Requested-With: XMLHttpRequest`, and double-submit `X-CSRF-Token` matching the non-HttpOnly `csrf_token` cookie (SameSite=Lax). Failure → `403 FORBIDDEN` (code `CSRF_FAILED` is folded into `FORBIDDEN` with `details.rule = "csrf"`).
- Edge/browser headers (set at nginx/Caddy and by Fastify `helmet`): `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (SPA needs `SAMEORIGIN` only if framed internally; default DENY), `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(self), microphone=(), geolocation=()` (camera needed for scanner PWA), `Content-Security-Policy` per security doc (`default-src 'self'; img-src 'self' data: blob:; connect-src 'self'`), no `Server`/`X-Powered-By` disclosure.
- Request body caps: JSON `1 MiB` default, `10 MiB` for bulk/import JSON, `100 MiB` for presigned file uploads (out-of-band, §7); URL `8 KiB`; headers `16 KiB`; multipart only on the two upload endpoints documented in §7.

### 1.18 Deprecation policy headers

- Within v1 only **additive** changes (new fields, new endpoints, new optional params) are allowed. Removing/renaming a field, changing a type, tightening validation, or removing an enum value is breaking.
- Breaking changes require `/api/v2`; v1 then serves `Deprecation: @<unix-seconds>` and `Sunset: <HTTP-date>` headers and continues for **at least two minor releases / 90 days** (whichever is longer).
- Fields marked deprecated in OpenAPI carry `deprecated: true` and a `x-sunset` extension; the SPA build fails if it references a deprecated operation (ESLint rule in the generated client).

---

## 2. Authentication & session API (identity)

Auth class legend used throughout §4:

| Mark | Meaning |
|---|---|
| `public` | No credentials. Rate-limited; only `/auth/*` entry points, health, webhooks. |
| `self` | Requires a valid access JWT; acts on the caller's own account. No RBAC permission key (still default-deny by route guard). |
| `cookie+csrf` | Refresh/logout family; refresh token cookie + CSRF checks. |
| `hmac` | Inbound webhook; signature verification per §6, no user JWT. |
| `scrape` | Static bearer token from env (`METRICS_TOKEN`), not a user JWT; loopback/allowlist only. |
| `perm:<key>` | Requires the named permission key from the registry (§5). Scope narrowing applies automatically. |

### 2.1 Token and session model (summary of `ADR-0004`)

- **Access token**: JWT, 10 min, `Authorization: Bearer`. Claims: `sub` (user public_id), `sid` (session public_id), `org` (org public_id), `pv` (permissions version), `scope` (`branchIds[]`, `warehouseIds[]` when scoped), `mfa` (bool), `amr` (password/otp), `jti`, `iat`, `exp`, `iss`, `aud`.
- **Refresh token**: 256-bit random opaque value, `HttpOnly` cookie `Path=/api/v1/auth`, 7 days, rotated on every use, stored SHA-256 hashed in `auth_sessions.refresh_token_hash`. Reuse of an old token revokes the whole session family and emits `security_events.SESSION_REUSED`.
- **Sessions vs devices**: one session per login (browser/device). A trusted device survives logout for 30 days and skips OTP on new sessions. Devices are keyed by a client-generated `deviceFingerprint` (stable hash of UA/platform/screen-timezone; no invasive fingerprinting) + server-issued `deviceId` cookie (not auth).
- **Permission versioning**: role/permission edits bump `users.permissions_version` in the same transaction. Tokens with stale `pv` get `401 PERMISSIONS_CHANGED`; SPA calls `/auth/refresh` (refresh token carries no `pv`, so the new access token is fresh) and retries the failed request **once**.
- **2FA / step-up**: untrusted device login returns a challenge instead of tokens. Sensitive actions (`journal.post`, `fiscal-year.close`, `channel-credential.write`, `payment.execute`, `password.change`, `role.permission.assign`, `api-client.secret.rotate`) require a step-up token (5 min, single action, `X-Step-Up-Token` header) obtained via `POST /auth/step-up`.
- **Break-glass**: emergency elevated session, permission `identity.break_glass.use`, max 60 min, loud audit + notification to superadmins, requires reason ≥ 20 chars.

### 2.2 Auth endpoints

| Method · Path | Auth | Permission | Purpose | Request (key fields) | Response | Important errors |
|---|---|---|---|---|---|---|
| `GET /auth/config` | public | — | Login-page bootstrap: OTP enabled?, password enabled?, 2FA policy, org name/logo, password policy hints, `smsMode: real\|mock`. | — | `{ passwordLogin, otpLogin, mfaPolicy, orgName, logoUrl?, policy: { minLength, zxcvbnMin } }` | `RATE_LIMITED` |
| `POST /auth/login` | public | — | Password login. Starts a session; may return a 2FA challenge. | `username` (mobile/email/username), `password`, `deviceFingerprint`, `deviceName?`, `rememberDevice?` | `200` tokens + user; or `202 { mfaRequired: true, challengeId, methods:["otp_sms"], expiresIn }` (no tokens) | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `MFA_REQUIRED`, `RATE_LIMITED`, `RESOURCE_LOCKED` |
| `POST /auth/login/otp` | public | — | Passwordless login step 1: request OTP for a mobile. | `mobile`, `deviceFingerprint`, `deviceName?` | `202 { challengeId, expiresIn, resendAfter }` (same shape for existing/unknown mobile) | `RATE_LIMITED`, `OTP_RESEND_TOO_SOON` |
| `POST /auth/otp/request` | public/self | — | Request OTP for any purpose (`login`, `mfa`, `password_reset`, `sensitive_action`, `device_trust`). | `purpose`, `mobile?` (required for public purposes), `challengeId?` | `202 { challengeId, expiresIn, resendAfter, maskMobile }` | `OTP_RESEND_TOO_SOON`, `RATE_LIMITED`, `VALIDATION_ERROR` |
| `POST /auth/otp/verify` | public | — | Verify OTP for login/mfa/passwordless; issues tokens on success. | `challengeId`, `code` (6 digits), `deviceFingerprint`, `trustDevice?` | `200` tokens + `user` + `permissionsVersion`; `204` if purpose was `password_reset` (returns resetToken separately) | `OTP_INVALID`, `OTP_EXPIRED`, `OTP_ATTEMPTS_EXCEEDED`, `MFA_REQUIRED` |
| `POST /auth/otp/voice` | public | — | Voice OTP fallback via Limo `SendOTPVoice` (rate-limited, `smsMode` must be real). | `mobile`, `challengeId?` | `202 { challengeId, expiresIn }` | `NOT_IMPLEMENTED` (`SMS_MODE=mock`), `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE` |
| `POST /auth/mfa/verify` | public | — | Complete a pending login challenge; marks the session `mfa_verified`. | `challengeId`, `code`, `trustDevice?` | `200` tokens + user | `OTP_INVALID`, `OTP_EXPIRED`, `MFA_REQUIRED`, `UNAUTHENTICATED` |
| `POST /auth/mfa/resend` | public | — | Resend the login challenge OTP. | `challengeId` | `202 { resendAfter }` | `OTP_RESEND_TOO_SOON`, `NOT_FOUND` |
| `POST /auth/refresh` | cookie+csrf | — | Rotate refresh token, issue a new access token; refreshes `pv`. | (cookie; body empty) | `200` tokens + `permissionsVersion`; rotated `Set-Cookie` | `UNAUTHENTICATED`, `SESSION_REVOKED`, `REFRESH_TOKEN_REUSED` |
| `POST /auth/logout` | self | — | Revoke current session and clear cookie. | `allDevices?` | `204` | `UNAUTHENTICATED` |
| `POST /auth/logout-all` | self | — | Revoke every session of the caller (all devices). | — | `204` | `UNAUTHENTICATED` |
| `GET /auth/me` | self | — | Current user profile + effective roles + permission keys + scopes + `permissionsVersion`. | — | `{ id, fullName, mobile, email?, roles[], permissions[] (keys), scope, mfa, lastLoginAt, org }` | `UNAUTHENTICATED` |
| `GET /auth/permissions` | self | — | Permission registry digest for client-side menu rendering (only the caller's keys + registry version). | — | `{ version, keys[] }` | `UNAUTHENTICATED` |
| `PATCH /auth/me` | self | — | Update own profile (name, email, language, avatar file id). | `fullName?`, `email?`, `language?`, `avatarFileId?` | `200` user | `VALIDATION_ERROR`, `VERSION_CONFLICT` |
| `POST /auth/password/change` | self | — | Change own password (step-up required). | `currentPassword`, `newPassword`, `stepUpToken` | `204`; all other sessions revoked | `CURRENT_PASSWORD_INVALID`, `PASSWORD_POLICY_VIOLATION`, `STEP_UP_REQUIRED` |
| `POST /auth/password/forgot` | public | — | Start password reset (always `202` to avoid enumeration). | `mobile` | `202 { challengeId, expiresIn }` | `RATE_LIMITED` |
| `POST /auth/password/reset` | public | — | Complete reset with OTP-verified `resetToken`. | `resetToken`, `newPassword` | `204`; all sessions revoked | `OTP_INVALID`, `OTP_EXPIRED`, `PASSWORD_POLICY_VIOLATION` |
| `POST /auth/step-up` | self | — | Obtain a short-lived step-up token for a sensitive action. | `password` **or** `otpChallengeId`+`code`, `action` (expected permission key) | `200 { stepUpToken, expiresIn, action }` | `CURRENT_PASSWORD_INVALID`, `OTP_INVALID`, `RATE_LIMITED` |
| `POST /auth/break-glass` | self | `identity.break_glass.use` | Emergency elevation; expires automatically. | `reason` (≥20 chars), `durationMinutes` (≤60), `password`, `otpCode` | `200` tokens (elevated `scope`, `amr:["break_glass"]`) + notifies superadmins | `FORBIDDEN`, `VALIDATION_ERROR` |
| `GET /auth/sessions` | self | — | List the caller's active sessions (device label, IP /24, last used, current flag). | `?include=revoked` | cursor list of sessions | `UNAUTHENTICATED` |
| `DELETE /auth/sessions/{id}` | self | — | Revoke one own session by public id. | — | `204` | `NOT_FOUND`, `UNAUTHENTICATED` |
| `POST /auth/sessions/revoke-others` | self | — | Revoke all sessions except the current one. | — | `204 { revokedCount }` | `UNAUTHENTICATED` |
| `GET /auth/devices` | self | — | List known devices (trusted flag, last seen, platform). | — | list of devices | `UNAUTHENTICATED` |
| `POST /auth/devices/{id}/trust` | self | — | Trust a device for 30 days (requires OTP). | `otpChallengeId`, `code` | `200 { trustedUntil }` | `OTP_INVALID`, `NOT_FOUND` |
| `DELETE /auth/devices/{id}` | self | — | Forget a device (revokes its sessions and trust). | — | `204` | `NOT_FOUND` |
| `DELETE /auth/devices` | self | — | Forget all devices except current (revokes their sessions). | — | `204 { revokedCount }` | `UNAUTHENTICATED` |
| `GET /auth/security-events` | self | — | Own recent security events (logins, failures, revocations) for the "security" screen. | cursor + `type?` | cursor list | `UNAUTHENTICATED` |

---

## 3. How to read the endpoint catalog (§4)

Each module has one table with these columns:

| Column | Meaning |
|---|---|
| **Method · Path** | Full path under `/api/v1`. `{id}` is always a **public UUID**. Path params are validated. |
| **Perm** | Permission key required (registry §5). `self` = any authenticated user acting on own account. `public` = unauthenticated. `hmac` = channel webhook signature. |
| **Kind** | Flags: `C` cursor pagination, `O` offset pagination, `IK` `Idempotency-Key` required, `IM` `If-Match` required, `AS` async `202`+job, `B` bulk with per-item results, `FILE` file transfer per §7. |
| **Purpose** | One line: what the endpoint is for. |
| **Request (key)** | Key request fields / filters (`F:`), sort whitelist (`S:`), search (`Q:`); optional fields marked `?`. |
| **Response** | Shape of `data` and notable headers/status. Money fields are strings; ids are UUIDs. |
| **Errors** | Non-obvious error codes beyond the global `VALIDATION_ERROR`/`INTERNAL`. |

Universal rules applied to every row and not repeated:

1. All rows require authentication **except** those with `public` or `hmac`.
2. All `GET` list rows return `{ data: [], meta.pagination }` per §1.5.
3. Every `POST` that creates a business document also accepts `Idempotency-Key` (required only where `IK` is marked) and returns `201` with `Location`; action endpoints return `200`.
4. Mutations returning the resource include `ETag`; docs with `IM` also *require* `If-Match`.
5. Cost/price-inclusive responses are redacted unless the caller holds `product.cost.read`; see §10.3.
6. Every denial/approval/submit/post is audited (`audit_logs`) with `requestId`; no endpoint needs a separate "log" call.
7. Soft-deleted resources are invisible; `DELETE` is idempotent (`204` if already deleted).
8. All list endpoints default to `limit=50` (cursor) or `perPage=25` (offset); no unbounded lists exist.
9. Cross-org access returns `404`; scope violations return `403 SCOPE_DENIED`.
10. Fields that reference another aggregate accept only UUID `*Id` values (never codes, never bigints).

## 4. Endpoint catalog (by module)

### 4.1 Identity — users, roles, permissions, sessions, devices, security events

| Method · Path | Perm | Kind | Purpose | Request (key) | Response | Errors |
|---|---|---|---|---|---|---|
| `GET /users` | `user.read` | O | List users. | `F:q,status,roleId,branchId,departmentId`; `S:createdAt,fullName,lastLoginAt`; `Q` | list of user summaries | — |
| `POST /users` | `user.create` | IK | Create a user and assign roles/scope; optionally send SMS invite. | `mobile`, `fullName`, `email?`, `password?`, `roleIds[]`, `branchIds[]`, `warehouseIds[]`, `departmentId?`, `sendInvite?` | `201` user | `CONFLICT` (mobile exists), `PASSWORD_POLICY_VIOLATION` |
| `GET /users/{id}` | `user.read` | — | User detail + roles + scope + status. | — | user | `NOT_FOUND` |
| `PATCH /users/{id}` | `user.update` | IM | Update profile fields (not roles/scope/password). | `fullName?`, `email?`, `departmentId?`, `language?`, `status?` | user | `VERSION_CONFLICT` |
| `DELETE /users/{id}` | `user.delete` | — | Soft-delete a user; revokes sessions; blocks self-delete and last superadmin. | — | `204` | `RULE_VIOLATION` (`last_superadmin`, `self_delete`) |
| `POST /users/{id}/activate` | `user.update` | — | Reactivate a disabled user. | — | user | `DOCUMENT_STATE_INVALID` |
| `POST /users/{id}/deactivate` | `user.update` | — | Disable user and revoke all sessions immediately. | `reason` | user | `DOCUMENT_STATE_INVALID` |
| `PUT /users/{id}/roles` | `role.assign` | IM | Replace the user's role set; bumps `permissionsVersion`. | `roleIds[]` | user | `RULE_VIOLATION` (`last_superadmin`) |
| `PUT /users/{id}/scope` | `user.scope.assign` | IM | Replace branch/warehouse scope. | `branchIds[]`, `warehouseIds[]` | user | `VALIDATION_ERROR` |
| `POST /users/{id}/password/reset` | `user.update` | — | Admin-initiated reset: sends OTP/link, revokes sessions. | `delivery: "sms"\|"link"` | `202 { delivery, expiresIn }` | `NOT_FOUND`, `UPSTREAM_UNAVAILABLE` |
| `GET /users/{id}/permissions` | `user.read` | — | Effective permission keys (union of roles) + version. | — | `{ version, keys[] }` | `NOT_FOUND` |
| `GET /users/{id}/sessions` | `session.read` | O | Active sessions of a user. | `F:active` | list of sessions | `NOT_FOUND` |
| `POST /users/{id}/sessions/revoke` | `session.revoke` | — | Revoke all sessions of a user (force logout). | `reason` | `204 { revokedCount }` | `NOT_FOUND` |
| `GET /roles` | `role.read` | O | List roles (system roles flagged). | `F:system`; `S:name,createdAt`; `Q` | list of roles | — |
| `POST /roles` | `role.create` | IK | Create a custom role. | `name`, `nameFa`, `descriptionFa?`, `permissionKeys[]` | `201` role | `CONFLICT` (name) |
| `GET /roles/{id}` | `role.read` | — | Role detail with permission keys. | — | role | `NOT_FOUND` |
| `PATCH /roles/{id}` | `role.update` | IM | Rename/describe a non-system role. | `name?`, `nameFa?`, `descriptionFa?` | role | `RULE_VIOLATION` (`system_role_immutable`) |
| `DELETE /roles/{id}` | `role.delete` | — | Delete a non-system role with no users. | — | `204` | `RULE_VIOLATION` (`role_in_use`, `system_role_immutable`) |
| `GET /roles/{id}/permissions` | `role.read` | — | Permission keys of a role. | — | `{ keys[] }` | `NOT_FOUND` |
| `PUT /roles/{id}/permissions` | `role.assign` | IM | Replace role permission set; bumps every affected user's version. | `permissionKeys[]` | `{ keys[], affectedUsers }` | `VALIDATION_ERROR` (unknown key), `RULE_VIOLATION` (`system_role_immutable`) |
| `POST /roles/{id}/clone` | `role.create` | IK | Clone a role. | `name`, `nameFa` | `201` role | `CONFLICT` |
| `GET /roles/{id}/users` | `user.read` | O | Users holding a role. | — | list of user summaries | `NOT_FOUND` |
| `GET /permissions` | `permission.read` | — | Full permission registry grouped by resource (for the role editor). | `F:resource` | `{ version, groups: [{ resource, permissions[{key,action,descriptionFa}] }] }` | — |
| `GET /sessions` | `session.read` | O | All sessions across users (admin view). | `F:userId,active,ip`; `S:lastUsedAt` | list of sessions | — |
| `DELETE /sessions/{id}` | `session.revoke` | — | Revoke one session by id. | — | `204` | `NOT_FOUND` |
| `GET /devices` | `device.read` | O | All known devices. | `F:userId,trusted,platform` | list of devices | — |
| `DELETE /devices/{id}` | `device.revoke` | — | Revoke a device and its sessions. | — | `204` | `NOT_FOUND` |
| `GET /security-events` | `security_event.read` | C | Security event log (logins, OTP failures, denials, reuse detection). | `F:type,userId,severity,gte:createdAt`; `C` | cursor list | — |
| `GET /security-events/{id}` | `security_event.read` | — | Event detail (redacted IP/UA). | — | security event | `NOT_FOUND` |

### 4.2 Organization — organization profile, branches, departments, currencies, holidays

| Method · Path | Perm | Kind | Purpose | Request (key) | Response | Errors |
|---|---|---|---|---|---|---|
| `GET /organization` | `organization.read` | — | Organization profile + fiscal/calendar settings summary. | — | org profile | — |
| `PATCH /organization` | `organization.update` | IM | Update legal name, national id, address, logo, contacts, base currency. | `legalName?`, `nationalId?`, `address?`, `phone?`, `email?`, `logoFileId?`, `baseCurrency?` | org | `VERSION_CONFLICT`, `VALIDATION_ERROR` |
| `GET /branches` | `branch.read` | O | List branches. | `F:status`; `S:name,code`; `Q` | list of branches | — |
| `POST /branches` | `branch.create` | IK | Create a branch. | `name`, `code`, `address?`, `phone?`, `managerUserId?` | `201` branch | `CONFLICT` (code) |
| `GET /branches/{id}` | `branch.read` | — | Branch detail. | — | branch | `NOT_FOUND` |
| `PATCH /branches/{id}` | `branch.update` | IM | Update branch. | `name?`, `address?`, `phone?`, `managerUserId?`, `status?` | branch | `VERSION_CONFLICT` |
| `DELETE /branches/{id}` | `branch.delete` | — | Soft-delete a branch (only if unused). | — | `204` | `RULE_VIOLATION` (`branch_in_use`) |
| `GET /departments` | `department.read` | O | List departments. | `F:branchId,status`; `S:name`; `Q` | list of departments | — |
| `POST /departments` | `department.create` | IK | Create a department. | `name`, `code`, `branchId`, `parentId?`, `managerUserId?` | `201` department | `CONFLICT` (code) |
| `GET /departments/{id}` | `department.read` | — | Department detail. | — | department | `NOT_FOUND` |
| `PATCH /departments/{id}` | `department.update` | IM | Update department. | `name?`, `parentId?`, `managerUserId?`, `status?` | department | `VERSION_CONFLICT` |
| `DELETE /departments/{id}` | `department.delete` | — | Soft-delete a department with no members. | — | `204` | `RULE_VIOLATION` (`department_in_use`) |
| `GET /currencies` | `currency.read` | O | Currencies and FX rates (v1: IRR active only, others inactive). | `F:active` | list of currencies | — |
| `POST /currencies` | `currency.create` | IK | Add a currency (inactive by default; for future multi-currency). | `code`, `nameFa`, `symbol`, `decimalPlaces` | `201` currency | `CONFLICT` (code) |
| `PATCH /currencies/{id}` | `currency.update` | IM | Update currency metadata / activate. | `nameFa?`, `symbol?`, `isActive?`, `fxRate?` | currency | `VERSION_CONFLICT` |
| `DELETE /currencies/{id}` | `currency.delete` | — | Delete an unused non-base currency. | — | `204` | `RULE_VIOLATION` (`base_currency`, `currency_in_use`) |
| `GET /holidays` | `holiday.read` | O | Calendar holidays used by SLA/fiscal calculations. | `F:year,branchId`; `S:date` | list of holidays | — |
| `POST /holidays` | `holiday.create` | IK | Add a holiday. | `date`, `titleFa`, `isOfficial?`, `branchId?` | `201` holiday | `CONFLICT` (date) |
| `PATCH /holidays/{id}` | `holiday.update` | IM | Update a holiday. | `titleFa?`, `isOfficial?` | holiday | `VERSION_CONFLICT` |
| `DELETE /holidays/{id}` | `holiday.delete` | — | Delete a holiday. | — | `204` | `NOT_FOUND` |

### 4.3 Catalog — categories, brands, products, variants, barcodes, attributes, media, units

Catalog responses contain prices/costs only when the caller has `product.cost.read`; list responses omit `cost` and `purchasePrice` entirely (§10.3). Imports/exports go through the async platform endpoints (`/imports`, `/exports`) and use `import.create` / `export.create`.

| Method · Path | Perm | Kind | Purpose | Request (key) | Response | Errors |
|---|---|---|---|---|---|---|
| `GET /categories` | `category.read` | O | Category list or full tree (`?tree=true`). | `F:parentId,status,channelId`; `tree?`; `S:name,sortOrder`; `Q` | list / nested tree | — |
| `POST /categories` | `category.create` | IK | Create a category node. | `nameFa`, `nameEn?`, `parentId?`, `code`, `sortOrder?`, `imageFileId?`, `attributes[]?` | `201` category | `CONFLICT` (code), `VALIDATION_ERROR` (cycle) |
| `GET /categories/{id}` | `category.read` | — | Category detail + ancestors path. | — | category | `NOT_FOUND` |
| `PATCH /categories/{id}` | `category.update` | IM | Update category. | `nameFa?`, `nameEn?`, `sortOrder?`, `imageFileId?`, `status?` | category | `VERSION_CONFLICT` |
| `DELETE /categories/{id}` | `category.delete` | — | Soft-delete a leaf category with no products. | — | `204` | `RULE_VIOLATION` (`category_has_children`, `category_has_products`) |
| `POST /categories/{id}/move` | `category.update` | — | Re-parent a category subtree. | `parentId?` | category | `RULE_VIOLATION` (`category_cycle`) |
| `POST /categories/bulk-update` | `category.update` | B | Bulk patch up to 100 categories. | `items[{id, ...fields}]` | per-item results | — |
| `GET /brands` | `brand.read` | O | Brand list. | `F:status`; `S:name`; `Q` | list of brands | — |
| `POST /brands` | `brand.create` | IK | Create a brand (logo via files flow). | `nameFa`, `nameEn?`, `logoFileId?`, `externalCodes?` | `201` brand | `CONFLICT` (name) |
| `GET /brands/{id}` | `brand.read` | — | Brand detail. | — | brand | `NOT_FOUND` |
| `PATCH /brands/{id}` | `brand.update` | IM | Update brand. | `nameFa?`, `nameEn?`, `logoFileId?`, `status?` | brand | `VERSION_CONFLICT` |
| `DELETE /brands/{id}` | `brand.delete` | — | Soft-delete a brand with no products. | — | `204` | `RULE_VIOLATION` (`brand_in_use`) |
| `GET /products` | `product.read` | C/O | Product catalog list with channel/stock flags. | `F:q,categoryId,brandId,status,hasStock,channelCode,updatedAt[gte]`; `S:createdAt,updatedAt,nameFa,sku`; `Q`; cost redacted | cursor/offset list | — |
| `POST /products` | `product.create` | IK | Create a product with variants, attributes, media. | `nameFa`, `nameEn?`, `categoryId`, `brandId?`, `description?`, `attributes[]?`, `variants[{sku, barcode?, attributes[], unitId, weight?}]`, `mediaFileIds[]?`, `status?` | `201` product | `CONFLICT` (sku/barcode), `VALIDATION_ERROR` (category attribute schema) |
| `GET /products/{id}` | `product.read` | — | Product detail with variants and media. | `include=variants,media,categories,attributes,suppliers` | product | `NOT_FOUND` |
| `PATCH /products/{id}` | `product.update` | IM | Update product master data (not variants). | `nameFa?`, `nameEn?`, `categoryId?`, `brandId?`, `description?`, `attributes?`, `status?` | product | `VERSION_CONFLICT` |
| `DELETE /products/{id}` | `product.delete` | — | Soft-delete a product with no stock/orders. | — | `204` | `RULE_VIOLATION` (`product_has_stock`, `product_in_orders`) |
| `POST /products/{id}/publish` | `product.update` | — | Activate a product for sale (channel push may follow). | `channelIds?` | product | `RULE_VIOLATION` (`product_incomplete`) |
| `POST /products/{id}/archive` | `product.update` | — | Archive a product (stops channel pushes, keeps history). | `reason` | product | `DOCUMENT_STATE_INVALID` |
| `POST /products/bulk-update` | `product.update` | B | Bulk update up to 100 products. | `items[{id, nameFa?, categoryId?, brandId?, status?, attrs?}]` | per-item results | — |
| `GET /products/lookup` | `product.read` | — | Scanner/search lookup by barcode/SKU/external code; used by warehouse UI. | `barcode?`, `sku?`, `channelCode?`+`externalId?` | `{ product, variants[] }` or `404` | `NOT_FOUND`, `VALIDATION_ERROR` |
| `GET /products/{id}/variants` | `variant.read` | O | Variants of a product. | `F:status`; `S:sku` | list of variants | `NOT_FOUND` |
| `POST /products/{id}/variants` | `variant.create` | IK | Add a variant (SKU). | `sku`, `barcode?`, `attributes[]`, `unitId`, `weight?`, `dimensions?` | `201` variant | `CONFLICT` (sku/barcode), `VALIDATION_ERROR` |
| `GET /products/{id}/price-history` | `product.read` | C | Sale price history (price lists/snapshots). | `F:channelId,currency,date[gte]` | cursor list | `NOT_FOUND` |
| `GET /products/{id}/cost-history` | `product.cost.read` | C | Purchase/landed cost history. | `F:date[gte]` | cursor list | `FORBIDDEN` |
| `GET /products/{id}/media` | `media.read` | O | Product media list (ordered, primary flag). | — | list of media | `NOT_FOUND` |
| `POST /products/{id}/media` | `media.create` | IK | Attach an uploaded file as product media. | `fileId`, `alt?`, `isPrimary?`, `sortOrder?` | `201` media | `NOT_FOUND`, `UPLOAD_UNSUPPORTED_TYPE` |
| `PATCH /products/{id}/media/{mediaId}` | `media.update` | IM | Reorder/set primary/alt text. | `alt?`, `isPrimary?`, `sortOrder?` | media | `NOT_FOUND` |
| `DELETE /products/{id}/media/{mediaId}` | `media.delete` | — | Detach media (file kept until garbage-collected). | — | `204` | `NOT_FOUND` |
| `GET /products/{id}/suppliers` | `supplier.read` | O | Supplier links + last purchase price. | — | list of links | `NOT_FOUND` |
| `PUT /products/{id}/suppliers` | `product.update` | IM | Replace supplier links (reference prices are cost-gated). | `items[{supplierId, supplierSku?, leadTimeDays?, lastPrice?}]` | links | `VALIDATION_ERROR` |
| `GET /variants` | `variant.read` | C/O | Variant list (flat, for stock/price screens). | `F:productId,status,hasStock,channelCode,barcode,sku`; `S:sku,createdAt`; `Q` | list of variants | — |
| `GET /variants/{id}` | `variant.read` | — | Variant detail + barcodes + attributes + stock summary. | `include=barcodes,attributes,inventory` | variant | `NOT_FOUND` |
| `PATCH /variants/{id}` | `variant.update` | IM | Update variant attributes/weight/unit. | `weight?`, `dimensions?`, `unitId?`, `attributes?`, `status?` | variant | `VERSION_CONFLICT` |
| `DELETE /variants/{id}` | `variant.delete` | — | Soft-delete a variant with no stock/orders. | — | `204` | `RULE_VIOLATION` (`variant_in_use`) |
| `PUT /variants/{id}/attributes` | `variant.update` | IM | Replace variant attribute values (validated against category attributes). | `values[{attributeId, valueId?, rawValue?}]` | variant | `VALIDATION_ERROR` |
| `GET /variants/{id}/barcodes` | `barcode.read` | O | Barcodes of a variant (manufacturer/internal/GTIN/QR). | — | list of barcodes | `NOT_FOUND` |
| `POST /variants/{id}/barcodes` | `barcode.create` | IK | Add a barcode; one primary GTIN per variant. | `value`, `type: "gtin13"\|"gtin8"\|"upc"\|"ean"\|"internal"\|"qr"`, `isPrimary?` | `201` barcode | `CONFLICT` (value), `VALIDATION_ERROR` (checksum) |
| `DELETE /variants/{id}/barcodes/{barcodeId}` | `barcode.delete` | — | Remove a barcode. | — | `204` | `NOT_FOUND`, `RULE_VIOLATION` (`primary_barcode`) |
| `GET /barcodes/lookup` | `barcode.read` | — | Resolve a scanned code to variant/product/location (scanner UX). | `code` (or `value`), `codeType?` | `{ barcode, variant, product? , location? }` | `NOT_FOUND` |
| `GET /barcodes/{id}` | `barcode.read` | — | Barcode detail. | — | barcode | `NOT_FOUND` |
| `GET /attributes` | `attribute.read` | O | Catalog attribute definitions. | `F:categoryId,type,isVariant`; `S:sortOrder`; `Q` | list of attributes | — |
| `POST /attributes` | `attribute.create` | IK | Create an attribute definition. | `nameFa`, `code`, `type: "select"\|"multiselect"\|"text"\|"number"\|"boolean"\|"date"`, `isVariant`, `isRequired`, `categoryIds[]`, `values[]?` | `201` attribute | `CONFLICT` (code) |
| `GET /attributes/{id}` | `attribute.read` | — | Attribute detail + values. | — | attribute | `NOT_FOUND` |
| `PATCH /attributes/{id}` | `attribute.update` | IM | Update attribute definition. | `nameFa?`, `type?`, `isRequired?`, `categoryIds?` | attribute | `RULE_VIOLATION` (`attribute_in_use_type_change`) |
| `DELETE /attributes/{id}` | `attribute.delete` | — | Soft-delete an unused attribute. | — | `204` | `RULE_VIOLATION` (`attribute_in_use`) |
| `GET /attributes/{id}/values` | `attribute.read` | O | Allowed values of an attribute. | `F:q` | list of values | `NOT_FOUND` |
| `PUT /attributes/{id}/values` | `attribute.update` | IM | Replace allowed values (order preserved). | `values[{id?, valueFa, valueEn?, sortOrder?}]` | list of values | `RULE_VIOLATION` (`value_in_use_removed`) |
| `PATCH /attribute-values/{id}` | `attribute.update` | IM | Rename/reorder one value. | `valueFa?`, `valueEn?`, `sortOrder?` | value | `NOT_FOUND` |
| `DELETE /attribute-values/{id}` | `attribute.update` | — | Delete an unused value. | — | `204` | `RULE_VIOLATION` (`value_in_use`) |
| `GET /units` | `unit.read` | O | Units of measure. | `F:type,status`; `S:nameFa`; `Q` | list of units | — |
| `POST /units` | `unit.create` | IK | Create a unit. | `nameFa`, `symbol`, `type: "count"\|"weight"\|"volume"\|"length"`, `isBase`, `precision?` | `201` unit | `CONFLICT` (symbol) |
| `GET /units/{id}` | `unit.read` | — | Unit detail + conversions. | `include=conversions` | unit | `NOT_FOUND` |
| `PATCH /units/{id}` | `unit.update` | IM | Update unit metadata. | `nameFa?`, `symbol?`, `status?` | unit | `VERSION_CONFLICT` |
| `DELETE /units/{id}` | `unit.delete` | — | Delete an unused unit. | — | `204` | `RULE_VIOLATION` (`unit_in_use`) |
| `GET /units/{id}/conversions` | `unit.read` | O | Conversion factors from this unit. | — | list of conversions | `NOT_FOUND` |
| `POST /units/{id}/conversions` | `unit.update` | IK | Add a conversion (e.g. carton = 12 pcs). | `toUnitId`, `factor` (decimal string), `rounding?` | `201` conversion | `CONFLICT`, `VALIDATION_ERROR` |
| `DELETE /units/{id}/conversions/{conversionId}` | `unit.update` | — | Delete a conversion. | — | `204` | `NOT_FOUND` |
| `GET /media/{id}` | `media.read` | — | Media metadata + presigned download link. | — | media + `downloadUrl` | `NOT_FOUND` |
| `DELETE /media/{id}` | `media.delete` | — | Delete media reference (owner-aware). | — | `204` | `NOT_FOUND` |

### 4.4 Inventory — balances, ledger, reservations, adjustments, transfers, lots, serials, units, counts, valuation

Stock semantics (`ADR-0007`): `available = onHand − reserved − safetyBuffer`. Channels only ever receive `available`. `onHand`, `reserved`, `available`, `safetyBuffer` are decimal strings. `unitCost`, `costRemaining`, `valuation` fields are **cost fields** and are redacted unless `product.cost.read`.

| Method · Path | Perm | Kind | Purpose | Request (key) | Response | Errors |
|---|---|---|---|---|---|---|
| `GET /inventory/balances` | `inventory.balance.read` | C | Balance projection per warehouse × variant × location. | `F:warehouseId,variantId,productId,locationId,includeZero,safetyBufferBelow,updatedAt[gte]` | balances (cost gated) | — |
| `GET /inventory/balances/{id}` | `inventory.balance.read` | — | One balance row + last movement. | — | balance | `NOT_FOUND` |
| `GET /inventory/availability` | `inventory.balance.read` | — | Bulk availability for allocation UI / channel push (`?variantIds=` max 100). | `variantIds[]`, `warehouseIds[]?`, `channelCode?` | `{ items[{variantId, available, byWarehouse[]}] }` | `VALIDATION_ERROR` (too many ids) |
| `GET /inventory/ledger` | `inventory.ledger.read` | C | Append-only inventory transactions. Range required (default last 31 days, max 366). | `F:warehouseId,variantId,type,referenceType,referenceId,createdAt[gte,lt]`; `S:createdAt` | ledger entries (unitCost cost-gated) | `VALIDATION_ERROR` (`date_range_required`) |
| `GET /inventory/ledger/{id}` | `inventory.ledger.read` | — | Ledger row + source document links. | — | ledger entry | `NOT_FOUND` |
| `GET /inventory/reservations` | `inventory.reserve.read` | C | Stock reservations (active/consumed/released/expired). | `F:status,variantId,warehouseId,sourceType,sourceId,expiresBefore` | reservations | — |
| `POST /inventory/reservations` | `inventory.reserve` | IK | Manual reservation (e.g. hold for a customer/order not yet confirmed); reason mandatory; TTL default 15 min. | `warehouseId`, `lines[{variantId, quantity}]`, `reason`, `ttlMinutes?` | `201` reservation | `INSUFFICIENT_STOCK`, `SCOPE_DENIED` |
| `GET /inventory/reservations/{id}` | `inventory.reserve.read` | — | Reservation detail. | — | reservation | `NOT_FOUND` |
| `POST /inventory/reservations/{id}/release` | `inventory.reserve` | — | Release a manual reservation. | `reason?` | reservation | `DOCUMENT_STATE_INVALID` |
| `POST /inventory/reservations/{id}/consume` | `inventory.reserve` | — | Consume manual reservation into a movement. | `referenceType`, `referenceId` | reservation | `DOCUMENT_STATE_INVALID` |
| `GET /inventory/adjustments` | `inventory.adjust.read` | O | Stock adjustments (count corrections, write-offs, damage). | `F:status,type,warehouseId,createdAt[gte]`; `S:createdAt` | list | — |
| `POST /inventory/adjustments` | `inventory.adjust` | IK | Create adjustment draft. Auto-routes to approval above threshold (`APPROVAL_REQUIRED`). | `warehouseId`, `type: "increase"\|"decrease"\|"writeoff"\|"damage"\|"correction"`, `reason`, `lines[{variantId, locationId, quantity, unitCost? (cost perm)}]`, `attachmentFileIds[]?` | `201` adjustment | `RULE_VIOLATION` (`negative_stock`), `APPROVAL_REQUIRED` |
| `GET /inventory/adjustments/{id}` | `inventory.adjust.read` | — | Detail + approval state + posted ledger refs. | — | adjustment | `NOT_FOUND` |
| `PATCH /inventory/adjustments/{id}` | `inventory.adjust` | IM | Edit a draft. | same as create | adjustment | `DOCUMENT_STATE_INVALID` |
| `DELETE /inventory/adjustments/{id}` | `inventory.adjust` | — | Delete a draft. | — | `204` | `DOCUMENT_STATE_INVALID` |
| `POST /inventory/adjustments/{id}/submit` | `inventory.adjust` | — | Submit for approval (or straight to posted if under threshold). | — | adjustment | `DOCUMENT_STATE_INVALID` |
| `POST /inventory/adjustments/{id}/approve` | `inventory.adjust.approve` | — | Approve (requester ≠ approver; step-up). | `stepUpToken`, `note?` | adjustment | `FORBIDDEN` (self-approval), `STEP_UP_REQUIRED` |
| `POST /inventory/adjustments/{id}/post` | `inventory.adjust.post` | — | Post to ledger in one transaction; updates balances. | — | adjustment + `ledgerIds[]` | `INSUFFICIENT_STOCK`, `PERIOD_CLOSED` |
| `POST /inventory/adjustments/{id}/void` | `inventory.adjust.post` | — | Void a posted adjustment via reversal entries. | `reason` | adjustment | `DOCUMENT_STATE_INVALID` |
| `GET /inventory/transfers` | `inventory.transfer.read` | C | Warehouse-to-warehouse transfers. | `F:status,fromWarehouseId,toWarehouseId,createdAt[gte]` | list | — |
| `POST /inventory/transfers` | `inventory.transfer` | IK | Create transfer request (stock leaves source only on dispatch). | `fromWarehouseId`, `toWarehouseId`, `lines[{variantId, fromLocationId, quantity}]`, `reason`, `expectedAt?` | `201` transfer | `INSUFFICIENT_STOCK`, `APPROVAL_REQUIRED` |
| `GET /inventory/transfers/{id}` | `inventory.transfer.read` | — | Transfer detail with dispatched/received quantities. | — | transfer | `NOT_FOUND` |
| `PATCH /inventory/transfers/{id}` | `inventory.transfer` | IM | Edit a draft transfer. | lines/reason/expectedAt | transfer | `DOCUMENT_STATE_INVALID` |
| `POST /inventory/transfers/{id}/submit` | `inventory.transfer` | — | Submit for approval/dispatch. | — | transfer | `DOCUMENT_STATE_INVALID` |
| `POST /inventory/transfers/{id}/approve` | `inventory.transfer.approve` | — | Approve (SoD). | `stepUpToken`, `note?` | transfer | `FORBIDDEN` (self-approval) |
| `POST /inventory/transfers/{id}/dispatch` | `inventory.transfer` | — | Dispatch: ledger-out from source, in-transit ledger state. | `scannedLines[]?` | transfer | `INSUFFICIENT_STOCK` |
| `POST /inventory/transfers/{id}/receive` | `inventory.transfer` | — | Receive: ledger-in at destination (partial allowed). | `lines[{lineId, receivedQuantity, toLocationId}]` | transfer | `DOCUMENT_STATE_INVALID` |
| `POST /inventory/transfers/{id}/cancel` | `inventory.transfer` | — | Cancel before dispatch (or reverse in-transit quantity). | `reason` | transfer | `DOCUMENT_STATE_INVALID` |
| `GET /inventory/lots` | `inventory.lot.read` | C | Batches/lots with expiry and remaining cost layers (cost gated). | `F:variantId,warehouseId,expiryBefore,status`; `S:expiryDate` | lots | — |
| `POST /inventory/lots` | `inventory.lot.create` | IK | Register a lot (normally auto-created on receipt). | `variantId`, `lotNumber`, `manufactureDate?`, `expiryDate?`, `supplierId?` | `201` lot | `CONFLICT` (lotNumber) |
| `GET /inventory/lots/{id}` | `inventory.lot.read` | — | Lot detail + trace. | `include=trace` | lot | `NOT_FOUND` |
| `PATCH /inventory/lots/{id}` | `inventory.lot.update` | IM | Correct dates/notes (not quantities). | `expiryDate?`, `manufactureDate?`, `notes?` | lot | `RULE_VIOLATION` (`lot_in_use_date_change`) |
| `DELETE /inventory/lots/{id}` | `inventory.lot.delete` | — | Delete an empty, unreferenced lot. | — | `204` | `RULE_VIOLATION` (`lot_has_stock`) |
| `GET /inventory/lots/{id}/trace` | `inventory.lot.read` | — | Forward/backward genealogy (receipt → orders). | — | trace graph | `NOT_FOUND` |
| `GET /inventory/serials` | `inventory.serial.read` | C | Serial-tracked items. | `F:variantId,status,warehouseId,serial`; `Q` | serials | — |
| `POST /inventory/serials` | `inventory.serial.create` | B/IK | Bulk register serials (max 500) for received goods. | `variantId`, `serials[]`, `warehouseId`, `locationId?`, `lotId?` | per-item results | `CONFLICT` (duplicate serial) |
| `GET /inventory/serials/{id}` | `inventory.serial.read` | — | Serial detail + event history. | — | serial | `NOT_FOUND` |
| `GET /inventory/serials/{id}/trace` | `inventory.serial.read` | — | Full serial movement trace. | — | trace graph | `NOT_FOUND` |
| `GET /inventory/units` | `inventory.unit.read` | C | Tracked physical units (for unit-level traceability SKUs). | `F:variantId,status,warehouseId,code`; `Q` | units | — |
| `POST /inventory/units` | `inventory.unit.create` | B/IK | Bulk create tracked units (max 500). | `variantId`, `units[{inventoryCode, lotId?, serialId?, locationId?}]` | per-item results | `CONFLICT` (inventoryCode) |
| `GET /inventory/units/{id}` | `inventory.unit.read` | — | Unit detail + current location/status. | — | unit | `NOT_FOUND` |
| `GET /inventory/units/{id}/events` | `inventory.unit.read` | C | Unit lifecycle events. | — | cursor list | `NOT_FOUND` |
| `POST /inventory/units/{id}/events` | `inventory.unit.update` | — | Record a unit event (move, repair, scrap) with reason. | `type: "move"\|"repair"\|"scrap"\|"return"\|"sale"`, `locationId?`, `referenceType?`, `referenceId?`, `note?` | unit | `DOCUMENT_STATE_INVALID` |
| `GET /inventory/counts` | `inventory.count.read` | C | Stock count sessions (cycle/full/spot). | `F:status,warehouseId,type,createdAt[gte]` | counts | — |
| `POST /inventory/counts` | `inventory.count` | IK | Create a count session (scope: warehouse/zone/category/variant list). | `warehouseId`, `type: "spot"\|"cycle"\|"full"`, `scope{locationIds[], categoryIds[], variantIds[]}`, `blind?`, `scheduledAt?` | `201` count | `RULE_VIOLATION` (`count_overlap`) |
| `GET /inventory/counts/{id}` | `inventory.count.read` | — | Count session + lines + progress. | `include=lines` | count | `NOT_FOUND` |
| `PATCH /inventory/counts/{id}` | `inventory.count` | IM | Edit scope before start. | `scope`, `blind?` | count | `DOCUMENT_STATE_INVALID` |
| `POST /inventory/counts/{id}/start` | `inventory.count` | — | Start counting (freezes count lines). | — | count | `DOCUMENT_STATE_INVALID` |
| `POST /inventory/counts/{id}/scans` | `inventory.count` | — | Record a scan/count (offline queue replays with client `eventId`). | `eventId` (client UUID), `variantId`, `locationId?`, `countedQuantity`, `lotId?`, `serial?` | count line | `DOCUMENT_STATE_INVALID`, `INVALID_BARCODE`→`RULE_VIOLATION` |
| `PUT /inventory/counts/{id}/lines` | `inventory.count` | B | Batch set counted quantities (desktop entry, max 500 lines). | `lines[{lineId, countedQuantity, note?}]` | count | `DOCUMENT_STATE_INVALID` |
| `POST /inventory/counts/{id}/submit` | `inventory.count` | — | Submit for variance review. | — | count | `DOCUMENT_STATE_INVALID` |
| `POST /inventory/counts/{id}/approve` | `inventory.count.approve` | — | Approve variance (SoD; above threshold → accounting approval too). | `stepUpToken`, `note?` | count | `FORBIDDEN` (self-approval) |
| `POST /inventory/counts/{id}/post` | `inventory.count.post` | — | Post variance as adjustment ledger rows in one transaction. | — | count + `adjustmentId` | `PERIOD_CLOSED` |
| `POST /inventory/counts/{id}/cancel` | `inventory.count` | — | Cancel a count before posting. | `reason` | count | `DOCUMENT_STATE_INVALID` |
| `GET /inventory/counts/{id}/variance` | `inventory.count.read` | — | Variance report (system vs counted vs value, cost gated). | `include=value` | variance summary + lines | `NOT_FOUND` |
| `GET /inventory/valuation` | `inventory.valuation.read` | — | Current valuation summary by warehouse/category (FIFO or weighted average per settings). | `F:warehouseId,categoryId,variantId,asOf` | valuation totals (cost gated) | — |
| `GET /inventory/valuation/layers` | `inventory.valuation.read` | C | FIFO cost layers with remaining quantity/cost. | `F:variantId,warehouseId,expiryBefore` | layers (cost gated) | — |
| `GET /inventory/integrity-check` | `inventory.balance.read` | AS | Run ledger-vs-balance consistency check as an async job; returns discrepancies. | `warehouseId?`, `since?` | `202` job | — |

### 4.5 Warehouse & WMS — locations tree, putaway, waves, picking, packing, devices

Location hierarchy is fixed: `warehouse → zone → aisle → rack → shelf → bin → location` (`ARCHITECTURE.md` §4). A location code is human-scannable (e.g. `TEH-A-03-02-01`). Warehouse operators' token scope limits writes to assigned warehouses (`403 SCOPE_DENIED`).

| Method · Path | Perm | Kind | Purpose | Request (key) | Response | Errors |
|---|---|---|---|---|---|---|
| `GET /warehouses` | `warehouse.read` | O | List warehouses. | `F:status,branchId`; `S:name,code`; `Q` | list | — |
| `POST /warehouses` | `warehouse.create` | IK | Create a warehouse. | `name`, `code`, `branchId`, `address`, `type: "main"\|"transit"\|"return"`, `settings?` | `201` warehouse | `CONFLICT` (code) |
| `GET /warehouses/{id}` | `warehouse.read` | — | Warehouse detail + capacity summary. | `include=capacity,stats` | warehouse | `NOT_FOUND` |
| `PATCH /warehouses/{id}` | `warehouse.update` | IM | Update warehouse. | `name?`, `address?`, `status?`, `settings?` | warehouse | `VERSION_CONFLICT` |
| `DELETE /warehouses/{id}` | `warehouse.delete` | — | Soft-delete an empty warehouse. | — | `204` | `RULE_VIOLATION` (`warehouse_has_stock`) |
| `GET /warehouses/{id}/tree` | `warehouse.location.read` | — | Full location tree (cached ETag). | `depth?`, `includeEmpty?` | nested tree | `NOT_FOUND` |
| `GET /warehouses/{id}/capacity` | `warehouse.read` | — | Capacity/utilization per zone/bin. | — | capacity rows | `NOT_FOUND` |
| `GET /warehouses/{id}/locations` | `warehouse.location.read` | C | Locations flat list (scanner/ops). | `F:code,zoneId,type,status,hasStock`; `S:code`; `Q` | locations | `NOT_FOUND` |
| `POST /warehouses/{id}/locations` | `warehouse.location.create` | IK | Create a location node. | `parentId?`, `code`, `type: "zone"\|"aisle"\|"rack"\|"shelf"\|"bin"\|"location"`, `capacity?`, `barcode?` | `201` location | `CONFLICT` (code) |
| `POST /warehouses/{id}/locations/bulk` | `warehouse.location.create` | B | Bulk create a location hierarchy (max 500). | `items[]` | per-item results | `CONFLICT` |
| `GET /locations/lookup` | `warehouse.location.read` | — | Resolve scanned location barcode/code. | `code` | location + parent path | `NOT_FOUND` |
| `GET /locations/{id}` | `warehouse.location.read` | — | Location detail + allowed products rules. | — | location | `NOT_FOUND` |
| `PATCH /locations/{id}` | `warehouse.location.update` | IM | Update location code/capacity/status. | `capacity?`, `status?`, `barcode?` | location | `VERSION_CONFLICT` |
| `DELETE /locations/{id}` | `warehouse.location.delete` | — | Soft-delete an empty location. | — | `204` | `RULE_VIOLATION` (`location_has_stock`) |
| `POST /locations/{id}/move` | `warehouse.location.update` | — | Re-parent a location node. | `parentId?` | location | `RULE_VIOLATION` (`location_cycle`) |
| `GET /locations/{id}/contents` | `warehouse.location.read` | C | Current stock in the bin. | — | balances | `NOT_FOUND` |
| `GET /locations/{id}/rules` | `warehouse.location.read` | O | Product-location rules (putaway constraints). | — | rules | `NOT_FOUND` |
| `PUT /locations/{id}/rules` | `warehouse.location.update` | IM | Replace rules (e.g. only category X or temp-controlled). | `rules[{categoryId?, productId?, variantId?, allow, maxQuantity?}]` | rules | `VALIDATION_ERROR` |
| `GET /putaway/tasks` | `warehouse.putaway.read` | C | Putaway work queue. | `F:status,warehouseId,assigneeId,receiptId`; `S:priority,createdAt` | tasks | — |
| `GET /putaway/tasks/{id}` | `warehouse.putaway.read` | — | Putaway task detail + suggestion. | — | task | `NOT_FOUND` |
| `POST /putaway/tasks` | `warehouse.putaway` | IK | Create a manual putaway task. | `warehouseId`, `lines[{variantId, quantity, lotId?, fromLocationId?}]`, `priority?` | `201` task | `VALIDATION_ERROR` |
| `POST /putaway/tasks/{id}/assign` | `warehouse.putaway` | — | Assign to operator/device. | `assigneeUserId?`, `deviceId?` | task | `DOCUMENT_STATE_INVALID` |
| `POST /putaway/tasks/{id}/scans` | `warehouse.putaway` | — | Scan/verify product + target location (offline-replayable via `eventId`). | `eventId`, `barcode`, `locationCode`, `quantity` | task progress | `RULE_VIOLATION` (`wrong_location`, `wrong_product`) |
| `POST /putaway/tasks/{id}/complete` | `warehouse.putaway` | — | Complete putaway; writes ledger move into the bin. | — | task + `ledgerIds[]` | `DOCUMENT_STATE_INVALID` |
| `POST /putaway/tasks/{id}/cancel` | `warehouse.putaway` | — | Cancel with reason. | `reason` | task | `DOCUMENT_STATE_INVALID` |
| `GET /putaway/suggestions` | `warehouse.putaway.read` | — | Suggest target location(s) for a receipt line (rules + capacity + chaos policy). | `warehouseId`, `variantId`, `quantity`, `lotId?` | `{ suggestions[{locationId, code, score, reason}] }` | — |
| `GET /pick-waves` | `warehouse.wave.read` | C | Pick waves. | `F:status,warehouseId,createdAt`; `S:createdAt` | waves | — |
| `POST /pick-waves` | `warehouse.wave` | IK | Plan a wave from confirmed orders (allocation strategy per settings). | `warehouseId`, `orderIds[]`, `strategy: "fifo"\|"fefo"\|"nearest"\|"fewest_picks"`, `priority?` | `201` wave | `INSUFFICIENT_STOCK`, `VALIDATION_ERROR` |
| `GET /pick-waves/{id}` | `warehouse.wave.read` | — | Wave detail + aggregated pick lines + route. | `include=tasks,route` | wave | `NOT_FOUND` |
| `POST /pick-waves/{id}/release` | `warehouse.wave` | — | Release wave to floor (creates/assigns tasks). | `assigneeIds[]?` | wave | `DOCUMENT_STATE_INVALID` |
| `POST /pick-waves/{id}/cancel` | `warehouse.wave` | — | Cancel a wave before picking starts (releases allocations). | `reason` | wave | `DOCUMENT_STATE_INVALID` |
| `GET /pick-waves/{id}/route` | `warehouse.wave.read` | — | Optimized pick route (sequence per location). | — | route steps | `NOT_FOUND` |
| `GET /pick-tasks` | `warehouse.pick.read` | C | Pick task queue (operator/device scoped). | `F:status,waveId,assigneeId,deviceId,locationId`; `S:sequence,priority` | tasks | — |
| `GET /pick-tasks/{id}` | `warehouse.pick.read` | — | Pick task with expected items. | — | task | `NOT_FOUND` |
| `POST /pick-tasks/{id}/assign` | `warehouse.pick` | — | Assign task to operator/device. | `assigneeUserId`, `deviceId?` | task | `DOCUMENT_STATE_INVALID` |
| `POST /pick-tasks/{id}/start` | `warehouse.pick` | — | Start picking (locks task). | — | task | `RESOURCE_LOCKED` |
| `POST /pick-tasks/{id}/scans` | `warehouse.pick` | — | Two-stage scan verification: location → variant barcode → quantity. | `eventId`, `barcode`, `locationCode?`, `quantity`, `lotId?`, `serial?` | task progress | `RULE_VIOLATION` (`wrong_product`, `wrong_quantity`, `wrong_location`) |
| `POST /pick-tasks/{id}/complete` | `warehouse.pick` | — | Complete pick (short picks must use `/short`). | — | task | `DOCUMENT_STATE_INVALID` |
| `POST /pick-tasks/{id}/short` | `warehouse.pick` | — | Report short pick; creates exception + deallocates remainder. | `lines[{lineId, pickedQuantity, reason}]` | task | `DOCUMENT_STATE_INVALID` |
| `POST /pick-tasks/{id}/cancel` | `warehouse.pick` | — | Cancel task, returning allocations. | `reason` | task | `DOCUMENT_STATE_INVALID` |
| `GET /packing-stations` | `warehouse.pack.read` | O | Packing stations. | `F:warehouseId,status` | stations | — |
| `POST /packing-stations` | `warehouse.pack` | IK | Create a packing station (printer/scale binding). | `warehouseId`, `name`, `printerId?`, `scaleId?`, `active?` | `201` station | `CONFLICT` (name) |
| `GET /packing-stations/{id}` | `warehouse.pack.read` | — | Station detail + current session. | — | station | `NOT_FOUND` |
| `PATCH /packing-stations/{id}` | `warehouse.pack` | IM | Update station binding/status. | `printerId?`, `scaleId?`, `active?` | station | `VERSION_CONFLICT` |
| `DELETE /packing-stations/{id}` | `warehouse.pack` | — | Delete an idle station. | — | `204` | `RULE_VIOLATION` (`station_busy`) |
| `GET /packing-tasks` | `warehouse.pack.read` | C | Packing queue. | `F:status,stationId,warehouseId,assigneeId`; `S:priority,createdAt` | tasks | — |
| `GET /packing-tasks/{id}` | `warehouse.pack.read` | — | Packing task + expected contents + label status. | `include=items,verifications` | task | `NOT_FOUND` |
| `POST /packing-tasks/{id}/start` | `warehouse.pack` | — | Start packing session on a station. | `stationId` | task/session | `RESOURCE_LOCKED` |
| `POST /packing-tasks/{id}/scans` | `warehouse.pack` | — | Anti-mispack verification: scan order, then product barcode, compare SKU/qty/channel. | `eventId`, `barcode`, `stage: "order"\|"product"\|"package"`, `quantity?` | verification result | `RULE_VIOLATION` (`pack_verification_failed`, `order_mismatch`, `channel_mismatch`) — blocks packing |
| `POST /packing-tasks/{id}/weight` | `warehouse.pack` | — | Record scale weight; compares to expected within tolerance. | `weightGrams`, `eventId` | `{ expected, actual, withinTolerance }` | `RULE_VIOLATION` (`weight_mismatch`) → manual review |
| `POST /packing-tasks/{id}/complete` | `warehouse.pack` | — | Seal package, produce label, mark order ready-to-ship. | `packageCount?`, `note?` | task + `packageId`, `labelId` | `DOCUMENT_STATE_INVALID`, `UPSTREAM_UNAVAILABLE` (label provider) |
| `POST /packing-tasks/{id}/block` | `warehouse.pack` | — | Block task after failed verification. | `reason` | task | `DOCUMENT_STATE_INVALID` |
| `POST /packing-tasks/{id}/override` | `warehouse.pack` | — | Supervisor override of a verification block (reason required, audited). | `reason`, `verifiedBarcode`, `supervisorNote` | task | `FORBIDDEN`, `STEP_UP_REQUIRED` |
| `GET /warehouse/devices` | `warehouse.device.read` | O | Scanner devices / mobile terminals. | `F:warehouseId,status,type` | devices | — |
| `POST /warehouse/devices` | `warehouse.device.register` | IK | Register a device (returns one-time device secret). | `warehouseId`, `name`, `type: "scanner"\|"tablet"\|"printer_agent"`, `serial?` | `201` device + `secret` (shown once) | `CONFLICT` (serial) |
| `PATCH /warehouse/devices/{id}` | `warehouse.device` | IM | Update device name/status/station binding. | `name?`, `status?`, `stationId?` | device | `VERSION_CONFLICT` |
| `DELETE /warehouse/devices/{id}` | `warehouse.device` | — | Revoke a device and its sessions. | — | `204` | `NOT_FOUND` |
| `POST /warehouse/devices/{id}/rotate-key` | `warehouse.device` | — | Rotate device secret (old one invalid immediately). | — | `{ secret, rotatedAt }` | `NOT_FOUND` |
| `GET /warehouse/workload` | `warehouse.read` | — | Operator workload/throughput for the shift. | `warehouseId`, `date?` | workload rows | — |

### 4.6 Procurement — suppliers, purchase orders, goods receipts, supplier invoices, reorder rules

Receiving writes stock through the inventory ledger only (`ADR-0007`); the receipt endpoint never updates balances directly. Three-way match (PO ↔ receipt ↔ supplier invoice) is mandatory before a supplier invoice can be posted.

| Method · Path | Perm | Kind | Purpose | Request (key) | Response | Errors |
|---|---|---|---|---|---|---|
| `GET /suppliers` | `supplier.read` | C/O | Supplier list. | `F:status,q`; `S:name,createdAt`; `Q` | suppliers | — |
| `POST /suppliers` | `supplier.create` | IK | Create supplier + payment terms. | `nameFa`, `code`, `nationalId?`, `mobile?`, `email?`, `address?`, `paymentTermDays?`, `currency?` | `201` supplier | `CONFLICT` (code) |
| `GET /suppliers/{id}` | `supplier.read` | — | Supplier detail + terms + balance. | — | supplier | `NOT_FOUND` |
| `PATCH /suppliers/{id}` | `supplier.update` | IM | Update supplier. | `nameFa?`, `contact?`, `paymentTermDays?`, `status?` | supplier | `VERSION_CONFLICT` |
| `DELETE /suppliers/{id}` | `supplier.delete` | — | Soft-delete an unused supplier. | — | `204` | `RULE_VIOLATION` (`supplier_in_use`) |
| `GET /suppliers/{id}/performance` | `supplier.read` | — | OTIF, lead time, defect rate, last purchase. | `from?`, `to?` | KPI summary | `NOT_FOUND` |
| `GET /suppliers/{id}/products` | `supplier.read` | O | Products supplied + supplier SKU + last price (cost gated). | — | links | `NOT_FOUND` |
| `PUT /suppliers/{id}/products` | `supplier.update` | IM | Replace product links. | `items[{productId\|variantId, supplierSku, leadTimeDays?, lastPrice?}]` | links | `VALIDATION_ERROR` |
| `GET /purchase-orders` | `purchase.order.read` | C | PO list. | `F:status,supplierId,warehouseId,expectedAt[gte],createdAt[gte]`; `S:createdAt,expectedAt` | POs | — |
| `POST /purchase-orders` | `purchase.order.create` | IK | Create PO draft (lines, prices, expected date). | `supplierId`, `warehouseId`, `expectedAt?`, `currency?`, `lines[{variantId, quantity, unitPrice, taxRateId?, discount?}]`, `notes?` | `201` PO | `VALIDATION_ERROR`, `PRICE_BELOW_MARGIN` (if selling-price guard applies) |
| `GET /purchase-orders/{id}` | `purchase.order.read` | — | PO detail + receipts + invoices + approval state. | `include=lines,receipts,invoices` | PO | `NOT_FOUND` |
| `PATCH /purchase-orders/{id}` | `purchase.order.update` | IM | Edit a draft PO. | lines/expectedAt/notes | PO | `DOCUMENT_STATE_INVALID` |
| `DELETE /purchase-orders/{id}` | `purchase.order.delete` | — | Delete a draft PO. | — | `204` | `DOCUMENT_STATE_INVALID` |
| `POST /purchase-orders/{id}/submit` | `purchase.order.update` | — | Submit for approval. | — | PO | `DOCUMENT_STATE_INVALID` |
| `POST /purchase-orders/{id}/approve` | `purchase.order.approve` | — | Approve (SoD + amount matrix). | `stepUpToken`, `note?` | PO | `FORBIDDEN` (self-approval), `STEP_UP_REQUIRED` |
| `POST /purchase-orders/{id}/reject` | `purchase.order.approve` | — | Reject with reason. | `reason` | PO | `DOCUMENT_STATE_INVALID` |
| `POST /purchase-orders/{id}/cancel` | `purchase.order.update` | — | Cancel an approved/receiving PO (no open receipts). | `reason` | PO | `RULE_VIOLATION` (`open_receipts`) |
| `POST /purchase-orders/{id}/close` | `purchase.order.update` | — | Close short (accept remaining as undelivered). | `reason` | PO | `DOCUMENT_STATE_INVALID` |
| `GET /purchase-orders/{id}/document` | `purchase.order.read` | FILE | Printable PO (PDF) via presigned link. | `format=pdf` | `{ fileId, downloadUrl }` | `NOT_FOUND` |
| `GET /goods-receipts` | `goods.receipt.read` | C | Receipts list. | `F:status,warehouseId,supplierId,purchaseOrderId,createdAt[gte]` | receipts | — |
| `POST /goods-receipts` | `goods.receipt.create` | IK | Open a receipt against a PO (or blind receipt if allowed). | `purchaseOrderId?`, `warehouseId`, `supplierId?`, `lines[{poLineId?, variantId, expectedQuantity, lotNumber?, expiryDate?}]`, `deliveryNote?` | `201` receipt | `DOCUMENT_STATE_INVALID`, `VALIDATION_ERROR` |
| `GET /goods-receipts/{id}` | `goods.receipt.read` | — | Receipt detail + scans + generated putaway tasks. | `include=lines,scans,putawayTasks` | receipt | `NOT_FOUND` |
| `PATCH /goods-receipts/{id}` | `goods.receipt.update` | IM | Edit header/expected quantities before posting. | `deliveryNote?`, `lines?` | receipt | `DOCUMENT_STATE_INVALID` |
| `POST /goods-receipts/{id}/scans` | `goods.receipt.execute` | — | Scan received item (barcode/lot/serial/qty); offline queue uses `eventId`. | `eventId`, `barcode`, `quantity`, `lotNumber?`, `serial?`, `targetLocationId?` | receipt line progress | `RULE_VIOLATION` (`unexpected_item`, `over_receipt`) |
| `POST /goods-receipts/{id}/complete` | `goods.receipt.execute` | — | Post receipt: ledger-in, lot/serial creation, PO received qty, putaway tasks, AP accrual hook. | — | receipt + `ledgerIds[]`, `putawayTaskIds[]` | `DOCUMENT_STATE_INVALID`, `PERIOD_CLOSED` |
| `POST /goods-receipts/{id}/cancel` | `goods.receipt.update` | — | Cancel an unposted receipt. | `reason` | receipt | `DOCUMENT_STATE_INVALID` |
| `GET /supplier-invoices` | `supplier.invoice.read` | C | Supplier invoices. | `F:status,supplierId,purchaseOrderId,receiptId,issueDate[gte]` | invoices | — |
| `POST /supplier-invoices` | `supplier.invoice.create` | IK | Register supplier invoice (amounts, tax, due date). | `supplierId`, `purchaseOrderId?`, `receiptId?`, `invoiceNumber`, `issueDate`, `dueDate`, `lines[{poLineId?, description, quantity, unitPrice, taxRateId?}]`, `attachmentFileIds[]?` | `201` invoice | `CONFLICT` (supplier+invoiceNumber), `VALIDATION_ERROR` |
| `GET /supplier-invoices/{id}` | `supplier.invoice.read` | — | Detail + match result + journal refs. | — | invoice | `NOT_FOUND` |
| `PATCH /supplier-invoices/{id}` | `supplier.invoice.update` | IM | Edit an unposted invoice. | header/lines | invoice | `DOCUMENT_STATE_INVALID` |
| `POST /supplier-invoices/{id}/match` | `supplier.invoice.match` | — | Run three-way match; returns discrepancies (qty/price/tax). | `tolerancePercent?` | `{ matched, discrepancies[] }` | `RULE_VIOLATION` (`match_failed`) |
| `POST /supplier-invoices/{id}/approve` | `supplier.invoice.approve` | — | Approve for posting (SoD). | `stepUpToken`, `note?` | invoice | `FORBIDDEN` (self-approval) |
| `POST /supplier-invoices/{id}/post` | `supplier.invoice.post` | — | Post AP journal + payable + optional tax document. | — | invoice + `journalEntryId` | `PERIOD_CLOSED`, `JOURNAL_UNBALANCED` |
| `POST /supplier-invoices/{id}/void` | `supplier.invoice.post` | — | Void by reversal (posted only). | `reason` | invoice | `DOCUMENT_STATE_INVALID` |
| `GET /reorder-rules` | `reorder.rule.read` | O | Reorder points / min-max rules. | `F:warehouseId,variantId,categoryId,active` | rules | — |
| `POST /reorder-rules` | `reorder.rule.create` | IK | Create a reorder rule. | `variantId`, `warehouseId`, `minQuantity`, `maxQuantity`, `reorderPoint`, `leadTimeDays?`, `safetyStock?` | `201` rule | `CONFLICT` (variant+warehouse) |
| `GET /reorder-rules/{id}` | `reorder.rule.read` | — | Rule detail. | — | rule | `NOT_FOUND` |
| `PATCH /reorder-rules/{id}` | `reorder.rule.update` | IM | Update rule. | quantities/lead time | rule | `VERSION_CONFLICT` |
| `DELETE /reorder-rules/{id}` | `reorder.rule.delete` | — | Delete rule. | — | `204` | `NOT_FOUND` |
| `GET /procurement/recommendations` | `purchase.order.read` | O | Purchase recommendations from reorder rules, sales velocity, open POs. | `F:warehouseId,supplierId,categoryId` | recommendation rows | — |

### 4.7 Sales — customers, sales orders, customer invoices, returns, refunds

Orders are canonical; channel orders are mapped in `channels` (§4.10) and never bypass this state machine. State machine: `draft → submitted → confirmed → allocated → picking → packed → shipped → delivered → closed`, with `cancelled`, `on_hold`, and per-line `returned`. Transitions are `POST` actions; an invalid transition is `409 DOCUMENT_STATE_INVALID`.

| Method · Path | Perm | Kind | Purpose | Request (key) | Response | Errors |
|---|---|---|---|---|---|---|
| `GET /customers` | `customer.read` | C | Customer list. | `F:status,groupId,q,mobile,createdAt[gte]`; `S:createdAt,fullName`; `Q` | customers | — |
| `POST /customers` | `customer.create` | IK | Create customer (+ first address, credit limit). | `fullName`, `mobile`, `email?`, `nationalId?`, `groupId?`, `creditLimit?`, `addresses[]?` | `201` customer | `CONFLICT` (mobile) |
| `GET /customers/{id}` | `customer.read` | — | Customer 360: profile, addresses, AR, orders summary. | `include=addresses,credit,orders` | customer | `NOT_FOUND` |
| `PATCH /customers/{id}` | `customer.update` | IM | Update customer. | `fullName?`, `email?`, `groupId?`, `status?`, `tags?` | customer | `VERSION_CONFLICT` |
| `DELETE /customers/{id}` | `customer.delete` | — | Soft-delete a customer with no open orders/receivables. | — | `204` | `RULE_VIOLATION` (`open_receivables`) |
| `GET /customers/lookup` | `customer.read` | — | Find customer by mobile/email/national id (POS/order entry). | `mobile`, `email?`, `nationalId?` | customer or `404` | `NOT_FOUND` |
| `GET /customers/{id}/addresses` | `customer.read` | O | Addresses. | — | addresses | `NOT_FOUND` |
| `POST /customers/{id}/addresses` | `customer.update` | IK | Add address (shipping/billing, geo for carrier rates). | `title`, `province`, `city`, `postalCode`, `line1`, `line2?`, `lat?`, `lng?`, `isDefault?` | `201` address | `VALIDATION_ERROR` |
| `PATCH /addresses/{id}` | `customer.update` | IM | Update address. | address fields | address | `NOT_FOUND` |
| `DELETE /addresses/{id}` | `customer.update` | — | Delete non-default address. | — | `204` | `RULE_VIOLATION` (`default_address`) |
| `GET /customers/{id}/orders` | `sales.order.read` | C | Customer order history. | `F:status,createdAt[gte]` | orders | `NOT_FOUND` |
| `GET /customers/{id}/credit` | `customer.credit.read` | — | Credit limit, open AR, overdue, aging snapshot. | — | credit summary | `NOT_FOUND` |
| `PUT /customers/{id}/credit` | `customer.credit.update` | IM | Set credit limit and terms. | `creditLimit`, `termDays?`, `note?` | credit summary | `VERSION_CONFLICT` |
| `GET /sales-orders` | `sales.order.read` | C | Sales orders across channels. | `F:status,channelCode,customerId,warehouseId,createdAt[gte],orderDate[gte]`; `S:createdAt,orderDate,total` (total sort cost-gated?) | orders | — |
| `POST /sales-orders` | `sales.order.create` | IK | Create a manual sales order (storefront/phone). Channel orders arrive via webhook/sync instead. | `customerId`, `channelCode?`, `warehouseId?`, `lines[{variantId, quantity, unitPrice, discount?, taxRateId?}]`, `shippingAddressId?`, `notes?` | `201` order | `INSUFFICIENT_STOCK` (if auto-confirm), `VALIDATION_ERROR` |
| `GET /sales-orders/{id}` | `sales.order.read` | — | Order detail: lines, allocations, shipments, journal refs, status history. | `include=lines,allocations,shipments,history,customer` | order | `NOT_FOUND` |
| `PATCH /sales-orders/{id}` | `sales.order.update` | IM | Edit a draft order. | header/lines | order | `DOCUMENT_STATE_INVALID` |
| `DELETE /sales-orders/{id}` | `sales.order.delete` | — | Delete a draft order. | — | `204` | `DOCUMENT_STATE_INVALID` |
| `POST /sales-orders/{id}/submit` | `sales.order.update` | — | Submit draft for confirmation. | — | order | `DOCUMENT_STATE_INVALID`, `VALIDATION_ERROR` |
| `POST /sales-orders/{id}/confirm` | `sales.order.update` | — | Confirm order → reserve stock atomically (`ADR-0007`); all-or-nothing per order. | `partialFulfilmentAllowed?` (if false → hard failure) | order | `INSUFFICIENT_STOCK` (details per line), `SCOPE_DENIED` |
| `POST /sales-orders/{id}/allocate` | `sales.order.update` | — | Re-run allocation engine (choose locations) after confirmation. | `strategy?` | order + allocations | `INSUFFICIENT_STOCK` |
| `POST /sales-orders/{id}/deallocate` | `sales.order.update` | — | Release reservations (returns order to confirmed). | `reason` | order | `DOCUMENT_STATE_INVALID` |
| `POST /sales-orders/{id}/hold` | `sales.order.update` | — | Put order on hold (blocks fulfillment). | `reason` | order | `DOCUMENT_STATE_INVALID` |
| `POST /sales-orders/{id}/release` | `sales.order.update` | — | Release hold. | — | order | `DOCUMENT_STATE_INVALID` |
| `POST /sales-orders/{id}/cancel` | `sales.order.update` | — | Cancel order; releases reservations and reverses journal if posted. | `reason`, `restock?` | order | `DOCUMENT_STATE_INVALID`, `PERIOD_CLOSED` |
| `GET /sales-orders/{id}/allocations` | `sales.order.read` | — | Reservation/allocation breakdown per line/location. | — | allocations | `NOT_FOUND` |
| `GET /sales-orders/{id}/shipments` | `shipment.read` | O | Shipments/packages of the order. | — | shipments | `NOT_FOUND` |
| `GET /sales-orders/{id}/history` | `sales.order.read` | C | Status history with actor and reason. | — | cursor list | `NOT_FOUND` |
| `POST /sales-orders/{id}/lines` | `sales.order.update` | IK | Add a line to a draft order. | `variantId`, `quantity`, `unitPrice`, `discount?`, `taxRateId?` | `201` line | `DOCUMENT_STATE_INVALID` |
| `PATCH /sales-orders/{id}/lines/{lineId}` | `sales.order.update` | IM | Amend a draft line. | quantity/price/discount | line | `DOCUMENT_STATE_INVALID` |
| `DELETE /sales-orders/{id}/lines/{lineId}` | `sales.order.update` | — | Remove a draft line. | — | `204` | `DOCUMENT_STATE_INVALID` |
| `GET /sales-orders/{id}/document` | `sales.order.read` | FILE | Order invoice/proforma PDF via presigned link. | `type=proforma\|invoice` | `{ fileId, downloadUrl }` | `NOT_FOUND` |
| `GET /customer-invoices` | `customer.invoice.read` | C | Customer invoices. | `F:status,customerId,orderId,issueDate[gte]` | invoices | — |
| `POST /customer-invoices` | `customer.invoice.create` | IK | Create invoice from an order/return (draft). | `orderId?`, `returnId?`, `customerId`, `lines[]`, `taxRates?` | `201` invoice | `VALIDATION_ERROR` |
| `GET /customer-invoices/{id}` | `customer.invoice.read` | — | Invoice detail + tax doc + payment allocations. | — | invoice | `NOT_FOUND` |
| `POST /customer-invoices/{id}/issue` | `customer.invoice.issue` | — | Issue (allocate number, snapshot, tax document, AR journal). | `issueDate?` | invoice | `PERIOD_CLOSED`, `DOCUMENT_STATE_INVALID` |
| `POST /customer-invoices/{id}/void` | `customer.invoice.void` | — | Void by reversal (never delete). | `reason` | invoice | `DOCUMENT_STATE_INVALID` |
| `GET /customer-invoices/{id}/document` | `customer.invoice.read` | FILE | Invoice PDF (and e-invoicing export format). | `format=pdf\|xml\|json` | `{ fileId, downloadUrl }` | `NOT_FOUND`, `NOT_IMPLEMENTED` (e-invoicing submission) |
| `GET /returns` | `sales.return.read` | C | Returns/RMAs. | `F:status,orderId,customerId,createdAt[gte]` | returns | — |
| `POST /returns` | `sales.return.create` | IK | Create a return request (RMA) with lines/reasons; `resolution` is refund/exchange/credit. | `orderId`, `lines[{orderLineId, quantity, reason}]`, `resolution`, `attachmentFileIds[]?` | `201` return | `RULE_VIOLATION` (`return_quantity_exceeded`) |
| `GET /returns/{id}` | `sales.return.read` | — | Return detail + inspection + refund link. | `include=lines,refund` | return | `NOT_FOUND` |
| `PATCH /returns/{id}` | `sales.return.update` | IM | Edit a requested return. | lines/resolution | return | `DOCUMENT_STATE_INVALID` |
| `POST /returns/{id}/receive` | `sales.return.update` | — | Receive returned goods into a return location (does not restock yet). | `warehouseId`, `lines[{lineId, receivedQuantity, locationId}]` | return | `DOCUMENT_STATE_INVALID` |
| `POST /returns/{id}/inspect` | `sales.return.update` | — | Record inspection result per line; decides restock vs scrap. | `lines[{lineId, condition: "sellable"\|"damaged"\|"scrap", quantity}]` | return | `DOCUMENT_STATE_INVALID` |
| `POST /returns/{id}/approve` | `sales.return.approve` | — | Approve return for restock/refund (SoD, step-up). | `stepUpToken`, `note?` | return | `FORBIDDEN` (self-approval) |
| `POST /returns/{id}/close` | `sales.return.update` | — | Close return after restock and refund (journal auto-post). | — | return | `DOCUMENT_STATE_INVALID`, `PERIOD_CLOSED` |
| `GET /refunds` | `sales.refund.read` | C | Refunds. | `F:status,returnId,orderId,customerId,createdAt[gte]` | refunds | — |
| `POST /refunds` | `sales.refund.create` | IK | Create refund (cash/credit/gateway); threshold → approval. | `returnId?`, `orderId?`, `customerId`, `amount`, `method: "cash"\|"bank"\|"gateway"\|"store_credit"`, `bankAccountId?`, `reason` | `201` refund | `RULE_VIOLATION` (`refund_exceeds_paid`), `APPROVAL_REQUIRED` |
| `GET /refunds/{id}` | `sales.refund.read` | — | Refund detail + approval + payment refs. | — | refund | `NOT_FOUND` |
| `POST /refunds/{id}/approve` | `sales.refund.approve` | — | Approve refund (SoD). | `stepUpToken`, `note?` | refund | `FORBIDDEN` (self-approval) |
| `POST /refunds/{id}/pay` | `sales.refund.pay` | — | Execute refund through treasury; posts journal. | `paymentMethodId`, `reference?` | refund + `paymentId` | `PERIOD_CLOSED`, `UPSTREAM_UNAVAILABLE` (gateway) |
| `POST /refunds/{id}/void` | `sales.refund.void` | — | Void an unpaid refund. | `reason` | refund | `DOCUMENT_STATE_INVALID` |

### 4.8 Fulfillment — allocation, shipments, packages, labels, carriers, rates

| Method · Path | Perm | Kind | Purpose | Request (key) | Response | Errors |
|---|---|---|---|---|---|---|
| `POST /fulfillment/allocate` | `fulfillment.allocate` | B | Batch allocation run for confirmed orders (used by wave planning/cron). | `orderIds[]` (≤200), `warehouseId?`, `strategy?` | per-order results | `INSUFFICIENT_STOCK` (per item) |
| `GET /fulfillment/queue` | `warehouse.read` | C | Fulfillment work queue (confirmed/allocated orders by priority/SLA). | `F:warehouseId,status,channelCode,priority,createdAt` | orders | — |
| `GET /fulfillment/workload` | `warehouse.read` | — | Demand vs capacity per warehouse for the day. | `warehouseId?`, `date?` | workload | — |
| `GET /shipments` | `shipment.read` | C | Shipments. | `F:status,carrierId,orderId,warehouseId,shippedAt[gte]` | shipments | — |
| `POST /shipments` | `shipment.create` | IK | Create shipment from packed packages (one or more orders if consolidated). | `packageIds[]`, `carrierId`, `serviceLevel?`, `recipientAddressId` | `201` shipment | `VALIDATION_ERROR`, `DOCUMENT_STATE_INVALID` |
| `GET /shipments/{id}` | `shipment.read` | — | Shipment detail + events + tracking + label. | `include=events,packages,label` | shipment | `NOT_FOUND` |
| `PATCH /shipments/{id}` | `shipment.update` | IM | Update carrier/service/tracking before dispatch. | `carrierId?`, `serviceLevel?`, `trackingNumber?` | shipment | `DOCUMENT_STATE_INVALID` |
| `POST /shipments/{id}/dispatch` | `shipment.dispatch` | — | Dispatch: hand to carrier, ledger-out inventory, notify channel, post COGS journal. | `dispatchedAt?`, `trackingNumber?` | shipment | `DOCUMENT_STATE_INVALID`, `PERIOD_CLOSED` |
| `POST /shipments/{id}/deliver` | `shipment.dispatch` | — | Mark delivered (webhook/manual); triggers revenue recognition where configured. | `deliveredAt`, `proofFileId?` | shipment | `DOCUMENT_STATE_INVALID` |
| `POST /shipments/{id}/cancel` | `shipment.cancel` | — | Cancel before dispatch (restocks packages); after dispatch → return flow. | `reason` | shipment | `DOCUMENT_STATE_INVALID` |
| `GET /shipments/{id}/events` | `shipment.read` | C | Carrier/shipment events timeline. | — | cursor list | `NOT_FOUND` |
| `GET /packages` | `package.read` | C | Packages. | `F:status,orderId,stationId,createdAt[gte]` | packages | — |
| `POST /packages` | `package.create` | IK | Create a package manually (exception flows). | `orderId`, `items[{orderLineId, quantity}]`, `weightGrams?`, `dimensions?` | `201` package | `VALIDATION_ERROR` |
| `GET /packages/{id}` | `package.read` | — | Package content + label + shipment link. | `include=items,label,shipment` | package | `NOT_FOUND` |
| `PATCH /packages/{id}` | `package.update` | IM | Update package contents before sealing. | `items?`, `weightGrams?`, `dimensions?` | package | `DOCUMENT_STATE_INVALID` |
| `POST /packages/{id}/seal` | `package.seal` | — | Seal package (content immutable; label may be generated). | `weightGrams?` | package | `DOCUMENT_STATE_INVALID` |
| `DELETE /packages/{id}` | `package.delete` | — | Void an unsealed package. | `reason` | `204` | `DOCUMENT_STATE_INVALID` |
| `GET /shipping-labels/{id}` | `label.read` | — | Label metadata + status (pending/printed/reprinted). | — | label | `NOT_FOUND` |
| `POST /shipping-labels` | `label.create` | IK | Request a label for a package (channel label or postal). | `packageId`, `carrierId`, `labelType: "postal"\|"channel"\|"a4"\|"thermal"` | `201` label + `fileId` | `UPSTREAM_UNAVAILABLE`, `NOT_IMPLEMENTED` (unsupported channel label) |
| `POST /shipping-labels/{id}/reprint` | `label.reprint` | — | Create a print job for an existing label; increments reprint counter (audited). | `printerId?`, `copies?` | `202` print job | `NOT_FOUND` |
| `DELETE /shipping-labels/{id}` | `label.delete` | — | Void a label before use. | `reason` | `204` | `DOCUMENT_STATE_INVALID` |
| `GET /carriers` | `carrier.read` | O | Carriers/providers. | `F:active,type` | carriers | — |
| `POST /carriers` | `carrier.create` | IK | Create carrier with account/API settings reference. | `name`, `code`, `type: "post"\|"courier"\|"marketplace"\|"in_house"`, `trackingUrlTemplate?`, `active?` | `201` carrier | `CONFLICT` (code) |
| `GET /carriers/{id}` | `carrier.read` | — | Carrier detail + rates count. | — | carrier | `NOT_FOUND` |
| `PATCH /carriers/{id}` | `carrier.update` | IM | Update carrier. | name/active/settings | carrier | `VERSION_CONFLICT` |
| `DELETE /carriers/{id}` | `carrier.delete` | — | Delete unused carrier. | — | `204` | `RULE_VIOLATION` (`carrier_in_use`) |
| `GET /shipping-rates` | `shipping.rate.read` | O | Rate cards (weight/zone/service). | `F:carrierId,zone,active` | rates | — |
| `POST /shipping-rates` | `shipping.rate.create` | IK | Create a rate entry. | `carrierId`, `zone`, `minWeightGrams`, `maxWeightGrams`, `price`, `serviceLevel?`, `validFrom?`, `validTo?` | `201` rate | `CONFLICT` (overlapping range) |
| `PATCH /shipping-rates/{id}` | `shipping.rate.update` | IM | Update rate. | price/ranges/validity | rate | `VERSION_CONFLICT` |
| `DELETE /shipping-rates/{id}` | `shipping.rate.delete` | — | Delete rate. | — | `204` | `NOT_FOUND` |
| `POST /shipping-rates/quote` | `shipping.rate.read` | — | Quote shipping options for a destination/weight/order value. | `addressId\|city`, `weightGrams`, `orderValue?`, `carrierIds[]?` | `{ options[{carrierId, serviceLevel, price, etaDays}] }` | `VALIDATION_ERROR` |

### 4.9 Pricing — price lists, rules, calculation runs, marketplace fees, snapshots

Pricing is a core module (`project-doc.txt` §56–§62): `cost → rules → channel fees → tax → shipping/packaging → margin guard → final price`. Any final price below the configured margin triggers `PRICE_BELOW_MARGIN` unless overridden through approval. Price changes are versioned; recalculated prices are applied to channel price snapshots and pushed asynchronously.

| Method · Path | Perm | Kind | Purpose | Request (key) | Response | Errors |
|---|---|---|---|---|---|---|
| `GET /price-lists` | `price.list.read` | O | Price lists (retail/channel/wholesale). | `F:active,channelCode,currency`; `S:name` | lists | — |
| `POST /price-lists` | `price.list.create` | IK | Create a price list. | `name`, `channelCode?`, `currency?`, `validFrom?`, `validTo?`, `priority?` | `201` list | `CONFLICT` (name+channel) |
| `GET /price-lists/{id}` | `price.list.read` | — | List detail + item count + rules. | — | list | `NOT_FOUND` |
| `PATCH /price-lists/{id}` | `price.list.update` | IM | Update list. | name/validity/priority | list | `VERSION_CONFLICT` |
| `DELETE /price-lists/{id}` | `price.list.delete` | — | Delete an inactive list. | — | `204` | `RULE_VIOLATION` (`price_list_in_use`) |
| `POST /price-lists/{id}/activate` | `price.list.activate` | — | Activate a list (deactivates overlapping lower-priority lists). | — | list | `RULE_VIOLATION` (`overlapping_price_list`) |
| `GET /price-lists/{id}/items` | `price.list.read` | C | Items in a price list (variant-level prices). | `F:variantId,categoryId` | items | `NOT_FOUND` |
| `PUT /price-lists/{id}/items` | `price.list.update` | B | Bulk upsert items (≤500); optional approval for large changes. | `items[{variantId, price, minQuantity?, validFrom?, validTo?}]` | per-item results | `PRICE_BELOW_MARGIN`, `APPROVAL_REQUIRED`, `VALIDATION_ERROR` |
| `DELETE /price-lists/{id}/items/{itemId}` | `price.list.update` | — | Remove an item. | — | `204` | `NOT_FOUND` |
| `GET /price-rules` | `pricing.rule.read` | O | Pricing rules (markup/commission/tax/margin guard). | `F:type,active,channelCode,categoryId` | rules | — |
| `POST /price-rules` | `pricing.rule.create` | IK | Create a pricing rule. | `name`, `type: "markup"\|"margin"\|"commission"\|"tax"\|"rounding"\|"fixed"`, `scope{categoryIds?, brandIds?, variantIds?, channelCode?}`, `value`, `priority`, `active?` | `201` rule | `CONFLICT` (name), `VALIDATION_ERROR` |
| `GET /price-rules/{id}` | `pricing.rule.read` | — | Rule detail + effective scope preview. | — | rule | `NOT_FOUND` |
| `PATCH /price-rules/{id}` | `pricing.rule.update` | IM | Update rule. | value/scope/priority | rule | `VERSION_CONFLICT` |
| `DELETE /price-rules/{id}` | `pricing.rule.delete` | — | Delete an inactive rule. | — | `204` | `NOT_FOUND` |
| `POST /price-rules/{id}/activate` | `pricing.rule.activate` | — | Activate a rule (approval for commission/margin rules). | `stepUpToken?` | rule | `APPROVAL_REQUIRED`, `PRICE_BELOW_MARGIN` |
| `POST /pricing/calculate` | `pricing.calculate` | — | Price simulator / single calculation (no persistence). | `variantId`, `channelCode?`, `quantity?`, `costOverride? (cost perm)`, `overrides?` | `{ cost, steps[], finalPrice, margin, warnings[] }` (cost gated) | `PRICE_BELOW_MARGIN` (as warning, not error) |
| `GET /pricing/runs` | `pricing.run.read` | C | Calculation runs (batch recalculation). | `F:status,channelCode,createdAt[gte]` | runs | — |
| `POST /pricing/runs` | `pricing.run` | IK/AS | Start a batch price calculation (scope: category/channel/all). | `scope{categoryIds?, variantIds?, channelCode?}`, `dryRun?` | `202` job with run id | `VALIDATION_ERROR` |
| `GET /pricing/runs/{id}` | `pricing.run.read` | — | Run detail + progress + summary (changed/below-margin counts). | `include=items` | run | `NOT_FOUND` |
| `POST /pricing/runs/{id}/apply` | `pricing.run` | — | Apply calculated prices: write price history + channel snapshots; queue channel push. | `approvedByStepUpToken?`, `onlyChanged?` | run + `appliedCount` | `APPROVAL_REQUIRED`, `PRICE_BELOW_MARGIN` |
| `GET /pricing/runs/{id}/items` | `pricing.run.read` | C | Per-variant calculation results. | `F:changed,belowMargin` | items (cost gated) | `NOT_FOUND` |
| `GET /marketplace-fees` | `marketplace.fee.read` | O | Marketplace commission/fee rules. | `F:channelCode,active,categoryId` | fees | — |
| `POST /marketplace-fees` | `marketplace.fee.create` | IK | Create a fee rule. | `channelCode`, `categoryId?`, `type: "percent"\|"fixed"\|"tiered"`, `value`, `tiers?`, `validFrom?` | `201` fee | `CONFLICT` |
| `PATCH /marketplace-fees/{id}` | `marketplace.fee.update` | IM | Update fee rule. | value/tiers/validity | fee | `VERSION_CONFLICT` |
| `DELETE /marketplace-fees/{id}` | `marketplace.fee.delete` | — | Delete an inactive fee rule. | — | `204` | `NOT_FOUND` |
| `GET /pricing/snapshots` | `price.snapshot.read` | C | Price snapshots pushed to channels with status. | `F:channelCode,variantId,status,createdAt[gte]` | snapshots | — |
| `POST /pricing/snapshots` | `pricing.run` | B | Manually snapshot prices for a set of variants (emergency price fix; approval). | `channelCode`, `items[{variantId, price}]`, `reason` | per-item results | `APPROVAL_REQUIRED`, `PRICE_BELOW_MARGIN` |

### 4.10 Channels — accounts, encrypted credentials, mappings, sync jobs, webhooks, API-call log

Adapters are behind the canonical port (`ADR-0006`). Credentials are write-only: **no endpoint ever returns a secret**, only a fingerprint (`…last4`), algorithm, `rotatedAt`, `expiresAt`. Reads of credentials require `channel.account.read`; writes require `channel.credential.write` **plus** step-up and are audited. Inbound channel payloads are archived raw in `channel_webhook_events` before parsing.

| Method · Path | Perm | Kind | Purpose | Request (key) | Response | Errors |
|---|---|---|---|---|---|---|
| `GET /channels` | `channel.read` | O | Supported/configured channels (carexy, digikala, mock). | `F:active,code` | channels | — |
| `GET /channels/{id}` | `channel.read` | — | Channel detail + adapter capabilities + account count. | `include=accounts,capabilities` | channel | `NOT_FOUND` |
| `POST /channels` | `channel.create` | IK | Enable a channel from the supported-adapter catalog. | `code: "carexy"\|"digikala"\|"mock"`, `nameFa`, `settings?` | `201` channel | `CONFLICT` (already enabled), `NOT_IMPLEMENTED` (unsupported adapter) |
| `PATCH /channels/{id}` | `channel.update` | IM | Update channel settings (sync windows, debounce, buffer). | `settings{syncIntervalSeconds, stockDebounceSeconds, safetyBuffer?, autoConfirmOrders?}` | channel | `VERSION_CONFLICT` |
| `POST /channels/{id}/enable` | `channel.update` | — | Enable sync for a channel. | — | channel | `DOCUMENT_STATE_INVALID` |
| `POST /channels/{id}/disable` | `channel.update` | — | Disable sync (in-flight jobs finish; no new pushes). | `reason` | channel | `DOCUMENT_STATE_INVALID` |
| `GET /channels/health` | `channel.read` | — | Health of every channel account: last success, failure streak, rate-limit state. | — | health rows | — |
| `GET /channels/{id}/accounts` | `channel.account.read` | O | Seller/store accounts of a channel (multi-account supported). | `F:active,warehouseId` | accounts | `NOT_FOUND` |
| `POST /channels/{id}/accounts` | `channel.account.create` | IK | Create a channel account (credentials set separately). | `nameFa`, `externalSellerId`, `warehouseIds[]`, `settings?` | `201` account | `CONFLICT` (external id) |
| `GET /channel-accounts/{id}` | `channel.account.read` | — | Account detail + credential metadata (no secret) + health. | `include=health,credentialMeta,mappings` | account | `NOT_FOUND` |
| `PATCH /channel-accounts/{id}` | `channel.account.update` | IM | Update account name/warehouses/settings. | `nameFa?`, `warehouseIds?`, `active?`, `settings?` | account | `VERSION_CONFLICT` |
| `DELETE /channel-accounts/{id}` | `channel.account.delete` | — | Delete an account after mappings/sync are detached. | — | `204` | `RULE_VIOLATION` (`account_in_use`) |
| `POST /channel-accounts/{id}/test` | `channel.account.test` | — | Live auth/capability probe against the partner (rate-limited). | — | `{ ok, latencyMs, capabilities[], scopes[]? }` | `UPSTREAM_UNAVAILABLE`, `NOT_IMPLEMENTED` |
| `GET /channel-accounts/{id}/health` | `channel.account.read` | — | Detailed health/probe history. | `from?`, `to?` | health | `NOT_FOUND` |
| `GET /channel-accounts/{id}/credentials` | `channel.account.read` | — | Credential metadata only (fingerprint, algorithm, rotatedAt, expiresAt). Secret never returned. | — | metadata | `NOT_FOUND` |
| `PUT /channel-accounts/{id}/credentials` | `channel.credential.write` | IM | Set/rotate encrypted credentials (AES-256-GCM). Step-up required; write-only. | `payload` (channel-specific: `{apiKey}` Carexy; `{clientId, clientSecret}` Digikala; `{apiKey, senderNumber, patternId}` Limo), `expiresAt?` | `200` metadata | `STEP_UP_REQUIRED`, `VALIDATION_ERROR`, `APPROVAL_REQUIRED` (per policy) |
| `POST /channel-accounts/{id}/credentials/rotate` | `channel.credential.rotate` | — | Rotate secret: test new value first, then atomically replace; old value invalidated. | `payload`, `stepUpToken` | metadata | `UPSTREAM_UNAVAILABLE` (new secret rejected), `STEP_UP_REQUIRED` |
| `DELETE /channel-accounts/{id}/credentials` | `channel.credential.delete` | — | Remove credentials (disables account sync). | `reason` | `204` | `NOT_FOUND` |
| `GET /channels/{id}/product-mappings` | `channel.mapping.read` | C | ERP product/variant ↔ external product/variant mappings. | `F:status,variantId,externalId,mismatch` | mappings | — |
| `POST /channels/{id}/product-mappings` | `channel.mapping.create` | IK | Create a manual mapping. | `variantId`, `externalProductId`, `externalVariantId`, `externalSku?` | `201` mapping | `CONFLICT` (external id), `VALIDATION_ERROR` |
| `PATCH /channel-product-mappings/{id}` | `channel.mapping.update` | IM | Update mapping (e.g. re-link after marketplace re-creation). | `externalProductId?`, `externalVariantId?`, `status?` | mapping | `VERSION_CONFLICT` |
| `DELETE /channel-product-mappings/{id}` | `channel.mapping.delete` | — | Remove mapping (product stops syncing to channel). | — | `204` | `NOT_FOUND` |
| `POST /channels/{id}/product-mappings/auto` | `channel.mapping.auto` | AS | Auto-map by barcode/SKU/external code; returns a job with proposed mappings. | `dryRun?`, `overwrite?` | `202` job | `NOT_IMPLEMENTED` (`TBD-DIGIKALA` matching fields) |
| `GET /channels/{id}/inventory-mappings` | `channel.mapping.read` | C | Variant × warehouse ↔ external inventory/storage mapping. | `F:variantId,warehouseId` | mappings | — |
| `PUT /channels/{id}/inventory-mappings` | `channel.mapping.update` | B | Upsert inventory mappings (≤500). Carexy requires `storage_uuid`; Digikala uses variant stock. | `items[{variantId, warehouseId, externalInventoryId?, externalStorageId?, mode: "push"\|"pull"\|"both"}]` | per-item results | `VALIDATION_ERROR` (`mapping_required`) |
| `GET /channels/{id}/category-mappings` | `channel.mapping.read` | O | ERP category ↔ external category mapping. | `F:categoryId` | mappings | — |
| `PUT /channels/{id}/category-mappings` | `channel.mapping.update` | B | Upsert category mappings. | `items[{categoryId, externalCategoryId, externalPath?}]` | per-item results | `VALIDATION_ERROR` |
| `GET /channels/{id}/attribute-mappings` | `channel.mapping.read` | O | ERP attribute/value ↔ external attribute/variable mapping. | `F:attributeId` | mappings | — |
| `PUT /channels/{id}/attribute-mappings` | `channel.mapping.update` | B | Upsert attribute/variable mappings (Carexy `variables`, Digikala attributes `TBD-DIGIKALA`). | `items[{attributeId, valueId?, externalAttributeKey, externalValue?}]` | per-item results | `VALIDATION_ERROR` |
| `GET /channel-sync-jobs` | `channel.sync.read` | C | Sync job history (inventory/price/order/product/settlement). | `F:channelId,accountId,type,status,createdAt[gte]`; `S:createdAt` | jobs | — |
| `POST /channel-sync-jobs` | `channel.sync.trigger` | IK | Trigger a sync run. | `channelId`, `accountId?`, `type: "inventory_push"\|"price_push"\|"order_pull"\|"product_push"\|"settlement_pull"\|"full_reconcile"`, `scope{variantIds?, categoryIds?, from?, to?}` | `202` job | `NOT_IMPLEMENTED` (adapter lacks capability), `UPSTREAM_UNAVAILABLE` |
| `GET /channel-sync-jobs/{id}` | `channel.sync.read` | — | Job detail + counters + errors summary. | — | job | `NOT_FOUND` |
| `POST /channel-sync-jobs/{id}/retry` | `channel.sync.retry` | — | Retry a failed/partial job (only failed items). | `dryRun?` | `202` job | `DOCUMENT_STATE_INVALID` |
| `POST /channel-sync-jobs/{id}/cancel` | `channel.sync.cancel` | — | Cancel a queued/running job cooperatively. | — | job | `DOCUMENT_STATE_INVALID` |
| `GET /channel-sync-jobs/{id}/errors` | `channel.sync.read` | C | Per-item sync errors (dead-letter subset). | — | errors | `NOT_FOUND` |
| `GET /channels/{id}/webhook-subscriptions` | `channel.webhook.read` | O | Webhook subscriptions registered with the partner. | `F:accountId,eventType,active` | subscriptions | — |
| `POST /channels/{id}/webhook-subscriptions` | `channel.webhook.manage` | IK | Register a webhook URL at the partner (Digikala `/webhook/subscription`; Carexy `TBD-CAREXY`). | `accountId`, `eventTypes[]`, `webhookUrl`, `secret?` | `201` subscription | `NOT_IMPLEMENTED` (no partner API), `UPSTREAM_UNAVAILABLE` |
| `PATCH /channel-webhook-subscriptions/{id}` | `channel.webhook.manage` | IM | Enable/disable or change events. | `eventTypes?`, `active?` | subscription | `VERSION_CONFLICT` |
| `DELETE /channel-webhook-subscriptions/{id}` | `channel.webhook.manage` | — | Unsubscribe at partner and locally. | — | `204` | `UPSTREAM_UNAVAILABLE` (logged, retried) |
| `POST /channel-webhook-subscriptions/{id}/rotate-secret` | `channel.webhook.manage` | — | Rotate the HMAC secret used to verify inbound webhooks (dual-secret window 24 h). | — | `{ fingerprint, rotatedAt }` | `NOT_IMPLEMENTED` |
| `POST /channel-webhook-subscriptions/{id}/test` | `channel.webhook.manage` | — | Send a synthetic signed event to our own receiver (loopback test). | `eventType` | `{ delivered, verified }` | `UPSTREAM_UNAVAILABLE` |
| `GET /channel-webhook-events` | `channel.webhook.read` | C | Raw inbound webhook archive (payload included, secrets redacted). | `F:channelId,accountId,eventType,status,receivedAt[gte]` | events | — |
| `GET /channel-webhook-events/{id}` | `channel.webhook.read` | — | One archived event + processing attempts. | — | event | `NOT_FOUND` |
| `POST /channel-webhook-events/{id}/replay` | `channel.webhook.replay` | — | Re-process an archived event idempotently (safe; duplicate is a no-op). | `force?` | `202` job | `NOT_FOUND` |
| `GET /channel-api-calls` | `channel.api_call.read` | C | Outbound partner API call log (method, path, status, latency, retry count; bodies redacted). | `F:channelId,accountId,method,status,createdAt[gte]`; `S:createdAt` | calls | — |
| `GET /channel-api-calls/{id}` | `channel.api_call.read` | — | One call with redacted request/response excerpts. | — | call | `NOT_FOUND` |
| `GET /integration-dead-letters` | `integration.dead_letter.read` | C | Terminal failures after retries exhausted. | `F:channelId,type,createdAt[gte]` | dead letters | — |
| `POST /integration-dead-letters/{id}/retry` | `integration.dead_letter.retry` | — | Re-enqueue a dead letter. | — | `202` job | `NOT_FOUND` |
| `DELETE /integration-dead-letters/{id}` | `integration.dead_letter.delete` | — | Acknowledge/dismiss a dead letter. | `note?` | `204` | `NOT_FOUND` |
| `GET /channels/{id}/order-mappings` | `channel.mapping.read` | C | External order ↔ canonical order mapping (audit of ingestion). | `F:status,externalOrderId,createdAt[gte]` | mappings | — |

### 4.11 Accounting — chart of accounts, periods, journals, tax, valuation, budgets, approvals

Accounting is event-driven: business endpoints emit outbox events and the accounting service posts journals inside the same transaction where the money path requires it (`ARCHITECTURE.md` §7). Manual journals follow `draft → submitted → approved → posted`, corrections only via reversal (`POST …/reverse`), never by editing posted rows. Money fields are strings; every journal must balance or `422 JOURNAL_UNBALANCED`.

| Method · Path | Perm | Kind | Purpose | Request (key) | Response | Errors |
|---|---|---|---|---|---|---|
| `GET /accounting/accounts` | `accounting.coa.read` | O | Chart of accounts (Iranian 6-level: group/کل/معین/تفصیلی + analytical levels). | `F:level,parentId,type,active,code`; `S:code`; `Q` | accounts | — |
| `POST /accounting/accounts` | `accounting.coa.create` | IK | Create an account node. | `code`, `nameFa`, `nameEn?`, `parentId?`, `type: "asset"\|"liability"\|"equity"\|"income"\|"expense"`, `level`, `isPostable`, `currency?` | `201` account | `CONFLICT` (code), `VALIDATION_ERROR` (`parent_level`) |
| `GET /accounting/accounts/tree` | `accounting.coa.read` | — | Full CoA tree (cached ETag). | `depth?`, `activeOnly?` | tree | — |
| `GET /accounting/accounts/{id}` | `accounting.coa.read` | — | Account detail + balance + dimensions. | `include=balance` | account | `NOT_FOUND` |
| `PATCH /accounting/accounts/{id}` | `accounting.coa.update` | IM | Rename/deactivate account (code immutable). | `nameFa?`, `nameEn?`, `isActive?` | account | `RULE_VIOLATION` (`account_in_use`) |
| `DELETE /accounting/accounts/{id}` | `accounting.coa.delete` | — | Delete an unused leaf account. | — | `204` | `RULE_VIOLATION` (`account_has_entries`, `account_has_children`) |
| `POST /accounting/accounts/import` | `accounting.coa.import` | AS | Import the standard 6-level CoA hierarchy (idempotent). | `fileId` or inline `accounts[]` | `202` job | `IMPORT_VALIDATION_FAILED` |
| `GET /accounting/accounts/{id}/balance` | `accounting.balance.read` | — | Balance by period/dimension. | `fiscalYearId`, `periodId?`, `dimensions?` | `{ debit, credit, balance }` | `NOT_FOUND` |
| `GET /accounting/accounts/{id}/ledger` | `accounting.ledger.read` | C | Account ledger lines. | `F:periodId,date[gte],date[lt]`, `S:date` | lines | `NOT_FOUND` |
| `GET /accounting/dimensions` | `accounting.dimension.read` | O | Analytical dimensions (cost center, project, branch, channel). | `F:active` | dimensions | — |
| `POST /accounting/dimensions` | `accounting.dimension.create` | IK | Create a dimension. | `code`, `nameFa`, `isRequired` | `201` dimension | `CONFLICT` |
| `PATCH /accounting/dimensions/{id}` | `accounting.dimension.update` | IM | Update dimension. | `nameFa?`, `isRequired?`, `active?` | dimension | `VERSION_CONFLICT` |
| `DELETE /accounting/dimensions/{id}` | `accounting.dimension.delete` | — | Delete an unused dimension. | — | `204` | `RULE_VIOLATION` (`dimension_in_use`) |
| `GET /accounting/dimensions/{id}/values` | `accounting.dimension.read` | O | Dimension values. | `F:active` | values | `NOT_FOUND` |
| `PUT /accounting/dimensions/{id}/values` | `accounting.dimension.update` | IM | Replace values. | `values[{code, nameFa, active?}]` | values | `RULE_VIOLATION` (`value_in_use_removed`) |
| `GET /accounting/fiscal-years` | `accounting.fiscal_year.read` | O | Fiscal years and period status. | `F:status` | years + periods | — |
| `POST /accounting/fiscal-years` | `accounting.fiscal_year.create` | IK | Create a fiscal year and generate monthly periods from org calendar settings. | `startDate`, `endDate`, `title`, `periodType?` | `201` year + periods | `CONFLICT` (overlap), `VALIDATION_ERROR` |
| `GET /accounting/fiscal-years/{id}` | `accounting.fiscal_year.read` | — | Year detail + periods + close checklist. | `include=periods,checklist` | year | `NOT_FOUND` |
| `PATCH /accounting/fiscal-years/{id}` | `accounting.fiscal_year.update` | IM | Update title/settings before close. | `title?`, `settings?` | year | `RULE_VIOLATION` (`year_closed`) |
| `POST /accounting/fiscal-years/{id}/close` | `accounting.fiscal_year.close` | — | Close year: no open periods, no unposted journals, approval + step-up (break-glass only to reopen). | `stepUpToken`, `note` | year | `RULE_VIOLATION` (`unposted_journals`, `open_periods`), `FORBIDDEN` (self-approval) |
| `POST /accounting/fiscal-years/{id}/reopen` | `accounting.fiscal_year.reopen` | — | Reopen a closed year — superadmin only, step-up, full audit + notification. | `stepUpToken`, `reason` (≥30 chars) | year | `FORBIDDEN` |
| `GET /accounting/periods` | `accounting.period.read` | O | Periods and lock state. | `F:fiscalYearId,status` | periods | — |
| `POST /accounting/periods/{id}/close` | `accounting.period.close` | — | Close a period (rejects posting afterwards). | `note?` | period | `RULE_VIOLATION` (`unposted_journals`) |
| `POST /accounting/periods/{id}/reopen` | `accounting.period.reopen` | — | Reopen a period (finance manager + step-up). | `reason`, `stepUpToken` | period | `FORBIDDEN` |
| `GET /accounting/journal-entries` | `accounting.journal.read` | C | Journal entries. | `F:status,type,fiscalYearId,periodId,date[gte],sourceType,sourceId,createdBy`; `S:date,number,createdAt` | journals | — |
| `POST /accounting/journal-entries` | `accounting.journal.create` | IK | Create a manual journal draft (balanced). | `date`, `description`, `dimensions?`, `lines[{accountId, debit, credit, description?, dimensions?}]`, `attachmentFileIds[]?` | `201` journal | `JOURNAL_UNBALANCED`, `PERIOD_CLOSED`, `COST_CENTER_REQUIRED` |
| `GET /accounting/journal-entries/{id}` | `accounting.journal.read` | — | Journal detail + lines + approvals + source links. | `include=lines,approval,links` | journal | `NOT_FOUND` |
| `PATCH /accounting/journal-entries/{id}` | `accounting.journal.update` | IM | Edit a draft (balanced check on save). | lines/description/date | journal | `JOURNAL_UNBALANCED`, `PERIOD_CLOSED` |
| `DELETE /accounting/journal-entries/{id}` | `accounting.journal.delete` | — | Delete a draft. | — | `204` | `DOCUMENT_STATE_INVALID` |
| `POST /accounting/journal-entries/{id}/submit` | `accounting.journal.update` | — | Submit for approval. | — | journal | `DOCUMENT_STATE_INVALID` |
| `POST /accounting/journal-entries/{id}/approve` | `accounting.journal.approve` | — | Approve (requester ≠ approver; amount matrix). | `stepUpToken`, `note?` | journal | `FORBIDDEN` (self-approval) |
| `POST /accounting/journal-entries/{id}/post` | `accounting.journal.post` | — | Post: assigns document number, updates `account_balances`, locks lines. Step-up required. | `stepUpToken`, `postDate?` | journal | `PERIOD_CLOSED`, `JOURNAL_UNBALANCED`, `STEP_UP_REQUIRED` |
| `POST /accounting/journal-entries/{id}/reverse` | `accounting.journal.reverse` | — | Create and post a reversal entry (never edit posted). | `reason`, `reversalDate?` | reversal journal | `DOCUMENT_STATE_INVALID`, `PERIOD_CLOSED` |
| `GET /accounting/journal-entries/{id}/lines` | `accounting.journal.read` | — | Journal lines with account/dimension refs. | — | lines | `NOT_FOUND` |
| `POST /accounting/journal-entries/{id}/lines` | `accounting.journal.update` | — | Append a line to a draft. | `accountId`, `debit`, `credit`, `description?`, `dimensions?` | line | `DOCUMENT_STATE_INVALID` |
| `DELETE /accounting/journal-entries/{id}/lines/{lineId}` | `accounting.journal.update` | — | Remove a draft line. | — | `204` | `DOCUMENT_STATE_INVALID` |
| `GET /accounting/account-balances` | `accounting.balance.read` | C | Account × period balances (trial-balance source). | `F:fiscalYearId,periodId,accountId,level` | balances | — |
| `GET /accounting/general-ledger` | `accounting.ledger.read` | C | General ledger detail (posted lines). | `F:accountId,date[gte],date[lt],dimensions`; `S:date` | GL lines | — |
| `GET /accounting/sub-ledger` | `accounting.ledger.read` | C | Sub-ledger by party (customer/supplier/partner) for AR/AP control. | `F:partyType,partyId,date[gte]` | sub-ledger lines | — |
| `GET /accounting/journal-book` | `accounting.journal.read` | C | Chronological journal book with numbers and sources. | `F:fiscalYearId,date[gte],date[lt]` | journal book | — |
| `GET /accounting/posting-rules` | `accounting.posting_rule.read` | O | Auto-posting rules (event type → debit/credit accounts). | `F:eventType,active` | rules | — |
| `POST /accounting/posting-rules` | `accounting.posting_rule.manage` | IK | Create a posting rule. | `eventType`, `description`, `lines[{side: "debit"\|"credit", accountId, amountSource, dimensions?}]` | `201` rule | `VALIDATION_ERROR` |
| `PATCH /accounting/posting-rules/{id}` | `accounting.posting_rule.manage` | IM | Update rule (affects future events only). | rule fields | rule | `VERSION_CONFLICT` |
| `DELETE /accounting/posting-rules/{id}` | `accounting.posting_rule.manage` | — | Disable/delete a rule. | — | `204` | `NOT_FOUND` |
| `GET /accounting/tax-rates` | `accounting.tax.read` | O | VAT/tax rates with validity windows. | `F:active,type` | rates | — |
| `POST /accounting/tax-rates` | `accounting.tax.create` | IK | Create tax rate. | `nameFa`, `rate`, `type: "vat"\|"withholding"\|"other"`, `validFrom`, `validTo?` | `201` rate | `CONFLICT`, `VALIDATION_ERROR` |
| `PATCH /accounting/tax-rates/{id}` | `accounting.tax.update` | IM | Update tax rate validity/status. | `rate?`, `validTo?`, `active?` | rate | `VERSION_CONFLICT` |
| `DELETE /accounting/tax-rates/{id}` | `accounting.tax.delete` | — | Delete an unused rate. | — | `204` | `RULE_VIOLATION` (`tax_rate_in_use`) |
| `GET /accounting/tax-documents` | `accounting.document.read` | C | Tax documents (invoice/credit note/return) prepared for مؤدیان export. | `F:type,status,issueDate[gte],customerId` | documents | — |
| `POST /accounting/tax-documents` | `accounting.document.create` | IK | Create a tax document draft. | `type`, `invoiceId?`, `returnId?`, `payload?` | `201` document | `VALIDATION_ERROR` |
| `GET /accounting/tax-documents/{id}` | `accounting.document.read` | — | Tax document detail + payload + status. | — | document | `NOT_FOUND` |
| `POST /accounting/tax-documents/{id}/issue` | `accounting.document.issue` | — | Issue and assign a gap-free number. | `issueDate?` | document | `PERIOD_CLOSED`, `DOCUMENT_STATE_INVALID` |
| `POST /accounting/tax-documents/{id}/void` | `accounting.document.void` | — | Void with credit note. | `reason` | document | `DOCUMENT_STATE_INVALID` |
| `GET /accounting/tax-documents/{id}/export` | `accounting.document.export` | FILE | Export in مؤدیان-compatible JSON/XML (submission is out of scope). | `format=json\|xml` | `{ fileId, downloadUrl }` | `NOT_FOUND` |
| `GET /accounting/valuation-runs` | `accounting.valuation.read` | C | Inventory valuation runs (FIFO / weighted average). | `F:method,status,periodId,warehouseId` | runs | — |
| `POST /accounting/valuation-runs` | `accounting.valuation.run` | IK/AS | Start a valuation run for a period/warehouse set. | `method: "fifo"\|"weighted_average"`, `periodId`, `warehouseIds[]`, `asOf?` | `202` job | `PERIOD_CLOSED`, `APPROVAL_REQUIRED` |
| `GET /accounting/valuation-runs/{id}` | `accounting.valuation.read` | — | Run detail + totals + posting state. | — | run (cost gated) | `NOT_FOUND` |
| `GET /accounting/valuation-runs/{id}/lines` | `accounting.valuation.read` | C | Per-variant valuation lines. | `F:variantId,warehouseId` | lines (cost gated) | `NOT_FOUND` |
| `POST /accounting/valuation-runs/{id}/post` | `accounting.valuation.post` | — | Post valuation adjustment journal. | `stepUpToken?` | run + `journalEntryId` | `PERIOD_CLOSED`, `DOCUMENT_STATE_INVALID` |
| `GET /accounting/budgets` | `accounting.budget.read` | O | Budgets. | `F:fiscalYearId,status` | budgets | — |
| `POST /accounting/budgets` | `accounting.budget.create` | IK | Create budget with lines. | `fiscalYearId`, `name`, `lines[{accountId, periodId, amount, dimensions?}]` | `201` budget | `VALIDATION_ERROR` |
| `GET /accounting/budgets/{id}` | `accounting.budget.read` | — | Budget detail + variance. | `include=lines,variance` | budget | `NOT_FOUND` |
| `PATCH /accounting/budgets/{id}` | `accounting.budget.update` | IM | Update a draft budget (lines replace via PUT). | `name?`, `lines?` | budget | `DOCUMENT_STATE_INVALID` |
| `DELETE /accounting/budgets/{id}` | `accounting.budget.delete` | — | Delete a draft budget. | — | `204` | `DOCUMENT_STATE_INVALID` |
| `POST /accounting/budgets/{id}/approve` | `accounting.budget.approve` | — | Approve budget (SoD). | `stepUpToken` | budget | `FORBIDDEN` |
| `POST /accounting/budgets/{id}/activate` | `accounting.budget.activate` | — | Activate for variance tracking. | — | budget | `DOCUMENT_STATE_INVALID` |
| `GET /accounting/expenses` | `accounting.expense.read` | C | Operating expenses. | `F:status,categoryId,date[gte],costCenter` | expenses | — |
| `POST /accounting/expenses` | `accounting.expense.create` | IK | Create an expense (draft), with attachment. | `categoryId`, `amount`, `taxRateId?`, `date`, `descriptionFa`, `paymentMethodId?`, `costCenter?`, `attachmentFileIds[]?` | `201` expense | `VALIDATION_ERROR` |
| `GET /accounting/expenses/{id}` | `accounting.expense.read` | — | Expense detail + approval + journal. | — | expense | `NOT_FOUND` |
| `POST /accounting/expenses/{id}/submit` | `accounting.expense.update` | — | Submit for approval. | — | expense | `DOCUMENT_STATE_INVALID` |
| `POST /accounting/expenses/{id}/approve` | `accounting.expense.approve` | — | Approve expense (SoD). | `stepUpToken` | expense | `FORBIDDEN` |
| `POST /accounting/expenses/{id}/pay` | `accounting.expense.pay` | — | Pay via treasury (cash/bank) and post journal. | `bankAccountId?`, `cashBoxId?`, `paymentDate?` | expense + `paymentId` | `PERIOD_CLOSED` |
| `POST /accounting/expenses/{id}/void` | `accounting.expense.update` | — | Void an unpaid expense. | `reason` | expense | `DOCUMENT_STATE_INVALID` |
| `GET /accounting/expense-categories` | `accounting.expense.read` | O | Expense categories (mapped to CoA). | `F:active` | categories | — |
| `POST /accounting/expense-categories` | `accounting.expense.create` | IK | Create expense category. | `nameFa`, `accountId` | `201` category | `CONFLICT` |
| `PATCH /accounting/expense-categories/{id}` | `accounting.expense.update` | IM | Update category. | `nameFa?`, `accountId?`, `active?` | category | `VERSION_CONFLICT` |
| `DELETE /accounting/expense-categories/{id}` | `accounting.expense.delete` | — | Delete an unused category. | — | `204` | `RULE_VIOLATION` (`category_in_use`) |
| `GET /approvals` | `approval.request.read` | C | Approval inbox/outbox (all workflows). | `F:status,requestedBy,workflowCode,entityType,createdAt[gte]` | requests | — |
| `POST /approval-requests` | `approval.request` | IK | Open an approval request for any governed action (journal, refund, adjustment, PO, credential change). | `workflowCode`, `entityType`, `entityId`, `payload?`, `note?` | `201` request | `APPROVAL_PENDING`, `VALIDATION_ERROR` |
| `GET /approval-requests/{id}` | `approval.request.read` | — | Request detail + steps + actions + entity snapshot. | — | request | `NOT_FOUND` |
| `POST /approval-requests/{id}/submit` | `approval.request` | — | Submit to the first approver step. | — | request | `DOCUMENT_STATE_INVALID` |
| `POST /approval-requests/{id}/approve` | `approval.act` | — | Approve current step (SoD: requester ≠ approver enforced by DB). | `stepUpToken?`, `note?` | request | `FORBIDDEN` (self-approval), `DOCUMENT_STATE_INVALID` |
| `POST /approval-requests/{id}/reject` | `approval.act` | — | Reject at current step. | `reason` | request | `DOCUMENT_STATE_INVALID` |
| `POST /approval-requests/{id}/cancel` | `approval.request` | — | Withdraw a pending request. | `reason` | request | `DOCUMENT_STATE_INVALID` |
| `GET /approval-requests/{id}/actions` | `approval.request.read` | C | Decision history per step. | — | actions | `NOT_FOUND` |
| `GET /approval-workflows` | `approval.workflow.read` | O | Workflow definitions (thresholds, steps). | `F:active,entityType` | workflows | — |
| `POST /approval-workflows` | `approval.workflow.manage` | IK | Create a workflow with steps/amount matrix. | `code`, `nameFa`, `entityType`, `steps[{roleId\|permissionKey, minAmount?, maxAmount?}]` | `201` workflow | `CONFLICT` (code) |
| `PATCH /approval-workflows/{id}` | `approval.workflow.manage` | IM | Update workflow steps/thresholds. | `steps`, `active?` | workflow | `VERSION_CONFLICT` |
| `DELETE /approval-workflows/{id}` | `approval.workflow.manage` | — | Delete a workflow with no pending requests. | — | `204` | `RULE_VIOLATION` (`pending_requests`) |
| `GET /accounting/document-links` | `accounting.link.read` | O | Links between business documents and journals (traceability). | `F:entityType,entityId,journalEntryId` | links | — |
| `POST /accounting/document-links` | `accounting.link.create` | IK | Create an explicit link (usually automatic). | `entityType`, `entityId`, `journalEntryId`, `relation` | `201` link | `CONFLICT` |
| `DELETE /accounting/document-links/{id}` | `accounting.link.delete` | — | Remove an erroneous manual link (not auto links). | — | `204` | `RULE_VIOLATION` (`auto_link`) |

### 4.12 Treasury — payments, bank accounts, cash, cheques, reconciliation

Every money movement creates an accounting journal in the same transaction (`ARCHITECTURE.md` §6). Treasury writes require the corresponding permission **and** either a non-closed period or an explicit `PERIOD_CLOSED` failure. Cheques follow the Iranian lifecycle `issued → endorsed → deposited → cleared | bounced | cancelled`.

| Method · Path | Perm | Kind | Purpose | Request (key) | Response | Errors |
|---|---|---|---|---|---|---|
| `GET /treasury/payments` | `payment.read` | C | Payments (in/out) with status. | `F:direction,status,partyType,partyId,bankAccountId,date[gte]`; `S:date,amount` | payments | — |
| `POST /treasury/payments` | `payment.create` | IK | Create a payment draft (supplier/expense/refund/partner). | `direction: "out"\|"in"`, `partyType`, `partyId?`, `amount`, `method: "cash"\|"bank"\|"cheque"\|"gateway"`, `bankAccountId?`, `cashBoxId?`, `date`, `descriptionFa`, `allocations[]?` | `201` payment | `VALIDATION_ERROR`, `APPROVAL_REQUIRED` |
| `GET /treasury/payments/{id}` | `payment.read` | — | Payment detail + allocations + journal. | `include=allocations,journal` | payment | `NOT_FOUND` |
| `PATCH /treasury/payments/{id}` | `payment.update` | IM | Edit a draft payment. | amount/date/method/description | payment | `DOCUMENT_STATE_INVALID` |
| `POST /treasury/payments/{id}/submit` | `payment.submit` | — | Submit for approval. | — | payment | `DOCUMENT_STATE_INVALID` |
| `POST /treasury/payments/{id}/approve` | `payment.approve` | — | Approve (SoD + amount matrix). | `stepUpToken`, `note?` | payment | `FORBIDDEN` (self-approval) |
| `POST /treasury/payments/{id}/execute` | `payment.execute` | — | Execute: cash box/bank movement + journal; cheque payments create a cheque. | `stepUpToken`, `executedAt?`, `reference?` | payment + `journalEntryId`, `chequeId?` | `PERIOD_CLOSED`, `STEP_UP_REQUIRED` |
| `POST /treasury/payments/{id}/void` | `payment.void` | — | Void an unexecuted payment or reverse an executed one. | `reason` | payment | `DOCUMENT_STATE_INVALID` |
| `GET /treasury/payments/{id}/allocations` | `payment.read` | — | Allocation to invoices/bills. | — | allocations | `NOT_FOUND` |
| `POST /treasury/payments/{id}/allocations` | `payment.allocate` | B | Allocate payment to one/more invoices (AR/AP settlement). | `items[{invoiceType: "customer_invoice"\|"supplier_invoice", invoiceId, amount}]` | allocations | `RULE_VIOLATION` (`allocation_exceeds_amount`) |
| `DELETE /treasury/payments/{id}/allocations/{allocationId}` | `payment.allocate` | — | Deallocate. | — | `204` | `DOCUMENT_STATE_INVALID` |
| `GET /treasury/bank-accounts` | `bank.account.read` | O | Bank accounts. | `F:active,bankName` | accounts | — |
| `POST /treasury/bank-accounts` | `bank.account.create` | IK | Create bank account with GL account link. | `nameFa`, `bankName`, `accountNumber`, `iban`, `glAccountId`, `branchId?` | `201` account | `CONFLICT` (iban/accountNumber) |
| `GET /treasury/bank-accounts/{id}` | `bank.account.read` | — | Account detail + current balance. | — | account | `NOT_FOUND` |
| `PATCH /treasury/bank-accounts/{id}` | `bank.account.update` | IM | Update account metadata/GL link. | `nameFa?`, `glAccountId?`, `active?` | account | `VERSION_CONFLICT` |
| `DELETE /treasury/bank-accounts/{id}` | `bank.account.delete` | — | Delete an unused account. | — | `204` | `RULE_VIOLATION` (`account_has_transactions`) |
| `GET /treasury/bank-accounts/{id}/statement-imports` | `bank.statement.read` | C | Imported bank statements. | `F:status,from,to` | imports | — |
| `POST /treasury/bank-accounts/{id}/statement-imports` | `bank.statement.import` | IK/AS/FILE | Import a bank statement (CSV/Excel) via presigned file; parses and stages lines. | `fileId`, `format: "csv"\|"xlsx"`, `from?`, `to?` | `202` job | `IMPORT_VALIDATION_FAILED` |
| `GET /treasury/bank-statements/{id}` | `bank.statement.read` | — | Statement detail + line count + reconciliation state. | — | statement | `NOT_FOUND` |
| `GET /treasury/bank-statements/{id}/lines` | `bank.statement.read` | C | Statement lines (matched/unmatched). | `F:matched,date[gte]` | lines | `NOT_FOUND` |
| `GET /treasury/cash-boxes` | `cash.read` | O | Cash boxes (branches/stations). | `F:active,branchId` | boxes | — |
| `POST /treasury/cash-boxes` | `cash.create` | IK | Create cash box with GL account. | `nameFa`, `branchId`, `glAccountId`, `currency?` | `201` box | `CONFLICT` |
| `PATCH /treasury/cash-boxes/{id}` | `cash.update` | IM | Update cash box. | `nameFa?`, `glAccountId?`, `active?` | box | `VERSION_CONFLICT` |
| `DELETE /treasury/cash-boxes/{id}` | `cash.delete` | — | Delete an unused cash box. | — | `204` | `RULE_VIOLATION` (`cash_box_in_use`) |
| `GET /treasury/cash-sessions` | `cash.session.read` | C | Cash sessions (shift open/close with counted amount). | `F:cashBoxId,status,openedAt[gte]` | sessions | — |
| `POST /treasury/cash-sessions` | `cash.session.open` | IK | Open a cash session with opening float. | `cashBoxId`, `openingBalance` | `201` session | `CONFLICT` (session already open) |
| `GET /treasury/cash-sessions/{id}` | `cash.session.read` | — | Session detail + transactions + expected vs counted. | `include=transactions` | session | `NOT_FOUND` |
| `POST /treasury/cash-sessions/{id}/close` | `cash.session.close` | — | Close session with physical count; variance posts adjustment or requires note. | `countedBalance`, `note?`, `varianceAccountId?` | session | `RULE_VIOLATION` (`variance_requires_note`) |
| `GET /treasury/cash-transactions` | `cash.transaction.read` | C | Cash receipts/payments. | `F:cashBoxId,sessionId,type,date[gte]` | transactions | — |
| `POST /treasury/cash-transactions` | `cash.transaction.create` | IK | Record a cash receipt/payment (with optional invoice allocation). | `cashBoxId`, `sessionId?`, `type: "receipt"\|"payment"`, `amount`, `partyType?`, `partyId?`, `descriptionFa`, `allocations[]?` | `201` transaction | `PERIOD_CLOSED` |
| `GET /treasury/cheques` | `cheque.read` | C | Cheques received/issued. | `F:status,direction,partyId,dueDate[gte],bankAccountId`; `S:dueDate,amount` | cheques | — |
| `POST /treasury/cheques` | `cheque.issue` | IK | Register a cheque (received or issued) with due date/bank. | `direction: "received"\|"issued"`, `partyType`, `partyId`, `amount`, `chequeNumber`, `bankName`, `bankAccountId?`, `dueDate`, `sayadId?`, `attachmentFileIds[]?` | `201` cheque | `CONFLICT` (chequeNumber+bank) |
| `GET /treasury/cheques/{id}` | `cheque.read` | — | Cheque detail + events + journal links. | `include=events,journals` | cheque | `NOT_FOUND` |
| `PATCH /treasury/cheques/{id}` | `cheque.update` | IM | Update metadata before an event (due date, note). | `dueDate?`, `note?`, `attachmentFileIds?` | cheque | `DOCUMENT_STATE_INVALID` |
| `POST /treasury/cheques/{id}/endorse` | `cheque.endorse` | — | Endorse to a third party (creates transfer journal). | `endorsedTo`, `endorsedAt?` | cheque | `DOCUMENT_STATE_INVALID` |
| `POST /treasury/cheques/{id}/deposit` | `cheque.deposit` | — | Deposit to a bank account (in-transit state). | `bankAccountId`, `depositedAt?` | cheque | `DOCUMENT_STATE_INVALID` |
| `POST /treasury/cheques/{id}/clear` | `cheque.clear` | — | Mark cleared (cash realized; posts final journal). | `clearedAt?`, `bankReference?` | cheque | `DOCUMENT_STATE_INVALID`, `PERIOD_CLOSED` |
| `POST /treasury/cheques/{id}/bounce` | `cheque.bounce` | — | Mark bounced (reversal + receivable + alert). | `bouncedAt?`, `reason` | cheque | `DOCUMENT_STATE_INVALID` |
| `POST /treasury/cheques/{id}/cancel` | `cheque.cancel` | — | Cancel a cheque before clearing. | `reason` | cheque | `DOCUMENT_STATE_INVALID` |
| `GET /treasury/cheques/{id}/events` | `cheque.read` | C | Cheque event history. | — | cursor list | `NOT_FOUND` |
| `GET /treasury/reconciliations` | `reconciliation.read` | C | Bank reconciliations. | `F:bankAccountId,status,periodId` | reconciliations | — |
| `POST /treasury/reconciliations` | `reconciliation.create` | IK | Start reconciliation for account + period. | `bankAccountId`, `statementId`, `periodId` | `201` reconciliation | `CONFLICT` |
| `GET /treasury/reconciliations/{id}` | `reconciliation.read` | — | Detail + matches + unmatched diff. | `include=matches` | reconciliation | `NOT_FOUND` |
| `POST /treasury/reconciliations/{id}/match` | `reconciliation.match` | B | Match statement lines to payments/journal lines (manual). | `items[{statementLineId, paymentId?, journalLineId?}]` | matches | `RULE_VIOLATION` (`amount_mismatch`) |
| `POST /treasury/reconciliations/{id}/unmatch` | `reconciliation.match` | — | Undo a match. | `matchId` | `204` | `NOT_FOUND` |
| `POST /treasury/reconciliations/{id}/complete` | `reconciliation.complete` | — | Complete reconciliation when difference is within tolerance/explained. | `note`, `stepUpToken?` | reconciliation | `RULE_VIOLATION` (`unexplained_difference`) |
| `GET /treasury/payment-methods` | `payment_method.read` | O | Payment methods (cash/bank/gateway/cheque). | `F:active` | methods | — |
| `POST /treasury/payment-methods` | `payment_method.create` | IK | Create payment method + GL mapping. | `nameFa`, `code`, `type`, `glAccountId?` | `201` method | `CONFLICT` |
| `PATCH /treasury/payment-methods/{id}` | `payment_method.update` | IM | Update method. | `nameFa?`, `glAccountId?`, `active?` | method | `VERSION_CONFLICT` |
| `DELETE /treasury/payment-methods/{id}` | `payment_method.delete` | — | Delete unused method. | — | `204` | `RULE_VIOLATION` (`method_in_use`) |

### 4.13 Partners — shareholders, partner accounts, profit distribution, channel settlements

| Method · Path | Perm | Kind | Purpose | Request (key) | Response | Errors |
|---|---|---|---|---|---|---|
| `GET /partners` | `partner.read` | O | Partners (profit-share parties). | `F:status,type`; `Q` | partners | — |
| `POST /partners` | `partner.create` | IK | Create partner. | `nameFa`, `type: "shareholder"\|"investor"\|"channel"`, `profitSharePercent?`, `glAccountId?` | `201` partner | `CONFLICT` |
| `GET /partners/{id}` | `partner.read` | — | Partner detail + accounts + statement. | `include=accounts,statement` | partner | `NOT_FOUND` |
| `PATCH /partners/{id}` | `partner.update` | IM | Update partner. | `nameFa?`, `profitSharePercent?`, `status?` | partner | `VERSION_CONFLICT` |
| `DELETE /partners/{id}` | `partner.delete` | — | Delete a partner with no balances. | — | `204` | `RULE_VIOLATION` (`partner_has_balance`) |
| `GET /partners/{id}/accounts` | `partner.read` | O | Partner ledger accounts. | — | accounts | `NOT_FOUND` |
| `POST /partners/{id}/accounts` | `partner.update` | IK | Create a partner account (capital/current/profit). | `type: "capital"\|"current"\|"profit"`, `glAccountId` | `201` account | `CONFLICT` |
| `GET /partner-accounts/{id}` | `partner.read` | — | Account detail + balance. | — | account | `NOT_FOUND` |
| `PATCH /partner-accounts/{id}` | `partner.update` | IM | Update mapping/active. | `glAccountId?`, `active?` | account | `VERSION_CONFLICT` |
| `GET /partner-accounts/{id}/transactions` | `partner.transaction.read` | C | Partner transactions (capital in/out, drawings, profit). | `F:type,date[gte]` | transactions | — |
| `POST /partner-accounts/{id}/transactions` | `partner.transaction.create` | IK | Record a partner transaction (with approval above threshold). | `type: "capital_in"\|"capital_out"\|"drawing"\|"profit"\|"adjustment"`, `amount`, `date`, `descriptionFa`, `paymentId?` | `201` transaction | `APPROVAL_REQUIRED`, `PERIOD_CLOSED` |
| `GET /partners/{id}/statement` | `partner.read` | — | Partner statement for a period (PDF/JSON). | `fiscalYearId`, `periodId?`, `format?` | statement | `NOT_FOUND` |
| `GET /shareholders` | `shareholder.read` | O | Shareholders and share percentages. | `F:active` | shareholders | — |
| `POST /shareholders` | `shareholder.create` | IK | Create shareholder (user/partner link + share %). | `nameFa`, `userId?`, `partnerId?`, `sharePercent`, `nationalId?` | `201` shareholder | `CONFLICT`, `VALIDATION_ERROR` (sum>100) |
| `GET /shareholders/{id}` | `shareholder.read` | — | Shareholder detail + transactions. | `include=transactions` | shareholder | `NOT_FOUND` |
| `PATCH /shareholders/{id}` | `shareholder.update` | IM | Update shareholder. | `nameFa?`, `sharePercent?`, `active?` | shareholder | `VERSION_CONFLICT` |
| `DELETE /shareholders/{id}` | `shareholder.delete` | — | Delete a shareholder with no transactions. | — | `204` | `RULE_VIOLATION` (`shareholder_has_transactions`) |
| `GET /shareholders/{id}/transactions` | `shareholder.transaction.read` | C | Capital/share transactions. | `F:type,date[gte]` | transactions | — |
| `POST /shareholders/{id}/transactions` | `shareholder.transaction.create` | IK | Record a shareholder transaction. | `type: "capital_in"\|"capital_out"\|"dividend"\|"adjustment"`, `amount`, `date`, `descriptionFa` | `201` transaction | `PERIOD_CLOSED` |
| `POST /shareholders/{id}/share-adjustments` | `shareholder.share.adjust` | — | Adjust share percentages (must sum to 100; approval + step-up). | `sharePercent`, `effectiveDate`, `reason`, `stepUpToken` | shareholders | `VALIDATION_ERROR` (share sum), `APPROVAL_REQUIRED` |
| `GET /profit-distributions` | `profit.distribution.read` | C | Profit distribution runs. | `F:fiscalYearId,status` | distributions | — |
| `POST /profit-distributions` | `profit.distribution.run` | IK/AS | Compute profit distribution for a fiscal year/period (based on share % and policy). | `fiscalYearId`, `periodId?`, `policy: "share_percent"\|"custom"`, `customShares?` | `202`/`201` distribution | `PERIOD_CLOSED`, `RULE_VIOLATION` (`profit_not_finalized`) |
| `GET /profit-distributions/{id}` | `profit.distribution.read` | — | Detail + per-partner amounts + journal refs. | `include=lines` | distribution | `NOT_FOUND` |
| `POST /profit-distributions/{id}/approve` | `profit.distribution.approve` | — | Approve distribution (SoD + step-up). | `stepUpToken`, `note?` | distribution | `FORBIDDEN` (self-approval) |
| `POST /profit-distributions/{id}/post` | `profit.distribution.run` | — | Post distribution journals to partner accounts. | — | distribution + `journalEntryId` | `PERIOD_CLOSED`, `JOURNAL_UNBALANCED` |
| `POST /profit-distributions/{id}/reverse` | `profit.distribution.run` | — | Reverse a posted distribution. | `reason`, `stepUpToken` | distribution | `DOCUMENT_STATE_INVALID` |
| `GET /channel-settlements` | `settlement.read` | C | Channel settlements (marketplace payouts). | `F:channelId,accountId,status,periodId,createdAt[gte]` | settlements | — |
| `POST /channel-settlements` | `settlement.create` | IK | Record a settlement statement from a channel (manual or pulled). | `channelId`, `accountId`, `externalStatementId`, `periodFrom`, `periodTo`, `grossAmount`, `fees`, `netAmount`, `lines[]?`, `attachmentFileIds[]?` | `201` settlement | `CONFLICT` (externalStatementId), `VALIDATION_ERROR` |
| `GET /channel-settlements/{id}` | `settlement.read` | — | Detail + line breakdown + journal. | `include=lines,journal` | settlement | `NOT_FOUND` |
| `POST /channel-settlements/{id}/confirm` | `settlement.confirm` | — | Confirm settlement against orders/fees (reconciliation); discrepancies flagged. | `tolerance?` | settlement | `RULE_VIOLATION` (`settlement_mismatch`) |
| `POST /channel-settlements/{id}/post` | `settlement.confirm` | — | Post settlement journals (channel receivable/fee/commission). | `stepUpToken?` | settlement + `journalEntryId` | `PERIOD_CLOSED` |
| `GET /channel-settlements/{id}/lines` | `settlement.read` | C | Settlement lines (order/fee/tax). | — | lines | `NOT_FOUND` |

### 4.14 Reporting — report definitions, runs, exports, dashboards, saved filters

Reports are code-defined SQL/read-model definitions seeded as rows; the API exposes a registry plus run/download. Heavy reports go through `reporting` read models and **never** run inside a write transaction (`ARCHITECTURE.md` §6). Financial report permissions additionally require the corresponding accounting read key (noted per family). Report ranges accept Gregorian `from`/`to` or Jalali with `calendar=jalali` (`ADR-0014`).

| Method · Path | Perm | Kind | Purpose | Request (key) | Response | Errors |
|---|---|---|---|---|---|---|
| `GET /reports` | `report.read` | O | Report catalog (code, titleFa, required permission, params schema). | `F:category` | definitions | — |
| `POST /reports` | `report.create` | IK | Create a custom report definition (SQL whitelist template — no arbitrary user SQL). | `code`, `titleFa`, `category`, `queryTemplateId`, `paramsSchema` | `201` definition | `CONFLICT` (code), `VALIDATION_ERROR` |
| `GET /reports/{code}` | `report.read` | — | Definition + params + last run. | — | definition | `NOT_FOUND` |
| `PATCH /reports/{code}` | `report.update` | IM | Update custom definition. | `titleFa?`, `paramsSchema?`, `active?` | definition | `RULE_VIOLATION` (`system_report`) |
| `DELETE /reports/{code}` | `report.delete` | — | Delete a custom definition. | — | `204` | `RULE_VIOLATION` (`system_report`) |
| `POST /reports/{code}/run` | `report.run` | IK/AS | Run a report (sync ≤ 5 s/small result; async otherwise). | `params{from,to,calendar?,filters...}`, `async?`, `format?` | `200 { rows, meta }` or `202` job | `VALIDATION_ERROR` |
| `GET /reports/runs` | `report.run` | C | Report run history. | `F:reportCode,status,createdAt[gte]` | runs | — |
| `GET /reports/runs/{id}` | `report.run` | — | Run status/metrics/row count. | — | run | `NOT_FOUND` |
| `GET /reports/runs/{id}/rows` | `report.run` | C | Paginated result rows (JSON). | `limit`, `cursor` | rows | `NOT_FOUND` |
| `POST /reports/runs/{id}/cancel` | `report.run` | — | Cancel a running report. | — | run | `DOCUMENT_STATE_INVALID` |
| `GET /reports/runs/{id}/download` | `report.run` | FILE | Download result (csv/xlsx/pdf). | `format` | `{ fileId, downloadUrl }` | `NOT_FOUND` |
| `POST /exports` | `export.create` | IK/AS | Create a generic async export (products, inventory, orders, journal, audit). | `entity`, `format: "csv"\|"xlsx"`, `filters`, `columns?` | `202` job | `VALIDATION_ERROR` |
| `GET /exports` | `export.read` | C | Export history. | `F:entity,status,createdAt[gte]` | exports | — |
| `GET /exports/{id}` | `export.read` | — | Export detail + progress. | — | export | `NOT_FOUND` |
| `GET /exports/{id}/download` | `export.read` | FILE | Presigned download (expires 15 min; export retained 7 days). | — | `{ fileId, downloadUrl, expiresIn }` | `NOT_FOUND`, `RULE_VIOLATION` (`export_expired`) |
| `DELETE /exports/{id}` | `export.delete` | — | Delete export artifact. | — | `204` | `NOT_FOUND` |
| `GET /dashboards` | `dashboard.read` | O | Dashboard definitions. | `F:role` | dashboards | — |
| `POST /dashboards` | `dashboard.create` | IK | Create a custom dashboard. | `code`, `titleFa`, `widgets[{type, queryCode, params, layout}]` | `201` dashboard | `CONFLICT` |
| `GET /dashboards/{code}` | `dashboard.read` | — | Dashboard + widgets resolved values. | `params?` | dashboard + widget data | `NOT_FOUND` |
| `PATCH /dashboards/{code}` | `dashboard.update` | IM | Update widgets/layout. | `titleFa?`, `widgets?` | dashboard | `VERSION_CONFLICT` |
| `DELETE /dashboards/{code}` | `dashboard.delete` | — | Delete a custom dashboard. | — | `204` | `RULE_VIOLATION` (`system_dashboard`) |
| `GET /dashboard/summary` | `dashboard.read` | — | Home KPI summary (sales today, profit, open orders, low stock, cash, AR/AP). | `date?`, `branchId?` | KPI object | — |
| `GET /saved-filters` | `saved_filter.read` | O | User/role saved filter sets per screen. | `F:screen` | filters | — |
| `POST /saved-filters` | `saved_filter.create` | IK | Save a filter set. | `screen`, `name`, `query` (whitelisted params JSON), `shared?` | `201` filter | `CONFLICT` (screen+name) |
| `PATCH /saved-filters/{id}` | `saved_filter.update` | IM | Update saved filter. | `name?`, `query?`, `shared?` | filter | `VERSION_CONFLICT` |
| `DELETE /saved-filters/{id}` | `saved_filter.delete` | — | Delete saved filter. | — | `204` | `FORBIDDEN` (not owner) |

**Seeded report codes (v1):** operational — `sales-by-channel`, `sales-by-product`, `sales-by-category`, `sales-by-customer`, `inventory-aging`, `dead-stock`, `fast-moving`, `stock-turnover`, `stock-movement`, `stock-discrepancy`, `supplier-performance`, `procurement-recommendations`, `channel-profit`; financial (also require `accounting.balance.read` or `accounting.ledger.read`) — `trial-balance`, `general-ledger`, `sub-ledger`, `journal-book`, `balance-sheet`, `income-statement`, `cash-flow`, `receivables-aging`, `payables-aging`, `tax-summary`, `partner-profit`, `settlement-summary`, `audit-summary`.

### 4.15 Notifications & SMS — in-app inbox, templates, Limo messages

| Method · Path | Perm | Kind | Purpose | Request (key) | Response | Errors |
|---|---|---|---|---|---|---|
| `GET /notifications` | self | C | In-app inbox for the caller. | `F:read,type,severity,createdAt[gte]` | notifications | — |
| `GET /notifications/{id}` | self | — | Notification detail + link target. | — | notification | `NOT_FOUND` |
| `POST /notifications/{id}/read` | self | — | Mark one as read. | — | `204` | `NOT_FOUND` |
| `POST /notifications/read-all` | self | — | Mark all as read. | `before?` | `204 { count }` | — |
| `DELETE /notifications/{id}` | self | — | Dismiss a notification. | — | `204` | `NOT_FOUND` |
| `GET /notification-preferences` | self | — | Per-channel preferences (SMS/email/in-app/webhook). | — | preferences | — |
| `PATCH /notification-preferences` | self | — | Update preferences. | `channels[{type,event,enabled}]`, `quietHours?` | preferences | `VALIDATION_ERROR` |
| `GET /notification-templates` | `notification.template.read` | O | Notification templates (event → channels). | `F:eventType,channel,active` | templates | — |
| `POST /notification-templates` | `notification.template.manage` | IK | Create a template (Persian body with variables). | `eventType`, `channel`, `subjectFa?`, `bodyFa`, `variables[]`, `active?` | `201` template | `CONFLICT` |
| `PATCH /notification-templates/{id}` | `notification.template.manage` | IM | Update template. | `bodyFa?`, `active?` | template | `VERSION_CONFLICT` |
| `DELETE /notification-templates/{id}` | `notification.template.manage` | — | Delete unused template. | — | `204` | `RULE_VIOLATION` (`template_in_use`) |
| `POST /notification-templates/{id}/test` | `notification.template.manage` | — | Send a test to the caller (SMS mock/real per `SMS_MODE`). | `variables?` | `{ delivered, smsMessageId? }` | `UPSTREAM_UNAVAILABLE` |
| `GET /sms-messages` | `sms.read` | C | Outbound SMS log (OTP/pattern/bulk) with status. | `F:type,status,mobile,createdAt[gte]` | messages | — |
| `GET /sms-messages/{id}` | `sms.read` | — | Message detail + provider MessageId + delivery status. | — | message | `NOT_FOUND` |
| `POST /sms/send` | `sms.send` | IK | Send an ad-hoc SMS/pattern message (not for OTP flows — those are internal). | `mobile`, `templateId?` **or** `message`, `replaceTokens?`, `senderNumber?`, `scheduledAt?` | `202 { smsMessageId }` | `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `NOT_IMPLEMENTED` (`SMS_MODE=mock`) |
| `POST /sms/otp/voice` | `sms.send` | — | Send a voice OTP via Limo `SendOTPVoice` (support/testing; login flows use `/auth/otp/voice`). | `mobile`, `code?` | `202 { smsMessageId }` | `NOT_IMPLEMENTED` (`SMS_MODE=mock`) |
| `GET /sms-templates` | `sms.read` | O | Limo pattern templates (OtpId + body + tokens). | `F:active` | templates | — |
| `POST /sms-templates` | `sms.template.manage` | IK | Register a Limo pattern (OtpId) and its replace tokens. | `providerPatternId` (OtpId), `nameFa`, `bodyFa`, `variables[]`, `senderNumber?` | `201` template | `CONFLICT` (pattern id) |
| `PATCH /sms-templates/{id}` | `sms.template.manage` | IM | Update local metadata/active. | `nameFa?`, `variables?`, `active?` | template | `VERSION_CONFLICT` |
| `DELETE /sms-templates/{id}` | `sms.template.manage` | — | Deactivate/delete local template. | — | `204` | `RULE_VIOLATION` (`template_in_use`) |
| `POST /sms-templates/{id}/test` | `sms.template.manage` | — | Send a test pattern message with sample tokens. | `mobile`, `replaceTokens?` | `{ delivered, smsMessageId }` | `UPSTREAM_UNAVAILABLE`, `NOT_IMPLEMENTED` |

### 4.16 Files — presigned upload, download, links

Two-step upload (default): request presigned `PUT` → upload raw bytes directly to S3/MinIO → complete. Direct multipart is allowed only for images ≤ 10 MiB on trusted origins. Full rules in §7.

| Method · Path | Perm | Kind | Purpose | Request (key) | Response | Errors |
|---|---|---|---|---|---|---|
| `POST /files/uploads` | `file.create` | IK | Request a presigned upload URL. | `fileName`, `contentType`, `sizeBytes`, `sha256?`, `purpose: "product_media"\|"invoice"\|"attachment"\|"avatar"\|"import"\|"cheque_image"` | `201 { fileId, uploadUrl, method: "PUT", headers, expiresIn }` | `PAYLOAD_TOO_LARGE`, `UPLOAD_UNSUPPORTED_TYPE` |
| `POST /files/uploads/{fileId}/complete` | `file.create` | IK | Complete upload: server verifies size/magic bytes/hash, marks file `ready`, triggers scan hook. | `sha256`, `sizeBytes` | file metadata | `UPLOAD_CHECKSUM_MISMATCH`, `UPLOAD_UNSUPPORTED_TYPE`, `NOT_FOUND` |
| `POST /files` | `file.create` | FILE | Direct multipart upload for small images (≤10 MiB). | `multipart: file`, `purpose` | `201` file metadata | `PAYLOAD_TOO_LARGE`, `UPLOAD_UNSUPPORTED_TYPE` |
| `GET /files` | `file.read` | O | Files by owner/purpose. | `F:ownerType,ownerId,purpose,createdAt[gte]` | files | — |
| `GET /files/{id}` | `file.read` | — | File metadata + virus-scan status. | — | file | `NOT_FOUND` |
| `GET /files/{id}/download-url` | `file.read` | — | Presigned download URL (15 min, `Content-Disposition` attachment, access audited). | `disposition?` | `{ downloadUrl, expiresIn, fileName, contentType, sizeBytes }` | `NOT_FOUND`, `RULE_VIOLATION` (`file_not_ready`, `file_quarantined`) |
| `DELETE /files/{id}` | `file.delete` | — | Soft-delete file (blob removed by GC; blocked if linked to posted documents). | — | `204` | `RULE_VIOLATION` (`file_in_use`) |
| `POST /files/{id}/links` | `file.link.create` | — | Link a file to a business entity (invoice, expense, cheque, product). | `ownerType`, `ownerId`, `role?` | `201` link | `CONFLICT` |
| `DELETE /files/{id}/links/{linkId}` | `file.link.create` | — | Remove a link. | — | `204` | `RULE_VIOLATION` (`link_in_posted_document`) |

### 4.17 Settings, feature flags, numbering, system, API clients

| Method · Path | Perm | Kind | Purpose | Request (key) | Response | Errors |
|---|---|---|---|---|---|---|
| `GET /settings` | `setting.read` | — | All settings groups (secrets never included; use credential endpoints). | — | settings object | — |
| `GET /settings/{group}` | `setting.read` | — | One group (`general`, `inventory`, `accounting`, `sales`, `channels`, `notifications`, `security`, `files`). | — | group | `NOT_FOUND` |
| `PUT /settings/{group}` | `setting.update` | IM | Replace a group (Zod-validated; security group needs step-up). | group fields | group | `VALIDATION_ERROR`, `STEP_UP_REQUIRED`, `VERSION_CONFLICT` |
| `GET /feature-flags` | `setting.read` | — | Feature flags and current state. | `F:enabled` | flags | — |
| `PATCH /feature-flags/{key}` | `setting.update` | IM | Toggle a non-locked flag (production guardrails apply). | `enabled` | flag | `RULE_VIOLATION` (`flag_locked`) |
| `GET /numbering-sequences` | `setting.read` | — | Document numbering sequences and last values. | `F:fiscalYearId,documentType` | sequences | — |
| `PUT /numbering-sequences/{documentType}` | `setting.update` | IM | Set prefix/next value (never below issued max; gap-free enforced). | `prefix?`, `nextValue?`, `fiscalYearId` | sequence | `RULE_VIOLATION` (`number_rewind`) |
| `GET /system/info` | `system.read` | — | Build/version/DB schema version/uptime/env mode (no secrets). | — | info | — |
| `GET /system/maintenance` | `system.maintenance.read` | — | Partition status, retention jobs, consistency checks. | — | maintenance status | — |
| `POST /system/maintenance/partitions` | `system.maintenance.run` | — | Create next partitions / run retention (idempotent). | `monthsAhead?`, `dryRun?` | `{ created[], dropped[] }` | `UPSTREAM_UNAVAILABLE` (DB) |
| `GET /system/backups` | `system.backup.read` | — | Backup status (last dump, WAL/PITR, manifest hash). | — | backup status | — |
| `POST /system/backups` | `system.backup.run` | — | Trigger an on-demand backup (rate-limited). | `type: "full"\|"manifest_verify"` | `202` job | `RATE_LIMITED` |
| `GET /api-clients` | `api_client.read` | O | Machine clients (server-to-server integrations). | `F:active` | clients | — |
| `POST /api-clients` | `api_client.create` | IK | Create an API client; secret returned once. | `nameFa`, `scopes[]`, `ipAllowlist[]?`, `expiresAt?` | `201 client + secret` | `VALIDATION_ERROR` |
| `PATCH /api-clients/{id}` | `api_client.update` | IM | Update scopes/IPs/active. | `nameFa?`, `scopes?`, `ipAllowlist?`, `active?` | client | `VERSION_CONFLICT` |
| `POST /api-clients/{id}/rotate-secret` | `api_client.rotate` | — | Rotate client secret (old valid 24 h overlap). | — | `{ secret, rotatedAt }` | `NOT_FOUND` |
| `DELETE /api-clients/{id}` | `api_client.delete` | — | Revoke a client. | — | `204` | `NOT_FOUND` |
| `GET /data-versions` | `data.version.read` | — | Cache-busting version keys (permissions, settings, categories, mappings). | — | versions | — |

### 4.18 Audit, request logs, automation, jobs/imports/printers (platform)

| Method · Path | Perm | Kind | Purpose | Request (key) | Response | Errors |
|---|---|---|---|---|---|---|
| `GET /audit-logs` | `audit.read` | C | Audit trail (who changed what, before/after diff, requestId). | `F:actorId,action,entityType,entityId,createdAt[gte,lt],severity`; `S:createdAt` | audit entries | — |
| `GET /audit-logs/{id}` | `audit.read` | — | One audit entry with diff (PII-redacted per security policy). | — | audit entry | `NOT_FOUND` |
| `GET /audit-logs/export` | `audit.export` | AS/FILE | Export audit range to S3 (signed manifest). | `from`, `to`, `format: "csv"\|"jsonl"` | `202` job | `VALIDATION_ERROR` |
| `GET /api-request-logs` | `api_request_log.read` | C | HTTP access log (90-day retention, partitioned). | `F:route,status,userId,createdAt[gte,lt]` | request logs | — |
| `GET /api-request-logs/{id}` | `api_request_log.read` | — | One request log line (no bodies/PII). | — | log line | `NOT_FOUND` |
| `GET /automation/rules` | `automation.rule.read` | O | Business rules (`trigger → condition → action`). | `F:triggerType,active` | rules | — |
| `POST /automation/rules` | `automation.rule.create` | IK | Create a rule (e.g. `stock < reorder_point → create purchase recommendation`). | `nameFa`, `triggerType`, `conditions[]`, `actions[]`, `active?` | `201` rule | `VALIDATION_ERROR` |
| `GET /automation/rules/{id}` | `automation.rule.read` | — | Rule detail + recent executions. | `include=executions` | rule | `NOT_FOUND` |
| `PATCH /automation/rules/{id}` | `automation.rule.update` | IM | Update rule. | conditions/actions/active | rule | `VERSION_CONFLICT` |
| `DELETE /automation/rules/{id}` | `automation.rule.delete` | — | Delete rule. | — | `204` | `NOT_FOUND` |
| `POST /automation/rules/{id}/test` | `automation.rule.test` | — | Dry-run a rule against sample/near-real data. | `sample?` | `{ matched, actions[] }` | `VALIDATION_ERROR` |
| `POST /automation/rules/{id}/enable` | `automation.rule.update` | — | Enable rule. | — | rule | `DOCUMENT_STATE_INVALID` |
| `POST /automation/rules/{id}/disable` | `automation.rule.update` | — | Disable rule. | `reason?` | rule | `DOCUMENT_STATE_INVALID` |
| `GET /automation/alert-rules` | `automation.alert.read` | O | Alert rules (stock low, margin low, API failures, accounting imbalance). | `F:severity,active` | alert rules | — |
| `POST /automation/alert-rules` | `automation.alert.manage` | IK | Create an alert rule. | `code`, `nameFa`, `condition`, `severity: "info"\|"warning"\|"critical"`, `recipients[]?` | `201` alert rule | `CONFLICT` |
| `PATCH /automation/alert-rules/{id}` | `automation.alert.manage` | IM | Update alert rule. | condition/severity/active | alert rule | `VERSION_CONFLICT` |
| `DELETE /automation/alert-rules/{id}` | `automation.alert.manage` | — | Delete alert rule. | — | `204` | `NOT_FOUND` |
| `GET /alerts` | `automation.alert.read` | C | Fired alerts (ops inbox). | `F:severity,status,ruleId,createdAt[gte]` | alerts | — |
| `GET /alerts/{id}` | `automation.alert.read` | — | Alert detail + related entity links. | — | alert | `NOT_FOUND` |
| `POST /alerts/{id}/acknowledge` | `automation.alert.ack` | — | Acknowledge an alert. | `note?`, `assigneeUserId?` | alert | `NOT_FOUND` |
| `GET /alerts/{id}/events` | `automation.alert.read` | C | Alert lifecycle events. | — | events | `NOT_FOUND` |
| `GET /automation/fraud-flags` | `automation.fraud.read` | C | Fraud/risk flags (velocity, duplicate address, refund abuse). | `F:status,severity,entityType,createdAt[gte]` | flags | — |
| `GET /automation/fraud-flags/{id}` | `automation.fraud.read` | — | Flag detail + evidence. | — | flag | `NOT_FOUND` |
| `POST /automation/fraud-flags/{id}/resolve` | `automation.fraud.resolve` | — | Resolve a flag (confirmed fraud / false positive). | `resolution: "confirmed"\|"false_positive"`, `note`, `stepUpToken?` | flag | `DOCUMENT_STATE_INVALID` |
| `GET /jobs` | `job.read` | C | All background jobs (imports, exports, sync, reports, maintenance). | `F:type,status,queue,createdAt[gte]` | jobs | — |
| `GET /jobs/{id}` | `job.read` | — | Job status/progress/result refs. | — | job | `NOT_FOUND` |
| `GET /jobs/{id}/errors` | `job.read` | C | Per-item job errors. | — | errors | `NOT_FOUND` |
| `POST /jobs/{id}/retry` | `job.run` | — | Retry a failed job (idempotent handlers). | — | `202` job | `DOCUMENT_STATE_INVALID` |
| `POST /jobs/{id}/cancel` | `job.run` | — | Cooperative cancel. | — | job | `DOCUMENT_STATE_INVALID` |
| `GET /outbox-events` | `outbox.read` | C | Outbox events and dispatch state (debug/ops). | `F:eventType,status,aggregateType,createdAt[gte]` | events | — |
| `GET /outbox-events/{id}` | `outbox.read` | — | Event payload + attempts + handler result. | — | event | `NOT_FOUND` |
| `POST /outbox-events/{id}/retry` | `outbox.retry` | — | Re-dispatch a stuck event (safe; handlers idempotent). | — | `202` | `NOT_FOUND` |
| `GET /imports` | `import.read` | C | Import jobs (products, inventory, prices, customers, CoA). | `F:entity,status,createdAt[gte]` | imports | — |
| `POST /imports` | `import.create` | IK/AS/FILE | Create an import from an uploaded file (≤ 100k rows); stages and validates. | `entity`, `fileId`, `mode: "insert"\|"upsert"`, `mapping?` | `202` job | `IMPORT_VALIDATION_FAILED`, `PAYLOAD_TOO_LARGE` |
| `GET /imports/{id}` | `import.read` | — | Import progress/validation summary. | — | import | `NOT_FOUND` |
| `POST /imports/{id}/validate` | `import.validate` | — | (Re)validate staged rows. | — | validation summary | `DOCUMENT_STATE_INVALID` |
| `POST /imports/{id}/commit` | `import.commit` | — | Commit valid rows in chunks; idempotent per row key. | `skipInvalid?` | import | `IMPORT_VALIDATION_FAILED` |
| `POST /imports/{id}/rollback` | `import.rollback` | — | Compensate a committed import (creates reversal/void, never hard-deletes posted docs). | `reason` | import | `DOCUMENT_STATE_INVALID` |
| `GET /imports/{id}/errors` | `import.read` | C | Row-level errors with line numbers. | `F:errorCode` | errors | `NOT_FOUND` |
| `GET /printers` | `printer.device.read` | O | Printer registry (thermal/A4/A5/postal/label/barcode). | `F:warehouseId,type,active` | printers | — |
| `POST /printers` | `printer.device.manage` | IK | Register a printer/local print agent. | `nameFa`, `type`, `paperSize`, `labelSize?`, `warehouseId?`, `agentId?`, `ip?` | `201` printer | `CONFLICT` (name) |
| `PATCH /printers/{id}` | `printer.device.manage` | IM | Update printer config. | `paperSize?`, `labelSize?`, `active?`, `agentId?` | printer | `VERSION_CONFLICT` |
| `DELETE /printers/{id}` | `printer.device.manage` | — | Remove printer. | — | `204` | `NOT_FOUND` |
| `POST /printers/{id}/test` | `printer.device.manage` | — | Send a test label/page to the printer agent. | — | `202` print job | `UPSTREAM_UNAVAILABLE` (agent offline) |
| `POST /printers/print-jobs` | `printer.job.create` | IK | Create a print job (label, invoice, picking list, barcode sheet). | `printerId`, `documentType`, `documentId`, `copies?`, `payload?` | `201` print job | `NOT_FOUND`, `UPSTREAM_UNAVAILABLE` |
| `GET /printers/print-jobs` | `printer.job.read` | C | Print job queue/status (`pending\|printed\|failed`). | `F:printerId,status,createdAt[gte]` | print jobs | — |
| `GET /printers/print-jobs/{id}` | `printer.job.read` | — | Print job detail + retry count. | — | print job | `NOT_FOUND` |
| `POST /print-jobs/{id}/retry` | `printer.job.retry` | — | Retry a failed print job. | — | `202` print job | `DOCUMENT_STATE_INVALID` |
| `POST /print-jobs/{id}/cancel` | `printer.job.cancel` | — | Cancel a pending job. | — | print job | `DOCUMENT_STATE_INVALID` |

### 4.19 Health, metrics, inbound webhooks, outbound webhooks

| Method · Path | Auth | Perm | Kind | Purpose | Request (key) | Response | Errors |
|---|---|---|---|---|---|---|---|
| `GET /health/live` | public | — | — | Process liveness (no dependency checks). | — | `{ status: "ok", uptime }` | — |
| `GET /health/ready` | public | — | — | Readiness: DB + Redis + S3 checks; used by LB/compose. | — | `{ status, checks{db,redis,s3} }` or `503` | `SERVICE_DEGRADED` |
| `GET /health/version` | public | — | — | Build version, schema version, `APP_ENV`. | — | `{ version, schemaVersion, env, commit }` | — |
| `GET /metrics` | scrape | — | — | Prometheus exposition (HTTP histogram, pool, queue depth, outbox lag, channel failures). | (bearer `METRICS_TOKEN` or loopback allowlist) | `text/plain; version=0.0.4` | `UNAUTHENTICATED` (if token wrong) |
| `GET /system/metrics` | perm | `system.metrics.read` | — | JSON metrics snapshot for the admin ops screen. | — | metrics object | — |
| `POST /webhooks/channels/{channelCode}` | hmac | — | — | Generic inbound channel webhook receiver (Digikala; Carexy `TBD-CAREXY`). Raw body verified per §6. | raw body + signature headers | `200 { received: true }` (always fast; processing async) | `UNAUTHENTICATED` (bad signature), `PAYLOAD_TOO_LARGE`, `RATE_LIMITED` |
| `POST /webhooks/channels/{channelCode}/{accountId}` | hmac | — | — | Multi-account variant of the receiver; `accountId` is the account public UUID in the URL configured at the partner. | raw body + signature headers | same as above | same as above |
| `POST /webhooks/limo/delivery` | hmac | — | — | SMS delivery-status callback (**reserved**: not documented by Limo; disabled unless `LIMO_WEBHOOK_SECRET` is set). | raw body + signature | `200` | `NOT_IMPLEMENTED`, `UNAUTHENTICATED` |
| `GET /webhooks/health` | public | — | — | Receiver health (secret configured per channel, last event age). | — | `{ channels: [{ code, secretConfigured, lastEventAt }] }` | — |
| `GET /webhooks/outbound/subscriptions` | perm | `webhook.outbound.read` | O | Outbound webhook subscriptions to Carexy (`https://carexy.shop/...`) and other consumers. | `F:active,eventType` | subscriptions | — |
| `POST /webhooks/outbound/subscriptions` | perm | `webhook.outbound.manage` | IK | Register an outbound subscription (ERP → Carexy) with HMAC secret. | `url`, `eventTypes[]`, `secret?`, `active?` | `201` subscription + secret (once) | `CONFLICT` (url+events) |
| `PATCH /webhooks/outbound/subscriptions/{id}` | perm | `webhook.outbound.manage` | IM | Update URL/events/active. | `url?`, `eventTypes?`, `active?` | subscription | `VERSION_CONFLICT` |
| `DELETE /webhooks/outbound/subscriptions/{id}` | perm | `webhook.outbound.manage` | — | Delete subscription. | — | `204` | `NOT_FOUND` |
| `GET /webhooks/outbound/deliveries` | perm | `webhook.outbound.read` | C | Delivery attempts with response status/latency (bodies redacted). | `F:subscriptionId,status,eventType,createdAt[gte]` | deliveries | — |
| `POST /webhooks/outbound/deliveries/{id}/retry` | perm | `webhook.outbound.manage` | — | Retry a delivery. | — | `202` | `NOT_FOUND` |

---

## 5. Permission-key registry (source of truth for the seed)

### 5.1 Key grammar and granularity

- A key is **`<resource>.<action>`**: the **last dot segment is the action**, everything before it is the resource. The resource may itself contain dots (`accounting.journal`), so `accounting.journal.post` = resource `accounting.journal`, action `post`.
- Keys are **opaque, global, unique strings**; a role grant references an exact key (no wildcards in the database; wildcards appear only in seed source files). `permissions` seed row: `key`, `resource`, `action`, `description_fa`, `is_system`, `module`.
- Granularity rule:
  - **Master-data resources** use CRUD actions: `read`, `create`, `update`, `delete`.
  - **Workflow/capability resources** use domain actions (`approve`, `post`, `reverse`, `execute`, `confirm`, `issue`, `import`, `run`, `manage`, `trigger`, `retry`, `replay`, `allocate`, `seal`, `clear`, …). A bare capability key such as `inventory.adjust` gates "create/edit/submit an adjustment"; the stricter `inventory.adjust.approve` and `inventory.adjust.post` are separate keys because they are separation-of-duties gates.
  - Reads of sensitive projections have explicit `*.read` keys (`product.cost.read`, `accounting.balance.read`, `security_event.read`), never implicit.
- **Default-deny**: a route with no key fails CI (`ADR-0008`). Keys below are exactly the set referenced by §4 — the registry was generated from the catalog and any drift fails the `permission-registry` test.
- Every key seeded is immutable when `is_system=true`; adding keys is additive, removing/renaming is a breaking API change requiring a major version.
- Data-model seed plan (`docs/02-data-model/DATA-MODEL.md`) MUST seed this registry exactly. Naming is `resource.action` as agreed with the data-model owner; the physical table mapping is: `cheques → cheque.*`, `channel_settlements → settlement.*`, partner profit tables → `profit.distribution.*`, `approval_* → approval.*`, `printer_jobs → printer.*`, `outbox_events → outbox.*`, `integration_dead_letters → integration.dead_letter.*`, `report_* → report.*`, `dashboard_widgets → dashboard.*`.

### 5.2 Registry (authoritative; full key = resource + "." + action)

```text
accounting.balance: read
accounting.budget: activate, approve, create, delete, read, update
accounting.coa: create, delete, import, read, update
accounting.dimension: create, delete, read, update
accounting.document: create, export, issue, read, void
accounting.expense: approve, create, delete, pay, read, update
accounting.fiscal_year: close, create, read, reopen, update
accounting.journal: approve, create, delete, post, read, reverse, update
accounting.ledger: read
accounting.link: create, delete, read
accounting.period: close, read, reopen
accounting.posting_rule: manage, read
accounting.tax: create, delete, read, update
accounting.valuation: post, read, run
api_client: create, delete, read, rotate, update
api_request_log: read
approval: act, request
approval.request: read
approval.workflow: manage, read
attribute: create, delete, read, update
audit: export, read
automation.alert: ack, manage, read
automation.fraud: read, resolve
automation.rule: create, delete, read, test, update
bank.account: create, delete, read, update
bank.statement: import, read
barcode: create, delete, read
branch: create, delete, read, update
brand: create, delete, read, update
carrier: create, delete, read, update
cash: create, delete, read, update
cash.session: close, open, read
cash.transaction: create, read
category: create, delete, read, update
channel: create, read, update
channel.account: create, delete, read, test, update
channel.api_call: read
channel.credential: delete, rotate, write
channel.mapping: auto, create, delete, read, update
channel.sync: cancel, read, retry, trigger
channel.webhook: manage, read, replay
cheque: bounce, cancel, clear, deposit, endorse, issue, read, update
currency: create, delete, read, update
customer: create, delete, read, update
customer.credit: read, update
customer.invoice: create, issue, read, void
dashboard: create, delete, read, update
data.version: read
department: create, delete, read, update
device: read, revoke
export: create, delete, read
file: create, delete, read
file.link: create
fulfillment: allocate
goods.receipt: create, execute, read, update
holiday: create, delete, read, update
identity.break_glass: use
import: commit, create, read, rollback, validate
integration.dead_letter: delete, read, retry
inventory: adjust, count, reserve, transfer
inventory.adjust: approve, post, read
inventory.balance: read
inventory.count: approve, post, read
inventory.ledger: read
inventory.lot: create, delete, read, update
inventory.reserve: read
inventory.serial: create, read
inventory.transfer: approve, read
inventory.unit: create, read, update
inventory.valuation: read
job: read, run
label: create, delete, read, reprint
marketplace.fee: create, delete, read, update
media: create, delete, read, update
notification.template: manage, read
organization: read, update
outbox: read, retry
package: create, delete, read, seal, update
partner: create, delete, read, update
partner.transaction: create, read
payment: allocate, approve, create, execute, read, submit, update, void
payment_method: create, delete, read, update
permission: read
price.list: activate, create, delete, read, update
price.snapshot: read
pricing: calculate, run
pricing.rule: activate, create, delete, read, update
pricing.run: read
printer.device: manage, read
printer.job: cancel, create, read, retry
product: create, delete, read, update
product.cost: read
profit.distribution: approve, read, run
purchase.order: approve, create, delete, read, update
reconciliation: complete, create, match, read
reorder.rule: create, delete, read, update
report: create, delete, read, run, update
role: assign, create, delete, read, update
sales.order: create, delete, read, update
sales.refund: approve, create, pay, read, void
sales.return: approve, create, read, update
saved_filter: create, delete, read, update
security_event: read
session: read, revoke
setting: read, update
settlement: confirm, create, read
shareholder: create, delete, read, update
shareholder.share: adjust
shareholder.transaction: create, read
shipment: cancel, create, dispatch, read, update
shipping.rate: create, delete, read, update
sms: read, send
sms.template: manage
supplier: create, delete, read, update
supplier.invoice: approve, create, match, post, read, update
system: read
system.backup: read, run
system.maintenance: read, run
system.metrics: read
unit: create, delete, read, update
user: create, delete, read, update
user.scope: assign
variant: create, delete, read, update
warehouse: create, delete, device, pack, pick, putaway, read, update, wave
warehouse.device: read, register
warehouse.location: create, delete, read, update
warehouse.pack: read
warehouse.pick: read
warehouse.putaway: read
warehouse.wave: read
webhook.outbound: manage, read
```

> Note: `warehouse.pick` appears both as an action of `warehouse` (execute picking) and, with `.read`, as its own family (`warehouse.pick.read` = read pick tasks). Same pattern for `wave`, `pack`, `putaway`. This is intentional: capability gates execution, `.read` gates visibility.

### 5.3 Keys added beyond the data-model seed draft (backend must seed these too)

The data-model owner's list is expressed at *resource* level. The catalog above expands it into the exact action set. The following families/actions were **added by the API contract** and must be present in `permissions` seed (all are additive, all `is_system=true`):

| Family | Added keys (reason) |
|---|---|
| identity | `identity.break_glass.use` (ADR: break-glass), `security_event.read` (security screen), `user.scope.assign` (scope is authz-sensitive, separate from profile edit), `role.assign` (role↔permission and user↔role assignment is SoD-sensitive) |
| inventory | `inventory.adjust.read/.approve/.post`, `inventory.count.read/.approve/.post`, `inventory.transfer.read/.approve`, `inventory.reserve.read`, `inventory.valuation.read` (read/approve/post split for SoD; draft capability `inventory.adjust`/`inventory.count`/`inventory.transfer`/`inventory.reserve` covers create/edit/submit) |
| warehouse | `warehouse.location.{read,create,update,delete}`, `warehouse.device.{read,register}`, `warehouse.{putaway,wave,pick,pack}.read`, `warehouse.device`, `warehouse.wave/pick/pack/putaway` (capability keys) |
| procurement | `goods.receipt.execute`, `supplier.invoice.match/.post` (three-way match + posting are distinct gates) |
| sales | `customer.credit.read/.update`, `customer.invoice.{create,issue,void,read}`, `sales.return.approve`, `sales.refund.{create,pay,void}` |
| fulfillment | `fulfillment.allocate`, `label.reprint`, `package.seal`, `carrier.*`, `shipping.rate.*` |
| pricing | `pricing.calculate`, `pricing.run`, `pricing.run.read`, `price.list.activate`, `pricing.rule.activate`, `price.snapshot.read`, `price.list.*` CRUD |
| channels | `channel.credential.delete`, `channel.mapping.auto`, `channel.sync.cancel`, `channel.webhook.manage`, `channel.webhook.replay`, `channel.webhook.read`, `channel.api_call.read`, `integration.dead_letter.delete` |
| accounting | `accounting.fiscal_year.{read,create,update,close,reopen}`, `accounting.period.{read,close,reopen}`, `accounting.journal.approve`, `accounting.balance.read`, `accounting.ledger.read`, `accounting.link.*`, `accounting.posting_rule.{read,manage}`, `accounting.expense.*`, `approval.workflow.{read,manage}` |
| treasury | `bank.statement.{read,import}`, `payment.{submit,allocate}`, `payment_method.*`, `cheque.{update,deposit,cancel}`, `cash.session.*`, `cash.transaction.*`, `reconciliation.*` |
| partners | `partner.transaction.*`, `shareholder.share.adjust`, `shareholder.transaction.*`, `profit.distribution.{run,post,approve,reverse}`, `settlement.{create,confirm}` |
| reporting | `report.*`, `dashboard.*`, `saved_filter.*`, `export.*` |
| notifications | `notification.template.{read,manage}`, `sms.template.manage`, `sms.{read,send}` |
| platform | `job.{read,run}`, `import.{read,create,validate,commit,rollback}`, `outbox.{read,retry}`, `printer.device.{read,manage}`, `printer.job.{read,create,retry,cancel}`, `system.{read,metrics.read,maintenance.*,backup.*}`, `api_client.*`, `data.version.read`, `api_request_log.read`, `audit.export`, `webhook.outbound.{read,manage}` |
| files | `file.{read,create,delete}`, `file.link.create` |

### 5.3.1 Exact delta vs docs/02-data-model/DATA-MODEL.md §6.2 (must be added to the seed)

DATA-MODEL §6.2 is a **resource-level** view (314 keys / 248 expanded at the time of writing) and states that this API registry is the source of truth for names. The API references **412 keys**; the following 183 keys are **not present** in DATA-MODEL §6.2's current expansion and MUST be added by the backend/seed before go-live (`permissions` is idempotently upserted and CI diffs `packages/shared/permissions.ts` against this list):

```text
accounting.budget.activate
accounting.budget.approve
accounting.budget.create
accounting.budget.delete
accounting.budget.update
accounting.coa.delete
accounting.coa.import
accounting.dimension.create
accounting.dimension.delete
accounting.dimension.update
accounting.document.create
accounting.document.export
accounting.document.issue
accounting.document.void
accounting.expense.delete
accounting.expense.update
accounting.fiscal_year.reopen
accounting.fiscal_year.update
accounting.journal.approve
accounting.journal.delete
accounting.ledger.read
accounting.link.create
accounting.link.delete
accounting.link.read
accounting.posting_rule.manage
accounting.posting_rule.read
accounting.tax.create
accounting.tax.delete
accounting.tax.update
accounting.valuation.post
api_client.create
api_client.delete
api_client.rotate
api_client.update
api_request_log.read
approval.request.read
approval.workflow.manage
approval.workflow.read
audit.export
automation.alert.ack
automation.fraud.resolve
automation.rule.create
automation.rule.delete
automation.rule.test
automation.rule.update
bank.account.create
bank.account.delete
bank.account.update
bank.statement.import
bank.statement.read
carrier.create
carrier.delete
carrier.update
cash.create
cash.delete
cash.session.close
cash.session.open
cash.session.read
cash.update
channel.account.test
channel.create
channel.credential.delete
channel.mapping.auto
channel.sync.cancel
channel.sync.retry
channel.update
channel.webhook.manage
channel.webhook.replay
cheque.issue
currency.create
currency.delete
currency.update
customer.credit.read
customer.credit.update
customer.invoice.issue
dashboard.create
dashboard.delete
dashboard.update
export.delete
file.create
file.link.create
fulfillment.allocate
goods.receipt.execute
goods.receipt.update
holiday.create
holiday.delete
holiday.update
identity.break_glass.use
import.commit
import.rollback
import.validate
integration.dead_letter.delete
inventory.adjust
inventory.adjust.post
inventory.count
inventory.count.post
inventory.lot.create
inventory.lot.delete
inventory.lot.update
inventory.reserve
inventory.reserve.read
inventory.serial.create
inventory.transfer
inventory.unit.create
inventory.unit.update
label.delete
marketplace.fee.create
marketplace.fee.delete
marketplace.fee.update
media.create
media.update
notification.template.manage
notification.template.read
package.delete
package.seal
partner.create
partner.delete
partner.transaction.create
partner.transaction.read
partner.update
payment.allocate
payment.approve
payment.execute
payment.submit
payment.update
payment_method.create
payment_method.delete
payment_method.read
payment_method.update
price.list.activate
pricing.calculate
pricing.run
printer.device.read
printer.job.cancel
printer.job.read
printer.job.retry
profit.distribution.run
purchase.order.delete
reconciliation.create
reconciliation.match
reorder.rule.create
reorder.rule.delete
reorder.rule.update
report.create
report.delete
report.update
role.assign
sales.order.delete
sales.refund.void
sales.return.update
saved_filter.create
saved_filter.delete
saved_filter.update
security_event.read
settlement.create
shareholder.create
shareholder.delete
shareholder.share.adjust
shareholder.transaction.create
shareholder.transaction.read
shareholder.update
shipment.dispatch
shipment.update
shipping.rate.create
shipping.rate.delete
shipping.rate.update
supplier.invoice.approve
supplier.invoice.match
system.backup.read
system.backup.run
system.maintenance.read
system.maintenance.run
system.metrics.read
system.read
user.scope.assign
warehouse.device
warehouse.device.register
warehouse.pack
warehouse.pick
warehouse.putaway
warehouse.wave
webhook.outbound.manage
webhook.outbound.read
```

### 5.3.2 Alias/reserved keys currently in DATA-MODEL §6.2 that the API does not reference

These 85 keys appear in DATA-MODEL §6.2 but are not referenced by any route in §2/§4. Preferred action: **drop** them from the seed (regenerate §6.2 verbatim from §5.2) rather than seed dead keys. If the data-model owner prefers to keep some as `reserved` (e.g. `auth.*` route-guard keys for future use, `setting.secret.read` for a future secrets screen), they must be marked `is_system=true, reserved=true` and grants must not reference them.

```text
accounting.budget.manage
accounting.coa.deactivate
accounting.dimension.manage
accounting.document.manage
accounting.journal.void
accounting.period.create
accounting.tax.manage
api_client.manage
approval.cancel
approval.read
auth.login
auth.logout
auth.otp.send
auth.otp.verify
auth.refresh
automation.alert.acknowledge
automation.fraud.review
automation.rule.manage
bank.account.manage
carrier.manage
cash.manage
channel.order.read
cheque.create
currency.manage
dashboard.manage
device.trust
file.upload
goods.receipt.cancel
goods.receipt.post
holiday.manage
inventory.adjust.cancel
inventory.adjust.create
inventory.count.create
inventory.count.execute
inventory.reserve.create
inventory.reserve.release
inventory.transfer.cancel
inventory.transfer.create
inventory.transfer.dispatch
inventory.transfer.receive
inventory.valuation.run
label.print
marketplace.fee.manage
media.upload
notification.read
notification.send
pricing.run.create
printer.read
product.publish
profit.distribution.create
profit.distribution.post
purchase.order.cancel
purchase.order.close
reconciliation.approve
reconciliation.import
reorder.rule.manage
report.export
sales.order.allocate
sales.order.cancel
sales.order.confirm
sales.order.export
sales.refund.cancel
sales.return.cancel
sales.return.complete
sales.return.receive
saved_filter.write
setting.secret.read
settlement.dispute
shareholder.manage
shipment.deliver
shipment.pickup
shipping.rate.manage
supplier.invoice.void
user.role.assign
warehouse.device.manage
warehouse.pack.exception
warehouse.pack.execute
warehouse.pick.exception
warehouse.pick.execute
warehouse.putaway.cancel
warehouse.putaway.create
warehouse.putaway.execute
warehouse.wave.cancel
warehouse.wave.create
warehouse.wave.release
```
### 5.4 Role templates (seed convenience; roles are rows, not code)

| Role | Intended permission families (exact keys must be listed in seed) |
|---|---|
| `superadmin` | all keys; `is_system=true`, cannot be edited/deleted; break-glass not needed |
| `admin` | all except `identity.break_glass.use`, `system.backup.run`, `api_client.*` |
| `finance_manager` | accounting.*, treasury.*, partners.*, report.*, approval.workflow.read/manage, product.cost.read; **no** inventory.adjust/count/transfer (SoD) |
| `accountant` | accounting.coa/journal/ledger/balance/tax/document/valuation read + create/post where allowed, treasury read/payment.create, report.* |
| `warehouse_manager` | warehouse.*, inventory.balance/ledger/count/adjust/transfer/lot/serial/unit/valuation.read, procurement.goods.receipt, fulfillment.allocate, report.read; no cost unless granted |
| `warehouse_operator` | warehouse.pick/pack/putaway/device, inventory.balance.read (scoped warehouses), inventory.count (scan only), barcode.read, product.read (no cost), notification self |
| `sales_agent` | customer.*, sales.order.*, sales.refund.create, product.read (retail prices only), report.read (sales family) |
| `viewer` | `*.read` only, financial reports only if granted; no cost, no security_event.read |

Field-level rule: `product.cost.read` is a **standalone grant** (never implied by `product.read` or a manager role) and is required for every cost/price/margin field in responses; see §10.3. Warehouse operator and viewer roles must never receive it.

---

## 6. Webhooks

### 6.1 Inbound channel webhooks (partner → ERP)

| Item | Rule |
|---|---|
| Receiver paths | `POST /api/v1/webhooks/channels/{channelCode}` and `POST /api/v1/webhooks/channels/{channelCode}/{accountPublicId}` |
| Supported in v1 | `digikala` (webhook subscription API is contract-confirmed; signature header/algorithm **TBD-DIGIKALA** — see §8.3), `carexy` (**TBD-CAREXY**: contract has no webhook section; receiver exists but subscription stays disabled until partner confirms) |
| Auth | No user JWT. Signature verification only. Wrong/missing signature → `401 UNAUTHENTICATED` with `details.rule = "webhook_signature"`; the event is *not* archived (untrusted). |
| Raw body | Signature is computed over the **raw bytes** exactly as received (`fastify-raw-body` / `rawBody` capture before JSON parse). Re-serializing JSON breaks verification — this is a hard requirement. |
| Signature scheme | `HMAC-SHA256(secret, timestamp + "." + rawBody)`, hex, header `X-Signature` (also accept `X-Hub-Signature-256` `sha256=…` and `X-Digikala-Signature` where the partner uses them). Secret per channel account, stored encrypted, rotatable with a 24 h dual-secret window. **Digikala header name/envelope are TBD-DIGIKALA** — the adapter reads the configured header from `channel_account.settings`. |
| Timestamp | Header `X-Timestamp` (unix seconds or ISO-8601; adapter normalizes). Skew window **±300 s** (`WEBHOOK_MAX_SKEW_SECONDS`). Outside window → `401` (replay defense). Missing timestamp → rejected after a 1-release grace when `WEBHOOK_REQUIRE_TIMESTAMP=true`. |
| Replay protection | Signature covers timestamp + body; event id (`X-Event-Id`, or partner event id from parsed body) is persisted in `channel_webhook_events` with a **unique index `(channel_id, external_event_id)`**; duplicate delivery → `200` immediately with `{ duplicate: true }`, no re-processing. Replay of a *different* payload with a used event id → archived as `rejected` and alerted. |
| Idempotency | Two layers: (1) unique external event id; (2) business natural key (`channel:order:{externalOrderId}`) in `idempotency_keys`. Both are required. |
| Processing | Receiver does **only**: verify → archive raw payload → insert outbox event → `200`. All parsing/domain work happens asynchronously in the worker (target p99 response < 100 ms). Slow partner callbacks must never block the API. |
| Response codes | `200` accepted/duplicate, `401` bad signature/timestamp, `413` body > 2 MiB, `429` rate-limited, `503` DB unavailable (partner retries). Never `4xx` for a valid event whose business processing later fails — that would cause partner retry storms; failures go to DLQ. |
| Event types (Digikala, contract-confirmed subscription) | `order.created`, `order.updated`, `order.cancelled` and shipping/status events as subscribed; exact payload schema **TBD-DIGIKALA**. Unknown event types are archived and ignored (counted in metrics). |
| Carexy inbound | **TBD-CAREXY** — polling (`order_pull` sync job, 60 s interval) is the v1 default. If Carexy later exposes webhooks, they plug into the same receiver with a `carexy` signature config. |
| Limo SMS delivery callback | `POST /webhooks/limo/delivery` is **reserved** (`TBD-LIMO`); enabled only when `LIMO_WEBHOOK_SECRET` is set. Delivery status is otherwise polled via the provider's message-status API (also **TBD-LIMO** — not in the supplied contract). |
| Archive retention | `channel_webhook_events` raw payload retained 90 days (JSONB), then anonymized; `channel_api_calls` 180 days. |
| Ops surface | `GET /channel-webhook-events`, `GET /webhook/health`, replay via `POST /channel-webhook-events/{id}/replay`. |

### 6.2 Outbound webhooks (ERP → Carexy and other consumers)

| Item | Rule |
|---|---|
| Purpose | Push ERP events to Carexy (`https://carexy.shop/...`) or another consumer (e.g. a notification relay). Carexy has no confirmed inbound webhook contract either, so v1 uses **configurable outbound subscriptions** and marks the Carexy receiver endpoint contract **TBD-CAREXY**; deliveries are logged and retried regardless. |
| Endpoint | Configured URL; HTTPS only; public hosts only (SSRF guard: resolve DNS, reject private/link-local/metadata ranges, allowlist port 443/8443, no redirects). |
| Signature | `X-Saman-Signature: sha256=HMAC_SHA256(secret, timestamp + "." + rawBody)`, `X-Saman-Timestamp`, `X-Saman-Event`, `X-Saman-Delivery-Id` (UUID, also in body). Consumer must verify and dedupe on delivery id. |
| Events (v1) | `order.created`, `order.confirmed`, `order.cancelled`, `order.shipped`, `order.delivered`, `shipment.tracking_updated`, `inventory.changed` (debounced), `price.changed`, `product.published`, `return.approved`, `refund.paid`, `settlement.confirmed` |
| Delivery | Outbox → BullMQ `webhooks` queue, at-least-once, exponential backoff 30 s → 1 h, max 10 attempts, then `integration_dead_letters` + alert. Timeout 10 s, 2 retries per attempt by HTTP client. `2xx` = delivered; `410` = auto-disable subscription; other `4xx` = permanent failure (DLQ, no retry storm). |
| Ordering | Per-aggregate ordering is best-effort per subscription (single queue lane keyed by `aggregateId` hash); consumers must be idempotent and tolerate out-of-order with `occurredAt`. |
| Payload | `{ id, event, occurredAt, aggregateType, aggregateId, data, version }` with `data` being the same shape as the corresponding API resource (no cost fields unless the subscription is explicitly granted `product.cost.read`, which outbound subscriptions may configure). |
| Observability | `webhook.outbound` metrics, `GET /webhooks/outbound/deliveries`, retry endpoint; secrets shown once. |

### 6.3 Webhook security checklist (must be true in code review)

1. Raw-body capture before JSON parsing; signature compared with `crypto.timingSafeEqual`.
2. Constant-time compare, no early return on length mismatch that leaks info (compare fixed-length digests).
3. Timestamp skew ±5 min; clock is NTP-synced server-side; no client-provided time trusted beyond this.
4. Unique `(channel_id, external_event_id)`; duplicate → fast `200` no-op.
5. Body size cap 2 MiB, header size cap 16 KiB, no query-string secrets.
6. Archive before parse; never log signature/secret; redact `Authorization`/`X-API-KEY`/cookies from logs.
7. Processing async-only; webhook handler has no direct DB writes to domain tables (outbox only).
8. Per-account rate limiting and an anomaly alert on signature-failure spikes.

---

## 7. Files: upload, download, validation

### 7.1 Presigned upload flow (default)

```text
1. POST /api/v1/files/uploads            → { fileId, uploadUrl, method:"PUT", headers, expiresIn:900 }
2. PUT <uploadUrl>  (browser → S3/MinIO) → raw bytes (no API involvement)
3. POST /api/v1/files/uploads/{fileId}/complete { sha256, sizeBytes }
                                          → file metadata { id, status:"ready", ... }
4. POST /products/{id}/media { fileId }   (or file.link.create) → attach to business entity
5. GET  /api/v1/files/{id}/download-url   → presigned GET (15 min, audited)
```

| Rule | Value |
|---|---|
| URL TTL | Upload 15 min; download 15 min; both bound to the requesting user's session/request context (presign issued by API, not public bucket). |
| Object key | `{orgPublicId}/{purpose}/{yyyy}/{mm}/{fileId}/{sanitizedFileName}` — no user path traversal; `fileId` is server-generated. |
| Bucket | Private by default; `media` bucket versioned; no anonymous read. |
| Max size | Images 10 MiB; PDF/documents 25 MiB; import files 100 MiB; label PDFs 5 MiB. Per-purpose cap in settings; `413` beyond. |
| Allowed types | Images: `image/jpeg,image/png,image/webp`; docs: `application/pdf`; imports: `text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`; avatars same as images. |
| Magic-byte validation | Server sniffs file header on `complete`; declared `contentType` must match sniffed type → else `UPLOAD_UNSUPPORTED_TYPE` and object deleted. |
| Integrity | `sha256` (hex) required on complete; mismatch → `UPLOAD_CHECKSUM_MISMATCH`; size mismatch → `VALIDATION_ERROR`. |
| Antivirus | `scan` hook (`FILE_SCAN_ENABLED`): file is `pending_scan` → `ready` or `quarantined`; quarantined files are never downloadable (`RULE_VIOLATION file_quarantined`). v1 ships a ClamAV sidecar profile as optional; without it files go straight to `ready` and a security note is logged at boot. |
| Images | Server-side thumbnails (`_thumb.webp`, 320 px) generated in worker for product media; EXIF stripped. |
| Download headers | `Content-Disposition: attachment; filename*=UTF-8''…`; `Content-Type` from sniffed type; `X-Content-Type-Options: nosniff`; no inline rendering for user uploads (except whitelisted product images via the SPA image pipeline). |
| Access control | Every download URL is issued only after permission check on the linked entity (`file.read` + entity read); URL itself is short-lived. Files not linked to an entity are visible only to their uploader + admins. |
| Deletion | Soft-delete metadata; blob GC after 30 days if no links; posted accounting documents' attachments cannot be deleted (`file_in_use`). |
| Export files | Generated by worker into `exports/` prefix, download via `/exports/{id}/download`, retained 7 days then GC. |
| Backup files | Stored by the backup sidecar under `backups/`; never exposed through the API (ops-only `/system/backups` metadata). |
| Limits per org | `FILE_STORAGE_QUOTA_GB` (default 20 GB) → `413`/`RULE_VIOLATION quota_exceeded` with admin alert at 80%. |
| Logging | File id, purpose, size, sha256, uploader, linked entity; never file bytes or presigned URLs in logs. |

### 7.2 Inline file transfer exceptions

Only two endpoints accept multipart directly (`POST /files` and, for legacy integrations, imports can reference `fileId`); everything else is presigned. `POST /files` is capped at 10 MiB and is disabled when `FILE_DIRECT_UPLOAD=false`.

---

## 8. Channel adapter endpoint mappings

Adapters implement the port in `ADR-0006`; they are the **only** code allowed to call partner APIs. All calls go through the egress allowlist, per-account token buckets, retry with jitter, and the `channel_api_calls` log. Base URLs, auth and mapped endpoints below are contract-confirmed unless marked `TBD-*`.

### 8.1 Port ↔ API surface

| Port capability | ERP triggers | API surface used by SPA | Status per adapter |
|---|---|---|---|
| `pushInventory` | inventory ledger change (debounced 2–5 s), sync job | `POST /channel-sync-jobs` type `inventory_push`, mapping endpoints | carexy ✅, digikala ✅ (`seller-stock`), mock ✅ |
| `pushPrices` | pricing run apply, manual snapshot | `POST /pricing/snapshots`, `POST /channel-sync-jobs` type `price_push` | carexy ✅, digikala ✅ (`variant` price), mock ✅ |
| `pullOrders` | cron 60 s / webhook nudge | `POST /channel-sync-jobs` type `order_pull` | carexy ✅ (poll), digikala ✅ (SBS orders), mock ✅ |
| `acknowledgeOrder` | order confirm/dispatch | automatic in sync job | carexy TBD-CAREXY (no ack endpoint documented), digikala ✅ (`tracking-code`, `update-status`) |
| `updateShipment` | shipment dispatch/deliver | `POST /shipments/{id}/dispatch`, `deliver` | carexy TBD-CAREXY, digikala ✅ (`ship-by-seller-orders/*`), mock ✅ |
| `pushProduct` | product publish | `POST /products/{id}/publish` + sync job `product_push` | carexy ✅, digikala ✅, mock ✅ |
| `pullSettlements` | daily cron | `POST /channel-sync-jobs` type `settlement_pull` | carexy TBD-CAREXY, digikala ✅ (`invoices`, `commissions`), mock ✅ |
| `verifyWebhook` | inbound receiver | §6.1 | carexy TBD-CAREXY, digikala ✅ subscription API / signature TBD-DIGIKALA, mock ✅ |
| `healthCheck` | channel health cron | `POST /channel-accounts/{id}/test`, `GET /channels/health` | all ✅ |

### 8.2 Carexy adapter (contract-confirmed: `project-doc.txt` §50, §52–§54; auth header `X-API-KEY`)

- **Base URL**: `https://carexy.shop` (paths below are under `/api/v1`).
- **Auth**: header `X-API-KEY: <key>` (encrypted at rest in `channel_api_credentials`; write-only API §4.10). `Content-Type: application/json`.
- **Direction**: ERP is source of truth; Carexy is the storefront. Product/inventory push, order pull, webhook **TBD-CAREXY** (polling default).

| ERP operation | Carexy endpoint (method · path) | Request mapping (ERP → Carexy) | Response mapping (Carexy → ERP) | Notes |
|---|---|---|---|---|
| List products | `GET /api/v1/products` | query params (pagination/status; exact names **TBD-CAREXY**) | product list → `channel_product_mappings` reconciliation | used for full product reconcile |
| Get product | `GET /api/v1/products/show/{uuid}` | `uuid` = mapped `external_product_id` | product detail incl. variable schema | **Required before** creating inventory for variable products (§53) |
| Create product | `POST /api/v1/products/create` | `{ user_id, category_id, title, content?, images[], status?" }` (per SRS §50 / integration doc §6-2) | `{ product_uuid }` → stored as `external_product_id` | `user_id`/`category_id` are Carexy ids from mapping; never stored as ERP FKs |
| Delete product | `DELETE /api/v1/products/delete/{uuid}` | mapped uuid | `{ success }` | only when ERP product deleted/unpublished |
| List inventories of product | `GET /api/v1/inventories/product/{product_uuid}` | mapped product uuid | inventories with `price, discount_price, discount_expire, discount_tree, count, sale_min, max_sale, original, used, weight, purchase_price, time_send` | used to seed `channel_inventory_mappings` and detect drift |
| Create inventory | `POST /api/v1/inventories/product/{product_uuid}/create` | `{ user_id, storage_uuid, variables, price, count, weight? }` | `{ inventory_uuid }` → `external_inventory_id` | `storage_uuid` from `GET /api/v1/storages/`; `variables` from ERP variant attributes via `channel_attribute_mappings` |
| Update inventory | `PUT /api/v1/inventories/update/{inventory_uuid}` | `{ user_id, count, price }` (+ discount fields when a campaign is pushed) | `{ success }` | primary stock/price push path; never send `count` from `on_hand` — send `available` |
| Delete inventory | `DELETE /api/v1/inventories/delete/{inventory_uuid}` | mapped inventory uuid | `{ success }` | on variant archive |
| List storages | `GET /api/v1/storages/` | — | `[{ storage_uuid, name }]` → storage mapping per warehouse | required before inventory create |
| Products in storage | `GET /api/v1/storages/products/{storage_uuid}` | mapped storage uuid | product list in storage | reconciliation of external stock |
| Orders | **TBD-CAREXY** — no order endpoint in the supplied contract | — | — | v1 pulls orders by polling a partner endpoint to be confirmed; order ingestion via webhook/sync is behind `TBD-CAREXY` flags and disabled by default. Do **not** invent paths. |

**Variable mapping (§53 of source):** `ERP attribute/value → channel_attribute_mappings.variables → Carexy variables`. Workflow: fetch product detail → read its variable schema → map ERP variant attribute values → send `variables` object on inventory create/update. Missing mapping → sync job fails that item with `mapping_required` (never guessed).
**Price mapping (§54):** Carexy fields `price`, `discount_price`, `discount_expire`, `discount_tree` map from ERP: `price` ← final channel price snapshot; `discount_price` ← promotion price (if any); `discount_expire` ← promotion end; `discount_tree` ← tiered/quantity discounts (unmapped by default, flagged). Fields `count`, `sale_min`, `max_sale`, `original`, `used`, `weight`, `purchase_price`, `time_send` are **channel attributes**, never added to core tables; `count` is always ERP `available`, `purchase_price` is never sent (cost stays in ERP).
**Carexy errors:** HTTP status + body mapped to `UPSTREAM_UNAVAILABLE`/`UPSTREAM_INVALID_RESPONSE`; 401/403 on `X-API-KEY` → account marked unhealthy + alert, no retry storm; 429 honored with `Retry-After`.

### 8.3 Digikala adapter (contract-confirmed catalog: 264 endpoints / scopes; auth OAuth2 client-credentials)

- **Base URL**: `https://seller.digikala.com/open-api/v1` (OpenAPI spec `/open-api/v1/doc/specification.yml`). Server-side, host configurable per environment (sandbox supported).
- **Auth**: OAuth2. `POST /auth/token` with `{client_id, client_secret, grant_type:"client_credentials"}` → `{access_token, refresh_token?, expires_in}`; refresh via `POST /auth/refresh-token`; revoke via `POST /auth/revoke`; scopes discoverable via `GET /auth/scopes` and `GET /auth/scopes/{client_code}`. Token cached in memory per account; never logged.
- **Scopes used**: `product`, `variant`, `inventory`, `order`, `package`, `shipment`, `sbs_orders`, `sbs_setting`, `sbs_shipment`, `profile`, `promotion`, `invoice`, `commission`, `self_settings` (webhooks), `insight` (optional).
- **Full scope catalog (reviewed)**: `self_settings`, `product`, `variant`, `order`, `inventory`, `package`, `shipment`, `profile`, `question`, `insight`, `lightening_deal`, `promotion`, `voucher`, `sbs_setting`, `sbs_orders`, `sbs_shipment`, `invoice`, `commission`, `search_ads`. The supplied catalog contains 264 paths in 30 groups; the ERP consumes the core commerce groups only (product, variant, inventory, order, package, shipment, invoice, commission, webhook). The remaining groups — promotions/PLP/lightning deals/vouchers/smart discount, buybox/price-stats, search ads, Q&A, insight, batch API, SBS/postex wallet & shipping services, commitments, nearby stores — are **not integrated in v1** (future `09-roadmap`); their scopes are not requested, which keeps the least-privilege footprint small.
- **Direction**: ERP pushes product/price/stock, pulls orders, acknowledges shipment/tracking, pulls settlements. Webhook subscription is confirmed; **signature scheme and payload schemas are TBD-DIGIKALA** — no field is guessed.

| ERP operation | Digikala endpoint (method · path; scope) | Request mapping | Response mapping / notes |
|---|---|---|---|
| Authenticate | `POST /auth/token` (`self_settings`) | client_id/client_secret from encrypted credential | token + expiry; on 401 re-auth once then fail job |
| Refresh token | `POST /auth/refresh-token` | refresh_token | rotated tokens |
| Revoke | `POST /auth/revoke` | token | on account disable |
| Seller profile | `GET /profile`, `GET /profile/business`, `GET /profile/warehouse` | — | external seller/warehouse ids for mapping |
| Seller products | `GET /products/seller` (`product`) | query filters (pagination params **TBD-DIGIKALA**) | list → reconcile `channel_product_mappings` |
| Product edit (read) | `GET /product-edit/{product_id}` (`product`) | mapped product id | detail incl. variants |
| Create product | `POST /product-creation/save` (`product`) | `{category_id, title, content, images[], attributes}` — schema **TBD-DIGIKALA** | returns draft/product id → `external_product_id` |
| Publish product | `POST /product-edit/{product_id}/publish` (`product`) | product id | product visible |
| Edit product | `PUT /product-edit/{product_id}` (`product`) | changed fields | — |
| Category tree | `GET /categories/tree` (`product`) | — | used for `channel_category_mappings` |
| Category attributes | `GET /product-creation/attributes/{category_id}` (`product`) | — | schema for product create (**TBD-DIGIKALA** payload shape) |
| Variants of product | `GET /variants/creation/{product_id}` (`variant`) | product id | variant list |
| Create variant | `POST /variants/creation/{product_id}` (`variant`) | variant payload **TBD-DIGIKALA** | external variant id |
| Variant detail / update | `GET /variants/{variant_id}`, `PUT /variants/{variant_id}` (`variant`) | mapped variant id | price/activation/stock fields per schema **TBD-DIGIKALA** |
| Stock read | `GET /inventories/{product_variant_id}` (`inventory`) | variant id | external stock (reconcile only; ERP stays source of truth) |
| Stock push (single) | `PATCH /variants/{variant_id}/seller-stock` (`variant`) | `{stock}` | sent as ERP `available` not `on_hand` |
| Stock push (bulk) | `POST /batch/variant/seller-stock/update` (`variant`) | batch payload **TBD-DIGIKALA** | preferred for debounced batches |
| Price push | `PATCH /variants/selling-price` (`variant`) and/or variant update | price payload **TBD-DIGIKALA** | ERP final channel price |
| Orders (SBS) | `GET /ship-by-seller-orders` (`sbs_orders`), `GET /ship-by-seller-orders/statistics` | since/status filters **TBD-DIGIKALA** | canonical order ingestion via `channel_order_mappings` |
| Order detail | `GET /ship-by-seller-orders/{shipment_id}`, `GET …/customer/{shipment_id}`, `GET …/post-data/{shipment_id}` (`sbs_orders`) | shipment id | customer/postal data (PII redacted in logs) |
| Report tracking code | `POST /ship-by-seller-orders/tracking-code` (`sbs_orders`) | `{shipment_id, tracking_code}` (payload shape **TBD-DIGIKALA**) | marks dispatched |
| Update order status | `PUT /ship-by-seller-orders/update-status` (`sbs_orders`) | `{shipment_id, status}` (enum **TBD-DIGIKALA**) | maps to ERP shipment states only |
| Confirm full delivery | `POST /ship-by-seller-orders/full-delivered` (`sbs_orders`) | `{shipment_id}` | delivery confirmation |
| Cancel item/shipment | `POST /ship-by-seller-orders/cancel-item`, `POST …/cancel-shipment` (`sbs_orders`) | item/shipment ids | cancels ERP order/line + releases stock |
| Packages | `GET /packages`, `POST /packages`, `GET /packages/{id}`, `DELETE /packages/{id}` (`package`) | payload **TBD-DIGIKALA** | optional: Digikala-side packaging; ERP package remains canonical |
| Shipments (DK) | `GET /shipments/dk`, `POST /shipments/dk`, `GET /shipments/dk/{id}` (`shipment`) | payload **TBD-DIGIKALA** | only when carrier is Digikala's |
| Label | `GET /shipping-services/label/{registration_method}/{parcel_number}` (`sbs_shipment`) | parcel no | PDF → stored as ERP label file |
| Invoices | `GET /invoices`, `GET /invoices/{id}/details` (`invoice`) | — | settlement/invoice reconciliation |
| Commissions | `GET /commissions/` (`commission`) | — | marketplace fee actuals for settlement |
| Webhook subscribe | `GET /webhook/event-types`, `POST /webhook/subscription`, `POST /webhook/unsubscription`, `POST /webhook/subscription/change-activation` (`self_settings`) | event types + URL | ERP maps to `channel_webhook_subscriptions`; signature **TBD-DIGIKALA** |
| Health check | `GET /` | — | account health probe |

**TBD-DIGIKALA policy:** the catalog is contract-confirmed at *path/scope* level; request/response **schemas are not in the supplied document**. Any field not directly evidenced above is marked `TBD-DIGIKALA`, isolated in `channels/adapters/digikala/constants.ts`, validated in sandbox before production, and any endpoint listed here but without a confirmed schema is behind the `TBD-DIGIKALA` feature flag (returns `501 NOT_IMPLEMENTED` from the ERP side rather than guessing). Endpoints in the 264-catalog that the ERP does **not** use in v1 (ads, promotions/PLP/lightning deals, vouchers, Q&A, insights, search-ads, SBS settings, postex wallet, etc.) are not integrated; Core APIs remain: product, variant, inventory, order, shipment, package, invoice, commission, webhook, profile.

### 8.4 Limo SMS adapter (contract-confirmed: `limo-sms.txt`; auth header `ApiKey`)

- **Base URL**: `https://api.limosms.com/api`. **Auth**: header `ApiKey: <key>` (write-only credential). Content type JSON.
- **Usage in ERP**: OTP for login/2FA/step-up, transactional pattern messages (order shipped, payment received), optional bulk SMS. `SMS_MODE=mock` logs and never calls the provider (development/test only; refused in production).

| ERP operation | Limo endpoint (method · path) | Request payload (contract fields) | Response handling | Notes |
|---|---|---|---|---|
| Send OTP (login/2FA) | `POST /api/sendpatternmessage` | `OtpId` (long, pattern id), `ReplaceToken: string[]`, `MobileNumber` (string), `Send: bool` (true; `false` = quote only) | `{Success, Message, TotalAmount?}`; `Success=false` → `UPSTREAM_UNAVAILABLE` with `Message` logged (redacted phone) | preferred for OTP: pre-approved pattern, <5 s delivery; ERP stores challenge hash only |
| Send transactional (pattern) | `POST /api/sendpatternmessage` | `OtpId`, `ReplaceToken[]` (order no, amount, tracking…), `MobileNumber`, `Send:true` | same | replace tokens mapped from `sms_templates.variables`; token count must match pattern — mismatch → template validation error at config time |
| Send plain SMS | `POST /api/sendsms` | `SenderNumber`, `Message` (string), `MobileNumber: string[]`, `SendToBlocksNumber?`, `SendTimeSpan?` | `{Success, Message, MessageId[]}` | used for ad-hoc/admin messages; not for OTP |
| Send peer-to-peer (different texts) | `POST /api/sendpeertopeersms` | `SenderNumber`, `Message: string[]`, `MobileNumber: string[]`, `SendToBlocksNumber?`, `SendTimeSpan?` | `{Success, Message, MessageId[]}` | bulk personalized; arrays must be equal length |
| Provider-generated OTP code | `POST /api/sendcode` | `Mobile`, `Footer` | `{Success, Message}` | **not used** in v1: ERP generates and hashes its own OTP; kept as documented adapter capability only |
| Voice OTP | `POST /api/SendOTPVoice` | `PhoneNumber`, `GenerateCode?` (optional caller-supplied code) | `{Success, Message, GenerateCode?}` | fallback when SMS fails twice or user requests voice; ERP supplies its own code |
| Delivery status | **TBD-LIMO** — not documented in supplied contract | — | — | v1 records `MessageId[]` and marks `sent`; delivery callback endpoint reserved (§6.1); no invented status API |

**Limo rules:** `MessageId[]` persisted per recipient in `sms_messages` (one ERP row per recipient with provider message id); pattern messages are the only OTP path in production; sender number per template; 429/provider `Success=false` → job retry with backoff; OTP send limit enforced by ERP before calling Limo (5/hour/mobile, 3/10 min resend window); no message body/phone full number in logs (mask to `09xx***xxxx`); provider responses archived in `channel_api_calls` with redaction.

### 8.5 Adapter sync policy (all channels)

- Debounce inventory pushes 2–5 s per channel account; batch up to 100 items per partner call where supported, else sequential with 100 ms pacing.
- Per-account token bucket from channel settings (default 5 req/s, burst 10); 429/5xx → exponential backoff 1 s → 5 m with jitter, max 10 attempts, then DLQ.
- Timeouts: connect 5 s, total 20 s; never inside an HTTP request transaction (outbox only).
- Mapping required: an item without a mapping is skipped and counted (`mapping_required`), never created implicitly on the partner.
- Conflict rules: ERP wins for price/stock; partner wins for order lifecycle events; disputes → `channel_sync_errors` + alert (`project-doc.txt` §102).
- Full reconcile daily 03:30 per channel; drift report with `available` diffs > threshold creates an alert, never auto-overwrites partner stock without a push decision.

---

## 9. OpenAPI, client generation, versioning, changelog

### 9.1 Generation strategy

| Artifact | Source | Command | Gate |
|---|---|---|---|
| Zod DTOs | `apps/api/src/modules/**/dto/*.ts` (`nestjs-zod`) | authored | `pnpm typecheck` |
| OpenAPI 3.1 | generated from DTOs + decorators (`@nestjs/swagger` + `nestjs-zod` document factory) | `pnpm openapi:generate` → `packages/contracts/openapi.json` | CI diff check: generated file must match committed file |
| SPA types | `openapi-typescript` | `pnpm openapi:types` → `packages/contracts/src/api.d.ts` | CI typecheck |
| SPA client wrapper | thin hand-written `apiClient` around generated types (auth/refresh, error normalization, idempotency header, Persian error mapping) | `apps/web/src/lib/api` | unit tests |
| Docs UI | `/api/v1/docs` (Swagger UI) and `/api/v1/docs/openapi.json` | served only when `DOCS_ENABLED=true`; **off in production by default** | smoke test in staging |
| Contract tests | generated schema validated against fixture responses; breaking-change detection via `oasdiff` | CI | new major only for breaking changes |

Rules:

1. **Zod is the single source of truth.** No hand-maintained OpenAPI YAML; no `class-validator` duplicates.
2. Every operation declares: `operationId` (`moduleAction`, camelCase), tags (module), summary (English), description (English; Persian only in examples), security, `x-permission` extension (the exact permission key from §5), `x-auth-class`, `x-idempotency` (`required|optional|none`), `x-version-added`, and error responses referencing the shared `Error` schema.
3. **Permission and route parity test**: a test enumerates every registered Nest route and asserts it has `@Permissions(...)` and that the key exists in the registry; a second test asserts every registry key is used by at least one route (no dead keys) or is explicitly marked `reserved`.
4. Error schema is one shared component (`ErrorEnvelope`) with `code` enum generated from `packages/shared/error-codes.ts`; adding a code is additive, removing is breaking.
5. Enum value lists live in `packages/shared` and are imported by both API and SPA Zod schemas; DB uses `varchar + CHECK` (`ADR-0003`).
6. Pagination/filter/sort params are generated from per-endpoint whitelist descriptors (`listQuery({ filters, sorts, searchable, mode })`) so documentation and validation cannot drift.
7. Money/decimal schema types (`MoneyString`, `QuantityString`, `RateString`) are shared Zod brands; OpenAPI emits `type: string` + `pattern` + `format: rial-decimal`.

### 9.2 SPA client rules (`ADR-0011`)

- TanStack Query keys derive from operation ids; mutations set `Idempotency-Key` automatically for `x-idempotency=required` operations.
- 401 handling: one silent refresh via `/auth/refresh` (queued single-flight), then replay the failed request once; on failure redirect to login. `401 PERMISSIONS_CHANGED` triggers refresh + permission re-fetch.
- 409 `VERSION_CONFLICT` prompts "reload and re-apply" with a diff preview where feasible; never auto-overwrite.
- 422 `RULE_VIOLATION` / `VALIDATION_ERROR` maps `details[].path` to form fields; Persian `message` shown in toast for non-field rules.
- `202` responses poll `/jobs/{id}` with backoff and surface progress in a non-blocking job tray.
- Generated client is the only place HTTP paths appear; no string-concatenated URLs in components.

### 9.3 Versioning and deprecation

- URI major (`/api/v1`). Additive-only within v1: new endpoints, new optional request fields, new response fields, new enum values (clients must tolerate unknown enums — documented in the generated types as union + `(string & {})`).
- Breaking changes (required field, field removal/rename, type change, stricter validation, permission-key rename, status-code change) require `/api/v2` plus a migration guide.
- Deprecation lifecycle: mark in OpenAPI (`deprecated: true`, `x-sunset`), emit `Deprecation` and `Sunset` headers, announce in `docs/03-api-contract/CHANGELOG.md`, keep for ≥ 2 minor releases and ≥ 90 days, monitor usage via `api_request_logs` before removal.
- Partner adapters are version-pinned by partner, not by our API version; adapter changes are never a breaking API change.
- Error codes are a stable contract: new codes are additive; removing a code is breaking (§1.4.1).

### 9.4 API changelog convention

- File: `docs/03-api-contract/CHANGELOG.md` (added in the backend repo alongside this doc; this deliverable defines it).
- Sections: `## [API v1.x] — YYYY-MM-DD` with `Added`, `Changed`, `Deprecated`, `Removed`, `Security`.
- Every PR that touches a route/DTO/schema must add an entry under `Unreleased`; CI fails if generated OpenAPI changed without a changelog line.
- Entries reference operation ids and permission keys; security entries also reference `SECURITY.md` control ids.
- SemVer for the API: MAJOR = `/api/vN`; MINOR = additive; PATCH = docs/bugfix with no schema change.

---

## 10. Cross-cutting request behaviour

### 10.1 Request context and organization scoping

Every authenticated request builds a `RequestContext` before any repository call:

```ts
type RequestContext = {
  requestId: string;               // from X-Request-ID
  orgId: bigint;                   // internal, from JWT `org` → org public_id lookup
  actorId: bigint;                 // internal user id
  actorPublicId: string;           // UUID (for audit)
  sessionId: bigint;               // auth_sessions.id
  permissions: ReadonlySet<string>;
  permissionsVersion: number;      // JWT `pv`
  scope: { branchIds: bigint[]; warehouseIds: bigint[] };
  ip: string; userAgentHash: string;
  mfaVerified: boolean; stepUpActions: string[];
  idempotencyKey?: string;
};
```

- Controllers never see internal ids; services receive `RequestContext` + zod-validated DTO containing **public UUIDs**, resolved to internal ids by repositories **inside the same scope** (`ADR-0005`).
- Every query is org-scoped at repository level; missing `organization_id` predicate is a review-blocking bug. Cross-org id guess → `404 NOT_FOUND`.
- Scope narrowing: mutations on scoped resources (warehouse/inventory/pick/pack) verify `warehouse_id ∈ scope`; reads filter by scope silently (list) or `403 SCOPE_DENIED` (detail of an out-of-scope id is `404` to avoid existence leaks).
- `scope` is carried in the JWT; scope changes bump `permissionsVersion` so stale tokens are rejected.
- Every denial is audited as `access.denied` with `requestId`, route, key, actor (never with sensitive payload).

### 10.2 Mutation pipeline (order is fixed)

```text
router → auth guard (JWT) → permission guard (@Permissions) → scope guard
→ idempotency interceptor → Zod validation (body/query/params)
→ If-Match precondition check → domain service in one DB transaction
→ audit interceptor (diff) → serializers (cost redaction) → envelope
```

- Unknown/extra body fields are rejected (`strict` Zod) by default; this prevents mass-assignment (e.g. a client setting `organizationId` or `version`).
- Audit interceptor writes `audit_logs` in the **same transaction** for every mutation; high-risk actions add a `security_events` row.
- Outbox events are written in the same transaction as the business write; no network I/O inside the transaction (`ARCHITECTURE.md` §6).
- Domain `AppError` maps to the stable envelope; unhandled exceptions → `500 INTERNAL` with `requestId` only.

### 10.3 Cost / price field protection (must be enforced by serializers)

| Field group | Examples | Required permission | Behaviour without permission |
|---|---|---|---|
| Cost | `unitCost`, `purchasePrice`, `costRemaining`, `averageCost`, `landedCost`, `valuationValue`, `cogs` | `product.cost.read` | Fields are **stripped** from single and list responses; totals that imply cost (e.g. `inventoryValue`) are omitted from dashboards/reports; query filter/sort on cost fields → `403 FORBIDDEN`. |
| Margin / profit | `margin`, `marginPercent`, `profit`, `profitByChannel` | `product.cost.read` **or** `report.read` with financial grant | Stripped; margin-guard detail hidden. |
| Selling price | `price`, `discountPrice`, `salePrice` | entity read (`product.read`, `sales.order.read`, `price.list.read`) | Visible (retail price is not confidential); purchase/cost stays gated. |
| Partner/shareholder amounts | `sharePercent`, `capitalContribution`, profit amounts | `partner.read` / `shareholder.read` | Stripped on roles without grant. |
| Channel credentials | API keys/secrets/clients | never returned | Only fingerprint `…last4`, algorithm, `rotatedAt`, `expiresAt`. |
| PII | national id, full address, phone | entity read + org policy | Masked in logs; list responses mask national id. |

Rules: redaction happens in a single serializer layer (`common/serializers`) based on the permission set, **not** in controllers; tests assert that a warehouse-operator token never receives a cost field for every endpoint in the catalog (RBAC matrix test, `05-testing`). Cost redaction applies to exports, reports, dashboard widgets, outbound webhooks and audit diffs (audit diff stores cost only for privileged actions, otherwise redacted marker).

### 10.4 Persian user-facing message examples (canonical seed for `messageFa`)

| `code` | Persian `message` |
|---|---|
| `UNAUTHENTICATED` | «برای ادامه باید وارد شوید.» |
| `FORBIDDEN` | «دسترسی لازم برای این عملیات را ندارید.» |
| `SCOPE_DENIED` | «این عملیات خارج از محدودهٔ دسترسی شماست.» |
| `NOT_FOUND` | «مورد درخواستی پیدا نشد.» |
| `VALIDATION_ERROR` | «داده‌های ورودی معتبر نیستند.» |
| `CONFLICT` | «این مقدار قبلاً ثبت شده است.» |
| `VERSION_CONFLICT` | «این مورد توسط کاربر دیگری تغییر کرده است؛ صفحه را بازخوانی کنید.» |
| `INSUFFICIENT_STOCK` | «موجودی کافی برای این اقلام وجود ندارد.» |
| `PERIOD_CLOSED` | «دورهٔ مالی بسته شده است و ثبت در آن مجاز نیست.» |
| `APPROVAL_REQUIRED` | «این عملیات نیازمند تأیید است و به کارتابل تأیید ارسال شد.» |
| `PRICE_BELOW_MARGIN` | «قیمت پیشنهادی کمتر از حداقل حاشیهٔ سود است.» |
| `OTP_INVALID` | «کد تأیید نادرست است.» |
| `OTP_EXPIRED` | «کد تأیید منقضی شده است؛ کد جدید دریافت کنید.» |
| `RATE_LIMITED` | «تعداد درخواست‌ها بیش از حد مجاز است؛ کمی بعد دوباره تلاش کنید.» |
| `UPSTREAM_UNAVAILABLE` | «سرویس خارجی در دسترس نیست؛ درخواست برای تلاش مجدد صف شد.» |
| `INTERNAL` | «خطای غیرمنتظره‌ای رخ داد؛ با شناسهٔ درخواست با پشتیبانی تماس بگیرید.» |

`messageKey` is the stable English key (`auth.unauthenticated`, `inventory.insufficient_stock`, …); Persian text lives in the shared message catalog, not inline in controllers.

### 10.5 Configuration surface referenced by this contract

| Variable | Effect on API behaviour |
|---|---|
| `PORT` (4000) / `PUBLIC_BASE_URL` (`https://erp.carexy.shop`) | listening port; links in `Location` are path-only |
| `DOCS_ENABLED` | `/api/v1/docs` on/off (off in production) |
| `CORS_ORIGINS` | browser origins allowed; production is same-origin |
| `ACCESS_TOKEN_TTL` (10m), `REFRESH_TOKEN_TTL_DAYS` (7), `TRUSTED_DEVICE_DAYS` (30) | auth |
| `PERMISSIONS_CACHE_TTL` (5m) | permission cache; version bump invalidates |
| `IDEMPOTENCY_TTL_HOURS` (24) | replay window |
| `RATE_LIMIT_*` | tier overrides (§1.12) |
| `WEBHOOK_MAX_SKEW_SECONDS` (300), `WEBHOOK_REQUIRE_TIMESTAMP` | inbound webhook verification |
| `FILE_SCAN_ENABLED`, `FILE_DIRECT_UPLOAD`, `FILE_MAX_MB_*` | files |
| `SMS_MODE` (`mock`/`real`), `LIMO_BASE_URL` | notifications/OTP |
| `CAREXY_BASE_URL` (`https://carexy.shop`), `DIGIKALA_BASE_URL` | adapters |
| `METRICS_ENABLED`, `METRICS_TOKEN` | `/metrics` |
| `OTEL_ENABLED` | trace propagation |

---

## 11. Coverage matrix (self-review)

### 11.1 ARCHITECTURE.md §4 module → this document

| Module | Sections covering it | Status |
|---|---|---|
| platform (settings, audit, files, notifications, printers, jobs, outbox) | §4.15, §4.16, §4.17, §4.18, §4.19, §7 | ✅ |
| identity (users, roles, permissions, sessions, devices, otp, mfa) | §2, §4.1 | ✅ |
| org (organizations, branches, departments) | §4.2 (+ currencies, holidays) | ✅ |
| catalog (categories, brands, products, variants, barcodes, attributes, units) | §4.3 | ✅ |
| inventory (balances, ledger, reservations, lots, serials, counts, adjustments) | §4.4 | ✅ |
| warehouse (locations, putaway, pick waves/tasks/scans, packing, devices) | §4.5 | ✅ |
| procurement (suppliers, POs, receipts, supplier invoices) | §4.6 | ✅ |
| sales (customers, sales orders, returns, refunds) | §4.7 | ✅ |
| fulfillment (allocation, shipments, packages, labels, carriers, rates) | §4.8 | ✅ |
| pricing (price lists, rules, calc runs, snapshots, marketplace fees) | §4.9 | ✅ |
| channels (accounts, credentials, mappings, sync jobs, webhooks, api calls) | §4.10, §6, §8 | ✅ |
| accounting (coa, periods, journals, balances, valuation, tax, approvals) | §4.11 | ✅ |
| treasury (payments, banks, cheques, reconciliation, cash) | §4.12 | ✅ |
| partners (shareholders, transactions, profit distribution, settlements) | §4.13 | ✅ |
| reporting (defs/runs, dashboards, read models, exports) | §4.14 | ✅ |
| automation (business rules, alerts, fraud flags) | §4.18 | ✅ |
| health / metrics | §4.19 | ✅ |
| inbound/outbound webhooks, files | §6, §7 | ✅ |

### 11.2 Acceptance checklist (task-2)

| Check | Result |
|---|---|
| Every module in `ARCHITECTURE.md` §4 has an endpoint section | ✅ §11.1 |
| Every endpoint has an auth class and a permission key (or explicit `self/public/hmac/scrape`) | ✅ enforced by §3 rules + registry-parity CI test (§9.1 rule 3) |
| Every mutation has a permission key | ✅ (verified by extraction script; registry §5.2 lists all 412 keys) |
| Permission keys consistent with data-model seed plan | ✅ naming agreed with data-model owner; API references 412 keys. DATA-MODEL §6.2 currently lists 314 (resource-level); the exact 183-key delta to add and 85 alias keys to drop are listed in §5.3.1/§5.3.2 for the backend seed |
| No endpoint exposes internal `bigint` ids | ✅ §1.9; UUID only in paths/bodies/responses |
| No cost field without a permission note | ✅ §10.3 + cost redaction tests |
| Pagination/filter/sort/idempotency/If-Match documented per endpoint | ✅ Kind flags `C/O/IK/IM` |
| Webhook receivers: path, signature, skew, idempotency, raw body | ✅ §6.1 |
| Outbound webhooks to Carexy | ✅ §6.2 |
| Adapter mappings: Carexy real endpoints, Digikala contract-confirmed only + TBD marks, Limo payloads incl. `ReplaceToken` | ✅ §8.2–§8.4 |
| OpenAPI generation from Zod, SPA client, versioning/deprecation, changelog | ✅ §9 |
| Persian error messages | ✅ §1.4, §10.4 |
| Money as string, ISO timestamps | ✅ §1.8, ADR-0013/0014 |

### 11.3 Endpoint count summary

| Group | Endpoints |
|---|---|
| §2 Authentication & session | 27 |
| §4.1 Identity | 29 |
| §4.2 Organization | 20 |
| §4.3 Catalog | 60 |
| §4.4 Inventory | 58 |
| §4.5 Warehouse & WMS | 59 |
| §4.6 Procurement | 40 |
| §4.7 Sales | 52 |
| §4.8 Fulfillment | 31 |
| §4.9 Pricing | 27 |
| §4.10 Channels | 50 |
| §4.11 Accounting | 92 |
| §4.12 Treasury | 50 |
| §4.13 Partners | 32 |
| §4.14 Reporting | 26 |
| §4.15 Notifications & SMS | 21 |
| §4.16 Files | 9 |
| §4.17 Settings/System/API clients | 18 |
| §4.18 Audit/Automation/Platform | 49 |
| §4.19 Health/Metrics/Webhooks | 15 |
| **Total** | **765** |

Counting rule: one row = one HTTP method + path (post-action endpoints count separately from the document resource). The count is machine-verified by the extraction script in CI; this table and the file must stay in sync.

---

## 12. Open questions and TBD register

| # | Item | Owner | Blocking? | Proposed default until resolved |
|---|---|---|---|---|
| 1 | Digikala request/response schemas are not in the supplied catalog (paths + scopes only) | channels/backend | yes for adapter P5 | `TBD-DIGIKALA` constants + `501 NOT_IMPLEMENTED`; obtain OpenAPI YAML/sandbox before enabling |
| 2 | Digikala webhook signature header + algorithm | security/channels | yes for inbound DK | configurable header/secret in account settings; reject events until configured |
| 3 | Carexy order endpoints and webhook contract (not in §50) | channels | yes for Carexy order pull | polling behind `TBD-CAREXY`, disabled by default; manual order entry works |
| 4 | Carexy pagination/query parameter names and success envelope exact shape | channels | no (adapter-internal) | adapter tolerates both `data`/raw shapes; never leaks to core |
| 5 | Limo delivery-status API/webhook | notifications | no | store `MessageId`, mark `sent`; reserved receiver endpoint |
| 6 | Digikala app registration/scopes provisioning per seller account | ops | yes for go-live | account `test` endpoint reports missing scopes; admin runbook step |
| 7 | Carexy `user_id` semantics (single store user vs per-account) | channels | no | store per channel account `settings.carexyUserId` |
| 8 | Approval amount thresholds/matrix defaults | finance/product | no | seed placeholders in settings; workflow rows editable |
| 9 | Iranian 6-level CoA exact mapping to the accountant's chart | accounting | yes for accounting P4 | seed standard CoA; override via import before go-live |
| 10 | Whether `report.create` may use SQL templates or only pre-seeded codes | security/backend | no | custom report definitions restricted to admin + non-arbitrary template registry |
| 11 | E-invoicing (سامانه مؤدیان) submission vs export-only | product | no (out of scope v1) | export JSON/XML only; submission roadmap |
| 12 | Rate-limit numeric tiers validation under load | qa/perf | no | values in §1.12 are targets pending k6 in `05-testing` |
| 13 | `If-Match` required on every PATCH vs optional for low-risk master data | backend/product | no | required where marked `IM`; others accept-if-present |
| 14 | Antivirus sidecar mandatory in production? | security | no | optional in v1, logged at boot; recommended for go-live |
| 15 | Channel order poll interval 60 s vs webhook-only | channels/product | no | 60 s cron + webhook nudge |
| 16 | Idempotency retention 24 h vs partners retrying later | backend/channels | no | 24 h for client keys; business natural keys are permanent |
| 17 | Persian message ownership: message catalog vs hardcoded per service | frontend/backend | no | shared catalog keyed by `messageKey`; `message` always server-provided |
| 18 | Named financial reports as generic codes vs dedicated routes | frontend/backend | no | generic `POST /reports/{code}/run`; SPA menu maps codes |
| 19 | Carexy outbound webhook consumer endpoint existence | channels | no | outbound subscriptions configurable; deliver to any HTTPS consumer |
| 20 | Multi-currency documents | product | no (explicitly out of scope v1) | reject non-IRR with `currency_not_supported` |

---

## 13. Related documents

| Document | Relationship |
|---|---|
| `docs/00-overview/README.md` | product scope, personas, success criteria |
| `docs/01-architecture/ARCHITECTURE.md` | §8 API contract origin, §9 auth, §10 security boundaries |
| `docs/02-data-model/DATA-MODEL.md` | tables, seed plan (permissions registry source), partitioning |
| `docs/04-security/SECURITY.md` | ASVS controls, webhook HMAC details, rate-limit hardening, PII redaction |
| `docs/05-testing/TESTING.md` | contract tests, RBAC matrix tests, k6 thresholds |
| `docs/06-deployment/*`, `docs/07-operations/*` | env vars, reverse proxy, metrics scraping |
| `docs/adr/0004-auth-sessions.md`, `0006-channel-adapters.md`, `0007-inventory-ledger.md`, `0008-authorization.md`, `0013-money-precision.md`, `0014-calendar-numbering.md` | normative decisions applied here |

