# سامان ERP — Saman ERP

> **ERP یکپارچه، چندکاناله و مقیاس‌پذیر برای فروش، انبار، حسابداری و تسویه**
> Omnichannel Commerce ERP · WMS · OMS · Accounting · Channel Integration

<p dir="rtl">

**سامان** یک ERP ماژولار برای **کِرَکسی شاپ (Carexy Shop)** است — کسب‌وکاری که روی چند کانال فروش (سایت اختصاصی `carexy.shop`، دیجی‌کالا، اسنپ‌شاپ، تپسی‌شاپ) می‌فروشد و به انبارداری دقیق، حسابداری دوطرفه و تسویهٔ کانال نیاز دارد. دامنهٔ هدف: `erp.carexy.shop`.
این مخزن شامل **کل سیستم** است: API، کارگرهای پس‌زمینه، پنل مدیریت، پایگاه داده PostgreSQL، مهاجرت‌ها، تست‌ها، استقرار Docker و مستندات.

- **زبان رابط:** فارسی · RTL · فونت وزیرمتن
- **پایگاه داده:** PostgreSQL 16 (schema `erp`)
- **معماری:** Modular Monolith + Event Driven (Outbox + BullMQ)
- **استقرار:** `docker compose up -d` روی هر سرور لینوکسی
- **وضعیت:** نسخهٔ 1.0.0 — هستهٔ عملیاتی ساخته و typecheck/build تست شده؛ اجرای Docker/DB اولین قدم روی سرور شماست (جزئیات: `docs/VERIFICATION.md` و `docs/09-roadmap/ROADMAP.md`)

</p>

## Quick start (production, Docker)

```bash
git clone https://github.com/mfallah/saman-erp.git && cd saman-erp
git checkout v1.0.0
cp .env.example .env
./scripts/gen-secrets.sh        # builds ./secrets/* and fills .env (then edit DOMAIN/Limo/channel keys)
docker compose up -d --build   # postgres, redis, minio, api, worker, web
docker compose --profile tools run --rm migrate                    # schema (migrator role)
docker compose --profile tools run --rm migrate node /app/packages/db/dist/seed.js  # roles, permissions, CoA, admin
# open http://127.0.0.1:8080 — admin credentials are printed by the seed (BOOTSTRAP_ADMIN_*)
```

> **Docker was not runnable in the build environment** — this quick start is the first thing to verify
> on a real host. Full Persian guide: [`docs/06-deployment/INSTALL-FA.md`](docs/06-deployment/INSTALL-FA.md);
> exact evidence of what was machine-verified: [`docs/VERIFICATION.md`](docs/VERIFICATION.md).

Full Persian installation guide — database setup, TLS, backups, upgrades:
[`docs/06-deployment/INSTALL-FA.md`](docs/06-deployment/INSTALL-FA.md)

## Repository layout

```text
apps/
  api/          NestJS + Fastify API, Drizzle schema & migrations, tests
  web/          React 19 + Vite admin SPA (RTL)
packages/
  shared/       Shared Zod contracts, permission keys, enums, errors
docs/           00-overview → 09-roadmap, ADRs, review records
infra/          docker, nginx, backup, monitoring
scripts/        dev/ops helper scripts
.github/        CI (lint, typecheck, test, build, docker, security scan)
```

## Documentation map

| Doc | English | فارسی |
|---|---|---|
| Overview & scope | [00-overview](docs/00-overview/README.md) | خلاصه در ابتدای سند |
| Architecture & decisions | [01-architecture](docs/01-architecture/ARCHITECTURE.md) | ADR-ها |
| Data model (150+ tables) | [02-data-model](docs/02-data-model/DATA-MODEL.md) | — |
| API contract | [03-api-contract](docs/03-api-contract/API.md) | — |
| Security model | [04-security](docs/04-security/SECURITY.md) | — |
| Testing strategy | [05-testing](docs/05-testing/TESTING.md) | — |
| Installation & deployment | [06-deployment](docs/06-deployment/INSTALL-FA.md) | ✅ کامل فارسی |
| Operations runbook | [07-operations](docs/07-operations/RUNBOOK.md) | فارسی |
| User guide | [08-user-guide](docs/08-user-guide/GUIDE-FA.md) | ✅ فارسی |
| Roadmap & status | [09-roadmap](docs/09-roadmap/ROADMAP.md) | فارسی |
| Design reviews (3 rounds) | [docs/_review](docs/_review/) | — |

## Security

See [`SECURITY.md`](SECURITY.md) and [`docs/04-security/SECURITY.md`](docs/04-security/SECURITY.md). Report vulnerabilities privately — never in a public issue.

## License

Proprietary — © Carexy Shop. All rights reserved. See [`LICENSE`](LICENSE).

