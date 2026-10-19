# CI/CD workflows (Saman ERP)

## Workflows

| File | Trigger | Purpose |
|---|---|---|
| `ci.yml` | push to `main`/`develop`, PR, manual | quality gate, integration tests, docker build matrix, compose semantic validation |
| `security.yml` | push, PR, weekly schedule | gitleaks secret scan, `pnpm audit` (high+), Trivy fs/config scan, dependency review on PRs |
| `release.yml` | tag `v*.*.*`, manual | build & push `api`/`web`/`backup` images to GHCR (amd64+arm64) and create a GitHub release with deployment assets |

## Required status checks (branch protection)

Configure these as **required** for merging to `main` and `develop`:

- `quality`
- `integration`
- `docker (api)`
- `docker (web)`
- `docker (backup)`
- `compose-config`
- `gitleaks`
- `dependency-audit`
- `trivy`
- `dependency-review` (PR-only)

## What each gate actually does

- **quality** — `pnpm install --frozen-lockfile`, `lint`, `typecheck`, unit tests with coverage, `build`; uploads `dist/` and `coverage/` artifacts. The lockfile must be committed; CI is intentionally frozen.
- **integration** — ephemeral PostgreSQL 16 + Redis 7 service containers, then `db:migrate`, `db:seed`, `test:int`. CI uses superuser DB URLs against the ephemeral services only.
- **docker** — build matrix for `api` (prod target), `web` (prod target), `backup`; layers cached with `type=gha`. Builds are not pushed on PRs.
- **compose-config** — real Docker engine semantic validation (`docker compose config -q`) for base, base+prod and base+dev overlays, plus `python3 scripts/validate-config.py` (install-free YAML/JSON checks) and an uploaded rendered compose file. This catches env interpolation and profile errors that no local YAML parser can.
- **security** — runs independently; `pnpm audit` fails on high/critical advisories, Trivy fails on CRITICAL/HIGH findings (unfixed ignored), gitleaks blocks leaked secrets.

## Local equivalents

```bash
make validate            # YAML/JSON + compose contract checks (install-free)
make ci                  # lint + typecheck + unit + build (requires pnpm install)
make compose-config      # (only on a host with Docker) docker compose config -q
make up && make smoke    # runtime validation on a Docker host
```

> **Honesty note:** the environment where these workflows were authored had **no Docker daemon**, so `docker compose config` / image builds could not be executed locally. `scripts/validate-config.py` parsed all YAML/JSON (including the compose files) successfully; pipeline stages above are validated by review and run for the first time in GitHub Actions.

## Secrets

- `GITHUB_TOKEN` (automatic) — used by gitleaks, dependency review, GHCR push.
- No deployment secrets live in GitHub; the customer `.env` is generated on the server (`scripts/gen-secrets.sh`) and never committed.
- Never add production credentials as repository secrets for CI; integration tests use ephemeral service containers only.
