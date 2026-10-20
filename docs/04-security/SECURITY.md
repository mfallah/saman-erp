# 04 — Security Controls (SECURITY)

**خلاصهٔ فارسی:** این سند کاتالوگ کنترل‌های امنیتی «سامان ERP» است: احراز هویت و نشست، مجوزدهی و تفکیک وظایف، اعتبارسنجی ورودی و خروجی، رمزنگاری و مدیریت کلید، امنیت مرورگر و انتقال، محدودیت نرخ، ممیزی، امنیت داده و پایگاه‌داده، سخت‌سازی زیرساخت و زنجیرهٔ تأمین، پایش و پاسخ به حادثه، و چک‌لیست ASVS 4.0 سطح ۲. هر کنترل یک شناسه، محل پیاده‌سازی مشخص و وضعیت دارد؛ کنترل مبهم یا بدون مالک مجاز نیست. این سند مرجع نهایی (normative) امنیت است و اسناد استقرار و عملیات باید به آن ارجاع دهند.

| Field | Value |
|---|---|
| Status | **Design baseline v1.1 (round-1 remediation)** — normative for P1–P7 implementation |
| Revision | v1.1 — resolves R1-security B-02…B-06, H-01…H-12, M-01…M-10 and integrates R1-accounting integrity constraints; see §17 revision log |
| Owner | Security Lead |
| Reviewers | Lead Architect, Backend Lead, DevOps Lead, QA Lead |
| Last updated | 1405-07-27 |
| Companion | `docs/04-security/THREAT-MODEL.md` (assets, boundaries, abuse cases, risk register) |
| Related | `docs/01-architecture/ARCHITECTURE.md` §9/§10/§13/§14, `docs/adr/0004`–`0014` |

---

## 0. How to use this document

### 0.1 Scope and authority

This document is the **authoritative security control catalog**. Where `DEPLOYMENT.md`, `RUNBOOK.md`, `TESTING.md`, `API.md`, `DATA-MODEL.md` or an ADR describes a weaker control, this document wins — and the delta is recorded in §16 as an *ADR deviation request* / *remaining dependency*. Where a control cannot be implemented as specified, the implementer MUST either implement the listed compensating control or open a deviation with the Security Lead; silently dropping a control is a release blocker.

**Requirement language (RFC 2119/8174).** The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, MAY and OPTIONAL in this document are to be interpreted as described in RFC 2119 and RFC 8174 when, and only when, they appear in capitals. Lower-case "must/should" in narrative prose carries the same intent but the capitalised form is the normative signal. A row marked `planned` names a MUST-level implementation obligation for the phase shown.

**Evidence rule (R1 B-01).** No control is "verified", "done" or "signed off" without an artifact. §9 requires, per control-row, a **route/source file path + test name + CI run id**; a row without all three is not signed. The words "verified" and "implemented" MUST NOT appear in any other document without such an artifact link. `ARCHITECTURE.md` §17 phase status is explicitly *planned* until the corresponding evidence exists (routing dependency to Lead Architect).

All paths are **planned repository targets**. `apps/`, `infra/`, `packages/` are empty skeleton directories at this design baseline; the phase column says when the control must exist (P1 = platform/auth, P2 catalog/inventory, P3 sales/fulfillment, P4 accounting, P5 channels, P6 frontend, P7 hardening — `ARCHITECTURE.md` §17).

### 0.2 Control ID and status scheme

`SEC-<area>-<nn>`. Areas: `AUTH`, `AZ` (authorization), `IN` (input), `OUT` (output), `CRYPTO`, `TLS`, `RL` (rate limiting), `AUD` (audit), `DATA`, `INF` (infrastructure), `SC` (supply chain), `MON` (monitoring/IR), `SDLC`.

| Status | Meaning |
|---|---|
| `planned` | Specified and accepted here; code/config not yet present. Target phase in the table. **This is a commitment, not an aspiration** — the row names the exact file/table/header. |
| `implemented-in-code` | Present in the repository at the named location, **with a route/source file path + test name + CI run id recorded in §9**. At this baseline **no row is `implemented-in-code`** because the implementation tree is empty; a pasted code snippet or a passing design review is NOT evidence (R1 B-01). |
| `roadmap` | Explicitly post-v1.0; a compensating control is named for v1.0. |
| `n/a` | Not applicable to this architecture — with a one-line justification. |

Verification for every row is listed in §9 (sign-off checklist), §14 (ASVS) and the test plan in `docs/05-testing/TESTING.md` (security test set requested in `THREAT-MODEL.md` D-10).

### 0.3 Non-negotiable invariants

1. **Default deny.** A route without an explicit permission policy fails CI; a permission not granted fails at runtime.
2. **No secret in git, image, log, or error**. Ever. `.env` only, and gitleaks blocks the merge.
3. **No customer/business write without an audit row** in the same transaction.
4. **Money and stock are never mutated by an untrusted inbound payload** (webhook/channel/import/URL). They are validated against authoritative state first.
5. **Least privilege at every layer**: DB role, app process, container, network, employee role.
6. **Fail closed for security decisions** (authn/authz/validation); **fail open only where explicitly documented and monitored** (Redis rate-limit fallback, `ARCHITECTURE.md` §13).

---

## 1. Principles and threat summary

The full model is in `THREAT-MODEL.md`. The top threats this catalog addresses: credential stuffing (AC-01), OTP flooding (AC-02), oversell race (AC-04), IDOR across branches (AC-05), channel SSRF (AC-06), webhook forgery (AC-07), malicious upload (AC-08), SQLi (AC-09), stored XSS (AC-10), role-edit privilege escalation (AC-11), backup exfiltration (AC-12), insider journal fraud (AC-13), session replay (AC-14), supply-chain compromise (AC-15), **device-trust forgery (AC-16, R1 B-02)**, **password-reset takeover (AC-17, R1 B-03)**, **approval-config tampering (AC-18, R1 B-04)**, **outbound-webhook exfiltration (AC-19, R1 H-04)** and **secrets disclosure via container inspection (AC-20, R1 H-11)**. The round-1 review (`docs/_review/round-1/R1-security.md`) is dispositioned in §17; `R1-accounting.md` integrity requirements (VAT/COGS posting, GRNI, period/date integrity, posted-document immutability, journal header totals) are normatively routed into SEC-DATA-15/§8.2 so the books remain auditable.

Design principles applied throughout:

| Principle | Concrete expression in Saman ERP |
|---|---|
| Defense in depth | JWT short TTL **and** CSP **and** audit; DB constraint **and** service validation **and** UI masking |
| Least privilege | `saman_app` no DDL/no superuser; container non-root/read-only; per-adapter minimum scopes |
| Secure default | `APP_ENV=production` forces secure cookies, docs off, `SMS_MODE=limo` guard, verbose errors off, secret-file required |
| Separation of duties | requester ≠ approver at DB-constraint level; finance ≠ stock |
| Minimize attack surface | same-origin SPA, no third-party JS in production, only ports 22/80/443 exposed |
| Detect over prevent where prevention is impossible | audit hash chain, anomaly alerts, offsite immutable backups |
| Recoverability as a security property | RPO ≤ 15 min, quarterly restore drill, incident runbook |

---

## 2. Authentication

### 2.1 Password storage — SEC-AUTH-01

**Control.** Passwords are hashed with **Argon2id** only, using the OWASP-recommended-or-stronger profile: `memoryCost = 65536` (64 MiB), `timeCost = 3`, `parallelism = 1`, `hashLength = 32`, 16-byte random salt, PHC-string output. Parameters are calibrated at deploy time to **~250 ms ± 50 ms** on the target 4-vCPU host (`pnpm tsx scripts/calibrate-argon2.ts`). If calibrated values differ from the defaults, the calibrated values are recorded in `docs/07-operations/RUNBOOK.md` and used for new hashes.

**Location.** `apps/api/src/modules/identity/auth/password.service.ts` (uses `@node-rs/argon2`; no native build scripts — see SEC-SC-01); verification uses the stored PHC parameters (supports rehash-on-login to the current profile).

**Rules.** Constant-time verification (library); rehash-on-login when parameters change; no password value in logs, exceptions, or audit `before_data` (SEC-AUD-03); `SEC-AUTH-13` policy applies at set/change only (never on read).

### 2.2 Access token and refresh session — SEC-AUTH-02, 08

**Access token.** JWT, 10-minute TTL (`JWT_ACCESS_TTL`), `HS256` signed with `JWT_ACCESS_SECRET` (64-byte random; rotation with a short dual-verify window — SEC-CRYPTO-04), `RS256`-ready. Claims: `iss` (`saman-erp`), `aud` (`api`), `sub` (user `public_id`), `org`, `sid` (session `public_id`), `pv` (`permissions_version`), `scope` (`branchIds`, `warehouseIds`), `amr` (`pwd`, `otp`), `exp`, `iat`, `jti`. Stored **only in JS memory** on the SPA; never `localStorage`/`sessionStorage`/non-httpOnly cookie. Bearer header only.

**JWT verification hardening (SEC-AUTH-16; MUST — R1 L-04).** Verification is configured once in `apps/api/src/modules/identity/auth/token.service.ts`: `jwtVerify(token, keyFor(kid), { algorithms: [algorithmForKeyType], audience: 'api', issuer: 'saman-erp' })`. The accepted algorithm is derived from the **trusted keyring entry**, never from the token header — `alg:none`, header-chosen algorithms and HS/RS public-key confusion are rejected; an unknown `kid` is `401`. `jti` is checked against a Redis revocation set (`jti:revoked:{jti}`, TTL = remaining token lifetime) on the sensitive-action routes listed below, so a stolen access token can be killed before its 10-minute expiry; on ordinary routes the expiry-bound risk is accepted (`ADR-0004` consequence).

**Session record.** `auth_sessions` (per `ADR-0004`, extended per `THREAT-MODEL.md` D-1/D-11): `id`, `public_id`, `user_id`, `family_id`, `device_id` (NOT NULL), `token_hash` (unique), `ip_prefix` (truncated `/24` v4, `/64` v6), `ua_hash`, `created_at`, `last_used_at`, `expires_at`, `revoked_at`, `revoke_reason`, `mfa_verified_at`. Refresh token = 256-bit CSPRNG (SEC-CRYPTO-15), sent only as the cookie; the DB stores `sha256(REFRESH_PEPPER ‖ token)` as `token_hash` (constant-time compare).

**Refresh rotation (SEC-AUTH-06).** Every `POST /auth/refresh` issues a new token, marks the old row `rotated_at`/revokes it, and links `rotated_from`. Presenting a **revoked** token → revoke the entire `family_id` (all descendant sessions), write `security_events` row `auth.refresh.reuse_detected`, increment `SEC-MON-02` counter, return `401 SESSION_REVOKED` with no detail. Grace window: a second presentation within **10 s** from the same `sid`+UA returns the same new token (network-retry safety) — outside that it is reuse.

**Session validation (SEC-AUTH-08).** Normal requests verify the JWT signature/exp/`pv` only (10-minute revocation tolerance, `ADR-0004` consequence). The following **always** load the session row and reject if `revoked_at IS NOT NULL` or `expires_at < now()`: `/auth/*` (except login), permission/role changes, approval decisions, channel credential read/write, journal post/reverse, export generation, session listing. This is the step-up path (`SEC-AUTH-05`).

### 2.3 Lockout and login throttling — SEC-AUTH-03

| Rule | Value | Where |
|---|---|---|
| Account lockout | 10 consecutive failures → locked 15 min (`users.locked_until`) | `login.service.ts` |
| Progressive delay | after 3 failures: +1 s, +2 s, +4 s (capped 4 s) before verifying | same |
| Per-IP login window | 20 attempts / 10 min (distributed per username also counted: 10 / 10 min per `(ip, username)`) | `SEC-RL-01` |
| Global per-username | 50 attempts / hour (catches botnets) | Redis |
| Unlock | automatic after window; admin unlock + `auth.unlock` audit | `users.controller.ts` |
| Reset on success | `failed_login_count = 0`, `last_login_at = now()` | same |
| Alert | **SEC-MON-02** thresholds | `apps/api/src/common/security/security-metrics.ts` |

Lockout responses use the generic `401 INVALID_CREDENTIALS` (never "locked"/"user not found" — SEC-AUTH-10). Admin lock/unlock actions are audited.

### 2.4 OTP (SMS) — SEC-AUTH-04, 12

| Property | Value |
|---|---|
| Code | 6 digits, CSPRNG (`crypto.randomInt`), never `Math.random` |
| TTL | 120 s; one active code per `(mobile, purpose)` — sending a new code invalidates the previous |
| Storage | `otp_challenges.code_hash = HMAC-SHA256(OTP_PEPPER, "${mobile}:${purpose}:${code}")`, constant-time compare |
| Attempts | max **5** verify attempts per challenge; on exceed → `status='locked'`, new challenge required, audit `otp.verify.exhausted` |
| Single use | `verified_at` + `status='consumed'`; a consumed challenge can never be verified again |
| Send limit | 5 / hour / mobile, 3 / 2 min / mobile, 20 / hour / IP (`SEC-RL-02`) |
| Budget | org daily SMS cap (default 2 000, `system_settings.sms_daily_budget`); on exhaustion: 429 `SMS_BUDGET_EXHAUSTED`, alert `SEC-MON-08` |
| Purpose binding | Seeded lookup `otp_challenge_purposes` (not a CHECK string — R1 M-01): `login`, `mfa`, `step_up`, `sensitive_action`, `password_change`, `password_reset`, `device_trust`, `channel_credential_change`, `journal_close`, `period_close`; purpose is part of the OTP hash and the challenge row |
| Provider | Limo `/api/sendcode` (fixed message, no user-controlled text — `limo-sms.txt`). `SMS_MODE=mock`: in `development` the code is printed to the local log for convenience; in `test` it is returned only to the test harness; in `staging`/`production` mock is forbidden — the API refuses to boot if `APP_ENV=production && SMS_MODE!=live` |
| Logging | code, hash, and full mobile never logged (`SEC-CRYPTO-06`); `sms_messages` stores provider id and masked mobile only |

**Anti-enumeration (SEC-AUTH-10).** `POST /auth/otp/request` always returns `202 {"request_id": "..."}` in constant-ish time regardless of whether the mobile belongs to a user. For unknown mobiles the SMS is not sent; the delay is padded to the median send latency (200–600 ms, configurable jitter) to avoid timing oracles. Login failures never distinguish "wrong password" from "not OTP-verified" from "unknown user".

### 2.5 MFA, device trust, step-up — SEC-AUTH-05, 07

- **Enrollment/trust:** first successful password+OTP login on a new device creates `user_devices` (device label, display fingerprint, `device_secret_hash`, first/last seen, expires 30 days, `revoked_at`). New-device login **always** requires OTP. Trusted-device login may skip OTP **only for read-only sessions**; any sensitive action requires `mfa_verified_at` within 15 min. Trust MUST be bound to the server-issued device secret (`SEC-AUTH-14`), never to a client-declared fingerprint.
- **Server-issued device secret (SEC-AUTH-14; MUST — R1 B-02):** the `deviceFingerprint` value accepted by the API is a *display label only*; device trust requires the server-issued `__Secure-saman_dev` secret described in §2.9. A request that presents a correct password and a copied/guessed fingerprint but no matching device secret MUST receive a 202 MFA challenge, never tokens.
- **Sensitive actions requiring fresh OTP/step-up:** password change/reset, role/permission/scope change, user disable, channel credential or account-setting change, approval decision, approval-workflow/threshold change, manual journal post/reverse, period close/reopen, export > 1 000 rows or containing cost/PII, session revoke-all, API-client create, backup restore trigger, raw channel payload view. Server returns `403 STEP_UP_REQUIRED` + `X-Step-Up-Purpose`; SPA opens the OTP dialog and retries once with `X-Step-Up-Token`.
- **Mandatory MFA roles:** `superadmin`, `admin`, `finance_manager` may not hold a valid non-MFA session for sensitive routes; enforced by `@RequireMfa()` guard reading `mfa_verified_at` on the session.
- **IP/UA change:** a request from a different IP-prefix **and** different UA hash than the session's last use forces step-up and emits `security_events` row `auth.session.anomaly`; the session is not killed automatically (avoids mobile-network lockouts) but is flagged.
- **Break-glass:** the sealed emergency account is governed by §2.12 (`SEC-AUTH-17`), not by ordinary login.

### 2.6 Session revocation and offboarding — SEC-AUTH-09

| Action | Endpoint | Effect |
|---|---|---|
| Logout | `POST /auth/logout` | revoke current session + clear cookie |
| Revoke others | `POST /auth/sessions/revoke-others` | all sessions of the user except current |
| List sessions | `GET /auth/sessions` | own sessions: device label, last IP prefix, last used, current marker |
| Admin revoke user | `POST /users/{id}/sessions/revoke` | requires `identity.session.revoke` + audit |
| Deactivate user | `PATCH /users/{id}` (`status='disabled'`) | transactionally revokes all sessions, bumps `permissions_version`, invalidates refresh families |
| Offboarding procedure | `docs/07-operations/RUNBOOK.md` §"Offboarding" | disable user, revoke sessions **and device trust** (`user_devices`), remove SSH key, rotate shared secrets if the leaver had access, confirm 0 active sessions |

Access tokens die within 10 min; the sensitive-action list (§2.2) checks the session row immediately.

### 2.7 Session lifetime and idle timeout — SEC-AUTH-11

| Class | Access TTL | Refresh absolute | Idle timeout |
|---|---|---|---|
| Office SPA | 10 min | 7 days | 60 min |
| Warehouse tablet | 10 min | 12 h | 15 min (scanner flows re-auth per shift with a 4–6 digit PIN + periodic OTP) |
| `superadmin` | 10 min | 8 h | 15 min |
| API client (machine) | n/a (opaque bearer, 1 h) | rotate 90 d | n/a |

Idle is tracked server-side on `last_used_at`; the SPA also locks the screen. A session beyond idle is revoked on next use with `401 SESSION_EXPIRED`.

### 2.8 Password policy and breach list — SEC-AUTH-13

- Minimum **12** characters, maximum 128 (Do **not** truncate silently; reject > 128). No composition rules (length + breach check + zxcvbn is stronger and modern per NIST SP 800-63B).
- `zxcvbn-ts` score **≥ 3** required; reject if it contains the username, email, mobile, org name, or `saman`/`erp`, or a sequence of > 3 repeated characters.
- **Breach list:** at set time, check against an offline bundled list (`packages/shared/src/security/pwned-sha1.txt`, top 100k breached passwords, SHA-1 prefixes, updated quarterly via Renovate PR) **and** the HIBP k-anonymity range API when outbound access is available (`packages/shared/src/security/pwned.ts`, 2 s timeout, fail **open** with an audit note — availability trade-off), plus the org-internal `password_history`.
- No reuse of the **last 5** hashes (`password_history`). No forced periodic rotation (only on compromise/suspected compromise; forced change for new users at first login: `must_change_password`).
- Password change requires current password + step-up OTP; all other sessions revoked on change; audit `auth.password.changed` (never the value).
- Password reset follows §2.10 (`SEC-AUTH-15`) — **no public self-service reset in v1**; resets are admin-assisted with a subset check and delivered only to the user's verified mobile. A temporary password is random 20+ chars, `must_change_password=true`, expires in 72 h, and is never displayed to the admin.

### 2.9 Server-issued device secret and device-bound trust — SEC-AUTH-14

R1 B-02 closed here; normative regardless of what `API.md` §2 currently lists.

1. **Secret issuance.** On first successful OTP verification for a device, the API generates a 32-byte CSPRNG secret, stores only `user_devices.device_secret_hash = HMAC-SHA256(OTP_PEPPER, secret)` (constant-time compare), and sets `__Secure-saman_dev` (HttpOnly, Secure, SameSite=Lax, `Path=/api/v1/auth`, Max-Age 180 days, rotated on each trust renewal/step-up success).
2. **Trust decision (login + step-up):** password/OTP auth succeeds → the server evaluates trust *only* if the device cookie is presented **and** its hash matches a non-revoked, non-expired `user_devices` row for the same `user_id` **and** the browser is the same UA family; otherwise a `202 MFA_REQUIRED` challenge is returned. The client-supplied `deviceFingerprint` is stored as a display label (`device_fingerprint_hash`) and MUST NOT influence the trust decision, OTP skip, or authorization.
3. **Binding.** `auth_sessions.device_id` is NOT NULL and survives refresh rotation. Trust is revoked when: the device row is revoked by the user/admin, the password or role/scope changes, the user is disabled, or 30 days pass. Revoking a device revokes its sessions in the same transaction.
4. **Response discipline.** `MFA_REQUIRED` is returned for "no cookie", "wrong secret", "unknown device" alike (no oracle). Failed device-secret matches emit `security_events` `auth.device.secret_mismatch` (sampled after 5/min per user) and count toward the login throttle.
5. **Schema dependency:** `user_devices.device_secret_hash`, `auth_sessions.device_id NOT NULL` (`THREAT-MODEL.md` D-12 to db-architect). **Tests:** correct password + victim fingerprint + no device cookie ⇒ 202 MFA (not tokens); replayed device cookie from another user ⇒ 202; revoked device ⇒ 202; trusted device + sensitive action ⇒ step-up.

### 2.10 Password reset policy — SEC-AUTH-15

R1 B-03 closed here. **One policy, no public self-service reset in v1:**

1. **No public reset endpoints.** `POST /auth/password/forgot` and `POST /auth/password/reset` MUST NOT exist in v1 (`404`), because an OTP-only public reset would hand an SMS-interception attacker a finance session without MFA (accepted risk AS-06). Routing delta to `API.md` (D-9). A self-service flow may be added later only with the token spec in step 4 plus a DPIA and Security Lead approval.
2. **Admin-assisted initiation.** A new permission `identity.user.reset_password` (distinct from `identity.user.update`) plus `@RequireMfa()` allows an admin to start a reset. The admin MUST NOT reset a user whose **effective permission set is not a subset of the admin's own** (no resetting a `superadmin`/higher role), MUST NOT reset their own account through this path, and the request is audited (`auth.password.reset_requested`).
3. **Delivery.** The system generates a 32-byte single-use reset token stored **hashed** (`sha256`), TTL 15 min, bound to `(user_id, device_id, purpose='password_reset')`. The token is delivered to the user's verified mobile through the OTP/reset SMS pattern — **never returned to the admin, never in a response body, log, or audit row**. The admin response is only `{requestId, expiresAt}`.
4. **Completion.** A reset MUST present the token **and** a fresh OTP with `purpose='password_reset'`; on success: set the new password policy checks, `must_change_password=false`, revoke **all** sessions and all trusted devices, bump `permissions_version`, reset `failed_login_count`, audit `auth.password.reset_completed`. A temporary-password path (admin-created user) generates 20+ random chars, `must_change_password=true`, 72 h expiry, and is shown to the user only through the same verified channel — never to the admin.
5. **OTP purposes** are a seeded lookup (`otp_challenge_purposes`), not a CHECK string (R1 M-01): `login`, `mfa`, `step_up`, `sensitive_action`, `password_change`, `password_reset`, `device_trust`, `channel_credential_change`, `journal_close`, `period_close`. The purpose is part of the OTP hash and is validated on consumption.
6. **Rate tiers** for reset completion are listed in §7.1 (`password-reset`, `mfa-verify`). **Tests:** public endpoints 404; admin cannot reset higher-privileged user or self; token single-use/TTL/binding; sessions+devices revoked; audit rows present without any secret.

### 2.11 JWT verification and access-token replay — SEC-AUTH-16

See §2.2. Normative points: fixed algorithm allowlist derived from the trusted key, `aud`/`iss` validation, `alg:none` and algorithm confusion rejected per RFC 8725 (JWT BCP), unknown `kid` rejected, `jti` revocation checked on the sensitive-action routes. Tokens are never accepted from query strings, cookies, or `Referer`; only `Authorization: Bearer`. Verification failures are `401` and emit sampled `auth.token.invalid` events (no token contents in logs).

### 2.12 Break-glass hardening — SEC-AUTH-17

R1 M-07 closed here. Break-glass is **offline + two-person**, not an in-band elevation.

1. `FEATURE_BREAK_GLASS=false` by default; enabling it is a separate deploy-time config change with Security Lead approval, and the switch is audited.
2. Credentials for the sealed `superadmin` are held offline (two custodians, split custody). A session requires: custodian A runs `pnpm breakglass:request` on the host (writes an approval request), custodian B approves with `pnpm breakglass:approve --request <id>` over a different channel; **both** approvals and a valid password+OTP from the sealed account are required. No web-only path.
3. Issued session: `actor_type='break_glass'`, `amr=['break_glass']`, max 60 min, **session row is checked on every request** (no JWT-only window), and it MUST be revoked at incident end.
4. **Denylist:** break-glass sessions MUST NOT create/modify users or roles, read or rotate credentials/keys, export data, delete/void documents, change approval workflows/thresholds, or approve their own requests. SoD checks are preserved, not skipped.
5. Alerts on request, approval, token issuance and every break-glass write go to all admins and the Security Lead (multi-channel), and a post-incident review ticket is mandatory within 24 h. Every event is in the 10-year audit archive.

### 2.13 Authentication summary

| SEC ID | Control | Location | Phase | Verify |
|---|---|---|---|---|
| SEC-AUTH-01 | Argon2id params + rehash | `apps/api/src/modules/identity/auth/password.service.ts` | P1 | unit test: hash/verify/rehash; calibrated params recorded |
| SEC-AUTH-02 | 10-min JWT in memory only | `apps/api/src/modules/identity/auth/token.service.ts`, `apps/web/src/lib/auth-store.ts` | P1 | E2E: token absent from storage; CSP test |
| SEC-AUTH-03 | Lockout + progressive delay | `login.service.ts` | P1 | integration: 10 failures → 423/401 + lock; rate test |
| SEC-AUTH-04 | OTP hashing/TTL/attempts/single-use | `modules/identity/otp/otp.service.ts` | P1 | unit: expiry, attempts, replay, constant-time |
| SEC-AUTH-05 | MFA/step-up/2FA roles | `common/guards/require-mfa.guard.ts` | P1 | integration matrix per sensitive route |
| SEC-AUTH-06 | Refresh rotation + reuse detection | `auth/session.service.ts` | P1 | test: reuse revokes family; grace window |
| SEC-AUTH-07 | Device trust + anomaly flag | `auth/device.service.ts`, `user_devices` (+ §2.9 device secret) | P1 | test: new device OTP required; copied fingerprint without device cookie ⇒ 202; IP/UA change → step-up |
| SEC-AUTH-08 | Session row checked on sensitive routes | `common/guards/session.guard.ts` | P1 | integration: revoked session → 401 |
| SEC-AUTH-09 | Revocation + offboarding | `auth.controller.ts`, `users.controller.ts` | P1 | E2E: revoke-all, disable-user |
| SEC-AUTH-10 | Anti-enumeration generic responses | `auth.controller.ts`, `otp.service.ts` | P1 | test: identical status/body/timing bucket |
| SEC-AUTH-11 | Idle/absolute session limits | `session.service.ts`, config table | P1 | test: idle expiry per class |
| SEC-AUTH-12 | OTP send limits + SMS budget | `otp.service.ts`, `rate-limit` policy | P1 | test: 6th send → 429; budget stop |
| SEC-AUTH-13 | Password policy + breach list + history | `password-policy.ts`, `packages/shared` | P1 | unit: policy matrix; breach fixture |
| SEC-AUTH-14 | Server-issued device secret + device-bound trust (R1 B-02) | `auth/device.service.ts`, `user_devices.device_secret_hash`, `__Secure-saman_dev` cookie | P1 | test: copied fingerprint without device cookie ⇒ 202 MFA; revoked device ⇒ 202 |
| SEC-AUTH-15 | Password-reset policy: no public reset; admin-assisted token+OTP; no privileged-target reset (R1 B-03) | `auth/password-reset.service.ts`, `otp_challenge_purposes`, permission `identity.user.reset_password` | P1 | test matrix: 404 public endpoints; subset check; token TTL/single-use; sessions+devices revoked |
| SEC-AUTH-16 | JWT verification hardening: fixed alg from key, `aud`/`iss`, `jti` revocation, RFC 8725 (R1 L-04) | `auth/token.service.ts` | P1 | unit: alg:none/confusion/unknown-kid rejected; revoked jti ⇒ 401 |
| SEC-AUTH-17 | Break-glass: offline + two-person approval, checked session, denylist, kill switch (R1 M-07) | `auth/breakglass.service.ts`, `scripts/breakglass-*.ts`, `FEATURE_BREAK_GLASS` | P1 | test: single-custodian request cannot issue tokens; denylisted actions 403; audit + alerts |

---

## 3. Authorization

### 3.1 Permission registry and guards — SEC-AZ-01, 02, 03

**Registry.** The single source of truth is `packages/shared/src/permissions.ts`: a frozen map of `permissionKey → { module, description, scopeable, sensitive }`. `resource.action` naming (`ARCHITECTURE.md` §5). Seeds are idempotent (`pnpm db:seed`, `ADR-0008`); `permissions` rows are inserted from the registry and **never deleted** (deprecation marks `retired_at`). Adding a permission requires: registry entry → seed → role template → API decorator → SPA menu entry. Unknown keys in the DB = drift; a CI check (`scripts/check-permissions.ts`) fails the build if DB seed and registry diverge.

**Guards.** Global `AuthGuard` (JWT) → global `PermissionsGuard` (default deny) → optional `ScopeGuard` → optional `RequireMfaGuard` → `PermissionsGuard` reads the decorator metadata. A route with no `@Permissions()` or `@Public()`/`@Webhook()` marker is a **build error** (custom ESLint rule `saman/require-permission`). Guards are registered globally in `apps/api/src/common/guards/` so a module cannot accidentally skip them; `@Public()` is limited to health, `/auth/login|otp|refresh`, SPA static; `@Webhook()` is limited to the webhook controllers and still enforces signature verification (`SEC-IN-11`).

```ts
// apps/api/src/modules/inventory/controllers/adjustment.controller.ts (pattern)
@Controller('inventory/adjustments')
export class AdjustmentController {
  @Post()
  @Permissions('inventory.adjust')
  @Scope({ warehouse: true })
  @RequireMfa()
  @Audit({ action: 'inventory.adjustment', entity: 'inventory_transactions' })
  create(@Body() dto: CreateAdjustmentDto, @Ctx() ctx: RequestContext) { … }
}
```

**Deny and not-found behavior (SEC-IN-08, SEC-AZ-03).** A missing permission returns `403 FORBIDDEN`; a resource outside the actor's scope returns `404 NOT_FOUND` (prevents existence probing). Both are audited (`SEC-AUD-04`). No endpoint leaks internal `bigint` ids — API responses only expose `public_id` (`ADR-0003`).

### 3.2 Scope narrowing — SEC-AZ-04, 10

`TenantContext` (`{ orgId, actorId, actorType, branchIds, warehouseIds, permissionsVersion }`) is built **only** from the verified JWT + session row by `RequestContextMiddleware`, never from request body/query. Repositories accept it as the first argument and apply `where organization_id = ctx.orgId` plus, for scopeable resources, `branch_id = ANY(ctx.branchIds)`/`warehouse_id = ANY(ctx.warehouseIds)`. A user with `scope='all'` gets `branchIds = null` (meaning unrestricted **within the org**).

Enforcement is structural, not disciplinary:

1. `packages/db/src/repository-base.ts` exposes the only query builders that accept a `TenantContext`.
2. ESLint rule `saman/no-raw-db-access` fails on `db.select()/insert()/update()/delete()` outside `*.repository.ts` (SEC-AZ-10).
3. Integration test suite `apps/api/test/security/scope.spec.ts` iterates every `*.repository.ts` and asserts a scope-filtered query is generated (snapshot of SQL AST) — adding a repository without scoping fails CI.
4. Composite FKs `(organization_id, id)` on orders, reservations, ledger, journals prevent cross-org references even on a bug (`ADR-0005`).

### 3.3 Permission cache — SEC-AZ-05, 09

Resolved permission sets are cached in Redis: key `perms:{orgId}:{userId}:{pv}`, TTL 5 min (defense against a missed invalidation). Any role/permission/user-role change increments `users.permissions_version` **inside the same transaction** as the change (`ADR-0008`); the next request computes a new key. The cache is a derived value only — a poisoned/forged cache entry can grant nothing because the `pv` claim in the JWT must match `users.permissions_version`, and forging that claim requires the JWT signing key (SEC-CRYPTO-04). Redis down → read through to DB (fail closed to DB, not to "allow"); see SEC-RL-08.

`401 PERMISSIONS_CHANGED` is returned when `pv` is stale; the SPA silently refreshes the token and retries once.

### 3.4 Field-level protection — SEC-AZ-06

Costs, purchase prices, margins, partner profit shares, and customer national IDs are masked **in the serializer**, not in the UI. `apps/api/src/common/serializers/` declares per-module serializers (`ProductSerializer`, `OrderSerializer`, …). A field marked `sensitive: 'catalog.cost.read'` is omitted entirely (not nulled, not zeroed) unless the caller holds the permission. Implementation contract:

- The serializer receives the actor's permission set (already resolved by the guard) and a `SensitiveFieldsPolicy`; it never receives the raw DB row for sensitive tables when the permission is absent (repository selects the safe column set via a projection map).
- Order/report exports run the same serializer; an export cannot bypass masking (`export.service.ts` uses the same projection).
- Cost columns (`product_costs`, `purchase_price`, `journal_lines` on COGS accounts) are behind the same permission; `saman_readonly` reporting views expose only masks (SEC-DATA-08).
- QA matrix: for each role in `README.md` §4, assert every forbidden field is absent from every list/detail/export response (see `docs/05-testing/TESTING.md`).

### 3.5 Separation of duties and approval matrix — SEC-AZ-11

| Action | Requester role(s) | Approver role(s) | Approval rule | DB constraint |
|---|---|---|---|---|
| Manual journal ≥ `approval.journal_threshold` (default 500,000,000 IRR) | `accountant`, `finance_manager` | `finance_manager` **≠ requester**, or `admin` | 2 steps if ≥ 5× threshold | `approval_requests.requested_by <> approval_actions.actor_id` (trigger) |
| Journal reversal | `accountant` | `finance_manager` | always | same |
| Stock write-off / adjustment above `approval.writeoff_threshold` | `warehouse_manager` | `admin`/`finance_manager` | 1 step | same |
| Refund | `sales_agent` | `finance_manager` | always | same |
| Channel credential change | `admin` | second `admin`/`superadmin` | always + step-up | same |
| Price rule activation | `finance_manager` | `admin` | always | same |
| Period close / reopen | `finance_manager` | `admin` | reopen always | audit + step-up |
| User role change | `admin` | — (step-up + audit) | cannot grant unseen permissions | `SEC-AZ-07/15` |
| Approval workflow / threshold config change | `admin` with `approval.config.manage` | second `admin`/`superadmin` (2-person) | always + step-up + 24 h cooling before it can gate a new request | immutable `data_versions` snapshot (`SEC-AZ-16`) |
| Export / report run (any seeded report) | any role holding the report's `required_permissions[]` | — | per-report and per-entity permission, never a single `report.run` | `SEC-AZ-17` |
| API-client creation / rotation | `admin` | — (step-up + audit) | scopes ⊆ actor's permissions | `SEC-AZ-18` |

DB-level requirements for this matrix (R1 B-04 — enforce in the database, not only in the app):

- `journal_entries.approval_id` is **NOT NULL when the amount crosses the configured threshold**, enforced by a deferred constraint/trigger; `erp.post_journal()` validates that the approval exists, is for the same document type/amount window, is not expired, and that the approver is not the requester — a `post` without a valid approval row is rejected by the DB even if the API check is bypassed.
- `approval_requests.requested_by <> approval_actions.actor_id` trigger remains, and approval actions themselves require step-up (`SEC-AUTH-05`).
- `posting_rules`/`posting_rule_lines` are versioned (`rule_version_id`), immutable once used, and changing them is an approval-governed config change; every journal stores the `rule_version_id` it was posted with.
- Accounting-period close/reopen is approval-governed and writes an append-only `accounting_period_events` row (reason, actor, approver) in the same transaction (R1-accounting M-17); this table is append-only like the audit trail (`SEC-DATA-05`).

Implementation: `approval_workflows`/`steps`/`requests`/`actions` (`ADR-0008`); `apps/api/src/modules/platform/approvals/`. A trigger on `approval_actions` raises if `actor_id = approval_requests.requested_by`. Every approval decision is audited, and the approved action is executed by a **worker job** carrying the approval id (idempotent), not by the approver's request.

### 3.6 Privilege escalation guards — SEC-AZ-07, 08, 12

- **No privilege amplification:** when granting a permission set, the guard computes `requested \ actor.effectivePermissions`; non-empty → `403 FORBIDDEN_PERMISSION_ESCALATION` (unless actor is `superadmin`, and even then only `superadmin` can create `superadmin`). This blocks AC-11.
- **System roles immutable:** `roles.is_system = true` (`superadmin`, the 7 seeded roles) cannot be edited or deleted; API rejects with `409 SYSTEM_ROLE_IMMUTABLE`; DB trigger `trg_roles_system_immutable`.
- **Self-modification:** a user may not change their own roles, disable their own account, or approve their own request (`SEC-AZ-11`); may not remove the last active `superadmin` (count check in transaction).
- **Sensitive accounting actions (SEC-AZ-12):** `accounting.journal.post|reverse`, period close, and `accounting.period.reopen` require `@RequireMfa()` and an approval or explicit second factor; the `saman_app` DB role additionally cannot `UPDATE` posted journals (`SEC-DATA-04`).
- **Service accounts/API clients:** `api_clients` hold explicit scopes only (no wildcard in v1), hashed keys (`client_key_hash`), rotation 90 days, and are audited; they are never used by the SPA. The machine-auth contract is §3.11 (`SEC-AZ-18`).
- **Scope-change immediacy (R1 M-10):** any change to a user's branch/warehouse scope bumps `users.permissions_version` **and revokes that user's refresh sessions in the same transaction**; `ScopeGuard` re-reads the effective scope on every scoped mutation. A narrowed operator therefore cannot write to the removed warehouse on the next request (test: narrow scope ⇒ next write `401/403`), and a widened scope is not silently delayed to the next refresh.
- **Approval config is a privileged object (R1 B-04):** see §3.9. No actor may both edit a workflow/threshold and have the resulting document posted without a second approver.

### 3.7 Permission-registry conformance — SEC-AZ-14

R1 B-06 closed here; this section is normative over any table in `API.md` or `DATA-MODEL.md`.

1. **One registry.** `packages/shared/src/permissions.ts` is the single machine-readable source of truth (keys, module, description, scopeable, sensitive, `reserved`). The permission tables inside `API.md` §5.2 and `DATA-MODEL.md` §6.2 MUST be deleted and replaced by a reference to this file + the generated seed. Two normative registries are prohibited.
2. **Key grammar and matching.** `resource.action` only (`ck_permissions_key_format`); matching is **exact string equality** — no prefix, suffix, wildcard or pattern matching in guards, role expansion, seeds or the SPA. `reserved:true` keys are allowed in the registry (planned features) but MUST NOT be assigned to a role and MUST NOT match a route.
3. **No route-only/public keys.** `auth.*` and `device.trust` keys MUST NOT exist in the registry; those endpoints are `@Public()`. A route marked `@Public()` MUST NOT be reachable with a permission key as an alternative path.
4. **Bidirectional CI parity** (`scripts/check-permissions.ts` in the `security`/`lint` job): (a) every `@Permissions()` key on every route ∈ registry; (b) every non-reserved registry key is used by ≥ 1 route; (c) every role-template/manifest key ∈ registry; (d) registry count is asserted in one place (single expected number) rather than in prose; (e) the DB seed diff is empty. Any failure blocks merge.
5. **Reconciliation owner:** API and data-model owners MUST reconcile the overlapping key sets against this registry before P1 exit; the Security Lead signs the reconciled registry. Until then the count in either document is non-authoritative.

### 3.8 Role and scope change authorization — SEC-AZ-15

R1 H-01 and M-10 closed here. These rules MUST be enforced on **every** endpoint that changes roles, permissions, user-role assignments or scope (`POST /roles`, `PUT /roles/{id}/permissions`, `PUT /users/{id}/roles`, `PUT /users/{id}/scope`, role create/update/delete, API-client scope changes):

1. `@RequireMfa()` + a fresh step-up token (`X-Step-Up-Token`) are REQUIRED; a stolen 10-minute access token alone is insufficient.
2. Server-side subset check: `requested ⊆ actor.effectivePermissions` **and**, for user-role edits, `targetUser.currentPermissions` must also be a subset of the actor's permissions (you cannot strip or alter privileges you do not hold); only `superadmin` may grant `superadmin`; the last active `superadmin` cannot be removed (`SEC-AZ-08`).
3. Every failure is `403 FORBIDDEN_PERMISSION_ESCALATION` in addition to the existing `RULE_VIOLATION`/`VALIDATION_ERROR` rows in the API contract; request bodies that self-assign roles are rejected; no self-role-edit.
4. Same-transaction `users.permissions_version` bump for both roles and scope; scope changes also revoke the target user's refresh sessions (immediacy, `SEC-AZ-15`/M-10).
5. Audit: `identity.role.permissions_changed`, `identity.user.roles_changed`, `identity.user.scope_changed` with before/after diff (redacted) and `request_id`; alert on privilege expansion for `superadmin`/`admin`/`finance_manager` (§7.2).

### 3.9 Approval-configuration protection and DB-level separation of duties — SEC-AZ-16

R1 B-04 closed here. Maker-checker is only as strong as the configuration it runs on:

1. **Config object.** Approval workflows/steps, thresholds (`approval.journal_threshold`, `approval.writeoff_threshold`, refund/channel rules), the SoD matrix and posting-rule activation are security-critical configuration. Changing them REQUIRES the new `approval.config.manage` permission + `@RequireMfa()` + a **two-person approval** through a dedicated `config_change` workflow + a **24-hour cooling period** before the new configuration can gate any request. The change is snapshotted immutably in `data_versions` with `effective_from`; the previous version is retained.
2. **DB-enforced approval.** For journals above threshold, `journal_entries.approval_id` is NOT NULL (deferred check) and `erp.post_journal()` validates approval existence/type/amount/expiry and `approver ≠ requester`. A journal that bypasses the workflow cannot be posted by API or by direct SQL from the app role.
3. **Disjoint author/post duties.** `*_post`, `*_approve`, `*_execute` keys MUST be disjoint from `*.create/update` for the same document type in code-enforced SoD: at post/approve time the guard denies if the actor also authored the document and holds the authoring key for that type, even if a role template was mis-edited. Exceptions require `superadmin` + approval + audit (break-glass denylist still applies).
4. **No self-service threshold raise.** Raising a threshold to cover a pending document, or editing a workflow that has pending requests, is rejected; in-flight requests use the config version captured at request time.
5. **Tests:** finance_manager edits workflow to remove a step ⇒ rejected/requires second approver; 1 bn IRR journal without `approval_id` ⇒ DB error; self-approval ⇒ denied; config change without cooling ⇒ not effective.

### 3.10 Export, report and dashboard authorization — SEC-AZ-17

R1 H-02 and H-09 closed here.

1. **Generic exports derive their permission.** `POST /exports` MUST map `entity` → required permission set and reject any mismatch: `audit` ⇒ `audit.export`; `journal`/cost-bearing entities ⇒ `product.cost.read` + accounting read; `partner` ⇒ partner read; `customer` ⇒ customer read + PII permission. A role with only `export.create` cannot export the audit trail or cost data (no super-entity bypass). `GET /exports` and `/download` are scoped to `requested_by = actor` unless the actor holds `export.read_all`; each download re-checks the entity permission + `TenantContext` scope, opens a fresh 5-minute signed URL, and writes `export.downloaded` to the audit trail.
2. **Per-report permissions.** Each seeded report row carries `required_permissions[]` (a data column, not prose); it is enforced at (a) report run, (b) row retrieval, (c) download/export and (d) dashboard-widget resolution. A single `report.run` key is not sufficient to see financials or partner profit.
3. **Dashboards inherit the strictest widget.** A dashboard widget with `queryCode` executes only if the actor holds every permission of the underlying report; widget resolution failures are `403`, not silently empty. Users may only create widgets from the closed set of seeded `queryCode` values.
4. **No user SQL.** `report.create` accepts only a closed enum of code-committed `queryTemplateId` values (no free SQL/template text). Open question #10 in `API.md` MUST be closed before P6. Template registry changes require code review + Security review.
5. **Tests:** viewer with `export.create` cannot export `audit`; accountant without partner permission cannot run `partner-profit`; widget `queryCode:'trial-balance'` without permission ⇒ 403; cross-user export download ⇒ 404.

### 3.11 API-client (machine) authentication — SEC-AZ-18

R1 M-06 closed here. Machine clients are NOT `X-Api-Key`-style static access:

1. **Token endpoint.** `POST /auth/token` (client-credentials): `client_key` (public identifier) + `client_secret` (32-byte, stored as `sha256(pepper‖secret)` in `api_clients.client_secret_hash`); returns an opaque bearer (or JWT with `actor_type='api_client'`) valid **15 minutes** with `scope` = intersection(requested, client.scopes) — requested scopes beyond the client's set are rejected, never silently narrowed.
2. **Same guard chain.** API-client tokens flow through the identical `PermissionsGuard`/`ScopeGuard`; every permission comes from the scope→permission map in the registry; no separate authorization path.
3. **Network restriction.** `api_clients.allowed_cidrs` is enforced on **every** request; a mismatch is `403 IP_NOT_ALLOWED` and a security event. Empty `allowed_cidrs` means "deny all" (opt-in per client).
4. **Audit + idempotency.** `actor_type='api_client'` in audit; `Idempotency-Key` is scoped to the API client id; every client action is audited. Secrets are returned once at creation/rotation with a 24-hour rotation overlap, then revoked.
5. **Tests:** wrong CIDR ⇒ 403; scope escalation ⇒ 403; token expiry ⇒ 401; audit actor_type present.

### 3.12 Authorization summary

| SEC ID | Control | Location | Phase |
|---|---|---|---|
| SEC-AZ-01 | Global authn + default-deny authz guards; writes bearer-only | `apps/api/src/common/guards/` | P1 |
| SEC-AZ-02 | Code-defined permission registry + seed drift check | `packages/shared/src/permissions.ts`, `scripts/check-permissions.ts` | P1 |
| SEC-AZ-03 | Route-without-permission is a build error; uniform 404 | `.eslintrc`/`eslint.config.js`, error filter | P1 |
| SEC-AZ-04 | `TenantContext` from token only; repository scoping | `packages/db/src/repository-base.ts` | P1 |
| SEC-AZ-05 | Permission cache keyed by `pv`, DB read-through | `common/auth/permission-cache.ts` | P1 |
| SEC-AZ-06 | Serializer-level field masking (cost/margin/PII) | `common/serializers/` | P2 |
| SEC-AZ-07 | No privilege amplification on role edit | `modules/identity/roles/role.service.ts` | P1 |
| SEC-AZ-08 | Immutable system roles + last-superadmin guard | same + DB trigger | P1 |
| SEC-AZ-09 | `permissions_version` bump in same tx | `role.service.ts`, `user.service.ts` | P1 |
| SEC-AZ-10 | CI scope test + no-raw-db-access lint | `apps/api/test/security/scope.spec.ts` | P1 |
| SEC-AZ-11 | SoD/approval matrix + DB trigger | `modules/platform/approvals/` | P4 |
| SEC-AZ-12 | Step-up on accounting/credential/export actions | `@RequireMfa()` usage map | P4 |
| SEC-AZ-13 | API client scopes + hashed keys + rotation | `modules/platform/api-clients/` | P5 |
| SEC-AZ-14 | Single permission registry + exact matching + bidirectional CI parity (R1 B-06) | `packages/shared/src/permissions.ts`, `scripts/check-permissions.ts` | P1 |
| SEC-AZ-15 | Step-up + subset check on role/scope edits; scope change revokes sessions (R1 H-01/M-10) | `modules/identity/roles/`, `users.controller.ts`, `common/guards/role-escalation.guard.ts` | P1 |
| SEC-AZ-16 | Approval config protection (2-person, 24 h cooling, immutable snapshot) + DB `approval_id` + disjoint author/post duties (R1 B-04) | `modules/platform/approvals/`, `erp.post_journal()`, `data_versions` | P4 |
| SEC-AZ-17 | Per-entity export permission + per-report `required_permissions[]` + dashboard widget inheritance + closed template enum (R1 H-02/H-09) | `modules/reporting/exports/`, `reports.required_permissions`, `report-templates` registry | P4/P6 |
| SEC-AZ-18 | API-client token endpoint, CIDR enforcement, scope mapping, audit (R1 M-06) | `modules/platform/api-clients/`, `POST /auth/token` | P5 |

---

## 4. Input validation and output encoding

### 4.1 Validation — SEC-IN-01

- **Every** request input (body, query, params, headers used in logic, multipart metadata, webhook payloads) is parsed by a **Zod** schema (`nestjs-zod`); unknown keys are stripped (`.strict()` on security-sensitive DTOs, e.g. auth, approvals, journal, channel config). No controller takes `@Body() body: any`.
- Global limits in `apps/api/src/main.ts`: JSON body ≤ 1 MB (business), multipart ≤ 25 MB, URL/header limits from Fastify defaults plus `maxParamLength: 200`; `requestTimeout: 30_000`, `connectionTimeout: 10_000`.
- Type coercion is explicit; money is `MoneyString` (`ADR-0013`), ids are `UUID` (`public_id`) or integer ranges where internal; enums are closed unions; free text has `.max()` and normalization (`NFKC`, trim) — Persian digits normalized at the edge.
- `safeParse` everywhere with a global `ZodValidationExceptionFilter` mapping to `VALIDATION_ERROR` + field paths (no SQL/stack leak — SEC-IN-09).
- Server-side validation is authoritative; SPA validation is UX only, using the same schemas from `packages/shared`.

### 4.2 SQL injection posture — SEC-IN-02, 03, 04

- **Parameterization by construction:** all SQL goes through Drizzle query builders or `sql` tagged templates with bound parameters (`sql`…${value}…``). `postgres.js` prepared statements; no string concatenation of values anywhere.
- **Dynamic identifiers** (`sort`, `filter[field]`, report columns, group-by) are never interpolated. The DTO uses `z.enum([...])`; a mapper (`packages/db/src/query/identifier-map.ts`) converts the enum to a hard-coded column reference. An unrecognized field is a `VALIDATION_ERROR`. `filter[field]` allowed-lists live next to each repository.
- **Banned APIs:** `sql.raw()`, `db.execute()` outside `*.repository.ts`, and `unsafe()` are banned by ESLint (`saman/no-unsafe-sql`) and Semgrep; exceptions require a Security Lead review comment and are listed in `infra/semgrep/allowlist.yml`.
- **DB-side defense:** `saman_app` has no superuser, no `CREATE`, no file functions (`pg_read_file`, `lo_import` revoked), no `COPY ... PROGRAM`; `statement_timeout=5s`; connection with `search_path=erp,pg_catalog`.
- **Verification:** Semgrep rules `sql-injection`, `drizzle-raw-sql`; ZAP active scan with SQLi policy on staging; a dedicated negative test per parameterized endpoint (`?sort=id;DROP TABLE` → 400) in `apps/api/test/security/sqlinjection.spec.ts`.

### 4.3 Output encoding and serializers — SEC-OUT-01, 02, 03

- React escapes by default; **no** `dangerouslySetInnerHTML` in the SPA. ESLint rule `react/no-danger` + custom `saman/no-dangerous-html`. Rich text (product descriptions imported from channels) is stored as **plain text** in v1; if rich text is ever required, a single `SafeHtml` component uses DOMPurify with an allowlist (`b, i, em, strong, ul, ol, li, p, br, a[href https]`) and is the only sanctioned path.
- No HTML is generated server-side for the SPA (REST + JSON only), so server-side encoding risk is limited to exports (CSV/PDF): CSV cells starting with `= + - @ \t \r` are prefixed with `'` (SEC-OUT-06); PDF labels are generated from templates with escaped fields.
- **Response serializers (SEC-OUT-03):** every controller returns a typed serializer/DTO — never a raw Drizzle row. Serializers whitelist fields (prevents accidental leakage of `password_hash`, `token_hash`, `credentials_encrypted`, internal `id`, audit internals). A test snapshots every response schema and fails if a new field appears without review.
- Error responses contain only `{ error: { code, messageFa, details?, requestId } }`; no SQL, stack, file path, host name, or dependency version. `details` are field-level validation messages only.

### 4.4 File upload pipeline — SEC-IN-10

Endpoint: `POST /api/v1/files` (`multipart/form-data`), permission `file.upload`; import endpoints accept files through the same service. Pipeline in `apps/api/src/modules/platform/files/upload.pipeline.ts`:

1. **Size/type admission:** per-purpose hard caps (image 10 MB, CSV/XLSX import 20 MB, PDF label 5 MB); max 5 files/request; `@fastify/multipart` limits configured globally.
2. **Magic bytes** (first 16 bytes) must match the declared purpose: JPEG `FF D8 FF`, PNG `89 50 4E 47`, WebP `RIFF....WEBP`, PDF `%PDF-`; CSV requires valid UTF-8 with a required header row and **no** binary content. Extension is cosmetic and must match MIME; mismatch → `400 INVALID_FILE_TYPE`.
3. **Image re-encode (authoritative):** `sharp` decodes and re-encodes every image to WebP/JPEG at max 4096×4096, strips all metadata (EXIF/GPS/ICC except sRGB), applies no HTML/SVG. **SVG is rejected in v1** (stored XSS vector); if needed later, sanitize with DOMPurify's SVG profile + serve as attachment only.
4. **Content scan seam:** `scanFile(buffer)` hook → ClamAV via unix socket/sidecar (roadmap) or no-op; `file_assets.scan_status` (`pending|clean|infected|skipped`) records the outcome; `infected` → 422 + quarantine object + alert.
5. **Dedup/hash:** `sha256` computed on the **re-encoded** bytes, stored in `file_assets.sha256` (unique per org); duplicate → reuse object, return existing `public_id`.
6. **Private storage:** bucket `saman-media` (MinIO, private). Key = `org/{orgId}/{yyyy}/{mm}/{uuid}` generated server-side; the original filename only as metadata (length-limited, no path separators). No public bucket policy, no client write credentials.
7. **Serve:** `GET /api/v1/files/{public_id}/download` → permission + entity-scope check, then `302` to a **5-minute presigned URL** (or streams through the API). Always `Content-Disposition: attachment; filename="..."`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, `Cache-Control: private, no-store`. Inline rendering is allowed only for `image/*` used in `<img>` via a separate `/thumbnail` endpoint serving re-encoded WebP.
8. **Imports:** parsed in the **worker**, not the request; row cap (default 20 000), byte cap, cell length cap; per-item errors to `import_errors`; no formula evaluation; `xlsx` (SheetJS) reads values only with `cellFormula:false`.
9. **Audit:** `file.upload`, `file.download`, `file.rejected` rows; metrics on rejection rate; disk quota alert (SEC-MON-03).

**Transport rule (R1 H-05).** In v1 all uploads are **server-mediated** (multipart through the API, pipeline above); clients receive **no S3 write credentials and no bare presigned PUT**. If a presigned flow is enabled later (the API contract lists one), it MUST satisfy §4.9 or it is a release blocker.

**Download authorization (R1 H-06).** Issuing a download URL is an authorization decision, not just `file.read`: see §4.12 (`SEC-OUT-07`).

### 4.5 SSRF and egress control — SEC-IN-06, 07

All outbound HTTP from API/worker goes through `packages/http-client` (undici wrapper). Feature code cannot call `fetch`/`axios` directly (ESLint `saman/no-direct-http`).

**Destination policy (`apps/api/src/modules/channels/egress.ts`):**

| Channel | Allowlisted hosts (**code-declared, not configurable**) | Methods | Notes |
|---|---|---|---|
| Carexy | `carexy.shop`, `api.carexy.shop` | GET/POST/PUT | `X-API-KEY` from encrypted store |
| Digikala | `api.digikala.com`, `open-api.digikala.com`, `seller.digikala.com` | GET/POST/PUT/PATCH | OAuth2 client-credentials, minimum scopes |
| Limo SMS | `api.limosms.com` | POST | `ApiKey` header only, called from API |
| S3/MinIO | internal host `minio:9000` only | S3 API | signed by SDK |

**Host authority (R1 M-05; MUST).** The production host set is compiled into `packages/http-client/src/egress-hosts.ts` and reviewed like code. Environment variables (`CAREXY_API_BASE_URL`, `DIGIKALA_API_BASE_URL`, `LIMO_BASE_URL`) MAY only select a **code-declared preset** (`live`/`sandbox`), never an arbitrary URL; a boot assertion fails startup if any effective adapter base URL is not in the declared set. `channel_accounts.base_url` MUST NOT be an authorization authority for egress; if retained for display it is validated against the preset. The network egress firewall (SEC-INF-03) remains an independent backstop.

Rules enforced by the client for **every** request, including admin-configured `base_url` and any user-supplied URL (image import, partner callback):

1. Scheme must be `https` (MinIO internal is the only exception, hard-coded).
2. URL must not contain userinfo, port other than 443, fragment, or IP literal (IPv4/IPv6).
3. Host must match the allowlist by exact hostname or a **single-label** subdomain pattern; no wildcard suffixes, no regex.
4. **Resolve then connect:** custom undici `lookup` resolves the hostname, validates **every** returned address, and connects to that validated address (defeats DNS rebinding). Blocked ranges: `0.0.0.0/8`, `10/8`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`, `100.64/10`, `192.0.0/24`, `198.18/15`, `::1`, `fc00::/7`, `fe80::/10`, `::ffff:0:0/96`; no multicast/broadcast/reserved.
5. No automatic redirects (or max 3, each **revalidated** with the same policy).
6. Timeouts: connect 5 s, total 30 s. Response cap: 10 MB (JSON), 50 MB (label PDF streamed to S3 only), `content-type` allowlist per operation.
7. Egress is also restricted at the host/container level (SEC-INF-03): the worker's outbound traffic may reach only allowlisted destination IPs (documented firewall rules), so a code-path bypass is still blocked by the network.
8. Every blocked request increments `SEC-MON-06` counter and writes `security_events` (`security.egress.blocked`) with host + reason.

### 4.6 Webhook verification — SEC-IN-11..14

Receiver: `POST /api/v1/webhooks/{channel}` — `@Public()` + `@Webhook()` markers only.

1. **Raw body:** the route is registered with a raw-body parser; the signature is computed over the **exact bytes** (`rawBody.toString('utf8')`), never over re-serialized JSON.
2. **Headers:** `X-Saman-Timestamp` (unix seconds), `X-Saman-Signature` (`v1=<hex>`), `X-Saman-Event-Id`, `X-Saman-Event-Type`, plus the adapter's account identifier. Digikala's actual header names are `TBD-DIGIKALA` until confirmed in sandbox (`ADR-0006` consequence); the adapter maps them, but the **signature scheme (header name, algorithm, required-ness) is compile-time per adapter and MUST NOT be configurable through account settings** (R1 H-03).
3. **Verify (R1 M-03):** `HMAC-SHA256(secret, "v1|" + channel + "|" + account_id + "|" + event_id + "|" + timestamp + "|" + rawBody)` with `crypto.timingSafeEqual`. The **event id is inside the MAC** (an unsigned event-id header is not a replay defense). Secret from `channel_webhook_secrets` (encrypted per account, `SEC-CRYPTO-01`); rotation supports two active secrets for 24 h.
4. **Replay:** timestamp is **mandatory, no feature flag**; reject `|now − timestamp| > 300 s`; the dedupe key is `(channel_id, account_id, external_event_id)` from the signed content, enforced both by a unique DB index and a Redis `SET NX wh:{channel}:{account}:{eventId}` 24 h. A captured valid delivery replayed with a mutated event-id header fails verification (MAC mismatch); a byte-identical replay is a `200` idempotent no-op.
5. **Parse:** event type must be in the adapter's allowlist; Zod schema per type; unknown type → `400` + security event; never execute a generic handler.
6. **Quarantine and handoff:** store raw payload in `channel_webhook_events` (status `received`, PII columns not indexed, archive 90 d) and enqueue the job; respond `202` fast (no synchronous business logic).
7. **Never authoritative (SEC-IN-14):** a webhook may not create stock/money effects directly. The handler first fetches the order/return from the channel API (`pullOrders`/`getOrder`) or, if the fetch fails, marks the event `unverified` for reconciliation. Amounts/quantities in the payload are compared to fetch-back values; mismatch → alert + dead-letter.
8. **Digikala hardening until signature confirmed:** source-IP allowlist from partner ranges + fetch-back mandatory + feature flag `DIGIKALA_WEBHOOKS_ENABLED` default false in production until QA validates the contract.

### 4.7 Idempotency, concurrency, and replay control — SEC-IN-05

- **`Idempotency-Key`** is required on every `POST` that creates a business document (orders, adjustments, receipts, journals, refunds) and accepted on other unsafe methods. The key is scoped to `(actorId, method, route)` — a captured key cannot be reused by another actor — stored in `idempotency_keys` with a SHA-256 of the request body and a 24 h TTL. Replay with the same body returns the **original response** (`200`/`201`) without re-executing; replay with a different body returns `409 IDEMPOTENCY_KEY_REUSED`. Concurrent duplicates are resolved by a unique index on `(actor_id, method, route, key)`; the loser waits or receives `409`.
- **Optimistic concurrency:** mutable resources require `If-Match: <version>` for state-changing edits of approved/allocated/posted documents; a mismatch is `409 VERSION_CONFLICT` (`ADR-0003`). Approval decisions and journal posts check the document version they were requested against.
- **Replay of state transitions** is prevented by legal-transition guards in the domain services (`modules/sales/order-state.ts`, fulfillment state machines): a duplicate event is a no-op, an out-of-order event is rejected rather than applied.
- **Effect idempotency** at the worker/outbox level uses natural keys (`channel:order:{id}`, `webhook:{eventId}`) per `ADR-0010`; handlers test duplicate keys before side effects.
- The key and body hash are recorded in the audit/API log (hash only, never the body) so a replay attempt can be investigated without exposing PII.

### 4.8 Outbound webhook subscriptions — SEC-IN-16

R1 H-04 closed here. Outbound webhooks are **data egress** and are treated like an external integration:

1. **Destination allowlist.** Subscriptions may only target hosts in a code-reviewed, seeded allowlist (`OUTBOUND_WEBHOOK_ALLOWLIST`); arbitrary URLs are rejected at create/update (`400 EGRESS_DESTINATION_NOT_ALLOWED`). Adding a destination is a two-person config change (`SEC-AZ-16` flow) with step-up and audit.
2. **Payload allowlist.** Each event type has an explicit outbound DTO allowlist; **cost/price/margin fields MUST NOT be sent on outbound subscriptions**, and customer PII is minimized to IDs/masked values. The subscriber cannot "configure" extra fields.
3. **Change control.** Create/update requires `webhook.outbound.manage` + `@RequireMfa()`; the first delivery to a newly approved host raises a High alert and is logged; repeated delivery failures disable the subscription.
4. **Outbound signing.** Deliveries are HMAC-signed with a per-subscription secret (returned once, stored encrypted); receivers verify; delivery log stores status + hash, never the payload.
5. **Tests:** registration of an attacker host ⇒ 400; cost field absent from every outbound payload; new-host first-delivery alert; disabled on repeated failure.

### 4.9 File upload transport and orphan control — SEC-IN-18

R1 H-05 closed here. Applies to the upload pipeline in §4.4 and to any future presigned flow.

1. **v1 default (normative):** all bytes flow through the API (`multipart`), never directly from browser to S3. No client S3 credentials.
2. **If presigned uploads are enabled** (the API contract lists them): use an S3 **POST policy** presign — not a bare PUT — with `content-length-range` (purpose cap), exact `Content-Type` condition, `x-amz-meta-sha256`, `x-amz-meta-owner`, and 15-minute expiry, so the storage layer itself rejects oversized/wrong-type bodies. `/complete` re-verifies size, MIME and SHA-256 before the object becomes `ready`.
3. **Orphans:** `pending` objects are lifecycle-deleted after 24 h (MinIO lifecycle rule); a reconciliation job deletes `file_assets` rows still `pending` after 24 h. Per-user **in-flight upload cap = 5** and daily quota (200 MB, §7.1).
4. **Scan before ready:** objects sit in a quarantine prefix until `scanFile()` returns `clean`; `scan_status='pending'` files are never downloadable. ClamAV is REQUIRED in production; if the deployment cannot provide it, the risk acceptance must be signed in §9 and the file is served only as a forced attachment after re-encode.
5. **Tests:** oversized POST policy rejected by storage; wrong content-type rejected; orphan deleted after 24 h; in-flight cap enforced.

### 4.10 Import/XLSX and PDF-rendering resource caps — SEC-IN-19

R1 M-04 closed here.

1. **XLSX/CSV imports (worker).** Before parsing: reject files with decompressed size > **10× file size or 200 MB** (whichever is lower), > **100 000 archive entries**, compression ratio > **100:1**, or > 20 000 rows; XML parsing disables external entities (XXE), DTDs and external references; SheetJS runs with `cellFormula:false`, `cellHTML:false`, no macros. Parsing runs in a **memory-limited child process** (`--max-old-space-size=512`) so an OOM kills the job, not the worker.
2. **PDF/label rendering.** The renderer is named: a server-side PDF library (`pdf-lib`/`pdfkit`) with escaped text fields and **no HTML/URL interpretation**. If a headless browser is ever used, it MUST run with network disabled, `file://` access disabled, an isolated throwaway profile/user, and stripped HTML inputs — and that decision requires Security review. Fields are HTML-stripped and length-capped before rendering.
3. **Caps:** render timeout 30 s, memory 256 MB, concurrency 2 (separate `reports` queue), output ≤ 50 MB; a timeout is a failed job with alert, not an API hang.
4. **Tests:** zip-bomb fixture rejected; product name `<iframe src=file:///app/.env>` renders as inert text; render timeout kills the job.

### 4.11 Channel payload persistence and PII minimization — SEC-IN-20

R1 H-10 closed here.

1. **Allowlisted schemas.** `channel_api_calls` and `channel_webhook_events` persist only fields named in the adapter's per-operation allowlist. **No request/response headers, no `Authorization`/`X-API-KEY`, no cookies** are ever persisted. Customer PII (name, address, mobile, postal code) is NOT persisted in the general call log — store channel order/entity **IDs and hashes** only and fetch details on demand from the channel when an authorized user needs them.
2. **Inbound raw archive.** The raw webhook payload is stored only for the event types that need replay (default: order/return/shipment state), with sensitive fields either dropped, hashed, or encrypted with the `channel_payload_encryption` key (envelope, `SEC-CRYPTO-01`); retention shortened to **30 days** (daily partition drop) and columns revoked from `saman_readonly`.
3. **Access.** Viewing raw payloads requires `channel.webhook.read` + `@RequireMfa()`; bulk export requires a second approval; every view is audited (`channel.payload.viewed`).
4. **Tests:** a captured `X-API-KEY`/`Authorization` never appears in any DB row or log; raw payload access without step-up ⇒ 403; retention job drops old partitions.

### 4.12 File download authorization — SEC-OUT-07

R1 H-06 closed here.

1. `GET /files/{id}/download-url` resolves `file_assets.owner_entity_type` / `owner_entity_id` and REQUIRES the **entity's read permission** AND `TenantContext` scope (branch/warehouse). `file.read` alone is never sufficient for a linked file; for unlinked files only the uploader or an actor with `file.read_all` may download.
2. Out-of-scope or unauthorized ⇒ **`404 NOT_FOUND`** (no existence oracle), `403` only when the caller already legitimately sees the entity list. The signed URL is 5 minutes, `Content-Disposition: attachment`, `nosniff`, sandbox CSP; inline rendering only through the WebP thumbnail endpoint.
3. `GET /files` is scoped: default = files linked to entities the actor can read, plus own uploads; org-wide listing requires `file.read_all`.
4. Each URL issuance writes `file.download` audit with file id, entity, actor and request id.
5. **Tests:** sales agent cannot fetch cheque/supplier-invoice images; cross-branch file ⇒ 404; audit row generated; URL expiry works.

### 4.13 SMS content safety and voice-OTP abuse — SEC-IN-15, RL-02

Limo `/api/sendcode` carries the OTP in a provider-approved pattern and a fixed `Footer`; **no user-controllable text** is placed in SMS (no customer name, no order note). Transactional notifications use seeded `sms_templates` rendered with escaped, length-capped variables; template edits require `settings.notification.write` + audit. This prevents SMS injection/smishing from our sender line.

**Voice OTP / paid-message abuse (R1 H-08):** any paid channel (SMS **and** voice) draws from one **global per-org monetary budget** (`SMS_DAILY_BUDGET` covers all sends incl. `/auth/otp/voice` and `sendpeertopeersms`); the voice fallback requires a `challengeId` issued by the password step (no unauthenticated free-call trigger) and is rate-limited per §7.1; CAPTCHA/Turnstile is MANDATORY (not roadmap) on the public send endpoints after 3 sends / 10 min from an IP — if the CAPTCHA provider is unavailable the endpoint fails **closed** (`503`), never open. Alert at 80 % budget (§12.2).

### 4.14 Input/output summary

| SEC ID | Control | Location | Phase |
|---|---|---|---|
| SEC-IN-01 | Zod everywhere + global body limits | `apps/api/src/main.ts`, DTOs | P1 |
| SEC-IN-02 | Parameterized SQL only | `packages/db/src/`, repositories | P1 |
| SEC-IN-03 | Identifier allowlists for sort/filter/group | `packages/db/src/query/identifier-map.ts` | P1 |
| SEC-IN-04 | Lint/Semgrep bans raw SQL, direct http, danger | `eslint.config.js`, `infra/semgrep/saman.yml` | P1 |
| SEC-IN-05 | Idempotency-Key + If-Match semantics | `common/interceptors/idempotency.*` | P1 |
| SEC-IN-06 | SSRF allowlist + URL validation | `modules/channels/egress.ts` | P5 |
| SEC-IN-07 | Resolve-validate-connect, no private IPs | `packages/http-client/src/guard.ts` | P5 |
| SEC-IN-08 | Uniform 404 for out-of-scope resources | error filter + guards | P1 |
| SEC-IN-09 | Error filter with no internals | `common/filters/http-exception.filter.ts` | P1 |
| SEC-IN-10 | Upload/serve pipeline (magic, re-encode, private, signed) | `modules/platform/files/` | P2 |
| SEC-IN-11 | Webhook HMAC-SHA256 verification | `modules/channels/webhooks/` | P5 |
| SEC-IN-12 | Replay window + event-id set | same + Redis | P5 |
| SEC-IN-13 | Event-type allowlist + per-type Zod | adapters | P5 |
| SEC-IN-14 | Webhook is a hint, fetch-back before state change | `webhook-processor.service.ts` | P5 |
| SEC-IN-15 | Fixed SMS templates, no user text | `modules/notifications/sms.report.ts` | P1 |
| SEC-OUT-01 | React escaping default; plain-text rich content | SPA components | P6 |
| SEC-OUT-02 | No `dangerouslySetInnerHTML`; sanitizer seam | `apps/web/src/components/SafeHtml.tsx` (roadmap for rich text) | P6 |
| SEC-OUT-03 | Whitelist response serializers; no internal ids | `common/serializers/` | P1 |
| SEC-OUT-04 | 5-min presigned URLs + download headers | `files.controller.ts` | P2 |
| SEC-OUT-05 | Adapter outbound DTO allowlist | `modules/channels/adapters/*/dto.ts` | P5 |
| SEC-OUT-06 | CSV formula-injection escaping | `modules/reporting/export/csv.ts` | P2 |
| SEC-IN-16 | Outbound webhook destination allowlist, payload allowlist (no cost/cost fields), step-up + first-delivery alert (R1 H-04) | `modules/channels/outbound-webhooks/`, `OUTBOUND_WEBHOOK_ALLOWLIST` | P5 |
| SEC-IN-17 | Webhook MAC input binds channel/account/event-id/timestamp; signature scheme non-configurable (R1 H-03/M-03) | `modules/channels/webhooks/verify.ts` | P5 |
| SEC-IN-18 | Presigned POST-policy constraints, orphan lifecycle 24 h, in-flight cap, scan-before-ready (R1 H-05) | `modules/platform/files/`, MinIO lifecycle, `infra/docker/minio/init.sh` | P2 |
| SEC-IN-19 | Import decompression/entry caps + sandboxed parser + named PDF renderer caps (R1 M-04) | `workers/imports/`, `modules/reporting/pdf/` | P2 |
| SEC-IN-20 | Channel payload allowlist schema, no headers/PII, 30-day encrypted archive, step-up raw view (R1 H-10) | adapters `persisted-body.ts`, `channel_api_calls`, `channel_webhook_events` | P5 |
| SEC-IN-21 | Code-declared egress hosts + boot assertion (no env-controlled destination) (R1 M-05) | `packages/http-client/src/egress-hosts.ts`, boot check | P5 |
| SEC-OUT-07 | Entity-scoped file download authorization; 404 on cross-scope; download audit (R1 H-06) | `files.controller.ts`, `file_assets.owner_entity_*` | P2 |

---

## 5. Secrets and cryptography

### 5.1 Secret inventory and storage — SEC-CRYPTO-02, 09, 11, 16

**Canonical names.** Environment names below are aligned with the repository template `.env.example` (canonical; `env.schema.ts` validates them at boot). Anything not listed in `.env.example` is a **secret file** under `/run/secrets/` (R1 H-11), not an environment variable.

| Secret | Canonical name / secret file | Format | Rotation | Consumer |
|---|---|---|---|---|
| JWT signing key | `JWT_ACCESS_SECRET` → `/run/secrets/jwt_access_secret` (+ `.previous` during rotation) | 64 B base64 | 90 days | `token.service.ts` |
| Access/refresh TTLs | `JWT_ACCESS_TTL` (10m), `JWT_REFRESH_TTL` (7d) | duration | config | token/session service |
| Refresh-token pepper | `REFRESH_PEPPER` → `/run/secrets/refresh_pepper` | 32 B base64 | 180 days | session service |
| OTP pepper | `OTP_PEPPER` → `/run/secrets/otp_pepper` | 32 B base64 | 180 days | OTP/device service |
| Data-encryption key | `APP_ENCRYPTION_KEY` → `/run/secrets/app_encryption_key` | 32 B base64 | 180 days | `envelope.ts` |
| Data-key version | `APP_ENCRYPTION_KEY_VERSION` | integer (`1`, `2`, …) = envelope prefix `vN` | per key | `envelope.ts` |
| Retired data keys (rotation only) | `/run/secrets/app_encryption_keys.previous` (JSON `{version: key}`) | JSON | window only | `envelope.ts` |
| DB runtime credentials | `DATABASE_URL` (password injected from `/run/secrets/db_app_password`) | URL | 180 days | postgres.js |
| DB migrator credentials | `MIGRATION_DATABASE_URL` → `/run/secrets/migrator_database_url` | URL | 180 days | release step only |
| DB TLS | `DB_SSL=true`, `DB_SSL_CA_PATH=/run/secrets/db-ca.pem` | path | — | postgres.js |
| Redis | `REDIS_URL` + `REDIS_PASSWORD` → `/run/secrets/redis_password` | 32 B random | 180 days | API/worker |
| Object storage | `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_ENDPOINT` → `/run/secrets/s3_access_key`, `/run/secrets/s3_secret_key` | opaque | 180 days | files service |
| SMS provider | `LIMO_API_KEY` → `/run/secrets/limo_api_key` | opaque | 180 days/incident | Limo adapter only |
| Channel credentials (bootstrap) | `CAREXY_API_KEY`, `CAREXY_WEBHOOK_SECRET`, `DIGIKALA_CLIENT_ID`, `DIGIKALA_CLIENT_SECRET`, `DIGIKALA_WEBHOOK_SECRET` | opaque | n/a | **one-shot import** → encrypted DB rows; the env value is deleted after import |
| Channel credentials (steady state) | DB, encrypted: `channel_accounts.credentials_encrypted`, `channel_api_credentials.secret_ciphertext`, `channel_webhook_secrets.secret_ciphertext` | AES-GCM envelope | 90 days (webhooks, dual-secret window) | adapters |
| Backup passphrase | `BACKUP_ENCRYPTION_PASSPHRASE` → `/run/secrets/backup_passphrase` | 32+ B random | yearly | backup sidecar |
| Bootstrap admin | `BOOTSTRAP_ADMIN_MOBILE`, `BOOTSTRAP_ADMIN_PASSWORD` → `/run/secrets/bootstrap_admin_password` | one-shot | delete after first boot | bootstrap script only |
| CI/CD secrets | GitHub environment secrets | — | 90 days | deploy |

**Delivery rules (R1 H-11; MUST).**

1. Production secrets are delivered with Compose **`secrets:`** (file secrets, tmpfs at `/run/secrets/<name>`, `mode: 0400`, `uid/gid` set to the container app user) or root-owned `0400` files bind-mounted read-only. Secrets MUST NOT be passed via `env_file`/`environment:` — environment variables are readable by `docker inspect` and `docker exec … env`.
2. The app reads each secret file **once at boot** into memory (`apps/api/src/config/secrets.service.ts`) and never re-reads it; a missing/unreadable/empty secret is a boot failure (fail closed).
3. Verification gate: `docker inspect api --format '{{json .Config.Env}}'` MUST contain no secret values, and `docker exec api env` MUST show none. This is a §9 sign-off item.
4. `env_file` (`.env`, mode 600) carries **non-secret configuration only**: `APP_ENV`, `APP_URL`, `APP_PORT`, `API_PREFIX`, `API_VERSION`, `APP_TIMEZONE`, `APP_DEFAULT_LOCALE`, `DOCS_ENABLED`, `LOG_LEVEL`, `CORS_ORIGINS`, `COOKIE_SECURE`, `COOKIE_DOMAIN`, `TRUST_PROXY`, `SECURITY_HSTS`, rate-limit values, `LOGIN_MAX_FAILED`, `LOGIN_LOCK_MINUTES`, `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_TIMEOUT_MS`, `DB_SCHEMA`, `SMTP_*` (if ever), `METRICS_ENABLED`, `OTEL_*`, `SENTRY_DSN` (treat as sensitive but non-authenticating), `BACKUP_*` non-secret values, `CHANNEL_*` tuning.
5. **Docker access equals root.** Membership of the `docker` group, the Docker socket, or passwordless `sudo docker` is host-root-equivalent (mounting `/`, reading container secrets, `docker inspect` env). The deploy user MUST NOT have docker sudo; use rootless Docker for the deploy path or a narrowly scoped systemd unit whose secret files are root-owned and only `docker compose -f …` is permitted. This is documented in `DEPLOYMENT.md`/`RUNBOOK.md` (routing).
6. Secrets MUST NOT appear in git history (gitleaks), images (`docker history`/`ENV`), logs (§5.6), error messages, audit rows, queue payloads or metric labels. `.env.example` contains placeholders only; boot refuses placeholder values (`CHANGE_ME*`) in production.
7. Rotation never requires editing images: new secret file → restart → verify; old value retained only for the documented overlap window (JWT 20 min, encryption until re-encrypt completes, webhook 24 h).

### 5.2 Credential encryption — SEC-CRYPTO-01, 03, 05

**Algorithm.** AES-256-GCM. 32-byte key, 12-byte random IV per message (never reused; `randomBytes(12)`), 16-byte auth tag. **Envelope format** stored as text:

```text
v<keyVersion>:<base64url( iv(12) || tag(16) || ciphertext )>
example: v2:q83v…9cA
```

**AAD binds the ciphertext to its row** so a ciphertext cannot be moved between rows/columns: `AAD = "org:" + organizationId + "|table:" + table + "|id:" + publicId + "|field:" + field`. Decryption fails (`DataIntegrityError`, 500 + alert) if the row id or field is changed.

**Library.** `apps/api/src/common/crypto/envelope.ts` using Node `crypto` (no third-party crypto), unit-tested against known vectors and tamper cases (flip a bit → throw). `decrypt` picks the key version from the prefix; unknown version → `ConfigurationError` at call site (never silently plaintext).

**Scope.** `SEC-CRYPTO-05`: decrypt only inside the adapter/service call scope; plaintext credential exists only as a local variable in the HTTP-client call frame; never passed to logs, events, queue payloads, or the SPA. The keyring is loaded once at boot into memory (`config/secrets.service.ts`), never re-read per request.

**Key hierarchy.** `APP_ENCRYPTION_KEY` is the active *data* key (retired versions only ever live in the rotation-only `/run/secrets/app_encryption_keys.previous` file); the `/run/secrets` directory, root-owned and mounted read-only, is the root of trust in v1 — **not** `.env` and not a container environment variable (R1 H-11). Optional hardening (roadmap): load the keyring from a systemd credential or a local KMS/LUKS-protected volume. No external KMS dependency in v1 (single host).

### 5.3 JWT secret rotation — SEC-CRYPTO-04

`JWT_ACCESS_SECRET` is a single 64-byte secret at `/run/secrets/jwt_access_secret`. Rotation uses a **dual-verify window**: the new secret is written to `jwt_access_secret`, the old one to `jwt_access_secret.previous`; both files are mounted and the token service signs with the current secret and verifies with current-then-previous. After **≥ 2 × access TTL (20 min)** the `.previous` file is removed and the old secret destroyed. Refresh tokens are opaque DB rows (unaffected); no downtime, no mass logout. Token `kid` is optional in v1 (single active key + previous); if `RS256` is enabled, `kid` maps to the public key and the algorithm is derived from the key type (SEC-AUTH-16).

### 5.4 Encryption-key rotation runbook — SEC-CRYPTO-03

Preconditions: a new 32-byte key is written to `/run/secrets/app_encryption_key`; the **previous** key is made available in `/run/secrets/app_encryption_keys.previous` as JSON `{"<old version>":"<b64 key>"}`; `APP_ENCRYPTION_KEY_VERSION` is bumped (e.g. `1` → `2`). The envelope prefix `v<version>:` selects the decrypting key; encryption always uses the active `APP_ENCRYPTION_KEY`/`APP_ENCRYPTION_KEY_VERSION`. A ciphertext whose version has no available key is a hard error (never plaintext fallback). Procedure (recorded in `docs/07-operations/RUNBOOK.md`, rehearsed yearly):

1. **Backup first:** trigger an encrypted backup and verify it (`SEC-DATA-11`/`SEC-MON-07`).
2. **Switch active:** deploy the new secret files, set `APP_ENCRYPTION_KEY_VERSION=2`, restart api+worker; new writes are `v2:`; `v1:` rows still decrypt with the previous-keys file. Boot fails if any key is missing, short, or a placeholder.
3. **Re-encrypt:** `docker compose run --rm api pnpm crypto:reencrypt --from 1 --to 2 --batch 500`. The job scans every table/column in `crypto.registry.ts` (`channel_accounts.credentials_encrypted`, `channel_api_credentials.secret_ciphertext`, `channel_webhook_secrets.secret_ciphertext`, encrypted channel payload archive columns, and any encrypted PII columns), re-encrypts rows whose prefix matches `--from`, is **resumable** (progress in `crypto_rotation_progress`), idempotent, writes an audit summary and a JSON report.
4. **Verify:** `pnpm crypto:audit --require-version 2` must return zero rows with an older prefix; run in read-only mode as part of the release gate.
5. **Retire:** remove `app_encryption_keys.previous`, restart; keep the retired key offline in split custody for 90 days in case an old backup must be restored (a restored old backup MUST be re-encrypted with step 3 immediately after restore).
6. **Record:** rotation date, versions, row counts, operator, approver in the security log and the §17 revision log.

**Incident variant (key compromise):** revoke sessions, rotate JWT/peppers, add a new data key, re-encrypt, and rotate all channel credentials with the providers (Carexy API key, Digikala OAuth client secret, Limo key), because historical ciphertext may have been exfiltrated.

### 5.5 Backup encryption — SEC-CRYPTO-10, 13

Dumps are encrypted **on the host, before upload**, with `age` using the passphrase from the Compose secret `backup_passphrase` (`BACKUP_ENCRYPTION_PASSPHRASE`, never in `env_file`; the passphrase itself is held in split custody and not on the deploy workstation):

```bash
pg_dump -Fc "$DATABASE_URL" \
  | age -p -o "/backup/saman-$(date +%F).dump.age"   # passphrase read from /run/secrets/backup_passphrase
sha256sum "/backup/saman-$(date +%F).dump.age" > "/backup/saman-$(date +%F).dump.age.sha256"
aws s3 cp /backup/saman-$(date +%F).dump.age \
  --endpoint-url "$S3_ENDPOINT" --sse AES256 "s3://$BACKUP_BUCKET/$BACKUP_S3_PREFIX/"
```

The passphrase is **not on the host** in cleartext: it is injected into the backup sidecar as a Compose secret (root-owned `0400`, read-only mount) and is stable-custodied by two operators for restores. The backup bucket identity is **write-only** (no read, no delete except lifecycle) and object-lock/versioning preserves the 30-day window. Restore: `age -d -i <passphrase-file> | pg_restore -d "$TARGET"` with the `RESTORE_CONFIRM=<db>` guard (`THREAT-MODEL.md` TB-8). `scripts/verify-backup.sh` runs `age -d … | pg_restore --list` daily and alerts if the archive is unreadable.

### 5.6 Log redaction and no-secrets logging — SEC-CRYPTO-06, AUD-07

pino is configured once (`apps/api/src/common/logging/logger.ts`):

```ts
redact: {
  paths: [
    'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]',
    'req.headers["x-saman-signature"]', 'res.headers["set-cookie"]',
    '*.password', '*.new_password', '*.current_password', '*.token', '*.access_token',
    '*.refresh_token', '*.otp', '*.code', '*.api_key', '*.apikey', '*.client_secret',
    '*.secret', '*.credentials_encrypted', '*.secret_ciphertext', '*.ciphertext',
    '*.iban', '*.national_id', '*.card_number',
  ],
  censor: '[REDACTED]',
},
serializers: { req: pino.stdSerializers.req, res: pino.stdSerializers.res, err: redactError },
```

- Request/response **bodies are never logged** by default (`LOG_BODIES=false`, forbidden in production by a boot check).
- Mobile numbers are logged masked (`0912****1234`) via a `maskMobile` helper; customer names are not logged.
- Errors: `redactError` keeps `name`, `code`, `requestId`, and a sanitized message; stack only at `fatal` in dev; third-party errors are wrapped (an adapter error containing an API key in a URL is scrubbed by a generic secret-pattern filter: `/(api[_-]?key|token|secret|password)=[^&\s]+/gi → $1=[REDACTED]`).
- `console.log` is banned by lint (`no-console`); the logger is injected.
- CI test `apps/api/test/security/no-secrets-in-logs.spec.ts`: runs login/OTP/channel-create/refresh flows with a capturing transport and asserts no secret patterns appear.

### 5.7 Cryptography summary

| SEC ID | Control | Location | Phase |
|---|---|---|---|
| SEC-CRYPTO-01 | AES-256-GCM envelope + AAD binding | `common/crypto/envelope.ts` | P1 |
| SEC-CRYPTO-02 | Secret rotation: `JWT_ACCESS_SECRET` (+ `.previous` dual-verify), `APP_ENCRYPTION_KEY` (+ retired-keys file), peppers | `config/secrets.service.ts` | P1 |
| SEC-CRYPTO-03 | Rotation/re-encrypt runbook + CLI | `scripts/crypto-reencrypt.ts` | P1 |
| SEC-CRYPTO-04 | JWT `kid` rotation, dual-verify window | `token.service.ts` | P1 |
| SEC-CRYPTO-05 | Decrypt only in adapter scope | adapters, `http-client` | P5 |
| SEC-CRYPTO-06 | Redaction rules + `LOG_BODIES=false` | `common/logging/logger.ts` | P1 |
| SEC-CRYPTO-07 | Minimum OAuth scopes per adapter | `adapters/digikala/scopes.ts` | P5 |
| SEC-CRYPTO-08 | Dedicated MinIO app user (no root) | `infra/docker/minio/init.sh` | P7 |
| SEC-CRYPTO-09 | `.env` 600, outside git/images | host setup, `.gitignore` | P1 |
| SEC-CRYPTO-10 | age-encrypted backups, offline key | `infra/backup/backup.sh` | P7 |
| SEC-CRYPTO-11 | Provider API keys env-only, single use-site | adapters | P5 |
| SEC-CRYPTO-12 | OTP/password peppers + constant-time | `otp.service.ts`, `password.service.ts` | P1 |
| SEC-CRYPTO-13 | Separate backup bucket identity, write-only | `infra/backup/`, MinIO policy | P7 |
| SEC-CRYPTO-14 | Column-level encryption for national ID/IBAN (roadmap) | `crypto.registry.ts` | roadmap |
| SEC-CRYPTO-15 | CSPRNG for all tokens/codes/IVs | `common/crypto/random.ts` | P1 |
| SEC-CRYPTO-16 | Production secret delivery via Compose `secrets:`/root-owned `/run/secrets` files (never `env_file`); docker access documented as root (R1 H-11) | `docker-compose.yml` secrets, `config/secrets.service.ts`, `scripts/verify-host.sh` | P1/P7 |

---

## 6. Transport, headers, cookies, CORS, CSRF

### 6.1 TLS and HSTS — SEC-TLS-01, 02, 03

- TLS **1.2 minimum, 1.3 preferred**; modern cipher suites only (`ECDHE-ECDSA/RSA-AES-GCM`, `CHACHA20`); TLS 1.0/1.1 and weak ciphers disabled; no renegotiation; session tickets off for the edge (key rotation) or rotated.
- **HSTS:** `max-age=63072000; includeSubDomains; preload` — enabled only after the domain is permanently HTTPS and **all** subdomains are HTTPS (Caddy/nginx config review). Redirect all `:80` traffic with `301` to HTTPS.
- Certificates: Caddy profile (automatic Let's Encrypt/ZeroSSL) or host nginx with certbot; renewal alert at 21 days (SEC-MON-07); OCSP stapling on; certificate transparency monitoring (roadmap). Internal service traffic (api↔postgres) stays on the private Docker network; **DB TLS is optional** on the private network and **required** if PostgreSQL is external/managed (`sslmode=require|verify-full`; `DEPLOYMENT.md`).
- No mixed content: all SPA assets same-origin, fonts self-hosted (`Vazirmatn` from `/assets`), no third-party CDNs.

### 6.2 Cookies — SEC-TLS-04

| Attribute | Value | Rationale |
|---|---|---|
| Name | `__Secure-saman_rt` | `__Secure-` prefix forces `Secure`; `__Host-` is impossible with a scoped `Path` |
| `Path` | `/api/v1/auth` | Cookie is not sent to any business endpoint → **business writes are not CSRF-able** (`ADR-0004`) |
| `HttpOnly` | yes | Not readable by JS |
| `Secure` | yes (`COOKIE_SECURE=true`; always in non-dev) | HTTPS only; boot fails if false when `APP_ENV=production` |
| `SameSite` | `Lax` | Blocks cross-site POST; top-level GET navigations only |
| `Max-Age` | 7 days (`JWT_REFRESH_TTL`; warehouse 12 h) | Matches refresh absolute TTL |
| Domain | not set (`COOKIE_DOMAIN` empty → host-only) | No sharing across subdomains |
| Device cookie | `__Secure-saman_dev` — HttpOnly, Secure, SameSite=Lax, `Path=/api/v1/auth`, 180 days | Server-issued device secret for MFA trust (§2.9, R1 B-02); rotated on trust renewal; **not** an authentication token by itself |

Invalid/stale cookies are cleared with an expired Set-Cookie on `401`. The access token is **never** in a cookie.

### 6.3 CORS — SEC-TLS-06

Production is **same-origin** (SPA served by the same edge as `/api`), so no CORS headers are emitted and `Origin` is checked against `APP_URL` for unsafe `/auth/*` calls. Staging/dev: `CORS_ORIGINS` is an explicit comma-separated **exact** allowlist (`https://erp.example.com`), `credentials: true`, `methods` limited to the ones used, `maxAge: 600`; **no** `*`, no origin reflection, no regex. nginx never adds `Access-Control-Allow-Origin` automatically. A boot assertion rejects an empty allowlist in staging/production.

### 6.4 CSRF — SEC-TLS-05

Threat model: the only cookie-authenticated endpoint is `/api/v1/auth/refresh` (plus logout/sessions under the same path). Business mutations require the bearer header (not a cookie) → not CSRF-able.

For `/auth/*` unsafe methods the API enforces **all** of:

1. `Origin` header present and exactly equal to `APP_URL` (or in the dev/staging `CORS_ORIGINS` allowlist) — `SameSite=Lax` alone is not sufficient for login CSRF.
2. `X-Requested-With: saman-spa` custom header (cannot be sent cross-origin without a CORS preflight that we will reject).
3. `Content-Type: application/json` required (no form-encoded, no `text/plain`).
4. On login/refresh, a new refresh token **and** session family are issued (no fixation); `MFA` state belongs to the new session.

A missing/mismatched `Origin` returns `403 CSRF_REJECTED` and logs a security event. `GET` must never mutate state (enforced by review + integration test: every `GET` handler is read-only).

### 6.5 CSP and security headers — SEC-TLS-07, 08, 09

The edge sets headers (nginx/Caddy); the API **also** sets defense-in-depth headers on API responses via `@fastify/helmet` (`apps/api/src/main.ts`), with CSP only on HTML responses (API returns JSON, so CSP is at the edge for the SPA).

**CSP for the SPA** (production; `infra/nginx/saman-erp.conf`):

```nginx
add_header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; manifest-src 'self'; worker-src 'self' blob:; upgrade-insecure-requests" always;
```

- `script-src 'self'` — **no** `unsafe-inline`, **no** `unsafe-eval`, no third-party scripts. Vite emits external bundles; the index.html contains no inline script. A violation report goes to `POST /api/v1/csp-report` (rate-limited, sampled) and increments a metric.
- `style-src 'self' 'unsafe-inline'` is a **documented residual risk** accepted in v1 because React inline `style` attributes (data-driven table widths, progress bars) are used; it cannot execute script. Hardening roadmap (`docs/09-roadmap`): remove inline styles, then drop `unsafe-inline` and add a style nonce/hash. This is recorded, not ignored.
- `frame-ancestors 'none'` + `X-Frame-Options: DENY` (clickjacking), `object-src 'none'`, `base-uri 'none'` (base-tag injection).
- `connect-src 'self'` prevents exfiltration to attacker domains even with a DOM XSS in a non-script sink.

**Full edge header block** — SEC-TLS-08:

```nginx
server_tokens off;

add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "no-referrer" always;
add_header Permissions-Policy "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
add_header Cross-Origin-Embedder-Policy "require-corp" always;   # only after verifying SPA assets
add_header Content-Security-Policy "…as above…" always;
```

`camera=(self)` is required for the warehouse barcode scanner (PWA `BarcodeDetector` fallback per `ADR-0011`); all other powerful features are disabled.

**HTTP request hardening** — SEC-TLS-09 (Fastify + nginx): disable `TRACE`/`TRACK`; reject unknown methods; `client_max_body_size` from `UPLOAD_MAX_MB` (default 20m) with a hard 25m ceiling; header/body/idle timeouts (15 s / 30 s); `server_tokens off`; `proxy_hide_header X-Powered-By`; strict request-id (`X-Request-Id` accepted only if UUID, else generated); no `X-Forwarded-*` trust outside the edge (`trustProxy` derived from `TRUST_PROXY`/`TRUST_PROXY_CIDRS` only); HTTP/2 enabled at the edge; decompression limits (Fastify `bodyLimit` applies post-inflate; nginx `gunzip` off for uploads).

**Single normative source (R1 L-03).** This section is the only place header/CSP/HSTS values are specified. `API.md` §1.17 and any deployment doc MUST delete their duplicated header blocks and reference this section; a header-snapshot test generated from this section (asserting exact values on a live staging response) is the sign-off artifact. Values that differ by one character are a defect, not a preference.

### 6.6 Transport summary

| SEC ID | Control | Location | Phase |
|---|---|---|---|
| SEC-TLS-01 | TLS 1.2+/1.3, modern ciphers, redirect 80→443 | `infra/nginx/` or Caddyfile | P7 |
| SEC-TLS-02 | HSTS preload | same | P7 |
| SEC-TLS-03 | Cert renewal + expiry alert + DB TLS when external | edge config, `SEC-MON-07` | P7 |
| SEC-TLS-04 | Refresh cookie attributes + narrow Path | `auth.controller.ts` | P1 |
| SEC-TLS-05 | Origin + `X-Requested-With` + JSON content-type on `/auth/*` | `common/guards/csrf.guard.ts` | P1 |
| SEC-TLS-06 | Exact-origin CORS allowlist, no `*` | `main.ts` | P1 |
| SEC-TLS-07 | Strict CSP, `script-src 'self'`, report endpoint | edge + `csp-report.controller.ts` | P6 |
| SEC-TLS-08 | Full security header set | edge | P7 |
| SEC-TLS-09 | HTTP limits/methods/timeouts, no server tokens | nginx + `main.ts` | P7 |

---

## 7. Rate limiting, abuse detection, and audit logging

### 7.1 Rate-limit tiers — SEC-RL-01..07

Implementation: `apps/api/src/common/rate-limit/` — Redis sliding window (Lua script, atomic), keyed by tier; response headers `RateLimit-Limit/Remaining/Reset` and `Retry-After` on `429`; a global `@fastify/rate-limit` coarse layer in front for anonymous floods (per-IP). Tier values live in `config/rate-limits.ts` and are overridable per environment **without code changes** only for *lower* values; raising a production limit requires Security Lead review.

| Tier | SEC | Key | Limit | Burst | Endpoints |
|---|---|---|---|---|---|
| Login | RL-01 | `ip` | 20 / 10 min | 10 | `/auth/login` |
| Login | RL-01 | `ip+username` | 10 / 10 min | 5 | `/auth/login` |
| Login | RL-01 | `username` | 50 / h | 10 | `/auth/login` (botnet catch) |
| OTP send | RL-02 | `mobile` | 5 / h and 3 / 2 min | 2 | `/auth/otp/request`, step-up |
| OTP send | RL-02 | `ip` | 20 / h | 5 | same |
| OTP verify | RL-02 | `challenge` | 5 attempts total (shared with `/auth/mfa/verify`) | — | `/auth/otp/verify` |
| OTP verify | RL-02 | `ip` | 30 / h | 10 | same |
| MFA verify | RL-02 | `challenge` | 5 attempts total (same counter as OTP verify) | — | `/auth/mfa/verify`, step-up verify (R1 M-08) |
| MFA verify | RL-02 | `ip` | 30 / h | 10 | same |
| Password reset | RL-04 | `ip` | 5 / h | 2 | `/auth/password/reset*` **if** ever enabled (v1: 404, §2.10) |
| Password reset | RL-04 | `resetToken` | 3 attempts | — | same |
| Voice OTP | RL-02 | `mobile` | 1 / 5 min | 1 | `/auth/otp/voice`, `/sms/otp/voice` — requires a valid `challengeId` from the password step (R1 H-08) |
| Voice OTP | RL-02 | `ip` | 5 / h | 2 | same |
| Login (botnet) | RL-01 | `asn` | 100 / h | 20 | `/auth/login` — catches one-network credential stuffing (R1 H-07) |
| Public send (CAPTCHA) | RL-09 | `ip` | after 3 sends / 10 min require CAPTCHA/Turnstile; provider unavailable ⇒ 503 fail-closed | — | OTP/voice/reset request endpoints |
| Refresh | RL-04 | `session` | 120 / h | 10 | `/auth/refresh` |
| Refresh | RL-04 | `ip` | 300 / h | 50 | `/auth/refresh` |
| General (auth) | RL-03 | `user` | 600 / min | 100 | all authenticated |
| General (write) | RL-03 | `user` | 120 / min | 30 | POST/PATCH/PUT/DELETE |
| Anonymous | RL-03 | `ip` | 60 / min | 20 | non-auth public routes |
| Expensive read | RL-05 | `user` | 20 / min | 5 | reports, dashboard heavy |
| Export | RL-05 | `user` | 5 / h | 2 | exports |
| Import | RL-05 | `user` | 10 / h | 2 | imports |
| Upload | RL-05 | `user` | 20 / h, 200 MB/day | 5 | `/files` |
| Webhook | RL-07 | `channel` | 600 / min | 100 | `/webhooks/*` |
| Webhook (unknown source) | RL-07 | `ip` | 120 / min | 20 | same |
| Metrics/health | RL-08 | internal only | n/a | n/a | not public |

**Backpressure (RL-06):** long operations are never done inline — exports/imports/valuation are queued jobs (`ARCHITECTURE.md` §7). Queue depth/age is a metric; when a queue exceeds its cap the API returns `503 UPSTREAM_BUSY` with `Retry-After` for *that feature only* (no global outage). Per-channel token buckets are enforced inside the adapter (partner-specific, e.g. Digikala rate limits) — retries honor `429`+`Retry-After` from the partner.

**Redis outage behavior (RL-08):** the limiter falls back to an in-process token bucket per replica; to fail safe, auth tiers get **1/5** of their normal limit in this mode (slower but stricter), other tiers get 1/2; the degraded state is logged and alerted (`SEC-MON-01`). No security decision depends on Redis being available.

**Normative precedence (R1 H-07/M-08).** This table is the single normative rate-limit specification; `API.md` §1.12 duplicate values MUST be deleted and reference this section (differences are defects). The OTP attempt counter is **one Redis key shared by `/auth/otp/verify`, `/auth/mfa/verify` and reset completion** so an attacker cannot reset the counter by switching endpoints. Every paid send (SMS or voice) draws from the single `SMS_DAILY_BUDGET` monetary cap; CAPTCHA is mandatory on public send endpoints after the threshold above and fails **closed** (R1 H-08).

### 7.2 Abuse detection — SEC-MON-02

Rules evaluated on a 1-minute window (Redis counters) and on `security_events` (DB) for slower patterns. `apps/api/src/common/security/detectors/`:

| Rule | Trigger | Severity | Action |
|---|---|---|---|
| `auth.bruteforce` | ≥ 30 login failures/min per IP or ≥ 10 per username across IPs | High | alert + temporary block at edge (optional) |
| `auth.stuffing.distributed` | ≥ 100 failures/min from ≥ 20 IPs against ≥ 20 usernames | Critical | alert, enable strict login mode |
| `otp.flood` | ≥ 50 sends/min globally or budget > 80 % | High | alert, tighten limits, page on-call |
| `auth.refresh.reuse` | any reuse detection | Critical | revoke family (automatic) + alert |
| `auth.device.secret_mismatch` | ≥ 5/min per user | Medium | alert + counts toward login throttle (R1 B-02) |
| `security.breakglass.*` | any request/approval/login/write | Critical | multi-channel page to all admins + Security Lead; post-incident review (R1 M-07) |
| `security.audit_chain_mismatch` | any | Critical | incident response immediately (R1 B-05) |
| `access.denied.spike` | ≥ 20 deny rows/min per user | Medium | alert, optional user flag |
| `webhook.signature.invalid` | ≥ 10/min per channel | High | alert; consider disabling receiver |
| `egress.blocked` | any blocked SSRF destination | High | alert + investigate actor |
| `privilege.change.offhours` | role/permission change outside 07:00–20:00 Tehran | Medium | alert to Security Lead |
| `journal.anomaly` | manual journal, off-hours, round amount, or above 10× normal | High | alert to Finance + Security |
| `session.anomaly` | IP-prefix + UA change | Medium | step-up forced; event recorded |
| `export.large` | export > 50 000 rows or > 100 MB | High | require step-up + alert |
| `login.new.country` | successful login from a new country (IP geolocation, if available) | Medium | alert + step-up (roadmap) |

Every rule writes `security_events` and increments a Prometheus counter; alert routing is in §12.

### 7.3 Audit logging — SEC-AUD-01..10

**Model.** `audit_logs` is **append-only** and partitioned monthly (`ADR-0009`). R1 B-05 closed here: the hash columns exist, a `SECURITY DEFINER` chain function owned by the migrator writes them (the app/worker gets **EXECUTE only, never UPDATE**), and the event/actor/purpose vocabularies are seeded lookup tables rather than narrow CHECK strings.

```sql
CREATE TABLE erp.audit_logs (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  organization_id bigint NOT NULL,
  hash_seq      bigint NOT NULL,                 -- gap-free per organization (chain order)
  actor_type    varchar(20) NOT NULL REFERENCES erp.audit_actor_types(code),  -- user|system|api_client|channel|webhook|break_glass
  actor_id      bigint,
  actor_label   varchar(150),                    -- username/label at time of action (survives user deletion)
  action        varchar(80) NOT NULL,            -- seeded in erp.audit_actions (dotted verb)
  entity_type   varchar(80) NOT NULL,
  entity_id     bigint,
  result        varchar(10) NOT NULL REFERENCES erp.audit_results(code),      -- allow|deny
  reason        varchar(200),
  request_id    uuid,
  ip_prefix     inet,                            -- truncated /24 or /64
  ua_hash       char(64),
  before_data   jsonb,                           -- redacted diff only
  after_data    jsonb,                           -- redacted diff only
  changed_fields text[],
  prev_hash     char(64) NOT NULL,               -- previous row's row_hash (64 zeros for genesis)
  row_hash      char(64) NOT NULL,               -- sha256(prev_hash || canonical_json(row minus hashes))
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- owned by saman_migrator; the ONLY writer of chain columns
CREATE FUNCTION erp.chain_audit(p_batch int DEFAULT 1000)
RETURNS TABLE (chained bigint) LANGUAGE plpgsql SECURITY DEFINER
AS $$ … per-org advisory lock; select unhashed rows in id order; compute hash_seq,
        prev_hash, row_hash; UPDATE only those three columns; return count … $$;
REVOKE ALL ON FUNCTION erp.chain_audit(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erp.chain_audit(int) TO saman_worker;   -- EXECUTE only; no table UPDATE
```

**Vocabulary (SEC-AUD-11; R1 M-01/B-05).** `erp.audit_actor_types`, `erp.audit_actions`, `erp.audit_results`, `erp.security_event_types`, `erp.otp_challenge_purposes`, and `erp.webhook_event_types` are seeded lookup tables in the same migration. The full vocabulary REQUIRED by this document is seeded (auth login/logout/refresh-reuse/otp/device/mfa/step-up/reset, role/permission/scope, approval config, journal post/reverse, period close/reopen, inventory adjustment, price change, credential change, file download, export, access denied, webhook signature invalid, egress blocked, audit chain mismatch, key rotation, break-glass). A test enumerates every action/event named in §2–§8 and asserts it is insertable; adding a new event without a seed row is a CI failure, never a silently dropped event.

**Coverage (SEC-AUD-01/02).** A Nest interceptor + a `@Audit()` decorator writes the row **inside the business transaction** (same commit) for: all create/update/delete/void on business entities; approve/reject; post/reverse; period close/reopen; export/import/download; credential and settings changes; approval-workflow/threshold changes; role/permission/scope/user changes; login success/failure/logout, OTP request/verify outcomes; device trust/revoke; session revoke; permission denial (SEC-AUD-04). `audit.service.record()` requires an explicit action + entity; a write path without an audit call fails a test that enumerates all controller mutation routes.

**Redaction (SEC-AUD-03).** A field policy strips passwords, tokens, OTPs, secrets, full mobile/IBAN/national ID, and free-text notes from `before/after` (mobile stored masked; ID only if legally required, then encrypted). The diff is computed against a projection; unchanged fields are omitted; row size is capped (2 KB per field, 32 KB per row) to prevent audit-table abuse as a storage channel.

**Immutability and tamper evidence (SEC-AUD-08/12, SEC-DATA-05).** `saman_app` and `saman_worker` have **SELECT/INSERT only** on `audit_logs` (no UPDATE, no DELETE); partitions are detached/archived by `saman_migrator` only once their rows are chained and verified. The `maintenance` worker calls `erp.chain_audit(1000)` every minute to chain new rows (safe: it touches only null/unhashed rows, in order, under a per-org advisory lock). An **hourly verification job** uses an independent read-only connection to recompute the chain (`row_hash` from `prev_hash` + canonical JSON) over the last N days and the archived manifests, and raises `CRITICAL` on any mismatch, gap in `hash_seq`, or row whose hashes are older than 5 minutes. Conclusion: an insider with app-role SQL can no longer edit/delete audit rows undetected — the chain breaks.

**Retention and access (SEC-AUD-10).** Active 13 months in DB, older partitions exported to S3 as Parquet with a `sha256` manifest **and** a signed manifest chain (partition range, row count, per-partition hash), then detached; total retention **10 years** (`THREAT-MODEL.md` D-4 / §8.6). Access to archived audit requires `audit.export` + a second approval; all reads of audit data are themselves audited.

**Security events (SEC-AUD-05, 09).** `security_events` is a sub-stream (same DB) whose `event_type` is an FK to `erp.security_event_types` (seeded, not a CHECK), covering: `auth.login.*`, `auth.otp.*`, `auth.refresh.reuse`, `auth.device.secret_mismatch`, `auth.session.anomaly`, `access.denied`, `webhook.signature.invalid`, `security.egress.blocked`, `security.audit_chain_mismatch`, `security.key.rotated`, `security.breakglass.*`, `rate_limit.triggered` (sampled), `channel.payload.viewed`. These are also emitted as structured log lines `{"security":true,...}` for the SIEM/log pipeline.

### 7.4 Rate limiting and audit summary

| SEC ID | Control | Location | Phase |
|---|---|---|---|
| SEC-RL-01 | Login windows + lockout integration | `common/rate-limit/policies/login.ts` | P1 |
| SEC-RL-02 | OTP send/verify limits + budget | `otp.service.ts` | P1 |
| SEC-RL-03 | General/auth/anon tiers | `policies/general.ts` | P1 |
| SEC-RL-04 | Refresh/session tiers | `policies/auth.ts` | P1 |
| SEC-RL-05 | Expensive/export/import/upload tiers | `policies/expensive.ts` | P2 |
| SEC-RL-06 | Queue backpressure, per-feature 503 | queue module | P5 |
| SEC-RL-07 | Webhook/channel token buckets | `webhooks/limits.ts` | P5 |
| SEC-RL-08 | Redis-down fail-safe fallback | `common/rate-limit/fallback.ts` | P1 |
| SEC-AUD-01 | Audit append-only schema + coverage | `packages/db/schema/audit.ts`, `common/audit/` | P1 |
| SEC-AUD-02 | Transactional audit interceptor | `common/audit/audit.interceptor.ts` | P1 |
| SEC-AUD-03 | Redaction policy for diffs | `common/audit/redact.ts` | P1 |
| SEC-AUD-04 | `access.denied` audit | guards | P1 |
| SEC-AUD-05 | Security events stream | `common/security/events.ts` | P1 |
| SEC-AUD-06 | Permission-change audit with diff | `role.service.ts` | P1 |
| SEC-AUD-07 | No secrets/PII in logs or audit | logger + redact | P1 |
| SEC-AUD-08 | Hash chain + hourly verification | `workers/audit-chain.worker.ts` | P1 |
| SEC-AUD-09 | Detectors → events + metrics | `common/security/detectors/` | P1 |
| SEC-AUD-10 | Retention 10 y, archive, access control | `workers/partition-maintenance.worker.ts` | P7 |
| SEC-AUD-11 | Seeded audit/security/purpose/event lookup vocabularies + insertability test (R1 M-01/B-05) | `packages/db/migrations/*audit_vocab*`, `seeds/audit-vocab.ts` | P1 |
| SEC-AUD-12 | `erp.chain_audit(int)` SECURITY DEFINER owned by migrator; EXECUTE to worker only; independent hourly verifier (R1 B-05) | `packages/db/functions/chain_audit.sql`, `workers/audit-chain.worker.ts` | P1 |
| SEC-RL-09 | Voice-OTP / reset / MFA tiers, shared attempt counter, global SMS+voice budget, fail-closed CAPTCHA (R1 H-07/H-08/M-08) | `config/rate-limits.ts`, `otp.service.ts`, `captcha.guard.ts` | P1 |

---

## 8. Data security, database privileges, and privacy

### 8.1 Database roles and grants — SEC-DATA-01, 02, 07, 16

R1 H-12 closed here. Grants are **generated from an explicit manifest** (`packages/db/grants.manifest.ts`), not hand-written in prose; the SQL below is the manifest's materialization. `saman_app`/`saman_worker` have **no DELETE anywhere**; `saman_readonly` has **SELECT only on reporting views/matviews, never base tables**. Lifecycle deletes (log/partition retention) run in a separate `saman_maintenance` role inside the maintenance container only.

```sql
-- Run once by the DB superuser (documented in docs/06-deployment/INSTALL-FA.md)
CREATE ROLE saman_migrator   LOGIN PASSWORD :'migrator_pw'   NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE saman_app        LOGIN PASSWORD :'app_pw'        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE saman_worker     LOGIN PASSWORD :'worker_pw'     NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE saman_maintenance LOGIN PASSWORD :'maint_pw'     NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE saman_readonly   LOGIN PASSWORD :'ro_pw'         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

CREATE SCHEMA IF NOT EXISTS erp AUTHORIZATION saman_migrator;
REVOKE ALL ON SCHEMA erp FROM PUBLIC;
GRANT USAGE ON SCHEMA erp TO saman_app, saman_worker, saman_maintenance, saman_readonly;

-- migrator owns everything: DDL + DML
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA erp TO saman_migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA erp TO saman_migrator;

-- future objects created by migrations: app/worker get SELECT/INSERT/UPDATE only (NO DELETE)
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  GRANT SELECT, INSERT, UPDATE ON TABLES TO saman_app, saman_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  GRANT USAGE, SELECT ON SEQUENCES TO saman_app, saman_worker;

-- app + worker: DML without DELETE, no DDL
REVOKE CREATE ON SCHEMA erp FROM saman_app, saman_worker, saman_maintenance;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA erp TO saman_app, saman_worker;
REVOKE DELETE ON ALL TABLES IN SCHEMA erp FROM saman_app, saman_worker;        -- explicit, belt and braces
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA erp FROM saman_app, saman_worker;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON erp.audit_logs        FROM saman_app;      -- SELECT only + INSERT via interceptor role below
GRANT INSERT ON erp.audit_logs TO saman_app;                                            -- append only
REVOKE UPDATE, DELETE, TRUNCATE ON erp.security_events          FROM saman_app;
REVOKE UPDATE, DELETE, TRUNCATE ON erp.inventory_transactions   FROM saman_app, saman_worker;
REVOKE UPDATE, DELETE, TRUNCATE ON erp.journal_lines            FROM saman_app, saman_worker;
REVOKE UPDATE, DELETE, TRUNCATE ON erp.accounting_period_events FROM saman_app, saman_worker;
REVOKE UPDATE, DELETE, TRUNCATE ON erp.outbox_events            FROM saman_app;        -- worker completes dispatch; API may only insert

-- the only write paths for immutable accounting/ledger rows (SECURITY DEFINER, owned by migrator)
GRANT EXECUTE ON FUNCTION erp.post_journal(bigint, bigint)             TO saman_app, saman_worker;
GRANT EXECUTE ON FUNCTION erp.void_inventory_transaction(bigint, text) TO saman_app, saman_worker;
GRANT EXECUTE ON FUNCTION erp.chain_audit(int)                         TO saman_worker;

-- maintenance role: lifecycle deletes/archives only (runs in the maintenance container, not the internet-facing worker)
GRANT SELECT, DELETE ON erp.api_request_logs, erp.channel_api_calls, erp.outbox_events,
                        erp.idempotency_keys, erp.sms_messages, erp.data_versions TO saman_maintenance;
GRANT SELECT ON ALL TABLES IN SCHEMA erp TO saman_maintenance;                          -- reads for archive/verify
GRANT EXECUTE ON FUNCTION erp.chain_audit(int) TO saman_maintenance;

-- reporting role: views/matviews ONLY — no base table anywhere (no password_history,
-- login_attempts, user_devices, security_events, system_settings, idempotency_keys, channel_*, auth_sessions)
REVOKE ALL ON ALL TABLES IN SCHEMA erp FROM saman_readonly;
GRANT SELECT ON erp.v_users_safe, erp.v_customers_safe, erp.v_orders_reporting,
                 erp.v_inventory_reporting, erp.v_financial_reporting TO saman_readonly;
GRANT SELECT ON erp.mv_daily_sales, erp.mv_stock_aging TO saman_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp REVOKE ALL ON TABLES FROM saman_readonly;

-- resource guards
ALTER ROLE saman_app         SET statement_timeout = '5s';
ALTER ROLE saman_app         SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE saman_worker      SET statement_timeout = '30min';
ALTER ROLE saman_maintenance SET statement_timeout = '30min';
ALTER ROLE saman_readonly    SET statement_timeout = '60s';
ALTER ROLE saman_app, saman_worker, saman_maintenance, saman_readonly SET search_path = erp, pg_catalog;
```

**Manifest + drift test (SEC-DATA-16).** `grants.manifest.ts` lists every role × object × privilege; `scripts/check-grants.ts` (integration job on Testcontainers) reads `pg_class.relacl`/`information_schema.role_table_grants`, compares it to the manifest, and fails on **any** drift (extra or missing privilege), including a column-level check that readonly sees no base table. A hand-run `GRANT` in any environment is therefore detectable and fails CI on the next run. Any new table requires a manifest entry in the same PR.

**Verification additions:** `psql "$MIGRATION_DATABASE_URL" -c "\dp erp.*"` output diffed against the manifest; assertion that `saman_app` has zero `DELETE` grants and `saman_readonly` zero base-table `SELECT`; negative tests confirm `saman_readonly` is denied on `password_history`, `login_attempts`, `user_devices`, `security_events`, `system_settings`, `idempotency_keys`, `channel_*`, `auth_sessions` and `api_clients`, and that `saman_app` cannot `DELETE` from any business table.

### 8.2 Ledger and journal immutability — SEC-DATA-03, 04

- `inventory_transactions` is append-only: no `UPDATE`/`DELETE` for `saman_app`; voiding writes `voided_at`/`void_reason` via a `SECURITY DEFINER` function owned by `saman_migrator` that checks the caller's role and writes the audit row; corrections are reversal rows (`ADR-0007`).
- `journal_entries`/`journal_lines`: only `INSERT` and a status transition to `posted` are allowed through a `SECURITY DEFINER` function `erp.post_journal()` (owned by migrator) that validates balance, period status, and the approval id. `UPDATE` of a **posted** entry is rejected by a trigger (`trg_journal_immutable`) for every role except the migrator running an approved reversal function. Period lock (`accounting_periods.status='closed'`) rejects postings with `PERIOD_CLOSED`, including from the worker.
- A nightly consistency job (`workers/ledger-consistency.worker.ts`) compares `Σ inventory_transactions` vs `inventory_balances` and `Σ journal_lines` debit vs credit per entry; mismatch → `CRITICAL` alert (`SEC-MON-05`) and a frozen write for the affected aggregate (feature-flag kill switch).
- **Additional DB invariants from R1-accounting (normative):** `CHECK (reserved + safety_buffer + damaged <= on_hand)` on `inventory_balances` (non-negative `available`, R1-accounting B-06); cost is NOT NULL and `total_cost = round(qty × unit_cost, 0)` for every value-moving `inventory_transactions` type (M-07); `stock_reservations.consumed_inventory_transaction_id` unique when consumed (M-08); `payment_allocations` sum ≤ payment amount enforced by deferred trigger (M-11); `refund.amount <= Σ return_line.refund_amount` (M-11). These are integrity controls, not optional domain polish.

#### Accounting-period, posting and approval integrity — SEC-DATA-15

R1-accounting B-04/B-09/B-16/H-11/H-12/M-17 are enforced here as security-integrity controls (the domain correctness of every posting rule remains the accounting owner's fix set in `docs/_review/round-1/R1-accounting.md`):

1. **Period derived from the legal date (B-09).** `journal_entries.period_id`/`fiscal_year_id` MUST be derived from `entry_date` by trigger/composite FK and verified to belong to the fiscal year; `EXCLUDE USING gist` range constraints prevent overlapping fiscal years/periods; `period_no <= 13` with explicit period-13 rules. A supplied `period_id` that disagrees with the derived period is rejected (`PERIOD_MISMATCH`). Posting into a closed/locked period is `PERIOD_CLOSED` for every role, including the worker.
2. **One transaction, one lock (B-16).** Any inventory write resolves and locks the accounting period (`FOR SHARE`) **before** writing the ledger; ledger row + balance + journal + outbox commit atomically. A receipt/issue targeting a closed period leaves zero ledger rows (test requirement). No "inventory succeeded, journal failed" state is reachable.
3. **Posted documents are immutable; corrections are reversals (H-11).** `trg_journal_immutable` blocks UPDATE of posted journals; `journal_entries.status='voided'` is allowed **only** when a posted reversal entry exists (`reversal_of_id` / `reversal_entry_id` linked both ways); goods receipts/adjustments follow the same rule. Void is a permission (`accounting.journal.void`?) that only performs the reversal, never a status flip. Every reversal/reopen writes `accounting_period_events` and audit.
4. **Header totals recomputed (H-12).** Deferred triggers recompute `journal_entries.total_debit_amount`/`total_credit_amount` from `journal_lines`; `total_debit = total_credit = Σ lines` and each entry balances; a mismatched header cannot be committed. Document numbers are gap-free per fiscal year (`ADR-0014`).
5. **Approval binding (B-04).** Above-threshold journals store a non-null `approval_id` (deferred FK) validated by `erp.post_journal()`; posting rules are versioned (`rule_version_id` stored on the journal) and rule changes are approval-governed config (§3.9).
6. **Close/reopen history (M-17).** `accounting_period_events` is append-only (reason, actor, approver, timestamp); reopen requires approval + step-up + reason; the table is granted SELECT/INSERT only to app/worker.
7. **Consistency freeze.** On a nightly mismatch (ledger vs balance, header vs lines, period vs date) the affected aggregate enters a read-only kill switch (`FEATURE_INVENTORY_FREEZE`, `FEATURE_ACCOUNTING_FREEZE`) until reconciled by an approved manual journal, which is itself audited.

### 8.3 Backup and restore access — SEC-DATA-11

Covered by `SEC-CRYPTO-10/13` and `THREAT-MODEL.md` TB-8. Access rules: only the backup container identity can write to the bucket; human access to dumps requires two-person approval, is logged (`audit` + S3 access logs), and is only for restore drills; production restore is a change-managed operation.

### 8.4 Anonymized staging — SEC-DATA-12

Staging is restored from a **production snapshot with a deterministic anonymization pass** (`scripts/anonymize-dump.sql`): customer names → `مشتری N`, mobiles → valid-format random, national IDs/IBAN → masked, addresses → city-level only, user emails → `user+N@example.test`; password hashes are **kept** (so testers can log in with seeded test accounts) only for accounts whose password is reset by the seed; channel credentials are replaced with sandbox values. The script is tested in CI and its output is rejected if the anonymization flag is absent.

### 8.5 Retention and log lifecycle — SEC-DATA-09, 13

| Data | Active retention | Archive | Basis |
|---|---|---|---|
| `api_request_logs`, `channel_api_calls` | 90 / 180 days | dropped with partition | operations |
| `audit_logs`, `security_events` | 13 months | S3 Parquet, **10 years** | tax/legal (`THREAT-MODEL.md` D-4) |
| `outbox_events` processed | 30 days | dropped | operations |
| Inventory ledger | 10 years (partitioned) | cold archive after 2 years | accounting |
| Journals | permanent (10 years min) | cold archive | accounting/tax |
| Customer PII | life of account + 10 years for financial docs; marketing data deleted on request | — | privacy |
| SMS logs (`sms_messages`) | 6 months | dropped | operations/privacy |
| Backups | 30 days + monthly 12 months | offsite immutable | DR |

Retention is enforced by the `maintenance` worker (partition create/detach/export) and verified by a monthly report. A **legal-hold** flag (`system_settings.legal_hold`) suspends deletion for a defined scope; used during litigation.

### 8.6 Privacy and regulatory notes

**Data inventory (ROPA seed):** customers (name, mobile, address, optional national ID/economic code for e-invoicing), employees (name, mobile, role), orders/returns, SMS content, files (invoices/labels), audit trails. Purpose limitation: operational ERP + accounting; no marketing use of employee/customer data in v1.

**Iranian context (verify with legal counsel — open question Q4/Q6 in `THREAT-MODEL.md`):**
- *E-Commerce Law (قانون تجارت الکترونیکی, 1382):* consumer data confidentiality, order/transaction record keeping, and disclosure of the seller's identity; our storefront obligations are Carexy's, but ERP-held customer data is in scope for confidentiality and access-control requirements.
- *Direct Taxes Act (قانون مالیاتهای مستقیم), art. 96:* books and documents must be kept for at least **10 years** after the fiscal year — this is why audit/accounting retention is 10 y (`ADR deviation D-4`).
- *Computer Crimes Law (1388):* preservation of logs for investigation; legal requests go through counsel; we keep 10 y audit + 90 d request logs and can export on a lawful order with approval.
- Cross-border transfer: if backups are stored outside Iran, it must be a documented business decision (open question Q4); default deployment keeps data on the customer's host in Iran.

**GDPR-readiness (for future EU customers; design now, certify later):**

| Requirement | Implementation |
|---|---|
| Lawful basis & notice | Privacy notice in SPA (`apps/web/src/routes/privacy.tsx`), consent not required for ERP operations (contract/legal obligation) |
| Data minimization | Only fields needed for operations; national ID optional; marketing fields absent |
| Access / portability | `POST /api/v1/privacy/export` → worker builds a JSON/CSV bundle of the data subject's records, step-up + approval, 5-day SLA, audited |
| Erasure | `POST /api/v1/privacy/erase` → pseudonymization of PII fields, financial/audit records retained under legal obligation (documented refusal reason); irreversible within 30 days |
| Records of processing (ROPA) | `docs/04-security/ROPA.md` (roadmap, maintained by Security Lead) |
| Processor agreements | DPA with Digikala/Carexy/Limo; data-flow appendix referencing this doc |
| Breach notification | IR runbook §12: assess within 24 h, notify regulator/customers within 72 h when required |
| DPIA | Required before enabling any new high-risk processing (e.g. biometric warehouse devices — not in v1) |
| Retention deletion jobs | §8.5 + `workers/retention.worker.ts`, report monthly |

### 8.7 Data security summary

| SEC ID | Control | Location | Phase |
|---|---|---|---|
| SEC-DATA-01 | Three DB roles, least privilege, no DDL for app | `infra/docker/postgres/init/01-roles.sql` | P1 |
| SEC-DATA-02 | No superuser application connection | same + boot check | P1 |
| SEC-DATA-03 | Append-only ledger + void procedure | migrations, `ledger.service.ts` | P2 |
| SEC-DATA-04 | Immutable posted journals + period lock | migrations, `journal.service.ts` | P4 |
| SEC-DATA-05 | Audit append-only grants | roles SQL | P1 |
| SEC-DATA-06 | Composite FKs + org scoping | migrations | P2 |
| SEC-DATA-07 | Readonly role restricted + reporting views | roles SQL, `v_*` views | P4 |
| SEC-DATA-08 | PII masking in views/serializers | views, serializers | P2 |
| SEC-DATA-09 | Partition retention + drop/archive | `workers/partition-maintenance.worker.ts` | P7 |
| SEC-DATA-10 | No manual production DDL; migrations only | process + `pg_hba`/grants | P1 |
| SEC-DATA-11 | Backup bucket policy write-only + object lock | `infra/backup/`, MinIO policy | P7 |
| SEC-DATA-12 | Anonymized staging dump | `scripts/anonymize-dump.sql` | P7 |
| SEC-DATA-13 | Retention jobs + legal hold | `workers/retention.worker.ts` | P7 |
| SEC-DATA-14 | Privacy export/erase endpoints | `modules/platform/privacy/` | roadmap (P7+) |
| SEC-DATA-15 | Accounting-period/posting/approval integrity (period derived from date, closed-period rejection, posted immutability + reversal, header totals, append-only period events) (R1-accounting B-04/B-09/B-16/H-11/H-12/M-17) | migrations/triggers, `erp.post_journal()`, `accounting_period_events` | P4 |
| SEC-DATA-16 | Explicit grant manifest + `\dp` drift CI test; app/worker no DELETE; readonly views-only; maintenance role for lifecycle deletes (R1 H-12) | `packages/db/grants.manifest.ts`, `scripts/check-grants.ts` | P1 |

---

## 9. Pre-release security sign-off checklist

Release gate `README.md` §7.5. This section MUST be signed off by the Security Lead before any production release. **Evidence rule (R1 B-01):** every row requires an artifact triple — (1) **source/route file path**, (2) **test name** that exercises the control, (3) **CI run id/link** (or signed manual-verification record for infra rows). A row with any element missing is **not signed**, and the release is blocked. Pasting a design quote, a code snippet without a test, or a local screenshot is not evidence. The `implemented-in-code` status in §0.2 is defined by this triple.

| # | Sign-off item | Control | Required artifact (file + test + CI run) | Sign |
|---|---|---|---|---|
| 1 | No secret in repository history; gitleaks clean | SC-07 | `security.yml` job id + gitleaks artifact URL | ☐ |
| 2 | `pnpm audit --audit-level=high` clean; Trivy images 0 CRITICAL/HIGH; actions SHA-pinned | SC-07, L-01 | dependency/container job ids + artifact URLs | ☐ |
| 3 | Argon2id calibrated + password policy tests | AUTH-01/13 | `password.service.spec.ts`, `password-policy.spec.ts` + run id | ☐ |
| 4 | No token in browser storage; CSP deployed with `script-src 'self'` only | AUTH-02, TLS-07 | `auth-store.spec.ts`, `headers.snapshot.spec.ts` + run id | ☐ |
| 5 | Lockout + OTP/SMS/voice budgets + CAPTCHA fail-closed | AUTH-03/04/12, RL-09 | `login-throttle.spec.ts`, `otp-limits.spec.ts` + run id | ☐ |
| 6 | Refresh rotation + reuse detection + session revocation | AUTH-06/08/09 | `session-rotation.spec.ts`, `revocation.spec.ts` + run id | ☐ |
| 7 | MFA enforced for mandatory-MFA roles on sensitive routes | AUTH-05 | route×role matrix test + run id | ☐ |
| 8 | **Device secret trust: copied fingerprint without device cookie ⇒ 202 MFA** (B-02) | AUTH-07/14 | `device-trust.spec.ts`, `device-secret.spec.ts` + run id | ☐ |
| 9 | **No public password-reset endpoints; admin reset subset check; token+OTP flow; sessions/devices revoked** (B-03) | AUTH-15 | `password-reset.spec.ts` + route snapshot (no `/auth/password/forgot`) | ☐ |
| 10 | **JWT verification: alg:none/confusion/unknown-kid rejected; jti revocation on sensitive routes** (L-04) | AUTH-16 | `jwt-verification.spec.ts` + run id | ☐ |
| 11 | **Break-glass two-person flow; denylist; kill switch** (M-07) | AUTH-17 | `breakglass.spec.ts` + audit artefact | ☐ |
| 12 | Every mutating route has a permission decorator; registry parity bidirectional | AZ-01/02/03/14 | `check-permissions` job + `lint` job ids | ☐ |
| 13 | **Role/scope escalation matrix: no amplification, step-up, pv bump, scope revocation** (H-01/M-10) | AZ-07/08/15 | `role-escalation.spec.ts`, `scope-immediacy.spec.ts` + run id | ☐ |
| 14 | **Approval config: 2-person + cooling; DB `approval_id`; disjoint author/post** (B-04) | AZ-16 | `approval-config.spec.ts`, `post-journal-requires-approval.sql` test + run id | ☐ |
| 15 | **Export/report/dashboard: per-entity permission, owner scoping, closed templates** (H-02/H-09) | AZ-17 | `export-authz.spec.ts`, `report-permissions.spec.ts` + run id | ☐ |
| 16 | **API-client token, CIDR, scope mapping, audit actor_type** (M-06) | AZ-18 | `api-client-auth.spec.ts` + run id | ☐ |
| 17 | IDOR/scope matrix for all roles × branches × warehouses; out-of-scope ⇒ 404 | AZ-04/10, IN-08, M-09 | `scope.spec.ts`, `idor.spec.ts`, `scope-probe.spec.ts` + run id | ☐ |
| 18 | Cost/margin/PII masking in every list/detail/export | AZ-06, DATA-08 | serializer snapshot + `masking.spec.ts` + run id | ☐ |
| 19 | SoD requester≠approver (DB trigger) | AZ-11 | `sod-trigger.sql` test + run id | ☐ |
| 20 | SQLi negative tests; no `sql.raw`/unsafe SQL | IN-02/03/04 | Semgrep job + `sqlinjection.spec.ts` + run id | ☐ |
| 21 | XSS corpus inert in product/customer/order fields | OUT-01/02 | `xss.spec.ts` (Playwright) + run id | ☐ |
| 22 | Upload: polyglots/SVG/oversize rejected; re-encode; presigned constraints; orphans collected (H-05) | IN-10/18 | `upload-pipeline.spec.ts`, lifecycle test + run id | ☐ |
| 23 | SSRF corpus blocked; **code-declared hosts + boot assertion** (M-05) | IN-06/07/21 | `ssrf.spec.ts`, `egress-boot.spec.ts` + run id | ☐ |
| 24 | Webhook: MAC binds event id/timestamp; replay; non-configurable scheme; fetch-back (H-03/M-03) | IN-11..14/17 | `webhook.spec.ts`, `webhook-replay.spec.ts` + run id | ☐ |
| 25 | **Outbound webhook destination allowlist; no cost fields; first-delivery alert** (H-04) | IN-16 | `outbound-webhook.spec.ts` + alert config diff | ☐ |
| 26 | **Channel payloads: no headers/PII persisted; archive encrypted; 30 d; step-up view** (H-10) | IN-20 | `channel-payload.spec.ts`, DB-inspection script output | ☐ |
| 27 | **Import zip-bomb caps; PDF renderer inert/file-less** (M-04) | IN-19 | `import-limits.spec.ts`, `pdf-render.spec.ts` + run id | ☐ |
| 28 | **File download entity-scoped; cross-scope 404; download audit** (H-06) | OUT-04/07 | `file-download-authz.spec.ts` + run id | ☐ |
| 29 | Channel credentials AES-GCM, no plaintext at rest, redaction test | CRYPTO-01/05/06 | `envelope.spec.ts`, `no-secrets-in-logs.spec.ts` + DB inspection | ☐ |
| 30 | **No secrets in container env (`docker inspect`/`exec env`) — Compose secrets mounted** (H-11) | CRYPTO-16 | `scripts/verify-host.sh` output + compose config diff | ☐ |
| 31 | Encryption-key rotation rehearsed; re-encrypt idempotent; `crypto:audit` zero old prefixes | CRYPTO-03 | rehearsal report + `crypto:audit` log | ☐ |
| 32 | Backups age-encrypted; restore drill within RPO/RTO | CRYPTO-10, DATA-11 | `verify-backup.sh` + restore report | ☐ |
| 33 | **Audit schema hash columns; `chain_audit()` EXECUTE-only; hourly verifier; vocabulary insertable** (B-05/M-01) | AUD-01/02/08/11/12 | `audit-chain.spec.ts`, `audit-vocab.spec.ts`, verifier output | ☐ |
| 34 | **DB grant manifest: app/worker no DELETE; readonly views-only; `\dp` diff green** (H-12) | DATA-01/02/07/16 | `check-grants.ts` job id + `\dp` diff artifact | ☐ |
| 35 | **Accounting integrity: period derived from date; closed-period rejection; posted immutability + reversal link; header totals recomputed; period events append-only** (accounting B-09/B-16/H-11/H-12/M-17) | DATA-15 | `period-integrity.spec.ts`, `journal-immutability.spec.ts`, `reconciliation.spec.ts` + run id | ☐ |
| 36 | **Idempotency keyed by actor: `(org, actor, scope, key)`; cross-actor reuse cannot leak/replay** (M-02) | IN-05 | `idempotency.spec.ts` + migration diff | ☐ |
| 37 | Security headers and TLS grade (A/A+), HSTS preload ready | TLS-01/02/08 | `check-headers.sh`/`testssl.sh` output | ☐ |
| 38 | Docker hardening: non-root, no caps, read-only, no DB/Redis ports, **edge port model correct (L-02)** | INF-01/02/03 | `docker compose config` + `inspect` output | ☐ |
| 39 | Host hardening applied (ufw/sshd/fail2ban/unattended-upgrades); **deploy user has no docker-root path** (H-11) | INF-07/08, CRYPTO-16 | `verify-host.sh` output + sudoers diff | ☐ |
| 40 | OWASP ZAP baseline + authenticated API scan: no HIGH/CRITICAL; MEDIUMs accepted | SDLC-04 | ZAP report + risk acceptance in `docs/_review/` | ☐ |
| 41 | ASVS L2 checklist: every `planned` row for this release is `implemented-in-code` (with triple) or explicitly deferred | §14 | ASVS diff artifact | ☐ |
| 42 | Threat model updated: no unowned High/Critical risk; R1 findings all `fixed` or `deferred+owner` | §1, §17 | risk register review | ☐ |
| 43 | IR contacts/on-call current; runbook offline-accessible; break-glass custodians confirmed | MON-09 | runbook review record | ☐ |
| 44 | Public health/webhook endpoints disclose no config (`/webhooks/health` internal-only) (L-05) | MON-01 | `headers/health` test + route access snapshot | ☐ |

Sign-off requires all 44 rows **with artifacts**; a missing artifact is a release blocker. Exceptions need a written risk acceptance in `docs/_review/` signed by Lead Architect + Security Lead, and the row is then marked `accepted-risk` (never "signed").

---

## 10. Infrastructure and container hardening

### 10.1 Network segmentation and port exposure — SEC-INF-03, 04, 06

Docker networks (`docker-compose.yml`):

```yaml
networks:
  edge:        # published ports live here only
    driver: bridge
  backend:     # internal services, no egress by default
    driver: bridge
    internal: true
```

| Service | Networks | Published ports | Notes |
|---|---|---|---|
| `web`/`edge` (nginx/Caddy) | edge | host `80:8080`, `443:8443` | only public entry; **container listens on 8080/8443 as non-root** (R1 L-02) — never re-add `NET_BIND_SERVICE` silently |
| `api` | edge, backend | none | reachable only via edge |
| `worker` | backend | none | outbound egress via host firewall rules (no `saman_maintenance` role) |
| `maintenance` (cron/retention) | backend | none | holds `saman_maintenance` credentials; not reachable from the internet |
| `postgres` | backend | **none** | never published (`ADR-0012`) |
| `redis` | backend | **none** | `requirepass`, `bind 0.0.0.0` only inside docker network |
| `minio` | backend | **none** | console not exposed in production |
| `backup` | backend | none | egress only to S3 endpoint |

The host firewall (SEC-INF-08) allows inbound `22/tcp` from the admin/VPN CIDR only, `80/443` from anywhere; denies everything else. Worker egress is restricted (Docker `--cap-drop` + host nftables/ufw rules) to the allowlisted channel/SMS/S3 destinations plus DNS — defense in depth for `SEC-IN-06`/`SEC-IN-07`.

### 10.2 Container hardening — SEC-INF-01, 02, 05

```yaml
x-hardening: &hardening
  user: "10001:10001"            # non-root uid/gid created in the image
  read_only: true
  init: true
  cap_drop: [ALL]                # the edge listens on 8080/8443, so NET_BIND_SERVICE is NOT needed
  security_opt: ["no-new-privileges:true"]
  tmpfs: ["/tmp:size=64m,mode=1777", "/app/.cache:size=64m"]
  pids_limit: 512
  mem_limit: "1g"                # per-service, sized in DEPLOYMENT.md
  ulimits: { nofile: { soft: 4096, hard: 8192 } }
  restart: unless-stopped
  logging: { driver: json-file, options: { max-size: "20m", max-file: "5" } }
  healthcheck: { test: ["CMD", "node", "dist/healthcheck.js"], interval: 30s, timeout: 5s, retries: 3 }

services:
  api:    <<: *hardening
    # no docker.sock mount, no host network, no privileged
    secrets: [jwt_access_secret, jwt_access_secret_previous, refresh_pepper, otp_pepper,
              app_encryption_key, db_app_password, redis_password, s3_access_key, s3_secret_key,
              limo_api_key]
  worker: <<: *hardening
    secrets: [jwt_access_secret, refresh_pepper, otp_pepper, app_encryption_key,
              db_app_password, redis_password, s3_access_key, s3_secret_key, limo_api_key]
  web:    <<: *hardening   # nginx-unprivileged image; listens 8080/8443

secrets:                     # file secrets: root-owned 0400 on host, tmpfs /run/secrets, mode 0400
  jwt_access_secret:        { file: ./secrets/jwt_access_secret }
  jwt_access_secret_previous: { file: ./secrets/jwt_access_secret.previous }
  refresh_pepper:           { file: ./secrets/refresh_pepper }
  otp_pepper:               { file: ./secrets/otp_pepper }
  app_encryption_key:       { file: ./secrets/app_encryption_key }
  db_app_password:          { file: ./secrets/db_app_password }
  redis_password:           { file: ./secrets/redis_password }
  s3_access_key:            { file: ./secrets/s3_access_key }
  s3_secret_key:            { file: ./secrets/s3_secret_key }
  limo_api_key:             { file: ./secrets/limo_api_key }
```

Rules: production images run as a **non-root** user; read-only root filesystem with explicit `tmpfs`; all Linux capabilities dropped; `no-new-privileges` (setuid escalation blocked); no `docker.sock`, no `pid: host`, no `network_mode: host`, no `privileged: true`; seccomp default (optional tailored profile roadmap); images multi-stage (`node:22-alpine`), prod deps only, `HEALTHCHECK`, pinned by digest (`SEC-SC-04`); `docker compose down -v` never in scripts (`ADR-0012`); the Docker daemon itself is not exposed over TCP, `userns-remap` optional, `live-restore` off, log driver rotation configured.

**Secrets inside containers (R1 H-11).** Secrets arrive only as files under `/run/secrets/*` (Compose `secrets:`, tmpfs, `mode: 0400`, owner = container uid); `docker inspect … .Config.Env` and `docker exec … env` MUST show none. The edge runs unprivileged on 8080/8443; if a deployment insists on binding 80/443 inside the container, `cap_add: [NET_BIND_SERVICE]` must be explicit and justified in review — silently re-adding capabilities is a defect (R1 L-02).

PostgreSQL/Redis/MinIO containers also run non-root where the image supports it, with data volumes owned by fixed uids; MinIO root credentials are **not** used by the app (`SEC-CRYPTO-08`).

### 10.3 Host hardening — SEC-INF-07, 08, 09, 10

`scripts/harden-host.sh` (idempotent; idempotence tested in CI with `--check`) applies:

```bash
# firewall
ufw default deny incoming; ufw default allow outgoing
ufw allow from "$ADMIN_CIDR" to any port 22 proto tcp
ufw allow 80/tcp; ufw allow 443/tcp
ufw --force enable

# sshd_config.d/99-saman.conf
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers deploy
MaxAuthTries 3
LoginGraceTime 20
AllowTcpForwarding no
X11Forwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
# ed25519 keys only; admin keys in /home/deploy/.ssh/authorized_keys (600/700)

# fail2ban: jail sshd (maxretry 3, bantime 1h), nginx-http-auth, nginx-badbots, recidive (1w)
# unattended-upgrades: security pockets on, automatic reboot window 04:00, reboot-required alert
# auditd: watch /etc/passwd,/etc/shadow,/etc/sudoers,/etc/ssh,/var/run/docker.sock
# sysctl: fs.protected_hardlinks=1, fs.protected_symlinks=1, kernel.dmesg_restrict=1,
#         net.ipv4.conf.all.rp_filter=1, kernel.yama.ptrace_scope=1, net.ipv4.tcp_syncookies=1
# time sync: chrony/systemd-timesyncd required (JWT/TOTP/skew correctness)
```

Also: full-disk encryption (LUKS) on the data volume **recommended** (roadmap; if unavailable, document the accepted risk); `/var/lib/docker` on a dedicated encrypted volume where possible; root login restricted to the console; **the deploy user MUST NOT have `sudo docker`/docker-group access** — that is root-equivalent (can read `/run/secrets`, `docker inspect` env, mount the host FS). Deploy via rootless Docker or a root-owned, narrowly scoped systemd unit that runs `docker compose -f /opt/saman/compose.yml up -d` with secret files owned by root; `sudo` is limited to that unit and log/journal read commands. This is recorded in `DEPLOYMENT.md`/`RUNBOOK.md` (routing). Security updates applied monthly at minimum with a documented exception process; UFW + fail2ban logs shipped off-host; file-integrity monitoring for `.env`, compose files, `secrets/`, and nginx config (auditd watches, alert on change).

`SEC-INF-10`: backups offsite + immutable (`SEC-CRYPTO-10`), restore drill quarterly, and a documented "ransomware / host-loss" recovery path in `docs/07-operations/BACKUP-RESTORE.md`; the host is rebuilt from the repository + encrypted backup, not patched back.

### 10.4 Infrastructure summary

| SEC ID | Control | Location | Phase |
|---|---|---|---|
| SEC-INF-01 | Non-root, read-only, dropped caps, no-new-privileges | `docker-compose.yml` `x-hardening` | P1 |
| SEC-INF-02 | No privileged/socket/host-network containers | compose review + CI scan | P1 |
| SEC-INF-03 | Network segmentation, internal networks, no DB/Redis ports | compose networks | P1 |
| SEC-INF-04 | Redis `requirepass`, bind internal, no persistence of authority | compose, `redis.conf` | P1 |
| SEC-INF-05 | PG timeouts/pool caps/resource limits | roles SQL, compose limits | P1 |
| SEC-INF-06 | Private MinIO bucket, console not exposed | `infra/docker/minio/init.sh` | P7 |
| SEC-INF-07 | SSH keys only, no root, AllowUsers, ed25519 | `scripts/harden-host.sh` | P7 |
| SEC-INF-08 | ufw allowlist + fail2ban + unattended upgrades | `scripts/harden-host.sh` | P7 |
| SEC-INF-09 | auditd + docker events + FIM for security files | same | P7 |
| SEC-INF-10 | Immutable offsite backup + restore drill + rebuild path | `infra/backup/`, runbook | P7 |
| SEC-INF-11 | Compose secret mounts + non-root edge ports (8080/8443) + no docker-root path for deploy user (R1 H-11/L-02) | `docker-compose.yml`, `scripts/verify-host.sh`, sudoers diff | P7 |

---

## 11. Supply chain and CI security

### 11.1 Dependency and artifact controls — SEC-SC-01..04, 09

- **Lockfile is truth:** `pnpm-lock.yaml` committed; CI uses `pnpm install --frozen-lockfile`; `save-exact=true`; no version ranges in `package.json` beyond what the lock resolves. Renovate/Dependabot PRs only (SEC-SC-02) with a **7-day cooling period** for new versions and grouped weekly updates.
- **Install scripts disabled by default:** `.npmrc` → `ignore-scripts=true`; the few packages that genuinely need native builds are explicitly allowlisted in `package.json` `pnpm.onlyBuiltDependencies` (expected: `@node-rs/argon2`, `sharp`, `esbuild`); adding to that list requires Security review.
- **Registry policy:** packages come from the configured registry (with integrity hashes in the lockfile); a private proxy/mirror is recommended for availability; `.npmrc` contains no tokens (auth via CI environment).
- **SBOM + licenses (SEC-SC-03):** CI generates CycloneDX SBOM (`pnpm dlx @cyclonedx/cyclonedx-npm --output-file sbom.json`) and stores it as a release artifact; a license allowlist check rejects GPL/AGPL in shipped code unless approved.
- **Images (SEC-SC-04):** base images pinned by digest (`node:22-alpine@sha256:…`), rebuilt weekly or on security update; final stage prod-only deps; Trivy image scan gates the build.
- **Releases (SEC-SC-08, roadmap):** git tags `v*` signed (or protected), images signed with cosign and verified at deploy; deploy pulls by digest, never `latest`. v1.0 compensating control: deploy script records and displays the image digests and the git commit, and refuses a digest that is not in the signed release manifest.

### 11.2 CI/CD pipeline and gates — SEC-SC-05, 06, 07

`.github/workflows/ci.yml` stages (a failing stage blocks merge; §12.5 of `ARCHITECTURE.md` testing strategy aligns):

```
install (frozen lockfile, ignore-scripts)
  → lint (eslint incl. custom security rules)
  → typecheck
  → unit tests
  → integration tests (Testcontainers postgres/redis/minio)
  → build (api, worker, web)
  → security (parallel): gitleaks · semgrep · trivy fs · pnpm audit · SBOM
  → e2e smoke (Playwright)
  → container build + trivy image
  → deploy staging (on main) → ZAP baseline → manual approval → deploy production (on tag)
```

`.github/workflows/security.yml` (nightly + on PR):

```yaml
name: security
on: [pull_request, schedule]           # schedule: cron '0 2 * * *'
jobs:
  secrets:    { steps: [ { uses: gitleaks/gitleaks-action@<40-char-sha>   # v2.x, Renovate-managed } ] }
  sast:       { steps: [ { run: semgrep ci --config p/owasp-top-ten --config infra/semgrep/saman.yml } ] }
  deps:       { steps: [ { run: pnpm audit --audit-level=high } ] }
  containers: { steps: [ { run: trivy image --severity CRITICAL,HIGH --exit-code 1 "$IMAGE" } ] }   # trivy image pinned by digest
  iac:        { steps: [ { run: trivy config docker-compose.yml infra/ } ] }
  sbom:       { steps: [ { run: pnpm dlx @cyclonedx/cyclonedx-npm@<exact-version> --output-file sbom.json } ] }
  pins:       { steps: [ { run: node scripts/check-action-pins.mjs } ] }   # fails any `uses:` without a 40-char SHA
```

**Tool/action pinning (R1 L-01).** Every GitHub Action is pinned to a **full 40-character commit SHA** (with a Renovate comment naming the release), Trivy is referenced by a pinned image digest, and the SBOM tool by an exact version. `scripts/check-action-pins.mjs` scans `.github/workflows/**` and fails the build on any tag/branch ref (`@v2`, `@main`) or short SHA; the same script also fails on `pull_request_target` and on any workflow that exposes environment secrets to fork PRs. A compromised upstream tag therefore cannot execute with our `GITHUB_TOKEN`/environment secrets.

**Branch protection (SEC-SC-05):** `main` and release tags protected: no direct push, 1 approving review (2 for paths in `CODEOWNERS`: `docs/04-security/**`, `apps/api/src/common/{auth,crypto,guards,audit}/**`, `infra/**`, `packages/db/migrations/**`), required status checks (lint, typecheck, unit, integration, security), no force-push, linear history, signed commits recommended. Production deploy uses a GitHub **environment** with required reviewer (DevOps Lead + one more) and environment-scoped secrets.

**CI secrets (SEC-SC-06):** no long-lived production credentials in CI; deploy credentials are environment secrets rotated quarterly; prefer OIDC/short-lived tokens where the hosting provider allows (roadmap). CI actions are pinned by full commit SHA (not tags). PRs from forks never receive secrets; `pull_request_target` is banned.

**Custom Semgrep rules (`infra/semgrep/saman.yml`):** `sql.raw`/`unsafe()` usage; `dangerouslySetInnerHTML`; `child_process`/`eval`/`new Function`; `fetch`/`axios` outside `packages/http-client` and adapters; `console.log`; hardcoded credentials; `crypto.createCipher`/`Math.random` for security values; wildcard CORS; `**` permission checks; `jwt.decode` without verify. Gitleaks config `.gitleaks.toml` with an allowlist limited to documented test fixtures.

### 11.3 Supply chain summary

| SEC ID | Control | Location | Phase |
|---|---|---|---|
| SEC-SC-01 | Frozen lockfile, `ignore-scripts`, allowlist | `pnpm-lock.yaml`, `.npmrc`, `package.json` | P1 |
| SEC-SC-02 | Renovate/Dependabot, cooling period, dependency review | `.github/dependabot.yml`, `renovate.json` | P1 |
| SEC-SC-03 | SBOM + license allowlist | `security.yml` | P1 |
| SEC-SC-04 | Digest-pinned base images, weekly rebuild | `apps/api/Dockerfile`, `apps/web/Dockerfile` | P1 |
| SEC-SC-05 | Branch protection, CODEOWNERS, required checks | GitHub settings (documented in `DEPLOYMENT.md`) | P1 |
| SEC-SC-06 | Least-privilege CI secrets, actions pinned by SHA | `.github/workflows/` | P1 |
| SEC-SC-07 | gitleaks + semgrep + Trivy + audit gates | `security.yml`, `infra/semgrep/` | P1 |
| SEC-SC-08 | Signed releases/images + verify at deploy (roadmap) | release pipeline | roadmap |
| SEC-SC-09 | Registry policy, no tokens in `.npmrc` | config | P1 |
| SEC-SC-10 | CI action/tool pinning policy test (40-char SHAs, pinned Trivy digest, pinned SBOM version) (R1 L-01) | `scripts/check-action-pins.mjs`, `security.yml` | P1 |

---

## 12. Monitoring, alerting, and incident response

### 12.1 Security observability — SEC-MON-01

- Metrics endpoint `/metrics` is **internal only** (nginx `deny all` / docker network); it exposes counters, never labels containing PII/secrets. `/health/version` (commit/env) and `/webhooks/health` (`secretConfigured`, `lastEventAt`) are **not public**: they require `system.read` or an internal scrape token/edge allowlist and return only `{status:"ok"}` anonymously (R1 L-05 — no free reconnaissance about webhook verification state).
- Structured logs (`pino` JSON) are shipped to the log store (docker log rotation by default; optional Loki/ELK profile in `DEPLOYMENT.md`). Security lines carry `"security": true, "event": "...", "severity": "..."` for SIEM filtering.
- A minimal alerting stack is **required for go-live**: Prometheus + Alertmanager or equivalent (healthchecks + threshold rules), with at least one non-host notification channel (email/SMS/Telegram to on-call). The runbook documents every rule with a response action.

### 12.2 Alert rules — SEC-MON-02..08

| Alert | Condition | Severity | Response |
|---|---|---|---|
| `auth.bruteforce` / `auth.stuffing` | §7.2 thresholds | High/Critical | on-call + consider edge block |
| `otp.flood` / `sms.budget` | §7.2; budget > 80 % / 100 % | High | on-call + provider contact |
| `refresh.reuse` | any | Critical | sessions already revoked; investigate |
| `webhook.signature.invalid` burst | ≥ 10/min | High | verify partner status, check secret rotation |
| `egress.blocked` | any | High | identify actor/route, may indicate SSRF attempt |
| `audit.chain_mismatch` | any | Critical | preserve evidence, incident response |
| `db.pool` | connections > 80 % for 5 min | High | scale/limit, check slow queries |
| `queue.backlog` / `outbox.lag` | depth > cap / lag > 60 s | High | worker health |
| `disk` | < 15 % free | High | retention/partition check |
| `backup.age` | > 26 h since success or verify failure | Critical | run backup now, investigate |
| `tls.expiry` | < 21 days | Medium | renew |
| `host.reboot_required` | security update pending | Medium | schedule window |
| `container.drift` | running image digest ≠ manifest | Critical | incident response |
| `privilege.offhours`, `journal.anomaly`, `export.large` | §7.2 | High/Medium | notify Security + Finance |

### 12.3 Incident-response runbook — SEC-MON-09

Target location: `docs/07-operations/INCIDENT-RESPONSE.md` (DevOps Lead owns the file; this section is the normative security content). Severity: **S1** confirmed data breach / full compromise / financial fraud in progress; **S2** active account takeover, ransomware attempt, forged webhook chain; **S3** single-account compromise, policy violation, vulnerability with no exploit; **S4** low-risk findings.

**Phase 1 — Detect & triage (target ≤ 30 min for S1/S2).** Confirm the alert, assign incident commander (Security Lead; backup: DevOps Lead), open an incident channel, start an evidence log (timestamps in UTC + Tehran, who/what/when). Preserve evidence **before** remediation: snapshot DB (`pg_dump` to an offsite evidence bucket), copy logs, `docker inspect`, `ss -tunap`, process list, current image digests, `audit_logs` export. Never delete logs or "fix first, investigate later".

**Phase 2 — Contain.** Options by scenario: revoke all sessions for affected users (`POST /users/{id}/sessions/revoke` + SQL `UPDATE auth_sessions SET revoked_at=now()` for mass revoke); rotate `JWT_ACCESS_SECRET` (with the `.previous` dual-verify window) and all peppers; disable the compromised account; block source IPs at ufw/edge; disable a channel receiver (`DIGIKALA_WEBHOOKS_ENABLED=false`); pause the worker (`docker compose stop worker`) to stop outbound damage while keeping API reads; rotate channel credentials at the provider (Carexy/Digikala/Limo) if credential exposure is suspected; isolate the host (firewall drop all except admin VPN) if root compromise is suspected; if a break-glass session exists, revoke it and file the mandatory review ticket.

**Phase 3 — Eradicate.** Identify root cause (log timeline, audit chain, diff of config/images), remove persistence (rogue users, API clients, SSH keys, cron jobs, containers, images, DB triggers/functions), patch the vulnerability, rebuild containers from verified digests rather than patching in place; re-run full dependency/container scans.

**Phase 4 — Recover.** Restore from a verified backup only if integrity is in doubt, following the restore drill procedure; validate data integrity (ledger/journal consistency, audit chain verification, trial balance); re-enable features gradually; monitor for 72 h with heightened alerting; rotate every secret touched.

**Phase 5 — Postmortem (within 5 business days, blameless).** Timeline, root cause, impact (data/subjects/amounts), detection & response metrics (MTTD/MTTR), what worked/failed, action items with owners and dates, threat-model update (`THREAT-MODEL.md` §5–§8), new tests/controls, and (if applicable) regulatory/customer notification assessment. Store in `docs/_review/incident-YYYY-MM-DD.md`.

**Legal/regulatory:** breach notification assessed within 24 h, notify affected data subjects/regulator within 72 h where GDPR applies; Iranian Computer Crimes Law cooperation via counsel (preserve logs, chain of custody); insurer notification if cyber coverage exists. Communication templates and contact list (roles, not personal numbers in git) live in the runbook.

### 12.4 Monitoring and IR summary

| SEC ID | Control | Location | Phase |
|---|---|---|---|
| SEC-MON-01 | Metrics/logs/security event pipeline | `apps/api/src/common/observability/`, `infra/` | P1 |
| SEC-MON-02 | Auth/OTP abuse alerts | alert rules | P1 |
| SEC-MON-03 | DB/disk/resource alerts | alert rules | P1 |
| SEC-MON-04 | Queue/outbox alerts | alert rules | P5 |
| SEC-MON-05 | Privileged action / journal anomaly alerts | alert rules | P4 |
| SEC-MON-06 | Egress/SSRF denial alert | alert rules | P5 |
| SEC-MON-07 | Backup/TLS/cert/reboot alerts | alert rules | P7 |
| SEC-MON-08 | SMS budget alerts | alert rules | P1 |
| SEC-MON-09 | Incident-response runbook (normative content above) | `docs/07-operations/INCIDENT-RESPONSE.md` | P7 |

---

## 13. Secure SDLC

| SEC ID | Control | Location | Phase |
|---|---|---|---|
| SEC-SDLC-01 | Security requirements & DoD: every feature has permission + audit + input validation + tests + threat-model row; "security" in the PR template checklist | `docs/`, `.github/PULL_REQUEST_TEMPLATE.md` | P1 |
| SEC-SDLC-02 | Change control: migrations only via `saman_migrator`; schema changes reviewed by DB owner + Security if touching auth/audit/credentials; release notes carry security impact | PR process | P1 |
| SEC-SDLC-03 | Code review security checklist: authz on new route, input validation, no secret/log leak, SQL parameterization, output encoding, scope filtering; CODEOWNERS for security paths | `docs/_review/SECURITY-REVIEW-CHECKLIST.md` | P1 |
| SEC-SDLC-04 | Security testing gates: SAST/SCA/secrets per PR; ZAP baseline per release; threat-model review per boundary; external pen test before go-live (ASVS L2 scope) and annually; findings tracked to closure | CI + `docs/05-testing/` | P1/P7 |
| SEC-SDLC-05 | Release checklist: §9 sign-off, image digest recorded, `.env` diff reviewed (no new plaintext secrets), migrations dry-run on staging with anonymized data, rollback plan | release PR | P1 |

Security training/awareness (roadmap): annual secure-coding training for the team, phishing awareness for ERP users, and a documented security champions model. Vulnerability disclosure: `SECURITY.md` (root) `security.txt`-style contact + 90-day coordinated disclosure policy at `/.well-known/security.txt` (roadmap).

---

## 14. OWASP ASVS 4.0 Level 2 checklist

This is the release acceptance contract. Status at design baseline: all application controls are `planned` (the implementation tree is empty); infra controls are `planned` for P7. The **phase** column says when a row must flip to `implemented-in-code`. Requirement groups follow the ASVS 4.0 chapter structure: where a chapter has a single L2 requirement group we keep the group ID and split rows by **aspect** (clearly labelled), so every row is traceable to a real ASVS group. "Where" points to control IDs/tables in this document.

| ASVS group | Aspect / requirement intent | Status | Where | Notes |
|---|---|---|---|---|
| V1.1 | Secure SDLC: threat modeling, secure coding, gates | planned (P1/P7) | SEC-SDLC-01..05, `THREAT-MODEL.md` | reviewed per release |
| V1.2 | Authentication architecture | planned (P1) | SEC-AUTH-01..13 | two-token model per ADR-0004 |
| V1.3 | Session management architecture | planned (P1) | SEC-AUTH-02/06/08/11 | rotation, revocation, idle |
| V1.4 | Access-control architecture (default deny, least privilege) | planned (P1) | SEC-AZ-01..13 | registry + guards |
| V1.5 | Input/output architecture (positive validation, encoding) | planned (P1) | SEC-IN-01, SEC-OUT-01/03 | Zod + serializers |
| V1.6 | Cryptographic architecture (approved algorithms, key lifecycle) | planned (P1) | SEC-CRYPTO-01..15 | AES-GCM + keyrings |
| V1.7 | Error handling and logging architecture | planned (P1) | SEC-IN-09, SEC-AUD-01..10 | no internals; audit chain |
| V1.8 | Data protection architecture (classification, PII) | planned (P2/P7) | SEC-AZ-06, §8.5/§8.6 | four-level classification |
| V1.9 | Communication architecture (TLS everywhere) | planned (P7) | SEC-TLS-01..09 | TLS 1.2+ only |
| V1.10 | Malicious code architecture (dependencies, integrity) | planned (P1) | SEC-SC-01..07 | lockfile + scans |
| V1.11 | Business-logic architecture (flows, limits, invariants) | planned (P4) | SEC-AZ-11/12, `ADR-0007/0008` | SoD, allocation |
| V1.12 | Secure file upload architecture | planned (P2) | SEC-IN-10 | private bucket, re-encode |
| V1.14 | Configuration architecture (fail-fast, secure defaults) | planned (P1) | §18 env schema, SEC-CRYPTO-09/16 | boot guards |
| V2.1 | Password security: 12+ chars, breach check, no forced rotation | planned (P1) | SEC-AUTH-13 | zxcvbn + breach list |
| V2.1 | Password storage: Argon2id, calibrated | planned (P1) | SEC-AUTH-01 | ~250 ms on target host |
| V2.2 | General authenticators: anti-automation, lockout, breach checks | planned (P1) | SEC-AUTH-03, SEC-RL-01 | progressive delay |
| V2.2 | Rate limiting / anti-automation effectiveness | planned (P1) | SEC-RL-01..08 | Redis + fallback |
| V2.3 | Authenticator lifecycle: OTP TTL, single-use, attempt limits | planned (P1) | SEC-AUTH-04/12 | 2 min, 5 attempts |
| V2.4 | Credential storage: no plaintext, hashed OTP/tokens | planned (P1) | SEC-AUTH-01/04/06, SEC-CRYPTO-12 | HMAC-SHA256 pepper |
| V2.5 | Credential recovery: safe reset, no email reset, no knowledge leak | planned (P1) | §2.8 | admin-assisted, one-time temp |
| V2.6 | Look-up secret verifier (OTP) + user-enumeration resistance | planned (P1) | SEC-AUTH-04/10 | generic responses |
| V2.7 | Out-of-band verifier (SMS OTP) | planned (P1) | SEC-AUTH-12, TB-7 | SMS risk accepted (AS-06) |
| V2.8 | TOTP verifier for admins | roadmap | — | recommended Q2 / `09-roadmap` |
| V2.10 | Service authentication (API clients) | planned (P5) | SEC-AZ-13 | hashed keys, scopes |
| V3.1 | Session management fundamentals (entropy, secure tokens) | planned (P1) | SEC-AUTH-02/06, SEC-CRYPTO-15 | 256-bit CSPRNG |
| V3.2 | Session binding (device/IP signals, anomaly detection) | planned (P1) | SEC-AUTH-07 | flag + step-up |
| V3.3 | Logout and timeout (idle/absolute) | planned (P1) | SEC-AUTH-09/11 | per session class |
| V3.4 | Cookie-based session management | planned (P1) | SEC-TLS-04/05 | httpOnly/Secure/SameSite/Path |
| V3.5 | Token-based session management | planned (P1) | SEC-AUTH-02/06 | memory-only JWT |
| V3.6 | Federated re-authentication | n/a | — | no SSO/OIDC in v1 (roadmap) |
| V3.7 | Defenses against session-management exploits (fixation, CSRF) | planned (P1) | SEC-TLS-05, SEC-AUTH-06 | Origin + custom header |
| V4.1 | General access control design (enforced server-side) | planned (P1) | SEC-AZ-01/02 | guards |
| V4.2 | Operation-level authorization: IDOR, scope, CSRF | planned (P1) | SEC-AZ-04/06, SEC-IN-08, SEC-TLS-05 | `TenantContext` |
| V4.3 | Administrative interfaces (separate auth, audit) | planned (P1) | SEC-AUTH-05, SEC-AUD-06 | step-up + audit |
| V5.1 | Input validation (positive, server-side, structured) | planned (P1) | SEC-IN-01 | Zod strict |
| V5.2 | Sanitization and sandboxing (HTML/JS content) | planned (P6) | SEC-OUT-01/02 | no raw HTML in v1 |
| V5.3 | Output encoding and injection prevention (SQL/OS/LDAP) | planned (P1/P6) | SEC-IN-02/03/04, SEC-OUT-01/03/06 | parameterization |
| V5.4 | Memory, string and unmanaged code safety | n/a (partial) | — | TypeScript; no native SQL/HTML parsing in-process |
| V5.5 | Deserialization prevention (no unsafe formats/eval) | planned (P1) | SEC-IN-01, SEC-IN-14 | Zod only |
| V5.6 | XML external entity (XXE) prevention | planned (P1) | SEC-IN-10 | no XML input in v1 |
| V6.1 | Data classification and protection policy | planned (P1) | SEC-AZ-06, `THREAT-MODEL.md` §3 | 4-level scheme |
| V6.2 | Approved cryptographic algorithms and modes | planned (P1) | SEC-CRYPTO-01/02 | AES-256-GCM, SHA-256, Argon2id |
| V6.3 | Random values (CSPRNG, sufficient entropy) | planned (P1) | SEC-CRYPTO-15 | `crypto.randomBytes/int` |
| V6.4 | Secret management (no hardcoded, storage, rotation) | planned (P1/P7) | SEC-CRYPTO-02/03/04/09/10 | `.env` 600 + keyrings |
| V7.1 | Log content: no credentials/sensitive data | planned (P1) | SEC-CRYPTO-06, SEC-AUD-03/07 | redaction rules |
| V7.2 | Log processing: integrity, ordering, time source | planned (P1) | SEC-AUD-08, chrony | hash chain |
| V7.3 | Log protection: tamper resistance, retention, access | planned (P1/P7) | SEC-AUD-10, SEC-DATA-05/09 | append-only + archive |
| V7.4 | Error handling and security-event logging | planned (P1) | SEC-IN-09, SEC-AUD-01..09 | generic errors; auth events |
| V8.1 | General data protection (retention, privacy, legal basis) | planned (P7) | §8.5/§8.6 | 10 y financial, 90 d request |
| V8.2 | Client-side data protection (no tokens/PII in storage) | planned (P1/P6) | SEC-AUTH-02 | memory only |
| V8.3 | Sensitive private data (masking, minimization, encryption) | planned (P2) | SEC-AZ-06, SEC-OUT-03, SEC-CRYPTO-01 | serializers |
| V9.1 | Client communication security (TLS config, cert validation) | planned (P7) | SEC-TLS-01/03, SEC-IN-06 | TLS 1.2+ |
| V9.2 | Server communication security (HSTS, no mixed content, external TLS) | planned (P5/P7) | SEC-TLS-02/08, adapters | strict HTTPS |
| V10.1 | Code integrity (source, dependencies, lockfile) | planned (P1) | SEC-SC-01..07 | frozen install |
| V10.2 | Malicious code search (no eval/backdoor patterns) | planned (P1) | Semgrep rules, SEC-SC-07 | CI |
| V10.3 | Deployed application integrity (image digest, drift) | planned (P7) | SEC-SC-04/08, SEC-MON-07 | drift alert |
| V11.1 | Business-logic integrity: server-authoritative state, sequencing | planned (P3/P4) | SEC-IN-14, `ADR-0007` | no client-trusted flow |
| V11.1 | Business-logic invariants: no oversell, balance enforcement | planned (P2/P4) | `ADR-0007`, `ADR-0008`, SEC-AZ-11 | DB constraints + tests |
| V11.1 | Anti-automation for business actions (order spam, export abuse) | planned (P1/P3) | SEC-RL-03/05, SEC-MON-02 | tiers + detectors |
| V11.1 | Anti-fraud flags and anomaly detection | planned (P4) | SEC-MON-02/05, `fraud_flags` | journal/order anomalies |
| V12.1 | File upload admission: size, type, magic bytes, content | planned (P2) | SEC-IN-10 §4.4 steps 1–3 | re-encode |
| V12.1 | File execution prevention (SVG/HTML/polyglot, headers) | planned (P2) | SEC-IN-10 §4.4 step 7 | attachment + nosniff |
| V12.1 | File storage and download authorization (private bucket) | planned (P2) | SEC-IN-10 §4.4 steps 6–7, SEC-OUT-04 | signed URL 5 min |
| V12.1 | File integrity (hash, dedupe, versioning) | planned (P2) | `file_assets.sha256`, object versioning | audit |
| V13.1 | Generic web-service security (authn/authz, schema) | planned (P1) | SEC-AZ-01..13, SEC-IN-01 | JWT bearer |
| V13.2 | RESTful web services (methods, content type, validation) | planned (P1) | SEC-IN-01, SEC-TLS-09 | OpenAPI from Zod |
| V13.3 | SOAP web services | n/a | — | REST only |
| V13.4 | GraphQL | n/a | — | REST only |
| V14.1 | Build and deploy pipeline security; deprecated components | planned (P1/P7) | SEC-SC-01/04/05/06, SEC-TLS-01 | CI gates |
| V14.2 | Dependency management (known-vulnerable, SBOM) | planned (P1) | SEC-SC-02/03/07 | Trivy + audit |
| V14.3 | Unintended security disclosures (debug, docs, headers) | planned (P1/P7) | SEC-IN-09, SEC-TLS-08/09 | docs off in prod |
| V14.4 | HTTP security headers (CSP, HSTS, frame options) | planned (P7) | SEC-TLS-07/08 | §6.5 block |
| V14.5 | HTTP request smuggling / header validation | planned (P7) | SEC-TLS-09 | nginx+Fastify review |

**ASVS summary at baseline:** all application rows `planned` (implementation tree empty), 1 roadmap row (V2.8 TOTP), 4 n/a rows (V3.6, V5.4 partial, V13.3, V13.4), all remaining rows committed with named locations. Target at go-live: every applicable L2 row `implemented-in-code` with the evidence triple in §9, or an explicit risk acceptance signed per §9.

**Round-1 additions mapped into this checklist:** SEC-AUTH-14/15/16/17 → V2.1/V2.2/V2.5/V2.6/V3.2 and V4.3 (device secret, reset policy, JWT verification, break-glass); SEC-AZ-14..18 → V1.4/V4.1/V4.2/V4.3 (registry conformance, role/scope step-up, approval config, export/report authz, API-client auth); SEC-IN-16..21, SEC-OUT-07 → V1.12/V5.x/V12.1/V13.1 (outbound egress, upload constraints, import/PDF caps, channel payload PII, code-declared hosts, file download authz); SEC-CRYPTO-16 → V6.4/V14.1 (secret delivery); SEC-AUD-11/12 → V7.1–V7.4 (vocabulary, chain function); SEC-DATA-15/16 → V8.1/V11.1 (accounting integrity, grant manifest); SEC-INF-11, SEC-SC-10 → V14.1/V14.2/V14.5.
## 15. OWASP Top 10 2021 self-review

| Top-10 risk | Controls in this document | Residual / owner |
|---|---|---|
| **A01 Broken Access Control** | SEC-AZ-01..18, SEC-IN-08/16/20, SEC-OUT-07, SEC-DATA-06/16, scope/IDOR/escalation test suites | No RLS in v1 → SEC-AZ-10/14 CI tests are the backstop; residual Medium (R-12), Backend Lead |
| **A02 Cryptographic Failures** | SEC-CRYPTO-01..16, SEC-TLS-01..09, SEC-DATA-11 | `style-src 'unsafe-inline'` and optional DB TLS on private net are documented residuals; Security Lead |
| **A03 Injection** | SEC-IN-01..04, SEC-OUT-01/06, Semgrep SQLi/XSS, Drizzle parameterization | None known; SQLi residual Low, Backend Lead |
| **A04 Insecure Design** | Threat model per boundary, SoD/approval matrix + DB `approval_id`, allocate/oversell invariants, fail-closed rules, approval-config protection | Single-tenant design trade-off (ADR-0005) accepted; Lead Architect |
| **A05 Security Misconfiguration** | SEC-TLS-08/09, SEC-INF-01..11, host hardening script, header/TLS + secret-mount verification gate | Operator drift → SEC-INF-09/11 FIM + deploy verification; DevOps Lead |
| **A06 Vulnerable & Outdated Components** | SEC-SC-01..10, SBOM, weekly rebuild, cooling period, SHA-pinned CI | Transitive risk accepted with gates; DevOps Lead |
| **A07 Identification & Authentication Failures** | SEC-AUTH-01..17, device-secret trust, reset policy, break-glass two-person, OTP limits, MFA/step-up, lockout, anti-enumeration | SMS interception (AS-06) accepted; Security Lead |
| **A08 Software & Data Integrity Failures** | SEC-SC-04/08/10, SEC-DATA-03/04/05/08/15, SEC-AUD-08/11/12 (hash chain + SECURITY DEFINER), outbox idempotency | Image signing roadmap; DevOps Lead |
| **A09 Security Logging & Monitoring Failures** | SEC-AUD-01..12, SEC-MON-01..09, IR runbook | Requires alerting stack deployed at go-live; DevOps Lead |
| **A10 SSRF** | SEC-IN-06/07/21, code-declared egress hosts + network policy, no redirects, rebinding-safe connect | Low; Security Lead |

No OWASP Top-10 category is unaddressed; each residual has an owner in `THREAT-MODEL.md` §8.

---

## 16. ADR deviation requests and cross-document dependencies

Requested changes to accepted ADRs and to sibling documents (never applied silently; Lead Architect / owning teammate decides). Round-1 routing IDs D-11…D-23 are new in v1.1.

| ID | Target | Request | Why |
|---|---|---|---|
| D-1 | ADR-0004 | Extend `auth_sessions` (family/device/mfa/UA-hash/IP-prefix/rotated-from); enforce `Origin`+`X-Requested-With` on **all** `/auth/*` unsafe methods, not only refresh; OTP verification constant-time with `OTP_PEPPER`; add `403 STEP_UP_REQUIRED` contract | Login CSRF, reuse detection, OTP brute force (§2) |
| D-2 | ADR-0004 | Formalize step-up 2FA for the sensitive-action list (§2.5) | AC-11, AC-13 |
| D-3 | ADR-0005 | Declare the RLS adoption trigger + test harness; keep repo-layer scoping as primary in v1 | R-12 residual |
| D-4 | ADR-0009 | Audit/accounting retention **10 years** (tax law) instead of 7; archive with manifest | AC-13; §8.5/§8.6 |
| D-5 | ADR-0012 + `ARCHITECTURE.md` §17 | CI/CD evidence path (protected branches, digest pinning, signing, deploy verification); **phase statuses ⓅⓁⒶⓃⓃⒺⒹ until artifacts exist** (R1 B-01) | TB-6 |
| D-6 | ADR-0006 | Pin the webhook signature contract (`v1|channel|account|eventId|timestamp|rawBody`), replay store, `channel_webhook_secrets`; signature scheme is compile-time (no settings override) | AC-07, R1 H-03/M-03 |
| D-7 | Reference DDL | Drop/never use `api_request_logs.request_body/response_body` in production; add audit `row_hash`/`prev_hash`/`hash_seq` | TB-2, R-13/R-15 |
| D-8 | `docs/02-data-model` | Add `user_devices`, `password_history`, `security_events`, `channel_webhook_secrets`, replay store, `users.locked_until`, `users.permissions_version`, `file_assets.scan_status`, `crypto_rotation_progress`, audit hash columns, `accounting_period_events`, lookup vocab tables (`audit_actions`, `audit_actor_types`, `security_event_types`, `otp_challenge_purposes`, `webhook_event_types`) | §2–§8; R1 B-05/M-01 |
| D-9 | `docs/03-api-contract` | Auth/session/step-up endpoints; remove public password-forgot/reset in v1; `429`+`Retry-After`; uniform error codes (`SESSION_REVOKED`, `STEP_UP_REQUIRED`, `CSRF_REJECTED`, `SMS_BUDGET_EXHAUSTED`, `INVALID_FILE_TYPE`, `SYSTEM_ROLE_IMMUTABLE`, `FORBIDDEN_PERMISSION_ESCALATION`, `EGRESS_DESTINATION_NOT_ALLOWED`, `PERIOD_MISMATCH`, `PERIOD_CLOSED`); webhook signed-input headers | §2–§6; R1 B-02/B-03/H-01 |
| D-10 | `docs/05-testing` | Security test set from `THREAT-MODEL.md` §7 (one test per abuse case) + the §9 evidence triple + the R1 regression tests named in §17 | Release gate |
| D-11 | ADR-0004 + DATA-MODEL | `user_devices.device_secret_hash`; `auth_sessions.device_id NOT NULL`; `deviceFingerprint` becomes a display label; trust only via server-issued secret cookie (R1 B-02) | §2.9 |
| D-12 | API + ADR-0004 | Remove public password reset/forgot from v1; admin reset permission `identity.user.reset_password` + subset check + token+OTP flow; break-glass becomes offline two-person (R1 B-03/M-07) | §2.10/§2.12 |
| D-13 | ADR-0008 + DATA-MODEL | `journal_entries.approval_id` NOT NULL above threshold (deferred FK); `data_versions` snapshots for approval config; `posting_rule_version_id`; `approval.config.manage`; disjoint author/post SoD guard (R1 B-04) | §3.9/§8.2 |
| D-14 | DATA-MODEL | Audit hash columns + `erp.chain_audit()` SECURITY DEFINER owned by migrator (EXECUTE to worker, no UPDATE); vocabulary lookup tables; `accounting_period_events`; grant manifest (R1 B-05/M-01/H-12) | §7.3/§8.1 |
| D-15 | `packages/shared` + API + DATA-MODEL | One machine-readable permission registry; delete duplicate tables; exact matching only; reserved keys; bidirectional CI parity (R1 B-06) | §3.7 |
| D-16 | API | Role/scope edits: step-up, `FORBIDDEN_PERMISSION_ESCALATION`, subset check incl. target user, pv bump, session revoke on scope change (R1 H-01/M-10) | §3.8 |
| D-17 | API + DATA-MODEL | Exports derive per-entity permission; `export.read_all`; report `required_permissions[]`; dashboard widget strictest permission; closed `queryTemplateId` enum (R1 H-02/H-09) | §3.10 |
| D-18 | API + channels | Outbound webhook destination allowlist + payload allowlist (never cost fields) + first-delivery alert; signature scheme compile-time per adapter; MAC covers event id (R1 H-03/H-04/M-03) | §4.6/§4.8 |
| D-19 | API + files | Server-mediated uploads in v1; if presigned then S3 POST policy constraints + orphan lifecycle; `file_assets.owner_entity_type/id`; entity-scoped download, 404 cross-scope (R1 H-05/H-06) | §4.9/§4.12 |
| D-20 | API | Voice/reset/MFA rate tiers, shared attempt counter, fail-closed CAPTCHA, one global SMS+voice budget; API-client token endpoint + `allowed_cidrs` (R1 H-07/H-08/M-06/M-08) | §3.11/§7.1 |
| D-21 | API + channels | Persisted channel payload allowlist (no headers, no customer PII), encrypted 30-day archive, step-up raw view (R1 H-10) | §4.11 |
| D-22 | API + infra | Code-declared egress hosts + boot assertion; import/PDF resource caps; scope denial is 404; health/webhook-health internal; remove `WEBHOOK_REQUIRE_TIMESTAMP` flag (R1 M-04/M-05/M-09/L-03/L-04/L-05) | §4.5/§4.10/§12.1 |
| D-23 | ADR-0012 + devops | Compose `secrets:` delivery (no `env_file` secrets); deploy user with no docker-root path; edge unprivileged ports 8080/8443; SHA-pinned CI actions (R1 H-11/L-01/L-02) | §5.1/§10/§11 |

**Remaining dependencies (short list — owner, what must change, where it is tracked):**

1. **api-architect (`API.md`)** — D-6, D-9, D-11, D-12, D-16, D-17, D-18, D-19, D-20, D-22; delete duplicate rate-limit/header/CSP/permission tables and point to this document; single permission registry reconciliation with db-architect.
2. **db-architect (`DATA-MODEL.md`)** — D-7, D-8, D-11, D-13, D-14, D-15, D-17, D-19; grant manifest shape; audit lookup vocabularies; `accounting_period_events`; no DELETE grants.
3. **devops-lead (`DEPLOYMENT.md`/`INSTALL-FA.md`/`RUNBOOK.md`/`BACKUP-RESTORE.md`)** — D-5, D-23; Compose secrets + `/run/secrets` layout; no docker sudo; edge ports; backup passphrase custody; `INCIDENT-RESPONSE.md` from §12.3; env table from §18.
4. **qa-lead (`TESTING.md`)** — D-10; the R1 regression tests and §9 evidence triple as CI gates.
5. **Lead Architect (`ARCHITECTURE.md` §17) / ADR owners** — D-5 (phase status correction, R1 B-01), D-1…D-4, D-6, D-13.
6. **accounting owner (R1-accounting domain fixes)** — posting rules/VAT/GRNI/CoA/cheque/payment domain correctness (R1-accounting B-01…B-16, H-01…H-14, M-01…M-21); security only enforces the integrity properties in SEC-DATA-15 and will not duplicate domain rules here.

---

## 17. Revision log — Round 1

Disposition of every finding in `docs/_review/round-1/R1-security.md` (and the security-relevant items from `R1-accounting.md`). Status values: **Fixed** = normative control added/changed in this document with an ID; **Fixed+Routed** = fixed here, but a sibling document must change for the fix to be implementable (tracked in §16); **Deferred** = not fixed here, with owner and reason. Nothing in this round is silently dropped.

| R1 ID | Finding | Status | Resolution (section / control) |
|---|---|---|---|
| B-01 | Docs claim P1–P7 shipped; sign-off signable against empty dirs | Fixed + Routed | Evidence triple in §0.1/§0.2/§9; `ARCHITECTURE.md` §17 status correction routed via D-5 (Lead Architect) |
| B-02 | Device fingerprint is client-declared ⇒ MFA bypass | Fixed + Routed | §2.9 SEC-AUTH-14 (server-issued device secret); schema via D-11 |
| B-03 | Admin/self-service password-reset takeover | Fixed + Routed | §2.10 SEC-AUTH-15 (no public reset in v1; subset-check + token+OTP); API via D-9/D-12 |
| B-04 | Maker-checker defeatable via mutable approval config | Fixed + Routed | §3.9 SEC-AZ-16 + §3.5 DB rules + §8.2 `approval_id`/period guard; D-13 |
| B-05 | Audit trail not tamper-evident (no hash cols, no legal writer, narrow CHECKs) | Fixed + Routed | §7.3 SEC-AUD-11/12 + vocabulary lookups; D-8/D-14 |
| B-06 | Two conflicting permission registries (314 vs 412 keys) | Fixed + Routed | §3.7 SEC-AZ-14 (single registry, exact matching, bidirectional CI parity); reconciliation deferred to API/DATA owners via D-15 — **blocker if unresolved before P1 exit** |
| H-01 | Role/scope edits: no escalation guard, no step-up | Fixed + Routed | §3.8 SEC-AZ-15; API rows via D-16 |
| H-02 | Exports bypass `audit.export` / cross-user downloads | Fixed + Routed | §3.10 SEC-AZ-17; API via D-17 |
| H-03 | Webhook signature scheme mutable via account settings | Fixed + Routed | §4.6 SEC-IN-17 (compile-time scheme); D-18 |
| H-04 | Outbound webhook subscriptions exfiltrate PII/cost | Fixed + Routed | §4.8 SEC-IN-16 (destination + payload allowlist, step-up, alert); D-18 |
| H-05 | Presigned uploads unbounded/spoofable/orphans | Fixed + Routed | §4.9 SEC-IN-18 (v1 server-mediated; presigned only with POST-policy constraints); D-19 |
| H-06 | File download `file.read` only; org-wide list | Fixed + Routed | §4.12 SEC-OUT-07 (entity scope, 404); D-19 |
| H-07 | Login throttling under-specified / self-contradictory | Fixed + Routed | §7.1 normative tiers (+ASN) + explicit precedence; D-9/D-20 |
| H-08 | Public voice OTP / ad-hoc SMS abuse, budget only OTP | Fixed + Routed | §4.13/§7.1 RL-09 (voice tiers, challenge binding, one monetary budget, fail-closed CAPTCHA); D-20 |
| H-09 | Report authorization collapses into `report.run`; dashboard bypass | Fixed + Routed | §3.10 SEC-AZ-17 (`required_permissions[]`, widget inheritance, closed templates); D-17 |
| H-10 | Channel call/webhook payloads persist PII (and maybe headers) | Fixed + Routed | §4.11 SEC-IN-20 (allowlist schemas, no headers/PII, 30 d encrypted, step-up); D-21 |
| H-11 | `env_file` secrets readable via `docker inspect`; docker sudo | Fixed + Routed | §5.1 SEC-CRYPTO-16 + §10.2/§10.3 (Compose secrets, no docker-root deploy path); D-23 |
| H-12 | `saman_readonly` over-privileged; `saman_app` can DELETE | Fixed | §8.1 SEC-DATA-16 (manifest-generated grants, no DELETE, views-only readonly, `\dp` drift CI) |
| M-01 | OTP purpose / security-event CHECKs cannot store required values | Fixed + Routed | §2.4/§7.3 seeded lookup vocabularies SEC-AUD-11; D-8 |
| M-02 | Idempotency unique key lacks actor | Fixed + Routed | §4.7 unique `(organization_id, actor_user_id, scope, key)`; D-8 |
| M-03 | Webhook replay defense uses unsigned event-id; timestamp flag | Fixed + Routed | §4.6 SEC-IN-17 (event id inside MAC, timestamp mandatory, flag removed); D-18 |
| M-04 | XLSX/PDF rendering attack surface | Fixed + Routed | §4.10 SEC-IN-19 (decompression/entry caps, sandboxed parse, named renderer); D-22 |
| M-05 | SSRF allowlist derived from mutable env | Fixed + Routed | §4.5 SEC-IN-21 (code-declared hosts + boot assertion); D-22 |
| M-06 | API-client auth undocumented | Fixed + Routed | §3.11 SEC-AZ-18 (token endpoint, CIDR, scope mapping, audit); D-20 |
| M-07 | Break-glass in-band elevation | Fixed + Routed | §2.12 SEC-AUTH-17 (offline + two-person, checked session, denylist, kill switch); D-12 |
| M-08 | Reset/MFA-completion rate-limit holes | Fixed + Routed | §7.1 (mfa-verify, password-reset tiers, shared attempt counter); D-20 |
| M-09 | 403 vs 404 scope oracle | Fixed | §3.1/§4.12/§9 item 17 (detail ⇒ 404; 403 only on already-visible selections) |
| M-10 | Scope change does not invalidate tokens | Fixed + Routed | §3.6/§3.8 (pv bump + session revoke + ScopeGuard re-read) |
| L-01 | CI actions/tooling unpinned | Fixed + Routed | §11.2 SEC-SC-10 (40-char SHA, pinned Trivy digest/SBOM version, pin-policy test); D-23 |
| L-02 | Edge publishes 80/443 while cap_drop ALL + non-root | Fixed | §10.1/§10.2 SEC-INF-11 (container listens 8080/8443; host maps 80/443; no silent NET_BIND_SERVICE) |
| L-03 | Header/CSP constants drift between docs | Fixed + Routed | §6.5 single-source rule (API/DEPLOYMENT must reference; header-snapshot test); D-22 |
| L-04 | JWT verification hardening unspecified | Fixed | §2.2/§2.11 SEC-AUTH-16 (fixed algorithm from key, `aud`/`iss`, `jti` revocation, RFC 8725) |
| L-05 | Public health/webhook-health disclosure | Fixed | §12.1 (internal-only + anonymous `{status:"ok"}` only) |
| AR-integrity (R1-accounting B-04, B-09, B-16, H-11, H-12, M-17) | Approval binding, period/date integrity, posted immutability, header totals, close/reopen history | Fixed (security-relevant part) | §8.2 + SEC-DATA-15; accounting domain fixes remain with accounting owner |
| AR-domain (R1-accounting B-01/02/03/05/06/07/08/10/11/12/13/14/15, H-01…H-14, M-01…M-21) | VAT/COGS/GRNI posting, CoA completeness, FIFO layers, cheque/payment/VAT domain rules | Deferred (out of security-doc scope) | Owner: accounting/domain design (re-review R2). Security enforces only integrity/auditability in SEC-DATA-15 and does not duplicate domain rules |

Re-verification note: the 20 *Verified controls* listed in R1-security remain verified at document level and are now referenced by the stronger §9 evidence triple; none were weakened in this round. New control IDs in v1.1: AUTH-14…17, AZ-14…18, IN-16…21, OUT-07, CRYPTO-16, AUD-11/12, DATA-15/16, INF-11, SC-10, RL-09 (24 new IDs) plus materially strengthened existing rows; **total 160 unique control IDs** (see §18.3 count note).

---

## 18. Appendix — environment and configuration reference

### 18.1 Security-relevant environment variables (canonical names = repository `.env.example`; Zod-validated at boot by `apps/api/src/config/env.schema.ts`)

`Secret` column: **file** = Compose secret under `/run/secrets/*` (R1 H-11), **no** = ordinary config via `.env`/`env_file`, **one-shot** = secret deleted after first use. Names marked ★ are additions this document requires and that the Lead will add to `.env.example`.

| Variable | Secret | Default | Purpose |
|---|---|---|---|
| `APP_ENV` | no | — | `development|test|staging|production`; drives secure defaults and boot guards |
| `APP_URL` | no | — | public origin (no trailing slash); exact `Origin` allowlist for `/auth/*` and CSP/base URL |
| `APP_PORT`, `API_PREFIX`, `API_VERSION` | no | 4000 / `api` / `v1` | listener and route prefix |
| `APP_TIMEZONE`, `APP_DEFAULT_LOCALE` | no | `Asia/Tehran`, `fa-IR` | display/business timezone and locale |
| `DOCS_ENABLED` | no | false | OpenAPI UI; must be false in production |
| `LOG_LEVEL`, `LOG_BODIES` ★ | no | `info`, false | pino level; request/response bodies off (production guard) |
| `JWT_ACCESS_SECRET` | **file** | — | 64 B base64 signing key (`/run/secrets/jwt_access_secret`; `.previous` during rotation) |
| `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL` | no | `10m`, `7d` | token lifetimes (access capped at 15m) |
| `APP_ENCRYPTION_KEY` | **file** | — | 32 B base64 AES-256-GCM data key |
| `APP_ENCRYPTION_KEY_VERSION` | no | `1` | envelope prefix `vN`; bump on rotation |
| `OTP_PEPPER`, `REFRESH_PEPPER` | **file** | — | HMAC peppers for OTP codes and refresh-token hashes |
| `CORS_ORIGINS` | no | — | exact origin allowlist for staging/dev (production same-origin) |
| `COOKIE_SECURE`, `COOKIE_DOMAIN` | no | true, empty | cookie flags; `Secure` enforced in production |
| `TRUST_PROXY`, `TRUST_PROXY_CIDRS` ★ | no | true, edge CIDR | Fastify trustProxy scope |
| `TLS_TERMINATED_AT_EDGE` ★, `SECURITY_HSTS` | no | true, true | edge TLS assumptions / HSTS emission |
| `RATE_LIMIT_ENABLED`, `RATE_LIMIT_AUTH_PER_MIN`, `RATE_LIMIT_OTP_PER_HOUR`, `RATE_LIMIT_API_PER_MIN` | no | true, 10, 5, 300 | coarse limits; fine tiers in `config/rate-limits.ts` (§7.1) |
| `LOGIN_MAX_FAILED`, `LOGIN_LOCK_MINUTES` | no | 10, 15 | lockout thresholds |
| `DATABASE_URL` (password from `/run/secrets/db_app_password`) | **file** | — | `saman_app` connection; `sslmode` for external DB |
| `DB_SSL`, `DB_SSL_CA_PATH` | no / **file** | false, — | external/managed PG TLS; CA at `/run/secrets/db-ca.pem` |
| `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_TIMEOUT_MS`, `DB_SCHEMA`, `DB_MIGRATION_ROLE` | no | 20, 5000, 30000, `erp`, `saman_migrator` | pool/timeouts/schema |
| `MIGRATION_DATABASE_URL` | **file** | — | `saman_migrator`; release step only |
| `REDIS_URL`, `REDIS_PASSWORD` | **file** (password) | — | cache/queue/rate-limit; `requirepass` from `/run/secrets/redis_password` |
| `REDIS_PREFIX`, `REDIS_TLS` | no | `saman:`, false | key namespace / TLS |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_FORCE_PATH_STYLE` | no | `http://minio:9000`, `saman-files`, `us-east-1`, true | object storage |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | **file** | — | scoped MinIO app user (not root) |
| `S3_PUBLIC_BASE_URL`, `UPLOAD_MAX_MB` | no | empty, 20 | optional CDN base (disabled by default) / upload cap |
| `SMS_MODE` | no | `mock` | `limo|mock`; **`mock` forbidden in production** |
| `LIMO_BASE_URL`, `LIMO_SENDER`, `LIMO_OTP_PATTERN_ID` | no | — | provider endpoint/sender/pattern |
| `LIMO_API_KEY` | **file** | — | Limo `ApiKey` |
| `OTP_TTL_SECONDS`, `OTP_MAX_ATTEMPTS` | no | 120, 5 | OTP lifetime/attempts |
| `SMS_DAILY_BUDGET` ★ | no | 2000 | **all paid SMS+voice** sends per day; alert at 80 % |
| `CAPTCHA_PROVIDER` ★, `CAPTCHA_SITE_KEY` ★, `CAPTCHA_SECRET_KEY` ★ | no / **file** | — | public send-endpoint CAPTCHA; unavailable ⇒ fail closed |
| `CAREXY_API_BASE_URL`, `DIGIKALA_API_BASE_URL`, `LIMO_BASE_URL` | no | preset | may only select a **code-declared** `live`/`sandbox` preset (SEC-IN-21) |
| `CAREXY_API_KEY`, `CAREXY_WEBHOOK_SECRET`, `DIGIKALA_CLIENT_ID`, `DIGIKALA_CLIENT_SECRET`, `DIGIKALA_WEBHOOK_SECRET` | **one-shot file** | — | bootstrap import into encrypted `channel_*` tables, then deleted from env/secrets |
| `CHANNEL_SYNC_ENABLED`, `CHANNEL_STOCK_DEBOUNCE_MS`, `CHANNEL_HTTP_TIMEOUT_MS` | no | true, 3000, 15000 | channel tuning (no destinations) |
| `DIGIKALA_WEBHOOKS_ENABLED` | no | false | TBD-DIGIKALA flag; off until signature confirmed |
| `BACKUP_ENABLED`, `BACKUP_CRON`, `BACKUP_KEEP_DAYS`, `BACKUP_S3_PREFIX` | no | true, `0 2 * * *`, 30, `backups/postgres` | backup schedule/retention |
| `BACKUP_ENCRYPTION_PASSPHRASE` | **file** | — | age passphrase (`/run/secrets/backup_passphrase`), split custody |
| `BOOTSTRAP_ADMIN_MOBILE`, `BOOTSTRAP_ADMIN_PASSWORD` | **one-shot file** | — | first-run admin; deleted after bootstrap; boot fails on `CHANGE_ME` |
| `BOOTSTRAP_ORG_NAME` | no | — | initial org name |
| `FEATURE_STRICT_LOGIN_MODE` ★, `FEATURE_BREAK_GLASS` ★, `FEATURE_INVENTORY_FREEZE` ★, `FEATURE_ACCOUNTING_FREEZE` ★ | no | false | incident/feature kill switches (break-glass off by default) |
| `BREAK_GLASS_USER` ★ | no | — | sealed superadmin public id (custodians only) |
| `METRICS_ENABLED`, `OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `SENTRY_DSN` | no | true, false, —, — | observability; `/metrics` internal only |
| `POSTGRES_*`, `REDIS_PORT`, `MINIO_ROOT_*`, `API_HOST_PORT`, `WEB_HOST_PORT`, `DOMAIN`, `ACME_EMAIL`, `IMAGE_TAG` | compose-only | — | container bootstrap/edge; `MINIO_ROOT_*` must not be used by the app |

**Boot guards (fail closed):** production refuses to start if `SMS_MODE != limo`, `LOG_BODIES=true`, `DOCS_ENABLED=true`, `COOKIE_SECURE=false`, `APP_URL` missing/invalid, `CORS_ORIGINS` empty for staging/production, any required secret file missing/unreadable/placeholder (`CHANGE_ME*`), `JWT_ACCESS_SECRET` < 64 B, `APP_ENCRYPTION_KEY` != 32 B, `DATABASE_URL` role is a superuser, a ciphertext key version has no available key, an adapter base URL is not in the code-declared host set, or the edge port model is inconsistent with the published ports.

### 18.2 Verification commands (used by §9 sign-off)

```bash
# no secrets / no raw sql / no dangerous html
pnpm run lint:security && pnpm exec semgrep --config infra/semgrep/saman.yml apps packages

# secrets must NOT be in container env (R1 H-11) — expect empty output
docker inspect api --format '{{json .Config.Env}}' | grep -Ei 'secret|password|pepper|jwt|encryption' || true
docker exec api env | grep -Ei 'secret|password|pepper|jwt|encryption' || true
ls -l /run/secrets/    # inside container: files only; host secrets/ is root:root 0400

# dependency + container + IaC + CI pinning (R1 L-01)
pnpm audit --audit-level=high
trivy image --severity CRITICAL,HIGH --exit-code 1 "$IMAGE"
trivy config docker-compose.yml infra/
node scripts/check-action-pins.mjs

# secrets in history
gitleaks detect --redact --no-banner

# headers / TLS (staging or prod)
curl -sI https://erp.example.com/ | grep -Ei 'strict-transport|content-security|x-content-type|x-frame|referrer|permissions-policy'
openssl s_client -connect erp.example.com:443 -tls1_2 </dev/null 2>/dev/null | grep 'Protocol'
testssl.sh --severity HIGH https://erp.example.com

# container hardening + edge port model (R1 L-02)
docker compose config | grep -E 'read_only|cap_drop|security_opt|user:|published'
docker ps --format '{{.Names}}' | xargs -I{} docker inspect {} --format '{{.Name}} privileged={{.HostConfig.Privileged}} user={{.Config.User}}'
ss -tlnp | grep -E ':(80|443|8080|8443)\b'

# DB least privilege + grant manifest drift (R1 H-12)
psql "$MIGRATION_DATABASE_URL" -c "select current_user; select rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname = current_user;"
psql "$MIGRATION_DATABASE_URL" -c "\dp erp.*" > /tmp/dp.txt && diff <(sort /tmp/dp.txt) <(pnpm tsx scripts/dump-expected-grants.ts | sort)
pnpm tsx scripts/check-grants.ts      # fails on any drift incl. readonly base-table SELECT / app DELETE

# audit chain + vocabulary (R1 B-05/M-01)
pnpm --filter api audit:verify -- --days 90
pnpm --filter api test -- audit-vocab.spec.ts

# accounting integrity regression (R1-accounting routing, SEC-DATA-15)
pnpm --filter api test -- period-integrity.spec.ts journal-immutability.spec.ts

# backup restore drill
bash infra/backup/verify-restore.sh --target saman_restore_test

# rate limits / lockout / CAPTCHA / device trust (staging script)
bash scripts/security-smoke.sh https://staging.example.com
```

### 18.3 Control inventory

v1.1 has **160 control IDs** (AUTH-01…17, AZ-01…18, IN-01…21, OUT-01…07, CRYPTO-01…16, TLS-01…09, RL-01…09, AUD-01…12, DATA-01…16, INF-01…11, SC-01…10, MON-01…09, SDLC-01…05), of which **24 are new in round 1** and a further set of existing rows were materially strengthened. `scripts/check-security-ids.ts` (CI) asserts that (a) every control ID referenced in `THREAT-MODEL.md`/`SECURITY.md` exists, (b) every ID has exactly one definition row, (c) the count in this paragraph equals the actual unique-ID count, and (d) no control row is missing a location or phase. This paragraph is the single authoritative count; any other count in any document is deleted (same rule as the permission registry, R1 B-06).

---

## 19. Document control

| Version | Date | Author | Change |
|---|---|---|---|
| 1.0 | 1405-07-27 | Security Lead | Initial design baseline: 14 control areas, 136 controls, ASVS L2 checklist, OWASP Top-10 review, sign-off checklist |
| 1.1 | 1405-07-27 | Security Lead | Round-1 remediation: 24 new control IDs + materially strengthened existing rows (160 total) — device secret, reset policy, JWT hardening, break-glass, registry conformance, role/scope step-up, approval-config protection, export/report authz, API-client auth, outbound webhook allowlist, upload constraints, import/PDF caps, channel-payload PII, file-download entity authz, secret-file delivery, vocabulary lookups + chain function, grant manifest, accounting-period/posting integrity, CI pinning, edge ports; canonical env names; evidence-triple sign-off (§9, 44 rows); revision log (§17); R1 routing D-11…D-23 (§16) |

Review cadence: quarterly and on any trust-boundary/role/schema change. Change control: Security Lead approves changes to this document; the ASVS status column is updated at each release. Open items requiring decisions are tracked in `THREAT-MODEL.md` §9.3 (Q1–Q6). Round-2 re-review is gated on the §16 remaining dependencies landing in sibling documents.


### Enforcement status (2026-10-20)

- Step-up: enforced by the global `StepUpGuard` on journal approve/post/reverse,
  inventory adjustment approve/post/void, user reset-password/roles and settings update.
- OTP: single-use via a conditional `UPDATE … RETURNING` (no replay window).
- Maker-checker: approver ≠ creator enforced in the journal service (403 verified live).
- ScopeGuard: **not yet enforced** (TD-32).
