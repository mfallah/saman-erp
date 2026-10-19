# Documentation — Saman ERP

Single entry point for all engineering and operational documentation. Persian
summaries live at the top of each document; user-facing guides are fully Persian.

## Reading order for a new engineer

1. [`../README.md`](../README.md) — what the product is, quick start
2. [`00-overview/README.md`](00-overview/README.md) — scope, personas, scale envelope, success criteria
3. [`01-architecture/ARCHITECTURE.md`](01-architecture/ARCHITECTURE.md) — topology, modules, transactions, events, API rules
4. [`adr/`](adr/) — 14 decision records (read 0001, 0002, 0003, 0007, 0008 first)
5. [`02-data-model/DATA-MODEL.md`](02-data-model/DATA-MODEL.md) — every table, index, partition, seed
6. [`03-api-contract/API.md`](03-api-contract/API.md) — endpoint catalog, permissions, adapters
7. [`04-security/THREAT-MODEL.md`](04-security/THREAT-MODEL.md) + [`04-security/SECURITY.md`](04-security/SECURITY.md)
8. [`05-testing/TESTING.md`](05-testing/TESTING.md) — invariants, suites, load thresholds, CI gates

## Operations

- [`06-deployment/INSTALL-FA.md`](06-deployment/INSTALL-FA.md) — **راهنمای نصب کامل فارسی**
- [`06-deployment/DEPLOYMENT.md`](06-deployment/DEPLOYMENT.md) — deployment architecture (EN)
- [`07-operations/RUNBOOK.md`](07-operations/RUNBOOK.md) — daily ops, incidents, maintenance
- [`07-operations/BACKUP-RESTORE.md`](07-operations/BACKUP-RESTORE.md) — backup strategy + restore drill

## Product & delivery

- [`08-user-guide/GUIDE-FA.md`](08-user-guide/GUIDE-FA.md) — راهنمای کاربری فارسی
- [`09-roadmap/ROADMAP.md`](09-roadmap/ROADMAP.md) — status, v1.1/v1.2/v2, technical debt ledger

## Design governance

- [`_review/`](_review/) — three review rounds: findings and resolutions (traceable)
- ADR is required for: schema convention changes, new external integration, auth/crypto changes,
  cross-module dependency, partitioning choice, public API breaking change.

## Document ownership

| Area | Owner |
|---|---|
| overview / architecture / ADRs | Lead Architect |
| data model | DB Architect |
| API contract | API Architect |
| security | Security Lead |
| deployment / operations | DevOps Lead |
| testing | QA Lead |
| roadmap | Lead Architect (approved by product owner) |
