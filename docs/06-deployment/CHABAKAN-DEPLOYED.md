# Chabakan deployment record — 2026-10-21 (updated 2026-10-22)

## Services (hourly billing)
| service | plan | role |
|---|---|---|
| `docker-0ga2pf` | 0.15 RAM / 0.15 CPU / 1GB (hourly) | API + Worker + admin SPA (`APP_ROLE=all`) on port 80 |
| `postgresql-49y6qs` | 0.25 RAM / 2GB (hourly) | PostgreSQL 16.14, db `benjamin` |
| `redis-xoefwl` | 0.25 RAM / 2GB (hourly) | Redis (queue/cache/rate-limit) |

Public URL: https://docker-0ga2pf.chbkn.dev

## Result
- Image built from the repo root `Dockerfile` (production stage, pnpm hoisted layout) and deployed with `POST services/docker-0ga2pf/deploy/`.
- `migrate`: 226 tables in schema `erp`.
- `seed`: 414 permissions, 169 CoA accounts, 6 channels, settings, superadmin.
- API started on `0.0.0.0:80` (`env=production`); worker booted; outbox dispatcher registered 9 handlers.
- Admin SPA (prebuilt `apps/web/dist`) is copied into the image and served from the same origin: `webRoot=/app/web-dist`, SPA fallback, `/api/*` still JSON.
- `/health/ready` verified against the same DB/Redis from a local API instance: `db up`, `redis up`, `s3 skipped`.
- Auth (login 202 → OTP 200 → JWT) and `/auth/me`, `/products`, `/inventory/balances`, `/roles`, `/settings`, `/audit-logs`, `/dashboard/summary` all 200.
- Write path: customer 201, category 201, audit +2, outbox +2 (test rows removed).

## Superadmin
- username `admin`, mobile `09999907902` (`superadmin` role).
- Password set during deployment — change after first login.

## Build gotchas fixed here
- `pnpm install --frozen-lockfile --ignore-scripts` (pnpm 10+ errors on ignored builds unless the flag is explicit).
- copy `tsconfig.base.json` into the image (otherwise TS targets ES5 and BigInt literals fail).
- keep workspace `node_modules` for `shared`/`db` (zod/postgres were missing at runtime).
- `node-linker=hoisted` + explicit TanStack peer deps for the SPA build.
- `.dockerignore` must re-include `apps/web/dist`; the root Dockerfile must end with the production stage and must not leave a trailing `\` on the build `RUN`.

## Open items
- Limo SMS credentials saved by the operator (sender `9998620687`, pattern `3401`).
- S3/MinIO not configured (`s3: skipped`): uploads/exports disabled.
- Custom domain `erp.carexy.shop` not connected yet.
