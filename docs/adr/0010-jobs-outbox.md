# ADR-0010 — Background processing & reliable events

**Status:** Accepted · **Date:** 1405-07-27

## Context

Channel sync, labels, SMS, exports, valuation and partition maintenance cannot run inside HTTP requests. The SRS asks for queues/retry but is silent on transactional consistency between DB writes and events.

## Decision

- **Transactional Outbox** (`outbox_events`) for anything that must happen *after* a committed business write (push stock, post journal, send SMS). Written in the same transaction; dispatched by the worker.
- **BullMQ on Redis** for job execution, delayed retries, cron-like repeatable jobs and concurrency control. Redis is treated as ephemeral: a lost queue job is recoverable because the outbox row is still unprocessed.
- **Dispatch loop**: `FOR UPDATE SKIP LOCKED` batches of 100, `LISTEN/NOTIFY` as a hint, 1-second poll fallback; exponential backoff (30 s → 1 h), max 10 attempts → `integration_dead_letters` + alert.
- **Idempotent handlers** keyed by `(event_type, aggregate_id, event_version)`; handlers must be safe to run twice.
- **Job naming**: `queue:action` (`channel-sync:push-inventory`), typed payload validated by Zod.
- **Observability**: queue depth/age, outbox lag, failed counts exported as Prometheus metrics.
- **No Kafka/RabbitMQ in v1** (single host, low ops budget). The outbox payload is the future broker contract.

## Consequences

- At-least-once delivery; exactly-once *effects* via idempotency.
- A single worker process is a throughput ceiling for batch work; scale by running more worker replicas (queues are shared via Redis).
