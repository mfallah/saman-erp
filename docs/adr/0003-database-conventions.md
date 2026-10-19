# ADR-0003 — Database conventions & schema shape

**Status:** Accepted · **Date:** 1405-07-27

## Context

The supplied `ERP_database_design_v1.sql` has 150 tables with good intent but is not executable (`DEFAULT GENERATED ALWAYS AS IDENTITY`), has no triggers (so `updated_at`/`version` never move), no partitioning, and mixes naming. We need conventions that survive 5+ years.

## Decision

1. **One schema `erp`.** Business tables live there; `public` stays empty. Migrations own everything; no manual DDL in production.
2. **Keys**: internal `id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`; external `public_id uuid NOT NULL DEFAULT gen_random_uuid()` (unique). APIs expose `public_id`; FKs use `id` (8 bytes, fast joins).
3. **Standard columns** on every business table: `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at`, `created_by bigint`, `updated_by bigint`, `deleted_at timestamptz`, `version integer NOT NULL DEFAULT 1`.
4. **Soft delete** only on master data (`deleted_at`); transactional tables are never deleted — they are voided/reversed. All list queries filter `deleted_at IS NULL` through repository helpers.
5. **Optimistic locking**: `version` incremented by a trigger on every `UPDATE`; API can require `If-Match`.
6. **`updated_at` maintained by trigger** (`set_updated_at` + `bump_version`), not by application code.
7. **Enums**: `varchar` + `CHECK` constraint or lookup table (no PG `ENUM` — painful to evolve). Documented value lists live in `packages/shared`.
8. **Money** `bigint` (IRR, no decimals); **quantities** `numeric(18,4)`; **unit prices/rates** `numeric(18,4)`; percentages `numeric(9,6)`; **never** `float`/`real`.
9. **Timestamps** `timestamptz` UTC; business dates (`invoice_date`, `fiscal date`) `date` in local business calendar.
10. **Naming**: `snake_case`, plural tables, `fk_<table>_<col>`, `uq_<table>_<cols>`, `ck_<table>_<rule>`, `ix_<table>_<cols>`, `ix_<table>_<cols>_partial`.
11. **`ON DELETE`**: `RESTRICT` for references to master/transactional records, `CASCADE` only for pure child rows (lines, mappings, scans). No cascading deletes across aggregates.
12. **JSONB** allowed for: raw channel payloads, event payloads, audit diffs, settings. Never for fields that need joins/filters (promote to columns).

## Consequences

- Dictionary in `docs/02-data-model` documents the final shape; it intentionally diverges from the supplied SQL where needed (documented in `MIGRATION-NOTES.md`).
- Public IDs prevent enumeration; internal bigint keeps indexes small.

## Alternatives rejected

- UUID as PK everywhere — 2–4× index bloat on 2M-rows/day tables.
- `serial` — legacy; identity is the modern default.
- Hard delete for master data — breaks audit and historical documents.
