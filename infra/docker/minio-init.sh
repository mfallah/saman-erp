#!/bin/sh
# =============================================================================
# Saman ERP — MinIO one-shot bootstrap (compose service `minio-init`)
# Creates buckets, enables versioning, and provisions the least-privilege
# application user used by the API/worker and the backup sidecar.
#
# The MinIO server image has no guaranteed healthcheck binary, so readiness is
# enforced HERE: retry `mc alias set` with bounded exponential backoff, then
# create buckets idempotently. api/worker depend on this service completing
# successfully (`condition: service_completed_successfully`).
# Idempotent: safe to run on every deploy.
# =============================================================================
set -eu

: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
: "${S3_ACCESS_KEY:?S3_ACCESS_KEY is required}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY is required}"
S3_BUCKET="${S3_BUCKET:-saman-files}"
BACKUP_BUCKET="${BACKUP_BUCKET:-saman-backups}"
export MC_CONFIG_DIR="${MC_CONFIG_DIR:-/tmp/mc}"
mkdir -p "$MC_CONFIG_DIR"

log() { printf '[minio-init] %s\n' "$*"; }

# --- wait for MinIO with bounded exponential backoff -----------------------
attempt=1
max_attempts=30
delay=2
until mc alias set local "${S3_ENDPOINT}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null 2>&1; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    log "ERROR: MinIO at ${S3_ENDPOINT} not reachable after ${max_attempts} attempts"
    exit 1
  fi
  log "waiting for MinIO (attempt ${attempt}/${max_attempts}, retry in ${delay}s)"
  sleep "$delay"
  attempt=$((attempt + 1))
  delay=$((delay * 2))
  if [ "$delay" -gt 15 ]; then
    delay=15
  fi
done
log "MinIO is reachable"

# --- buckets (idempotent) --------------------------------------------------
log "ensuring buckets: ${S3_BUCKET} ${BACKUP_BUCKET}"
retry() {
  _attempts=10
  _delay=1
  _i=1
  until "$@"; do
    if [ "$_i" -ge "$_attempts" ]; then
      log "ERROR: command failed after ${_attempts} attempts: $*"
      return 1
    fi
    sleep "$_delay"
    _i=$((_i + 1))
    _delay=$((_delay + 1))
  done
}
retry mc mb --ignore-existing "local/${S3_BUCKET}"
retry mc mb --ignore-existing "local/${BACKUP_BUCKET}"

log "enabling object versioning (media + backups)"
mc version enable "local/${S3_BUCKET}" || log "WARN: versioning on ${S3_BUCKET} unsupported/skipped"
mc version enable "local/${BACKUP_BUCKET}" || log "WARN: versioning on ${BACKUP_BUCKET} unsupported/skipped"

# --- least-privilege application policy ------------------------------------
cat > /tmp/saman-app-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::${S3_BUCKET}",
        "arn:aws:s3:::${BACKUP_BUCKET}"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": [
        "arn:aws:s3:::${S3_BUCKET}/*",
        "arn:aws:s3:::${BACKUP_BUCKET}/*"
      ]
    }
  ]
}
JSON

log "ensuring application user ${S3_ACCESS_KEY}"
if mc admin user info local "${S3_ACCESS_KEY}" >/dev/null 2>&1; then
  log "user exists — password unchanged (rotate via mc admin user; docs RUNBOOK §8)"
else
  retry mc admin user add local "${S3_ACCESS_KEY}" "${S3_SECRET_KEY}"
fi

log "applying least-privilege policy saman-app"
mc admin policy create local saman-app /tmp/saman-app-policy.json \
  || log "policy already exists — reusing the stable definition"
mc admin policy attach local saman-app --user "${S3_ACCESS_KEY}" \
  || log "policy already attached"

log "bootstrap complete:"
mc ls local
