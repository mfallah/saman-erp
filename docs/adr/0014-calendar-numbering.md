# ADR-0014 — Calendar, fiscal year & document numbering

**Status:** Accepted · **Date:** 1405-07-27

## Context

Iranian fiscal years start Farvardin 1, accounting periods are Jalali months, and users expect Jalali dates everywhere. Storing Jalali strings would break sorting/ranges and reporting. Document numbers must be gap-free and human-readable.

## Decision

- **Storage**: all instants as `timestamptz` (UTC); business dates as `date` in **Gregorian** representing the local day (a Jalali date maps to the same civil day). Conversion happens at the edges (UI, imports, reports).
- **`business_date`** columns exist where the legal/accounting date matters (journal entry date, invoice date).
- **Jalali conversion** in one shared module (pure, tested against known boundaries incl. leap years); frontend uses `Intl.DateTimeFormat('fa-IR-u-ca-persian')` and a date picker bound to that module.
- **Fiscal year**: `fiscal_years` with `start_date`, `end_date`, `status`, derived from org settings (`fiscal_year_start_month/day`); `accounting_periods` are monthly ranges generated on year creation. Posting into a closed period is rejected (`PERIOD_CLOSED`).
- **Document numbers**: `numbering_sequences(organization_id, document_type, fiscal_year_id, prefix, next_value)`; allocation inside the same transaction with `SELECT … FOR UPDATE` → gap-free per document type; format e.g. `SLS-1405-000123`. Numbers are never reused, even after voiding (voided docs keep their number and appear in the journal as void).
- **Reporting**: reports accept Jalali ranges and translate to Gregorian before hitting SQL; group-by month is done with a generated `business_date` (not string parsing).

## Consequences

- No dependency on a specific Persian-calendar SQL extension (`pg_calendar` etc.) — portable across managed PostgreSQL.
- Leap-year and month-end edge cases are covered by unit tests (1403/1404/1405+).
