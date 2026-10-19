# ADR-0009 — Partitioning & data lifecycle

**Status:** Accepted · **Date:** 1405-07-27

## Context

At 2M ledger rows/day and 7-year accounting retention, a few tables will dominate size within months. Dashboards and operational queries must not scan them.

## Decision

- **Monthly RANGE partitions** on `created_at` for: `inventory_transactions`, `audit_logs`, `api_request_logs`, `channel_api_calls`, `outbox_events` (partition by `created_at`; processed rows dropped with partition).
- Partition creation is **automated** by a `maintenance` worker job (creates next 2 months, runs daily). Missing-partition insert failure is caught and surfaced as a critical alert.
- **BRIN** index on `created_at` for each partitioned table (cheap, small, ideal for append-only).
- **Retention**: `api_request_logs` 90 days, `channel_api_calls` 180 days, processed `outbox_events` 30 days, `audit_logs` **10 years** (Iranian tax/accounting law — R1 review D-4; supersedes the earlier 7 years), `journal_*`/accounting documents 10 years.

## Revision — 2026-10-19 (R1 review D-4)

Accounting/audit retention raised to **10 years** with yearly archive manifests (hash + row counts) before detaching cold partitions to encrypted object storage. `audit_logs` also gains `prev_hash`/`row_hash` (tamper-evident chain) whose maintenance runs through a `SECURITY DEFINER` function owned by the migrator role — the application role still cannot UPDATE audit rows.

- **Archiving**: yearly `audit_logs` partitions exported to S3 as Parquet/CSV before detach.
- **Vacuum/analyze**: documented autovacuum tuning per table (`inventory_balances`, `sales_orders` hot; `inventory_transactions` insert-only).
- **`pg_cron` not required**; scheduling lives in the worker to keep one scheduler and one code path.

## Consequences

- Queries must always constrain `created_at` on partitioned tables (enforced by `statement_timeout` + review). Repositories provide default windows.
- Unique indexes on partitioned tables must include the partition key; external IDs are unique per month (fine) plus global uniqueness enforced by the source-of-truth table (`sales_orders`).
