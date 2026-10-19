# 06 — Deployment Architecture (English)

**Status:** Design baseline v1.0 · Owner: DevOps/Platform Lead · Audience: platform engineers, SREs, implementers.
**Companion docs:** [`INSTALL-FA.md`](./INSTALL-FA.md) (step-by-step Persian install), [`../07-operations/RUNBOOK.md`](../07-operations/RUNBOOK.md), [`../07-operations/BACKUP-RESTORE.md`](../07-operations/BACKUP-RESTORE.md), [`../adr/0012-deployment.md`](../adr/0012-deployment.md).

> **Verification honesty:** Docker was **not available** in the design/build environment. Everything below is a design contract derived from `ARCHITECTURE.md §3/§14/§16` and `ADR-0012`, reviewed by inspection against the canonical `.env.example`. No `docker compose config`, `build`, or `up` has been executed. Runtime validation is an explicit release-gate item (see §16). Do not describe this stack as "tested" until a real host run is recorded.

---

## 1. Purpose & scope

This document defines **how Saman ERP is packaged and shipped** to a customer-owned server:

- the supported single-host Docker Compose topology (the only supported v1 topology),
- the service/port/volume/health contract the Compose implementation must satisfy,
- the environment-variable and secrets contract,
- the database topology (in-Compose PostgreSQL and external/managed PostgreSQL),
- the release, upgrade, rollback and scaling procedures,
- the multi-environment model.

It does **not** contain the copy-paste production installation guide — that is `INSTALL-FA.md`. It also does not implement `infra/`; the contract here is consumed by the platform implementation and reviewed against it.

**Non-goals for v1:** Kubernetes, Swarm, multi-region active/active, database-per-tenant. HA is a roadmap profile (`docs/09-roadmap`).

---

## 2. Deployment architecture

### 2.1 Runtime topology (single host)

```text
                          Internet
                             │  80/443
                    ┌────────▼─────────┐
                    │ caddy (profile tls)│  automatic Let's Encrypt
                    │  or host nginx     │  (alternative path)
                    └────────┬─────────┘
                             │ http (docker network)
                    ┌────────▼─────────┐
                    │ web (nginx) :80   │  static SPA (fa-IR, RTL)
                    │  /      → SPA     │
                    │  /api/* → api:4000│
                    │  /health/* → api  │
                    └────────┬─────────┘
                             │ backend network
        ┌────────────────────┼───────────────────────┐
        │                    │                       │
┌───────▼──────┐    ┌────────▼────────┐    ┌─────────▼────────┐
│ api :4000     │    │ worker          │    │ (no inbound)     │
│ stateless N×  │    │ outbox/queues   │    │                  │
└───┬───┬───┬──┘    └───┬────┬────┬───┘    └──────────────────┘
    │   │   │           │    │    │
    │   │   └───────────┼────┼────┼──────► minio :9000  (S3 API)
    │   │               │    │    │            └── console 127.0.0.1:9001
    │   └───────────────┼────┼────┘
    │                   │    │
    └───────► redis :6379    └───────► postgres :5432
              (cache/queue)             db `saman`, schema `erp`
```

Middleware is **never** published on a public interface. Only the TLS terminator (`caddy` profile) or the host reverse proxy is reachable from the internet.

### 2.2 Process model

| Process | State | Replicable | Notes |
|---|---|---|---|
| `api` | stateless | yes | JWT auth, no server-side session lookup per request (`ADR-0004`); safe behind round-robin |
| `worker` | stateless (Redis/DB are the state) | yes | BullMQ queues and the outbox poller are safe with multiple replicas (`ADR-0010`) |
| `web` | stateless | yes | nginx serving static assets; upstream `api:4000` |
| `postgres` | **stateful** | no (v1) | single instance, volume `pgdata`; PITR optional profile |
| `redis` | ephemeral¹ | no | cache/queue; not a source of truth. AOF optional for queue durability |
| `minio` | stateful | no | volume `minio_data`; object versioning enabled on `saman-files` |

¹ Redis loss degrades rate limiting/caching and pauses queued jobs, but unprocessed outbox rows remain in PostgreSQL and are replayed (`ARCHITECTURE §13`).

### 2.3 Request path

1. Browser → TLS terminator (Caddy/host nginx) → `web:8080`.
2. `web` serves the SPA for non-API paths and proxies `/api/*` and `/health/*` to `api:4000`.
3. `api` authenticates (`Authorization: Bearer`, refresh cookie confined to `/api/v1/auth`), authorizes via permission keys, and runs one DB transaction per write (`ARCHITECTURE §6`).
4. Side effects required after commit go to `outbox_events`; `worker` dispatches them (channel sync, journals, SMS, exports).
5. External channel calls egress over HTTPS; raw payloads and sync state live in PostgreSQL, files/labels/exports in S3/MinIO.

---

## 3. Deployment artifacts (contract)

The repository ships (or must ship) exactly these deployment artifacts:

| Path | Purpose | Owner |
|---|---|---|
| `docker-compose.yml` | production baseline stack: postgres, redis, minio, minio-init, api, worker, web; profiles `tools`/`tls`/`backup`; healthchecks, resource limits, log rotation | Platform |
| `docker-compose.prod.yml` | production hardening overlay: `restart: always`, `pull_policy: missing`, reservations, TLS/caddy hardening (used with `--profile tls`) | Platform |
| `docker-compose.dev.yml` | local development overlay: loopback data ports, dev image targets, source bind-mounts, mock SMS | Platform |
| `.dockerignore` | lean build context; excludes secrets, node_modules, docs, runtime data | Platform |
| `Makefile` | operator entry points (`up-prod`, `migrate`, `seed`, `backup-now`, `smoke`, `validate`) | Platform |
| `.env.example` | canonical, commented env template; **single source of truth for env names** | Platform |
| `.env` (git-ignored, mode 600) | per-install values and secrets | Operator |
| `infra/docker/postgres/init/01-init.sql` | first-boot roles (migrator/app/worker/readonly/backup), schema `erp`, extensions, default privileges (psql `\getenv`) | Platform |
| `infra/docker/postgres/postgresql.conf` | PostgreSQL 16 tuning for the 8 vCPU / 16 GB profile; slow-query logging; `pg_stat_statements` preload | Platform |
| `infra/docker/minio-init.sh` | idempotent buckets/versioning/least-privilege app user for MinIO | Platform |
| `infra/nginx/Caddyfile` | Caddy TLS reverse proxy (Let's Encrypt), proxies `web:8080` | Platform |
| `infra/nginx/nginx.conf` + `saman.conf` + `proxy_params.inc` | unprivileged nginx inside the `web` image: SPA, `/api` + `/health` -> `api:4000`, CSP/security headers | Platform |
| `.github/workflows/{ci,security,release}.yml` | quality gate, security scans, GHCR release pipeline (required checks in `.github/workflows/README.md`) | Platform |
| `scripts/*.sh` + `scripts/validate-config.py` | secrets generation, health wait, smoke test, backup-now, restore drill, config validation | Platform |
| `infra/observability/*` | Prometheus scrape config + alert rules + Grafana provisioning/dashboard (external/optional) | Platform |
| `infra/backup/` | backup image/scripts: `pg_dump -Fc`, sha256, GPG AES-256, MinIO/S3 upload, retention, optional offsite mirror, restore helper | Platform |
| `infra/docker/api.Dockerfile`, `web.Dockerfile` | multi-stage, non-root (`node`/`nginx`), prod-only deps, dev targets for compose dev overlay | Platform |

**Compose invariants** (must be true of the implementation):

1. `postgres`, `redis`, `minio` have **no** public `ports:` mapping.
2. `web` publishes only `127.0.0.1:${WEB_HOST_PORT}:8080` (host-proxy mode) and `api` only `127.0.0.1:${API_HOST_PORT}:4000` *if* enabled for debugging — never `0.0.0.0`.
3. `caddy` is in profile `tls`, publishes `80:80` and `443:443`, and depends on `web`.
4. `migrate` is a one-shot service in profile `tools` using the API image and `MIGRATION_DATABASE_URL`; seeding reuses it with an overridden command: `docker compose --profile tools run --rm migrate pnpm db:seed`.
5. `backup` is in profile `backup`; disabled-profile stacks still work but are **not production-acceptable**.
6. `depends_on` uses `condition: service_healthy` for postgres/redis/minio.
7. All long-running services set `restart: unless-stopped`, `init: true`, and container log rotation is configured at the daemon level.
8. API/worker/web containers run as non-root with `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges` (see §4).
9. Migrations are **not** run on API boot in production (`ADR-0012`); the API refuses to start if the DB schema version is ahead of the image.
10. Destructive commands (`down -v`, `volume rm`, `DROP DATABASE` in scripts) are absent from all shipped scripts (CI validates this).
11. `docker-compose.prod.yml` is applied on top of the baseline for production and adds `restart: always`, `pull_policy: missing` and resource reservations; the Caddy TLS profile is enabled with `--profile tls`.
12. Image tags are pinned (no `:latest`) and base-image digests are pinned via CI/`docker buildx imagetools` once a registry is available.
13. **Crown secrets are files, not env**: compose top-level `secrets:` mounts `./secrets/{jwt_access_secret,app_encryption_key,otp_pepper,refresh_pepper,db_password,migration_db_url,redis_password,backup_encryption_passphrase}` (git-ignored, mode 0400). Services consume them via `*_FILE` env indirection (`JWT_ACCESS_SECRET_FILE`, `APP_ENCRYPTION_KEY_FILE`, `OTP_PEPPER_FILE`, `REFRESH_PEPPER_FILE`, `DB_PASSWORD_FILE`, `REDIS_PASSWORD_FILE`, `MIGRATION_DATABASE_URL_FILE`, `BACKUP_ENCRYPTION_PASSPHRASE_FILE`) and never via `env_file`. `.env` holds only non-secret config (plus local-dev fallbacks).
14. **Resource limits use top-level `cpus` / `mem_limit` / `mem_reservation`** — `deploy.resources` is ignored by Docker Compose v2 outside swarm and must not be used.
15. `minio` has **no healthcheck** (the MinIO image has no guaranteed probe binary); readiness is enforced by `minio-init` retrying `mc alias set` with backoff, and `api`/`worker` depend on `minio-init: condition: service_completed_successfully`.
16. `postgres` mounts `postgresql.conf`, `pg_hba.conf`, `pg_ident.conf` explicitly (`hba_file`/`ident_file` absolute paths) because the config file lives outside `PGDATA`; the official image's password-file mechanism supplies `POSTGRES_PASSWORD` to the init SQL.

---

## 4. Service catalogue

Sizing numbers below assume the "recommended" 8 vCPU / 16 GB profile; scale with `docs/00-overview` §2. Limits are top-level Compose keys (`cpus`/`mem_limit`/`mem_reservation`), enforced via cgroup on a single host; `deploy.*` is intentionally not used because Compose v2 ignores it outside swarm. Values are starting points — the load profile in `docs/05-testing/TESTING.md` is the authority.

| Service | Image / build | Command | Internal port | Volumes | Healthcheck | Restart | CPU / Mem limits | Exposure |
|---|---|---|---|---|---|---|---|---|
| `postgres` | `postgres:16-alpine` | `postgres -c shared_buffers=…` | `5432` | `pgdata:/var/lib/postgresql/data` | `pg_isready -U $POSTGRES_USER -d $POSTGRES_DB` | `unless-stopped` | `2.0` / `3g` | internal only |
| `redis` | `redis:7-alpine` | `redis-server --requirepass $REDIS_PASSWORD --appendonly yes --maxmemory 512mb --maxmemory-policy noeviction` | `6379` | `redisdata:/data` | `redis-cli -a $REDIS_PASSWORD ping` | `unless-stopped` | `1.0` / `768m` | internal only |
| `minio` | `minio/minio:RELEASE.2025-04-22T22-12-26Z` | `server /data --console-address :9001` | `9000` (S3), `9001` (console) | `minio_data:/data` | none — readiness enforced by `minio-init` retries; api/worker gate on its completion | `unless-stopped` | `1.0` / `1g` | console `127.0.0.1:9001` (`MINIO_CONSOLE_BIND`) |
| `minio-init` | `minio/mc:RELEASE.2025-04-16T18-13-26Z` | creates `saman-files`, `saman-backups`, versioning, app user/policy | — | — | one-shot (`Exited 0`) | `no` | `0.5` / `256m` | none |
| `api` | `saman-erp/api:$IMAGE_TAG` | `node dist/main.js` | `4000` (`APP_PORT`) | tmpfs `/tmp` | `wget -qO- http://127.0.0.1:4000/health/live` | `unless-stopped` | `2.0` / `1g` | via `web` only |
| `worker` | `saman-erp/api:$IMAGE_TAG` | `node dist/worker.js` | none | tmpfs `/tmp` | process-level (see note) | `unless-stopped` | `2.0` / `1g` | none |
| `web` | `saman-erp/web:$IMAGE_TAG` | `nginx -g 'daemon off;'` | `8080` | — | `wget -qO- http://127.0.0.1:8080/healthz` | `unless-stopped` | `0.5` / `128m` | `127.0.0.1:${WEB_HOST_PORT}` |
| `caddy` | `caddy:2-alpine` | `caddy run --config /etc/caddy/Caddyfile` | `80`, `443` | `caddy_data`, `caddy_config` | `caddy validate`/TCP check | `unless-stopped` | `0.5` / `128m` | public 80/443 |
| `migrate` | `saman-erp/api:$IMAGE_TAG` | `pnpm db:migrate` (seed = same image, command `pnpm db:seed`) | — | — | exit code 0 | `no` | tmpfs /tmp only | user `1000:1000`; reads `migration_db_url` secret (`MIGRATION_DATABASE_URL_FILE`) |
| `backup` | `saman-erp/backup:$IMAGE_TAG` | `supercronic /etc/backup/crontab` unless `once` | — | `pgbackups:/backups` | heartbeat file < 26 h (alert-driven) | `unless-stopped` | `1.0` / `512m` | none |
| `prometheus` (profile `observability`) | `prom/prometheus:v2.53.2` | default | `9090` | `prom_data` | HTTP probe (upstream image) | `unless-stopped` | `0.5` / `512m` | `127.0.0.1:9090` |
| `grafana` (profile `observability`) | `grafana/grafana:11.1.4` | default | `3000` | `grafana_data` | HTTP probe (upstream image) | `unless-stopped` | `0.5` / `256m` | `127.0.0.1:3000` (SSH tunnel) |

**Worker healthcheck note:** the worker exposes no HTTP upstream port in v1. A trivial `CMD-SHELL node -e "process.exit(0)"` only proves PID 1 is alive, so *real* liveness is operational: alert on `worker_heartbeat_age_seconds > 120` and on `outbox` lag (`RUNBOOK §3`). If the implementation adds an internal metrics listener, prefer an HTTP healthcheck there.

### 4.1 Security settings (api/worker/web)

```yaml
    init: true
    read_only: true
    user: "1000:1000"            # image USER node; explicit for review/CI
    tmpfs: ["/tmp:size=256m,mode=1777"]
    security_opt: ["no-new-privileges:true"]
    cap_drop: ["ALL"]
    secrets: [jwt_access_secret, app_encryption_key, otp_pepper, refresh_pepper, db_password, redis_password]
    environment:
      JWT_ACCESS_SECRET_FILE: /run/secrets/jwt_access_secret
      APP_ENCRYPTION_KEY_FILE: /run/secrets/app_encryption_key
```

`web` runs as uid 101 (unprivileged nginx image) with only `/tmp` writable; it mounts no source or config writable paths. `migrate` (uid 1000) and `backup` (uid 1000) are hardened with `init`/`cap_drop`/`no-new-privileges`; `backup` is `read_only` with a writable `/backups` volume and `/tmp`. PostgreSQL/Redis/MinIO keep their upstream users and need writable data volumes, so `read_only` is not applied to them.

### 4.2 Health & readiness semantics

| Endpoint | Served by | Meaning | Failure action |
|---|---|---|---|
| `GET /health/live` | api (`:4000`) | process alive | restart container |
| `GET /health/ready` | api (`:4000`) | DB + Redis + S3 usable | remove from upstream / do not deploy; alert |
| `GET /health/version` | api | app + schema version | drift check in CI/deploy |
| `GET /metrics` | api | Prometheus metrics | scrape internally only |
| `GET /healthz` | web | static nginx alive | restart container |
| `GET /api/v1/docs` | api | OpenAPI UI, **only if** `DOCS_ENABLED=true` | must be 404 in production |

`web` proxies only `/health/live` and `/health/ready` (plus `/api/*`). `/health/version` and `/metrics` stay internal.

---

## 5. Networking & exposure matrix

| Network | Members | `internal: true` | Purpose |
|---|---|---|---|
| `edge` | `caddy`, `web` | no | TLS terminator → SPA/nginx |
| `backend` | `api`, `worker`, `web`, `postgres`, `redis`, `minio`, `backup` | no (egress required for channel/SMS/offsite calls; no published ports) | app/data plane |
| `backend` (same network) | `prometheus`, `grafana` (profile `observability`) | no | scraping only; ports bound to loopback |

¹ `backend` must allow **egress** to the internet for channel APIs, Limo SMS and offsite S3. It is therefore **not** `internal: true` in the strict Docker sense; instead it has no published ports and egress is allowlisted at the host firewall/proxy if the customer requires it (`ARCHITECTURE §10` egress allowlist). The reference implementation keeps egress open (channel endpoints are dynamic) and relies on host egress filtering for regulated customers.

| Port | Host binding | Public? | Notes |
|---|---|---|---|
| `22/tcp` | all | only from admin CIDR | key-only SSH (`INSTALL-FA §13`) |
| `80/tcp` | `caddy` | yes | ACME + redirect to 443 |
| `443/tcp` | `caddy` | yes | TLS |
| `${API_HOST_PORT}` | `127.0.0.1` | **no** | debug-only mapping, disabled in production |
| `${WEB_HOST_PORT}` | `127.0.0.1` | **no** | host-nginx mode only; with Caddy it can be omitted |
| `5432`, `6379`, `9000` | none | **no** | internal only |
| `9001` | `127.0.0.1` | **no** | MinIO console via SSH tunnel |

**Docker/UFW warning:** published Docker ports bypass UFW. The binding rules above are the primary control; `DOCKER-USER` chains are defence-in-depth only.

---

## 6. Volumes & data lifecycle

| Volume | Data | Backup | Loss impact |
|---|---|---|---|
| `pgdata` | PostgreSQL cluster (`saman`/`erp`) | nightly `pg_dump -Fc` (+ optional WAL) | full data loss unless restored |
| `minio_data` | media, labels, exports, **backup objects** | offsite mirror (rclone/aws) | media loss; DB backups if not mirrored |
| `redisdata` | queue AOF | not backed up (ephemeral) | queued jobs replay from outbox; some delayed jobs may need re-enqueue |
| `caddy_data` / `caddy_config` | TLS certificates/account keys | include in config backup | cert re-issuance (rate-limited) |
| `pgbackups` | local staging of backups | offsite upload | usually safe; offsite copy is authoritative |
| `prom_data`, `grafana_data` (profile `observability`) | metrics/dashboards | optional | observability history only |

Lifecycle: partition creation/retention is handled by the `maintenance` worker queue (`ADR-0009`), not by Docker or cron in the container. Image upgrades must never touch volumes.

---

## 7. Environment matrix

**Rules**

- `.env.example` is the single source of truth for names. This table mirrors it; drift is a bug.
- Everything is 12-factor via env; no secrets in images, Compose files, or git (`ARCHITECTURE §16`).
- Zod validates env at boot; missing/invalid values must **fail fast** with a clear message (`APP_CONFIG_INVALID`).

### 7.1 Application & UI

| Variable | Required | Secret | Example / default | Purpose |
|---|---|---|---|---|
| `APP_ENV` | yes | no | `production` | drives safety defaults |
| `APP_NAME` | yes | no | `Saman ERP` | display name |
| `APP_PORT` | yes | no | `4000` | internal HTTP port |
| `APP_URL` | yes | no | `https://erp.carexy.shop` | public origin, no trailing slash |
| `API_PREFIX` | yes | no | `api` | URI prefix |
| `API_VERSION` | yes | no | `v1` | URI version |
| `APP_TIMEZONE` | yes | no | `Asia/Tehran` | business timezone |
| `APP_DEFAULT_LOCALE` | yes | no | `fa-IR` | Persian RTL UI default |
| `DOCS_ENABLED` | yes | no | `false` | OpenAPI UI exposure |
| `LOG_LEVEL` | yes | no | `info` | pino level |

### 7.2 Security & sessions

| Variable | Required | Secret | Example / default | Purpose |
|---|---|---|---|---|
| `JWT_ACCESS_SECRET` | yes | **yes** | 48-byte random | access token signing |
| `JWT_ACCESS_TTL` | yes | no | `10m` | access token lifetime |
| `JWT_REFRESH_TTL` | yes | no | `7d` | refresh token lifetime |
| `APP_ENCRYPTION_KEY` | yes | **yes (critical)** | 32-byte base64 | AES-256-GCM for stored channel credentials |
| `APP_ENCRYPTION_KEY_VERSION` | yes | no | `1` | key rotation marker |
| `OTP_PEPPER` | yes (via `OTP_PEPPER_FILE` in prod) | **yes** | random hex | OTP code hashing pepper (crown secret) |
| `REFRESH_PEPPER` | yes (via `REFRESH_PEPPER_FILE` in prod) | **yes** | random hex | refresh-token hashing pepper (crown secret) |
| `CORS_ORIGINS` | yes | no | `https://erp.carexy.shop` | exact allowed origins |
| `COOKIE_SECURE` | yes | no | `true` | refresh cookie Secure flag |
| `COOKIE_DOMAIN` | no | no | empty | empty = host-only cookie |
| `TRUST_PROXY` | yes | no | `true` | honor X-Forwarded-* (required behind proxy) |
| `SECURITY_HSTS` | yes | no | `true` | HSTS header |
| `RATE_LIMIT_ENABLED` | yes | no | `true` | global rate limiter |
| `RATE_LIMIT_AUTH_PER_MIN` | yes | no | `10` | auth attempts per IP/min |
| `RATE_LIMIT_OTP_PER_HOUR` | yes | no | `5` | OTP sends per mobile/hour |
| `RATE_LIMIT_API_PER_MIN` | yes | no | `300` | API requests per IP/min |
| `LOGIN_MAX_FAILED` | yes | no | `10` | lockout threshold |
| `LOGIN_LOCK_MINUTES` | yes | no | `15` | lockout duration |

### 7.3 Database

| Variable | Required | Secret | Example / default | Purpose |
|---|---|---|---|---|
| `DATABASE_URL` | yes | **yes** | `postgres://saman_app:***@postgres:5432/saman` | runtime role (`saman_app`, no DDL) |
| `MIGRATION_DATABASE_URL` | yes | **yes** | `postgres://saman_migrator:***@postgres:5432/saman` | DDL role for `db:migrate`/`db:seed` only |
| `DB_SSL` | no | no | `false` | TLS for external PostgreSQL |
| `DB_SSL_CA_PATH` | no | no | `/run/secrets/db-ca.pem` | CA bundle path for TLS verification |
| `DB_POOL_MAX` | yes | no | `20` | pool max per process |
| `DB_STATEMENT_TIMEOUT_MS` | yes | no | `5000` | per-query timeout (API) |
| `DB_IDLE_TIMEOUT_MS` | yes | no | `30000` | idle connection timeout |
| `DB_MIGRATION_ROLE` | yes | no | `saman_migrator` | expected DDL role name |
| `DB_SCHEMA` | yes | no | `erp` | business schema |

### 7.4 Redis

| Variable | Required | Secret | Example / default | Purpose |
|---|---|---|---|---|
| `REDIS_URL` | yes | **yes** (contains password) | `redis://:pw@redis:6379/0` | cache/queue/rate-limit |
| `REDIS_PASSWORD` | yes (production) | **yes** | random hex | applied to server and URL |
| `REDIS_PREFIX` | yes | no | `saman:` | key namespace |
| `REDIS_TLS` | no | no | `false` | managed Redis with TLS |

### 7.5 Object storage

| Variable | Required | Secret | Example / default | Purpose |
|---|---|---|---|---|
| `S3_ENDPOINT` | yes | no | `http://minio:9000` | S3/MinIO endpoint |
| `S3_REGION` | yes | no | `us-east-1` | region |
| `S3_BUCKET` | yes | no | `saman-files` | app files bucket |
| `S3_ACCESS_KEY` | yes | **yes** | `saman-app` | app user access key |
| `S3_SECRET_KEY` | yes | **yes** | random hex | app user secret |
| `S3_FORCE_PATH_STYLE` | yes | no | `true` | required by MinIO |
| `S3_PUBLIC_BASE_URL` | no | no | empty | optional public media base |
| `UPLOAD_MAX_MB` | yes | no | `20` | upload size cap |

### 7.6 SMS (Limo)

| Variable | Required | Secret | Example / default | Purpose |
|---|---|---|---|---|
| `SMS_MODE` | yes | no | `limo` (`mock` in dev) | provider selection |
| `LIMO_BASE_URL` | yes (limo) | no | `https://api.limosms.com` | provider base URL |
| `LIMO_API_KEY` | yes (limo) | **yes** | from panel | API key |
| `LIMO_SENDER` | yes (limo) | no | from panel | sender line |
| `LIMO_OTP_PATTERN_ID` | no | no | from panel | OTP pattern id |
| `OTP_TTL_SECONDS` | yes | no | `120` | OTP lifetime |
| `OTP_MAX_ATTEMPTS` | yes | no | `5` | OTP verify attempts |

### 7.7 Channels

| Variable | Required | Secret | Example / default | Purpose |
|---|---|---|---|---|
| `CAREXY_API_BASE_URL` | yes | no | `https://carexy.shop` | storefront API base |
| `CAREXY_API_KEY` | yes | **yes** | from panel | `X-API-KEY` |
| `CAREXY_WEBHOOK_SECRET` | yes | **yes** | random hex | webhook HMAC verification |
| `DIGIKALA_API_BASE_URL` | yes | no | `https://seller.digikala.com/open-api/v1` | marketplace API base |
| `DIGIKALA_CLIENT_ID` | if enabled | no | from panel | OAuth2 client id |
| `DIGIKALA_CLIENT_SECRET` | if enabled | **yes** | from panel | OAuth2 client secret |
| `DIGIKALA_WEBHOOK_SECRET` | yes | **yes** | random hex | webhook HMAC verification |
| `CHANNEL_SYNC_ENABLED` | yes | no | `true` | master switch for sync jobs |
| `CHANNEL_STOCK_DEBOUNCE_MS` | yes | no | `3000` | stock push debounce |
| `CHANNEL_HTTP_TIMEOUT_MS` | yes | no | `15000` | outbound HTTP timeout |

### 7.8 Jobs / worker

| Variable | Required | Secret | Example / default | Purpose |
|---|---|---|---|---|
| `WORKER_CONCURRENCY` | yes | no | `10` | global job concurrency |
| `OUTBOX_BATCH_SIZE` | yes | no | `100` | outbox batch size |
| `OUTBOX_POLL_INTERVAL_MS` | yes | no | `1000` | outbox poll interval |

### 7.9 Observability

| Variable | Required | Secret | Example / default | Purpose |
|---|---|---|---|---|
| `METRICS_ENABLED` | yes | no | `true` | expose `/metrics` |
| `OTEL_ENABLED` | yes | no | `false` | OpenTelemetry tracing |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | if OTel | no | internal collector URL | OTLP endpoint |
| `SENTRY_DSN` | no | **yes (URL secret)** | empty | error reporting |

### 7.10 Backups

| Variable | Required | Secret | Example / default | Purpose |
|---|---|---|---|---|
| `BACKUP_ENABLED` | yes | no | `true` | enable scheduled backups |
| `BACKUP_CRON` | yes | no | `0 2 * * *` | schedule (container TZ) |
| `BACKUP_KEEP_DAYS` | yes | no | `30` | local/S3 retention |
| `BACKUP_S3_PREFIX` | yes | no | `backups/postgres` | object key prefix |
| `BACKUP_ENCRYPTION_PASSPHRASE` | yes (prod) | **yes (critical)** | random base64 | GPG AES-256 symmetric encryption |
| `BACKUP_MIRROR_S3_ENDPOINT` | optional | no | empty | offsite S3 endpoint for the mirror copy (different provider/account) |
| `BACKUP_MIRROR_S3_BUCKET` | optional | no | empty | offsite bucket |
| `BACKUP_MIRROR_S3_ACCESS_KEY` | optional | **yes** | empty | offsite access key |
| `BACKUP_MIRROR_S3_SECRET_KEY` | optional | **yes** | empty | offsite secret |

> The `BACKUP_MIRROR_S3_*` names are the implemented contract in `infra/backup/backup.sh`; they are **not yet present in `.env.example`** (pending a canonical template addition by the Lead). Until then, set them only on the server and document them in the operations log. |

### 7.11 Bootstrap (first run only)

| Variable | Required | Secret | Example / default | Purpose |
|---|---|---|---|---|
| `BOOTSTRAP_ADMIN_MOBILE` | first seed only | no | `09121234567` | first admin mobile |
| `BOOTSTRAP_ADMIN_PASSWORD` | first seed only | **yes** | random, ≥12 chars | first admin password |
| `BOOTSTRAP_ORG_NAME` | first seed only | no | `کرکسی شاپ` | initial organization name |

`pnpm db:seed` is idempotent and creates the first admin **only when `users` is empty**; clear the values after first run. `pnpm --filter @saman/api db:create-admin` remains an optional interactive CLI.

### 7.12 Compose-only variables

| Variable | Required | Secret | Example / default | Purpose |
|---|---|---|---|---|
| `POSTGRES_USER` | yes | no | `saman` | container admin role |
| `POSTGRES_PASSWORD` | yes | **yes** | random hex | admin password; seeds initial role passwords |
| `POSTGRES_DB` | yes | no | `saman` | database name |
| `POSTGRES_PORT` | yes | no | `5432` | internal DB port |
| `REDIS_PORT` | yes | no | `6379` | internal Redis port |
| `MINIO_ROOT_USER` | yes | no | `saman` | MinIO admin user |
| `MINIO_ROOT_PASSWORD` | yes | **yes** | random hex | MinIO admin password |
| `API_HOST_PORT` | yes | no | `4000` | optional loopback API mapping |
| `WEB_BIND_ADDR` | yes | no | `127.0.0.1` | bind address for web; `0.0.0.0` ONLY behind a host proxy on a private interface |
| `WEB_HOST_PORT` | yes | no | `8080` | loopback web mapping (host-proxy mode) |
| `MINIO_CONSOLE_BIND` | yes | no | `127.0.0.1` | MinIO console bind address (never public) |
| `GRAFANA_ADMIN_PASSWORD` | profile `observability` | **yes** | random base64 | Grafana admin password |
| `DOMAIN` | yes | no | `erp.carexy.shop` | Caddy site address |
| `ACME_EMAIL` | yes (tls) | no | `admin@carexy.shop` | Let's Encrypt contact |
| `IMAGE_TAG` | yes | no | `1.0.0` | image tag / rollback pin |

---

## 8. Secrets flow

### 8.1 Generation

```bash
openssl rand -hex 32      # DB / Redis / MinIO / webhook secrets (URL-safe)
openssl rand -base64 48   # JWT secrets
openssl rand -base64 32   # APP_ENCRYPTION_KEY (AES-256 key)
openssl rand -base64 32   # BACKUP_ENCRYPTION_PASSPHRASE
```

### 8.2 Distribution

- **Production:** crown secrets live only in `./secrets/*` as files (`jwt_access_secret`, `app_encryption_key`, `otp_pepper`, `refresh_pepper`, `db_password`, `migration_db_url`, `redis_password`, `backup_encryption_passphrase`). `scripts/gen-secrets.sh` creates them with `secrets/` mode `700`; each file should be `0400` and owned so the container uid can read it: uid/gid `1000:1000` (api/worker/migrate) and `1000:1000` for the backup passphrase (backup uid). `docker compose` binds them at `/run/secrets/<name>` and services read them via `*_FILE` env vars — they never appear in `docker inspect`, Compose environment, images or git.
- `.env` on the host only, `chmod 600`, owner = service user; in production mode `gen-secrets.sh` blanks the crown values there. Never baked into images, never in git.
- **Local dev:** `gen-secrets.sh --dev` keeps secrets in `.env` for convenience; the compose secrets files are still generated and mounted, so the same contract is exercised.
- `minio-init` / MinIO admin credentials (`MINIO_ROOT_USER/PASSWORD`) and S3 keys remain environment variables in `.env` for v1 (internal-only service, no host exposure); migration to `*_FILE` for these is a documented follow-up.
- **Known interface gap (backend):** the runtime `DATABASE_URL` and `REDIS_URL` still carry the app DB password / Redis password from `.env` (`MIGRATION_DATABASE_URL` is already blanked in production and read from `MIGRATION_DATABASE_URL_FILE`). The approved direction is `*_FILE` indirection (`DB_PASSWORD_FILE`/`REDIS_PASSWORD_FILE` are already mounted); backend must define how it assembles those URLs from the `*_FILE` secrets + non-secret host/db/user env before `.env` can be freed of those passwords.
- Remote/CI vault option: `environment:`-based secrets or a vault agent that renders the same files is compatible; the `_FILE` contract stays unchanged.
- Secret values are never logged: pino redaction for `authorization`, `cookie`, `password`, `apiKey`, `secret`, `token`.

### 8.3 Rotation impact matrix

| Secret | Rotation procedure | Impact / caveat |
|---|---|---|
| `JWT_ACCESS_SECRET` | set new value, restart api/worker | all access tokens invalid; users transparently refresh |
| `APP_ENCRYPTION_KEY` (+version) | **re-encrypt channel credentials under new key before switching**; dual-key support if implemented | wrong rotation loses channel credentials; see `RUNBOOK §8` |
| `POSTGRES_PASSWORD` / role passwords | `ALTER ROLE` then update URL, rolling restart | transient auth failures if order is wrong |
| `REDIS_PASSWORD` | update server + `REDIS_URL`, roll restart | queue pauses briefly |
| `S3_ACCESS_KEY/SECRET_KEY` | create new MinIO user, switch, revoke old | media read/write errors during mismatch |
| `LIMO_API_KEY`, channel keys | update in `.env` + restart worker/api | channel sync fails until updated |
| `BACKUP_ENCRYPTION_PASSPHRASE` | keep old passphrase for old backups | old backups unreadable if lost |

### 8.4 Encryption at rest

- Channel credentials in DB: AES-256-GCM with `APP_ENCRYPTION_KEY` (`ARCHITECTURE §10`).
- Backups: GPG symmetric AES-256 with `BACKUP_ENCRYPTION_PASSPHRASE`; passphrase stored offline.
- Host disk encryption (LUKS) recommended for regulated customers; documented in the security checklist.

---

## 9. Database topology & role model

### 9.1 Supported topologies

| Option | When | Connection | Backup owner |
|---|---|---|---|
| **A. PostgreSQL in Compose** (default) | most customers, one host | `DATABASE_URL`/`MIGRATION_DATABASE_URL` to `postgres:5432`, db `saman` | backup sidecar |
| **B. External PostgreSQL 16** | customer DB server, managed RDS/Cloud SQL/Arvan | host:port, TLS (`DB_SSL=true`, CA path), db `saman` | customer DBA + our `pg_dump` |

The app is identical in both: only URLs/TLS change. Compose never publishes 5432; option B is expected to be reachable over a private network only.

### 9.2 Role model (both topologies)

| Role | Login | Privileges | Used by |
|---|---|---|---|
| `POSTGRES_USER` (e.g. `saman`) | yes | container superuser (option A only) | init, emergency admin |
| `saman_migrator` | yes | owns schema `erp`, `CREATE` on database, runs DDL | `db:migrate`, `db:seed` via `MIGRATION_DATABASE_URL` |
| `saman_app` | yes | DML only on `erp.*` via default privileges; no DDL | api, worker via `DATABASE_URL` |
| `saman_worker` | yes | DML only, `statement_timeout=30m` for long batch jobs (reserved; the compose worker currently connects as `saman_app`) | batch/ops role (future) |
| `saman_readonly` | yes | `SELECT` only, for reporting | BI/report accounts |
| `saman_backup` | yes | `pg_read_all_data` | `pg_dump` |

`ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp` grants `saman_app`/`saman_worker` DML and `saman_readonly` SELECT on **future** tables; this is created before the first migration so no post-migration grant step is required.

Statement timeouts: DB role `saman_app` gets `30s` as a safety net; the API enforces `DB_STATEMENT_TIMEOUT_MS=5000` in code; the worker uses longer per-session timeouts for batch jobs (`ARCHITECTURE §6`).

### 9.3 Connection budget

`Σ(DB_POOL_MAX × process replicas) + admin/migration headroom < max_connections`

Example: `api` ×2 (40) + `worker` (20) + migrate/admin (10) + headroom = 70–100 vs `max_connections=150`. For >4 API replicas or >250 connections, add **PgBouncer** in transaction mode; then use `prepare: false` (postgres.js) and avoid session-level features. The compose scaling profile documents PgBouncer as optional (`ARCHITECTURE §11.8`).

### 9.4 First-boot init (option A)

`infra/docker/postgres/init/01-init.sh` runs only on an **empty** `pgdata` volume: creates roles, schema `erp`, extensions (`pgcrypto`, `pg_trgm`, `btree_gin`), default privileges, and initial role passwords derived from `POSTGRES_PASSWORD` (rotate to distinct secrets post-install). If the volume exists, init is skipped — role setup must be applied manually (`INSTALL-FA §8.2`).

---

## 10. Release, upgrade & rollback

### 10.1 Release steps

```bash
# 1. backup first (always)
docker compose --profile backup run --rm backup once

# 2. fetch pinned tag (IMAGE_TAG), build/pull
git checkout v1.1.0
docker compose pull && docker compose build

# 3. expand-only DB migration under the DDL role
docker compose --profile tools run --rm migrate

# 4. idempotent seed (permissions, roles, CoA deltas)
docker compose --profile tools run --rm migrate pnpm db:seed

# 5. restart stateless services
docker compose up -d --no-deps api worker web

# 6. verify
docker compose exec -T api wget -qO- http://127.0.0.1:4000/health/ready
curl -fsS https://erp.carexy.shop/health/ready
```

**Migration policy (expand/contract):** every migration must be backward compatible with the previous release (add column nullable/defaulted, backfill, switch reads, drop later). This is what makes rollback without restore possible.

### 10.2 "Zero-downtime-ish" upgrade

True zero downtime requires >1 API replica and upstream health-based draining. On a single host, the supported procedure minimizes the blip:

1. Keep `web` up; it will return `502` for in-flight requests during the API switch (typically 1–5 s).
2. With two API replicas: `docker compose up -d --no-deps --scale api=2 api` → wait for both healthy → `docker compose up -d --no-deps --scale api=1 api` (old container drained) — but note Compose `--scale` conflicts with a fixed `container_name`; the implementation must not set static container names if scaling is desired.
3. Non-breaking migrations mean old and new API versions can run simultaneously during the switch.
4. Deploy at low-traffic windows for v1; document the actual blip measured during the release rehearsal.

### 10.3 Rollback

| Scenario | Procedure |
|---|---|
| app bug, compatible schema | `git checkout v1.0.0`, set `IMAGE_TAG=1.0.0`, `docker compose up -d --no-deps api worker web` |
| bad migration (incompatible) | stop api/worker/web, restore pre-upgrade dump into a fresh DB (`BACKUP-RESTORE §6.3`), redeploy previous tag, run `migrate` (expect no-op) |
| bad config | revert `.env` change, `docker compose up -d` (config-only, no image change) |
| bad web asset | rebuild `web` from previous tag only |

**Forbidden:** `docker compose down -v`, `docker volume rm`, in-place `DROP DATABASE` scripts.

---

## 11. Scaling profile (no code changes)

| Need | Action |
|---|---|
| More HTTP throughput | `--scale api=N`; raise `DB_POOL_MAX` budget; add PgBouncer beyond 4 replicas |
| More batch throughput | `--scale worker=N`; BullMQ shares queues via Redis; ensure idempotent handlers |
| DB read scale | `saman_readonly` + reporting read models; replica documented as roadmap |
| Externalize data plane | managed PostgreSQL, managed Redis, external S3: change URLs/TLS only |
| HA | roadmap: two hosts + managed DB/PITR + load balancer; single-host v1 is a SPOF (`ADR-0012`) |
| Observability | profile `observability` (Prometheus/Grafana) or external collectors |

Scaling limits to watch: PostgreSQL connections, Redis memory (`noeviction` for queue correctness), `pgdata` IOPS, and outbox/queue lag (`RUNBOOK §3`).

---

## 12. Backup & disaster recovery (summary)

Full detail: [`BACKUP-RESTORE.md`](../07-operations/BACKUP-RESTORE.md).

- **Default:** nightly `pg_dump -Fc` (02:00), sha256 manifest, GPG AES-256 encryption, upload to `saman-backups` bucket under `BACKUP_S3_PREFIX`, retention `BACKUP_KEEP_DAYS`; offsite mirror of the bucket.
- **RPO:** 24 h with default profile; ≤15 min only with the optional **pgBackRest PITR/WAL** profile (`ARCHITECTURE §14` target requires it — state this to the customer).
- **RTO:** ≤1 h target; measured by the quarterly restore drill.
- **Also backed up:** `saman-files` bucket (media/labels), `.env` + Compose + Caddy data (encrypted config archive), with `APP_ENCRYPTION_KEY` and backup passphrase stored offline.
- **Restore path:** fresh PostgreSQL container/DB → decrypt + verify → `pg_restore` (skipping extension TOC entries already installed) → `pnpm db:migrate` head check → start API → smoke test. Exact commands in `BACKUP-RESTORE §6`.
- **Redis:** not backed up; queued work replays from the outbox.

---

## 13. Observability hooks

- **Logs:** pino JSON to stdout; requestId/orgId/userId/route/latency; no bodies/PII; Docker json-file rotation (20 MB × 5) at daemon level.
- **Metrics:** `/metrics` (Prometheus) on api: HTTP histogram, DB pool, queue depth/age, outbox lag, channel failure rate, cache hit ratio. Internal-only scrape.
- **Tracing:** OTel hooks behind `OTEL_ENABLED`, W3C traceparent propagated to channel calls.
- **Health:** see §4.2.
- **Alerts:** outbox lag > 60 s, queue failed > 10, 5xx > 1 %, DB connections > 80 %, disk < 15 %, backup age > 26 h (`ARCHITECTURE §12`, thresholds in `RUNBOOK §3`).

---

## 14. Multi-environment guidance

| Env | Composition | Data | Key settings |
|---|---|---|---|
| `development` | compose infra only (postgres/redis/minio) + `pnpm dev` | seed/mock | `SMS_MODE=mock`, `DOCS_ENABLED=true`, `COOKIE_SECURE=false`, weak local secrets (never reused in prod) |
| `test` (CI) | ephemeral PostgreSQL/Redis service containers or Testcontainers | fixtures | mock channels, migrations applied from scratch |
| `staging` | same compose file on a staging host/domain | anonymized copy of prod | same topology, `SMS_MODE=mock`, `CHANNEL_SYNC_ENABLED=false` or sandbox creds, `DOCS_ENABLED=false` |
| `production` | this document | real | all safety defaults on; PITR recommended |

Rules:

- One `.env` per environment; never copy production secrets to staging.
- `APP_URL`/`CORS_ORIGINS`/`DOMAIN` are per-environment; a mismatched `APP_URL` breaks cookies, links and webhooks.
- `REDIS_PREFIX` separates environments sharing a Redis (staging only; production uses its own Redis).
- Promotion flow: CI build → image tag → staging deploy + smoke → production deploy at low traffic; migrations run first on staging against a prod-like snapshot.
- Staging data must be anonymized (customers/phones) before use; never restore prod backups into staging unredacted.

---

## 15. Sizing & resource rationale

| Component | Minimum (4 vCPU / 8 GB) | Recommended (8 vCPU / 16 GB) | Rationale |
|---|---|---|---|
| `postgres` | 2 CPU / 2 GB, `shared_buffers=1GB` | 2–4 CPU / 4–6 GB, `shared_buffers=4GB` | hot balance rows + ledger inserts; IOPS-bound |
| `redis` | 0.5 CPU / 512 MB | 1 CPU / 768 MB–1 GB | queue + cache + rate limits; `noeviction` |
| `minio` | 0.5 CPU / 512 MB | 1 CPU / 1 GB | media/labels; storage-bound |
| `api` | 1 CPU / 512 MB | 2 CPU / 1 GB × replicas | NestJS/Fastify, p95 < 200 ms read |
| `worker` | 1 CPU / 512 MB | 2 CPU / 1 GB × replicas | outbox + sync + reports |
| `web` | 0.25 CPU / 64 MB | 0.5 CPU / 128 MB | static + proxy |
| host disk | 120 GB NVMe | 250–500 GB NVMe | DB growth + WAL + backup staging (see `INSTALL-FA §2.2`) |

Host-level: 4–8 GB swap, `vm.swappiness=10`, Docker log rotation, journald capped — all in `INSTALL-FA §3`.

---

## 16. Open items & verification plan

| # | Item | Owner | Status |
|---|---|---|---|
| 1 | Implement `docker-compose.yml` + dev/prod overlays, `infra/*`, `scripts/*`, CI workflows, Makefile per this contract | Platform | **done (build phase); Lead review pending** |
| 2 | `docker compose config -q` semantic validation | CI job `compose-config` | **pending first CI run** (authoring env has no Docker; local validation is YAML/contract-only via `scripts/validate-config.py`) |
| 3 | First clean-host install using `INSTALL-FA.md` end-to-end | Platform/SRE | **pending** |
| 4 | Backup → fresh-container restore drill with RTO measurement | SRE | **script ready (`scripts/restore-drill.sh`); first real drill pending** |
| 5 | Decide PITR profile scope for customers requiring RPO ≤ 15 min | Product + Platform | **open question** |
| 6 | Backup target: sidecar uploads to MinIO `saman-backups` (created by `minio-init`) and optionally mirrors to offsite via `BACKUP_MIRROR_S3_*` (implemented in `infra/backup/backup.sh`) | Platform | **done** |
| 7 | `web` healthcheck path `/healthz` | Platform | **done** (`infra/nginx/saman.conf` + Dockerfile HEALTHCHECK + compose healthcheck) |
| 8 | Staging environment provisioning (domain, host, anonymized data) | Product/Platform | **document-only for v1; no dependency** |
| 9 | Backend must deliver `pnpm-lock.yaml` + workspace `package.json` manifests and `apps/api/dist/{main.js,worker.js}` before Docker image builds can succeed | Backend team | **blocking for image build / CI docker jobs** |
| 10 | Pin base-image digests (currently pinned by tag; digest pinning needs registry access) | Platform | **pending** |
| 11 | Backend implements *_FILE indirection for JWT_ACCESS_SECRET, APP_ENCRYPTION_KEY, OTP_PEPPER, REFRESH_PEPPER, DB_PASSWORD, REDIS_PASSWORD, MIGRATION_DATABASE_URL, BACKUP_ENCRYPTION_PASSPHRASE | Backend | **required before production-secrets mode** |
| 12 | .env.example additions: WEB_BIND_ADDR, OTP_PEPPER, REFRESH_PEPPER, GRAFANA_ADMIN_PASSWORD, BACKUP_MIRROR_S3_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY | Platform (Lead) | **pending (exact keys reported)** |

**Honesty statement:** this document and `INSTALL-FA.md` are specification-by-review. Docker images, Compose wiring and backup scripts must be validated on a real Linux host before any customer handover; the sign-off table in `INSTALL-FA §18.2` is the evidence record.

---

## Appendix A — Compose skeleton (illustrative, not authoritative)

The platform implementation may differ in details but must satisfy §3 invariants. This sketch shows the intended shape:

```yaml
name: saman-erp
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped
    networks: [backend]

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--requirepass", "${REDIS_PASSWORD}", "--appendonly", "yes", "--maxmemory", "512mb", "--maxmemory-policy", "noeviction"]
    volumes: [redisdata:/data]
    healthcheck:
      test: ["CMD-SHELL", "redis-cli -a $${REDIS_PASSWORD} ping | grep PONG"]
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped
    networks: [backend]

  minio:
    image: minio/minio:RELEASE.2025-04-22T22-12-26Z
    command: ["server", "/data", "--console-address", ":9001"]
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    volumes: [minio_data:/data]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped
    networks: [backend]

  api:
    build: { context: ., dockerfile: infra/docker/api.Dockerfile }
    image: saman-erp/api:${IMAGE_TAG}
    env_file: [.env]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
      minio: { condition: service_healthy }
    read_only: true
    tmpfs: ["/tmp:size=256m,mode=1777"]
    security_opt: ["no-new-privileges:true"]
    cap_drop: ["ALL"]
    init: true
    restart: unless-stopped
    networks: [backend, edge]
    # no public port; debugging only: ports: ["127.0.0.1:${API_HOST_PORT}:4000"]

  worker:
    image: saman-erp/api:${IMAGE_TAG}
    command: ["node", "dist/worker.js"]
    env_file: [.env]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    read_only: true
    tmpfs: ["/tmp:size=256m,mode=1777"]
    security_opt: ["no-new-privileges:true"]
    cap_drop: ["ALL"]
    init: true
    restart: unless-stopped
    networks: [backend]

  web:
    build: { context: ., dockerfile: infra/docker/web.Dockerfile }
    image: saman-erp/web:${IMAGE_TAG}
    depends_on: [api]
    ports: ["127.0.0.1:${WEB_HOST_PORT}:8080"]
    read_only: true
    tmpfs: ["/var/cache/nginx", "/var/run"]
    security_opt: ["no-new-privileges:true"]
    cap_drop: ["ALL"]
    restart: unless-stopped
    networks: [edge]

  caddy:
    image: caddy:2-alpine
    profiles: ["tls"]
    depends_on: [web]
    ports: ["80:80", "443:443"]
    environment:
      DOMAIN: ${DOMAIN}
      ACME_EMAIL: ${ACME_EMAIL}
    volumes:
      - ./infra/nginx/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    restart: unless-stopped
    networks: [edge]

  migrate:
    image: saman-erp/api:${IMAGE_TAG}
    profiles: ["tools"]
    command: ["pnpm", "db:migrate"]
    env_file: [.env]
    restart: "no"
    networks: [backend]


  backup:
    build: { context: ., dockerfile: infra/backup/Dockerfile }
    image: saman-erp/backup:${IMAGE_TAG}
    profiles: ["backup"]
    env_file: [.env]
    volumes: [pgbackups:/backups]
    depends_on:
      postgres: { condition: service_healthy }
    restart: unless-stopped
    networks: [backend]

volumes:
  pgdata: {}
  redisdata: {}
  minio_data: {}
  caddy_data: {}
  caddy_config: {}
  pgbackups: {}

networks:
  edge: {}
  backend: {}
```

Notes on the sketch:

- `env_file: [.env]` passes both compose-interpolated and app vars; the implementation must not leak admin-only vars into app containers where avoidable.
- The `migrate` service uses `MIGRATION_DATABASE_URL` from `.env`; the API/worker use `DATABASE_URL`. Seed is the same one-shot service with the command overridden to `pnpm db:seed`.
- `minio-init` (omitted here for brevity) creates `saman-files` and `saman-backups` and the `saman-app` user/policy.
- `pgbackrest` PITR profile (optional) replaces `postgres` with a custom image and adds WAL archive config — documented separately in `BACKUP-RESTORE §4`.

**End of document — v1.0**
