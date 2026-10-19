# 01 — Architecture

**خلاصهٔ فارسی:** معماری نهایی «Modular Monolith + Event-Driven» است: یک API بی‌حالت، یک Worker، PostgreSQL با schema واحد `erp`، Redis برای کش/صف/محدودیت نرخ، و S3-compatible برای فایل. مرزهای ماژول با قواعد وابستگی یک‌طرفه و مالکیت جدول‌ها تضمین می‌شود تا در آیندهٔ دور بتوان هر ماژول را بدون بازنویسی جدا کرد. این سند تصمیم‌ها، سیاست تراکنش، مدل رویداد، قرارداد API و طرح ظرفیت را تثبیت می‌کند.

Status: **Accepted v1.0** · Supersedes: microservice proposal in `erpcarexy.docx` §2 and queues without outbox.

---

## 1. Context

- Two enterprise design documents exist and **conflict**: the 246-section master spec chooses *Modular Monolith + Event Driven*; the SRS/`erpcarexy.docx` chooses *microservices + Database-per-Service + Kafka/RabbitMQ + Elasticsearch*.
- Deployment target is **one server** (user requirement), with 10,000+ SKUs and high daily transaction volume.
- Team size in practice is small; operational budget is one host, not a Kubernetes cluster.

Microservices on a single host buy nothing but distributed-transaction pain: accounting needs cross-module atomicity (order → stock → journal), and the SRS's own "Saga/Outbox" list is evidence that the author already felt that pain. We therefore adopt a **modular monolith with enforced module boundaries** and keep *every* seam needed to extract a service later (`ADR-0001`).

## 2. Decisions at a glance

| ADR | Decision |
|---|---|
| 0001 | Modular Monolith over Microservices |
| 0002 | Stack: NestJS 11 + Fastify, TypeScript strict, Drizzle ORM, React 19 + Vite |
| 0003 | PostgreSQL 16, single `erp` schema, `bigint` identity + `uuid public_id`, soft delete + optimistic `version` |
| 0004 | AuthN: short-lived JWT in memory + rotating refresh cookie + OTP/2FA device trust |
| 0005 | Organization scoping at repository layer; RLS reserved for a later multi-tenant profile |
| 0006 | Channel adapters behind a canonical port; no channel types leak into the domain |
| 0007 | Append-only inventory ledger + maintained balance projection; row-locked allocation |
| 0008 | Permission-based RBAC + separation of duties + approval workflow |
| 0009 | Monthly range partitioning for high-volume append-only tables + BRIN |
| 0010 | BullMQ (Redis) for jobs, transactional Outbox for reliable events, no Kafka |
| 0011 | Vite SPA (not Next.js); AI seams isolated behind interfaces |
| 0012 | Docker Compose as the supported topology; TLS via Caddy/nginx; automated backups |
| 0013 | Money = `bigint` IRR; quantities `numeric(18,4)`; rates `numeric(12,6)`; never floats |
| 0014 | Jalali calendar for UI/reporting, Gregorian `timestamptz` in DB; fiscal year configurable |

## 3. Runtime topology

```text
                        ┌──────────────────────────────┐
   Browser (RTL SPA) ───▶│ nginx / Caddy  (TLS, gzip)   │
                        │  /            → apps/web      │
                        │  /api/*       → apps/api      │
                        └───────────────┬──────────────┘
                                        │ HTTP/JSON
                        ┌───────────────▼──────────────┐
                        │  apps/api  (stateless, N×)   │
                        │  NestJS + Fastify            │
                        └───┬───────────┬───────────┬──┘
                            │           │           │
                 ┌──────────▼──┐  ┌─────▼─────┐ ┌──▼──────────────┐
                 │ PostgreSQL  │  │  Redis    │ │ S3 / MinIO      │
                 │ 16 (erp)    │  │ cache/    │ │ media, exports, │
                 │ + partitions│  │ queue/    │ │ labels, backups │
                 └──────▲──────┘  │ ratelimit │ └─────────────────┘
                        │         └─────▲─────┘
                 ┌──────┴─────────────┐  │
                 │ apps/worker        │──┘
                 │ outbox, sync, jobs │
                 │ scheduler, reports │
                 └──────┬─────────────┘
                        │ HTTPS (egress)
             ┌──────────▼───────────────────────────────┐
             │ Channel adapters: Carexy · Digikala ·    │
             │ Snapp/Tapsi (stub) · Limo SMS             │
             └──────────────────────────────────────────┘
```

**Processes:** `api` (HTTP, horizontally scalable), `worker` (queues + cron; at least one), `web` (static files served by nginx), plus `postgres`, `redis`, `minio`. All stateless processes may be replicated; only PostgreSQL is stateful in v1 (Redis is a cache/queue, not a source of truth).

## 4. Module map

```text
platform        settings · audit · files · notifications · printers · jobs · outbox
identity        users · roles · permissions · sessions · devices · otp · mfa
org             organizations · branches · departments
catalog         categories · brands · products · variants · barcodes · attributes · units
inventory       balances · ledger · reservations · lots · serials · counts · adjustments
warehouse       locations tree · putaway · pick waves/tasks/scans · packing · devices
procurement     suppliers · purchase orders · receipts · supplier invoices
sales           customers · sales orders · returns · refunds
fulfillment     allocation · shipments · packages · labels · carriers · rates
pricing         price lists · rules · calc runs · snapshots · marketplace fees
channels        accounts · credentials · mappings · sync jobs · webhooks · api calls
accounting      coa · periods · journals · balances · valuation · tax · approvals
treasury        payments · banks · cheques · reconciliation · cash
partners        shareholders · transactions · profit distribution · settlements
reporting       report defs/runs · dashboards · read models · exports
automation      business rules · alerts · fraud flags
```

### 4.1 Dependency rules (enforced in review + lint)

1. Dependencies point **inward**: `controller → application service → domain/repository → db`. Controllers never touch `db` directly.
2. A module may import another module's **public service** (`XxxService`) but must never import another module's repository/table. Table ownership is exclusive.
3. `platform`, `identity`, `org` are cross-cutting; `accounting` may not import `channels` (events only); `channels` may not import `accounting`.
4. Cross-module side effects go through the **event bus** (`emit(event)` in-process now, Outbox for durable/external ones).
5. Adapters (`channels/adapters/*`, `integrations/*`) depend on ports, never the reverse.

## 5. Layering & conventions

```text
apps/api/src/
  main.ts                 bootstrap (Fastify, helmet, body limits, validation pipe)
  app.module.ts           composition root
  config/                 zod-validated env schema (fail fast at boot)
  common/                 guards, interceptors, filters, pagination, idempotency, audit
  modules/<domain>/       controller · service · dto · repository · events · tests
  workers/                job processors (imported by worker entry)
packages/
  shared/                 money, jalali, permission registry (generated), errors, enums, zod primitives
  db/                     drizzle schema, SQL migrations, migration runner, seed, admin CLI
apps/web/                 Vite SPA (see ADR-0011)
```

DB is a first-class workspace package (`@saman/db`) so API and worker share one schema
and one migration stream, and so the seed/CLI can run without booting the HTTP app.

- **DTO = Zod schema** (`nestjs-zod`), types derived from schema; no `class-validator` duplication.
- **Repositories** own SQL; services own business rules; no raw SQL in controllers.
- **Money** is `bigint` rials; expose as string in JSON to prevent JS precision loss (`ADR-0013`).
- **Errors**: typed `AppError(code, messageFa, httpStatus, details)`; global filter maps to `{ error: { code, message, details, requestId } }`.
- **Naming**: DB `snake_case`, TS `camelCase`, tables plural, permission keys `resource.action`.

## 6. Data access & transaction policy

- One `postgres.js` pool per process (`max` from env, default 20); connection timeout + idle handling.
- Every write endpoint runs in **one DB transaction**, using `db.transaction(async tx => …)` with a retry wrapper for serialization failures/deadlocks (max 3).
- Row locking order is fixed and documented per flow to prevent deadlocks:
  - Inventory: lock `inventory_balances` by ascending `(warehouse_id, variant_id)`; never lock ledger rows.
  - Documents: number allocation via `numbering_sequences` row (`SELECT … FOR UPDATE`), then insert header, then lines.
  - Accounting: period row `FOR SHARE` while posting; journal insert then deferred balance check.
- **No long transactions around network I/O.** External calls happen *after* commit, from the outbox/queue.
- Read paths use plain queries; heavy reports use read models (`reporting` SQL/matviews) and are never mixed with write transactions.
- `statement_timeout` per role (api 5s, worker 30m, migration 0); slow-query log > 200 ms.

## 7. Events, jobs & scheduling

**Transactional outbox**

1. In the same transaction as the business write, insert `outbox_events(aggregate_type, aggregate_id, event_type, payload, available_at)`.
2. Worker polls `FOR UPDATE SKIP LOCKED` every 1 s, dispatches handlers, marks `processed_at`; failures get exponential backoff and land in `integration_dead_letters` after N attempts.
3. `NOTIFY` is used only as a wake-up hint; correctness never depends on it.

**Queue topology (BullMQ)**

| Queue | Examples | Concurrency |
|---|---|---|
| `channel-sync` | push stock/price, pull orders, full reconciliation | 5 (rate-limited per channel) |
| `fulfillment` | allocate order, generate pick wave, print label | 10 |
| `accounting` | post journal from event, run valuation | 5 |
| `notifications` | SMS OTP/pattern, in-app notify | 20 |
| `reports` | build export, refresh matview | 2 |
| `maintenance` | partition creation, retention, vacuum advice, backup trigger | 1 |

Schedules: `* * * * *` outbox dispatch; `*/5` stock sync sweep; daily 02:00 partition maintenance + matview refresh; daily 03:00 backup verification; hourly channel health.

**Idempotency**: every externally-triggered job carries a natural key (`channel:order:123`, `webhook:event-id`) persisted in `idempotency_keys`; duplicate keys are dropped, never re-executed.

## 8. API contract

- Base path `/api/v1`, JSON only, UTF-8, no trailing slashes.
- **Versioning**: URI major version; additive changes only within v1 (deprecation header + 2 minor releases).
- **Auth**: `Authorization: Bearer <access>` (10 min). Refresh via `POST /auth/refresh` using an httpOnly cookie (7 days, rotated, reuse-detected).
- **Pagination**: cursor (`?cursor=&limit=`) for ledgers/logs/orders; offset (`?page=&perPage=`) allowed for small admin lists. Response `{ data, meta: { nextCursor, total? } }`.
- **Filtering/sorting**: whitelisted fields per endpoint, `?sort=-created_at`, `?filter[status]=posted`.
- **Idempotency**: `Idempotency-Key` header supported on all `POST` that create business documents; 24 h retention; replay returns the original response.
- **Concurrency**: `If-Match: <version>` on mutable resources → `409 VERSION_CONFLICT`.
- **Errors** (stable codes): `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `VERSION_CONFLICT`, `RATE_LIMITED`, `RULE_VIOLATION`, `UPSTREAM_UNAVAILABLE`, `INTERNAL`.
- OpenAPI is generated from Zod DTOs at `/api/v1/docs` (disabled in production unless `DOCS_ENABLED=true`).

## 9. AuthN / AuthZ

- Argon2id password hashing (memory 64 MB, iterations 3, parallelism 1); password policy + breach-list check; per-user lockout + IP throttling.
- Access JWT (HS256 by default, RS256-ready) with `sub`, `org`, `sid`, `perms_version`; permission set cached in Redis and invalidated on role change.
- Refresh token: random 256-bit, **hashed** in `auth_sessions`, rotated on every use; reuse revokes the session family (`ADR-0004`).
- OTP: 6 digits, 2 min TTL, hashed at rest, max 5 sends/hour/mobile, max 5 verify attempts, single use. Sent through Limo SMS adapter; in `SMS_MODE=mock` logged, never in production.
- 2FA challenge on new device (device fingerprint + trusted-device table), and on sensitive actions (password change, channel credentials, journal-close).
- RBAC: `permissions` are code-defined seed rows (`inventory.adjust`, `accounting.post`, …); roles map to sets; guards enforce `@Permissions()`; **scope** narrowing (`branch_id`, `warehouse_id`) applied server-side from token claims.
- Maker-checker: `approval_requests` for high-risk actions (manual journal > threshold, stock write-off, refund, channel credential change).

## 10. Security boundaries (summary — full model in `04-security`)

| Boundary | Control |
|---|---|
| Browser ↔ API | TLS, HSTS, strict CORS allowlist, SameSite=Lax refresh cookie, double-submit CSRF on cookie-auth endpoints, CSP at nginx |
| API ↔ PostgreSQL | Least-privilege roles (`saman_app` no DDL, `saman_migrator` DDL, `saman_readonly` for reports); TLS optional on private network |
| API ↔ channels | Egress allowlist, per-channel credentials encrypted with AES-256-GCM (`APP_ENCRYPTION_KEY`), no credential in logs |
| Webhooks in | HMAC signature verification per channel, timestamp skew ≤ 5 min, replay protection |
| Files | Magic-byte validation, size caps, antivirus hook seam, content-disposition, no public bucket by default |
| Secrets | `.env` only (mode 600), never in git; rotation runbook; no secrets in error messages |

## 11. Capacity & performance plan

Assumptions: 10k SKUs → ~40k variants; 50k orders/day peak → ~2 orders/s average, ~20/s peak. At 20 orders/s with 3 line items each, stock reservation must sustain ~60 locked row updates/s — trivially within a single PostgreSQL instance if rows are narrow and indexes stay hot.

1. **Indexing**: every FK indexed; composite indexes matching actual access paths (`inventory_balances(warehouse_id, variant_id)`, `sales_orders(organization_id, status, created_at DESC)`, `inventory_transactions(warehouse_id, variant_id, created_at DESC)`); partial indexes for open work queues (`status IN ('pending','in_progress')`).
2. **Partitioning**: `inventory_transactions`, `audit_logs`, `api_request_logs`, `channel_api_calls`, `outbox_events` (processed) by month (RANGE on `created_at`); BRIN on `created_at`; retention: api logs 90 d, audit 7 y (archive), outbox processed 30 d.
3. **Read models**: `inventory_balances` (hot projection, row per warehouse×variant), `account_balances` (per account×period), daily sales/stock matviews for dashboards.
4. **Caching (Redis)**: permission sets (5 min + versioned), settings, channel mappings, category tree, product lookups by barcode/SKU (60 s); invalidation by version key bump, never by deleted TTL only.
5. **Batching**: channel stock push aggregated per channel (debounce 2–5 s); imports via `COPY` in worker with chunked validation.
6. **Backpressure**: per-channel token buckets, job concurrency caps, queue depth alerts; API rate limits per user/IP class.
7. **Frontend**: route-level code splitting, virtualized tables, keyset pagination; optimistic UI only where safe (scanner flows).
8. **Pooling**: `max=20` per API replica; document PgBouncer (transaction mode) for > 4 replicas.

Worst-case checks to keep green in CI (k6 profile in `docs/05-testing`): 1,000 concurrent product reads p95 < 200 ms; 100 parallel allocations on one variant → exactly stock-available reservations succeed, zero negative balances.

## 12. Observability

- **Logs**: pino JSON to stdout, `requestId` + `orgId` + `userId` + `route` + `latency`; no bodies/PII; 30-day retention via docker log rotation.
- **Metrics**: `/metrics` (Prometheus) — HTTP histogram, DB pool, queue depth/age, outbox lag, channel failure rate, cache hit ratio.
- **Tracing**: OpenTelemetry hooks ready (`OTEL_ENABLED`), W3C traceparent propagated to channels.
- **Health**: `/health/live` (process), `/health/ready` (DB + Redis + S3), `/health/version`.
- **Alerts** (documented rules): outbox lag > 60 s, queue failed > 10, 5xx > 1%, DB connections > 80%, disk < 15%, backup age > 26 h.

## 13. Failure modes & resilience

| Failure | Behaviour |
|---|---|
| Channel API down/timeout | job retries with exponential backoff + jitter; stock keeps truth in DB; stale-sync alert; no user-facing failure |
| Duplicate webhook/order | idempotency key on `channel:order:id`; second delivery is a no-op |
| Worker crash mid-job | BullMQ stalled-job recovery; handlers idempotent; outbox rows only marked after success |
| Redis outage | API degrades: rate limit falls back to in-memory, caching bypassed, queue paused; writes continue |
| DB primary restart | connections retried; API returns 503 on `ready`, LB drains; no data loss (synchronous commit) |
| Partial batch failure | per-item results + `import_errors`; no all-or-nothing surprise |
| Clock skew | all timestamps server-side; channel payload timestamps validated with 5 min tolerance |

## 14. Backup & disaster recovery

- Nightly `pg_dump -Fc` + continuous WAL archiving (optional `pgBackRest` profile), uploaded to S3/MinIO with 30-day retention; `sha256` manifest.
- Redis is disposable (AOF optional for queues).
- Restore drill documented quarterly; target **RPO ≤ 15 min, RTO ≤ 1 h**.
- Object storage versioning on for media bucket; DB backups encrypted (age/GPG).

## 15. Testing strategy (details in `05-testing`)

| Layer | Tool | Gate |
|---|---|---|
| Unit (domain rules, pricing, valuation, RBAC) | Vitest | ≥ 80% lines on `services/`, `engines/` |
| Integration (real PostgreSQL, migrations, transactions) | Vitest + Testcontainers (CI) | all critical flows |
| Contract (API schema, OpenAPI diff) | Zod + generated spec | no breaking change |
| E2E smoke (login→sale→journal) | Playwright (CI) | must pass before release |
| Load | k6 profiles | p95 budgets above |
| Security | dependency audit, gitleaks, semgrep, OWASP ZAP baseline | no high/critical |

## 16. Environments & configuration

| Env | Purpose | Data |
|---|---|---|
| `development` | local, docker compose infra only | seed data, mock channels, `SMS_MODE=mock` |
| `test` (CI) | ephemeral PG container | fixtures |
| `staging` | pre-prod on same compose file | anonymized copy |
| `production` | customer server | real |

Config is **12-factor**: everything via env, validated by Zod at boot; no config file secrets; `APP_ENV` drives safety defaults (docs off, verbose errors off, secure cookies on).

## 17. Delivery phases

| Phase | Output | Status |
|---|---|---|
| P0 Design | architecture + ADRs + data model + API contract + security + deployment docs, 3 review rounds | ✅ design v1.1 (round 1 remediated; rounds 2–3 in progress) |
| P1 Platform | monorepo, config, db schema/migrations/seed, auth/RBAC/audit, Docker, CI | 🧱 in progress |
| P2 Catalog + Inventory | products/variants/barcodes, warehouse tree, ledger, reservations, adjustments, counts | ⬜ planned |
| P3 Sales + Fulfillment | orders, allocation, pick/pack scans, shipments, labels, returns | ⬜ planned |
| P4 Accounting + Treasury | CoA, journals, auto-posting, reports, cheques, settlements | ⬜ planned |
| P5 Channels | adapters, mappings, sync, webhooks, DLQ | ⬜ planned |
| P6 Frontend | all admin screens + scanner PWA flows | ⬜ planned |
| P7 Hardening | tests, load profiles, backups, runbooks, docs | ⬜ planned |
| Roadmap | HR/payroll, e-invoicing, Snapp/Tapsi contracts, AI assistants, HA profile | `09-roadmap` |

> Status is truthful: only what exists in the repository with tests may be marked shipped.
> `docs/09-roadmap/ROADMAP.md` is the single place where delivery status is updated.

Definition of Done for any feature: migration + service + API + permission + audit + tests + OpenAPI + UI + docs + no `TODO` left in shipped path.
