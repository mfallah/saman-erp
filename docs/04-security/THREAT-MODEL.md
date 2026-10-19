# 04 — Threat Model

**خلاصهٔ فارسی:** این سند مدل تهدید «سامان ERP» را با روش STRIDE در مرزهای اعتماد تعریف می‌کند: دارایی‌ها، بازیگران، مرزهای اعتماد، سناریوهای تهدید، موارد سوءاستفاده (abuse cases) و رجیستر ریسک. هر تهدید به کنترل مشخص در `SECURITY.md` نگاشت شده است؛ هیچ ریسکی بدون مالک و بدون کنترل یا پذیرش صریح باقی نمی‌ماند.

| Field | Value |
|---|---|
| Status | **Design baseline v1.1 (round-1 remediation)** — pending review sign-off (release gate `README.md` §7.5) |
| Revision | v1.1 — integrates R1-security B-01…B-06, H-01…H-12, M-01…M-10, L-01…L-05 and the security-relevant R1-accounting integrity findings; see §12 revision log |
| Review | `docs/_review/round-1/R1-security.md`, `docs/_review/round-1/R1-accounting.md` |
| Owner | Security Lead (`security-lead`) |
| Reviewers | Lead Architect, Backend Lead, DevOps Lead, QA Lead |
| Last updated | 1405-07-27 |
| Method | STRIDE per trust boundary + abuse-case analysis; risk scored on a 5×5 matrix |
| Related | `docs/01-architecture/ARCHITECTURE.md` §9–§14, `docs/adr/0004`–`0014`, `docs/04-security/SECURITY.md` |

All file paths in this document are **planned repository targets** (the code tree is a design-phase skeleton: `apps/*`, `infra/*`, `packages/*`). Status values follow `SECURITY.md` §0.2. "ADR deviation request" marks a place where this document deliberately proposes something stronger or different from an accepted ADR; it is a request for the Lead Architect, never a silent override.

**Requirement language (RFC 2119/8174).** MUST / MUST NOT / SHOULD / MAY are normative as defined in RFC 2119 and RFC 8174 when capitalised. **Evidence rule (R1 B-01):** no control or threat-mitigation is "verified" without the route/source file + test name + CI run id required by `SECURITY.md` §9; a mitigation listed here that lacks a `SEC-*` control in `SECURITY.md` is an unowned risk and must appear in §8. All R1-security findings are dispositioned in §12; the controls that close them are marked `(R1 …)`.

---

## 1. Purpose, scope, and how to use this document

This threat model covers the **v1.0 single-host deployment** of Saman ERP as described in `ARCHITECTURE.md` §3: one stateless NestJS/Fastify API, one worker, PostgreSQL 16, Redis 7, S3/MinIO, an nginx/Caddy edge, and outbound adapters to Carexy, Digikala and Limo SMS.

**In scope:** admin/warehouse SPA users, channel integrations, inventory/order/accounting data integrity, host and container operation, backup/restore, CI/CD to production.

**Out of scope for v1.0 (explicit):** customer-facing storefront (owned by Carexy), payroll/HR, multi-tenant SaaS isolation guarantees (single tenant in v1 — see `ADR-0005` and §9 assumption AS-02), native mobile applications, and physical warehouse security.

**How to use it:**

- Before implementing a feature, find its boundary in §5/§6 and check its threats are addressed; add new rows when a boundary or data flow changes.
- Every control cited here (`SEC-*`) must resolve to a row in `SECURITY.md`; if it does not, the threat is unmitigated and must be added to the risk register.
- Security tests in `docs/05-testing/TESTING.md` are derived from the abuse cases in §7.
- Re-review triggers: a new trust boundary, a new external integration, a new role/permission class, a schema change to `audit_logs`/`auth_sessions`/`journal_*`, any production incident, and at minimum **quarterly**.

---

## 2. System snapshot and data flow

```text
   [AC-1 Anonymous internet]        [AC-2 Employee / warehouse device]      [AC-3 Insider / operator]
            |                                    |                                   |
            |  HTTPS (auth endpoints)            |  HTTPS (SPA + /api/v1)            | SSH / docker / DB console
            v                                    v                                   v
   +------------------------------------------------------------------------+   =============
   | TB-1  Edge: nginx / Caddy  (TLS, HSTS, headers, coarse rate limit)     |   TB-6  Host
   +----------------------------------┬-------------------------------------+   =============
                                      | HTTP/JSON (internal docker network)
                         +------------v-------------+
                         |  apps/api  (stateless)   |<----------- TB-4 inbound webhooks (Carexy/Digikala)
                         |  apps/web  (static)      |<----------- TB-7 OTP SMS (Limo, egress)
                         +--┬────────┬────────┬─────+
                            |        |        |
              TB-2 (DB/Redis)|        |        | TB-5 (S3)
                            v        v        v
                    +---------+  +------+  +-----------+
                    | Postgres|  |Redis |  | S3/MinIO  |
                    +----^----+  +--^---+  +-----^-----+
                         |          |            |
                    +----┴----------┴------------┴----+
                    |          apps/worker           |------> TB-3 outbound channels (Carexy, Digikala, Limo)
                    +----------------┬---------------+
                                     |
                              TB-8 backup/offsite (age-encrypted pg_dump -> S3/offsite)
```

Data flows that matter most: (a) login/OTP/refresh; (b) order ingest → reservation → pick/pack → ship → journal; (c) stock/price push to channels; (d) channel credentials and webhook secrets; (e) audit trail; (f) backups and exports.

---

## 3. Assets

Classification: **Public** < **Internal** < **Confidential** < **Restricted**. "Impact if compromised" drives the asset's weight in risk scoring.

| ID | Asset | Where it lives (planned) | Class | Impact if compromised |
|---|---|---|---|---|
| A-01 | Password hashes, password history | `erp.users.password_hash`, `erp.password_history` (DATA-MODEL) | Restricted | Account takeover, credential reuse damage |
| A-02 | Access/refresh tokens, session records | JWT in SPA memory; `erp.auth_sessions.token_hash`; Redis permission cache | Restricted | Full impersonation of a user/role |
| A-03 | OTP codes + SMS send budget | `erp.otp_challenges.code_hash`; Limo account credit | Confidential | Account takeover; direct financial loss (SMS cost) |
| A-04 | Roles, permissions, approval policy | `erp.permissions`, `erp.roles`, `erp.role_permissions`, `erp.approval_*` | Confidential | Privilege escalation; fraud enablement |
| A-05 | Channel API credentials | `erp.channel_accounts.credentials_encrypted`, `erp.channel_api_credentials.secret_ciphertext` | Restricted | Price/stock manipulation on marketplaces, order interception |
| A-06 | Webhook signing secrets / channel trust config | `erp.channel_webhook_secrets` (planned), `erp.channel_accounts.settings` | Restricted | Forged orders/returns, inventory corruption |
| A-07 | Master keys (`APP_ENCRYPTION_KEY`, `JWT_ACCESS_SECRET`, OTP/refresh peppers, backup passphrase) | `/run/secrets/*` Compose file secrets (root-owned 0400, mounted read-only, tmpfs), passphrase in split custody | Restricted | Mass decryption, token forgery, history decryption |
| A-08 | Inventory ledger + balances | `erp.inventory_transactions`, `erp.inventory_balances`, `erp.stock_reservations` | Confidential/Integrity | Oversell, stock loss, wrong valuation, accounting misstatement |
| A-09 | Journals, periods, trial balance | `erp.journal_entries`, `erp.journal_lines`, `erp.accounting_periods` | Restricted/Integrity | Financial statement fraud, tax exposure, audit failure |
| A-10 | Customer PII | `erp.customers` (mobile, address, national ID if collected), `erp.sales_orders.shipping_address` | Restricted | Privacy breach, legal exposure (e-commerce law), phishing |
| A-11 | Cost, purchase price, margin, partner share | `erp.product_costs`/price history, `erp.partner_*` | Confidential | Competitive and commercial damage; employee misuse |
| A-12 | Uploaded files, exports, labels | `erp.file_assets` + private S3 bucket; signed URLs | Confidential | Malware delivery, data exfiltration, PII leak |
| A-13 | Audit trail | `erp.audit_logs` (partitioned, hash-chained) | Restricted/Integrity | Loss of non-repudiation; insider fraud goes undetected |
| A-14 | Backups | age-encrypted `pg_dump -Fc` in S3/offsite | Restricted | Total data loss or mass exfiltration |
| A-15 | Host and infrastructure | SSH keys, `/run/secrets/*` files, `.env` (non-secret config), docker socket, compose files, DB superuser | Restricted | Full system compromise |
| A-16 | Availability of API/edge/DB | Single-host Docker topology | Internal | Revenue loss, SLA breach (99.9 % target) |
| A-17 | Raw channel payloads, API call logs | `erp.channel_webhook_events`, `erp.channel_api_calls` | Confidential | PII leakage; replay/debug data abuse |

---

## 4. Actors and entry points

### 4.1 Actors

| ID | Actor | Capability | Trust |
|---|---|---|---|
| AC-1 | Anonymous internet client | Reaches `/api/v1/auth/*` only; can query SPA static files | Untrusted |
| AC-2 | Authenticated employee | Holds a role from `README.md` §4; browser/tablet in office or warehouse | Semi-trusted (authorized but fallible; insider threat if disgruntled) |
| AC-3 | Warehouse operator / scanner device | Shared tablet/rugged scanner; often in a semi-public area; scan-heavy actions | Semi-trusted; weak physical control |
| AC-4 | Channel partner system (Carexy, Digikala) | Calls our webhook receiver; accepts our outbound calls; holds credentials we issued/received | External, contractual trust, compromised if partner is breached |
| AC-5 | SMS provider (Limo) | Receives OTP payloads; returns delivery status; bills per message | External, contractual trust |
| AC-6 | System administrator / DevOps | SSH to host, docker compose, DB tools, backup access, CI/CD secrets | High trust, high impact; the primary insider-risk actor for infra |
| AC-7 | Finance manager / accountant | Approves/post journals, sets prices, sees margin | Authorized; fraud-capable by design (mitigated by SoD/approval) |
| AC-8 | Compromised dependency / supply-chain attacker | Code execution inside API/worker container or CI | Untrusted |
| AC-9 | Opportunistic bot / scanner | Automated credential stuffing, path fuzzing, vulnerability scanning | Untrusted |
| AC-10 | Former employee with lingering access | Still has a valid refresh token or SSH key | Untrusted |

### 4.2 Entry points

| ID | Entry point | Boundary | Exposure |
|---|---|---|---|
| EP-1 | `POST /api/v1/auth/login`, `/auth/otp/*`, `/auth/refresh` | TB-1 | Public internet |
| EP-2 | All other `/api/v1/*` endpoints | TB-1 | Public internet, authenticated |
| EP-3 | SPA static assets `/` | TB-1 | Public |
| EP-4 | `POST /api/v1/webhooks/{channel}` | TB-4 | Public internet (must be signature-verified) |
| EP-5 | `/health/*`, `/metrics` | TB-1 | Internal/LB only (metrics never public) |
| EP-6 | MinIO/S3 API (signed URLs, internal) | TB-5 | Private docker network |
| EP-7 | SSH/22, docker CLI, DB console | TB-6 | VPN/allowlisted IPs only |
| EP-8 | CI/CD pipeline → production deploy | TB-6 | GitHub (protected branches, secrets) |
| EP-9 | Outbound HTTP to channels/SMS | TB-3/TB-7 | Egress from worker/API |
| EP-10 | CSV/Excel import, file upload | TB-1 → TB-5 | Authenticated users |
| EP-11 | Backup/restore job and offsite bucket | TB-8 | Cron container → S3 |

---

## 5–6. Trust boundaries and STRIDE analysis

For every boundary: a description, the data that crosses it, the enforcement point, and a STRIDE table. `Control` references `SECURITY.md` control IDs.

### TB-1 — Browser / warehouse device ↔ Edge / API

**Crosses:** credentials, OTPs, access tokens (bearer header), refresh cookie, business documents, PII, uploaded files.
**Enforcement:** nginx/Caddy TLS + headers; Fastify `helmet`, cookie plugin, CORS plugin, auth guard, Zod validation; SPA CSP.
**Baseline:** TLS 1.2+ / HSTS; access JWT in memory 10 min; refresh cookie `HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth`; strict-Origin checks on `/auth/*`; CSP; per-user/IP rate limits; audit on every sensitive write.

| ID | STRIDE | Threat scenario | Primary controls | Residual |
|---|---|---|---|---|
| T1-S1 | Spoofing | XSS in product name / customer note steals the in-memory access token and acts as the user | SEC-OUT-01 (React escaping), SEC-OUT-02 (no `dangerouslySetInnerHTML`), SEC-TLS-07 (CSP `script-src 'self'`), SEC-AUTH-02 (10-min TTL), SEC-AUD-02 | Token usable ≤ 10 min; detected via audit/security events. **Medium** |
| T1-S2 | Spoofing | Attacker plants their own refresh cookie (session fixation / login CSRF) and later rides the victim's session | SEC-TLS-05 (Origin allowlist on all `/auth/*`), SEC-AUTH-06 (token rotation, family revoke on reuse), SEC-TLS-04 (cookie scope) | Low |
| T1-S3 | Spoofing | Malware on a warehouse tablet replays a stolen refresh token, or an attacker who knows the victim's password forges the low-entropy client-declared `deviceFingerprint` to skip OTP | SEC-AUTH-14 (server-issued device secret; fingerprint is display-only — R1 B-02), SEC-AUTH-06 (rotation, family revoke), SEC-AUTH-09 (session list/revoke), SEC-AUD-05 | Medium (shared devices); **High** until SEC-AUTH-14 is coded |
| T1-S4 | Spoofing | Password-reset takeover: a public OTP-only reset lets an SMS-interception attacker set a finance user's password and obtain a non-MFA session; or a lower-privileged admin resets a higher-privileged user | SEC-AUTH-15 (no public reset in v1; admin subset check; token+OTP; sessions+devices revoked — R1 B-03), SEC-AUTH-05, SEC-AUD-05 | High if a public reset ships; Low with the policy enforced (routed D-9/D-12) |
| T1-T1 | Tampering | MITM on a public/hotel network alters requests or downgrades to HTTP | SEC-TLS-01/02 (TLS 1.2+, HSTS preload, 80→443), SEC-TLS-03 (certificate management) | Low |
| T1-T2 | Tampering | Replay of a captured idempotent `POST` creates a duplicate document | SEC-IN-05 (Idempotency-Key bound to actor + route, 24 h), SEC-AZ-05 (permission re-check) | Low |
| T1-R1 | Repudiation | Warehouse operator claims "the system did it" for a pick/adjustment | SEC-AUD-01..03 (actor, entity, before/after, requestId), device id on scans | Low |
| T1-R2 | Repudiation | Shared tablet logged in as a supervisor, so actions cannot be attributed to a person | SEC-AUTH-11 (short idle timeout, per-shift re-auth), SEC-AUD-01, `warehouse_devices` registration | Medium (process + technical) |
| T1-I1 | Info disclosure | IDOR: changing `public_id`/`branchId`/`warehouseId` in a request reads another branch's order, cost or stock | SEC-AZ-02 (permission guard), SEC-AZ-04 (scope narrowing from token, not request), SEC-AZ-03 (default-deny), SEC-IN-08 (uniform 404) | Low if scope tests exist (QA matrix) |
| T1-I2 | Info disclosure | Stack traces / SQL text returned to the browser | SEC-IN-09 (global error filter, `APP_ENV=production`), SEC-AUD-07 (no internals in errors) | Low |
| T1-I3 | Info disclosure | Cost/margin visible to warehouse operator in SPA payload | SEC-AZ-06 (serializer-level field masking), SPA hides fields only as UX | Low |
| T1-D1 | DoS | Password spray / credential stuffing from a botnet | SEC-AUTH-03 (Argon2id + lockout), SEC-RL-01..03 (Redis sliding window), SEC-MON-02 (alerts), nginx `limit_req` | Medium |
| T1-D2 | DoS | Expensive report/export loop exhausts DB/CPU | SEC-RL-05 (expensive tier + concurrency cap), SEC-RL-06 (job queue), `statement_timeout` | Medium |
| T1-E1 | Elevation | User with `role.update` grants themselves `superadmin` or grants a permission they do not hold | SEC-AZ-07 (no privilege amplification: actor may only grant permissions they hold), SEC-AZ-08 (system roles immutable), SEC-AUD-06, SEC-MON-05 | Low |
| T1-E2 | Elevation | Stolen superadmin session used to create a backdoor user/API client | SEC-AUTH-05 (mandatory 2FA for `superadmin` + `admin`), SEC-AZ-08, SEC-MON-05, break-glass account procedure | Medium |
| T1-E3 | Elevation | CSRF on a cookie-authenticated endpoint changes state | SEC-TLS-04 (cookie `Path` limit + SameSite), SEC-TLS-05 (Origin + `X-Requested-With` on `/auth/*`), SEC-AZ-01 (business writes require bearer, not cookie) | Low |
| T1-E4 | Elevation | Stolen 10-minute access token edits roles/scope (self-assign permissions or widen branch/warehouse scope), and the change outlives revocation | SEC-AZ-15 (step-up + subset check + pv bump + session revoke on scope change — R1 H-01/M-10), SEC-AUTH-16 (`jti` revocation on sensitive routes) | Low |
| T1-E5 | Elevation | Break-glass treated as in-band elevation: phished superadmin credentials+OTP yield a 60-minute unconstrained session with no second person | SEC-AUTH-17 (offline account, two-custodian approval, session always checked, action denylist, kill switch — R1 M-07) | Low |
| T1-D3 | DoS | Public voice-OTP / ad-hoc SMS endpoints drain paid credit and harangue arbitrary mobiles | SEC-RL-09 (voice tiers, challenge-bound voice fallback, one global SMS+voice budget, fail-closed CAPTCHA — R1 H-08), SEC-MON-08 | Medium |

### TB-2 — API / Worker ↔ PostgreSQL and Redis

**Crosses:** SQL, tenant context, session/permission cache, rate-limit counters, queue jobs, outbox events, audit rows.
**Enforcement:** DB roles/grants, Drizzle parameter binding, repository layer `TenantContext`, triggers, fixed lock order, timeouts.
**Baseline:** `saman_app` has DML only on business tables, no DDL, no superuser; audit tables append-only; Redis has `requirepass`, internal network only, and is never a source of truth.

| ID | STRIDE | Threat scenario | Primary controls | Residual |
|---|---|---|---|---|
| T2-S1 | Spoofing | App connects as the `postgres` superuser, so any bug is catastrophic | SEC-DATA-01 (dedicated `saman_app` role), SEC-DATA-02 (no superuser app role), SEC-INF-03 (no DB port published) | Low |
| T2-S2 | Spoofing | Redis unauthenticated and reachable, attacker injects cache entries (poisoned permission cache, forged rate counters) | SEC-INF-04 (Redis `requirepass` + bind internal), SEC-AZ-09 (cache keyed by `permissions_version`, cache is never authoritative), SEC-RL-08 (fail behaviour defined) | Low |
| T2-T1 | Tampering | App bug or malicious insider edits posted journals / stock ledger / audit rows; audit rows can be silently deleted or rewritten with no hash chain | SEC-DATA-03 (append-only ledger), SEC-DATA-04 (immutable posted journals + period lock), SEC-DATA-05 (append-only grants), SEC-AUD-08 (hash chain), SEC-AUD-11/12 (`row_hash`/`prev_hash`/`hash_seq` + `erp.chain_audit()` SECURITY DEFINER owned by migrator, EXECUTE-only to worker, seeded event vocabulary, independent hourly verifier — R1 B-05), SEC-DATA-15 (period/reversal/header-total integrity) | Low |
| T2-E3 | Elevation | Approval configuration is edited with a weaker config permission (remove the second approver / raise the threshold) so a large journal posts alone, or a journal bypasses the workflow entirely | SEC-AZ-16 (`approval.config.manage`, 2-person, 24 h cooling, immutable `data_versions`, DB `approval_id` above threshold, disjoint author/post — R1 B-04), SEC-AZ-11 (`requester ≠ approver` trigger), SEC-DATA-15 | Low |
| T2-I4 | Info disclosure | Reporting role `saman_readonly` reads password hashes, device secrets, security events or settings; `saman_app` can DELETE business rows | SEC-DATA-16 (manifest grants: readonly = views/matviews only; app/worker **no DELETE anywhere**; maintenance role for lifecycle deletes; `\dp` drift CI — R1 H-12), SEC-DATA-07 | Low |
| T2-R2 | Repudiation | Period close/reopen or journal reversal performed with no recorded reason/approver (only a status change) | SEC-DATA-15 (`accounting_period_events` append-only with reason/actor/approver — R1-accounting M-17), SEC-AUD-01/02, SEC-AZ-12 | Low |
| T2-T2 | Tampering | Migration run by the app at boot modifies schema unpredictably | SEC-DATA-01 (`saman_migrator` separate, release step per `ADR-0012`), SEC-SDLC-02 (migration review) | Low |
| T2-R1 | Repudiation | Sensitive mutation committed without an audit row | SEC-AUD-02 (interceptor + transactional audit insert), SEC-AUD-04 (deny-log), code-review checklist | Low |
| T2-I1 | Info disclosure | Unscoped repository query leaks another org/branch/warehouse data | SEC-AZ-04 (`TenantContext` mandatory), SEC-DATA-06 (composite FKs `(organization_id,id)` on high-risk relations), SEC-AZ-10 (CI test fails on `db.select().from()` outside repos) | Low–Medium (no RLS in v1, `ADR-0005`) |
| T2-I2 | Info disclosure | `saman_readonly` used by reports can read credential ciphertext, password hashes, PII | SEC-DATA-07 (column/table REVOKE + reporting views), SEC-DATA-08 (PII views) | Low |
| T2-I3 | Info disclosure | PII lands in `api_request_logs.request_body`, query logs, or error logs | SEC-AUD-07 (no bodies by default; reference DDL body columns must be null), SEC-CRYPTO-06 (log redaction), SEC-DATA-09 (log retention/partition drop) | Medium (dev oversight) |
| T2-D1 | DoS | Runaway query or transaction holds connections/locks | SEC-INF-05 (`statement_timeout` per role, idle-in-transaction timeout), pool cap 20/replica, SEC-MON-03 (DB pool alert) | Medium |
| T2-D2 | DoS | Queue backlog or outbox lag starves the API | SEC-RL-06 (queue isolation), SEC-MON-04 (outbox/queue alerts), worker resource limits | Medium |
| T2-E1 | Elevation | SQL injection through dynamic identifiers (`sort`, `filter`, table/column names) | SEC-IN-02 (Drizzle parameterization only), SEC-IN-03 (dynamic identifier allowlist), SEC-IN-04 (lint bans raw concatenation / `sql.raw`) | Low |
| T2-E2 | Elevation | `saman_app` can call `SECURITY DEFINER` functions or create objects to persist code | SEC-DATA-01 (no `CREATE` on schema), SEC-DATA-02 (no ownership of functions), extension allowlist | Low |

### TB-3 — Worker / API ↔ external channel APIs (egress)

**Crosses:** stock/price updates, order acks/labels, OAuth tokens, API keys, fetched order/media data.
**Enforcement:** adapters behind the `ChannelAdapter` port (`ADR-0006`), encrypted credential store, egress allowlist, timeouts/size caps, schema validation.
**Baseline:** only allowlisted partner hosts; HTTPS only; credentials decrypted in adapter scope; request/response logged without secrets; retries with backoff + DLQ.

| ID | STRIDE | Threat scenario | Primary controls | Residual |
|---|---|---|---|---|
| T3-S1 | Spoofing | Attacker with a DB read gets channel API keys and impersonates the ERP to Carexy/Digikala | SEC-CRYPTO-01 (AES-256-GCM envelope, key outside DB), SEC-CRYPTO-05 (decrypt only in adapter scope), SEC-DATA-07 (readonly role cannot read ciphertext) | Low |
| T3-S2 | Spoofing | Channel base URL is admin-editable; attacker points it at an internal service (SSRF) | SEC-IN-06 (egress allowlist + URL validation + IP-class blocking + no redirects), SEC-IN-07 (DNS-rebinding-safe connect) | Low–Medium |
| T3-T1 | Tampering | Partner response (or MITM) redirects to internal metadata endpoint / returns a huge or zip-bomb payload | SEC-IN-06, SEC-IN-10 (response size/time caps), `TLS verification on`, SEC-MON-06 (egress denial alert) | Low |
| T3-T2 | Tampering | Duplicate or out-of-order partner responses cause double stock push / double shipment update | SEC-IN-05 (idempotency keys), `channel_api_calls` request hash, outbox exactly-once effects (`ADR-0010`) | Low |
| T3-R1 | Repudiation | Partner claims they never received the stock update | `erp.channel_api_calls` with request hash + timestamp + response status (180 d retention) | Low |
| T3-I1 | Info disclosure | Adapter sends cost/margin or customer PII to a channel that does not need it | SEC-OUT-05 (adapter outbound DTO allowlist), code review + contract tests | Low |
| T3-I2 | Info disclosure | API key appears in error messages or logs | SEC-CRYPTO-06 (redaction), SEC-AUD-07, adapter wraps errors | Low |
| T3-D1 | DoS | Partner outage/rate-limit storm exhausts worker concurrency and blocks order ingest | Circuit breaker + backoff + jitter, circuit opens per channel, queue isolation, SEC-MON-04 | Medium |
| T3-E1 | Elevation | OAuth token over-scoped (Digikala 264-endpoint catalog); a stolen token can change prices/promotions | SEC-CRYPTO-07 (minimum scopes per adapter, documented in `API.md`), token encrypted with expiry, per-account rotation | Medium (partner-side) |
| T3-I3 | Info disclosure | Outbound webhook subscription (admin-created) points at an attacker host and streams orders, PII, stock and cost data out of the ERP | SEC-IN-16 (seeded destination allowlist, outbound payload allowlist with no cost/PII beyond IDs, step-up, first-delivery alert — R1 H-04), SEC-AZ-16 (destination change is a two-person config change) | Low |
| T3-E2 | Elevation | Egress allowlist is derived from operator-editable env/base-URL, so pointing the config at `minio`/metadata makes the allowlist approve it | SEC-IN-21 (host set is code-declared; env selects only a preset; boot assertion — R1 M-05), network egress firewall as independent backstop | Low |

### TB-4 — Inbound webhooks (channels → API)

**Crosses:** order/return/shipment events, merchant settings, payloads containing customer PII.
**Enforcement:** `POST /api/v1/webhooks/{channel}` in `apps/api/src/modules/channels/webhooks/`, raw-body capture, signature verify, replay store, Zod parse, idempotency, queue handoff.
**Baseline:** HMAC-SHA256 over raw body + timestamp; ≤ 300 s skew; replay cache; unknown event types rejected; 202 fast-ack, processing async.

| ID | STRIDE | Threat scenario | Primary controls | Residual |
|---|---|---|---|---|
| T4-S1 | Spoofing | Attacker posts a fake `order.created` to create real orders/stock reservations, or overrides the signature header/algorithm via editable account settings so a forged body verifies | SEC-IN-11 (HMAC-SHA256 over the raw body), SEC-IN-17 (MAC input binds `v1|channel|account|eventId|timestamp|rawBody`; scheme is compile-time, not settings — R1 H-03/M-03), per-channel secret from encrypted store, constant-time compare | Low |
| T4-S2 | Spoofing | Attacker replays a captured valid delivery with a fresh unsigned `X-Event-Id` (new archived event / re-run job), or replays indefinitely if the timestamp flag is off | SEC-IN-17 (event id inside the MAC; timestamp mandatory, no feature flag), SEC-IN-12 (300 s skew + replay set keyed by signed event id; unique `(channel, account, external_event_id)`) | Low |
| T4-T1 | Tampering | Body modified in transit (e.g. amount/quantity) with a valid-looking signature | Signature covers raw body; TLS; amounts are **never** trusted from webhook — order is fetched back/reconciled before stock/money commit | Low |
| T4-T2 | Tampering | Webhook triggers handlers for unknown/malicious event types | SEC-IN-13 (event-type allowlist), Zod schema per type, unknown → 400 + audit | Low |
| T4-R1 | Repudiation | Duplicate or dropped webhook leads to "we never got the order" dispute | Raw payload archived (`channel_webhook_events`), delivery id + `requestId`, idempotency key visible in audit | Low |
| T4-I1 | Info disclosure | Raw webhook (customer address/phone) logged or served by an over-broad endpoint | SEC-AUD-07 (redacted logging), archived payload is Confidential + DB role restricted, no API exposes raw archive | Medium |
| T4-D1 | DoS | Webhook flood saturates API/queue | SEC-RL-07 (per-channel token bucket + source-IP allowlist when partner provides one), quick 202, queue backpressure | Medium |
| T4-E1 | Elevation | Webhook accepted as authority for stock/money transitions (e.g. "order cancelled" → release reservation) | SEC-IN-14 (webhook is a hint; state transitions validated against fetch-back + current DB state), idempotent state machine | Low |
| T4-E2 | Elevation | Forged Digikala webhook passes because signature scheme is unconfirmed (`TBD-DIGIKALA`) | Compensating: source-IP allowlist + fetch-back verification + `TBD-DIGIKALA` feature flag off in production until signature verified | Medium (accepted until contract confirmed) |

### TB-5 — API / Worker ↔ S3 / MinIO

**Crosses:** product images, imports/exports, shipping labels, backup objects.
**Enforcement:** `apps/api/src/modules/platform/files/` upload pipeline, private bucket policy, server-generated object keys, short-TTL signed URLs.
**Baseline:** no public bucket/ACL; app uses a scoped MinIO user per bucket; server-side `sha256`; `Content-Disposition: attachment`; versions on.

| ID | STRIDE | Threat scenario | Primary controls | Residual |
|---|---|---|---|---|
| T5-S1 | Spoofing | Anonymous or leaked MinIO root credentials read/write buckets | SEC-CRYPTO-08 (separate MinIO app user, no root in app), SEC-INF-06 (MinIO port not published), SEC-INF-04 (network isolation) | Low |
| T5-T1 | Tampering | Uploaded object replaced after validation (e.g. malicious replacement image) | SHA-256 stored in `file_assets`, object versioning, upload-through-API only, no direct client write credentials | Low |
| T5-R1 | Repudiation | No record of who downloaded a sensitive export/label | `file_assets` + audit action `file.download`, signed URL issuance logged | Low |
| T5-I1 | Info disclosure | Bucket listing/anonymous read exposes customer invoices or media | SEC-INF-06 (private bucket, deny `s3:ListBucket` to anonymous, bucket policy reviewed in `infra/docker/minio/init.sh`) | Low |
| T5-I2 | Info disclosure | Long-lived presigned URL leaked in chat/referrer | SEC-OUT-04 (signed URL TTL ≤ 5 min, `Referrer-Policy: no-referrer`), per-file permission check before signing | Low |
| T5-D1 | DoS | Object spam / disk fill via upload or import; presigned-upload abuse (multi-GB junk, spoofed content-type, orphans never GC'd) | SEC-IN-10 (size caps, per-user upload tier SEC-RL-05), SEC-IN-18 (v1 server-mediated; if presigned, S3 POST-policy `content-length-range` + content-type + metadata binding, 24 h orphan lifecycle, in-flight cap, scan-before-ready — R1 H-05), MinIO quota, disk alert | Medium |
| T5-E1 | Elevation | Path traversal in storage keys (user-supplied filename used in key) | SEC-IN-10 (server-generated key `org/{orgId}/{yyyy}/{mm}/{uuid}`; original name only as metadata) | Low |
| T5-E2 | Elevation | Malicious file (SVG/HTML/CSV formula) served inline to a user's browser | SEC-IN-10 (magic bytes + image re-encode + SVG reject + `nosniff` + attachment), SEC-OUT-06 (CSV formula escaping) | Low |
| T5-I3 | Info disclosure | A user with only `file.read` downloads cheque images, supplier invoices or national-ID scans from another entity/branch (org-wide file list) | SEC-OUT-07 (entity-scoped download: resolve `owner_entity_*`, require entity read permission + TenantContext scope, 404 cross-scope, audit — R1 H-06), SEC-AZ-17 | Low |

### TB-6 — Operator / administrator ↔ host, SSH, CI/CD

**Crosses:** root shell, Docker socket, secret files under `/run/secrets`, DB superuser, deployment artifacts, CI secrets.
**Enforcement:** host firewall/SSH policy, Docker hardening, protected branches, secret scanning, least-privilege deploy user (no docker-root path).
**Baseline:** keys-only SSH from allowlisted IPs, no root login; containers non-root + read-only + dropped caps; secrets delivered as Compose file secrets (`/run/secrets`, no secrets in container env); production deploys only from protected tags via a reviewed pipeline.

| ID | STRIDE | Threat scenario | Primary controls | Residual |
|---|---|---|---|---|
| T6-S1 | Spoofing | SSH password brute force or stolen unencrypted private key | SEC-INF-07 (keys only, ed25519, `PermitRootLogin no`, `AllowUsers`, optional TOTP), SEC-INF-08 (fail2ban + ufw) | Low–Medium |
| T6-S2 | Spoofing | Compromised CI token deploys a malicious image or exfiltrates secrets | SEC-SC-05 (protected branches/environments, required reviews), SEC-SC-06 (OIDC/short-lived deploy creds, no long-lived PAT on host), SEC-SC-04 (image digest pinning) | Medium |
| T6-T1 | Tampering | Out-of-band host edits ("just one SQL fix") corrupt schema/audit | SEC-SDLC-02 (migrations only, release step), SEC-INF-09 (auditd + docker events shipped), SEC-DATA-10 (no manual production DDL) | Medium |
| T6-R1 | Repudiation | Admin denies a destructive action | auditd, shell history shipped off-host, docker events, DB `log_statement=ddl`, SEC-AUD-08 | Low |
| T6-I1 | Info disclosure | `.env`/backup readable by a low-privileged operator or in a volume snapshot; or all secrets visible to anyone with docker access via `docker inspect`/`docker exec env` (deploy user had docker sudo) | SEC-CRYPTO-16 (Compose `secrets:` / root-owned 0400 `/run/secrets` files, never `env_file`; no secrets in container env — R1 H-11), SEC-CRYPTO-09, SEC-CRYPTO-10 (encrypted backups, offline passphrase), SEC-INF-11, file-permission check in `scripts/verify-host.sh` | Low |
| T6-E4 | Elevation | Compromised/retagged CI Action or unpinned scanner tool executes with repo/environment secrets | SEC-SC-10 (every action pinned to a 40-char SHA, Trivy digest, exact SBOM version, pin-policy test — R1 L-01), SEC-SC-05/06, gitleaks push protection | Low–Medium |
| T6-E5 | Elevation | Edge container is documented as non-root + `cap_drop: ALL` but actually needs 80/443, so operators silently re-add `NET_BIND_SERVICE`/run root | SEC-INF-11 (edge listens 8080/8443; host maps 80/443; capability re-add is an explicit reviewed exception — R1 L-02), SEC-INF-01 | Low |
| T6-D1 | DoS | Ransomware/docker prune/down -v destroys data and backups | SEC-INF-10 (immutable/offsite backup copy, object-lock, restore drill), SEC-MON-07 (backup age alert), no destructive commands in scripts (`ADR-0012`) | Medium |
| T6-E1 | Elevation | Container escape via privileged container / docker socket mount | SEC-INF-01..03 (`no-new-privileges`, `cap_drop: ALL`, read-only rootfs, no socket mounts, explicit `user:`), seccomp default | Low |
| T6-E2 | Elevation | Key custodian decrypts/rewrites backups then restores them | Split custody: backup age private key held offline by a different person; audit of restore procedure; checksum + signed manifest | Medium (process) |
| T6-E3 | Elevation | Compromised npm dependency executes in CI with repo/create-release rights | SEC-SC-01..03 (lockfile immutable install, `ignore-scripts`, dependency review), SEC-SC-07 (semgrep/Trivy/gitleaks gates), branch protection | Medium |

### TB-7 — API ↔ SMS provider (Limo) and OTP path

**Crosses:** mobile number, OTP, pattern code, `ApiKey`, delivery result.
**Enforcement:** `apps/api/src/modules/identity/otp/limo-sms.adapter.ts`; `SMS_MODE=mock|limo` guard; rate limits; global paid-message budget; CAPTCHA.
**Baseline:** OTP generated server-side (CSPRNG), hashed at rest, never logged; `ApiKey` from `/run/secrets/limo_api_key`; provider calls made from API (`sendcode`) not worker; one monetary budget for SMS **and** voice.

| ID | STRIDE | Threat scenario | Primary controls | Residual |
|---|---|---|---|---|
| T7-S1 | Spoofing | Stolen Limo `ApiKey` used to send smishing on our sender line / drain credit | SEC-CRYPTO-11 (`LIMO_API_KEY` secret-file only, rotatable, used in one adapter), SEC-MON-08 (send-volume/monetary anomaly alert) | Low |
| T7-T1 | Tampering | OTP content manipulation via user-controlled template variables (pattern footer) | SEC-IN-15 (`/sendcode` with fixed footer only; user input never interpolated into SMS), templates seeded, not user-editable by non-admin | Low |
| T7-R1 | Repudiation | "I never received the OTP" dispute | `sms_messages` + provider `MessageId` + `otp_challenges` audit | Low |
| T7-I1 | Info disclosure | OTP appears in logs, DB plaintext, or `SMS_MODE=mock` accidentally left on in prod | SEC-CRYPTO-12 (HMAC-SHA256 with `OTP_PEPPER` at rest, constant-time verify), SEC-CRYPTO-06 (redact `otp`/`code`), SEC-AUD-07, boot guard: `SMS_MODE=limo` required when `APP_ENV=production` | Low |
| T7-I2 | Info disclosure | Mobile-number enumeration via OTP-send endpoint | SEC-AUTH-10 (same generic response + timing for known/unknown users; per-mobile + per-IP limits) | Low |
| T7-D1 | DoS/financial | OTP/voice flooding: attacker requests paid codes/calls for many numbers to burn credit and/or lock victims | SEC-AUTH-12 (per-mobile 5/h, per-IP 20/h, exponential delay), SEC-RL-09 (voice tiers, challenge-bound voice fallback, single global SMS+voice budget with auto-stop, mandatory fail-closed CAPTCHA — R1 H-08), SEC-RL-02 | Medium |
| T7-E1 | Elevation | OTP brute force within the 2-min window (6 digits, 1e6 space), including by switching between OTP/MFA/reset endpoints to reset attempts | SEC-AUTH-04 (max 5 attempts, single-use, 2-min TTL, DB attempt counter), shared attempt counter across endpoints (SEC-RL-09), lockout after exhaustion, SEC-AUD-05 | Low |

### TB-8 — Backup / restore and offsite storage

**Crosses:** full database dump (contains password hashes, encrypted creds, PII, journals), restore commands into a database.
**Enforcement:** `infra/backup/backup.sh` + maintenance worker trigger; age encryption; S3 offsite bucket; restore procedure in `docs/07-operations/BACKUP-RESTORE.md`.
**Baseline:** encrypted before leaving host, `sha256` manifest, 30-day retention + offsite object lock, restore drill quarterly (RPO ≤ 15 min, RTO ≤ 1 h).

| ID | STRIDE | Threat scenario | Primary controls | Residual |
|---|---|---|---|---|
| T8-S1 | Spoofing | Attacker with object-store credentials replaces a backup with a tampered/older dump | SEC-CRYPTO-10 (`age` encryption + signed `sha256` manifest), object-lock/immutability on offsite bucket, restore verifies manifest | Low–Medium |
| T8-T1 | Tampering | Backup tampered or truncated → silent data loss discovered at restore time | Daily backup verification job (`pg_restore --list`, checksum), SEC-MON-07 (backup age/failure alert) | Low |
| T8-I1 | Info disclosure | Plaintext dump exfiltrated from host/S3, exposing PII and encrypted channel secrets | SEC-CRYPTO-10 (age-encrypted dump), SEC-CRYPTO-13 (backup bucket credentials separate from app creds), SEC-DATA-11 (bucket policy: write-only for backup sidecar) | Low |
| T8-I2 | Info disclosure | Staging restore uses production PII | SEC-DATA-12 (anonymized staging copy; `pg_anonymize` script), documented in `DEPLOYMENT.md` | Medium |
| T8-D1 | DoS | Disk full or backup job killed → RPO breach | Dedicated volume, retention pruning, `maintenance` partition drops, SEC-MON-07 alerts, WAL archiving | Medium |
| T8-E1 | Elevation | Restore into the wrong database (prod overwritten by stale dump) | `RESTORE_CONFIRM` guard env + explicit target DB check in script, change-approval, restore drill | Low |

---

## 7. Abuse cases

Each abuse case is a concrete attacker playbook. `Detect` items must be exported as security events (`SEC-AUD-09`) and alert rules (`SEC-MON-01`).

### AC-01 · Credential stuffing and password spraying (AC-1/AC-9)
- **Preconditions:** public login endpoint; employees reuse passwords breached elsewhere.
- **Playbook:** attacker uses a leaked `mobile/username:password` list from Iranian breaches against `/auth/login`; rotates source IPs; tries company phone-number patterns; a small number of successes gives valid ERP accounts.
- **Impact:** account takeover of finance/warehouse users; fraud; data exfiltration. **Likelihood:** High. **Impact:** High. **Score 20 (Critical).**
- **Prevent:** Argon2id (SEC-AUTH-01); 12-char + zxcvbn≥3 + breached-password check at set time (SEC-AUTH-13); per-IP/per-username sliding windows (SEC-RL-01/02); lockout 10 failures/15 min + exponential delay (SEC-AUTH-03); mandatory 2FA on new devices (SEC-AUTH-05).
- **Detect:** `auth.login.failed` bursts per IP/ASN and distributed low-rate per-username; `auth.login.success` from a new IP/UA after failures; alert thresholds in SEC-MON-02.
- **Respond:** lock affected accounts, revoke sessions (SEC-AUTH-09), force password reset, block source ranges at nginx.
- **Residual:** Medium (a valid password + intercepted OTP can still succeed; MFA reduces it).

### AC-02 · OTP flooding and SMS-credit abuse (AC-1/AC-9)
- **Preconditions:** public OTP-send endpoint; SMS billed per message.
- **Playbook:** enumerate mobile numbers or target known employees, call send-OTP repeatedly (thousands/hour) to drain the Limo credit line and lock victims out of login; alternatively brute-force a victim's OTP across many concurrent sessions to beat attempt limits.
- **Impact:** financial loss, login denial for staff, support burden. **Likelihood:** High. **Impact:** Medium. **Score 15 (High).**
- **Prevent:** per-mobile 5/h, per-IP 20/h, per-OTP 5 verify attempts shared across OTP/MFA/reset (SEC-RL-09), 2-min TTL, single-use, Redis+DB counters (SEC-AUTH-04/12); one global SMS+voice monetary budget with auto-stop; **mandatory** CAPTCHA/Turnstile after 3 sends/10 min, fail-closed (SEC-RL-09); voice fallback bound to a `challengeId` from the password step.
- **Detect:** `otp.send` rate per IP/prefix; budget consumption vs baseline; `otp.verify.failed` clusters per mobile; `captcha.challenge.failed` spikes.
- **Residual:** Medium (distributed IPs; budget cap bounds loss).

### AC-03 · Order manipulation by an insider or compromised sales account (AC-2/AC-7)
- **Preconditions:** `sales.order.write` / `sales.order.discount` permissions; order editable before shipment.
- **Playbook:** user edits quantities/prices/discount after approval, creates fake customer, ships to an address they control, or cancels-and-recreates to bypass approval thresholds; partner order altered in ERP while channel still holds the original.
- **Impact:** revenue leakage, inventory mismatch, channel penalty. **Likelihood:** Medium. **Impact:** High. **Score 15 (High).**
- **Prevent:** SoD approval for discounts above threshold and for order edits after allocation (SEC-AZ-11); immutable order line snapshots (price/commission copied at creation); channel order reconciliation job; per-field audit with before/after (SEC-AUD-02); `If-Match` version check to prevent silent overwrite (SEC-IN-05).
- **Detect:** orders with modified price after confirmation; orders shipped to addresses differing from customer master; `sales.order.price_changed` events.
- **Residual:** Medium.

### AC-04 · Oversell race (concurrent allocation) (AC-1/AC-4)
- **Preconditions:** high-demand SKU with 1 remaining unit; two channels ingest orders simultaneously.
- **Playbook:** two concurrent allocations both read `available=1`, both create reservations; one fails to decrement due to lost update; channel receives "sold" for both; customer gets a cancellation.
- **Impact:** oversell, marketplace penalties, refund cost, trust loss. **Likelihood:** Medium. **Impact:** High. **Score 15 (High).**
- **Prevent:** transactional allocation with `FOR UPDATE` in fixed lock order and `CHECK (on_hand>=0 AND reserved>=0 AND available>=0)` (`ADR-0007`); reservation all-or-nothing; 100-parallel allocator test in CI; channel push uses `available` not `on_hand`.
- **Detect:** nightly `Σ ledger == balances` consistency job; reservation expiry anomalies; `RULE_VIOLATION INSUFFICIENT_STOCK` spikes.
- **Residual:** Low (DB constraints make negative stock impossible; channel-side promise lag remains).

### AC-05 · IDOR across branches / warehouses / organizations (AC-2/AC-3)
- **Preconditions:** multi-branch/warehouse deployment; IDs present in URLs and bodies; scope narrowing enforced server-side.
- **Playbook:** operator of branch A edits `branchId`/`warehouseId` in a request (or guesses another `public_id`) to read another branch's orders, margins, stock, or to post an adjustment in a warehouse they are not assigned to.
- **Impact:** cross-branch data leak, fraudulent stock adjustments. **Likelihood:** Medium. **Impact:** High. **Score 15 (High).**
- **Prevent:** default-deny `@Permissions()` guard (SEC-AZ-01/02); scope IDs taken from token `TenantContext`, never trusted from request (SEC-AZ-04); repository tests assert scope filtering (SEC-AZ-10); composite FKs `(organization_id,id)` (SEC-DATA-06); internal bigint never exposed (`ADR-0003`); **out-of-scope detail/action always returns 404, never 403** (SEC-IN-08, R1 M-09) so the response is not an existence oracle.
- **Detect:** `access.denied` audit rows spike; 404 sequences from one actor across many IDs; `access.denied.spike` alert.
- **Residual:** Low (no RLS in v1; relies on repo discipline — see `ADR deviation request D-3`).

### AC-06 · SSRF via channel configuration / import URL (AC-6/AC-8)
- **Preconditions:** admin-editable `channel_accounts.base_url` or "import from URL" feature; worker has network reachability to internal services.
- **Playbook:** attacker with `channel.*` write (or a compromised admin) sets base URL to `http://169.254.169.254/latest/meta-data/`, `http://postgres:5432`, or an internal MinIO endpoint; worker makes the request and returns or stores the response; alternatively a partner-controlled redirect points to internal hosts. If the allowlist is built from the same editable env var, the SSRF guard approves the attacker's destination.
- **Impact:** cloud metadata/credential theft, internal port scanning, DB/MinIO compromise. **Likelihood:** Low–Medium. **Impact:** Critical. **Score 15 (High).**
- **Prevent:** SEC-IN-06: per-adapter **code-declared** host allowlist (`packages/http-client/src/egress-hosts.ts`, not config) in `apps/api/src/modules/channels/adapters/<adapter>/egress.ts`; env selects only a `live`/`sandbox` preset; boot assertion fails on non-declared base URL (SEC-IN-21, R1 M-05); HTTPS-only; reject IP literals/userinfo/fragments; block RFC1918, loopback, link-local, `100.64/10`, `169.254/16`, `::1`, `fc00::/7`; resolve then connect-by-validated-IP (DNS-rebinding safe); max 3 redirects, each revalidated (or none); 5 s connect / 30 s total timeout; 10 MB response cap (SEC-IN-07/10); worker egress restricted via host firewall to allowlisted destinations; no cloud metadata on the host (bare metal).
- **Detect:** SEC-MON-06 egress-denied alerts; audit of channel URL changes; outbound connections to non-allowlisted IPs; boot-assertion failures at deploy.
- **Residual:** Low.

### AC-07 · Webhook forgery / replay (AC-1/AC-4)
- **Preconditions:** public webhook endpoint; partner signature scheme known or guessed.
- **Playbook:** attacker posts `order.created` with a high-value order shipped to their address, or replays a captured "order cancelled" to release stock/reservation and re-sell it, or floods to mask a real event.
- **Impact:** fake orders, inventory corruption, refund fraud. **Likelihood:** Medium. **Impact:** High. **Score 15 (High).**
- **Prevent:** SEC-IN-11/12/17 HMAC-SHA256 over `v1|channel|account|eventId|timestamp|rawBody` with per-channel secret (event id **inside** the MAC — R1 M-03), constant-time compare, mandatory 300 s skew (no flag), replay set keyed by signed event id; signature scheme/header/algorithm are compile-time per adapter and MUST NOT be configurable through account settings (R1 H-03); unknown event types rejected; **webhook never authoritative for amounts/stock** — fetch-back and reconcile before committing (SEC-IN-14); Digikala TBD signature → IP allowlist + fetch-back + feature flag off.
- **Detect:** `webhook.signature.invalid` security events; duplicate delivery IDs; order created from webhook without matching fetch-back.
- **Residual:** Medium for Digikala until its signature scheme is confirmed.

### AC-08 · Malicious file upload (AC-2/AC-8)
- **Preconditions:** image/import upload endpoints; files served back to users.
- **Playbook:** upload an HTML/SVG polyglot named `.jpg` to get stored XSS on the ERP origin; upload a zip bomb/CSV with formula injection to attack finance exports; upload a huge file to fill disk; upload a file whose EXIF carries malware payload for downstream scanners.
- **Impact:** stored XSS → session takeover; disk exhaustion; supply-chain to partners. **Likelihood:** Medium. **Impact:** High. **Score 15 (High).**
- **Prevent:** SEC-IN-10 pipeline — multipart limits, magic-byte check, MIME/extension cross-check, `sharp` re-encode (strips EXIF, rejects non-image content), SVG rejected, private bucket, `nosniff` + `Content-Disposition: attachment` + sandbox CSP on download, server-generated keys, CSV parsed in worker with row/size and decompression caps (SEC-IN-19, R1 M-04), formula escaping on export (SEC-OUT-06), ClamAV scan-before-ready. **No presigned client PUT in v1**; if enabled, S3 POST policy with size/type constraints + 24 h orphan lifecycle (SEC-IN-18, R1 H-05).
- **Detect:** upload rejection metrics; `file.upload.rejected` audit; disk usage alerts.
- **Residual:** Low–Medium (zero-day parser bugs).

### AC-09 · SQL injection (AC-1/AC-2/AC-8)
- **Preconditions:** any endpoint with filter/sort/search parameters or raw SQL.
- **Playbook:** inject via `?sort=`, `?filter[status]=`, report parameters, or a dynamic identifier in a reporting query to exfiltrate data or escalate to `pg_read_file`/stacked queries.
- **Impact:** full database compromise. **Likelihood:** Low (with Drizzle + review) / High if raw SQL slips in. **Impact:** Critical. **Score 10–20.**
- **Prevent:** SEC-IN-02 Drizzle parameter binding; SEC-IN-03 allowlisted identifiers (Zod enum → column map, never string interpolation); SEC-IN-04 ESLint rule banning `sql.raw()`/template concatenation outside reviewed helpers; no `db.execute` in controllers; `saman_app` no superuser/no file functions; CI semgrep SQLi rules (SEC-SC-07).
- **Detect:** WAF/nginx anomalous query patterns; DB error spikes; semgrep CI failures; ZAP baseline scan (QA).
- **Residual:** Low.

### AC-10 · Stored XSS in product names / customer notes (AC-2)
- **Preconditions:** catalog/order fields rendered in SPA; some fields allowed to contain limited HTML? (v1: no HTML allowed).
- **Playbook:** employee with catalog write (or a channel feed) stores `<img src=x onerror=...>` in product name/description; an admin opens the product list; script runs in ERP origin, steals the in-memory access token, calls APIs with admin rights.
- **Impact:** privilege escalation, mass data theft. **Likelihood:** Medium. **Impact:** High. **Score 15 (High).**
- **Prevent:** SEC-OUT-01 React escaping only, no `dangerouslySetInnerHTML` (lint), product descriptions as plain text (rich text only via sanitizer allowlist component), SEC-TLS-07 CSP `script-src 'self'` with no `unsafe-inline`/`unsafe-eval`, `object-src 'none'`, `base-uri 'none'`; channel payload strings validated/truncated on ingest (SEC-IN-01); access token 10-min TTL (SEC-AUTH-02).
- **Detect:** CSP violation reports (`/api/v1/csp-report`), dependency/DOM XSS review, ZAP.
- **Residual:** Low–Medium (one missed `dangerouslySetInnerHTML` reopens it).

### AC-11 · Privilege escalation through role/permission editing (AC-2/AC-6)
- **Preconditions:** `identity.role.write` or `identity.user.write` permission held by an admin.
- **Playbook:** admin edits their own role to add `accounting.journal.post` + `approval.bypass`, or grants a colleague an approval permission, or removes the `is_system` flag from a role to change it; alternatively exploits that permission cache isn't invalidated and keeps old/new rights longer than expected.
- **Impact:** fraud, unauthorized posting/adjustment. **Likelihood:** Medium. **Impact:** High. **Score 15 (High).**
- **Prevent:** SEC-AZ-07 no privilege amplification (can only grant permissions the actor holds; only `superadmin` may grant `superadmin`), **SEC-AZ-15** (step-up + subset check including the target user's permissions + scope changes bump `pv` and revoke target sessions — R1 H-01/M-10); system roles immutable (`ADR-0008`); permission changes require step-up 2FA + approval workflow; `permissions_version` bump inside the same transaction; Redis cache keyed by version (SEC-AZ-09); DB constraint `requested_by <> approved_by` (SEC-AZ-11); single permission registry with exact matching (SEC-AZ-14 — prevents wildcard/prefix grants).
- **Detect:** audit `identity.role.permissions_changed` with diff; alert when a permission set expands for a privileged role; `PERMISSIONS_CHANGED` re-auth events.
- **Residual:** Low.

### AC-12 · Backup exfiltration (AC-6/AC-8)
- **Preconditions:** backup written to host/S3; operator or compromised container can read it.
- **Playbook:** attacker exfiltrates a `pg_dump` and extracts password hashes (crack offline), customer PII, supplier/pricing data, and encrypted channel credentials; or exfiltrates the `.env` and the age private key together.
- **Impact:** mass privacy breach + account cracking. **Likelihood:** Low–Medium. **Impact:** Critical. **Score 15 (High).**
- **Prevent:** SEC-CRYPTO-10 backups encrypted (`age` passphrase via Compose secret) before leaving the host, passphrase in split custody and separate from the host (R1 H-11); SEC-CRYPTO-09 `.env` carries no secrets (config only); SEC-DATA-07 restricted DB roles; SEC-CRYPTO-13 separate write-only backup-bucket credentials; object-lock + retention; egress allowlist for backup container.
- **Detect:** S3 access logs (who downloaded dumps); unusual dump download notifications; SEC-MON-07 backup anomalies.
- **Residual:** Low–Medium (key custody is the weak point; see incident response SEC-MON-09).

### AC-13 · Insider fraud via journal manipulation (AC-7/AC-6)
- **Preconditions:** accountant/finance access to journal creation; period open; approval workflow exists.
- **Playbook:** accountant posts a manual journal to a suspense/expense account with a round amount, reverses it after period close, or edits a posted entry; creates a vendor/customer and pays via fake settlement; edits the approval workflow/threshold to remove the second approver; approves their own request by editing `approval_requests`; deletes audit evidence.
- **Impact:** direct financial theft, falsified statements, tax liability. **Likelihood:** Medium. **Impact:** Critical. **Score 20 (Critical).**
- **Prevent:** SEC-DATA-03/04 journals append-only, posted entries immutable, corrections only via reversal with `reversal_of_id`, period lock; **SEC-AZ-16** approval config is a 2-person, cooling-off, immutable-snapshot object and above-threshold journals need a DB-validated `approval_id` (R1 B-04); SEC-DATA-15 period derived from `entry_date`, `accounting_period_events` append-only for close/reopen, header totals recomputed from lines (R1-accounting B-09/B-16/H-11/H-12/M-17); SEC-AZ-11 SoD + SEC-AZ-12 journal step-up; no UPDATE/DELETE grants on audit/journal tables (SEC-DATA-05/16); audit hash chain (SEC-AUD-08/12).
- **Detect:** SEC-AUD-09 anomaly rules — manual journals above threshold, off-hours posting, round amounts, self-approval attempts, approval-config changes, role changes outside change windows, audit hash mismatch; SEC-MON-05 alerts.
- **Residual:** Medium (collusion of two privileged users; detective controls only).

### AC-14 · Session theft / refresh-token replay (AC-1/AC-3/AC-10)
- **Preconditions:** stolen refresh token (malware/misuse of a shared device/browser profile).
- **Playbook:** attacker replays the refresh token from another IP; continues rotating the session; legitimate user is logged out or the attacker persists for days. Former employee keeps a valid device session.
- **Impact:** long-lived impersonation. **Likelihood:** Medium. **Impact:** High. **Score 15 (High).**
- **Prevent:** SEC-AUTH-06 rotation + reuse detection (reuse revokes the whole family + security event); refresh cookie httpOnly/Secure; **SEC-AUTH-14** server-issued device secret + IP/UA change → step-up (a stolen refresh token without the device secret still rotates but triggers step-up on sensitive actions; R1 B-02); SEC-AUTH-16 `jti` revocation on sensitive routes; SEC-AUTH-09 session list + admin revoke + revoke on offboarding checklist; access token 10 min; `mfa_verified` enforced for sensitive actions (SEC-AUTH-05).
- **Detect:** `auth.refresh.reuse_detected`; session using two distant IPs in a short window; refresh from a new ASN.
- **Residual:** Low–Medium.

### AC-15 · Supply-chain compromise (AC-8)
- **Preconditions:** third-party npm dependency, Docker base image, or CI action.
- **Playbook:** typosquatted package or compromised maintainer publishes a malicious version consumed by `pnpm install`; postinstall script exfiltrates `.env` or adds a backdoor to the API image; compromised GitHub Action steals deploy secrets.
- **Impact:** full production compromise. **Likelihood:** Medium. **Impact:** Critical. **Score 20 (Critical).**
- **Prevent:** SEC-SC-01 lockfile + `--frozen-lockfile`, `ignore-scripts=true` with explicit `onlyBuiltDependencies`; SEC-SC-02 dependency review + Renovate with cooling period; SEC-SC-03 SBOM + license policy; SEC-SC-04 digest-pinned base images; SEC-SC-05 protected branches/required reviews; SEC-SC-06 least-privilege CI tokens; SEC-SC-07 gitleaks/semgrep/Trivy gates; SEC-SC-08 signed releases/images (roadmap).
- **Detect:** `pnpm audit`/Trivy CI failures, unexpected dependency diffs, egress from CI, image hash drift at deploy.
- **Residual:** Medium (transitive ecosystem risk; mitigate by time-delayed updates and runtime egress allowlist).

### AC-16 · Device-trust forgery / MFA bypass (AC-2/AC-10) — R1 B-02
- **Preconditions:** login accepts a client-declared `deviceFingerprint`; the server treats a matching fingerprint as a trusted device.
- **Playbook:** attacker obtains an employee password (breach/phishing/reuse) and sends the victim's observable fingerprint (UA/platform/screen/timezone hash) in the login body; the server matches `user_devices` and returns tokens **without OTP**, defeating mandatory MFA for admin/finance roles.
- **Impact:** full account takeover of a privileged user with no second factor. **Likelihood:** Medium. **Impact:** Critical. **Score 20 (Critical).**
- **Prevent:** SEC-AUTH-14 server-issued 32-byte device secret (`__Secure-saman_dev`, HttpOnly) — trust ONLY when the secret is presented and its HMAC matches; fingerprint is a display label; missing secret ⇒ 202 MFA challenge; trust revoked on password/role/scope change and on admin revoke; device mismatch counted in login throttle and `security_events`.
- **Detect:** `auth.device.secret_mismatch` counter; login success without an MFA event on a mandatory-MFA role.
- **Residual:** Low (device-cookie theft on a compromised endpoint is prevented only by the second factor; trusted-device lifetime 30 days).
- **Test:** correct password + victim fingerprint + no device cookie ⇒ 202 MFA, not tokens.

### AC-17 · Password-reset takeover (AC-1/AC-7) — R1 B-03
- **Preconditions:** a public OTP-only reset exists, or an admin with `user.update` can reset any user.
- **Playbook:** (a) attacker intercepts/ports the victim's SMS, calls `POST /auth/password/forgot` + `/auth/password/reset`, sets the password, receives tokens with no step-up and takes over a finance account; (b) a lower-privileged admin resets a `superadmin`/`finance_manager` via `POST /users/{id}/password/reset` and logs in as them; (c) reset token entropy/TTL/single-use is unspecified, so a captured token is replayed.
- **Impact:** privilege escalation and financial fraud via an account stronger than the attacker's own. **Likelihood:** Medium. **Impact:** Critical. **Score 20 (Critical).**
- **Prevent:** SEC-AUTH-15 — no public forgot/reset endpoints in v1; admin reset requires the dedicated `identity.user.reset_password` permission + step-up + **subset check against the target's effective permissions**; a 32-byte single-use hashed token (15 min TTL, bound to user+device+purpose) delivered only to the user's verified mobile; completion requires token **and** `purpose=password_reset` OTP; success revokes all sessions/devices and bumps `pv`; admin never sees a password.
- **Detect:** `auth.password.reset_requested/completed` audit; alert on any reset of a privileged role; `auth.password.reset.failed` bursts.
- **Residual:** Low.
- **Test:** public endpoints 404; admin cannot reset a higher-privileged user or self; token single-use/TTL; sessions+devices revoked.

### AC-18 · Approval-configuration tampering (AC-7/AC-6) — R1 B-04
- **Preconditions:** approval workflows/thresholds are mutable with a weaker permission than the actions they gate; SoD is enforced only by role templates.
- **Playbook:** `finance_manager` (holding `approval.workflow.manage` and `accounting.journal.*`) edits the workflow to remove the second step or raises the threshold above his journal, then creates and posts it alone; alternatively `setting.update` raises `approval.journal_threshold`, or the actor posts a journal that never enters the approval table (the requester≠approver trigger never sees it).
- **Impact:** large fraudulent postings; maker-checker becomes decorative. **Likelihood:** Medium. **Impact:** Critical. **Score 20 (Critical).**
- **Prevent:** SEC-AZ-16 — config changes require `approval.config.manage` + two-person approval + step-up + 24 h cooling + immutable `data_versions` snapshot; above-threshold journals store a non-null DB-validated `approval_id`; `post_journal()` enforces approver≠requester; disjoint author/post SoD guard; posting rules versioned (`rule_version_id`).
- **Detect:** audit `approval.config.changed` diff; `journal.anomaly` rules; alert if a journal above threshold has no approval id.
- **Residual:** Low.
- **Test:** workflow edit without second approver rejected; 1 bn IRR journal without `approval_id` rejected by DB; self-approval denied.

### AC-19 · Outbound-webhook data exfiltration (AC-6/AC-2) — R1 H-04
- **Preconditions:** an outbound webhook subscription feature whose destination and payload are configurable.
- **Playbook:** any holder of `webhook.outbound.manage` (admin by template) registers `https://attacker.tld/collect`, subscribes to `order.created`/`inventory.changed`/`price.changed`/`settlement.confirmed`, and the worker streams customer PII, order values, stock and cost data out of the ERP with no allowlist or approval.
- **Impact:** mass PII/price/cost exfiltration; competitive and legal damage. **Likelihood:** Low–Medium. **Impact:** Critical. **Score 15 (High).**
- **Prevent:** SEC-IN-16 — seeded destination allowlist (change = two-person config change), outbound payload DTO allowlist with **no cost/margin fields**, step-up on create/update, first-delivery-to-new-host alert, HMAC-signed deliveries, disabled on repeated failures.
- **Detect:** `outbound.webhook.delivery` to a newly approved host; destination-change audit; subscription failure alerts.
- **Residual:** Low.

### AC-20 · Secrets disclosure through container inspection (AC-6/AC-7) — R1 H-11
- **Preconditions:** secrets delivered via `env_file`/container environment and the deploy user has docker sudo (docker access = root).
- **Playbook:** an attacker who compromises the deploy SSH key or is a low-privileged operator with docker access runs `docker inspect api --format '{{.Config.Env}}'`/`docker exec api env`, reads `JWT_ACCESS_SECRET`, `APP_ENCRYPTION_KEY`, `OTP_PEPPER`, `DATABASE_URL`; forges superadmin JWTs, decrypts every channel credential, and reads the DB. No host root required.
- **Impact:** total compromise without exploiting the app. **Likelihood:** Medium. **Impact:** Critical. **Score 20 (Critical).**
- **Prevent:** SEC-CRYPTO-16 — Compose `secrets:`/root-owned 0400 files mounted at `/run/secrets`, loaded once into memory, never in env; `.env` carries only non-secret config; deploy user has **no** docker-root path (rootless docker or a narrowly scoped root-owned systemd unit); docker-group membership documented as root-equivalent; `docker inspect`/`exec env` verification gate in §9. Plus SEC-SC-10 pinning against CI-side secret theft.
- **Detect:** `scripts/verify-host.sh` diff; auditd watch on `/run/secrets` and compose files; alert on `docker exec`/inspect by the deploy user.
- **Residual:** Low (root/rootless-docker compromise remains host compromise — accepted, R-11).

---

## 8. Risk register

Scoring: Likelihood (1 rare … 5 almost certain) × Impact (1 minor … 5 critical). Bands: **Critical ≥ 20**, **High 12–19**, **Medium 6–11**, **Low ≤ 5**.
Treatment: M = mitigate (control), A = accept (documented), T = transfer (contract/insurance), R = roadmap.

| Risk ID | Risk | L | I | Score | Band | Treatment | Owner | Target |
|---|---|---|---|---|---|---|---|---|
| R-01 | Compromise of a superadmin session leads to full system takeover | 3 | 5 | 15 | High | M: SEC-AUTH-05/16/17, SEC-AZ-07/15, SEC-MON-05 | Security Lead | P1 |
| R-02 | Insider manipulates journals/stock for financial fraud | 3 | 5 | 15 | High | M: SEC-DATA-03/04/05/15/16, SEC-AZ-11/16, SEC-AUD-08/09/12 | Finance + Security | P4 |
| R-03 | Credential stuffing against employee accounts | 4 | 4 | 16 | High | M: SEC-AUTH-01/03/13/14, SEC-RL-01/09 | Security Lead | P1 |
| R-04 | Oversell due to allocation race | 2 | 4 | 8 | Medium | M: ADR-0007 + 100-parallel test + non-negative-availability CHECK (R1-accounting B-06) | Backend Lead | P2 |
| R-05 | SSRF via channel URL/config reaching internal services | 2 | 5 | 10 | Medium | M: SEC-IN-06/07/21, network egress policy | Security Lead | P5 |
| R-06 | Webhook forgery/replay creates fraudulent orders | 3 | 4 | 12 | High | M: SEC-IN-11/12/14/17 (Digikala signature still TBD) | Channels Lead | P5 |
| R-07 | Malicious file upload → stored XSS, disk/exhaustion | 3 | 4 | 12 | High | M: SEC-IN-10/18/19, SEC-TLS-07 | Backend + Security | P2 |
| R-08 | Multi-day session theft via refresh replay | 3 | 4 | 12 | High | M: SEC-AUTH-06/09/14/16 | Security Lead | P1 |
| R-09 | Supply-chain compromise of npm/Docker/CI | 2 | 5 | 10 | Medium | M: SEC-SC-01..10; R: signed images | DevOps Lead | P1/P7 |
| R-10 | Backup exfiltration exposing PII and credential material | 2 | 5 | 10 | Medium | M: SEC-CRYPTO-09/10/13/16 | DevOps Lead | P7 |
| R-11 | Host compromise via SSH/docker misconfiguration | 2 | 5 | 10 | Medium | M: SEC-INF-01..11, SEC-CRYPTO-16 | DevOps Lead | P7 |
| R-12 | Unscoped query exposes cross-branch data (no RLS in v1) | 3 | 4 | 12 | High | M: SEC-AZ-04/10/14, SEC-DATA-06; R: RLS profile | Backend Lead | P1 |
| R-13 | PII leak through logs/audit/export/channel archives | 3 | 4 | 12 | High | M: SEC-AUD-07, SEC-CRYPTO-06, SEC-DATA-08, SEC-IN-20 | Security Lead | P1 |
| R-14 | OTP/voice flooding drains paid credit / locks out staff | 4 | 3 | 12 | High | M: SEC-AUTH-04/12, SEC-RL-02/09, one monetary budget | Security Lead | P1 |
| R-15 | Audit trail tampering conceals fraud | 2 | 5 | 10 | Medium | M: SEC-AUD-08/11/12 (`chain_audit()` + verifier), SEC-DATA-05 | Security Lead | P1 |
| R-16 | Single-host failure (disk, ransomware) beyond RPO/RTO | 3 | 4 | 12 | High | M: SEC-INF-10, offsite immutable backup, drill | DevOps Lead | P7 |
| R-17 | **Device-trust forgery defeats MFA** (client fingerprint as authenticator) | 3 | 5 | 15 | High | M: SEC-AUTH-14 (server-issued secret); **High until coded** | Security Lead | P1 |
| R-18 | **Password-reset takeover** (public reset or high-privilege admin reset) | 3 | 4 | 12 | High | M: SEC-AUTH-15 (no public reset; subset check; token+OTP) | Security Lead | P1 |
| R-19 | **Approval-configuration tampering** defeats maker-checker | 3 | 5 | 15 | High | M: SEC-AZ-16, SEC-DATA-15; DB `approval_id` + cooling-off | Finance + Security | P4 |
| R-20 | **Permission-registry drift** (wrong/prefix grants or lockout) | 3 | 4 | 12 | High | M: SEC-AZ-14 (one registry, exact match, bidirectional CI parity); **open dependency D-15 until reconciled** | Security Lead + Backend | P1 |
| R-21 | **Outbound-webhook exfiltration** of PII/cost data | 2 | 5 | 10 | Medium | M: SEC-IN-16 (destination + payload allowlist, step-up, alert) | Security Lead | P5 |
| R-22 | **Secrets exposed via container env** (`docker inspect`; docker access = root) | 2 | 5 | 10 | Medium | M: SEC-CRYPTO-16 (Compose secrets, no docker-root deploy path), SEC-INF-11 | DevOps Lead | P1/P7 |

All risks above have a control mapping and an owner; risks with **residual = Medium** or higher that are only mitigated by process (R-02, R-06, R-09, R-17, R-20) require sign-off in the release gate review and are tracked in `docs/09-roadmap`. Round-1 raised R-17/R-20 to High with an explicit "not mitigated until code exists" qualifier (R1 B-02/B-06); they are not marked mitigated on the strength of the design alone.

---

## 9. Assumptions, exclusions, and open questions

### 9.1 Assumptions
- **AS-01** Production is single-tenant: one organization; `organization_id` scoping is defense-in-depth, not a contractual multi-tenant boundary.
- **AS-02** The admin SPA and API are served same-origin through the edge; no third-party JS is loaded in production (CSP `script-src 'self'`).
- **AS-03** Carexy and Digikala are contractually trusted partners, but their systems may be breached; all inbound data is untrusted input.
- **AS-04** The host is a dedicated bare-metal/VPS (no cloud instance metadata endpoint reachable), Ubuntu 22.04/24.04, admin access over VPN/allowlist.
- **AS-05** No payment-card data is stored in v1 (payments are recorded, not processed); PCI DSS controls are out of scope.
- **AS-06** The SMS provider delivers the OTP only to the intended number; SMS interception is out of our control (accepted risk, mitigated by short TTL + attempt limits).
- **AS-07** Email is not a security-critical channel in v1 (no password-reset-by-email).

### 9.2 Out of scope
Physical access to the server; DDoS beyond upstream provider capacity; provider-side (Digikala/Carexy/Limo) security; employee background checks; full ISO 27001/PCIDSS certification (compliance roadmap in `docs/09-roadmap`).

### 9.3 Open questions
1. **Q1** Does Digikala webhooks provide a documented HMAC signature scheme? If not, is enabling the webhook receiver in production acceptable with IP allowlist + fetch-back only?
2. **Q2** Is SMS OTP the only second factor, or will TOTP authenticator apps be supported for admins (recommended for resilience against SIM-swap and SMS outage)?
3. **Q3** Is there a requirement to expose a customer-facing order-status page (would add an anonymous boundary not modeled here)?
4. **Q4** Which data-residency constraint applies — must backups/PII stay inside Iran? (Affects storage provider and offsite copy.)
5. **Q5** *Resolved in v1.1:* break-glass is **dual-control by default** — offline sealed account + two custodians + out-of-band approval + session-always-checked + action denylist + post-incident review (`SECURITY.md` §2.12, SEC-AUTH-17). A single-custodian "sealed envelope" model is rejected.
6. **Q6** Retention: confirm 10-year retention for accounting records per tax law, which extends `ADR-0009`'s 7-year audit retention (see D-4).
7. **Q7** May the read-only reporting role receive *any* base-table grant for a special export (e.g. a regulator extract)? v1.1 answer: **no** — regulator extracts go through the API as an audited export with `audit.export` + approval, not through `saman_readonly` (R1 H-12).

---

## 10. Cross-document deltas and ADR deviation requests

These must be routed to the owning documents before the design baseline is signed off. They are **requests**, not unilateral changes.

| ID | To | Delta | Reason |
|---|---|---|---|
| D-1 | `ADR-0004` / DATA-MODEL | `auth_sessions` needs `family_id`, `device_id`, `mfa_verified_at`, `ua_hash`, `ip_prefix`, `rotated_from`; `token_hash` unique. `/auth/*` (not only `/auth/refresh`) must verify `Origin` + `X-Requested-With` (login CSRF). OTP verify uses constant-time compare with `OTP_PEPPER`. | §6 TB-1, AC-01/02/14 |
| D-2 | `ADR-0004` | Add **step-up authorization** contract: sensitive actions require `mfa_verified_at` within 15 min and return `403 STEP_UP_REQUIRED`. | AC-03, AC-11, AC-13 |
| D-3 | `ADR-0005` | Add explicit trigger for RLS adoption (second organization onboarded or a cross-scope incident) and an RLS test harness; no change for v1. | R-12 |
| D-4 | `ADR-0009` | Retention: audit/accounting records **10 years** (tax law) rather than 7 years; archive to S3 with manifest. | §AC-13, privacy note SECURITY.md §8.6 |
| D-5 | `ADR-0012` | Add secure CI/CD path (protected branches, image signing, digest pinning, deploy-time verification) to the deployment decision; TLS/HSTS/headers block is normative in `SECURITY.md` §6 and `infra/nginx/`. | TB-6 |
| D-6 | `ADR-0006` | Define webhook signature contract: `X-Saman-Timestamp` + `X-Saman-Signature: v1=…` = HMAC-SHA256(`v1|channel|account|eventId|timestamp|rawBody`); replay store keyed by signed event id; timestamp mandatory; per-account secret table `channel_webhook_secrets`; scheme/header/algorithm compile-time per adapter (not settings). | AC-07, R1 H-03/M-03 |
| D-7 | Reference DDL (`ERP_database_design_v1.sql`) | `api_request_logs.request_body/response_body` must be **removed or always NULL** in production; audit logs must not store secrets/PII. Add `prev_hash char(64)`, `row_hash char(64)`, `hash_seq bigint`, `actor_label` to `audit_logs`. | TB-2, R-13, R-15, R1 B-05 |
| D-8 | `docs/02-data-model` | Add tables required by this model: `channel_webhook_secrets`, replay store (`webhook_deliveries` or Redis-only), `security_events`, `password_history`, `user_devices` (with `device_secret_hash`), `users.locked_until`, `users.permissions_version`, `sms_send_budget` counters, `file_assets.scan_status` + `owner_entity_type/id`, `accounting_period_events`, `crypto_rotation_progress`, seeded vocabulary tables (`audit_actions`, `audit_actor_types`, `audit_results`, `security_event_types`, `otp_challenge_purposes`, `webhook_event_types`). | §3, §6, R1 B-05/M-01/H-06/M-17 |
| D-9 | `docs/03-api-contract` | Add `/auth/*` catalog, session management endpoints, step-up contract, `429`+`Retry-After`, signed webhook headers, machine-client token endpoint; add error codes `STEP_UP_REQUIRED`, `FORBIDDEN_PERMISSION_ESCALATION`, `EGRESS_DESTINATION_NOT_ALLOWED`, `PERIOD_CLOSED`, `PERIOD_MISMATCH`, `SYSTEM_ROLE_IMMUTABLE`, `SMS_BUDGET_EXHAUSTED`, `INVALID_FILE_TYPE`, `IP_NOT_ALLOWED`; remove public password forgot/reset in v1; remove `WEBHOOK_REQUIRE_TIMESTAMP` flag. | TB-1/TB-4, R1 B-03/H-01/H-08/M-03/M-06/L-04 |
| D-10 | `docs/05-testing` | Add the security test set from §7 (one test per abuse case: credential stuffing rate test, OTP attempt exhaustion, 100-parallel allocation, IDOR matrix, SSRF URL fuzz set, webhook signature/replay, upload polyglot set, SQLi parameter fuzz, XSS payload set, role-escalation matrix, backup restore drill) **plus** the round-1 regression tests: device-secret trust (AC-16), reset policy (AC-17), approval config + `approval_id` (AC-18), outbound-webhook allowlist (AC-19), secrets-in-env (AC-20), permission-registry parity, grant-manifest `\dp` diff, audit chain/vocabulary, accounting period/immutability. | §7, §12 |
| D-11 | ADR-0004 + DATA-MODEL | `user_devices.device_secret_hash`; `auth_sessions.device_id NOT NULL`; `deviceFingerprint` is a display label; trust only via server-issued secret cookie (R1 B-02). | TB-1, AC-16 |
| D-12 | API + ADR-0004 | Remove public password forgot/reset (v1); `identity.user.reset_password` + subset check + token+OTP; break-glass = offline two-person (R1 B-03/M-07). | TB-1, AC-17 |
| D-13 | ADR-0008 + DATA-MODEL | `journal_entries.approval_id` NOT NULL above threshold; `data_versions` snapshots; `posting_rule_version_id`; `approval.config.manage`; disjoint author/post SoD (R1 B-04). | TB-2, AC-18 |
| D-14 | DATA-MODEL | Audit hash columns + `erp.chain_audit()` SECURITY DEFINER (EXECUTE-only to worker) + vocabulary lookups + `accounting_period_events` + grant manifest (R1 B-05/M-01/H-12). | TB-2 |
| D-15 | `packages/shared` + API + DATA-MODEL | One machine-readable permission registry; delete duplicate tables; exact matching; reserved keys; bidirectional CI parity (R1 B-06). | TB-1/TB-2, R-20 |
| D-16 | API | Role/scope endpoints: step-up, `FORBIDDEN_PERMISSION_ESCALATION`, subset check incl. target user, pv bump, session revoke (R1 H-01/M-10). | TB-1, AC-11 |
| D-17 | API + DATA-MODEL | Export per-entity permission; `export.read_all`; report `required_permissions[]`; dashboard widget inheritance; closed template enum (R1 H-02/H-09). | TB-1 |
| D-18 | API + channels | Outbound destination allowlist + payload allowlist; compile-time signature scheme; MAC covers event id (R1 H-03/H-04/M-03). | TB-3/TB-4, AC-07/AC-19 |
| D-19 | API + files | Server-mediated uploads; presigned only with POST-policy constraints; `owner_entity_*`; entity-scoped download/404 (R1 H-05/H-06). | TB-5 |
| D-20 | API | Voice/reset/MFA rate tiers, shared attempt counter, fail-closed CAPTCHA, one paid-message budget; machine-client token + CIDR (R1 H-07/H-08/M-06/M-08). | TB-1/TB-7 |
| D-21 | API + channels | Persisted channel payload allowlist (no headers/PII), encrypted 30-day archive, step-up raw view (R1 H-10). | TB-4/TB-5 |
| D-22 | API + infra | Code-declared egress hosts + boot assertion; import/PDF caps; 404 scope rule; internal health endpoints (R1 M-04/M-05/M-09/L-03/L-05). | TB-3/TB-5 |
| D-23 | ADR-0012 + devops | Compose `secrets:` delivery; no docker-root deploy path; edge ports 8080/8443; SHA-pinned CI actions (R1 H-11/L-01/L-02). | TB-6, AC-20 |

---

## 11. Verification and maintenance

| Activity | Frequency | Owner | Evidence |
|---|---|---|---|
| Threat-model review against new boundaries/features | per release + quarterly | Security Lead | updated §5–§8, review notes |
| ASVS L2 review of `SECURITY.md` checklist | pre-release | Security Lead + QA | checklist status update |
| OWASP ZAP baseline + auth scan against staging | every release | QA Lead | CI artifact, no high/critical |
| Dependency/container scanning | every build | DevOps Lead | `security.yml` artifacts |
| Penetration test (external) | before go-live, then annually | Security Lead | report + retest |
| Backup restore drill | quarterly | DevOps Lead | `docs/07-operations/BACKUP-RESTORE.md` checklist |
| Incident tabletop (insider fraud, ransomware, webhook abuse) | twice yearly | Security Lead | postmortem template |
| Key-rotation rehearsal (JWT secret, encryption key) | yearly | DevOps Lead | `SECURITY.md` §5.4 runbook log |

Metrics to track (all exported by SEC-MON-01): mean time to detect (MTTD) security events, count of open high risks, % ASVS L2 items implemented, number of unmitigated threats in this document (target: 0), audit hash-verification failures (target 0), failed webhook signature rate, orphaned active sessions after offboarding (target 0), device-secret mismatch rate, approval-config changes without a second approver (target 0).

---

## 12. Revision log — Round 1

Disposition of R1-security findings that changed this threat model (the full per-finding resolution table, including items handled only in `SECURITY.md`, is `SECURITY.md` §17). Status: **Fixed** = boundary/abuse/risk rows updated with a control reference; **Tracked** = the threat is documented as an open residual with an owner/routing item.

| R1 ID | Threat-model change | Status |
|---|---|---|
| B-01 | §1 evidence rule added (no "verified" without artifact triple); §11 metrics unchanged; phase-status correction routed D-5 | Tracked (Lead Architect) |
| B-02 | New abuse case AC-16; TB-1 T1-S3 strengthened; risk R-17 (High until coded); D-11 | Fixed |
| B-03 | New abuse case AC-17; TB-1 T1-S4; risk R-18; D-12 | Fixed |
| B-04 | New abuse case AC-18; TB-2 T2-E3; TB-2 R2 (`accounting_period_events`); risk R-19; AC-13 strengthened; D-13 | Fixed |
| B-05 | TB-2 T2-T1 strengthened (`chain_audit()` + verifier + vocabulary); AC-13 prevention; D-7/D-14 | Fixed |
| B-06 | Risk R-20 (High, open dependency D-15); TB-1/TB-2 control refs; D-15 | Tracked (API/DATA reconciliation) |
| H-01 | TB-1 T1-E4; AC-11 strengthened; R-01/R-12 treatment; D-16 | Fixed |
| H-02 | §1 threat list + TB-2/TB-5 ref; R-13; AC-11/AC-13 detection refs; D-17 | Fixed |
| H-03 | TB-4 T4-S1/T4-S2 strengthened; AC-07 prevention; D-18 | Fixed |
| H-04 | New abuse case AC-19; TB-3 T3-I3; risk R-21; D-18 | Fixed |
| H-05 | TB-5 T5-D1 strengthened; AC-08 prevention; R-07; D-19 | Fixed |
| H-06 | TB-5 T5-I3; risk R-13; D-19 | Fixed |
| H-07 | AC-01 prevention/detect (ASN, per-IP window); TB-1 T1-D1; D-20 | Fixed |
| H-08 | TB-1 T1-D3; TB-7 T7-D1 strengthened; AC-02 prevention; R-14; D-20 | Fixed |
| H-09 | §1 threat list; TB-1 exit controls; R-13; D-17 | Fixed |
| H-10 | TB-4 T4-I1 + TB-5 refs; R-13; D-21 | Fixed |
| H-11 | New abuse case AC-20; TB-6 T6-I1 strengthened; risk R-22; asset A-07/A-15 wording; D-23 | Fixed |
| H-12 | TB-2 T2-I4; risk R-02/R-15 treatment; D-14 | Fixed |
| M-01 | TB-2/TB-7 OTP-purpose + event-vocabulary refs; D-8/D-14 | Fixed |
| M-02 | TB-1 T1-T2 idempotency control note; D-8 | Fixed |
| M-03 | TB-4 T4-S2 strengthened; AC-07 prevention; D-18 | Fixed |
| M-04 | AC-08 prevention (import caps); TB-5/TB-7 refs; D-22 (routed) | Fixed |
| M-05 | AC-06 prevention; TB-3 T3-E2; risk R-05; D-22 | Fixed |
| M-06 | TB-1/TB-3 control refs; D-20 (machine clients are a new actor class in TB-1) | Fixed |
| M-07 | TB-1 T1-E5; AC-20 ref; §9.3 Q5 resolved | Fixed |
| M-08 | TB-7 T7-E1 strengthened; §7 AC-02; D-20 | Fixed |
| M-09 | AC-05 prevention/detect (404 rule); TB-1 T1-I1; D-22 | Fixed |
| M-10 | TB-1 T1-E4; AC-11 prevention; D-16 | Fixed |
| L-01 | TB-6 T6-E4; R-09 treatment; D-23 | Fixed |
| L-02 | TB-6 T6-E5; D-23 | Fixed |
| L-03 | TB-1 baseline (headers single-source); D-22 | Fixed |
| L-04 | TB-1 T1-E4/T1-S1 (jti revocation); AC-14 prevention | Fixed |
| L-05 | TB-1/TB-4 baseline (health internal); D-22 | Fixed |
| R1-accounting B-04/B-09/B-16/H-11/H-12/M-17 | TB-2 T2-T1/T2-R2; AC-13 prevention; asset A-08/A-09 integrity note; risk R-02/R-19 | Fixed (security-integrity part; domain fixes remain with accounting owner) |

**New assets/entry points:** machine API clients are explicitly modeled under TB-1/TB-3 (client-credentials token, `allowed_cidrs`, `actor_type=api_client`); outbound webhook subscriptions are modeled under TB-3 (`T3-I3`) and as abuse case AC-19; the device cookie is modeled under `A-02` (session material). No new trust boundary was added — every round-1 finding maps to an existing boundary, which is itself a review conclusion: the boundary model was sound, the controls inside it were not.
