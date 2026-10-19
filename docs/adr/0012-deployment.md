# ADR-0012 — Deployment topology & TLS

**Status:** Accepted · **Date:** 1405-07-27

## Context

Requirement: "deploy the whole project and all prerequisites with Docker on any server". No Docker was available in the build environment, so the topology must be boring and standard.

## Decision

- **Single `docker-compose.yml`** with: `postgres:16-alpine`, `redis:7-alpine`, `minio`, `api`, `worker`, `web` (nginx), optional `backup` sidecar. Named volumes for data; healthchecks with dependencies (`service_healthy`).
- **TLS**: two supported paths documented — (a) built-in **Caddy** profile as reverse proxy with automatic Let's Encrypt, (b) existing reverse proxy/host nginx with provided config. App containers never expose `postgres`/`redis` ports publicly by default.
- **Images**: multi-stage, non-root user, `node:22-alpine`, pnpm via corepack, prod-only deps in final stage, `HEALTHCHECK`, read-only root filesystem where possible, explicit `init: true`.
- **Config**: single `.env` (mode 600) with Zod-validated keys; `docker compose --env-file`. No secrets baked into images.
- **Migrations** run as an explicit release step (`docker compose run --rm api pnpm db:migrate`), not automatically on boot (except dev), so rollouts are controlled; the API refuses to start if `DB_SCHEMA_VERSION` is ahead.
- **Scaling profile** documented: replicate `api`/`worker`, add PgBouncer, external managed PostgreSQL + Redis + S3; no code changes.
- **Backups**: `pg_dump -Fc` cron container → MinIO/S3 + optional `pgBackRest` profile for WAL/PITR.

## Revision — 2026-10-19 (R1 review H-11 + D-5)

1. **Secrets are not delivered via `env_file` in production.** Compose `secrets:` (root-owned `0400` files, mounted `/run/secrets/*`) carry JWT/encryption keys, DB and Redis passwords; the app supports `*_FILE` env indirection. Documented explicitly: docker socket/sudo access is equivalent to root — the deploy account does not get broad docker privileges.
2. **Secure supply chain is part of deployment**: pinned base image digests, non-root, read-only rootfs, `no-new-privileges`, dropped capabilities, CI gates (gitleaks, audit, semgrep, Trivy, CodeQL), signed release artifacts, protected `main`.
3. **RPO honesty**: default is nightly dumps (RPO ≤ 24 h); the ≤ 15 min RPO claim only holds when the pgBackRest/WAL PITR profile is enabled. Documented in INSTALL-FA and BACKUP-RESTORE.


## Consequences

- One-command install, but single-host is a SPOF; HA profile documented as a roadmap item.
- Compose files are versioned and reviewed; destructive commands (`down -v`) are never in scripts.

## Alternatives rejected

- Kubernetes — overkill for one server and a small team.
- Nomad/Swarm — no benefit over compose here.
