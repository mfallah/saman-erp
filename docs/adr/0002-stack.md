# ADR-0002 — Technology stack

**Status:** Accepted · **Date:** 1405-07-27

## Context

Documents name Prisma/Express-like code samples, React SPA, PostgreSQL and Redis. We need one coherent, type-safe stack that a small team can run for years, with predictable performance on modest hardware.

## Decision

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript 5.x, `strict`, no `any` in domain paths | end-to-end type safety with SPA |
| Backend | **NestJS 11 + Fastify adapter** | modules/DI/guards match the modular monolith; Fastify for throughput |
| Validation/contracts | **Zod** (`nestjs-zod`), inferred types | one source of truth: DTO ↔ OpenAPI ↔ SPA types |
| ORM/query | **Drizzle ORM + postgres.js** | SQL-first, typed, no hidden N+1; migrations as plain SQL |
| DB | **PostgreSQL 16** | transactions, JSONB, partitioning, BRIN, `pg_trgm` |
| Cache/queue | **Redis 7 + BullMQ** | cache, rate limit, jobs, scheduler |
| Object storage | **S3-compatible (MinIO)** | media, exports, labels, backups |
| SPA | **React 19 + Vite + TanStack Router/Query + Tailwind v4** | fast RTL dashboard, simple static deploy |
| Tests | Vitest + Supertest + Testcontainers + Playwright + k6 | unit → E2E → load |
| Infra | Docker multi-stage, Compose, nginx, GitHub Actions | single-host deploy + CI |

## Consequences

- Prisma samples from the SRS are **not** reused; the reference DDL is converted to Drizzle schema + SQL migrations.
- Fastify means no Express middleware ecosystem; we use Fastify plugins (helmet, rate-limit, cookies, multipart).
- Vite SPA has no SSR: acceptable for an authenticated admin product; keeps deploy simple (nginx static).

## Alternatives rejected

- **Prisma** — heavier runtime, weaker control over `FOR UPDATE`, partitioning and complex reporting SQL.
- **Next.js** — SSR/edge value not needed for an internal admin; extra server process and cache semantics.
- **Express** — weaker plugin/perf story than Fastify and Nest+Fastify.
- **MongoDB** — accounting/inventory need relational integrity.
