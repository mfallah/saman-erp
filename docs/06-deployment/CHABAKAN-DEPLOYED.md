# Chabakan deployment record — 2026-10-21

## Services (hourly billing)
| service | plan | role |
|---|---|---|
| `docker-0ga2pf` | 0.15 RAM / 0.15 CPU / 1GB (hourly) | API + Worker (`APP_ROLE=all`) on port 80 |
| `postgresql-49y6qs` | 0.25 RAM / 2GB (hourly) | PostgreSQL 16.14, db `benjamin` |
| `redis-xoefwl` | 0.25 RAM / 2GB (hourly) | Redis (queue/cache/rate-limit) |

## Result
- Image built from this repo (root `Dockerfile`, prod stage) and deployed via `services/docker-0ga2pf/deploy/`.
- `migrate`: 226 tables (schema `erp`) applied.
- `seed`: 414 permissions, 169 CoA accounts, 6 channels, settings, superadmin.
- API started on `0.0.0.0:80`, env `production`; worker booted and outbox dispatcher registered 9 handlers.
- `/health/ready` (verified against the same DB/Redis from a local API instance): `db up`, `redis up`, `s3 skipped`.
- Auth: login 202 → OTP verify 200 → JWT; `/auth/me`, `/products`, `/inventory/balances`, `/roles`, `/settings`, `/audit-logs`, `/dashboard/summary` all 200.
- Write path: create customer 201, create category 201, audit +2, outbox +2 (test rows cleaned up).

## Superadmin
- username `admin`
- mobile `09999907902`
- password reset during deployment (change after first login)

## Open items
- Limo SMS env still needs real values (`LIMO_API_KEY`, `LIMO_SENDER`, `LIMO_OTP_PATTERN_ID`) — currently placeholder; OTP delivery will fail until set.
- Object storage (S3/MinIO) not configured: `s3: skipped`, uploads/exports disabled.
- Web SPA not deployed yet (static service or nginx image).
- Custom domain not connected; using the platform default URL.
- `.env` values must be stored without the `KEY=` prefix (the container sanitises it, but keep them clean).

## Ops notes
- Deploy: `POST https://apihub.chabokan.net/api/v1/services/docker-0ga2pf/deploy/` (multipart `file` + `options`).
- Logs: `GET …/services/docker-0ga2pf/logs/`; restart: `GET …/restart/`.
- Migrations/seed run automatically at container start (`RUN_MIGRATIONS_ON_START=1`, `RUN_SEED_ON_START=1`).
- Managed PostgreSQL mode: `DB_MANAGED=true`, `MANAGED_PG=1` (single owner role; cluster-role DDL stripped).
