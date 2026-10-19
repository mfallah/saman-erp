# 05 — Testing Strategy, Acceptance Criteria & Load Profiles

Status: **v1.1-revised — round-1 remediation (1405-07-27)** · Owner: QA/Test Architect · Last updated: 1405-07-27
v1.0-draft was accepted and frozen; v1.1 adds the round-1 remediation test set (§21) in response to
`docs/_review/round-1/R1-accounting.md` and `R1-security.md`, and records the resulting amendments
to Lead decisions (§20). The v1.0 test matrix is preserved — affected cases are marked **†R1** and
listed in §21.4; new cases live in §21.
Applies to: `apps/api`, `apps/worker`, `apps/web`, `packages/*` · Release gate: overview `README.md` §7.

This document is the single source of truth for *how correctness is proven*. It defines the test
pyramid, the test environment contract, every named test that guards a business invariant, the
numeric performance envelope, the security test plan, and the CI gates that turn all of it into a
merge/release decision.

Entity names used below are the ADR-level names (`inventory_balances`, `stock_reservations`,
`journal_entries`, `outbox_events`, …). When `docs/02-data-model/DATA-MODEL.md` settles a different
physical name, the **test ID stays stable** and the fixture factory (`apps/api/test/factories/`)
is the only place that maps a logical name to a table — tests never contain hand-written table
names twice.

---

## 1. Quality objectives (what a green suite must prove)

| # | Objective | Proven by |
|---|---|---|
| Q1 | No overselling, ever, under 100 parallel allocators | `C-ALLOC-01`, `INV-03`, `INV-04`, k6 `allocation-race.js` |
| Q2 | Stock mutations only through the ledger; `on_hand = Σ ledger` always | `U-INV-01…12`, `INV-01`, `INV-02`, nightly invariant job |
| Q3 | Every posted journal balances (debit = credit, per entry and per period) | `U-ACC-01`, `INV-06`, `I-ORD-01`, `I-TRS-01` |
| Q4 | Corrections are reversals — nothing financial is mutated or deleted | `U-ACC-05/06`, `INV-07`, `I-ACC-01` |
| Q5 | No money value ever touches a float or exceeds `bigint` range | `U-MON-01…08`, `PROP-MON-01` |
| Q6 | Every route is permission-guarded; default-deny enforced statically | `SEC-AC-01…06`, `CT-PERM-01` |
| Q7 | Tenant/scope isolation: no cross-org or cross-branch data leak | `SEC-AC-07/08`, `INV-12` |
| Q8 | At-least-once delivery never becomes a duplicate business effect | `U-CHN`, `C-OBX-01`, `I-OBX-01`, `I-CHN-04` |
| Q9 | Design envelope met with headroom: 20 orders/s, 1,000 concurrent reads | `LOAD-02`, `LOAD-03`, thresholds in §12 |
| Q10 | Release installs and restores on a clean host | `REL-01`, `REL-02`, `REL-03` |
| Q11 | Books are auditable: every event posts balanced, VAT separately stated, CoA exact, closing/opening correct | §21.1/§21.2/§21.6, `CT-POST-01`, `CT-COA-01`, `I-CLS-01` |
| Q12 | No documented R1 finding is unproven: design defects have named regression tests | §21.12/§21.13 traceability tables |

Non-objectives for v1: multi-tenant RLS certification, browser-matrix beyond Chromium/Firefox/WebKit,
mobile native apps, Digikala endpoints marked `TBD-DIGIKALA` (explicitly out of the test contract,
`ADR-0006` §6).

---

## 2. Test pyramid, tooling & gates

| Layer | Tool / runner | Scope | Count target | Wall-clock budget | Required gate |
|---|---|---|---|---|---|
| Static | ESLint (incl. custom `saman/*` rules), `tsc --noEmit`, Prettier check | architecture rules, no ambient clock, no unscoped select, no float money, route permission decorator | — | ≤ 3 min | every PR |
| Unit | **Vitest 3** (node project + jsdom project), `fast-check` for properties | pure domain: money, pricing, valuation, allocation math, accounting rules, calendar, state machines, guards | **≥ 356** | ≤ 2 min | every PR, blocks merge |
| Integration | Vitest + **Supertest** + **Testcontainers** (PostgreSQL 16, Redis 7, MinIO) | real SQL, real transactions, real migrations, concurrency, HTTP contract | **≥ 101** | ≤ 9 min (4 workers) | every PR, blocks merge |
| Contract | Vitest + OpenAPI snapshot + `oasdiff` + Zod | route↔permission↔OpenAPI consistency; no breaking change | **≥ 22** | ≤ 2 min | every PR |
| Security | Vitest/Supertest security project, Semgrep, Gitleaks, `pnpm audit`, Trivy, OWASP ZAP baseline | OWASP ASVS L2 controls (§13, §21.11) | **≥ 79** | ≤ 9 min static, ZAP ≤ 15 min (nightly) | PR (static) + nightly (DAST); blocks release |
| E2E | **Playwright** (Chromium/Firefox/WebKit, 5 device projects) | user journeys, RTL, a11y, scanner flows | **26 specs** (14 smoke) | ≤ 10 min smoke | smoke blocks merge to `main`; full nightly |
| Load | **k6** (6 scripts) | throughput/latency/soak envelope | 6 profiles | nightly 45 min, weekly soak 4 h | blocks release |
| Invariants | SQL invariant harness (`scripts/invariants.ts`) | cross-table consistency | **18 checks** | ≤ 60 s | after every integration shard + nightly against staging |
| Release | Compose smoke + backup/restore rehearsal | installation, migrations, restore | 3 rehearsals | ≤ 40 min | blocks release tag |

Total automated test cases (minimum, v1.1): **356 unit + 101 integration + 22 contract + 79 security + 26 E2E = 584**, plus 18 invariant checks, 12 property-based properties, 19 concurrency cases and 6 load profiles.

**Pyramid percentages (enforced by review):** unit ≥ 60 %, integration ≈ 17 %, security ≈ 13 %, contract + E2E ≈ 8 % of cases. No business rule may be covered *only* by E2E.

**Rule of mocking:** unit tests may mock collaborators; integration tests never mock the database, the transaction manager, or repositories. Only system boundaries are doubled: clock, SMS HTTP, channel HTTP, S3 network (MinIO may be real), e-mail. A `vi.mock()` that replaces a repository in `apps/api/test/integration/**` fails review.

---

## 3. Repository layout & test-ID scheme

```text
apps/api/
  vitest.config.ts                     three projects: unit, integration, security
  src/modules/<module>/*.spec.ts       co-located unit tests (fast, no I/O)
  src/engines/*.spec.ts                valuation/pricing/accounting engines
  test/
    setup/unit.ts                      unit env, fake clock helpers
    setup/integration.ts               Testcontainers bootstrap, per-worker DB
    setup/security.ts
    factories/                         deterministic builders (§4.7)
    fixtures/                          JSON channel payloads, CoA seed, RBAC matrix
    helpers/                           auth token minting, HTTP client, invariant harness
    integration/<domain>/*.int.spec.ts
    security/*.spec.ts
    contract/*.spec.ts
    invariants/*.spec.ts
apps/web/
  src/**/*.spec.tsx                    Vitest + Testing Library (jsdom project)
  e2e/*.spec.ts                        Playwright, tagged @smoke / @regression
  playwright.config.ts
packages/shared/src/**/*.spec.ts       money, calendar, permissions, Zod schemas
infra/k6/                              smoke.js load.js stress.js soak.js spike.js allocation-race.js
scripts/invariants.ts                  standalone invariant runner (CI + nightly + operator tool)
.github/workflows/                     ci.yml, nightly.yml, release.yml
```

**Test IDs** are permanent and referenced from acceptance criteria (§17) and ADR traceability (§18):

| Prefix | Meaning | Example |
|---|---|---|
| `U-<DOM>-nn` | unit | `U-VAL-07` |
| `C-<DOM>-nn` | concurrency/race (integration project) | `C-ALLOC-01` |
| `I-<DOM>-nn` | integration scenario | `I-ORD-01` |
| `CT-<DOM>-nn` | contract | `CT-PERM-01` |
| `SEC-<DOM>-nn` | security/ASVS | `SEC-AC-03` |
| `E2E-SM-nn` / `E2E-RG-nn` | Playwright | `E2E-SM-06` |
| `INV-nn` | cross-table invariant | `INV-01` |
| `PROP-<DOM>-nn` | property-based | `PROP-INV-01` |
| `LOAD-nn` | k6 profile | `LOAD-02` |
| `REL-nn` | release rehearsal | `REL-02` |
| `U-COA-nn` / `U-PAY-nn` | unit domains added by R1 (chart-of-accounts manifest, payments/cash) | `U-COA-01`, `U-PAY-03` |
| `U-ACC-nn` ≥ 27, `U-INV-nn` ≥ 19, `U-TRS-nn` ≥ 17, `U-MON-nn` ≥ 14, `U-CAL-nn` ≥ 19, `I-*-nn` ≥ 02, `SEC-*-nn` ≥ 07, `INV-nn` ≥ 17, `PROP-*-nn` ≥ 03 | R1 remediation continuum — allocated only by §21 (never renumbered) | `U-ACC-27`, `SEC-AC-09` |

Test titles must start with the ID: `it('U-VAL-07 backdated receipt does not rewrite posted COGS', …)`.

---

## 4. Test environment & bootstrap

### 4.1 Runtime matrix

| Layer | PostgreSQL | Redis | S3 | Channels | SMS | Clock |
|---|---|---|---|---|---|---|
| Unit | none | none | none | fakes | fake | fake (`TestClock`) |
| Integration | real PG 16 container | real Redis 7 container | MinIO container | `mock` adapter + MSW | stub adapter | `TestClock` (controllable) |
| Security | real PG 16 | real Redis 7 | MinIO | mock adapter | stub | real (rate windows use Redis) |
| E2E | compose `postgres` | compose `redis` | compose `minio` | mock + preloaded fixtures | `SMS_MODE=mock` | real |
| Load/staging | managed/compose PG 16 | compose Redis 7 | MinIO | mock adapter | `SMS_MODE=mock` | real |

Test environment env file (`apps/api/test/.env.test`, committed, **no secrets**):

| Variable | Value | Purpose |
|---|---|---|
| `APP_ENV` | `test` | disables docs, verbose errors, enables deterministic IDs |
| `DATABASE_URL` | injected by Testcontainers | per-worker DB |
| `REDIS_URL` | injected | DB index per worker |
| `S3_ENDPOINT` / `S3_BUCKET` | injected / `saman-test-<worker>` | isolated bucket |
| `SMS_MODE` | `mock` | never sends |
| `CHANNEL_MODE` | `mock` | no egress |
| `JWT_ACCESS_TTL` | `600` | fixed for assertions |
| `OTP_TTL_SECONDS` | `120` | fixed |
| `RESERVATION_CHANNEL_TTL_MINUTES` | `120` | fixed for assertions; per-channel override allowed |
| `RESERVATION_MANUAL_TTL_MINUTES` | `1440` | fixed for assertions; manual/POS orders (24 h) |
| `OUTBOX_MAX_ATTEMPTS` | `10` | fixed |
| `LOG_LEVEL` | `silent` | CI signal |

CI guard: if `APP_ENV !== 'test'` and a destructive truncate/reset helper is imported, the bootstrap **throws** before opening a connection.

### 4.2 PostgreSQL: one container, one database per worker

- `apps/api/test/setup/integration.ts` starts **one** `postgres:16-alpine` container per Vitest *run* in `globalSetup` (`tmpfs: /var/lib/postgresql/data`, `fsync=off`, `max_connections=200`, `shared_buffers=256MB`), then creates database `saman_test_template` and applies all migrations once.
- Each Vitest worker (`maxWorkers: 4` locally, `2` in CI; `minWorkers` equal) clones `<template>` into `saman_test_w<workerId>` using `CREATE DATABASE … TEMPLATE …` (~200 ms). Bootstrapped DB names are cached per process; worker teardown drops them.
- `statement_timeout` is set to `10000` in test DB to catch runaway queries (same semantics class as the 5 s API role), except migration tests.
- Each test file gets a transaction-free scratch state: `resetToSeed()` truncates business tables in FK-safe order and reloads the system seed (roles, permissions, CoA, units, channels, settings). Reservation/outbox/partition tests opt into `resetDatabase()` (full) because they assert sequence/partition state.
- Every integration test ends with `assertInvariants(tx)` on the 16 global invariants (§9) unless it declares `@skip-invariants` with a reason.
- Parallel-safety: no test may assume a global ID value; no `nextval` assertions except in the numbering suite, which runs with `fileParallelism: false` in its own project.

**Migration suite (`I-ENV-01`):** from an empty database, `pnpm db:migrate` applies all migrations; schema hash recorded. `I-ENV-02`: `pnpm db:seed` twice is idempotent (row counts identical, no duplicate permission/role/CoA rows). `I-ENV-03`: `pnpm db:reset` returns to seed and the invariant suite passes. `I-ENV-04`: `drizzle-kit generate` produces **zero** diff against committed migrations (schema-drift test); a non-empty diff fails CI. Each migration file is applied in lexical order and is re-runnable only through `reset`, never edited after merge.

### 4.3 Redis

- One `redis:7-alpine` container per run; each worker uses database index `workerId` (`REDIS_URL=redis://…/0`, `/1`, …).
- `afterEach`: `FLUSHDB` is too destructive for BullMQ tests that inspect queue state; instead use key-prefix namespaces `test:w<id>:<suite>:*` and delete by prefix. Queue tests create their own queue name `test<uuid>` and `obliterate()` on teardown.
- Redis-down behaviour test (`I-ENV-05`): stop container mid-request → rate limiting falls back to in-memory, cache bypassed, writes continue (`ADR-0010`, architecture §13).

### 4.4 S3 / MinIO

- Real `minio/minio` container; bucket `saman-test-<worker>` created by setup; object keys asserted, not content hashes, except upload pipeline tests that assert byte equality for labels/exports.
- File tests cover: magic-byte rejection (a `.jpg` that is a ZIP), 413 above `MAX_UPLOAD_MB` (default 10 MB), content-disposition header, presigned URL TTL (600 s) and no public-read ACL (`ADR-0006`, architecture §10).

### 4.5 External channels & SMS

- `mock` channel adapter is the only adapter allowed in tests; Carexy/Digikala adapters have **unit tests against recorded fixtures** (`apps/api/test/fixtures/channels/{carexy,digikala}/*.json`) with HTTP doubled by MSW — no test ever reaches the internet.
- Egress guard (`CT-EGRESS-01`): MSW `onUnhandledRequest: 'error'` in integration/security projects; a test that attempts an undeclared outbound call fails.
- `SMS_MODE=mock` writes to a captured sink; assertion helpers `sms.lastOtp()` and `sms.outbox()`; the mock sink is truncated per test. **A test asserts that in `APP_ENV=production` the mock provider refuses to boot** (`SEC-CFG-04`).
- Digikala endpoints marked `TBD-DIGIKALA` must not be called in production; test `SEC-CHN-06` asserts adapter feature flags block them and that the flag is surfaced in `/health/version`.

### 4.6 Deterministic data

- `faker.seed(42)` once per worker; all IDs/timestamps derive from a per-test counter (`resetFactories()` in `beforeEach`), so a failing test reproduces with the same data.
- Factories (`apps/api/test/factories/`): `org()`, `user({role})`, `warehouseTree()`, `product({variants})`, `inventoryBalance()`, `stockMovement()`, `salesOrder()`, `journalEntry()`, `cheque()`, `channelAccount()`. Every factory returns `{ entity, persist(tx?) }`; builders are chainable (`.withLines(3)`).
- `seedSystem()` creates the immutable reference set exactly once per DB: 8 roles, permission catalogue from `packages/shared/permissions.ts`, Iranian 6-level CoA, units/UoM, document types, default settings, mock channel account. Tests that change seeds run in `apps/api/test/integration/seed/`.
- No test may depend on wall-clock `now()`; see §4.7. No test may rely on `ORDER BY created_at` ties — factories assign strictly increasing fake time.
- Performance rule: integration suites use bulk factories (`persistMany`) with one INSERT per 500 rows; a single test persisting > 5,000 rows belongs in the load-seeding path, not the PR suite.

### 4.7 Clock control

- Domain code receives `Clock` via DI: `interface Clock { now(): Date; today(): Date /* business date, Asia/Tehran */ }`. `TestClock` is a mutable implementation: `clock.set('2026-01-15T10:00:00+03:30')`, `clock.advance({minutes: 31})`.
- Unit tests use `TestClock` only (never `vi.useFakeTimers()` for domain logic); timer-dependent jobs use `vi.advanceTimersByTimeAsync`.
- ESLint custom rule `saman/no-ambient-clock` bans `new Date()` / `Date.now()` in `apps/api/src/modules/**` and `packages/shared/src` business code; the rule has its own test (`U-MON-09`).
- Time-zone tests run under `TZ=Asia/Tehran` and a second matrix leg `TZ=UTC` for the API to prove calendar boundaries do not depend on process TZ. Both legs are required in CI (matrix `tz: [Asia/Tehran, UTC]` for the `unit` and `integration` jobs).

---

## 5. Coverage & quality budgets

| Subject | Metric | Threshold | Enforced |
|---|---|---|---|
| Global API | lines / branches | ≥ 70 % / ≥ 65 % | CI (fails under) |
| `apps/api/src/modules/**/services` + `src/engines` | lines / branches | ≥ 85 % / ≥ 80 % (`ARCHITECTURE.md` §15 requires ≥ 80 % lines) | CI |
| `packages/shared/src/money.ts`, `calendar.ts`, allocation engine, posting engine, numbering | lines / branches | **≥ 95 % / ≥ 90 %** | CI |
| Changed lines in a PR | diff coverage | ≥ 85 % | CI comment + fail |
| Mutation testing (Stryker, nightly, engines only) | mutation score | ≥ 60 % | nightly report, trend tracked |
| Web components | lines | ≥ 60 % | CI |
| Skipped tests | count | 0 in required jobs (quarantine excluded, listed in report) | CI |
| Flaky rate | failing-then-passing runs / total | ≤ 1 % of runs per week | weekly report |

No `--passWithNoTests`, no `test.only`, no conditional `test.skip` without a `QUAR-<n>` issue tag. A skipped test is reported by a custom Vitest reporter and counted as a failure in required jobs.

---

## 6. Unit test matrix (named cases)

Minimum counts per area are listed; the sum of §6 is the **300** v1.0 unit target, and §21 adds
**56** R1 remediation unit cases for the v1.1 total of **356** (§2, §21.14). Paths are co-located
`src/**/*.spec.ts` unless stated.

### 6.1 Money, precision & property arithmetic — 22 cases (`packages/shared/src/money.spec.ts`)

| ID | Named case | Assertion |
|---|---|---|
| `U-MON-01` | serializes and parses IRR as string | `parseMoney("12500000") === 12500000n`; number input rejected by `MoneyString` Zod |
| `U-MON-02` | bigint overflow guard on add/mul | `add(2n**63n-1n, 1n)` throws `MONEY_OVERFLOW`; `mul(MAX, 2n)` throws before allocation |
| `U-MON-03` | rejects unsafe JS number and float input | `parseMoney(12500000.5)`, `parseMoney(Number.MAX_SAFE_INTEGER+1)` → `VALIDATION_ERROR` |
| `U-MON-04` †R1 | HALF_UP rounding at boundary | `round(0.5)=1`, `round(1.5)=2`, `round(2.5)=3`, `round(-0.5)=-1`, `round(4999/1000)=5`, `round(0.4999)=0` (money.ts is the only rounding point); invoice net/tax/gross each rounded once (see `U-MON-23…27`, R1 B-12/M-21) |
| `U-MON-05` | rate application keeps full precision until boundary | `applyRate(1_234_567n, 0.09)` = 111,111.03 → rounds only at invoice/tax call site |
| `U-MON-06` †R1 | tax rounding half-up | VAT 10 % on 1,234,567 → 123,457; on 1,234,565 → 123,457 (both directions tested); tax computed on `net_amount` after discounts, never on a tax-inclusive gross (R1 B-12) |
| `U-MON-07` | rejects negative amount where domain forbids | `MoneyString.positive()` rejects 0/negative for price/amount fields; refund accepts negative delta only via credit note |
| `U-MON-08` | JSON never emits `number` for money | serialized DTO snapshot: every money field is `typeof "string"` (recursive walker) |
| `U-MON-09` | no ambient clock lint rule | lint fixture with `new Date()` in a module fails; clean file passes |
| `U-MON-10` | numeric quantity scale | `numeric(18,4)` round-trip: `1.23456` rejected at DTO, `1.2345` accepted, sum of 4-dp quantities exact |
| `U-MON-11` | no float SQL column | schema snapshot asserts zero `real`/`double precision`/`float` columns in `erp` |
| `U-MON-12` | currency guard | document with `currency !== base` rejected `VALIDATION_ERROR` (ADR-0013) |
| `U-MON-13…22` | table-driven edge set | ±2^53 boundaries, zero, 1, 10^12, mixed rate precision, `formatFa` digits only at render, parse/format round-trip, `sub` underflow, `sum` of mixed scales, idempotent `round(round(x))` |

### 6.2 Pricing engine — 24 cases (`apps/api/src/engines/pricing.spec.ts`)

Canonical formula under test (all inputs `bigint`/`numeric`, rates `numeric(9,6)`):

```text
cost            = weighted cost or supplier landed cost (vendor, IRR)
base            = cost × (1 + markup_percent/100)              // markup, not margin
with_fees       = base + channel_fixed_fee
net_of_fee      = with_fees / (1 - commission_percent/100)     // gross-up so seller nets base+fee
price           = round_half_up(net_of_fee / price_rounding_step) × price_rounding_step   // default step 1,000 IRR
tax             = round_half_up(price × vat_percent/100)       // VAT on final price
final           = price + tax
effective_margin= (price × (1 - commission_percent/100) - cost) / price × 100
```

| ID | Named case | Assertion |
|---|---|---|
| `U-PRC-01` †R1 | base + markup + channel fees produce final price | cost 1,000,000; markup 20 %; fee 50,000; commission 10 % → base 1,200,000; grossed-up 1,388,889; rounded to 1,389,000; final price feeds invoice `unit_price` with separate net/tax/gross (R1 B-01/B-12) |
| `U-PRC-02` | commission gross-up direction is correct | higher commission ⇒ higher final price; `(final×0.9) - fee ≥ base` |
| `U-PRC-03` | fixed fee per channel is applied once per line, not per unit | qty 3, fee 50,000 → one fee; per-order fee variant tested separately |
| `U-PRC-04` | VAT applied on final price, not on cost | `final = price + 10 %`; snapshot line total = qty × final |
| `U-PRC-05` †R1 | **margin guard rejects** price below `min_margin_percent` | cost 1,000,000, commission 15 %, min margin 12 % → `RULE_VIOLATION PRICE_BELOW_MARGIN` with computed margin in details; guard evaluates net-of-commission and net-of-VAT revenue, not tax-inclusive gross (R1 B-01) |
| `U-PRC-06` | margin guard boundary is inclusive/exclusive as specified | margin == min passes; margin < min by 0.000001 fails |
| `U-PRC-07` | rounding step respected | price 1,388,889 → 1,389,000 (step 1,000); step 0 disables rounding |
| `U-PRC-08` | discount/ladder rule applied before margin guard | tier discount 5 % → guard evaluates discounted price |
| `U-PRC-09` | channel-specific tax/commission overrides | Digikala 12 % vs own-site 0 % produce expected split |
| `U-PRC-10` | no float leakage | intermediate values are bigint/decimal; snapshot of engine trace has no float |
| `U-PRC-11` | price calculation run is deterministic and snapshotted | same inputs same run key → byte-identical snapshot; changing rule bumps version |
| `U-PRC-12` | zero/negative markup rejected | `markup = -1`, `commission = 100`, `fee < 0` → `VALIDATION_ERROR` |
| `U-PRC-13…24` | table-driven boundaries | commission 0/2/12 %, markup 0/1/500 %, VAT 0/9/10 %, fee 0/1, rounding 1/1,000/10,000, cost 0 (free sample), qty 4-dp, mixed products, rule precedence (list → channel → campaign), price rule activation requires approval (`ADR-0008` §5), expired campaign ignored |

### 6.3 Inventory ledger & valuation — 18 cases (`apps/api/src/engines/valuation.spec.ts`, `.../inventory/*.spec.ts`)

**Decision (§20-D2):** valuation method is a **company-wide setting** `inventory_valuation_method`
(`fifo` default | `weighted_average`); FIFO layers are keyed per `(warehouse_id, variant_id)`;
`inventory_valuation_runs` aggregates per variant for accounting. Both methods are tested on the
same fixture, including backdated receipt and the negative-layer edge.

| ID | Named case | Assertion |
|---|---|---|
| `U-INV-01` | ledger row is append-only | repository exposes no `update`/`delete` for `inventory_transactions`; direct SQL UPDATE of `quantity` fails (trigger/permission) — `C-INV-02` covers at DB level |
| `U-INV-02` †R1 | balance projection equals ledger sum (unit-level) | given movements, `on_hand = Σ signed qty`; **`available = on_hand - reserved - safety_buffer - damaged` and `available ≥ 0`** (R1 B-06; see `U-INV-26`, `INV-18`) |
| `U-INV-03` | FIFO consumes oldest layer first, partial layer allowed | layers (5 @100, 10 @150, 20 @200), issue 8 → 5×100 + 3×150 = 950; remaining layer @150 = 7 |
| `U-INV-04` | FIFO skips empty/zero-remaining layers | layer with 0 remaining ignored; issue cost from next layer |
| `U-INV-05` | FIFO insufficient stock is rejected atomically, no negative layer | asking more than layers → `RULE_VIOLATION INSUFFICIENT_STOCK`; **no layer's `qty_remaining` or `cost_remaining` becomes negative** (negative-layer edge) |
| `U-INV-06` | weighted average recalculated on every receipt | 10 @100 + 10 @200 → avg 150; issue 5 → COGS 750; new receipt 10 @300 → avg 200 |
| `U-INV-07` | **backdated receipt** does not rewrite a posted COGS | issue posted on day 20; receipt with `received_at` day 10 → posted COGS unchanged, `inventory_valuation_runs` line proposes adjustment delta, adjustment journal posted only after approval; same case re-run under each valuation method |
| `U-INV-08` | valuation run snapshot is immutable and reproducible | run once, rerun with same `as_of` → same totals; run snapshot rows never updated; runs aggregate per variant across warehouses |
| `U-INV-09` | negative stock rejected at service and DB layers | service rejects with `RULE_VIOLATION`; direct SQL `on_hand = -1` violates `ck_inventory_balances_non_negative` |
| `U-INV-10` †R1 | safety buffer and damaged reduce available but not on_hand | buffer 5 + damaged 3, on_hand 20, reserved 0 → available 12; channel push sends 12; CHECK `reserved + safety_buffer + damaged <= on_hand` holds (R1 B-06) |
| `U-INV-11` | transfer moves stock with in-transit state | issue from A creates in-transit, receipt into B clears it; total company on_hand unchanged during transit |
| `U-INV-12` | unit/serial traceability | tracked unit cannot be in two locations; replaying same barcode movement rejected; untracked SKU gets no `inventory_units` rows |
| `U-INV-13` | adjustment writes ledger + reason + approval | adjustment above threshold creates approval; no silent balance edit |
| `U-INV-14` | lot expiry blocks issue | expired lot excluded from allocation; FEFO setting tested |
| `U-INV-15` | valuation method is a company-wide setting | `inventory_valuation_method ∈ {fifo (default), weighted_average}`; both methods run on identical data yield different COGS; method change requires approval (§20-D2) |
| `U-INV-16` | ledger FK/dimension integrity | every ledger row references valid variant/warehouse/location/source document; orphan insert fails FK |
| `U-INV-17` | void is metadata only | `voided_at` set, row and qty untouched; reversal row created instead |
| `U-INV-18` | nightly reconciliation job | `Σ ledger` vs balance drift injected → job reports exact `(warehouse, variant)` delta and alerts; no auto-fix |

### 6.4 Reservations & allocation — 20 cases (`apps/api/src/modules/fulfillment/*.spec.ts`, `.../inventory/allocation*.spec.ts`)

**Decision (§20-D1):** the `fulfillment` module owns the reservation lifecycle; a `maintenance`
queue job runs **every 5 min** and expires stale reservations. Defaults: channel orders **120 min**
(per-channel override), manual/POS orders **1440 min** (24 h). Expiry emits `reservation.expired`
→ release + audit. Boundary-at-TTL and idempotent-release tests are mandatory.

| ID | Named case | Assertion |
|---|---|---|
| `U-RES-01` | all-or-nothing per order | 3 lines, line 3 short by 1 → **zero** reservations and zero `reserved` increments |
| `U-RES-02` | multi-warehouse split picks by configured priority | warehouse A short, B has stock → lines split; single order stays one allocation record |
| `U-RES-03` | available computed per channel with buffer | channel buffer 2: channel sees `on_hand - reserved - 2` |
| `U-RES-04` | reservation status machine | only `active → consumed/released/expired` legal; reverse transitions throw `CONFLICT` |
| `U-RES-05` | release is idempotent | double release leaves `reserved` unchanged the second time; cancel + expiry racing release is a no-op for the loser |
| `U-RES-06` | consumed decreases on_hand and reserved together | ship consume: on_hand −qty, reserved −qty, available unchanged; ledger row written |
| `U-RES-07` | expiry restores availability exactly once | channel reservation at `TTL−1 s` still active and at `TTL+1 s` expired; `reservation.expired` emitted; `reserved` decremented; second expiry run no-op; maintenance job cadence 5 min asserted from schedule registration |
| `U-RES-08` | expiry vs consume race — exactly one wins | consume at ttl−1 ms and expiry job → one terminal state, no double decrement |
| `U-RES-09` | over-release cannot drive reserved negative | CHECK violation impossible; service clamps and logs metric |
| `U-RES-10` | reservation TTL resolution | channel order → 120 min, per-channel override honored; manual/POS order → 1440 min; settings read via repository, not hardcoded (§20-D1); test with 1 min override |
| `U-RES-11` | allocate idempotent by order id | second allocate for same order returns existing reservation, no double reserve |
| `U-RES-12` | lock order prevents deadlock (multi-variant) | two orders with variants [A,B] and [B,A] complete; retry counter 0–3, no deadlock error surfaced |
| `U-RES-13` | insufficient stock error lists per-line availability | `details.lines[]` with `requested/available/shortage`; HTTP 409 `RULE_VIOLATION` |
| `U-RES-14` | allocation order for waves respects priority/FIFO order date | allocation order deterministic and documented |
| `U-RES-15` | safety buffer + reservation interaction | reservation cannot consume buffer |
| `U-RES-16` | cancel order releases all active reservations | release count = line count; idempotent |
| `U-RES-17` | partial shipment consumes only shipped lines | remaining reservation still active, expiry still applies |
| `U-RES-18` | stale allocation cleanup safety net | order cancelled before pick → released on cancel event; an orphaned active reservation is expired by the 5-min maintenance job and audited |
| `U-RES-19` | reservation audit | every state change writes `audit_logs` actor + reason |
| `U-RES-20` | manual reservation (sales hold) expiry | hold released on TTL, stock visible again |

### 6.5 Accounting — 26 cases (`apps/api/src/engines/posting.spec.ts`, `.../accounting/*.spec.ts`)

| ID | Named case | Assertion |
|---|---|---|
| `U-ACC-01` | journal debit equals credit | any imbalance → `JOURNAL_UNBALANCED`; sum lines = 0 within transaction |
| `U-ACC-02` †R1 | posting rules map business events to accounts | sale → Dr AR (gross), Cr revenue (net), Cr VAT payable (tax), Cr shipping revenue, Dr COGS, Cr inventory; COGS at stock issue, never at invoice (R1 B-01/B-10; full matrix in §21.1) |
| `U-ACC-03` | 6-level CoA integrity | child account's parent chain exists; posting allowed only on detail/postable accounts; sum of children not enforced but report roll-up tested |
| `U-ACC-04` | period assignment from `business_date` | date in period 1405/04 → journal in that period; Gregorian/Jalali boundary correct |
| `U-ACC-05` | no mutation of posted journals | update/delete attempt → `CONFLICT`; only reversal allowed |
| `U-ACC-06` | reversal mirrors every line and keeps references | reversal debit/credit swapped, `reversal_of_id` set, original stays posted |
| `U-ACC-07` | reversal is idempotent | reversing twice returns same reversal / rejects second |
| `U-ACC-08` †R1 | **period lock** rejects posting incl. derived period | `PERIOD_CLOSED` 409 with period name; period derived from `entry_date` and locked `FOR SHARE`; a supplied `period_id` disagreeing with `entry_date` is rejected; lock is transactional (R1 B-09/B-16; see `U-ACC-50`, `I-PER-01`) |
| `U-ACC-09` | fiscal year boundaries and generated periods | 12 monthly periods; first/last day inclusive; no gap/overlap between years |
| `U-ACC-10` | journal number gap-free per type/year | 1..N contiguous; void keeps number; new year restarts at 1 with `JE-1406-000001` |
| `U-ACC-11` | trial balance sums to zero | after N journals, Σ debit − Σ credit = 0; per account balances equal ledger detail |
| `U-ACC-12` | account balance projection matches journal lines | `account_balances` equals recomputation for every account×period |
| `U-ACC-13` | posting is safe to retry | same event id → one journal (idempotency key); duplicate number impossible |
| `U-ACC-14` | dimensions required per rule | cost-center/branch dimension validation; missing dimension → `VALIDATION_ERROR` where rule requires |
| `U-ACC-15` | manual journal approval | above threshold requires approval; requester ≠ approver (DB constraint); approved by finance_manager only |
| `U-ACC-16` †R1 | tax document rules | VAT amount matches price engine; tax account mapping per rate/type (input, output, withholding, VAT receivable) instead of hard-coded codes; credit-note document type for returns (R1 B-11/H-07; see `U-ACC-35`) |
| `U-ACC-17` | revenue recognition on shipment, not order | no journal on order create; journal on ship/consume event |
| `U-ACC-18` | COGS equals valuation at ship time | journal COGS = FIFO/WA engine output for consumed layers |
| `U-ACC-19` | returns reverse revenue/COGS/tax proportionally | partial return computes proportional VAT with half-up rounding |
| `U-ACC-20` †R1 | channel fee expense posted with settlement | commission/fee expense and VAT-on-fee accounts, vendor payable cleared; **settlement never credits sales revenue**; residual to settlement-variance account (R1 B-03; see `U-ACC-34`) |
| `U-ACC-21` †R1 | cheque journals per state | receipt Dr cheques on hand / Cr AR; deposit Dr cheques in collection / Cr cheques on hand; collect Dr bank / Cr cheques in collection; bounce-before-collect Dr AR / Cr cheques on hand; **bounce-after-collect Dr AR / Cr bank + fee**; endorsed Dr AP / Cr cheques on hand; issued Dr AP / Cr cheques payable, cleared Dr cheques payable / Cr bank (R1 B-13; see `U-ACC-43`, `U-TRS-17…21`) |
| `U-ACC-22` | opening balances only in first period | opening journal in later period rejected |
| `U-ACC-23` | report read models not mixed with writes | report queries run on read-only role (`saman_readonly`) and fail on write attempt |
| `U-ACC-24` | journal posting from outbox event | event handler keys `(event_type, aggregate_id, event_version)`; duplicate event → no second journal |
| `U-ACC-25` | debit/credit direction validation | negative line amount rejected; use side + positive amount |
| `U-ACC-26` | archival/period-close completeness | closing a period requires zero draft journals; drafts block close with list |

### 6.6 Treasury & cheque lifecycle — 16 cases (`apps/api/src/modules/treasury/*.spec.ts`)

**Decision (§20-D3):** cheque state machine is exactly:

```text
registered → in_hand → deposited → collected
     │           │           │
     │           ├── endorsed (terminal: ownership transferred, no cash journal)
     │           ├── returned (terminal)
     │           └── cancelled (terminal)
     └── cancelled (terminal)      deposited → bounced (terminal) / returned (terminal)
```

| From \ To | registered | in_hand | deposited | collected | endorsed | returned | bounced | cancelled |
|---|---|---|---|---|---|---|---|---|
| **registered** | — | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **in_hand** | ❌ | — | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ |
| **deposited** | ❌ | ❌ | — | ✅ | ❌ | ✅ | ✅ | ❌ |
| **collected / endorsed / returned / bounced / cancelled** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

†R1 (v1.1, §20.1 D3-r1): the received-direction matrix above is unchanged; the R1 review requires a
separate `direction='issued'` sub-FSM (`issued → issued_cleared / issued_bounced / issued_cancelled`,
Dr AP / Cr cheques payable → Dr cheques payable / Cr bank), `endorsed_to` + `endorsement_date`,
`bank_account_id` at deposit and `cleared_bank_transaction_id` — locked by `U-TRS-17…21`, `I-TRS-02` (§21.9).

| ID | Named case | Assertion |
|---|---|---|
| `U-TRS-01` | cheque registration validates fields | amount > 0, due_date ≥ issue_date, unique `(org, bank, check_number)`, initial state `registered` |
| `U-TRS-02` | duplicate cheque number in same bank rejected | 409 `CONFLICT`; same number different bank allowed |
| `U-TRS-03` †R1 | registered → in_hand | received/held transition, custody fields set, audit row, no journal (R1 B-13) |
| `U-TRS-04` †R1 | in_hand → deposited | deposit date, bank account and collection account recorded; Dr cheques in collection / Cr cheques on hand; no revenue journal (R1 B-13) |
| `U-TRS-05` †R1 | deposited → collected | status collected + `collected_at`; Dr bank / Cr cheques in collection; linked payment done; `cleared_bank_transaction_id` set (R1 B-13) |
| `U-TRS-06` †R1 | branches: endorsed / returned / bounced / cancelled | **endorsement records endorsed_to + endorsement_date and guarantee memo**; returned/bounced post correct reversal depending on pre/post-collect; cancelled requires reason, no journal (R1 B-13; see `U-TRS-18`) |
| `U-TRS-07` †R1 | **full transition matrix** | all **64** received-direction cells plus the **issued-direction sub-matrix** of the R1-extended FSM asserted: legal transitions succeed, every illegal one → `CONFLICT`; terminal states accept no transition; self-transitions rejected (R1 B-13) |
| `U-TRS-08` †R1 | double collect race | two `deposited → collected` attempts → exactly one success, one `CONFLICT` (row lock), one journal |
| `U-TRS-09` | due-date alert at 7 days / 1 day | notification job selects `due_date BETWEEN today AND today+7`, excludes `collected/endorsed/returned/bounced/cancelled` |
| `U-TRS-10` | cheque currency/base guard | foreign currency rejected in v1 |
| `U-TRS-11` | payment reconciliation links | payment ↔ cheque ↔ bank transaction links consistent; unlink forbidden after `collected` |
| `U-TRS-12` | bank reconciliation unmatched items | imported statement line match/mismatch cases (exact amount + date window 3 days) |
| `U-TRS-13` | amount immutable, correction by reissue | no partial payment; correcting a settled cheque requires a new document + reversal |
| `U-TRS-14` | cheque report | `in_hand`/`deposited`/`collected`/`bounced` totals equal journal balances |
| `U-TRS-15` | cheque audit trail | every transition records actor, timestamp, reason (`returned`/`bounced` require reason) |
| `U-TRS-16` | cheque number uniqueness under concurrency | 20 parallel registrations of same number → 1 row, 19 conflicts |

### 6.7 Identity, auth & sessions — 28 cases (`apps/api/src/modules/identity/*.spec.ts`)

| ID | Named case | Assertion |
|---|---|---|
| `U-AUTH-01` | OTP is 6 digits, generated with CSPRNG | `/^\d{6}$/`; generator uses `randomInt`; 10,000 draws uniform-ish (chi-square smoke) |
| `U-AUTH-02` | OTP TTL exactly 120 s | valid at t=119 s, `OTP_EXPIRED` at t=121 s |
| `U-AUTH-03` | OTP stored hashed | DB column never equals plaintext; plaintext only in SMS sink |
| `U-AUTH-04` | OTP single-use | second verify with same code → `OTP_INVALID` |
| `U-AUTH-05` | max 5 verify attempts per challenge | 6th attempt (even correct) → `OTP_LOCKED` 429; counter increments before compare |
| `U-AUTH-06` | max 5 sends/hour/mobile | 6th send → 429 with `retry_after`; window is 60 min rolling in Redis |
| `U-AUTH-07` | send throttle per IP | distinct mobile, same IP → 20/hour → 429 (`ADR-0004`, security §rate) |
| `U-AUTH-08` | constant-time compare | wrong/right code timing difference < 5 ms over 1,000 samples (non-flaky: assert implementation uses `timingSafeEqual`) |
| `U-AUTH-09` | login lockout | 10 failed passwords → account locked 15 min; correct password during lock → 423/429 |
| `U-AUTH-10` | exponential delay on failures | attempts 1–10 produce monotonically non-decreasing delay (unit, no real sleep) |
| `U-AUTH-11` | refresh rotation | refresh R1 → R2; R1 no longer accepted |
| `U-AUTH-12` | **refresh reuse detection** | R1 replay after rotation → session family revoked, all refresh tokens dead, security audit event `auth.refresh_reuse`, 401 |
| `U-AUTH-13` | access JWT TTL 600 s and claims | `sub/org/sid/pv/scope` present; token signed HS256; no refresh token in body |
| `U-AUTH-14` | stale `pv` rejected | role change bumps version; old access token → 401 `PERMISSIONS_CHANGED`; refresh yields new token |
| `U-AUTH-15` | logout revokes session | refresh fails after logout; access token honoured ≤ TTL but sensitive endpoints check session row |
| `U-AUTH-16` | revoke-others | other sessions dead immediately at refresh, current survives |
| `U-AUTH-17` †R1 | device trust / 2FA challenge | trust bypass requires the **server-issued device secret** (HttpOnly cookie); a client-supplied `deviceFingerprint` alone never skips OTP; new device → OTP challenge; trusted device 30 days, untrusted after expiry (R1 B-02; see `SEC-AUTH-07/08`) |
| `U-AUTH-18` | refresh cookie attributes | `HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth`; not readable from JS (header assertion) |
| `U-AUTH-19` | refresh CSRF marker | missing `X-Requested-With` or foreign `Origin` → 403 |
| `U-AUTH-20` | password policy | < 12 chars, zxcvbn < 3, breached password, last-5 reuse → rejected |
| `U-AUTH-21` | Argon2id parameters | memory 64 MB, iterations 3, parallelism 1 (config assertion) |
| `U-AUTH-22` | OTP mock disabled in production | boot with `APP_ENV=production, SMS_MODE=mock` fails fast |
| `U-AUTH-23` | JWT `alg:none` and signature tamper rejected | 401, no key confusion |
| `U-AUTH-24` | user enumeration resistance | forgot-password/OTP send returns identical response body/time class for known/unknown mobile |
| `U-AUTH-25` | session table revocation reasons | `revoke_reason` enum recorded; audit log written |
| `U-AUTH-26` | token in logs forbidden | log serializers redact `authorization`, `cookie`, `refresh`; snapshot test |
| `U-AUTH-27` | device fingerprint truncation | IP stored /24 (IPv4) or /64 (IPv6); UA hashed |
| `U-AUTH-28` | permission cache invalidation | role edit bumps `users.permissions_version` transactionally; Redis key version changes |

### 6.8 RBAC, tenancy & separation of duties — 20 cases (`apps/api/src/modules/identity/rbac.spec.ts`, `platform/tenant.spec.ts`)

Role model: 8 seeded roles — `superadmin`, `admin`, `finance_manager`, `accountant`, `warehouse_manager`, `warehouse_operator`, `sales_agent`, `viewer` (`README.md` §4).

| ID | Named case | Assertion |
|---|---|---|
| `U-RBAC-01` | permission catalogue is code-defined and seeded | every key in `packages/shared/permissions.ts` exists as a seeded row; no orphan DB permission |
| `U-RBAC-02` | system roles immutable | edit/delete `superadmin`/`admin` → `FORBIDDEN`; custom role editable |
| `U-RBAC-03` | role template → permission set | matrix snapshot per role matches approved table in `docs/04-security/SECURITY.md` |
| `U-RBAC-04` | guard default-deny | handler without `@Permissions` is unreachable / lint fails (`CT-PERM-01`) |
| `U-RBAC-05` | field-level cost/price stripping | `warehouse_operator` GET product: no `cost`, `purchase_price`, `margin`; with `catalog.cost.read` fields present |
| `U-RBAC-06` | scope narrowing | user scoped to branch A/warehouse W1: list/get outside scope → 404 (not 403), repository adds scope predicate |
| `U-RBAC-07` †R1 | SoD: requester ≠ approver, enforced by guard + DB | DB constraint `requested_by <> approved_by`; self-approval attempt → 409; guard denies author+post of the same document type (`*_post` disjoint from `*.create/update`); over-threshold journal requires `approval_id NOT NULL`; approval-config changes need `approval.config.manage` + superadmin + step-up + 2-person approval (R1 B-04; see `SEC-AC-10/11`) |
| `U-RBAC-08` | approval workflow state machine | pending → approved/rejected/expired; no approve after expiry; one action per step |
| `U-RBAC-09` | every denial audited | `audit_logs.action = 'access.denied'` with route, actor, scope |
| `U-RBAC-10` | tenant context required by repository | repository called without `TenantContext` throws in dev/test; type-level requirement |
| `U-RBAC-11` | org scoping on list/detail | org B rows never returned in org A list; cross-org detail by public_id → 404 |
| `U-RBAC-12` | composite FK prevents cross-org link | inserting `(org A, variant of org B)` fails FK |
| `U-RBAC-13` | no unscoped select | lint/architecture test greps `db.select().from(` usage; only repository files allowed; own test fixture fails rule |
| `U-RBAC-14` | public_id enumeration resistance | sequential scanning of ids returns 404/no data; internal bigint never in API payload (snapshot) |
| `U-RBAC-15` | permission denied on missing scope claim | token without `warehouseIds` cannot operate warehouse endpoints |
| `U-RBAC-16` | RBAC matrix generation test | matrix (role × endpoint) fixture is exhaustive: every route has entry; changing route list fails until matrix updated |
| `U-RBAC-17` | permission cache poisoning guard | cache key includes `users.permissions_version`; stale cache cannot grant removed permission |
| `U-RBAC-18` | is_system role assignment guard | only `superadmin` can assign `admin`/`finance_manager` |
| `U-RBAC-19` | audit immutability | update/delete `audit_logs` denied for app role; append-only |
| `U-RBAC-20` | tenant-aware unique constraints | SKU/code uniqueness scoped per org (same SKU allowed in another org only if policy allows) |

### 6.9 Persian calendar & document numbering — 18 cases (`packages/shared/src/calendar.spec.ts`, `.../platform/numbering.spec.ts`)

Known boundary fixtures (oracle: `Intl.DateTimeFormat('fa-IR-u-ca-persian', {timeZone:'Asia/Tehran'})` plus hand-written expectations):

| Jalali | Gregorian (Asia/Tehran) | Note |
|---|---|---|
| 1403/01/01 | 2024-03-20 | Nowruz 2024 |
| 1403/12/30 | 2025-03-20 | 1403 is leap (Esfand 30 exists) |
| 1404/01/01 | 2025-03-21 | |
| 1404/12/29 | 2026-03-20 | 1404 is common (no 12/30) |
| 1405/01/01 | 2026-03-21 | |
| 1408/01/01 | 2029-03-21 | next leap cycle check |

| ID | Named case | Assertion |
|---|---|---|
| `U-CAL-01` | leap years 1403/1408 | 1403/12/30 valid; 1404/12/30 invalid |
| `U-CAL-02` | month lengths 1–6 = 31, 7–11 = 30, 12 = 29/30 | all 12 boundaries round-trip |
| `U-CAL-03` | Nowruz boundary at 00:00 Tehran | `1405/01/01 00:00` maps to correct UTC instant; day before maps to 1404/12/29 |
| `U-CAL-04` | conversion round-trip property | 20,000 random civil days 1390–1450: `toJalali(toGregorian(d)) === d` |
| `U-CAL-05` | invalid input rejected | `1404/12/30`, `1405/13/01`, month 0 → `VALIDATION_ERROR` |
| `U-CAL-06` | date-only business date has no timezone drift | `business_date` stored as `date`, read back identical; API emits `1405-07-27` string |
| `U-CAL-07` | report range translation | Jalali range `1405/01/01..1405/03/31` → SQL range correct, inclusive end-of-day |
| `U-CAL-08` †R1 | fiscal year derivation | org setting `fiscal_start_month=1, day=1`; year 1405 starts 2026-03-21; configurable start (e.g. month 7) tested; **fiscal-year ranges cannot overlap (`EXCLUDE USING gist`)** (R1 B-09; see `U-CAL-19`) |
| `U-CAL-09` †R1 | monthly period generation | 12 periods plus optional period **13** per rules, exact boundaries, no gaps/overlaps (`EXCLUDE` constraint); leap year 1403 period 12 = 30 days (R1 B-09/M-01; see `U-CAL-19/20/21`) |
| `U-CAL-10` | period lock boundary | posting at period last day 23:59:59 accepted; 00:00 next day → next period |
| `U-CAL-11` | document number format | `SLS-1405-000123`, `PUR-1405-000001`, `JE-1405-000001`; zero-padding to 6 |
| `U-CAL-12` | sequence allocation is gap-free under repeated allocation | 1,000 sequential allocations = values 1..1,000 without holes |
| `U-CAL-13` | voided document keeps its number | number never reused, appears in journal as void |
| `U-CAL-14` | year rollover restarts sequence | 1405 last number N; 1406 starts at 1 with new prefix year |
| `U-CAL-15` | concurrency numbering | covered by `C-NUM-01` (integration) |
| `U-CAL-16` | Jalali date picker model ↔ API | shared Zod `JalaliDate` parse/serialize; UI model test in web |
| `U-CAL-17` | no string sorting of Jalali dates | repository filters use `business_date` columns; code review/lint test forbids `ORDER BY` on Jalali text (schema has no Jalali text columns — schema snapshot test) |
| `U-CAL-18` | timezone matrix | same fixtures pass under `TZ=UTC` and `TZ=Asia/Tehran` |

### 6.10 Channels, webhooks & sync — 22 cases (`apps/api/src/modules/channels/*.spec.ts`, `adapters/*.spec.ts`)

| ID | Named case | Assertion |
|---|---|---|
| `U-CHN-01` | adapter capabilities declared per channel | `mock`: stock/price/order/label; Digikala missing capability fails feature gate |
| `U-CHN-02` | Carexy payload → canonical order | fixture mapping snapshot; no Carexy field leaks into core DTO |
| `U-CHN-03` | Digikala payload → canonical order | fixture mapping; order status mapped to core state machine |
| `U-CHN-04` | unknown/extra fields tolerated, missing required rejected | Zod strict on required, passthrough archived only |
| `U-CHN-05` | **channel mapping idempotency** | upsert mapping twice → 1 row, same `public_id`; conflicting mapping (external id reused for another variant) → 409 |
| `U-CHN-06` | canonical model purity | schema snapshot: zero `carexy_*`/`digikala_*` columns on core tables; external ids only in mappings |
| `U-CHN-07` | raw payload persisted before parse | parse failure still leaves `channel_webhook_events` row with raw body + signature verdict |
| `U-CHN-08` | webhook signature verification | valid HMAC passes; tampered body, missing header, wrong timestamp → 401 |
| `U-CHN-09` | **webhook duplicate/replay** | same event id twice → 1 effect, second is no-op 200; replay with timestamp older than 5 min → 401 `STALE_WEBHOOK` |
| `U-CHN-10` | idempotency natural key `channel:order:<id>` | duplicate pull delivery → 1 `sales_orders`, returns existing `public_id` |
| `U-CHN-11` | retry with exponential backoff + jitter | attempts at 30 s, 60 s, 120 s… capped 1 h; jitter within ±20 % |
| `U-CHN-12` | permanent failure → DLQ after 10 attempts | `integration_dead_letters` row with payload+error; alert metric incremented |
| `U-CHN-13` | transient 5xx vs permanent 4xx classification | 5xx/timeout retried; 400/401 permanent (or credential refresh once) |
| `U-CHN-14` | rate limit / token bucket per channel | mock limiter: burst then 429; scheduler respects `rate_limit_per_min` |
| `U-CHN-15` | stock push uses `available`, never `on_hand` | payload assertion with reserved stock present |
| `U-CHN-16` | stock push debounce/batch 2–5 s | 100 rapid changes → 1 aggregated push per channel per window |
| `U-CHN-17` | credential encryption | AES-256-GCM, random IV; ciphertext not equal plaintext; decrypt only inside adapter call; logs redacted |
| `U-CHN-18` | credential rotation | new key decrypts new ciphertext; old ciphertext re-encryptable; test key-version column |
| `U-CHN-19` | TBD-DIGIKALA guard | flagged endpoints throw/not-called; feature flag visible in health/version |
| `U-CHN-20` | webhook concurrent duplicate | covered by `C-CHN-01` |
| `U-CHN-21` | adapter timeout handling | mock hangs 30 s → abort at configured timeout (5 s default), retry scheduled, no user block |
| `U-CHN-22` | API call log | every call logged with channel, endpoint, status, latency, no secrets; 180-day retention partition (`ADR-0009`) |

### 6.11 Outbox, jobs & idempotency — 14 cases (`apps/api/src/modules/platform/outbox.spec.ts`)

| ID | Named case | Assertion |
|---|---|---|
| `U-OBX-01` | outbox row written in business transaction | rollback of business write leaves **zero** outbox rows; commit leaves exactly one |
| `U-OBX-02` | dispatch marks processed only after handler success | handler throws → `processed_at` null, attempts +1 |
| `U-OBX-03` | handler idempotency key `(event_type, aggregate_id, event_version)` | running twice yields one side effect |
| `U-OBX-04` | exponential backoff 30 s → 1 h, max 10 attempts | schedule table asserted; attempt 11 → DLQ |
| `U-OBX-05` | SKIP LOCKED no double-dispatch | two workers over same batch process each row once (unit-level + `C-OBX-01`) |
| `U-OBX-06` | events ordered per aggregate | aggregate A events dispatched in `event_version` order; different aggregates may interleave |
| `U-OBX-07` | unknown event type | handler missing → DLQ + alert, observed transaction remains committed |
| `U-OBX-08` | payload schema validation | invalid payload → DLQ, no partial effects |
| `U-OBX-09` | job payload Zod validation | BullMQ job with bad payload fails fast, not retried infinitely |
| `U-OBX-10` | periodic schedules registered | partition maintenance daily 02:00, matview refresh, backup verification 03:00, channel health hourly (`ARCHITECTURE.md` §7) |
| `U-OBX-11` | stalled job recovery | simulated worker stop → job re-run idempotently |
| `U-OBX-12` | idempotency_keys 24 h retention | replay within 24 h returns original response; after retention new request executes |
| `U-OBX-13` | queue metrics | depth/age/failed counters exported; outbox lag metric present |
| `U-OBX-14` | graceful shutdown | SIGTERM drains in-flight job then exits; no job lost |

### 6.12 Procurement, sales, warehouse, fulfillment — 28 cases

| ID | Named case | Assertion |
|---|---|---|
| `U-PUR-01` | PO → receipt over-receipt policy | receipt > ordered within tolerance (default 0 %) rejected; tolerance setting tested |
| `U-PUR-02` | receipt creates FIFO layers with landed cost | landed cost = unit + allocated freight; layer cost correct |
| `U-PUR-03` | receipt approval for above-threshold | approval workflow required (`ADR-0008`) |
| `U-PUR-04` | supplier invoice 3-way match | invoice vs PO vs receipt mismatch → `RULE_VIOLATION` with deltas |
| `U-PUR-05` | partial/multiple receipts | layers created per receipt; PO status remains partially_received |
| `U-PUR-06` | supplier invoice tax/discount math | line tax per rate, invoice total = Σ lines + tax − discount, HALF_UP |
| `U-SAL-01` | order state machine legal transitions | draft→confirmed→allocated→picking→packed→shipped→delivered; illegal jump → 409 |
| `U-SAL-02` | order totals = Σ lines + tax − discount | money helpers; no float; rounding half-up |
| `U-SAL-03` | customer credit limit | exceed → `RULE_VIOLATION` (configurable) |
| `U-SAL-04` | return authorization rules | return qty ≤ shipped qty; duplicate return of same unit rejected (serial) |
| `U-SAL-05` | refund ≤ paid amount | over-refund rejected; partial refunds accumulate |
| `U-SAL-06` | return restock policy | resellable → layer/value restored; damaged → write-off journal + approval |
| `U-SAL-07` | order/customer/address data validation | invalid national ID/mobile/postal code rejected; soft-deleted customer cannot be used in a new order |
| `U-WHS-01` | warehouse tree depth/ordering | hierarchy creation, cycle prevention, deactivate with stock rejected |
| `U-WHS-02` | putaway suggestion | putaway to allowed location; capacity/zone rules; fallback location |
| `U-WHS-03` | pick scan barcode match | wrong barcode → `SCAN_MISMATCH`, no pick progress; correct → task line done |
| `U-WHS-04` | pack scan match | pack verifies all lines; missing/extra item blocked |
| `U-WHS-05` | label generation | label payload deterministic, printed via stub, reprint audited |
| `U-WHS-06` | pick wave grouping and priority | wave batches by warehouse/zone and priority; deterministic order |
| `U-WHS-07` | offline scan replay | duplicate scan events replay idempotent (`ADR-0011` offline queue) |
| `U-WHS-08` | cycle count variance | counted vs on_hand → adjustment ledger + approval above threshold |
| `U-WHS-09` | shipment/carrier mapping | carrier label + tracking id stored; duplicate tracking rejected |
| `U-WHS-10` | bin/shelf capacity and location rules | over-capacity or disallowed pick location rejected; deactivated location blocks new putaway |
| `U-FUL-01` | allocation requests use order priority | priority/FIFO deterministic (covered also `U-RES-14`) |
| `U-FUL-02` | shipment completion consumes reservation | consume + ledger + package state consistent |
| `U-FUL-03` | partial shipment state | order remains partially_shipped; remaining reservation active |
| `U-FUL-04` | cancellation after pick requires restock | restock ledger and reservation release |
| `U-FUL-05` | scan events are audited | actor + device + timestamp per scan |

### 6.13 Reporting, settings, notifications, automation — 14 cases

| ID | Named case | Assertion |
|---|---|---|
| `U-RPT-01` | trial balance report matches journal aggregation | report totals equal SQL-independent recomputation |
| `U-RPT-02` | P&L and balance sheet equations | assets = liabilities + equity at any date; net = revenue − expense |
| `U-RPT-03` | Jalali grouping by month | business_date generated column groups correctly across leap year |
| `U-RPT-04` | report range validation | start > end rejected; range > 5 years rejected with clear error |
| `U-RPT-05` | export job | CSV/XLSX produced via worker, unicode UTF-8 with BOM, Persian text intact, progress + S3 URL |
| `U-RPT-06` | matview refresh does not block writes | refresh scheduled, concurrent writes succeed (integration) |
| `U-SET-01` | settings validation | unknown key/type rejected; secrets never returned by GET |
| `U-SET-02` | audit log diff | settings change records before/after with PII redaction |
| `U-NTF-01` | SMS pattern/parameters | Limo adapter payload matches fixture; pattern variables escaped |
| `U-NTF-02` | notification retry/DLQ | SMS provider 5xx → retry; permanent → DLQ; user sees nothing |
| `U-NTF-03` | no PII in logs | phone/email/OTP redacted (serializer snapshot) |
| `U-AUT-01` | business rule engine | reorder threshold triggers alert job once per day (dedupe) |
| `U-AUT-02` | fraud flag rules | duplicate order pattern flagged, not auto-blocked (human review) |
| `U-AUT-03` | alert dedupe | same alert within window → one notification |

### 6.14 Web (React) unit/component — 30 cases (`apps/web/src/**/*.spec.tsx`)

| ID group | Named cases | Assertion |
|---|---|---|
| `U-WEB-01…05` | money & date formatting | Persian digits via `Intl.NumberFormat('fa-IR')`, no client-side money summation, Jalali display, UTC→Tehran rendering, `dir="rtl"` root |
| `U-WEB-06…10` | auth client | access token in memory only (never localStorage/sessionStorage), silent refresh on 401 `PERMISSIONS_CHANGED`, logout clears store, refresh single-flight, error normalization |
| `U-WEB-11…16` | form validation | shared Zod schemas used; money inputs as strings; bigint precision preserved; JalaliDate picker; required permissions hide/disable actions; unsaved-changes guard |
| `U-WEB-17…22` | tables & scanner | virtualized table renders 10k rows budget (< 150 ms render), keyset pagination, barcode wedge input, camera fallback feature-detect, offline scan queue replay idempotency, large tap targets (≥ 44 px) |
| `U-WEB-23…27` | empty/error/loading states | 403 screen, 404 screen, network retry, global error boundary, skeletons |
| `U-WEB-28…30` | report components | charts render with empty data, currency axis formatting, RTL legend order |

---

## 7. Concurrency & race suite (integration project, `apps/api/test/integration/concurrency/`)

Every test uses real PostgreSQL with the production isolation level. Tests must be deterministic:
no wall-clock sleeps; use barriers (`Promise.allSettled`) and DB polling with a 100 ms interval and
10 s cap.

| ID | Named case | Exact expectation |
|---|---|---|
| `C-ALLOC-01` | **100 parallel allocators, one variant, qty 1 each, on_hand = 1** | exactly **1** HTTP 200/201; **99** HTTP 409 `RULE_VIOLATION INSUFFICIENT_STOCK`; `on_hand = 1`, `reserved = 1`, `available = 0`; ledger sum unchanged; zero negative rows |
| `C-ALLOC-02` | 100 parallel, on_hand = 12, qty 1 each | exactly 12 success, 88 conflicts; reserved = 12; no deadlock surfaced |
| `C-ALLOC-03` | multi-line all-or-nothing under contention | 50 orders × 3 lines, only last unit contested; failures leave **0** reservations for failed orders |
| `C-ALLOC-04` | 200 parallel mixed reserves/releases | final `reserved` = active reservations sum; available never negative at any polled instant |
| `C-ALLOC-05` | same idempotency key sent 20× concurrently | 1 order, 1 allocation, 19 replays return identical response body |
| `C-RES-01` | consume vs expiry at TTL boundary | exactly one terminal state per reservation; `reserved` decremented once |
| `C-INV-01` | concurrent receipt (in) + sale (out) | `on_hand = Σ ledger`; final = initial + in − out; invariant holds |
| `C-INV-02` | direct SQL UPDATE on ledger rejected | 0 rows affected / trigger error; ledger checksum unchanged |
| `C-INV-03` | DB CHECK prevents negative stock | concurrent writes cannot drive `on_hand < 0`; CHECK violation mapped to `RULE_VIOLATION` |
| `C-NUM-01` | 100 parallel document number allocations, one type/year | numbers exactly `1..100`, no duplicates, no gaps |
| `C-ACC-01` | 50 parallel journal postings | all balanced; `account_balances` equals sum of lines; no lost updates |
| `C-OBX-01` | two dispatchers run same batch | each outbox row processed once (SKIP LOCKED); side effect count equals event count |
| `C-CHN-01` | 20 concurrent duplicate webhook deliveries | 1 `sales_orders` row / 1 effect; 19 idempotent responses; raw events archived |
| `C-CHN-02` | 20 concurrent duplicate order pulls from channel | 1 order; unique `(channel, external_order_id)` holds |
| `C-IDEM-01` | 20 concurrent POST with same `Idempotency-Key` | one row, all responses identical (status + body), 24 h retention |
| `C-TRS-01` | 20 parallel clears of one cheque | 1 success, 19 `CONFLICT`; one journal |
| `C-PRT-01` | concurrent inserts at partition boundary | rows land in correct monthly partition; no missing-partition error after maintenance job pre-creates next 2 months |

Each concurrency test is tagged `@concurrency`; the suite runs in its own Vitest project with
`fileParallelism: false` when it asserts global numbering/partitions, and `pool: 'forks'` otherwise.

---

## 8. Integration scenarios (end-to-end through HTTP + DB, `apps/api/test/integration/`)

Each scenario seeds via factories, drives real HTTP with a real JWT, asserts DB state **and**
`assertInvariants()`. Minimum **90** integration tests across these scenarios (each scenario has
multiple `it()` cases).

| ID | Scenario | Key assertions |
|---|---|---|
| `I-ENV-01…05` | environment contract | migrations from empty, seed idempotency, reset, schema drift zero-diff, Redis-down degradation |
| `I-PUR-01` | **purchase → receipt → putaway → FIFO layers → stock balance** | PO confirmed; receipt creates layers (qty/cost/remaining); putaway to bin updates location balance and warehouse balance; `on_hand` = Σ layers per variant/warehouse; inventory asset journal posted; trial balance unchanged (asset vs payable) |
| `I-ORD-01` | **manual order full chain → allocate → pick scan → pack scan → label → ship → auto journal → trial balance** | order confirmed; allocation reservation exact; wrong pick barcode rejected server-side (409, no progress); correct scan completes pick; pack scan mismatch blocked; label generated (S3 object exists); ship consumes reservation + writes ledger; journals posted: revenue, VAT, COGS, inventory, shipping; **trial balance via `GET /api/v1/accounting/reports/trial-balance` has Σ debit = Σ credit**; order state `shipped` |
| `I-CHN-01` | **Carexy order webhook → canonical order** | HMAC valid; raw archived; canonical order created once; mapping linked; duplicate delivery no-op; unknown variant → DLQ/exception path with alert, no partial order |
| `I-CHN-02` | **Digikala mock poll → canonical → allocate** | pagination/since cursor, 264-endpoint contract only confirmed ones; duplicate pull idempotent; `TBD-DIGIKALA` never called |
| `I-RET-01` | **return → refund → restock → journal** | RMA approved; refund ≤ paid; restock re-creates value (resellable) or write-off (damaged, approval); reversal journals for revenue/VAT/COGS; stock balance restored; trial balance balances |
| `I-CHN-03` | **channel sync retry / backoff / DLQ** | mock returns 500 twice then 200 → success after retries, attempts recorded; permanent 400 → DLQ after 10; no user-facing error; metrics incremented |
| `I-CHN-04` | **duplicate webhook under concurrency** | 20 parallel deliveries → 1 order; raw events all archived; exactly one allocation |
| `I-PRT-01` | **partition rollover insert** | maintenance job creates next 2 monthly partitions; insert at first/last instant of next month lands in correct partition; query with `created_at` range uses partition pruning (`EXPLAIN` shows only target partitions); missing partition (simulated) raises critical alert |
| `I-OBX-01` | **outbox exactly-once effects** | business write + event atomic (rollback test); forced duplicate dispatch → journal/report/sms effect exactly once; outbox lag metric < 60 s in test |
| `I-ACC-01` | period close & correction | close period (draft journals block); posting rejected `PERIOD_CLOSED`; reversal posted in open period; trial balance still zero; no data mutation |
| `I-INV-01` | warehouse transfer | issue → in-transit → receipt; company total constant; balances per warehouse correct; journals for in-transit if configured |
| `I-INV-02` | cycle count + adjustment | variance → adjustment ledger + approval above threshold; journal posted; invariant holds |
| `I-TRS-01` | cheque lifecycle | receive (`registered → in_hand`) → due alert → deposit → collect (bank journal) or `bounced`/`returned` (reversal + fee) or `endorsed` (no cash journal); full transition matrix; no duplicate transition; trial balance balances |
| `I-SEC-01` | tenant & scope across endpoints | org B fixtures; token A cannot read/write org B (404); warehouse-scoped user limited; field stripping verified over HTTP |
| `I-RPT-01` | reporting read path | trial balance/P&L/balance sheet via API equal recomputation; Jalali range; read-only role enforced. Endpoint paths come from the generated client (no hardcoded strings, §20-D6) |

**Determinism requirement:** scenario fixtures include fixed `business_date` and `created_at` from
`TestClock`, so journals, document numbers (`SLS-1405-000001`, `JE-1405-000001`) and partition names
are deterministic and snapshot-asserted.

---

## 9. Invariant & property-based tests

### 9.1 Cross-table invariants (`apps/api/test/invariants/`, `scripts/invariants.ts`)

`assertInvariants()` runs after every integration test; `pnpm test:invariants` runs all 16 against
the tested DB and is invoked nightly against a staging clone. Any violation fails the build.

| ID | Invariant | SQL predicate (conceptual) | Where |
|---|---|---|---|
| `INV-01` | `on_hand = Σ ledger qty` per variant/warehouse/location | `inventory_balances.on_hand = SUM(inventory_transactions.qty_signed)` grouped by key | `invariants/ledger-sum.int.spec.ts` |
| `INV-02` | `reserved = Σ active reservations` | balance.reserved equals sum of `status='active'` reservations | `invariants/reservations.int.spec.ts` |
| `INV-03` | `reserved ≤ on_hand` | no row violates | same |
| `INV-04` | `available ≥ 0` and `available = on_hand − reserved − safety_buffer` | CHECK + computed comparison | same |
| `INV-05` | no negative quantities/prices | `qty ≥ 0`, `amount ≥ 0`, costs ≥ 0 where applicable | `invariants/amounts.int.spec.ts` |
| `INV-06` | every posted journal balances | per entry `SUM(debit) = SUM(credit)`; per period too | `invariants/journal-balance.int.spec.ts` |
| `INV-07` | posted journals/lines never mutated | `updated_at = created_at` for posted rows; no delete; reversal-only | same |
| `INV-08` | `account_balances` = Σ journal lines per account×period | equality query | `invariants/account-balances.int.spec.ts` |
| `INV-09` | document numbers gap-free per type/fiscal year | `COUNT = MAX − MIN + 1`, `COUNT(DISTINCT) = COUNT` | `invariants/numbering.int.spec.ts` |
| `INV-10` | no orphan children | left join line→header, mapping→account, reservation→order/balance etc. yields 0 | `invariants/orphans.int.spec.ts` |
| `INV-11` | every ledger row has valid source document | ledger.source_type/source_id resolves | same |
| `INV-12` | no cross-org references | all `organization_id` agree along FK chains checked at highest-risk relations | `invariants/tenancy.int.spec.ts` |
| `INV-13` | FIFO layers sum to on_hand for FIFO-valued variant | Σ `cost_remaining` qty = on_hand | `invariants/valuation.int.spec.ts` |
| `INV-14` | outbox terminal state consistency | processed rows have `processed_at`; DLQ rows have attempts = 10; no stuck `processing` > 5 min | `invariants/outbox.int.spec.ts` |
| `INV-15` | paid/refunded totals consistency | Σ refunds ≤ Σ payments per order; cheque totals match journal balances | `invariants/treasury.int.spec.ts` |
| `INV-16` | no duplicate business keys | unique indexes hold for `(channel, external_order_id)`, `(org, bank, cheque_number)`, SKU per org, mapping external id | duplicate-key scan |

Invariant harness is also an **operator tool**: `pnpm invariants --org=<public_id>` prints a
machine-readable report and exits non-zero on violation (runbook reference in `07-operations`).

### 9.2 Property-based tests (`fast-check`, 1,000 cases in PR, 50,000 nightly with fixed seed)

| ID | Property |
|---|---|
| `PROP-MON-01` | money arithmetic is associative and overflow-checked: for random bigint operands, `add(a,b)` never wraps; `parse(format(x)) = x`; `round` is idempotent |
| `PROP-MON-02` | invoice totals are order-independent: random line permutations yield identical final invoice total and tax |
| `PROP-INV-01` | random movement sequences (receipts/issues/reservations) preserve `on_hand = Σ ledger` and `available ≥ 0` |
| `PROP-INV-02` | random allocation/release/expire interleavings never produce negative reserved/available and always reach a count equal to active reservations |
| `PROP-ACC-01` | for random balanced entries and reversals, trial balance remains zero and balances equal line sums |
| `PROP-PRC-01` | for random cost/markup/commission/tax, final price is monotonic in cost, commission and markup; margin guard never passes below minimum |
| `PROP-CAL-01` | Jalali↔Gregorian round-trip over random dates (see `U-CAL-04`) |
| `PROP-NUM-01` | random interleaved document creations never yield duplicate or out-of-sequence numbers |

Property failures print the minimal shrunk counterexample and the seed; the seed is pinned in the
test file so reproduction is one command.

---

## 10. Contract tests (`apps/api/test/contract/`)

| ID | Test | Assertion / gate |
|---|---|---|
| `CT-PERM-01` | every route has a permission decorator | 0 routes without `@Permissions` (default-deny lint + runtime route scan) |
| `CT-PERM-02` | every permission used by a route exists in the seed catalogue | route ↔ catalogue diff empty |
| `CT-PERM-03` | every seeded permission is used by ≥ 1 route or marked `system` | no dead keys without justification |
| `CT-OAS-01` | OpenAPI generated from Zod matches committed snapshot | diff reviewed as breaking (via `oasdiff`) |
| `CT-OAS-02` | response schemas validate documented shapes | Supertest + Zod validation for each endpoint sample |
| `CT-OAS-03` | no breaking change | `oasdiff breaking` exit 0 against `main`; additive-only within v1 |
| `CT-ERR-01` | every error has stable code from registry | snapshot of error registry ↔ docs |
| `CT-ERR-02` | errors never leak stack/SQL/secret | 500 body matches `{error:{code,message,details,requestId}}`, no internals |
| `CT-PAGE-01` | pagination contract | cursor + offset shapes, `meta.nextCursor`, invalid cursor → 400 |
| `CT-IDEM-01` | `Idempotency-Key` documented on all business POSTs | route audit |
| `CT-VER-01` | `If-Match`/`version` conflict contract | stale version → 409 `VERSION_CONFLICT` |
| `CT-MONEY-01` | money fields are strings in OpenAPI | schema audit, zero number-typed money fields |
| `CT-BIGINT-01` | no internal bigint ids exposed | payload scan for `id` numeric; only `public_id` uuid |
| `CT-EGRESS-01` | no undeclared outbound calls in integration | MSW unhandled → error |
| `CT-MIG-01` | migration order and checksums stable | files committed, no edits after merge |
| `CT-SCOPE-01` | tenant-scoped route audit | every list/detail handler passes `TenantContext` |
| `CT-VER-02` | OpenAPI docs disabled in production | boot test with `APP_ENV=production` → `/docs` 404 |
| `CT-PERM-04` | permission matrix completeness | 8 roles × endpoints fixture updated when routes change |

---

## 11. E2E — Playwright (smoke 14, regression 12)

Config: `apps/web/playwright.config.ts`; baseURL from compose; `workers: 2` CI; `retries: 2` CI
(`0` local); `trace: 'on-first-retry'`, `video: 'retain-on-failure'`, `screenshot: 'only-on-failure'`;
global setup logs in once per role and stores storage state; OTP read from `SMS_MODE=mock` sink
endpoint `GET /api/v1/_test/last-otp` (test-only route, disabled unless `APP_ENV=test`).

**Decision (§20-D6/D7):** QA IDs (`E2E-SM-10`, `I-RPT-01`) are stable labels; route paths and
response shapes are **never hardcoded** in tests — they are injected through the generated API
client (`packages/shared` + OpenAPI-generated client) so a contract change breaks compilation, not
silently. Accounting truth is asserted against the API
(`GET /api/v1/accounting/reports/trial-balance`); the browser assertion only verifies that the
rendered totals equal the API values. Accounting truth is never derived from the DOM.

### 11.1 Smoke list (must pass before merge/release; tag `@smoke`)

| ID | Journey | Key assertions |
|---|---|---|
| `E2E-SM-01` | Login with OTP (mock SMS) | OTP screen, 6 boxes, Persian digits; session created; redirect to dashboard |
| `E2E-SM-02` | Login failure paths | invalid OTP 3× shows Persian error; lockout after 5 attempts; no token in localStorage |
| `E2E-SM-03` | Create product + variant + barcode | save, list, search by SKU/barcode; duplicate barcode rejected with field error; Persian labels/RTL |
| `E2E-SM-04` | Receive stock (PO → receipt) | on-hand and available update in UI; warehouse operator sees no cost column |
| `E2E-SM-05` | Create manual sales order | add customer, 2 lines, correct totals with tax; order confirmed |
| `E2E-SM-06` | Allocate order | allocation status visible; second order for last unit blocked with Persian message |
| `E2E-SM-07` | Pick scan | wrong barcode toast/error; correct scan progresses task; optimistic UI reconciles |
| `E2E-SM-08` | Pack scan + label | pack blocked until all items scanned; label (PDF/ZPL stub) opens/downloads |
| `E2E-SM-09` | Ship order | order → shipped; tracking number shown; stock decremented |
| `E2E-SM-10` | Auto journal + trial balance | accounting list shows sale journal; **API** `GET /api/v1/accounting/reports/trial-balance` returns balanced; rendered totals equal API values (UI = rendering check only, §20-D7) |
| `E2E-SM-11` | Invoice/print view | invoice shows Jalali date, Persian digits, totals; print stylesheet |
| `E2E-SM-12` | Channel mapping screen | map variant to mock channel; duplicate external id error; mapping persisted |
| `E2E-SM-13` | Users/roles permission edit | admin grants `inventory.adjust`; affected user sees action after re-login/refresh (`pv` bump) |
| `E2E-SM-14` | Mobile scanner pick flow (PWA) | mobile viewport, camera/wedge input, large tap targets, offline replay queue indicator |

### 11.2 Regression list (nightly; tag `@regression`)

`E2E-RG-01` purchase order 3-way match screen · `RG-02` return/refund flow · `RG-03` cheque clear &
bounce UI · `RG-04` inventory transfer · `RG-05` cycle count/adjustment · `RG-06` period close UI
· `RG-07` report export download · `RG-08` settings/audit log viewer · `RG-09` channel sync status &
DLQ retry screen · `RG-10` 10k-row virtualized product table scroll · `RG-11` session revoke others
· `RG-12` error pages (403/404/500) and global error boundary.

### 11.3 Device matrix & non-functional UI checks

| Project | Viewport / engine | Scope |
|---|---|---|
| `desktop-chromium` | 1440×900, Chromium | smoke + regression |
| `desktop-firefox` | 1440×900, Firefox | smoke |
| `tablet-webkit` | 1024×768, WebKit (`hasTouch`) | smoke subset + scanner |
| `mobile-chromium` | Pixel 5 393×851, Chromium (`hasTouch`, `isMobile`) | smoke subset + scanner PWA |
| `mobile-webkit` | iPhone 13 390×844, WebKit | smoke subset + RTL layout |

Per-page checks on every E2E run (assertions in `e2e/fixtures/ui.ts`, tag `@a11y`):
- `html[dir="rtl"]`, computed `direction: rtl`; no horizontal scrollbar at 390 px;
- Persian digits and `Intl.NumberFormat('fa-IR')` for money; Jalali dates in tables/filters;
- **axe-core** (`@axe-core/playwright`, WCAG 2.0 A/AA): **0 critical, 0 serious** violations;
- keyboard navigation: focus visible, tab order, modal focus trap, Escape closes;
- color contrast ≥ 4.5:1 for body text (axe rule enabled);
- no layout shift beyond 0.1 CLS on dashboard load (PerformanceObserver assertion, inform-level);
- console errors: zero uncaught exceptions per journey.

---

## 12. Load & performance (k6) — `infra/k6/`

### 12.1 Envelope derivation (from `README.md` §3 and `ARCHITECTURE.md` §11)

- Design order volume: **50,000 orders/day** → 0.58 orders/s average; stated peak **20 orders/s**.
- 3 lines/order × 20 orders/s = **60 inventory line writes/s**; bookings of 2–3 primary rows each.
- Catalog: 10,000 SKUs / ~40,000 variants; read p95 target **< 200 ms**, write p95 **< 500 ms**.
- Channel stock propagation **< 5 s** end-to-end; outbox lag alert threshold 60 s.
- Concurrent users 500 (design headroom 2,000); API pool 20/replica; test stack: 4 vCPU/8 GB.

### 12.2 Profiles and thresholds (all numeric; fail build when exceeded)

| ID | Script | Load model | Duration | Thresholds |
|---|---|---|---|---|
| `LOAD-01` | `smoke.js` | 1 VU, mixed read/write | 1 min | `checks > 99.9 %`, `http_req_failed < 0.1 %`, no threshold on latency (sanity) |
| `LOAD-02` | `load.js` | order ingest `constant-arrival-rate` **20 iters/s**; reads **500 req/s**; allocation **40 iters/s** | 30 min (2 min ramp) | order p95 **< 500 ms**, p99 **< 1,000 ms**; read p95 **< 200 ms**, p99 **< 400 ms**; `http_req_failed < 0.1 %`; `checks > 99.5 %`; allocation conflicts are expected-but-not-5xx; no negative stock checks fail |
| `LOAD-03` | `stress.js` | ramp orders 20→100/s in 10/s steps; reads 500→2,000/s | 25 min | find breaking point; **must sustain ≥ 40 orders/s** with p95 < 500 ms and errors < 1 %; record saturation metrics in report |
| `LOAD-04` | `soak.js` | steady 10 orders/s + 300 reads/s | **4 h** | p95 write ≤ **550 ms** (≤ 10 % degradation vs first 10 min), p99 ≤ 1,100 ms; `http_req_failed < 0.1 %`; API RSS growth ≤ **5 %**; DB connections ≤ **80 %** of `max_connections`; no disk growth > 2 GB; zero invariant violations |
| `LOAD-05` | `spike.js` | 2/s → 100/s in 10 s, hold 2 min, drop | 6 min | recovery within **60 s**; 5xx < 1 %; queue depth returns to < 100; no stuck reservations |
| `LOAD-06` | `allocation-race.js` | 100 parallel `POST /orders/:id/allocate` for one variant with qty 1, repeated 50 rounds | 5 min | every round: exactly 1 success; 99 `RULE_VIOLATION`; **0** 5xx; invariant `reserved ≤ on_hand` holds; p95 < 500 ms |

k6 scenario/options excerpt (thresholds are the contract):

```js
// infra/k6/load.js
export const options = {
  scenarios: {
    order_ingest: { executor: 'constant-arrival-rate', rate: 20, timeUnit: '1s',
                    duration: '30m', preAllocatedVUs: 100, maxVUs: 400 },
    catalog_read:  { executor: 'constant-arrival-rate', rate: 500, timeUnit: '1s',
                    duration: '30m', preAllocatedVUs: 200, maxVUs: 800 },
    allocation:    { executor: 'constant-arrival-rate', rate: 40, timeUnit: '1s',
                    duration: '30m', preAllocatedVUs: 100, maxVUs: 400 },
  },
  thresholds: {
    'http_req_duration{scenario:order_ingest}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{scenario:catalog_read}': ['p(95)<200', 'p(99)<400'],
    'http_req_duration{scenario:allocation}':   ['p(95)<500'],
    http_req_failed: ['rate<0.001'],
    checks: ['rate>0.995'],
  },
};
```

Additional numeric assertions in the k6 checks and post-run report:
- channel stock push observed by mock channel within **5 s p95** of receipt commit;
- outbox lag p95 **< 5 s**, max **< 60 s**;
- DB slow-query count (> 200 ms) per minute **< 10** during load;
- deadlock retries **< 1 %** of transactions; if ≥ 1 %, fail the run;
- API 5xx rate **< 0.1 %**; PgBouncer/queue depth alerts not triggered.

### 12.3 Data seeding strategy

`scripts/seed-load.ts` (worker-side `COPY`, chunked validation; ≤ **10 min** on 4 vCPU/8 GB):

| Dimension | Value |
|---|---|
| Organizations | 1 |
| Warehouses / locations | 3 / 600 bins |
| Products / variants / barcodes | 10,000 / 40,000 / 40,000 |
| Inventory balances | 40,000 × 3 warehouses = 120,000 |
| Inventory ledger rows | 1,000,000 (partitioned across 6 months) |
| Sales orders / lines | 200,000 / 600,000 |
| Journal entries / lines | 150,000 / 450,000 |
| Channel accounts / mappings | 2 / 80,000 |
| Users / roles | 50 users across 8 roles |

Repeatability: after seeding, take a `pg_dump -Fc` snapshot; each load run restores the snapshot
(≤ **2 min**) before execution so runs are comparable. k6 uses `setup()` to log in 50 test users
once (tokens refreshed via `POST /auth/refresh` at mid-run; access TTL 600 s). No PII: synthetic
Persian names, valid-format fake national IDs, no real phone numbers (SMS mock, `SMS_MODE=mock`).

Reports: `k6 run --summary-export=reports/k6/<profile>.json --out json=...`, thresholds baked in;
HTML report generated; CI job fails on threshold breach. Load runs execute against **staging
compose profile**, never the PR runner; results attached to the release checklist.

---

## 13. Security test plan (OWASP ASVS L2) — `apps/api/test/security/`

One row per ASVS chapter/control group; every control has an automated test where technically
possible, otherwise a documented manual procedure with a date. Static scans run on every PR;
DAST (ZAP) nightly and before release.

| ASVS area | Control (L2 baseline) | Test / tool | Numeric gate |
|---|---|---|---|
| **V1 Encoding / injection** | parameterized SQL only; no string concat | `SEC-INJ-01` SQLi corpus (20 payloads incl. `' OR 1=1`, `'; DROP TABLE`, unicode/encoding tricks) → 0 500s, 0 table loss; semgrep rule `saman/no-sql-concat` | 0 findings |
| V1 | XSS/HTML escaping in API + SPA | React escaping test; CSP report-only diff; stored-XSS payload in product name rendered as text | 0 critical |
| V2 Authentication | OTP/password per `ADR-0004` | `SEC-AUTH-01…06` (TTL/attempts/rate/lockout/reuse) — duplicates `U-AUTH` at HTTP level | 5 sends/h, 5 attempts, 120 s |
| V3 Session | refresh rotation, reuse detection, cookie flags, revocation | `SEC-SES-01…05` Supertest; cookie header assertions | 100 % reuse detections |
| V4 Access control | RBAC matrix, default deny, IDOR, field stripping, scope | `SEC-AC-01` matrix (8 roles × 24 endpoints = 192 assertions), `SEC-AC-03` IDOR (guess public_id of another org/branch), `SEC-AC-05` field stripping over HTTP | 192/192 matrix cells match; 0 leaks |
| V5 Validation | Zod strict DTO, mass-assignment, type confusion, boundary | `SEC-VAL-01` extra/unknown fields rejected; money as number/float rejected; negative qty; huge strings (1 MB) → 413/400 | 0 500s |
| V6 Cryptography | Argon2id, AES-256-GCM credentials, hashing, no weak algos | `SEC-CRY-01` config assertions; `SEC-CRY-02` ciphertext randomness/IV uniqueness 1,000 samples; JWT `alg:none` rejected | 0 weak algorithms |
| V7 Errors & logging | no stack traces/secrets/PII; requestId; audit | `SEC-LOG-01` 500 body schema; log serializer snapshot; `SEC-LOG-02` audit on sensitive writes | 0 secret/PII patterns in logs (gitleaks-style regex on captured logs) |
| V8 Data protection | PII minimization, encrypted transport, no PII in URLs | `SEC-DAT-01` payload audit (phone masked where not needed); cookies Secure; no sensitive query params | 0 PII in GET URLs |
| V9 Communications | TLS/HSTS/CORS allowlist/headers | `SEC-HDR-01` asserts `Strict-Transport-Security`, `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`; CORS preflight from unlisted origin → no `Access-Control-Allow-Origin` | all 6 headers present; CORS allowlist exact |
| V10 Malicious code | dependency/supply chain | `pnpm audit --audit-level=high`, `gitleaks detect --redact`, semgrep (`p/owasp-top-ten`, `p/security-audit`, custom), Trivy fs + image, CycloneDX SBOM, license allowlist | high/critical = **0**; secrets = **0**; semgrep errors = **0**; Trivy critical = 0, high = 0 (documented exception ≤ 14-day SLA) |
| V11 Business logic | anti-abuse of pricing/refund/stock | `SEC-BIZ-01` negative price/refund > paid/coupon reuse/price race; `SEC-BIZ-02` repeated submit (idempotency) | 0 anomalies; 24 h replay window |
| V12 Files | upload magic-byte, size, path traversal, content-disposition | `SEC-FILE-01` EICAR + fake-extension + `../` filename + oversize file; S3 object not public | 100 % rejected; no public ACL |
| V13 API | rate limits, idempotency, pagination DoS, method/verb tampering, mass assignment, SSRF | `SEC-API-01` 429 thresholds (login 10/15 min; OTP 5/h; global per-user 1,000/min; export 10/h); `SEC-API-02` pagination limit > 100 rejected; `SEC-API-03` SSRF URL field rejects `127.0.0.1`, `169.254.169.254`, `file://` | rate-limit thresholds exact; SSRF 100 % blocked |
| V14 Config | production hardening, headers, debug off, default creds, docs off | `SEC-CFG-01…05` boot tests: docs 404 in prod, verbose errors off, secure cookies on, mock providers refuse prod, no default admin password; Dockerfile non-root/read-only; compose ports not public | 5/5 boot tests pass |
| **DAST** | OWASP ZAP baseline + authenticated scan | nightly against staging; fail on High/Critical | High/Critical = **0**; Medium ≤ 5 with owned tickets |
| **Dependency / supply chain** | lockfile frozen, provenance, SBOM | `pnpm install --frozen-lockfile` in CI; SBOM artifact; Trivy DB updated weekly | see V10 |

Threat-model coverage: controls are traced to `docs/04-security/THREAT-MODEL.md` STRIDE entries —
test ID column is added there; a missing mapping fails security review (checklist in
`docs/04-security/SECURITY.md` §9, which release gate #5 references).

**Security fixes / exceptions:** any accepted risk needs an ADR addendum or a tracked exception with
owner, expiry (≤ 90 days), and compensating control. Expired exceptions fail the nightly job.

---

## 14. CI pipeline (`.github/workflows/ci.yml`, `nightly.yml`, `release.yml`)

### 14.1 PR pipeline (target wall-clock ≤ **15 min**)

| Stage | Job | What runs | Timeout | Required |
|---|---|---|---|---|
| 1 | `setup` | checkout, pnpm cache, `pnpm install --frozen-lockfile` | 5 min | — |
| 2a | `static` | `format:check`, `lint`, `typecheck` | 6 min | ✅ |
| 2b | `unit` | Vitest unit project, matrix `tz: [Asia/Tehran, UTC]`, `--shard` × 3 | 6 min | ✅ (aggregate) |
| 2c | `integration` | Testcontainers PG/Redis/MinIO, `--shard` × 2, invariant harness after each shard | 12 min | ✅ |
| 2d | `contract` | OpenAPI snapshot, permission/route audit, `oasdiff breaking` vs `main` | 4 min | ✅ |
| 2e | `security-static` | gitleaks, semgrep, `pnpm audit --audit-level=high`, Trivy fs, license check | 8 min | ✅ |
| 2f | `build` | `pnpm build` (api, web, worker), Dockerfile build (no push) | 8 min | ✅ |
| 3 | `e2e-smoke` | compose up, migrate/seed, Playwright `@smoke` × 3 device projects | 12 min | ✅ (blocks `main`) |
| 4 | `report` | merge coverage, junit, publish PR comment (coverage delta, flaky list) | 2 min | — |

Concurrency: `concurrency: ci-${{ github.ref }}`, cancel-in-progress on PRs. Path filter: docs-only PRs
still run `static` + `contract` (5 min) but may skip integration only with the `docs-only` label.
Node **22.x pinned** (`actions/setup-node`), pnpm **11.6.0** via corepack; ubuntu-latest runner
(Docker available for Testcontainers).

### 14.2 Nightly (`nightly.yml`, 02:00 Tehran time)

- full E2E (`@smoke` + `@regression`, 5 device projects);
- full ZAP baseline + authenticated scan against staging;
- invariant suite against staging clone (read-only) + partition maintenance dry-run;
- mutation testing (Stryker, engines) and property tests with 50,000 cases;
- `LOAD-01`, `LOAD-02` against staging; weekly Saturday **`LOAD-04` soak 4 h** and `LOAD-03` stress;
- full Trivy image scan with fresh DB; SBOM upload;
- flaky report: tests that failed then passed in last 7 days, with owners.

Failures notify the owning module channel and open/refresh a tracking issue automatically (single
issue per test ID, deduplicated).

### 14.3 Release pipeline (`release.yml`, tag `v*`)

Required green before tag/publish: all PR gates, full E2E, nightly security, `LOAD-02` + `LOAD-03`
results attached, plus release rehearsals:

| ID | Rehearsal | Pass criterion |
|---|---|---|
| `REL-01` | `docker compose up -d --build` on clean Ubuntu 24.04 host | all services `healthy`; `db:migrate` + `db:seed` succeed; login page reachable over HTTPS |
| `REL-02` | backup/restore | `pg_dump -Fc` → restore into fresh container → **E2E smoke passes**; RPO ≤ 15 min / RTO ≤ 1 h evidenced by timestamps |
| `REL-03` | upgrade/rollback | previous tag → current: migrations apply, app boots, `ROLLBACK` restores previous image with DB backup restore; no data loss |

Artifacts & retention:

| Artifact | Path | Retention |
|---|---|---|
| JUnit XML (all layers) | `reports/junit/**` | 30 days |
| Coverage (lcov + cobertura) | `reports/coverage/**` | 30 days |
| Playwright report/traces/videos | `reports/playwright/**` | 14 days (traces 7) |
| k6 summary JSON + HTML | `reports/k6/**` | 90 days |
| Security SARIF (semgrep/trivy/zap) + SBOM | `reports/security/**` | 90 days |
| invariant report | `reports/invariants/**` | 30 days |

Branch protection on `main`: require the **7 required checks** (`static`, `unit`, `integration`,
`contract`, `security-static`, `build`, `e2e-smoke`), 1 approving review, linear history, no force
push, no direct push. Required checks are exactly these names; renaming a job requires updating
branch protection in the same PR (documented in `README`). The local-verify split in §20-D4 does
**not** remove integration/contract (or `e2e-smoke`) from required CI — it only defines which
commands a developer must run locally before pushing.

---

## 15. Local verification contract (`pnpm verify`)

**Decision (§20-D4):** `pnpm verify` = **lint + typecheck + unit + build** (fast PR gate, ≤ 12 min).
`pnpm verify:full` = `verify` + **integration + contract**. **E2E, security scans and k6 are
release-gate/nightly jobs and are never part of `verify` or `verify:full`.** CI still runs
integration/contract on every PR (superset of the local gate); `verify:full` is the local mirror of
the CI code gate. This updates the wording of `README.md` §7 G2 (which listed integration inside
`verify`); the decision is recorded in §20-D4.

Current root `package.json` only runs `lint && typecheck && test && build`; it **must be extended**
(tracked as a P1 implementation task) to the contract below.

```jsonc
{
  "scripts": {
    "verify": "pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build",
    "verify:fast": "pnpm lint && pnpm typecheck && pnpm test:unit",
    "verify:full": "pnpm verify && pnpm test:int && pnpm test:contract",
    "test:unit": "vitest run --project unit",
    "test:int": "vitest run --project integration",
    "test:contract": "vitest run --project contract",
    "test:security": "vitest run --project security",
    "test:invariants": "tsx scripts/invariants.ts",
    "test:e2e": "playwright test --grep @smoke"
  }
}
```

| Rule | Detail |
|---|---|
| Preconditions (`verify`) | Node 22+, pnpm 11.6.0, no Docker needed — unit + build only. |
| Preconditions (`verify:full`) | Docker Desktop/Engine (Testcontainers) or explicit `DATABASE_URL_TEST`, `REDIS_URL_TEST`, `S3_ENDPOINT_TEST`. If Docker is missing and no URLs are set, `test:int` **fails**, never silently skips (`SKIP_INTEGRATION=1` requires an explicit reason env and prints a warning). |
| Runtime target | `pnpm verify` ≤ **12 min** on 8-core/16 GB; `verify:fast` ≤ **90 s** (pre-push hook); `verify:full` ≤ **20 min** (integration ≤ 8 min with 4 workers + contract ≤ 2 min). |
| Pre-push | Husky hook runs `verify:fast`; CI remains the authority. |
| CI mapping | CI `static` + `unit` + `build` == `verify`; adding `integration` + `contract` == `verify:full`. Nightly/release add `e2e-smoke`, `e2e-full`, `security`, `LOAD-*` — these are **not** local `verify` obligations. |
| Failure semantics | any non-zero exit code fails; no `--passWithNoTests`; coverage thresholds enforced inside Vitest config, not by review. |
| Reproducibility | pinned tool versions (`packageManager`, Node engines), frozen lockfile; Testcontainers images pinned by digest in `test/setup/images.ts`. |

---

## 16. Flaky-test policy

- **Definition:** a test that fails and then passes on the same commit without code change, or fails
  in < 100 % of reruns.
- **Detection:** CI stores per-test history; nightly job flags any test with ≥ 2 failures in its last
  20 runs. Per-PR automatic retries are allowed **only** in Playwright (max 2) and only for
  `@e2e`; unit/integration retries are **0** — infrastructure transient failures are retried by the
  harness at the container/health-check level, not by re-running assertions.
- **Quarantine:** after detection, the owning module adds `test.fixme('QUAR-<issue> …')` within **1 business day**
  and files a `flaky-test` issue with owner. Quarantined tests are excluded from required checks but
  still executed in nightly; they must be fixed or deleted within **10 business days**. Quarantine
  count > **3** blocks the release (§20-D5).
- **Budget:** ≤ **3** quarantined tests at any time; flaky rate ≤ **1 %** of runs/week. Weekly QA
  report publishes the list; the Lead signs it in the release checklist.
- **No silent skips:** `test.skip`/`.only`/`describe.skip` in committed code fails the static gate
  unless the title contains `QUAR-` or `WIP-` with an issue link in the comment.

---

## 17. Acceptance criteria per module (mapped to overview §7) & Definition of Done

Overview §7 release gates are referenced as **G1** (`compose up`+migrate/seed), **G2** (`pnpm verify`
+ `pnpm verify:full` green, per §20-D4), **G3** (E2E smoke chain), **G4** (100-parallel no oversell),
**G5** (security checklist + audit clean), **G6** (backup/restore + smoke).

| Module | Acceptance criterion | Verification | Gate |
|---|---|---|---|
| platform (config/audit/files/health/jobs) | health endpoints correct; config fails fast; audit append-only; files validated; outbox/partition jobs scheduled | `U-OBX-10/13`, `I-ENV-01…05`, `SEC-FILE-01`, `SEC-CFG-01…05` | G2, G5 |
| identity / auth | OTP rules exact; refresh reuse revokes family; RBAC default-deny; denial audited; lockout | `U-AUTH-01…28`, `U-RBAC-01…20`, `SEC-AUTH`, `SEC-SES`, `SEC-AC` | G2, G5 |
| org / tenancy | every query scoped; cross-org access 404; composite FKs | `U-RBAC-10…14`, `I-SEC-01`, `INV-12` | G2, G5 |
| catalog | 10k+ SKU CRUD; barcode uniqueness; variant/SKU search p95; soft delete filters | `U-WEB-17…22`, `E2E-SM-03`, `LOAD-02` read thresholds, `I-RPT-01` | G2, G3 |
| inventory | append-only ledger; `on_hand = Σ ledger`; FIFO/WA correct; backdated receipt safe; negative stock impossible; 100-parallel no oversell | `U-INV-01…18`, `C-ALLOC-01…05`, `C-INV-01…03`, `INV-01…05/13`, `PROP-INV-01`, `LOAD-06` | **G2, G4** |
| warehouse | two-stage scan verification; wrong barcode blocked; putaway/label/cycle count correct | `U-WHS-01…10`, `E2E-SM-07/08/14`, `I-ORD-01` | G2, G3 |
| sales / fulfillment | state machine; all-or-nothing allocation; pick→pack→ship; cancel/partial rules | `U-SAL-01…07`, `U-FUL-01…05`, `C-ALLOC-03`, `I-ORD-01` | G2, G3, G4 |
| procurement | receipt creates correct layers/cost; over-receipt blocked; 3-way match | `U-PUR-01…06`, `I-PUR-01` | G2, G3 |
| pricing | formula cost+markup+commission+tax; margin guard; HALF_UP; snapshots | `U-PRC-01…24`, `U-MON-01…13`, `PROP-PRC-01` | G2, G5 |
| channels | canonical-only; webhook HMAC/replay; mapping/order idempotency; retry/DLQ; secrets encrypted; no TBD calls | `U-CHN-01…22`, `C-CHN-01/02`, `I-CHN-01…04`, `SEC-CHN-06`, `CT-EGRESS-01` | G2, G5 |
| accounting | every journal balanced; period lock; reversal-only; gap-free numbering; trial balance/P&L/BS correct (**API is source of truth**, UI renders only); valuation snapshots | `U-ACC-01…26`, `C-NUM-01`, `C-ACC-01`, `INV-06…09`, `I-ACC-01`, `I-ORD-01` | **G2, G3** |
| treasury / partners | cheque state machine exactly `registered → in_hand → deposited → collected` + `endorsed/returned/bounced/cancelled`; 64-cell transition matrix; journals on collect/return/bounce; due alerts; no double transition; profit distribution balances | `U-TRS-01…16`, `C-TRS-01`, `I-TRS-01`, `INV-15` | G2, G3 |
| reporting | Jalali ranges; trial balance/P&L/BS equal recomputation; exports; read-only role; paths from generated client only | `U-RPT-01…06`, `U-CAL-07`, `I-RPT-01` | G2, G3 |
| web / UX | all smoke journeys pass; RTL/a11y zero critical; device matrix; no token in storage | `E2E-SM-01…14`, `E2E-RG-01…12`, `@a11y` checks, `U-WEB-01…30` | G3, G5 |
| operations | compose install healthy; backup/restore drill with smoke; migrations explicit; upgrade/rollback | `REL-01…03` | G1, G6 |

### Definition of Done (any feature / release)

1. Unit tests named per §6 for every new rule/engine; count target met per module.
2. Integration test(s) for every new endpoint and every cross-module effect; invariants still green.
3. Permission added to `packages/shared/permissions.ts` + role template + route decorator; `CT-PERM-01/02` green.
4. Migration added (no edit of merged migrations), `I-ENV-01/04` green; seed idempotent.
5. Audit log written for sensitive writes; denial path audited where applicable.
6. OpenAPI snapshot updated; `CT-OAS-01/03` green; error registry updated.
7. E2E smoke updated if a user-visible journey changed; a11y checks green.
8. Coverage thresholds met for touched code; diff coverage ≥ 85 %; no new `test.skip`/`only`.
9. No quarantine added; if a test became flaky it is fixed (not deleted) and the issue closed.
10. Security: no new Semgrep/Trivy/audit findings; threat-model mapping updated if a boundary changed.
11. Docs updated (`05-testing` counts/invariants, `03-api-contract` if contract changed, `07-operations` if runbook changed).
12. Release checklist (G1–G6) signed by Lead; all required CI checks green on the release commit.
13. R1 remediation: if the change touches accounting/treasury/inventory costing or authz/files/webhooks, the corresponding §21 case exists and is green; no R1 blocker/high finding mapped to the change is deferred.
14. Evidence: every `SECURITY.md` §9 control row touched by the change links route file + test ID + CI artifact (`CT-EVID-01`).

---

## 18. Traceability — ADR invariants → named tests (self-review checklist)

| Source | Invariant / decision | Tests |
|---|---|---|
| ADR-0007 §1 | append-only ledger, never updated, corrections via reversal | `U-INV-01/17`, `C-INV-02`, `INV-07` |
| ADR-0007 §2 | balance projection in same transaction; CHECK on_hand/reserved/available ≥ 0; no trigger logic | `U-INV-02`, `C-INV-01/03`, `INV-01/03/04`, `I-ENV-02` |
| ADR-0007 §3 | reservation rows active→consumed/released/expired; fixed lock order; all-or-nothing; `RULE_VIOLATION INSUFFICIENT_STOCK` per line; lifecycle owned by `fulfillment`, 5-min maintenance expiry (§20-D1) | `U-RES-01/04/05/07/08/12/13/18`, `C-ALLOC-01…05`, `LOAD-06` |
| ADR-0007 §4 | `available = on_hand − reserved − safety_buffer − damaged`; channels get available; `reserved + safety_buffer + damaged <= on_hand` | `U-RES-03/15`, `U-CHN-15`, `U-INV-26`, `C-INV-04`, `INV-04/18`, `PROP-INV-03` |
| ADR-0007 §5 | serial/unit traceability only where tracked | `U-INV-12`, `U-SAL-04` |
| ADR-0007 §6 | FIFO cost layers / moving average; `inventory_valuation_method` company-wide, per-variant override removed in v1 (D2-r1), layers per `(warehouse_id, variant_id)` with layer consumptions, runs aggregate per variant (§20-D2); valuation runs snapshot | `U-INV-03…08/15`, `U-INV-19…25`, `INV-13/17`, `I-PUR-01`, `I-ORD-01`, `I-INV-03` |
| ADR-0007 §7 | mandatory 100-parallel test; concurrent receipt+sale preserves ledger sum | `C-ALLOC-01`, `C-INV-01` |
| ADR-0007 consequences | nightly consistency job compares Σ ledger vs balances | `U-INV-18`, `INV-01` nightly |
| ADR-0008 §1 | permissions code-defined, seeded, `is_system` immutable | `U-RBAC-01/02`, `CT-PERM-02/03` |
| ADR-0008 §2 | `@Permissions` + `@Scope`, default-deny (route without decorator fails CI) | `CT-PERM-01`, `U-RBAC-04/06/15` |
| ADR-0008 §3 | cost/price/margin field stripping | `U-RBAC-05`, `SEC-AC-05` |
| ADR-0008 §4 | scope narrowing from token claims in repositories | `U-RBAC-06/10/15`, `I-SEC-01` |
| ADR-0008 §5 | SoD workflows; requester ≠ approver | `U-RBAC-07/08`, `U-ACC-15`, `U-PUR-03`, `U-TRS-06`, `U-PRC-12` |
| ADR-0008 §6 | permission cache keyed by `permissions_version`, bumped transactionally | `U-AUTH-28`, `U-RBAC-17`, `SEC-SES-03` |
| ADR-0008 §7 | every denial audited with route + actor | `U-RBAC-09`, `SEC-LOG-02` |
| ADR-0010 | outbox in same tx; SKIP LOCKED; backoff 30 s→1 h; DLQ at 10; idempotent handlers; exactly-once effects; metrics | `U-OBX-01…14`, `C-OBX-01`, `I-OBX-01`, `INV-14` |
| ADR-0013 | money bigint IRR, string JSON, no float, HALF_UP, rates precision, currency guard | `U-MON-01…13`, `PROP-MON-01/02`, `CT-MONEY-01`, `U-INV-02` |
| ADR-0014 | Jalali at edges, Gregorian storage; fiscal year/periods; period lock; gap-free never-reused numbers | `U-CAL-01…18`, `C-NUM-01`, `U-ACC-04/08/09/10/22`, `INV-09` |
| ADR-0004 | access 10 min memory token; refresh 7 d rotated; reuse revokes family; OTP 6/120 s/5 per h/5 attempts; 2FA device 30 d; lockout | `U-AUTH-01…28`, `SEC-AUTH`, `SEC-SES`, `SEC-CFG` |
| ADR-0005 | repository-level org scoping; no RLS; composite FKs high-risk | `U-RBAC-10…14`, `INV-12`, `CT-SCOPE-01`, `I-SEC-01` |
| ADR-0006 | canonical model only; raw payload before parse; natural-key idempotency; retries/DLQ; encrypted creds; TBD flags | `U-CHN-01…22`, `C-CHN-01/02`, `I-CHN-01…04` |
| ADR-0009 | monthly partitions; maintenance creates next 2 months; BRIN; retention; missing partition alert | `I-PRT-01`, `C-PRT-01`, `INV-14` |
| ADR-0003 | migrations own DDL; soft delete filters; optimistic `version`/If-Match; naming; no float | `I-ENV-01/04`, `CT-VER-01`, `U-MON-11`, `U-MON-12`, `CT-MIG-01` |
| ADR-0012 / README §7 G1/G6 | compose install healthy, explicit migrate/seed, backup/restore smoke, upgrade/rollback | `REL-01/02/03` |
| Lead decision §20-D3 | cheque FSM exactly `registered → in_hand → deposited → collected` + `endorsed/returned/bounced/cancelled`; 64-cell transition matrix | `U-TRS-03…08`, `C-TRS-01`, `I-TRS-01` |
| Lead decisions §20-D4/D6/D7 | verify split; stable QA IDs with generated-client paths; API is accounting source of truth (DOM render-only) | `REL-01`, `CT-OAS-01/03`, `I-RPT-01`, `E2E-SM-10` |
| §20.1 D2-r1 / D3-r1 | valuation cost-layer ledger + method-change policy; cheque FSM extended (issued direction, endorsement payee, pre/post-collect bounce) | `U-INV-19…25`, `INV-17`, `I-INV-03`, `U-TRS-17…21`, `I-TRS-02` |
| §21 R1 remediation | every R1-accounting and R1-security finding has a named regression test (mapping in §21.12/§21.13) | §21 full set: `U-ACC-27…50`, `U-COA-01…05`, `U-INV-19…26`, `U-CAL-19…21`, `U-MON-23…27`, `U-TRS-17…21`, `U-PAY-01…06`, `I-ACC-02…04`, `I-COA-01`, `I-INV-03/04`, `I-CLS-01`, `I-PER-01`, `I-TRS-02/03`, `C-INV-04`, `CT-POST-01/COA-01/PERM-05/EVID-01`, `SEC-*` 34 cases, `INV-17/18`, `PROP-*` 4 |

**Self-review result:** all ADR-0007 and ADR-0008 decisions above have at least one named test, every
numeric threshold in this document is a pass/fail value (no “reasonable”, “fast”, “secure” without a
number), all seven Lead decisions from §20 are implemented in the named suites they reference, and
every round-1 finding has a named test in the §21 remediation traceability tables (§21.12/§21.13).

---

## 19. Risks & maintenance

| # | Risk | Mitigation |
|---|---|---|
| R1 | Repo currently has no test tooling/config (P1 scaffolding only); this document is the contract the implementation must satisfy | P1 task adds Vitest/Playwright/k6 configs + scripts exactly as §3/§15; PR cannot merge until `pnpm verify` and `pnpm verify:full` exist and are green |
| R2 | Testcontainers requires Docker; Windows dev machines without WSL2 cannot run integration | CI is authoritative; document `DATABASE_URL_TEST` fallback; `SKIP_INTEGRATION` forbidden in CI |
| R3 | Data-model physical names may drift while DATA-MODEL.md lands | factories are the single mapping layer; test IDs stable; `I-ENV-04` drift test catches schema mismatch; report paths injected via generated client (§20-D6) |
| R4 | Persian calendar oracle differs from `Intl` in edge years | hand-written fixtures for 1403/1404/1405/1408 + round-trip property; no third-party calendar extension (ADR-0014) |
| R5 | Concurrency tests can be flaky on slow CI runners | deterministic barriers, no sleeps, 10 s polling caps, pinned images, concurrency project serialized; quarantine policy §16 |
| R6 | Load tests need a production-like host; results on smaller runners mislead | staging compose profile (4 vCPU/8 GB) + snapshot restore; thresholds are the contract; soak weekly, not per-PR |
| R7 | Digikala contract is partly unknown (`TBD-DIGIKALA`) | excluded from test contract by design; adapter unit tests on confirmed fixtures; release gate records open flags |
| R8 | Mutation/nightly suites can outgrow budget | timeboxed (soak 4 h, mutation ≤ 20 min); trend report, not blocker except release |
| R9 | Cheque FSM and valuation/reservation decisions (§20) must reach the data model + API contract | module owners update `02-data-model` and `03-api-contract` accordingly; test IDs already encode the expected behaviour, so implementation drift fails CI |

The v1.0 open questions are **closed**; the Lead's answers are recorded as normative decisions in
§20. New questions during implementation are raised in the design-review rounds and, if they change
behaviour, require a v1.1 revision note at the top of this document.

---

## 20. Lead decisions (v1.0-draft freeze, 1405-07-27; v1.1 amendments)

These decisions are normative and supersede any conflicting wording elsewhere in this document or in
`README.md` §7. They were signed off by the Lead on 1405-07-27; `TESTING.md` was frozen at
**v1.0-draft** from that date and revised to **v1.1-revised** after round 1 (§20.1).

| ID | Decision | Where reflected | Tests that lock it |
|---|---|---|---|
| **D1** | `fulfillment` module owns reservation lifecycle. A `maintenance` queue job expires stale reservations **every 5 min**. Defaults: channel orders **120 min** (per-channel override), manual/POS **1440 min** (24 h). Expiry emits `reservation.expired` → release + audit. Boundary-at-TTL and idempotent-release tests are mandatory. | §4.1 env (`RESERVATION_CHANNEL_TTL_MINUTES`, `RESERVATION_MANUAL_TTL_MINUTES`), §6.4 | `U-RES-05/07/08/10/18`, `C-RES-01`, `I-ORD-01` |
| **D2** | Valuation method is company-wide: `inventory_valuation_method` = `fifo` (default) \| `weighted_average`. FIFO layers are per `(warehouse_id, variant_id)`. `inventory_valuation_runs` aggregates per variant for accounting. Test both methods incl. backdated receipt and negative-layer edge. | §6.3, §6.3 fixtures | `U-INV-05/06/07/08/15`, `INV-13`, `PROP-INV-01` |
| **D3** | Cheque state machine is exactly `registered → in_hand → deposited → collected`, with terminal branches `returned`, `bounced`, `endorsed`, `cancelled`. Full 64-cell transition-matrix test is required; journals: collect Dr bank / Cr cheque receivable; return/bounce = reversal + fee; endorse = ownership transfer, no cash journal. | §6.6 (matrix + rows), §8 `I-TRS-01`, §17 | `U-TRS-03…08`, `C-TRS-01`, `I-TRS-01` |
| **D4** | `pnpm verify` = **lint + typecheck + unit + build** (PR gate, ≤ 12 min). `pnpm verify:full` = `verify` + **integration + contract**. E2E, security and k6 are release-gate/nightly only — never part of `verify`/`verify:full`. CI PR jobs still run integration + contract as a superset. | §15, §2, §14.1, §17 G2 | §15 script contract; CI required checks |
| **D5** | Flaky budget approved: ≤ **3** quarantined tests at any time, 10-business-day fix SLA, owner + issue required; > 3 blocks release. | §16 | CI quarantine report; release checklist |
| **D6** | QA IDs (`I-RPT-01`, `E2E-SM-10`, all IDs in §3) are stable labels. Do **not** hardcode report paths or response shapes; consume them from `packages/shared` + the generated OpenAPI client once `API.md` is frozen. A contract change must break compilation, not silently drift. | §8, §11 preamble, §19 R3 | `CT-OAS-01/03`, `CT-EGRESS-01`, `I-RPT-01` |
| **D7** | Trial balance E2E source of truth is the API: assert `GET /api/v1/accounting/reports/trial-balance`. The UI check only verifies that rendered sums equal API values. Accounting truth is **never** derived from the DOM. | §8 `I-ORD-01`, §11 `E2E-SM-10`, §11 preamble, §17 | `E2E-SM-10`, `I-ORD-01`, `I-RPT-01` |

### 20.1 v1.1 revision notes (round-1 remediation)

Round-1 review `R1-accounting.md` (16 blockers, 14 high, 21 medium) and `R1-security.md` (6 blockers,
12 high, 10 medium) found design defects that change the expected behaviour of D2/D3. The Lead's
company-wide valuation decision stands; the conflicts are resolved below and locked by §21 cases.

| Decision | Amendment (v1.1) | R1 findings | New/revised cases |
|---|---|---|---|
| **D2-r1** | Keep D2 (company-wide `inventory_valuation_method`). **Remove the per-variant `cost_method` override from v1** (it made one warehouse/date run contain mixed methods); method change is prospective from an effective date, requires approval + `valuation_policy_version` stored on the run, and discloses the effect. FIFO becomes a true **cost-layer ledger** (`inventory_cost_layers` + `inventory_layer_consumptions`), moving average keyed per `(warehouse_id, variant_id)`; layers carry `received_at`; returns/transfers/reversals restore exact layers; nightly `Σ layer value = GL inventory`. | R1 B-07, H-02, H-03, M-05, M-06 | `U-INV-19…25`, `INV-17`, `I-INV-03`, revised `U-INV-15` |
| **D3-r1** | Keep the received-cheque FSM names (`registered → in_hand → deposited → collected` + terminal `endorsed/returned/bounced/cancelled`) and **extend** it per R1 B-13: add a distinct `direction='issued'` sub-FSM (`issued → issued_cleared / issued_bounced / issued_cancelled`), `endorsed_to` + `endorsement_date`, `bank_account_id` at deposit and `cleared_bank_transaction_id`; **bounce before collect and bounce after collect post different entries** (pre: Dr AR / Cr cheques on hand; post: Dr AR / Cr bank + fee). Matrix becomes 64 received-direction cells + the issued sub-matrix. | R1 B-13, L-03 | `U-TRS-17…21`, `I-TRS-02`, revised `U-TRS-03…08`, `U-ACC-21` |
| **D1/D4–D7** | Unchanged. | — | — |

**Freeze rule:** from 1405-07-27, changes to this document require a revision note (v1.1 is the
round-1 remediation); test-ID renames are forbidden (acceptance criteria and ADR traceability
reference them). Any future decision that changes a numeric threshold or an invariant must update
this table, the affected section, and the traceability matrix in the same change.

**Next-phase ownership (per Lead):** after the three design-review rounds, the QA/Test Architect
(a) reviews round-2 focus “testability of the shipped implementation” and (b) owns the actual test
harness (`apps/api/test/**`, `apps/web/e2e/**`, `infra/k6/**`) once coding starts. No test code is
written before that hand-off.

---

## 21. Round-1 remediation test set (v1.1)

**Purpose.** `docs/_review/round-1/R1-accounting.md` (16 blockers, 14 high, 21 medium, 6 low) and
`docs/_review/round-1/R1-security.md` (6 blockers, 12 high, 10 medium, 5 low) found design defects
that the v1.0 matrix does not prove against. This section adds **only new cases** (permanent IDs,
existing matrix untouched) plus the **†R1** index of revised cases. These cases are required for
round-1 exit and for release gates **G2** (verify full) and **G5** (security sign-off); until they
exist in code, `SECURITY.md` §9 and `DATA-MODEL.md` §6.10 remain unsigned.

**Scope of the numbers:** §21 adds **56 unit** (`U-ACC-27…50`, `U-COA-01…05`, `U-INV-19…26`,
`U-CAL-19…21`, `U-MON-23…27`, `U-TRS-17…21`, `U-PAY-01…06`), **11 integration/concurrency**
(`I-ACC-02…04`, `I-COA-01`, `I-INV-03/04`, `I-CLS-01`, `I-PER-01`, `I-TRS-02/03`, `C-INV-04`),
**4 contract** (`CT-POST-01`, `CT-COA-01`, `CT-PERM-05`, `CT-EVID-01`), **34 security**
(`SEC-*` below), **2 invariants** (`INV-17/18`) and **4 properties** (`PROP-MON-03…05`,
`PROP-INV-03`). New totals are in §21.14.

### 21.1 Posting matrix — one named test per business event (`U-ACC-27…44`)

Path: `apps/api/src/engines/posting.spec.ts` (matrix runner) + `apps/api/test/integration/accounting/*.int.spec.ts`.
Every case asserts **balanced legs**, **exact accounts**, and that the journal header totals equal the
sum of lines; any event without a rule fails `U-ACC-44`.

| ID | Named case | Exact assertion (Dr / Cr) | R1 |
|---|---|---|---|
| `U-ACC-27` | sale taxable | Dr AR gross; Cr sales revenue net; Cr VAT payable tax; Dr COGS at issue; Cr inventory; seller/buyer legal snapshot present | B-01, H-08 |
| `U-ACC-28` | sale exempt / zero-rated | no VAT leg; revenue = net; tax document marked exempt; COGS unchanged | B-01 |
| `U-ACC-29` | sale with line + header discount | line discount reduces net before tax; header discount allocated largest-remainder; VAT on discounted net; Σ lines = header | B-01, B-12, M-15 |
| `U-ACC-30` | sale tax-inclusive price | net = gross / (1+rate) rounded once; tax = gross − net; totals reconcile to the rial | B-01, B-12 |
| `U-ACC-31` | cash sale (invoice → payment) | revenue + VAT + COGS recognised exactly once; payment Dr bank/clearing Cr AR; no revenue at payment | B-01 |
| `U-ACC-32` | goods receipt (no invoice) | Dr inventory net landed cost **/ Cr GRNI** (never AP); input VAT only when valid tax invoice exists; freight/duty capitalised | B-02, H-14 |
| `U-ACC-33` | supplier invoice + 3-way match | Dr GRNI + Dr VAT receivable + Dr/Cr purchase-price variance / Cr AP; unmatched above tolerance blocked; duplicate-invoice check | B-02, H-06 |
| `U-ACC-34` | channel settlement | **assert NO sales-revenue credit**; Dr settlement clearing/bank + Dr commission/fee expense + Dr VAT-on-fee + Dr penalty/return adjustments / Cr channel receivable; residual → settlement variance | B-03, M-12 |
| `U-ACC-35` | sales return (restock) + VAT credit note | Dr sales returns net + Dr VAT payable / Cr AR or customer credit; inventory + COGS restored at original layer cost; credit-note tax document references original invoice | B-11, H-08 |
| `U-ACC-36` | sales return (scrap/damaged) | same revenue/VAT legs; inventory loss account used (not inventory asset restoration); approval above threshold | B-11, H-05 |
| `U-ACC-37` | refund of paid invoice | Dr AR/customer credit or refund payable / Cr bank; no revenue/VAT effect; refund ≤ paid and ≤ returned value | B-11, M-11 |
| `U-ACC-38` | stock adjustment loss (shortage/damage/expiry/scrap/theft) | cost from layer/average (zero-cost write-off rejected); separate L4 accounts per type; Dr loss / Cr inventory; approval threshold | H-05, M-07, M-20 |
| `U-ACC-39` | stock adjustment gain | Dr inventory / Cr gain account (side flip is representable; not an expense credit) | H-05, B-10 |
| `U-ACC-40` | valuation-run posting | only delta journal vs prior run; balanced; idempotent; `valuation_policy_version` on the run; no direct balance edit | B-07, H-02, M-04 |
| `U-ACC-41` | transfer accounting (dispatch/receive/partial) | Dr inventory-in-transit / Cr inventory source; Dr destination / Cr in-transit; partial receipt; destination layer created | H-04 |
| `U-ACC-42` | tax legs (fee VAT, withholding, VAT payment/refund, bad debt) | fee VAT and expense input VAT explicit; withholding payable account; VAT payment/refund; bad-debt allowance/write-off | H-07, M-20 |
| `U-ACC-43` | rule engine expressiveness + posted-document immutability | conditions, account resolvers, multi-entry groups, side flip; mandatory balanced-rule validator; posted journal/receipt/adjustment immutable except reversal; multi-dimension lines don't duplicate balances | B-10, H-11, H-13 |
| `U-ACC-44` | journal header totals + event-rule completeness | deferred trigger recomputes `total_debit/total_credit = Σ lines`; header mismatch rejected; **every §21.1 event has exactly one active balanced rule** with `rule_version_id` | H-12, B-10 |

**Contract `CT-POST-01`:** the posting matrix is a code-committed manifest (event → rule id → legs →
account resolvers); CI asserts every event listed in §21.1 has exactly one active rule, every rule's
legs balance, no rule references a missing account/resolver (together with `CT-COA-01`), and no
wildcard/`00x` account selection exists.

Integration scenarios for the matrix (path `apps/api/test/integration/accounting/`):

| ID | Scenario | Key assertions | R1 |
|---|---|---|---|
| `I-ACC-02` | purchase: receipt (GRNI) → supplier invoice (input VAT + price variance + 3-way match) → payment | GRNI cleared exactly; AP = invoice; VAT receivable; variance account; duplicate invoice blocked; trial balance balanced | B-02, H-06 |
| `I-ACC-03` | sale matrix over HTTP: taxable, exempt, line+header discount, tax-inclusive, cash sale | each posts the §21.1 legs; invoice net/tax/gross equal header; COGS at ship; no revenue at payment; trial balance balanced | B-01, B-12 |
| `I-ACC-04` | channel settlement | **no revenue credit at settlement**; fees/commission/VAT-on-fee/returns netted; channel receivable cleared; residual in settlement variance; trial balance balanced | B-03, M-12 |

### 21.2 CoA manifest (`U-COA-01…05`, `I-COA-01`, `CT-COA-01`)

Path: `apps/api/src/modules/accounting/coa-manifest.spec.ts`, `apps/api/test/integration/accounting/coa.int.spec.ts`.

| ID | Named case | Exact assertion | R1 |
|---|---|---|---|
| `U-COA-01` | exact manifest count + unique codes | seeded row count equals the manifest count (v1: 129 ± 0 after fix), every code unique, manifest hash matches fixture; code length fits `varchar(40)` | B-05, L-01 |
| `U-COA-02` | mandatory attributes + hierarchy | every row has non-null `account_type`, `normal_balance`, `nature ∈ {operational,contra,suspense,control}`, `postable`; parent is same org and exactly one level above; no self-parent | B-04, B-05, M-03 |
| `U-COA-03` | contra rows sign correctness | each contra row (`4-1-02`, `4-1-03`, `1-2-02`, `1-1-03-003`, `3-1-02`) has `normal_balance` opposite its natural side; reports derive signs from `normal_balance`, not `account_type` | B-04 |
| `U-COA-04` | every posting-rule account resolves | every account code/resolver key used by §21.1 rules exists and is postable; zero `00x`/wildcard codes | B-05, B-10 |
| `U-COA-05` | required accounts present | GRNI, settlement clearing, settlement variance, rounding gain/loss, legal reserve, income summary, retained earnings, withholding payable, VAT receivable/refundable, damage/expiry/scrap/theft/count-shortage/count-gain, customer-credit/prepayment, cash-over/short, cheques on hand/in collection/payable | B-05, H-05, H-07, B-13, B-14 |
| `I-COA-01` | seed from empty DB | `db:migrate && db:seed` produces exactly the manifest; second seed is idempotent; posting a sale/receipt/settlement/return succeeds with zero missing accounts | B-05 |
| `CT-COA-01` | manifest snapshot contract | committed manifest ↔ DATA-MODEL §6.3 ↔ seed are identical (single generated source); CI diff fails on any drift | B-05, H-01 |

### 21.3 FIFO cost-layer ledger (`U-INV-19…25`, `I-INV-03`, `INV-17`)

Path: `apps/api/src/engines/valuation.spec.ts`, `apps/api/test/integration/inventory/fifo-layers.int.spec.ts`.

| ID | Named case | Exact assertion | R1 |
|---|---|---|---|
| `U-INV-19` | repeated lot number → separate layers | two receipts with the same supplier `lot_no` produce **two** `inventory_cost_layers` rows (key includes receipt line + `received_at`); no merge | B-07, H-03 |
| `U-INV-20` | sale spanning layers consumes in FIFO order | issue 8 across (5 @100, 10 @150) writes two `inventory_layer_consumptions` rows (5@100, 3@150); ledger line keeps per-layer detail; COGS = 950 | B-07, M-05 |
| `U-INV-21` | return restores exact consumed layers | returned qty re-credit goes back to the same layers/consumptions (reverse of issue), not to a new layer; COGS reversed exactly | B-07 |
| `U-INV-22` | transfer moves the layer | dispatch moves qty/cost to an in-transit layer; receive materialises the layer at destination with original unit cost; no blended cost | B-07, H-04 |
| `U-INV-23` | reversal restores layers | reversal of an issue restores `qty_remaining`/`cost_remaining` and writes reversal consumption rows; replay is idempotent | B-07, H-11 |
| `U-INV-24` | layer residual + average-cost state | `cost_remaining = round(qty_remaining × unit_cost)` within tolerance; residual written off on depletion; moving-average state per `(warehouse_id, variant_id)` recalculated on receipt/issue | B-07, M-06, H-02 |
| `U-INV-25` | method policy | company-wide `fifo | weighted_average`; no per-variant override in v1; method change = prospective from effective date + approval + `valuation_policy_version`; standard cost rejected | H-02, L-04 |
| `I-INV-03` | layer lifecycle e2e | receipt (landed cost) → sale spanning layers → return → transfer → reversal: layer quantities/costs, ledger, balance and GL inventory all reconcile; nightly job reports zero drift | B-07, H-03, H-04 |
| `INV-17` | layer-vs-GL nightly reconciliation | `Σ cost_remaining` per variant/warehouse = GL inventory balance; drift injected → job reports exact delta + alert, no auto-fix; control accounts (AR/AP/inventory) reconcile to subledgers | B-07, M-04 |

### 21.4 Existing v1.0 cases revised in v1.1 (†R1 index)

The v1.0 matrix is preserved; the following cases were **extended** (not replaced) by R1 findings:

| Case | Revision | R1 finding |
|---|---|---|
| `U-MON-04`, `U-MON-06` | net/tax/gross each rounded once; tax on net, not gross | B-12, M-21 |
| `U-PRC-01`, `U-PRC-05` | price feeds separate net/tax/gross; margin guard on net-of-commission/net-of-VAT | B-01, B-12 |
| `U-INV-02`, `U-INV-10` | `available` includes `damaged`; CHECK `reserved + safety_buffer + damaged <= on_hand` | B-06 |
| `U-INV-15` | company-wide method; per-variant override removed; policy version | H-02, D2-r1 |
| `U-ACC-02` | full sale legs incl. VAT, shipping revenue, COGS at issue | B-01, B-10 |
| `U-ACC-08` | period derived from `entry_date`; supplied period must agree; `FOR SHARE` lock | B-09, B-16 |
| `U-ACC-16` | tax account mapping per rate/type; credit-note type | B-11, H-07 |
| `U-ACC-20` | settlement never credits revenue; fees/VAT netted; variance account | B-03 |
| `U-ACC-21` | full cheque journal set incl. deposit, issued, bounce-before/post-collect | B-13 |
| `U-TRS-03…08` | R1-extended FSM (issued direction, endorsed_to, bank links) | B-13 |
| `U-AUTH-17` | device trust requires server-issued secret; fingerprint is a label | B-02 |
| `U-RBAC-07` | SoD by guard + DB `approval_id`; approval-config governance | B-04 |
| `U-CAL-08`, `U-CAL-09` | EXCLUDE range constraints; period 13 allowed per rules | B-09, M-01 |
| `I-RET-01` | adds VAT credit note + original-layer COGS restoration | B-11 |
| `I-PUR-01` | landed cost capitalised into layers (freight/duty/customs), GRNI instead of AP | B-02, H-14 |
| `I-RPT-01` | multi-dimension slice from journal lines; dimension-set no double count | H-13, M-04 |
| `U-ACC-05`, `U-ACC-06` | posted journals/headers immutable; reversal required; header totals recomputed | H-11, H-12 |
| `U-RES-06` | consumption links reservation → ledger transaction (one consumption) | M-08 |
| `U-RBAC-01`, `U-RBAC-16` | single generated permission registry (314 vs 412 resolved), matrix regenerated from it | B-06 (R1-security) |

### 21.5 Balance invariant — buffer + damaged (`U-INV-26`, `C-INV-04`, `INV-18`, `PROP-INV-03`)

| ID | Named case | Exact assertion | R1 |
|---|---|---|---|
| `U-INV-26` | damaged/buffer availability | `available = on_hand − reserved − safety_buffer − damaged ≥ 0`; service rejects any state violating `reserved + safety_buffer + damaged <= on_hand`; channels receive `available` | B-06 |
| `C-INV-04` | 100 parallel allocators with non-zero buffer/damaged | on_hand 10, reserved 0, safety_buffer 2, damaged 1 → 7 parallel qty-1 allocations succeed, 93 conflicts; zero negative `available` at every poll; final CHECK holds | B-06, ADR-0007 §7 |
| `INV-18` | availability invariant SQL | no row with `reserved + safety_buffer + damaged > on_hand` or `available < 0` exists at any integration teardown/nightly | B-06 |
| `PROP-INV-03` | availability property | random on_hand/reserved/buffer/damaged sequences: available non-negative and equals the formula after every operation | B-06 |

### 21.6 Closing run (`U-ACC-45…49`, `I-CLS-01`)

| ID | Named case | Exact assertion | R1 |
|---|---|---|---|
| `U-ACC-45` | P&L close | closing run zeroes all revenue/expense accounts into income summary; P&L accounts balance = 0 after posting; closing journals link to a closing-run record | B-08, L-06 |
| `U-ACC-46` | income summary → retained earnings → legal reserve | net profit: Dr income summary / Cr retained earnings; legal reserve appropriation 5 % of net profit until 10 % of capital (configurable), then remainder to retained earnings | B-08, H-09 |
| `U-ACC-47` | opening entries | next-year opening entries generated for every balance-sheet account; opening trial balance balances; balances carry exactly (no P&L carry-over); migration import path tested | B-08 |
| `U-ACC-48` | close blocked until run posted | `fiscal_year.close` rejected until closing run journals posted; distribution approved only from retained earnings after close; open drafts block close | B-08 |
| `U-ACC-49` | loss year + distribution | loss allocated to partner current accounts/retained earnings (`loss_share`); no dividend without approval; ownership sum = 100 %; shares distributed largest-remainder so Σ shares = distributable amount; withholding applied by shareholder type | H-09, M-18, M-19 |
| `I-CLS-01` | year-end close e2e | full-year fixture → close run → opening balances → trial balance + balance sheet balanced at both year ends; distribution blocked before close and posted after; audit trail complete | B-08, H-09 |

### 21.7 Period integrity (`U-CAL-19…21`, `U-ACC-50`, `I-PER-01`)

| ID | Named case | Exact assertion | R1 |
|---|---|---|---|
| `U-CAL-19` | range overlap rejected | `EXCLUDE USING gist` on fiscal years and periods: overlapping ranges fail; adjacent ranges succeed; same-org scoped | B-09, M-01 |
| `U-CAL-20` | entry_date ↔ period constraint | period derived from `entry_date`; supplied `period_id`/`fiscal_year_id` disagreeing with the date → `VALIDATION_ERROR`; no period can be resolved ⇒ rejected | B-09, M-14 |
| `U-CAL-21` | period 13 + status history | `period_no <= 13` allowed with explicit 13th-period adjustment rules; closed period rejects posting; reopen requires reason + approval and appends status history (no overwrite) | B-09, M-01, M-17 |
| `U-ACC-50` | closed-period guard covers inventory | inventory receipt/issue resolves period and locks it `FOR SHARE` **before** ledger write; closed period ⇒ whole transaction rejected, zero ledger rows, zero outbox rows | B-16, M-14 |
| `I-INV-04` | closed-period inventory integration | receive/issue into a closed period fails `PERIOD_CLOSED` and leaves **zero** ledger rows and zero balance changes; same operation in the open period succeeds with journal | B-16 |
| `I-PER-01` | period boundary integration | concurrent post at period last instant vs next period; EXCLUDE overlap attempt; closed-period receipt/issue rejected with rollback; 13th-period adjustment posted and reported | B-09, B-16 |

### 21.8 Invoice rounding & largest-remainder (`U-MON-23…27`, `PROP-MON-03…05`)

| ID | Named case | Exact assertion | R1 |
|---|---|---|---|
| `U-MON-23` | line net/tax/gross as separate bigints | `net = round_half_up(qty × unit_price) − discount`; `tax = round_half_up(net × rate)`; `gross = net + tax`; all `bigint`; fractional qty (`1.3333`) never produces a fractional bigint | B-12 |
| `U-MON-24` | header discount largest-remainder | discount allocated by largest remainder so Σ allocated = header discount exactly; tax recomputed per line on discounted net | B-12, M-15, M-21 |
| `U-MON-25` | Σ lines = header | `subtotal = Σ net`, `tax = Σ tax`, `grand = subtotal − header_discount + tax + shipping`; no line-tax double count | B-12 |
| `U-MON-26` | rounding-residual account | any residual (rate/rounding) posts to the seeded rounding gain/loss account so the journal balances within ±0 rial; P&L/receivables difference explained | M-21 |
| `U-MON-27` | rate convention | API uses decimal fraction (`0.1` = 10 %) or `ratePercent` (documented one only); `10` rejected with clear error; tax-rate effective windows cannot overlap; `is_default` only VAT | M-02, L-02 |
| `PROP-MON-03` | fractional qty property | for random qty (`0.0001…10^4`, 4 dp), unit price and rate: net/tax/gross are integers, `gross = net + tax`, `tax ∈ {floor,ceil}(net×rate)` | B-12 |
| `PROP-MON-04` | largest-remainder property | for 1…20 random lines with random header discount: Σ allocated = discount, no line negative, deterministic for fixed input order | B-12, M-21 |
| `PROP-MON-05` | document sum property | Σ lines = header for random lines/discounts/tax rates; journal balances exactly after residual posting | B-12, M-21 |

### 21.9 Cheque FSM extended (`U-TRS-17…21`, `I-TRS-02`)

| ID | Named case | Exact assertion | R1 |
|---|---|---|---|
| `U-TRS-17` | bounce before vs after collect | bounce from `in_hand`/`deposited`: Dr AR / Cr cheques on hand/collection (no bank); bounce after `collected`: Dr AR / Cr **bank** + bank charge; bank balance changes only in the post-collect case | B-13 |
| `U-TRS-18` | endorsement + issued | endorsement sets `endorsed_to`, `endorsement_date`, guarantee memo, Dr AP / Cr cheques on hand; `issued` sub-FSM (`issued → issued_cleared/issued_bounced/issued_cancelled`) posts Dr AP / Cr cheques payable then Dr cheques payable / Cr bank | B-13, L-03 |
| `U-TRS-19` | deposit/collect state custody | `in_hand → deposited` moves cheques-on-hand → cheques-in-collection; collect moves in-collection → bank; both record `bank_account_id`/`cleared_bank_transaction_id`; amounts on events required for value-moving transitions | B-13, L-03 |
| `U-TRS-20` | issued-cheque matrix + amount events | every legal/illegal cell in the issued direction; `Σ event amounts <= cheque.amount` for partial events; terminal states reject transitions | B-13, L-03 |
| `U-TRS-21` | cheque status history | append-only event history; each transition stores actor/time/reason/bank and reconciles to cheque current state | B-13, M-17 |
| `I-TRS-02` | full cheque lifecycle e2e | receive → hold → deposit → collect; parallel bounce variants; endorsement; issued cheque cleared; each state change's journals match `U-TRS-17/18`; bank and GL reconcile | B-13 |

### 21.10 Payments, advances, clearing, cash sessions (`U-PAY-01…06`, `I-TRS-03`)

| ID | Named case | Exact assertion | R1 |
|---|---|---|---|
| `U-PAY-01` | allocation bound | `Σ allocations ≤ payment.amount` and `allocated + unapplied = amount` enforced in DB + service; over-allocation rejected | B-14, M-11 |
| `U-PAY-02` | advance/unapplied + customer credit | overpayment recorded as unapplied/customer credit; applied later to an invoice; supplier prepayment flows to prepayment account; customer credit account used | B-14, H-10 |
| `U-PAY-03` | payment-method clearing accounts | every payment method has `gl_account_id`; gateway/POS/COD clearings post to their own accounts; bank only after settlement | B-14 |
| `U-PAY-04` | refund vs return | `refund.amount ≤ Σ return-line refund`; refund cannot exceed paid; cross-org document link rejected | M-11 |
| `U-PAY-05` | cash session reconciliation | open/close session with counted cash; over/short posts to cash-over-short account (separate from cash movement); `cash_transactions.session_id` required | M-16, B-14 |
| `U-PAY-06` | bank statements + matching | import batch header/opening/closing; same statement line cannot match twice; outstanding cheques/deposits-in-transit report; reconciliation difference explained | M-09, M-10, B-15 |
| `I-TRS-03` | treasury e2e | invoice → collection with advance/credit → payment allocations → cash session variance → bank statement import + reconciliation → trial balance; AP/AR control accounts equal subledgers | B-14, M-09/10/11/16 |

### 21.11 Security remediation (`SEC-*` — 34 cases, path `apps/api/test/security/`)

| ID | Named case | Exact assertion | R1 |
|---|---|---|---|
| `SEC-AUTH-07` | device-trust bypass | password + victim `deviceFingerprint` + **no device cookie** ⇒ `202` MFA challenge, no tokens; trust bypass only with valid server-issued device secret bound to the session `device_id` | B-02 |
| `SEC-AUTH-08` | device-secret roundtrip | secret is 32-byte random, stored hashed, `HttpOnly` cookie, rotates on re-trust; wrong/absent secret forces re-OTP; fingerprint alone never authenticates | B-02 |
| `SEC-AUTH-09` | password-reset policy | public `/auth/password/forgot|reset` are **404 absent** in v1 (or full flow: 256-bit single-use token, 10-min TTL, purpose-bound, device-bound, revoked on password change, step-up required); admin reset forbidden when target effective perms ⊄ actor perms; password never displayed to admin | B-03 |
| `SEC-AUTH-10` | OTP purpose vocabulary | every endpoint's purpose inserts successfully; purpose binding prevents cross-purpose replay (login OTP cannot be used for reset/step-up); DB CHECK/FK covers all API purposes | M-01 |
| `SEC-AUTH-11` | **step-up matrix** | each sensitive action (role/scope/user-role change, password reset, channel credential, approval-config, journal close, credential view, export of PII) without `X-Step-Up-Token` ⇒ `403 STEP_UP_REQUIRED`; with valid token succeeds; expired token rejected | H-01, B-04 |
| `SEC-AUTH-12` | API-client auth | client_key+secret → short-lived scoped token; `allowed_cidrs` enforced (`403 IP_NOT_ALLOWED`); scope→permission guard chain identical to users; rotation overlap; audit | M-06 |
| `SEC-AUTH-13` | break-glass controls | offline account + out-of-band second-custodian approval; distinct `actor_type`; session row checked per request; explicit denylist (credential export, user creation, data deletion); mandatory post-incident ticket + kill switch | M-07 |
| `SEC-AUTH-14` | JWT verification hardening | fixed algorithm allowlist derived from key type; `alg:none` rejected; `aud`/`iss` validated; `jti` replay policy defined for sensitive routes | L-04 |
| `SEC-AC-09` | **privilege-escalation matrix** | role/scope/user-role endpoints: actor cannot grant any permission/scope he lacks (target's current perms included) ⇒ `403 FORBIDDEN_PERMISSION_ESCALATION`; self-assignment of new role rejected; superadmin-only assign of admin/finance roles | H-01 |
| `SEC-AC-10` | approval-config governance | changing thresholds/workflow requires `approval.config.manage` + superadmin + step-up + **2-person approval**; immutable version snapshot; finance_manager cannot both edit and post | B-04 |
| `SEC-AC-11` | maker-checker enforcement | over-threshold journal without `approval_id` ⇒ `403`; self-approval ⇒ `409`; author+post same document type denied by guard; post key disjoint from create/update | B-04 |
| `SEC-AC-12` | scope-probe 404 | out-of-scope detail/action returns `404` (never `403 SCOPE_DENIED`); `403` only for body-derived targets the caller already sees; UUID scan enumerates nothing | M-09 |
| `SEC-SES-06` | scope change revocation | `PUT /users/{id}/scope` bumps `permissions_version` in the same transaction; narrowed scope blocked on the **next** request (≤ 0 requests of grace), widened scope invisible until refresh | M-10 |
| `SEC-API-04` | export entity permission | `/exports` derives permission from `entity`: `audit` ⇒ `audit.export`, cost columns ⇒ `catalog.cost.read`; scoped list/download (`requested_by = actor` unless `export.read_all`); cross-user download denied; audit row per download | H-02, H-09 |
| `SEC-API-05` | idempotency cross-actor | same `Idempotency-Key` from two actors is independent (unique includes `actor_user_id`); no body/status leak across actors; replay within 24 h only for the sender | M-02 |
| `SEC-API-06` | rate tiers integration | `auth-ip` (20/10 min per IP regardless of username count), `username-global` (50/h), `mfa-verify` (5/challenge, 30/h/IP), `password-reset` (5/h/IP, 3/token), `otp-voice` (1/5 min/mobile, 5/h/IP + org daily monetary budget), `export` (10/h) — each returns `429` with `retry_after` at the exact threshold | H-07, H-08, M-08 |
| `SEC-API-07` | report/widget permissions | each seeded report has `required_permissions[]` enforced at run, rows, download and dashboard widget resolution; `queryTemplateId` closed enum, no user SQL; dashboard inherits strictest widget permission | H-09 |
| `SEC-FILE-02` | file download entity+scope | `download-url` resolves owner entity → entity read permission + TenantContext scope; out-of-scope/unlinked (non-uploader) ⇒ `404`; presigned URL requires no extra but is short-lived | H-06 |
| `SEC-FILE-03` | presigned POST policy + pending lifecycle | S3 POST policy with `content-length-range` + content-type condition rejects oversize/wrong-type **at storage**; pending uploads GC'd after 24 h; per-user in-flight cap enforced; `ready` only after scan | H-05 |
| `SEC-FILE-04` | archive/PDF isolation | XLSX decompression cap (10× file size, 100k entries) before parse; parse in memory-limited sandbox; PDF renderer flags `--disable-network`, no `file://`; label fields stripped of HTML | M-04 |
| `SEC-CHN-07` | webhook MAC includes event id | MAC input includes `${timestamp}.${eventId}.${rawBody}`; replay of a valid body with mutated `X-Event-Id` rejected; unique `(channel, account, external_event_id)` holds under concurrency | M-03 |
| `SEC-CHN-08` | webhook timestamp + header immutability | timestamp mandatory (no flag), ±300 s skew; signature header/algorithm/required-ness compile-time per adapter, **not configurable** via channel-account settings; settings with overrides rejected | H-03, M-03 |
| `SEC-CHN-09` | outbound allowlist | outbound subscriptions restricted to seeded/approved hosts; cost fields forbidden; new host blocked until approval; step-up + audit; first-delivery alert | H-04 |
| `SEC-CHN-10` | partner archive redaction | no headers/tokens ever persisted; customer PII stored as IDs/hashes (allowlist schema); raw view requires step-up; retention shortened for PII; captured `X-API-KEY` never appears in any row/log | H-10 |
| `SEC-LOG-03` | audit hash-chain verification | `prev_hash`/`entry_hash`/`hash_seq` present; `SECURITY DEFINER` chain function callable by worker (no UPDATE grant); tamper (UPDATE/DELETE) detected by verifier job with exact sequence + alert; independent read path | B-05 |
| `SEC-LOG-04` | security-event vocabulary | every SECURITY §7.3 detector event (`auth.refresh.reuse`, `access.denied`, `webhook.signature.invalid`, `egress.blocked`, `audit_mismatch`, `breakglass`, …) inserts successfully; `audit_logs.actor_type` includes `webhook`; no CHECK violation on any detector path | B-05, M-01 |
| `SEC-LOG-05` | secret/PII redaction | logs redact auth/cookie/refresh/OTP/PII; `LOG_BODIES` forbidden in prod; third-party errors scrubbed; channel archives carry no credential header | H-10 |
| `SEC-DB-01` | grants manifest test | generated SQL ↔ `\dp` diff empty; `saman_app` has **no DELETE** on any table; `saman_readonly` sees views/matviews only (no base tables); revoked set includes password history, login attempts, devices, security events, settings, idempotency; audit log read-only | H-12 |
| `SEC-CFG-06` | secrets not in env | production keys loaded from root-owned `0400` file/Compose secrets, not `env_file`; `docker inspect` shows no secret; deploy user has no docker sudo (rootless or scoped systemd) | H-11 |
| `SEC-CFG-07` | code-declared egress | adapter base hosts hard-coded allowlist; env can only pick sandbox/live declared host; boot assertion every base URL ∈ declared set; firewall backstop | M-05 |
| `SEC-CFG-08` | edge ports/caps | unprivileged edge binds 8080/8443; published ports match; `cap_drop: ALL` verified by deploy check; no root bind without NET_BIND_SERVICE | L-02 |
| `SEC-CFG-09` | public endpoint disclosure | `/webhooks/health` internal-only; `/health/version` hides commit/env unless `system.read`; public endpoint returns only `ok` | L-05 |
| `SEC-SUP-01` | supply-chain pinning | every CI `uses:` pinned to 40-char SHA; Trivy image pinned by digest; SBOM tool version pinned; policy test fails otherwise | L-01 |
| `SEC-HDR-02` | security headers single source | header/CSP snapshot generated from one source (SECURITY §6.5): HSTS `max-age=63072000; includeSubDomains; preload`, CSP `default-src 'none'`; API doc duplicate removed | L-03 |
| `CT-EVID-01` | security-control evidence lint | every `SECURITY.md` §9 control row has a route file + test ID + CI run artifact; rows without evidence fail CI (implements R1 B-01) | B-01 |
| `CT-PERM-05` | single permission registry parity | one generated `packages/shared/permissions.ts` is the only registry; bidirectional parity (every route key ∈ registry, every registry key used or `reserved`), no prefix/wildcard matching, counts reconcile (API vs DATA-MODEL table deleted) | B-06 |

### 21.12 Remediation traceability — R1-accounting findings → tests

| Finding | Test(s) |
|---|---|
| B-01 sale VAT/COGS event | `U-ACC-27/28/29/30/31`, `U-PRC-01`, `CT-POST-01` |
| B-02 GRNI / supplier invoice | `U-ACC-32/33`, `I-ACC-02` |
| B-03 settlement double revenue | `U-ACC-34`, `I-ACC-04` |
| B-04 contra normal balance | `U-COA-03`, `U-COA-02` |
| B-05 CoA seed inconsistency | `U-COA-01/04/05`, `I-COA-01`, `CT-COA-01` |
| B-06 negative available | `U-INV-26`, `C-INV-04`, `INV-18`, `PROP-INV-03` |
| B-07 FIFO not a layer ledger | `U-INV-19…25`, `I-INV-03`, `INV-17` |
| B-08 closing/opening | `U-ACC-45…49`, `I-CLS-01` |
| B-09 period/date integrity | `U-CAL-19/20/21`, `U-ACC-50`, `I-PER-01` |
| B-10 rule engine expressiveness | `U-ACC-43/44`, `CT-POST-01` |
| B-11 return VAT credit note | `U-ACC-35/36`, `I-RET-01` |
| B-12 invoice arithmetic | `U-MON-23…27`, `PROP-MON-03/04/05`, revised `U-MON-04/06` |
| B-13 cheque lifecycle | `U-TRS-17…21`, `U-ACC-21`, `I-TRS-02` |
| B-14 payments/advances/clearing | `U-PAY-01…06`, `I-TRS-03` |
| B-15 missing cash/bank/partner tables | `U-PAY-05/06`, `I-TRS-03` (schema deltas tracked in `02-data-model`; harness binds when tables land) |
| B-16 inventory vs closed period | `U-ACC-50`, `I-INV-04` |
| H-01 6-level CoA / party detail | `U-COA-02/05`, `CT-COA-01` (mapping table is a DATA-MODEL fix) |
| H-02 valuation override/change policy | `U-INV-24/25`, D2-r1 |
| H-03 backdated receipts | `U-INV-19/20`, `I-INV-03` |
| H-04 transfer accounting | `U-ACC-41`, `U-INV-22`, `I-INV-03` |
| H-05 adjustments at zero cost | `U-ACC-38/39` |
| H-06 3-way match | `U-ACC-33`, `I-ACC-02` |
| H-07 tax GL mapping / fee VAT | `U-ACC-42`, revised `U-ACC-16` |
| H-08 legal invoice snapshot/credit note | `U-ACC-27/35`, `I-RET-01` |
| H-09 profit distribution | `U-ACC-49`, `I-CLS-01` |
| H-10 partner/customer accounts | `U-PAY-02`, `U-ACC-49` |
| H-11 void without reversal | `U-ACC-43`, revised `U-ACC-05/06` |
| H-12 header totals | `U-ACC-44` |
| H-13 multi-dimension balances | `U-ACC-43`, revised `I-RPT-01` |
| H-14 landed cost | `U-ACC-32`, revised `I-PUR-01` |
| M-01 period overlap/13th | `U-CAL-19/21`, `I-PER-01` |
| M-02 tax windows/default/rate | `U-MON-27`, `U-ACC-42` |
| M-03 CoA parent integrity | `U-COA-02` |
| M-04 control-account reconciliation | `INV-17`, `U-ACC-40` |
| M-05 FIFO/FEFO column | `U-INV-19/20` |
| M-06 layer residual | `U-INV-24` |
| M-07 optional transaction cost | `U-ACC-38`, `U-INV-24` |
| M-08 reservation consumption link | revised `U-RES-06`, `INV-02` |
| M-09/M-10 bank statements/matching | `U-PAY-06` |
| M-11 payment/refund bounds | `U-PAY-01/04` |
| M-12 settlement net formula | `U-ACC-34`, `U-PAY-01` |
| M-13 tax document links | revised `U-ACC-16` |
| M-14 entry/business date | `U-ACC-50`, `U-CAL-20` |
| M-15 discount double count | `U-ACC-29`, `U-MON-24` |
| M-16 cash variance/session | `U-PAY-05` |
| M-17 reopen audit | `U-CAL-21`, `U-ACC-48` |
| M-18/M-19 ownership/loss | `U-ACC-49` |
| M-20 purchase returns/bad debt | `U-ACC-38/42` |
| M-21 rounding account | `U-MON-25/26`, `PROP-MON-04/05` |
| L-01…L-06 | `U-COA-01` (code length), `U-MON-27` (rate naming), `U-TRS-19/20` (event amounts), `U-INV-25` (standard cost), `U-ACC-42` (tax-doc status), `U-ACC-45` (closing-run links) |

### 21.13 Remediation traceability — R1-security findings → tests

| Finding | Test(s) |
|---|---|
| B-01 claims vs implementation | `CT-EVID-01`, §17 DoD evidence rule |
| B-02 device-trust MFA bypass | `SEC-AUTH-07/08` |
| B-03 password reset takeover | `SEC-AUTH-09` |
| B-04 maker-checker defeat | `SEC-AC-10/11`, `SEC-AUTH-11` |
| B-05 audit tamper-evidence | `SEC-LOG-03/04` |
| B-06 permission registry split | `CT-PERM-05`, `U-RBAC-01/16` |
| H-01 privilege amplification | `SEC-AC-09`, `SEC-AUTH-11` |
| H-02 export permission bypass | `SEC-API-04` |
| H-03 webhook signature configurable | `SEC-CHN-08` |
| H-04 outbound webhook exfiltration | `SEC-CHN-09` |
| H-05 presigned upload abuse | `SEC-FILE-03` |
| H-06 file download authz | `SEC-FILE-02` |
| H-07 login throttling | `SEC-API-06` |
| H-08 voice-OTP abuse | `SEC-API-06` |
| H-09 report/dashboard permission collapse | `SEC-API-07` |
| H-10 channel archive PII | `SEC-CHN-10`, `SEC-LOG-05` |
| H-11 secrets via docker env | `SEC-CFG-06` |
| H-12 readonly/app role over-grant | `SEC-DB-01` |
| M-01 OTP/event vocabulary | `SEC-AUTH-10`, `SEC-LOG-04` |
| M-02 idempotency cross-actor | `SEC-API-05` |
| M-03 webhook replay event id | `SEC-CHN-07` |
| M-04 import/PDF attack surface | `SEC-FILE-04` |
| M-05 circular SSRF allowlist | `SEC-CFG-07` |
| M-06 API-client auth | `SEC-AUTH-12` |
| M-07 break-glass blast radius | `SEC-AUTH-13` |
| M-08 reset/MFA rate tiers | `SEC-API-06` |
| M-09 scope 403 oracle | `SEC-AC-12` |
| M-10 scope change token staleness | `SEC-SES-06` |
| L-01 supply-chain pinning | `SEC-SUP-01` |
| L-02 edge port/caps | `SEC-CFG-08` |
| L-03 header drift | `SEC-HDR-02` |
| L-04 JWT hardening | `SEC-AUTH-14` |
| L-05 public health disclosure | `SEC-CFG-09` |

### 21.14 Gate impact, totals & deferred items

- **v1.1 totals:** unit **356** (300 + 56), integration **101** (90 + 10 integration + 1 concurrency),
  contract **22** (18 + 4), security **79** (45 + 34), E2E **26** → **584 automated cases**; plus
  **18** invariants (`INV-01…18`), **12** properties (`PROP-*`), **19** concurrency cases and
  **6** k6 profiles. §2 is updated to these numbers.
- **Gates:** all §21 cases are required for **G2** (`pnpm verify:full`) and security cases for **G5**.
  Round-1 exit condition: every R1 blocker/high finding above has an implemented or explicitly
  deferred test (no blocker may be deferred past P1; security M-03–M-05 defer no later than P5,
  M-09/M-10 no later than P2 per R1 verdict).
- **Deferred (tracked, not silently dropped):**
  1. Schema/data-model deliverables referenced by B-15 (cash sessions, bank statements, partners),
     H-01 (6-level/party mapping table), H-08 (legal invoice snapshot columns), M-14 (`period_id` on
     inventory) — tests bind to tables when `02-data-model` lands (P1/P2); harness stubs fail loudly
     until then.
  2. E2E coverage for the new accounting/security flows (§21) — deferred to v1.2 after API freeze;
     no E2E workaround is allowed to derive accounting truth from the DOM (§20-D7).
  3. Mutation testing of §21 engines — same Stryker budget (§5), nightly only.
  4. Load thresholds unchanged; `LOAD-02` re-run required once the new posting matrix is implemented
     to prove p95 write budgets still hold with the extra journal/ledger legs.
  5. External-partner specifics (`TBD-DIGIKALA`, Limo voice budget API) remain out of the test
     contract until contracts are frozen.
- **Revision control:** this §21 is v1.1; any change to a §21 ID, threshold or mapping requires a
  v1.2 revision note and Lead sign-off.
