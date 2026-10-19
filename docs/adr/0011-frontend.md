# ADR-0011 — Frontend architecture & AI seams

**Status:** Accepted · **Date:** 1405-07-27

## Context

The admin panel is authenticated, data-dense, Persian RTL, and must work on tablets/phones in the warehouse (scanner flows). SSR/SEO is irrelevant. The spec also lists future AI assistants.

## Decision

- **React 19 + Vite SPA**, static build served by nginx; same-origin API (`/api`) so no CORS in production.
- **TanStack Router** (typed routes, file-based), **TanStack Query** (server state, retries, optimistic updates), **Tailwind CSS v4** + small in-house component kit (no heavy UI framework), **Vazirmatn** font, RTL by `dir="rtl"` + logical CSS properties.
- **API client** generated from the OpenAPI document at build time (`openapi-typescript`), wrapped with auth/refresh and error normalization.
- **Warehouse flows are PWA-friendly**: scanner input component (keyboard-wedge + camera via `BarcodeDetector` fallback), large tap targets, offline queue for scan events (IndexedDB) with idempotent replay.
- **Charts**: Recharts; **tables**: TanStack Table with virtualization; **forms**: react-hook-form + Zod (shared schemas via `packages/shared`).
- **AI**: not shipped. All AI features will sit behind a `packages/ai` interface and *never* write directly to domain tables; they propose, humans approve.

## Consequences

- Build is a static bundle; deploy = copy `dist` into nginx image.
- No SSR means initial load is a spinner; mitigated by route-level code splitting, skeleton loaders and HTTP caching of assets.
