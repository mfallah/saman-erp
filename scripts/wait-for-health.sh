#!/usr/bin/env bash
# =============================================================================
# Saman ERP — wait until docker compose services are healthy (or timeout)
# -----------------------------------------------------------------------------
# Usage:
#   ./scripts/wait-for-health.sh [TIMEOUT_SECONDS] [SERVICE...]
#
# Exits 0 when every service with a healthcheck reports `healthy` and every
# one-shot service has exited 0; exits 1 on timeout or a failed one-shot.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TIMEOUT="${1:-300}"
if [[ "$TIMEOUT" =~ ^[0-9]+$ ]]; then
  shift || true
else
  TIMEOUT=300
fi
SERVICES=("$@")

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose v2 is required" >&2; exit 1; }

if [[ ${#SERVICES[@]} -eq 0 ]]; then
  mapfile -t SERVICES < <(docker compose config --services)
fi

start_ts=$(date +%s)
printf '[wait-for-health] waiting up to %ss for: %s\n' "$TIMEOUT" "${SERVICES[*]}"

while :; do
  all_ok=1
  pending=()
  for svc in "${SERVICES[@]}"; do
    cid="$(docker compose ps -q "$svc" 2>/dev/null || true)"
    if [[ -z "$cid" ]]; then
      # One-shot services (migrate/seed/minio-init) may have no running container;
      # treat "not running" as pending unless compose says exited 0.
      state="$(docker compose ps -a --format '{{.State}}' "$svc" 2>/dev/null | head -1 || true)"
      if [[ "$state" == "exited" ]]; then
        code="$(docker inspect -f '{{.State.ExitCode}}' "$(docker compose ps -a -q "$svc" | head -1)" 2>/dev/null || echo 1)"
        [[ "$code" == "0" ]] || { all_ok=0; pending+=("$svc:exit($code)"); }
      else
        all_ok=0; pending+=("$svc:not-created")
      fi
      continue
    fi
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo unknown)"
    case "$health" in
      healthy|none) : ;;
      starting) all_ok=0; pending+=("$svc:starting") ;;
      *) all_ok=0; pending+=("$svc:$health") ;;
    esac
  done

  if [[ "$all_ok" -eq 1 ]]; then
    printf '[wait-for-health] OK after %ss\n' "$(( $(date +%s) - start_ts ))"
    exit 0
  fi

  if (( $(date +%s) - start_ts >= TIMEOUT )); then
    printf '[wait-for-health] TIMEOUT after %ss; pending: %s\n' "$TIMEOUT" "${pending[*]:-unknown}" >&2
    echo "--- docker compose ps ---" >&2
    docker compose ps >&2 || true
    echo "Inspect logs: docker compose logs --tail=100 <service> (docs/06-deployment/INSTALL-FA.md §17)" >&2
    exit 1
  fi

  printf '[wait-for-health] pending: %s\n' "${pending[*]:-unknown}"
  sleep 3
done
