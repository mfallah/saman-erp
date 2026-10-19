# ADR-0004 — Authentication & session model

**Status:** Accepted · **Date:** 1405-07-27

## Context

SRS requires mobile-based login with 2FA via Limo SMS, secure sessions and audit. The SPA is served from the same origin as the API. Tokens must survive page reloads but not be readable by XSS.

## Decision

**Two-token model**

| Token | Storage | TTL | Notes |
|---|---|---|---|
| Access JWT | JS memory (never localStorage) | 10 min | `Authorization: Bearer`; claims `sub`, `org`, `sid`, `pv` (permissions version), `scope` |
| Refresh token | `httpOnly`, `Secure`, `SameSite=Lax`, `Path=/api/v1/auth` cookie | 7 days | random 256-bit, stored **hashed** (`sha256`) in `auth_sessions` |

- **Rotation with reuse detection**: every refresh issues a new token and revokes the old one; presentation of a revoked token revokes the whole session family and raises a security event.
- **Session record**: user, device label, IP (truncated /24 or /64), user-agent hash, `created_at`, `last_used_at`, `revoked_at`, `revoke_reason`.
- **2FA**: password (or OTP-only login) → if device untrusted or action sensitive → OTP challenge (`otp_challenges`, 6 digits, 2 min, hashed, single-use, 5/hour, 5 attempts) → session marked `mfa_verified`; trusted devices expire after 30 days.
- **Permission versioning**: role/permission change bumps `users.permissions_version`; API rejects tokens with stale `pv` (`401 PERMISSIONS_CHANGED`) → SPA refreshes silently.
- **CSRF**: cookie is scoped to `/api/v1/auth`, so state-changing business endpoints authenticate only via `Authorization` header (not CSRF-able). `/auth/refresh` additionally verifies `Origin` and a `X-Requested-With` marker.
- **Logout / revoke-all**: `POST /auth/logout` revokes current session; `POST /auth/sessions/revoke-others`; admin can revoke a user's sessions.
- **Passwords**: Argon2id, min 12 chars, zxcvbn score ≥ 3, no reuse of last 5 hashes, breach-list check at set time.
- **Login throttling**: per `(ip, username)` sliding window (Redis) + account lockout (15 min after 10 failures) + exponential delay.

## Consequences

- XSS can still act with a live access token for ≤ 10 min; mitigated by CSP, escaping, dependency hygiene, and audit.
- No server-side session lookup on every request (fast), but revocation of an access token takes ≤ 10 min; sensitive endpoints check the session row.

## Revision — 2026-10-19 (design review round 1, R1-C B-02/B-03 + D-1/D-2)

Accepted changes:
1. **Device trust is server-issued, not client-declared.** `user_devices` gains `device_secret_hash`; trust is granted only when a 256-bit HttpOnly `deviceSecret` cookie (scoped `/api/v1/auth`) matches. `deviceFingerprint` is a display label and must never bypass MFA.
2. **Step-up authentication** is formalized: `POST /auth/step-up` → `X-Step-Up-Token` (5 min, bound to session + action). Required for role/scope edits, credential changes, approval-config changes, break-glass, raw audit/financial export, raw channel payload view. Error `403 STEP_UP_REQUIRED`.
3. **Password reset policy**: no public email/SMS reset in v1. Self-service = authenticated change with current password + step-up; admin-assisted reset requires `user.reset_password`, target's effective permissions ⊆ actor's, step-up, never reveals a password, and delivers a 256-bit single-use token/OTP (10 min, hashed, purpose-bound) to the target user only.
4. `auth_sessions` gains `family_id`, `device_id`, `mfa_verified_at`, `rotated_from`, `ua_hash`, `ip_prefix`; permission cache version is invalidated on role/scope change.

## Alternatives rejected

- Access token in localStorage — XSS-exfiltratable for its whole lifetime.
- Access token also in cookie — needs full CSRF machinery for every write.
- Server-side opaque token per request — extra DB round-trip per API call.
