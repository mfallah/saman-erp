#!/bin/bash
# =============================================================================
# Saman ERP — backup sidecar
# -----------------------------------------------------------------------------
# Modes:
#   backup.sh once     run one backup now (also used by scripts/backup-now.sh)
#   backup.sh daemon   run daily at BACKUP_CRON time (default: 02:00)
#   backup.sh verify   verify the newest local backup (sha256 + gpg + pg_restore -l)
#
# Pipeline: pg_dump -Fc -> sha256 manifest -> gpg AES-256 -> MinIO/S3 upload ->
#           optional offsite mirror -> local retention -> .last-success marker.
#
# Env (canonical, see .env.example):
#   MIGRATION_DATABASE_URL          dump source (schema-owner role; read-only dump)
#   BACKUP_ENABLED                  true|false
#   BACKUP_CRON                     "M H * * *" (daily only; validated)
#   BACKUP_KEEP_DAYS                local retention days
#   BACKUP_S3_PREFIX                object prefix in bucket saman-backups
#   BACKUP_ENCRYPTION_PASSPHRASE    GPG symmetric passphrase (required in prod)
#   S3_ENDPOINT/S3_ACCESS_KEY/S3_SECRET_KEY
# Optional offsite mirror:
#   BACKUP_MIRROR_S3_ENDPOINT / BACKUP_MIRROR_S3_BUCKET /
#   BACKUP_MIRROR_S3_ACCESS_KEY / BACKUP_MIRROR_S3_SECRET_KEY
# See docs/07-operations/BACKUP-RESTORE.md — this is design-by-review,
# not runtime-tested in the build environment.
# =============================================================================
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BUCKET="${BACKUP_BUCKET:-saman-backups}"
PREFIX="${BACKUP_S3_PREFIX:-backups/postgres}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
HOSTNAME_SHORT="$(hostname -s 2>/dev/null || echo saman-erp)"
MARKER="${BACKUP_DIR}/.last-success"
LOG_PREFIX="[backup ${TS}]"

log()  { printf '%s %s\n' "$LOG_PREFIX" "$*"; }
fail() { printf '%s ERROR: %s\n' "$LOG_PREFIX" "$*" >&2; exit 1; }

# Compose passes crown secrets as files with *_FILE indirection; support both
# (plain env for local dev, file for production).
file_env() {
  local var="$1"
  local file_var="${var}_FILE"
  local file="${!file_var:-}"
  if [[ -z "${!var:-}" && -n "$file" && -f "$file" ]]; then
    local value
    value="$(<"$file")"
    printf -v "$var" '%s' "$value"
    export "${var?}"
  fi
}
file_env MIGRATION_DATABASE_URL
file_env BACKUP_ENCRYPTION_PASSPHRASE
file_env S3_ACCESS_KEY
file_env S3_SECRET_KEY
file_env S3_ENDPOINT
file_env BACKUP_MIRROR_S3_ACCESS_KEY
file_env BACKUP_MIRROR_S3_SECRET_KEY
file_env BACKUP_MIRROR_S3_ENDPOINT

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "required environment variable $name is empty"
}

prepare_dirs() {
  mkdir -p "$BACKUP_DIR" "${MC_CONFIG_DIR:-/tmp/mc}" "${GNUPGHOME:-/tmp/gnupg}"
  chmod 700 "${GNUPGHOME:-/tmp/gnupg}" 2>/dev/null || true
}

minio_alias() {
  local alias_name="${1:-local}"
  local endpoint="$2" key="$3" secret="$4"
  mc alias set "$alias_name" "$endpoint" "$key" "$secret" >/dev/null
}

run_backup() {
  [[ "${BACKUP_ENABLED:-true}" == "true" ]] || { log "BACKUP_ENABLED=false — skipping"; return 0; }
  require_env MIGRATION_DATABASE_URL
  require_env BACKUP_ENCRYPTION_PASSPHRASE
  require_env S3_ENDPOINT
  require_env S3_ACCESS_KEY
  require_env S3_SECRET_KEY
  prepare_dirs

  local plain="${BACKUP_DIR}/saman-erp-${TS}.dump"
  local enc="${plain}.gpg"

  log "starting pg_dump (custom format, compressed)"
  pg_dump -Fc -Z6 --no-owner --no-acl --dbname="$MIGRATION_DATABASE_URL" -f "$plain" \
    || fail "pg_dump failed"

  log "computing sha256 manifest"
  ( cd "$BACKUP_DIR" && sha256sum "$(basename "$plain")" > "$(basename "$plain").sha256" )

  log "verifying dump readability (pg_restore --list)"
  pg_restore -l "$plain" >/dev/null || { rm -f "$plain" "$plain.sha256"; fail "dump is not readable"; }

  log "encrypting with GPG AES-256"
  printf '%s' "$BACKUP_ENCRYPTION_PASSPHRASE" \
    | gpg --batch --yes --quiet --passphrase-fd 0 --symmetric --cipher-algo AES256 -o "$enc" "$plain" \
    || { rm -f "$plain" "$plain.sha256"; fail "gpg encryption failed"; }

  # Plaintext must never rest on disk after encryption.
  shred -u "$plain" 2>/dev/null || rm -f "$plain"

  log "uploading to MinIO/S3 (${BUCKET}/${PREFIX})"
  minio_alias local "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY"
  mc cp "${enc}" "local/${BUCKET}/${PREFIX}/" >/dev/null
  mc cp "${enc}.sha256" "local/${BUCKET}/${PREFIX}/" >/dev/null
  mc stat "local/${BUCKET}/${PREFIX}/$(basename "$enc")" >/dev/null \
    || fail "upload verification failed (mc stat)"

  # Optional offsite mirror (different provider/account; never the same disk).
  if [[ -n "${BACKUP_MIRROR_S3_ENDPOINT:-}" ]]; then
    require_env BACKUP_MIRROR_S3_BUCKET
    require_env BACKUP_MIRROR_S3_ACCESS_KEY
    require_env BACKUP_MIRROR_S3_SECRET_KEY
    log "mirroring to offsite ${BACKUP_MIRROR_S3_ENDPOINT}/${BACKUP_MIRROR_S3_BUCKET}"
    minio_alias offsite "$BACKUP_MIRROR_S3_ENDPOINT" "$BACKUP_MIRROR_S3_ACCESS_KEY" "$BACKUP_MIRROR_S3_SECRET_KEY"
    mc mb --ignore-existing "offsite/${BACKUP_MIRROR_S3_BUCKET}" >/dev/null 2>&1 || true
    mc cp "${enc}" "offsite/${BACKUP_MIRROR_S3_BUCKET}/${PREFIX}/" >/dev/null
    mc cp "${enc}.sha256" "offsite/${BACKUP_MIRROR_S3_BUCKET}/${PREFIX}/" >/dev/null
  else
    log "no BACKUP_MIRROR_S3_ENDPOINT set — skipping offsite mirror (offsite copy is mandatory for production)"
  fi

  log "applying retention (${KEEP_DAYS} days)"
  find "$BACKUP_DIR" -maxdepth 1 -name '*.gpg' -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true
  find "$BACKUP_DIR" -maxdepth 1 -name '*.sha256' -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true
  mc rm --recursive --force --older-than "${KEEP_DAYS}d" \
    "local/${BUCKET}/${PREFIX}/" >/dev/null 2>&1 || \
    log "WARN: remote retention via mc --older-than unsupported/skipped"

  date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER"
  log "SUCCESS: $(basename "$enc") ($(du -h "$enc" | cut -f1)), sha256=$(cut -c1-16 "${enc}.sha256")…"
}

verify_latest() {
  prepare_dirs
  local latest
  latest="$(find "$BACKUP_DIR" -maxdepth 1 -name '*.dump.gpg' | sort | tail -1 || true)"
  [[ -n "$latest" ]] || fail "no local backup found in $BACKUP_DIR"
  log "verifying $latest"
  ( cd "$BACKUP_DIR" && sha256sum -c "$(basename "$latest").sha256" )
  require_env BACKUP_ENCRYPTION_PASSPHRASE
  local tmp; tmp="$(mktemp)"
  printf '%s' "$BACKUP_ENCRYPTION_PASSPHRASE" \
    | gpg --batch --yes --quiet --passphrase-fd 0 --decrypt -o "$tmp" "$latest"
  pg_restore -l "$tmp" | head -5
  rm -f "$tmp"
  log "SUCCESS: backup decrypts and its TOC is readable"
}

daemon() {
  local minute hour dom mon dow
  read -r minute hour dom mon dow <<<"${BACKUP_CRON:-0 2 * * *}"
  [[ "$minute" =~ ^[0-9]{1,2}$ && "$hour" =~ ^[0-9]{1,2}$ && "$dom" == "*" && "$mon" == "*" && "$dow" == "*" ]] \
    || fail "BACKUP_CRON must be a daily 'M H * * *' expression (got '${BACKUP_CRON:-}')"
  minute=$((10#$minute)); hour=$((10#$hour))
  [[ $minute -le 59 && $hour -le 23 ]] || fail "BACKUP_CRON out of range: ${BACKUP_CRON}"
  log "daemon started; daily backup at $(printf '%02d:%02d' "$hour" "$minute") ${TZ:-local}"
  local last_run=""
  while true; do
    local now_h now_m today
    now_h=$((10#$(date +%H))); now_m=$((10#$(date +%M))); today="$(date +%F)"
    if [[ "$now_h" -eq "$hour" && "$now_m" -eq "$minute" && "$today" != "$last_run" ]]; then
      last_run="$today"
      if ! run_backup; then
        log "ERROR: scheduled backup failed — will retry on the next matching minute window"
      fi
    fi
    sleep 30
  done
}

case "${1:-daemon}" in
  once)   run_backup ;;
  verify) verify_latest ;;
  daemon) daemon ;;
  *)      printf 'usage: %s {daemon|once|verify}\n' "$0" >&2; exit 2 ;;
esac
