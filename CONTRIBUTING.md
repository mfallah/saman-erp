# Contributing to Saman ERP

> Team-internal project. Read this before your first commit.

## Ground rules

1. **Design first.** A feature starts in `docs/` (or an ADR) and only then in code.
2. **One migration per change.** Never edit an applied migration; add a new one.
3. **Every mutation needs**: Zod DTO, permission decorator, audit event, test, OpenAPI exposure.
4. **No secrets, ever.** `.env` is git-ignored; use placeholders in `.env.example`.
5. **No `any` in domain paths.** `unknown` + narrowing is the expected style.
6. **Money is `bigint` (IRR)** and crosses the API as a string. Never use `number` for money.
7. **All DB access through repositories.** No `db.select()` in controllers/services.
8. **No cross-module table access** (see `docs/01-architecture/ARCHITECTURE.md` §4.1).

## Branching & commits

- Branch: `feat/<scope>`, `fix/<scope>`, `chore/<scope>`, `docs/<scope>`.
- Conventional Commits: `feat(inventory): reserve stock with row locks`.
- PRs: small, one concern, linked issue, screenshots for UI changes, `pnpm verify` green.
- Squash merge to `main`; `main` is always releasable and deploys to staging.

## Local workflow

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d   # postgres, redis, minio
pnpm db:migrate && pnpm db:seed
pnpm dev:api     # :4000
pnpm dev:web     # :5173
pnpm verify      # lint + typecheck + unit + build (must pass before PR)
```

Integration tests need Docker (Testcontainers) or `TEST_DATABASE_URL` pointing at a disposable database.

## Code review checklist

- [ ] Correctness: concurrency, transactions, idempotency, money rounding
- [ ] Security: permission + scope, input validation, no PII in logs, no SSRF
- [ ] Data: indexes for new queries, migration reversible/rollback note, no N+1
- [ ] Ops: logs, metrics, error codes, feature flag if risky
- [ ] Tests: unit + integration for the invariant touched; negative cases
- [ ] Docs: API doc, ADR if decision changed, changelog entry

## Definition of Done

Migration + service + API + permission + audit + tests + OpenAPI + UI + docs + no
open `TODO` in the shipped path + `pnpm verify` green.

## Ownership

See `.github/CODEOWNERS`. Security-sensitive paths (`auth`, `crypto`, `channels/adapters`,
`scripts/`, `docker-compose*.yml`) require Security Lead review.
