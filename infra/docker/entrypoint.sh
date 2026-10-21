#!/bin/sh
# Saman ERP container entrypoint.
# One image, three roles (Chabakan runs api and worker as two Docker services):
#   APP_ROLE=api      -> HTTP API (default)
#   APP_ROLE=worker   -> outbox dispatcher + background processors
#   APP_ROLE=all      -> worker in background + API in foreground (single-service deploys)
#   APP_ROLE=migrate  -> run SQL migrations once, then exit
set -eu

ROLE="${APP_ROLE:-api}"
if [ -n "${DATABASE_URL:-}" ]; then echo "[entrypoint] DATABASE_URL is set"; else echo "[entrypoint] DATABASE_URL is MISSING" >&2; fi
if [ -n "${MIGRATION_DATABASE_URL:-}" ]; then echo "[entrypoint] MIGRATION_DATABASE_URL is set"; else echo "[entrypoint] MIGRATION_DATABASE_URL is empty (fallback to DATABASE_URL)"; fi
if [ -n "${REDIS_URL:-}" ]; then echo "[entrypoint] REDIS_URL is set"; else echo "[entrypoint] REDIS_URL is MISSING" >&2; fi
# Normalise a malformed migration URL to the runtime URL (managed DBs use one role).
case "${MIGRATION_DATABASE_URL:-}" in
  postgres://*|postgresql://*) : ;;
  *) echo "[entrypoint] MIGRATION_DATABASE_URL is malformed; using DATABASE_URL"; export MIGRATION_DATABASE_URL="${DATABASE_URL:-}" ;;
esac
case "${REDIS_URL:-}" in
  redis://*|rediss://*) : ;;
  *) echo "[entrypoint] REDIS_URL is malformed (must start with redis:// or rediss://; length=${#REDIS_URL})" >&2 ;;
esac
cd /app/apps/api

if [ "${RUN_MIGRATIONS_ON_START:-0}" = "1" ]; then
  echo "[entrypoint] running migrations (APP_ROLE=${ROLE})"
  node /app/packages/db/dist/migrate.js
fi

if [ "${RUN_SEED_ON_START:-0}" = "1" ]; then
  echo "[entrypoint] seeding base data (idempotent)"
  node /app/packages/db/dist/seed.js || echo "[entrypoint] seed failed (continuing)"
fi

case "$ROLE" in
  api)
    exec node dist/main.js
    ;;
  worker)
    exec node dist/worker.js
    ;;
  all)
    # Single-container deployment: background worker with auto-restart.
    (
      while true; do
        node dist/worker.js || true
        echo "[entrypoint] worker exited; restarting in 5s" >&2
        sleep 5
      done
    ) &
    exec node dist/main.js
    ;;
  migrate)
    exec node /app/packages/db/dist/migrate.js
    ;;
  *)
    echo "[entrypoint] unknown APP_ROLE: $ROLE (expected api|worker|migrate)" >&2
    exit 1
    ;;
esac
