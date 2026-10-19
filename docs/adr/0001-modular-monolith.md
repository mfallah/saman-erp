# ADR-0001 — Modular Monolith over Microservices

**Status:** Accepted · **Date:** 1405-07-27 · **Deciders:** Lead Architect, Backend, DevOps

## Context

`erpcarexy.docx` §2 proposes microservices, Database-per-Service, Kafka/RabbitMQ and Elasticsearch. The master spec proposes a Modular Monolith with internal events. The customer wants a single server (`docker compose`), a small operational team, and strong accounting correctness — sales, inventory and journals must commit atomically.

## Decision

Build **one deployable backend** (two processes: `api`, `worker`) with **statically enforced module boundaries**. Modules communicate in-process through domain events; durable/external events go through the transactional outbox. No network hop between business modules in v1.

## Consequences

**Positive**
- Order → stock → journal is one ACID transaction; no sagas/compensations for the money path.
- One schema, one migration stream, one place to debug; deploys are `docker compose up`.
- Far lower operational cost (no service mesh, no Kafka, no ES cluster).

**Negative / accepted risks**
- Scaling is process-level until modules are extracted; mitigated by stateless API replicas + partitioning.
- A runaway module can affect the whole process; mitigated by per-process limits, queue isolation and `statement_timeout`.

**Extraction path (kept open)**
1. Each module already owns its tables and exposes only services/events.
2. Outbox event types are versioned and JSON-schema'd → can become broker messages unchanged.
3. Repository interfaces isolate SQL, so a module can be moved to its own DB/auth later.

## Alternatives rejected

- **Full microservices now** — distributed transactions for accounting, 5–10× ops overhead, no benefit on one host.
- **Serverless / edge** — needs long-lived DB pools, cron, queues; wrong fit.
