#!/usr/bin/env python3
"""Saman ERP — configuration validation (install-free).

Validates the files this repository owns the syntax of:
  * docker-compose.yml / docker-compose.dev.yml / docker-compose.prod.yml
  * .github/workflows/*.yml
  * infra/observability/prometheus.yml + alerts.yml + Grafana provisioning
  * infra/observability/grafana/dashboards/*.json
  * .github/ISSUE_TEMPLATE/*.yml

Exit code 0 = all parsed; 1 = at least one error. Does NOT need Docker.
Docker/Compose semantic validation is a separate CI job (compose-config) and
requires a Docker host; it cannot run in environments without Docker.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    import yaml  # PyYAML
except ImportError:  # pragma: no cover
    print("ERROR: PyYAML is required (python3 -m pip install pyyaml)", file=sys.stderr)
    sys.exit(2)

ROOT = Path(__file__).resolve().parent.parent

YAML_TARGETS = [
    "docker-compose.yml",
    "docker-compose.dev.yml",
    "docker-compose.prod.yml",
    "infra/observability/prometheus.yml",
    "infra/observability/alerts.yml",
    "infra/observability/grafana/provisioning/datasources/prometheus.yml",
    "infra/observability/grafana/provisioning/dashboards/dashboards.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/security.yml",
    ".github/workflows/release.yml",
    ".github/workflows/README.md",  # skipped: not YAML, see below
]
JSON_TARGETS = [
    "infra/observability/grafana/dashboards/saman-overview.json",
]

SHELL_TARGETS = [
    "scripts/gen-secrets.sh",
    "scripts/wait-for-health.sh",
    "scripts/smoke.sh",
    "scripts/backup-now.sh",
    "scripts/restore-drill.sh",
    "infra/backup/backup.sh",
    "infra/backup/restore.sh",
    "infra/docker/minio-init.sh",
]

DOCKERFILE_TARGETS = [
    ("infra/docker/api.Dockerfile", "USER 1000:1000"),
    ("infra/docker/web.Dockerfile", "USER 101:101"),
    ("infra/backup/Dockerfile", "USER 1000:1000"),
]

warnings: list[str] = []

errors: list[str] = []


def load_yaml(path: Path) -> None:
    try:
        with path.open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
    except yaml.YAMLError as exc:
        errors.append(f"{path.relative_to(ROOT)}: YAML error: {exc}")
        return
    if data is None:
        errors.append(f"{path.relative_to(ROOT)}: empty YAML document")
        return
    print(f"OK   yaml  {path.relative_to(ROOT)}")


def load_json(path: Path) -> None:
    try:
        json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        errors.append(f"{path.relative_to(ROOT)}: JSON error: {exc}")
        return
    print(f"OK   json  {path.relative_to(ROOT)}")


def check_compose_services(path: Path) -> None:
    """Contract checks shared with docs/06-deployment/DEPLOYMENT.md §3."""
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError:
        return
    services = data.get("services") or {}
    required = {
        "postgres", "redis", "minio", "minio-init", "api", "worker",
        "web", "migrate", "caddy", "backup",
    }
    if path.name == "docker-compose.yml":
        missing = required - set(services)
        if missing:
            errors.append(f"{path.name}: missing required services: {sorted(missing)}")
        else:
            print(f"OK   contract {path.name}: all {len(required)} services present")
        if services.get("caddy", {}).get("profiles") != ["tls"]:
            errors.append(f"{path.name}: caddy must be in profile ['tls']")
        if services.get("migrate", {}).get("profiles") != ["tools"]:
            errors.append(f"{path.name}: migrate must be in profile ['tools']")
        if services.get("backup", {}).get("profiles") != ["backup"]:
            errors.append(f"{path.name}: backup must be in profile ['backup']")
        if services.get("prometheus", {}).get("profiles") != ["observability"]:
            errors.append(f"{path.name}: prometheus must be in profile ['observability'] or removed")
        if services.get("grafana", {}).get("profiles") != ["observability"]:
            errors.append(f"{path.name}: grafana must be in profile ['observability'] or removed")
        # No public data-plane ports.
        for svc in ("postgres", "redis", "minio", "api", "migrate"):
            ports = services.get(svc, {}).get("ports") or []
            if any(":" in str(p) and not str(p).startswith("127.0.0.1") and "${MINIO_CONSOLE_BIND" not in str(p) for p in ports):
                errors.append(f"{path.name}: service {svc} publishes a non-loopback port: {ports}")
        web_ports = services.get("web", {}).get("ports") or []
        if not web_ports or any("${WEB_BIND_ADDR" not in str(p) and not str(p).startswith("127.0.0.1") for p in web_ports):
            errors.append(f"{path.name}: web must publish via ${WEB_BIND_ADDR:-127.0.0.1} (loopback default)")
        # Compose v2 ignores deploy.* outside swarm: never leave silently-ignored limits.
        for svc, spec in services.items():
            if isinstance(spec, dict) and "deploy" in spec:
                errors.append(f"{path.name}: service {svc} uses deploy.* (ignored by Compose v2); use cpus/mem_limit")
        if "deploy" in data:
            errors.append(f"{path.name}: top-level deploy key is ignored by Compose v2")
        # Resource limits must be real top-level keys.
        for svc in ("postgres", "redis", "minio", "api", "worker", "web", "caddy", "backup"):
            spec = services.get(svc, {})
            if "mem_limit" not in spec:
                errors.append(f"{path.name}: service {svc} has no top-level mem_limit")
        # Crown secrets contract.
        secret_names = set((data.get("secrets") or {}).keys())
        required_secrets = {
            "jwt_access_secret", "app_encryption_key", "otp_pepper", "refresh_pepper",
            "db_password", "migration_db_url", "redis_password",
        }
        if not required_secrets.issubset(secret_names):
            errors.append(f"{path.name}: missing compose secrets: {sorted(required_secrets - secret_names)}")
        for svc in ("api", "worker"):
            spec = services.get(svc, {})
            env = spec.get("environment") or {}
            for key in ("JWT_ACCESS_SECRET_FILE", "APP_ENCRYPTION_KEY_FILE", "OTP_PEPPER_FILE",
                        "REFRESH_PEPPER_FILE", "DB_PASSWORD_FILE", "REDIS_PASSWORD_FILE"):
                if key not in env:
                    errors.append(f"{path.name}: {svc} missing *_FILE indirection key {key}")
            if spec.get("user") != "1000:1000":
                errors.append(f"{path.name}: {svc} must set user: '1000:1000'")
            if spec.get("read_only") is not True:
                errors.append(f"{path.name}: {svc} must set read_only: true")
        # MinIO has no reliable probe binary: readiness is enforced by minio-init.
        if services.get("minio", {}).get("healthcheck"):
            errors.append(f"{path.name}: minio must not define a healthcheck (no guaranteed probe binary)")
        api_deps = (services.get("api", {}).get("depends_on") or {})
        if (api_deps.get("minio-init") or {}).get("condition") != "service_completed_successfully":
            errors.append(f"{path.name}: api must depend on minio-init service_completed_successfully")
        if (services.get("minio-init", {}).get("depends_on", {}).get("minio") or {}).get("condition") != "service_started":
            errors.append(f"{path.name}: minio-init must depend on minio service_started (it retries readiness)")
        print("OK   contract: secrets/*_FILE, loopback ports, mem_limit, no deploy.*, minio-init readiness")



def check_no_latest() -> None:
    """Pinned base images: no `:latest` tags in compose files or Dockerfiles."""
    for rel in ("docker-compose.yml", "docker-compose.dev.yml", "docker-compose.prod.yml"):
        text = (ROOT / rel).read_text(encoding="utf-8")
        if ":latest" in text:
            errors.append(f"{rel}: contains an unpinned ':latest' image tag")
    for rel, _ in DOCKERFILE_TARGETS:
        text = (ROOT / rel).read_text(encoding="utf-8") if (ROOT / rel).exists() else ""
        if ":latest" in text:
            errors.append(f"{rel}: contains an unpinned ':latest' image tag")
    print("OK   images: no ':latest' tags in compose/Dockerfiles")


def check_dockerfiles() -> None:
    for rel, expected_user in DOCKERFILE_TARGETS:
        path = ROOT / rel
        if not path.exists():
            errors.append(f"{rel}: missing Dockerfile")
            continue
        text = path.read_text(encoding="utf-8")
        froms = text.count("\nFROM ")
        if froms < 2 and "api.Dockerfile" in rel or froms < 2 and "web.Dockerfile" in rel:
            errors.append(f"{rel}: expected a multi-stage build (>=2 FROM), found {froms}")
        if not text.lstrip().startswith("# syntax=docker/dockerfile:"):
            warnings.append(f"{rel}: missing '# syntax=docker/dockerfile:1.7' header")
        if expected_user not in text:
            errors.append(f"{rel}: expected non-root final stage with '{expected_user}'")
        if "COPY . ." in text:
            errors.append(f"{rel}: broad 'COPY . .' would invalidate cache and risk leaking context")
        print(f"OK   dockerfile {rel}: pinned, non-root ({expected_user.split()[-1]}), {froms} stage(s)")


def check_shell_scripts() -> None:
    """Static shell checks. bash/WSL execution is blocked in the authoring sandbox,
    so the scripts are validated by review here and executed for real in CI."""
    forbidden = [
        ("docker compose down -v", "destructive volume removal"),
        ("rm -rf /", "dangerous root deletion"),
        ("--no-verify", "hook bypass"),
    ]
    for rel in SHELL_TARGETS:
        path = ROOT / rel
        if not path.exists():
            errors.append(f"{rel}: missing shell script")
            continue
        lines = path.read_text(encoding="utf-8").splitlines()
        body = "\n".join(lines)
        if not lines or not lines[0].startswith("#!"):
            errors.append(f"{rel}: missing shebang")
            continue
        if "set -euo pipefail" not in body and "set -eu" not in body:
            errors.append(f"{rel}: missing 'set -e(uo pipefail)' safety flags")
        for pattern, reason in forbidden:
            if pattern in body:
                errors.append(f"{rel}: forbidden pattern '{pattern}' ({reason})")
        # All scripts must reference only relative/repo paths, never a user home.
        if "/home/" in body or "C:\\\\" in body:
            warnings.append(f"{rel}: absolute user path detected — keep scripts portable")
        print(f"OK   shell {rel}: shebang + safety flags present (bash execution unavailable locally; CI runs it)")


def main() -> int:
    for rel in YAML_TARGETS:
        if rel.endswith(".md"):
            continue
        path = ROOT / rel
        if not path.exists():
            errors.append(f"{rel}: file missing")
            continue
        load_yaml(path)
        if rel.startswith("docker-compose"):
            check_compose_services(path)
    for rel in JSON_TARGETS:
        path = ROOT / rel
        if not path.exists():
            errors.append(f"{rel}: file missing")
            continue
        load_json(path)
    for rel in (".github/workflows/ci.yml", ".github/workflows/security.yml", ".github/workflows/release.yml"):
        path = ROOT / rel
        if path.exists():
            data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            jobs = data.get("jobs") or {}
            if not jobs:
                errors.append(f"{rel}: no jobs defined")
            else:
                print(f"OK   workflow {rel}: {len(jobs)} job(s): {', '.join(jobs)}")

    check_no_latest()
    check_dockerfiles()
    check_shell_scripts()
    if warnings:
        print("\nWARNINGS (advisory, not failures):")
        for warn in warnings:
            print(f"  - {warn}")

    if errors:
        print("\nFAILED:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        return 1
    print("\nAll configuration files parsed successfully.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
