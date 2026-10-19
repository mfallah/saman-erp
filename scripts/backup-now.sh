#!/usr/bin/env bash
# =============================================================================
# Saman ERP — take an ad-hoc backup now and print the remote backup listing
# -----------------------------------------------------------------------------
# Usage: ./scripts/backup-now.sh [--no-list]
# Requires: docker compose stack running with the `backup` profile image built.
# The backup itself is implemented in infra/backup/backup.sh (pg_dump -Fc ->
# sha256 -> gpg -> MinIO/S3 -> retention). See docs/07-operations/BACKUP-RESTORE.md.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LIST=1
[[ "${1:-}" == "--no-list" ]] && LIST=0

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
[[ -f .env ]] || { echo ".env not found — run scripts/gen-secrets.sh first" >&2; exit 1; }

echo "[backup-now] running one backup"
docker compose --profile backup run --rm backup once

if [[ "$LIST" -eq 1 ]]; then
  echo "[backup-now] remote backup objects (bucket: saman-backups)"
  # MinIO/S3 port is not published; list through the mc one-shot container.
  docker compose run --rm --entrypoint sh minio-init -c '
    set -eu
    mc alias set local "$S3_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
    mc ls --recursive "local/${BACKUP_BUCKET:-saman-backups}/${BACKUP_S3_PREFIX:-backups/postgres}" | tail -n 10
  '
fi

echo "[backup-now] done. Verify a restore regularly: docs/07-operations/BACKUP-RESTORE.md §9"
