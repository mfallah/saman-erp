#!/bin/sh
# Saman ERP container entrypoint.
# One image, three roles (Chabakan runs api and worker as two Docker services):
#   APP_ROLE=api      -> HTTP API (default)
#   APP_ROLE=worker   -> outbox dispatcher + background processors
#   APP_ROLE=migrate  -> run SQL migrations once, then exit
set -eu

ROLE="${APP_ROLE:-api}"
cd /app/apps/api

if [ "${RUN_MIGRATIONS_ON_START:-0}" = "1" ]; then
  echo "[entrypoint] running migrations (APP_ROLE=${ROLE})"
  node /app/packages/db/dist/migrate.js
fi

case "$ROLE" in
  api)
    exec node dist/main.js
    ;;
  worker)
    exec node dist/worker.js
    ;;
  migrate)
    exec node /app/packages/db/dist/migrate.js
    ;;
  *)
    echo "[entrypoint] unknown APP_ROLE: $ROLE (expected api|worker|migrate)" >&2
    exit 1
    ;;
esac
