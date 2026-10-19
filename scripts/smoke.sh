#!/usr/bin/env bash
# =============================================================================
# Saman ERP — post-deploy smoke test (no credentials required)
# -----------------------------------------------------------------------------
# Usage:
#   ./scripts/smoke.sh                       # http://127.0.0.1:${WEB_HOST_PORT:-8080}
#   ./scripts/smoke.sh --url https://erp.carexy.shop
#   ./scripts/smoke.sh --url http://127.0.0.1:8080 --timeout 60
#
# Verifies: web liveness, API liveness/readiness, Persian RTL SPA shell, and
# that the OpenAPI docs endpoint is not publicly exposed in production.
# Does NOT log in (no credentials in scripts); the release gate adds a manual
# login + product/order read (docs/07-operations/BACKUP-RESTORE.md §9).
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

URL=""
TIMEOUT=30
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)     URL="${2:?}"; shift 2 ;;
    --timeout) TIMEOUT="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$URL" ]]; then
  PORT="8080"
  if [[ -f .env ]]; then
    PORT="$(grep -E '^WEB_HOST_PORT=' .env | head -1 | cut -d= -f2- | tr -d ' ' || true)"
    PORT="${PORT:-8080}"
  fi
  URL="http://127.0.0.1:${PORT}"
fi
URL="${URL%/}"

PASS=0
FAIL=0
declare -a FAILED=()

pass() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); FAILED+=("$*"); printf '  FAIL  %s\n' "$*" >&2; }

http_code() {
  # -k only when asked via SMOKE_INSECURE=1 (self-signed staging certs)
  local curl_args=(-s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" --retry 3 --retry-connrefused)
  [[ "${SMOKE_INSECURE:-0}" == "1" ]] && curl_args+=(-k)
  curl "${curl_args[@]}" "$1" || echo "000"
}
http_body() {
  local curl_args=(-s --max-time "$TIMEOUT" --retry 3 --retry-connrefused)
  [[ "${SMOKE_INSECURE:-0}" == "1" ]] && curl_args+=(-k)
  curl "${curl_args[@]}" "$1" || true
}

printf '[smoke] target: %s\n' "$URL"

# --- web ------------------------------------------------------------------
code="$(http_code "$URL/healthz")"
[[ "$code" == "200" ]] && pass "web /healthz = 200" || fail "web /healthz = $code (expected 200)"

# --- API liveness ---------------------------------------------------------
code="$(http_code "$URL/health/live")"
[[ "$code" == "200" ]] && pass "api /health/live = 200" || fail "api /health/live = $code (expected 200)"

# --- API readiness (DB + Redis + S3) --------------------------------------
code="$(http_code "$URL/health/ready")"
[[ "$code" == "200" ]] && pass "api /health/ready = 200" || fail "api /health/ready = $code (503 = dependency down; RUNBOOK §11.1/§11.2/§11.10)"

# --- Persian RTL SPA shell ------------------------------------------------
body="$(http_body "$URL/")"
if grep -qiE 'lang="fa"|dir="rtl"' <<<"$body"; then
  pass "SPA shell is Persian/RTL (lang=fa or dir=rtl)"
else
  fail "SPA shell does not advertise Persian/RTL (check APP_DEFAULT_LOCALE=fa-IR and web image)"
fi
if grep -qi 'vazirmatn' <<<"$body"; then
  pass "Vazirmatn font referenced"
else
  printf '  WARN  Vazirmatn font not found in index.html (may be bundled via CSS)\n' >&2
fi

# --- OpenAPI docs must be off in production -------------------------------
docs_enabled="false"
if [[ -f .env ]]; then
  docs_enabled="$(grep -E '^DOCS_ENABLED=' .env | head -1 | cut -d= -f2- | tr -d ' ' || true)"
fi
code="$(http_code "$URL/api/v1/docs")"
if [[ "${docs_enabled,,}" == "true" ]]; then
  [[ "$code" == "200" ]] && pass "OpenAPI docs reachable (DOCS_ENABLED=true)" || fail "DOCS_ENABLED=true but /api/v1/docs = $code"
else
  if [[ "$code" == "404" || "$code" == "403" ]]; then
    pass "/api/v1/docs is not exposed ($code)"
  else
    fail "/api/v1/docs = $code but DOCS_ENABLED=false (expected 404)"
  fi
fi

# --- metrics must not be public ------------------------------------------
code="$(http_code "$URL/metrics")"
[[ "$code" == "404" || "$code" == "403" ]] && pass "/metrics is not public ($code)" || fail "/metrics = $code (expected 404/403)"

echo
if [[ "$FAIL" -eq 0 ]]; then
  printf '[smoke] PASS (%d checks)\n' "$PASS"
  exit 0
fi
printf '[smoke] FAIL (%d passed, %d failed)\n' "$PASS" "$FAIL" >&2
printf '  failed: %s\n' "${FAILED[*]}" >&2
exit 1
