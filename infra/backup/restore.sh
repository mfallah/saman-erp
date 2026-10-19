#!/bin/bash
# =============================================================================
# Saman ERP — single-dump restore helper (runs inside the backup image)
# -----------------------------------------------------------------------------
# Restores a pg_dump custom-format archive into an EXISTING, EMPTY database
# whose roles/schema/extensions were prepared by the PostgreSQL init contract.
#
# Usage:
#   restore.sh --file /backups/saman-erp-YYYYMMDDTHHMMSSZ.dump.gpg \
#              --database-url "postgres://saman_migrator:***@postgres:5432/saman" \
#              [--single-transaction]
#   restore.sh --file dump.dump --list          # inspect archive TOC only
#
# Security/consistency notes:
#   * Extension and CREATE SCHEMA entries are filtered from the TOC because the
#     target DB is pre-provisioned (01-init.sql); re-running them would fail.
#   * --no-owner --no-acl keeps the dump portable across environments; objects
#     are created as the connecting role (saman_migrator) so default privileges
#     apply to saman_app/saman_worker/saman_readonly.
#   * The dump is expected next to a <file>.sha256 manifest; if present it is
#     verified before restore.
# See docs/07-operations/BACKUP-RESTORE.md §6.
# =============================================================================
set -euo pipefail

FILE=""
DB_URL=""
LIST_ONLY="false"
SINGLE_TX="false"

log()  { printf '[restore] %s\n' "$*"; }
fail() { printf '[restore] ERROR: %s\n' "$*" >&2; exit 1; }

# Compose mounts crown secrets as files; support *_FILE indirection for the
# backup passphrase (plain env still works for local dev / manual hosts).
file_env() {
  local var="$1" file_var="${var}_FILE" file="${!file_var:-}"
  if [[ -z "${!var:-}" && -n "$file" && -f "$file" ]]; then
    local value
    value="$(<"$file")"
    printf -v "$var" '%s' "$value"
    export "${var?}"
  fi
}
file_env BACKUP_ENCRYPTION_PASSPHRASE

usage() {
  grep '^#   ' "$0" | sed 's/^#   //'
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file)               FILE="${2:?}"; shift 2 ;;
    --database-url)       DB_URL="${2:?}"; shift 2 ;;
    --list)               LIST_ONLY="true"; shift ;;
    --single-transaction) SINGLE_TX="true"; shift ;;
    -h|--help)            usage ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ -n "$FILE" ]] || fail "--file is required"
[[ -f "$FILE" ]] || fail "dump file not found: $FILE"

prepare_gnupg() {
  export GNUPGHOME="${GNUPGHOME:-/tmp/gnupg}"
  mkdir -p "$GNUPGHOME"; chmod 700 "$GNUPGHOME"
}

# --sha256 verification (only when a manifest sits next to the dump) ----------
if [[ -f "${FILE}.sha256" ]]; then
  log "verifying sha256 manifest"
  ( cd "$(dirname "$FILE")" && sha256sum -c "$(basename "$FILE").sha256" )
else
  log "WARN: no ${FILE}.sha256 manifest next to the dump — skipping checksum"
fi

# --decrypt if GPG symmetric ------------------------------------------------
WORK_FILE="$FILE"
CLEANUP=()
if [[ "$FILE" == *.gpg ]]; then
  prepare_gnupg
  [[ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]] || fail "BACKUP_ENCRYPTION_PASSPHRASE is required to decrypt $FILE"
  WORK_FILE="$(mktemp)"
  CLEANUP+=("$WORK_FILE")
  log "decrypting (GPG AES-256)"
  printf '%s' "$BACKUP_ENCRYPTION_PASSPHRASE" \
    | gpg --batch --yes --quiet --passphrase-fd 0 --decrypt -o "$WORK_FILE" "$FILE"
fi
trap 'if [[ ${#CLEANUP[@]} -gt 0 ]]; then for f in "${CLEANUP[@]}"; do rm -f "$f"; done; fi' EXIT

TOC="$(mktemp)"; CLEANUP+=("$TOC")
log "building filtered TOC (skipping EXTENSION / SCHEMA entries)"
pg_restore -l "$WORK_FILE" | grep -vE ' (EXTENSION|COMMENT - EXTENSION|SCHEMA) - ' > "$TOC" || true
objects="$(grep -c ' TABLE ' "$TOC" || true)"
log "TOC: ${objects} table entries selected"

if [[ "$LIST_ONLY" == "true" ]]; then
  head -n 40 "$TOC"
  exit 0
fi

[[ -n "$DB_URL" ]] || fail "--database-url is required unless --list is used"
log "restoring into target database (this can take a while)"
ARGS=(--no-owner --no-acl -L "$TOC" -d "$DB_URL" "$WORK_FILE")
if [[ "$SINGLE_TX" == "true" ]]; then
  ARGS=(--single-transaction "${ARGS[@]}")
fi
pg_restore "${ARGS[@]}" || fail "pg_restore reported errors — inspect the output above before starting the API"
log "restore completed; run the migrations head-check and smoke test (docs/07-operations/BACKUP-RESTORE.md §6.2 steps 6–8)"
