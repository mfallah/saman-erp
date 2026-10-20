# Verification evidence (v1.0 build)

**خلاصهٔ فارسی:** این سند «چه چیزی واقعاً تست شد» را از «چه چیزی فقط طراحی/بازبینی شده» جدا می‌کند.
هدف: هیچ ادعای سبزی بدون خروجی فرمان ثبت نشود.

Build environment: Windows 11 sandbox · Node 22.18 · pnpm 11.6 · **no Docker daemon** · **no PostgreSQL server** ·
child-process spawning with piped stdio is denied for Node tools (esbuild/Vite/Vitest cannot spawn services).
These constraints are why some checks are marked *not verified here*.

---

## 1. Checks executed in this environment

| # | Check | Command (from repo root) | Result |
|---|---|---|---|
| V-01 | Shared contracts typecheck + build | `node node_modules/typescript/lib/tsc.js -p packages/shared/tsconfig.json` | **exit 0** |
| V-02 | Database package typecheck + build | `node node_modules/typescript/lib/tsc.js -p packages/db/tsconfig.json` | **exit 0** (11 JS + 11 d.ts in `dist/`) |
| V-03 | API typecheck | `node node_modules/typescript/lib/tsc.js -p apps/api/tsconfig.json --noEmit` | **0 errors** |
| V-04 | API compile (emit) | `node node_modules/typescript/lib/tsc.js -p apps/api/tsconfig.build.json` | **exit 0**; `dist/main.js` + `dist/worker.js` produced |
| V-05 | Web typecheck | `node node_modules/typescript/lib/tsc.js -p apps/web/tsconfig.json --noEmit` | **0 errors** |
| V-06 | Web production build | `cd apps/web && node ../../node_modules/vite/bin/vite.js build --configLoader native` | **exit 0**, 1,921 modules, 11.3 s, 25 lazy chunks, `dist/` emitted (review-agent executed; sandbox-adapted config) |
| V-07 | Shared unit tests | `tsc -p packages/shared/tsconfig.test.json && node packages/shared/dist-test/test/run.js` | **43 pass / 0 fail** (16 suites) |
| V-08 | API platform tests | `tsc -p apps/api/tsconfig.test.json && node apps/api/dist-test/test/run.js` | **20 pass / 0 fail**; HTTP/DB-dependent specs skipped unless `TEST_HTTP_APP=1` |
| V-09 | Web unit tests | `cd apps/web && node ../../node_modules/vitest/vitest.mjs run --configLoader native` | **28 pass / 0 fail** (6 files) |
| V-10 | Web lint | `node .../eslint/bin/eslint.js apps/web --max-warnings=0` | **exit 0** |
| V-11 | SQL generation determinism | `node --experimental-strip-types packages/db/scripts/generate.mjs` (twice) | identical SHA-256; 1,348-line `drizzle/0001_init.sql`, 414 permission keys, CoA manifest |
| V-12 | SQL static validation | `packages/db/scripts/validate-sql` (in-package) | **VALIDATION OK** — 201 tables, 5 partitioned parents + default partitions, 319 indexes, 314 triggers, 127 FKs, 33 CHECKs, 10 functions |
| V-13 | Permission registry parity | registry generated from `docs/03-api-contract/API.md §5.2` vs `docs/02-data-model/DATA-MODEL.md §6.2` | **414/414 exact**, 131/131 resource lines identical |
| V-14 | Domain engine suites (broker-run shim) | module `__tests__` executed with a vitest-compatible shim outside the repo | **commerce 278 pass / 0 fail** (allocation/oversell, FIFO layers, sales FSM, warehouse scans) · **finance 135 pass / 0 fail** (45-event posting matrix, VAT/GRNI/settlement, closing, cheque FSM, rounding) |
| V-15 | YAML/Compose static validation | `python scripts/validate-config.py` (review-agent) | all compose/dev/prod, workflows, prometheus/alert/Grafana YAML parsed; contract assertions pass |
| V-16 | Repo hygiene | `git status`, secrets scan (`gitleaks` config present) | no `.env`, no secrets committed; `.env.example` placeholders only |

## 2. NOT verified in this environment (must be the first CI/host run)

| Area | Why | First-run command |
|---|---|---|
| `docker compose config -q` / `docker build` / stack boot | no Docker daemon | CI job `compose-config` + `docker-build`; host: `docker compose up -d --build` |
| Migration execution against PostgreSQL | no server | `docker compose --profile tools run --rm migrate` |
| Seed idempotency (`db:seed` twice) | needs DB | `... run --rm migrate pnpm db:seed` (twice) |
| Constraint/trigger runtime (journal balance, hash chain, partitions, `\dp` grants) | needs DB | integration suite `TEST_DATABASE_URL=... pnpm test:int` |
| Full E2E (login → product → stock → order → pick/pack → journal → trial balance) | needs running stack | Playwright CI job |
| k6 load/soak thresholds | needs reference host | `k6 run tests/load/*` on 4 vCPU/8 GB |
| Digikala sandbox certification | needs seller credentials | adapter `TBD-DIGIKALA` endpoints stay feature-flagged |

## 3. What this build is

- **280** TypeScript files / ~51.6k lines in `apps/api` (15 controllers, **324 routes**, 42 services, 33 repositories, 30 spec files)
- **88** files / **23** screens in `apps/web` (React 19 + Vite, Persian RTL)
- **216** tables in generated SQL (**201** implemented in `packages/db`, 15 deferred per `MIGRATION-STATUS.md`)
- **33** documentation files / ~11.9k lines; 3-round review trail in `docs/_review/`
- Docker/Compose/CI/reverse-proxy/backup/monitoring configuration and a Persian installation guide

## 4. Release gate for the owner's server

```bash
# 1) install (per docs/06-deployment/INSTALL-FA.md)
cp .env.example .env && ./scripts/gen-secrets.sh          # fill DOMAIN, CMS secrets
docker compose up -d --build
docker compose --profile tools run --rm migrate
docker compose --profile tools run --rm migrate pnpm db:seed
# 2) verify
curl -fsS http://127.0.0.1:8080/health/live
curl -fsS http://127.0.0.1:8080/health/ready
./scripts/smoke.sh                                       # login + RBAC + health
# 3) backup drill
docker compose --profile backup up -d backup && ./scripts/restore-drill.sh
```

A green result of §4 on the target host is the acceptance criterion for v1.0 deployment; §1 is what has
been machine-verified so far.
