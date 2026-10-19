#!/usr/bin/env bash
# =============================================================================
# Saman ERP — backup RESTORE DRILL (safe, non-destructive)
# -----------------------------------------------------------------------------
# Restores a dump into a throwaway PostgreSQL container, runs migrations to the
# head, checks basic invariants and (optionally) boots a temporary API against
# it, then destroys everything. PRODUCTION IS NEVER TOUCHED.
#
# Usage:
#   ./scripts/restore-drill.sh --dump /path/to/saman-erp-YYYYMMDDTHHMMSSZ.dump.gpg --yes
#   ./scripts/restore-drill.sh --dump dump.dump --yes --no-smoke
#
# Requirements (host): docker + docker compose v2, a built stack (images
# saman-erp/api:$IMAGE_TAG and saman-erp/backup:$IMAGE_TAG), and a running
# `saman-erp_backend` network (start the stack once first).
# Env is read from .env via grep (never sourced — values like BACKUP_CRON
# contain spaces and are not shell-safe).
#
# Design-by-review only: Docker was not available in the build environment;
# the first real drill is the acceptance test (docs/07-operations/BACKUP-RESTORE.md §9).
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DUMP=""
ASSUME_YES=0
DO_SMOKE=1
KEEP=0
DRILL_PG_PORT="${DRILL_PG_PORT:-55432}"
DRILL_API_PORT="${DRILL_API_PORT:-14000}"
SCRATCH="saman-restore-drill-$$"
TMPAPI="saman-restore-drill-api-$$"

usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dump)     DUMP="${2:?}"; shift 2 ;;
    --yes)      ASSUME_YES=1; shift ;;
    --no-smoke) DO_SMOKE=0; shift ;;
    --keep)     KEEP=1; shift ;;
    -h|--help)  usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

fail() { printf '[restore-drill] ERROR: %s\n' "$*" >&2; exit 1; }
log()  { printf '[restore-drill] %s\n' "$*"; }

env_get() {
  local key="$1" default="${2:-}" value=""
  if [[ -f .env ]]; then
    value="$(grep -E "^${key}=" .env | head -1 | cut -d= -f2- || true)"
  fi
  printf '%s' "${value:-$default}"
}

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 is required"
[[ -n "$DUMP" ]] || fail "--dump is required"
[[ -f "$DUMP" ]] || fail "dump file not found: $DUMP"
[[ -f .env ]] || fail ".env not found — run scripts/gen-secrets.sh first"
[[ "$ASSUME_YES" -eq 1 ]] || fail "refusing to run without --yes (creates a scratch container; production is never touched)"

PG_PW="$(env_get POSTGRES_PASSWORD)"
PG_DB="$(env_get POSTGRES_DB saman)"
REDIS_PW="$(env_get REDIS_PASSWORD)"
BACKUP_PASS="$(env_get BACKUP_ENCRYPTION_PASSPHRASE)"
# Production keeps crown secrets only under ./secrets (see scripts/gen-secrets.sh).
if [[ -z "$BACKUP_PASS" && -f "${ROOT}/secrets/backup_encryption_passphrase" ]]; then
  BACKUP_PASS="$(cat "${ROOT}/secrets/backup_encryption_passphrase")"
fi
if [[ -z "$PG_PW" && -f "${ROOT}/secrets/db_password" ]]; then
  PG_PW="$(cat "${ROOT}/secrets/db_password")"
fi
TAG="$(env_get IMAGE_TAG 1.0.0)"
[[ -n "$PG_PW" ]] || fail "POSTGRES_PASSWORD is empty in .env"
IMAGE_API="saman-erp/api:${TAG}"
IMAGE_BACKUP="saman-erp/backup:${TAG}"

# --- resolve compose backend network ---------------------------------------
NETWORK="$(docker network ls --format '{{.Name}}' | grep -E '(^|_)backend$' | head -1 || true)"
[[ -n "$NETWORK" ]] || fail "compose backend network not found — start the stack once (docker compose up -d postgres redis minio) or check COMPOSE_PROJECT_NAME"

docker image inspect "$IMAGE_API"    >/dev/null 2>&1 || fail "image $IMAGE_API not found — run: docker compose build"
docker image inspect "$IMAGE_BACKUP" >/dev/null 2>&1 || fail "image $IMAGE_BACKUP not found — run: docker compose --profile backup build"

cleanup() {
  if [[ "$KEEP" -eq 0 ]]; then
    docker rm -f "$TMPAPI" >/dev/null 2>&1 || true
    docker rm -f "$SCRATCH" >/dev/null 2>&1 || true
    log "scratch containers removed"
  else
    log "KEEP requested: scratch DB container is $SCRATCH (port ${DRILL_PG_PORT}); remove manually when done"
  fi
}
trap cleanup EXIT INT TERM

START_TS="$(date +%s)"
SAFE_DUMP_NAME="$(basename "$DUMP")"
log "target scratch DB: ${SCRATCH}:${DRILL_PG_PORT}/${PG_DB} — production is not touched"

# --- 1) scratch PostgreSQL -------------------------------------------------
log "starting scratch PostgreSQL 16 container"
docker run -d --name "$SCRATCH" \
  --network "$NETWORK" \
  -e POSTGRES_PASSWORD="$PG_PW" \
  -e POSTGRES_DB="$PG_DB" \
  -e TZ=Asia/Tehran \
  -p "127.0.0.1:${DRILL_PG_PORT}:5432" \
  postgres:16-alpine >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$SCRATCH" pg_isready -U postgres -d "$PG_DB" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker exec "$SCRATCH" pg_isready -U postgres -d "$PG_DB" >/dev/null 2>&1 \
  || fail "scratch PostgreSQL did not become ready"

# --- 2) apply the documented init contract (roles/schema/extensions) -------
log "applying infra/docker/postgres/init/01-init.sql (roles/schema/default privileges)"
docker exec -i -e POSTGRES_PASSWORD="$PG_PW" -e POSTGRES_DB="$PG_DB" \
  "$SCRATCH" psql -U postgres -d "$PG_DB" -v ON_ERROR_STOP=1 -f - \
  < "$ROOT/infra/docker/postgres/init/01-init.sql" >/dev/null

# --- 3) restore the dump ---------------------------------------------------
log "restoring dump via ${IMAGE_BACKUP} (sha256 + gpg + TOC filtering inside)"
DUMP_DIR="$(cd "$(dirname "$DUMP")" && pwd)"
RESTORE_ARGS=(
  --rm --network "$NETWORK"
  -v "${DUMP_DIR}:/dump:ro"
  -e GNUPGHOME=/tmp/gnupg
  --entrypoint /usr/local/bin/restore.sh
  "$IMAGE_BACKUP"
  --file "/dump/${SAFE_DUMP_NAME}"
  --database-url "postgres://saman_migrator:${PG_PW}@${SCRATCH}:5432/${PG_DB}"
  --single-transaction
)
if [[ -n "$BACKUP_PASS" ]]; then
  RESTORE_ARGS=(-e "BACKUP_ENCRYPTION_PASSPHRASE=${BACKUP_PASS}" "${RESTORE_ARGS[@]}")
fi
docker run "${RESTORE_ARGS[@]}"

# --- 4) migrations head-check ---------------------------------------------
log "running migrations head-check against scratch DB (must be clean/no-op)"
docker compose --profile tools run --rm --no-deps \
  -e DATABASE_URL="postgres://saman_app:${PG_PW}@${SCRATCH}:5432/${PG_DB}" \
  -e MIGRATION_DATABASE_URL="postgres://saman_migrator:${PG_PW}@${SCRATCH}:5432/${PG_DB}" \
  migrate

# --- 5) data checks --------------------------------------------------------
log "restored data summary"
docker exec "$SCRATCH" psql -U postgres -d "$PG_DB" -tAc "
  SELECT 'tables=' || count(*) FROM information_schema.tables WHERE table_schema='erp';
  SELECT 'users=' || count(*) FROM erp.users;
  SELECT 'inventory_transactions=' || count(*) FROM erp.inventory_transactions;
  SELECT 'newest_ledger=' || coalesce(max(created_at)::text,'none') FROM erp.inventory_transactions;" \
  | sed 's/^/  /' || fail "data check queries failed (did the dump contain the expected schema?)"

# --- 6) optional API smoke against scratch DB ------------------------------
if [[ "$DO_SMOKE" -eq 1 ]]; then
  log "booting temporary API on 127.0.0.1:${DRILL_API_PORT} (SMS mocked, channel sync disabled)"
  docker run -d --name "$TMPAPI" \
    --network "$NETWORK" \
    --env-file .env \
    -p "127.0.0.1:${DRILL_API_PORT}:4000" \
    -e DATABASE_URL="postgres://saman_app:${PG_PW}@${SCRATCH}:5432/${PG_DB}" \
    -e MIGRATION_DATABASE_URL="postgres://saman_migrator:${PG_PW}@${SCRATCH}:5432/${PG_DB}" \
    -e APP_ENV=production -e NODE_ENV=production -e APP_PORT=4000 \
    -e "APP_URL=http://127.0.0.1:${DRILL_API_PORT}" \
    -e COOKIE_SECURE=false -e SMS_MODE=mock -e CHANNEL_SYNC_ENABLED=false -e DOCS_ENABLED=false \
    -e REDIS_URL="redis://:${REDIS_PW}@redis:6379/0" -e REDIS_PASSWORD="$REDIS_PW" \
    "$IMAGE_API" >/dev/null

  smoke_code="000"
  for _ in $(seq 1 40); do
    smoke_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${DRILL_API_PORT}/health/live" || true)"
    [[ "$smoke_code" == "200" ]] && break
    sleep 3
  done
  [[ "$smoke_code" == "200" ]] || fail "temporary API failed /health/live (code=$smoke_code); check: docker logs $TMPAPI"
  log "temporary API /health/live = 200"

  ready_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:${DRILL_API_PORT}/health/ready" || true)"
  log "temporary API /health/ready = ${ready_code} (200 = DB/Redis/S3 all reachable; 503 = a dependency is down)"
  [[ "$ready_code" == "200" ]] || log "WARN: readiness degraded — production must be verified separately"
  log "manual release-gate step: log in with the restored admin and read a product/order (BACKUP-RESTORE §9 steps 8–9)"
fi

ELAPSED="$(( $(date +%s) - START_TS ))"
log "DRILL COMPLETE in ${ELAPSED}s (RTO measurement; target ≤ 3600s)"
log "record this run in docs/07-operations/BACKUP-RESTORE.md §9 and attach the output to the release evidence"
