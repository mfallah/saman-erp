#!/usr/bin/env bash
# =============================================================================
# Saman ERP — generate a production .env + ./secrets/* from .env.example
# -----------------------------------------------------------------------------
# Usage:
#   ./scripts/gen-secrets.sh            # production: crown secrets live in ./secrets
#   ./scripts/gen-secrets.sh --dev      # local dev: also keep secrets in .env
#   ./scripts/gen-secrets.sh --force    # overwrite existing .env / secrets
#
# Produces:
#   .env                       (mode 600) non-secret config + local-dev secrets
#   secrets/                   (mode 700) root-owned crown secrets (mode 400)
#     jwt_access_secret  app_encryption_key  otp_pepper  refresh_pepper
#     db_password        migration_db_url    redis_password
#     backup_encryption_passphrase
#
# In production mode the crown values are blanked in .env and consumed through
# *_FILE indirection (docker-compose.yml `secrets:` -> /run/secrets/<name>).
# Secrets are never printed. After generation, edit DOMAIN/ACME_EMAIL, Limo and
# channel keys manually (they cannot be generated).
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT}/.env"
EXAMPLE="${ROOT}/.env.example"
SECRETS_DIR="${ROOT}/secrets"
FORCE=0
DEV=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --dev)   DEV=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }
[[ -f "$EXAMPLE" ]] || { echo ".env.example not found at $EXAMPLE" >&2; exit 1; }

if [[ ( -f "$ENV_FILE" || -d "$SECRETS_DIR" ) && "$FORCE" -ne 1 ]]; then
  echo ".env or secrets/ already exists. Re-run with --force to overwrite (a backup is created)." >&2
  exit 1
fi
if [[ -f "$ENV_FILE" ]]; then
  cp -p "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
fi

umask 077

GEN_HEX() { openssl rand -hex 32; }
GEN_B64() { openssl rand -base64 "${1:-48}" | tr -d '\n'; }

PG_PW="$(GEN_HEX)"
REDIS_PW="$(GEN_HEX)"
MINIO_PW="$(GEN_HEX)"
S3_PW="$(GEN_HEX)"
JWT_SECRET="$(GEN_B64 48)"
ENC_KEY="$(GEN_B64 32)"
OTP_PEPPER="$(GEN_HEX 32)"
REFRESH_PEPPER="$(GEN_HEX 32)"
BOOT_PW="$(GEN_B64 24)"
BACKUP_PASSPHRASE="$(GEN_B64 32)"
GRAFANA_PW="$(GEN_B64 24)"

# --- .env ------------------------------------------------------------------
cp "$EXAMPLE" "$ENV_FILE"

replace_key() {
  local key="$1" value="$2"
  awk -v k="$key" -v v="$value" '
    BEGIN { FS = OFS = "=" }
    $1 == k { print k "=" v; next }
    { print }
  ' "$ENV_FILE" > "${ENV_FILE}.tmp"
  mv "${ENV_FILE}.tmp" "$ENV_FILE"
}

ensure_key() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    replace_key "$key" "$value"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

replace_key POSTGRES_PASSWORD          "$PG_PW"
replace_key POSTGRES_USER              "saman"
replace_key POSTGRES_DB                "saman"
replace_key DATABASE_URL               "postgres://saman_app:${PG_PW}@postgres:5432/saman"
replace_key MIGRATION_DATABASE_URL     "postgres://saman_migrator:${PG_PW}@postgres:5432/saman"
replace_key REDIS_PASSWORD             "$REDIS_PW"
replace_key REDIS_URL                  "redis://:${REDIS_PW}@redis:6379/0"
replace_key MINIO_ROOT_PASSWORD        "$MINIO_PW"
replace_key S3_ACCESS_KEY              "saman-app"
replace_key S3_SECRET_KEY              "$S3_PW"
replace_key JWT_ACCESS_SECRET          "$JWT_SECRET"
replace_key APP_ENCRYPTION_KEY         "$ENC_KEY"
replace_key BACKUP_ENCRYPTION_PASSPHRASE "$BACKUP_PASSPHRASE"
replace_key BOOTSTRAP_ADMIN_PASSWORD   "$BOOT_PW"
replace_key BOOTSTRAP_ORG_NAME         "کرکسی شاپ"

# Keys approved by the Lead but not yet in the canonical .env.example.
ensure_key WEB_BIND_ADDR               "127.0.0.1"
ensure_key OTP_PEPPER                  "$OTP_PEPPER"
ensure_key REFRESH_PEPPER              "$REFRESH_PEPPER"
ensure_key GRAFANA_ADMIN_PASSWORD      "$GRAFANA_PW"
ensure_key BACKUP_MIRROR_S3_ENDPOINT   ""
ensure_key BACKUP_MIRROR_S3_BUCKET     ""
ensure_key BACKUP_MIRROR_S3_ACCESS_KEY ""
ensure_key BACKUP_MIRROR_S3_SECRET_KEY ""

if [[ "$DEV" -eq 1 ]]; then
  replace_key APP_ENV              "development"
  replace_key SMS_MODE             "mock"
  replace_key COOKIE_SECURE        "false"
  replace_key DOCS_ENABLED         "true"
  replace_key CHANNEL_SYNC_ENABLED "false"
  replace_key LOG_LEVEL            "debug"
else
  # Production: crown secrets are files only; blank them in .env so they never
  # sit in the Compose environment or `docker inspect` output.
  replace_key JWT_ACCESS_SECRET              ""
  replace_key MIGRATION_DATABASE_URL          ""
  replace_key APP_ENCRYPTION_KEY             ""
  replace_key REDIS_PASSWORD                 ""
  replace_key BACKUP_ENCRYPTION_PASSPHRASE   ""
  replace_key OTP_PEPPER                     ""
  replace_key REFRESH_PEPPER                 ""
  # Production must use the real SMS provider and a real origin; otherwise the
  # API boot-guards refuse to start (see docs/06-deployment/INSTALL-FA.md).
  replace_key SMS_MODE "limo"
  if grep -q "^CORS_ORIGINS=https://erp.example.com" "$ENV_FILE"; then
    replace_key CORS_ORIGINS "https://erp.carexy.shop"
  fi
fi

chmod 600 "$ENV_FILE"

# --- secrets/ (crown keys; mounted by compose, read via *_FILE) -------------
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

write_secret() {
  local name="$1" value="$2"
  local path="${SECRETS_DIR}/${name}"
  printf '%s' "$value" > "$path"
  chmod 400 "$path"
}

write_secret jwt_access_secret              "$JWT_SECRET"
write_secret app_encryption_key             "$ENC_KEY"
write_secret otp_pepper                     "$OTP_PEPPER"
write_secret refresh_pepper                 "$REFRESH_PEPPER"
write_secret db_password                    "$PG_PW"
write_secret migration_db_url               "postgres://saman_migrator:${PG_PW}@postgres:5432/saman"
write_secret redis_password                 "$REDIS_PW"
write_secret backup_encryption_passphrase   "$BACKUP_PASSPHRASE"

# Containers run as uid 1000 (api/web/worker/migrate) or 1001 (backup). Secret
# files must be readable by those users: 0400 owned by 1000:1000 (and 1001:1001
# for the backup passphrase) when the installer runs as root.
if [[ "$(id -u)" -eq 0 ]]; then
  chown 1000:1000 "${SECRETS_DIR}"/*
else
  echo "WARN: not running as root — ensure ./secrets/* are owned by/readable to uid 1000 (api/worker/migrate/backup)." >&2
fi

echo "Generated ${ENV_FILE} (mode 600) and ${SECRETS_DIR}/ (mode 700, files mode 400)."
echo "Still required from the operator (cannot be generated):"
echo "  - DOMAIN/ACME_EMAIL (current: $(grep -E '^DOMAIN=' "$ENV_FILE" | cut -d= -f2-))"
echo "  - LIMO_API_KEY, LIMO_SENDER, CAREXY_API_KEY, DIGIKALA_CLIENT_ID/SECRET"
echo "  - BOOTSTRAP_ADMIN_MOBILE (first-admin mobile number)"
echo "Next: edit .env, then 'docker compose up -d --build' (docs/06-deployment/INSTALL-FA.md §6)."
