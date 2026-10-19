# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.x | ✅ security fixes |

## Reporting a vulnerability

**Do not open a public issue.** Report privately to the maintainer (GitHub Security
Advisory → *Report a vulnerability*, or email the address in the repository profile).

Include: affected component/version, reproduction steps or PoC request, impact
assessment, and any suggested fix. You will receive an acknowledgement within 48 h
and a remediation plan within 7 days. Please allow us to fix and release before
public disclosure (coordinated disclosure, 90 days by default).

## Scope

In scope: authentication/session handling, authorization bypass (IDOR, role
escalation), injection (SQL/NoSQL/command/template), SSRF via channel integrations,
webhook forgery, file upload, secret leakage, dependency vulnerabilities, insecure
defaults in `docker-compose.yml`/nginx, tenant/scope isolation, audit-log tampering.

Out of scope: findings that require a compromised host/root, self-XSS without a
victim, missing security headers on non-TLS local dev, volumetric DoS.

## Security requirements for contributors

- Read [`docs/04-security/SECURITY.md`](docs/04-security/SECURITY.md) before touching auth, files, integrations or SQL.
- Never commit secrets, `.env` files, dumps or credentials. Use `.env.example` placeholders.
- Every new endpoint must declare a permission and be covered by a negative test.
- Dependencies: no known `high`/`critical` advisories; `pnpm audit --prod` must pass.
- CI runs: `gitleaks`, `pnpm audit`, `semgrep`, Trivy image scan, CodeQL.

## Secure disclosure credit

We credit reporters in release notes unless requested otherwise.
