# ADR-0006 — Channel adapter boundary

**Status:** Accepted · **Date:** 1405-07-27

## Context

Channels (Carexy storefront, Digikala, later Snapp/Tapsi) have different auth (API key vs OAuth2 client credentials), different payloads, different order lifecycles and different rate limits. The SRS warns the ERP core must not depend on them. Digikala's real catalog contains 264 endpoints with scopes; Carexy exposes `/api/v1/products|inventories|storages` with `X-API-KEY`.

## Decision

Define a **port** in the domain and implement one **adapter per channel**:

```ts
interface ChannelAdapter {
  code: string;                                  // 'carexy' | 'digikala' | 'mock'
  capabilities: Set<Capability>;                 // stock.push, price.push, order.pull, label.print, ...
  authenticate(account: ChannelAccount): Promise<AuthResult>;
  pushInventory(items: InventoryUpdate[]): Promise<BatchResult>;
  pushPrices(items: PriceUpdate[]): Promise<BatchResult>;
  pullOrders(since: Date): AsyncIterable<CanonicalOrder>;
  acknowledgeOrder(order: CanonicalOrder): Promise<void>;
  updateShipment(shipment: ShipmentUpdate): Promise<void>;
  verifyWebhook(headers, rawBody): WebhookVerdict;
}
```

Rules:

1. **Canonical model only.** External IDs live in `channel_*_mappings`; no `digikala_*` column ever appears on a core table.
2. **Raw payloads persisted** (`channel_webhook_events`, `channel_api_calls`) before parsing, for replay/debug.
3. **Idempotency** by natural key (`channel + external_order_id`), enforced by a unique index and `idempotency_keys`.
4. **Every external call is retried** with exponential backoff + jitter; permanent failures go to `integration_dead_letters` and raise an alert — never block a user request.
5. **Secrets**: per-account encrypted credentials, decrypted only in the adapter call scope, redacted in logs.
6. **Unknown contract = feature flag.** Digikala endpoints present in the catalog but without a confirmed schema stay behind `TBD-DIGIKALA` constants and are not called in production until validated in sandbox.

## Consequences

- Adding Snapp/Tapsi requires one adapter file + mapping seeds; core untouched.
- Some channel-specific quirks (e.g. Digikala SBS shipment states) are mapped in the adapter, not leaked to `sales_orders.status`.

## Revision — 2026-10-19 (R1 review H-03, H-04, M-03, M-05)

1. **Webhook verification parameters are compile-time per adapter** (header name, algorithm, mandatory-ness). They are NOT editable through `channel_account.settings`; only the encrypted secret is configurable, behind `channel.credential.write` + step-up + approval.
2. **Inbound MAC input** = `channelId.accountId.eventId.timestamp.rawBody`; timestamp is mandatory (no "optional" flag); uniqueness enforced on `(channel_id, account_id, external_event_id)`; replay store retained ≥ 24 h.
3. **Outbound webhooks** are restricted to a seeded destination allowlist (Carexy + explicitly approved consumer hosts); cost fields are never sent; new destinations require step-up + audit + alert.
4. **Adapter base URLs are code-declared hosts** (production/sandbox only), never free-form config; a boot assertion verifies every adapter host ∈ declared set, with an egress firewall as independent backstop.
5. Channel payload archives store identifiers/hashes, not customer PII or auth headers; raw view is step-up + masked.

## Alternatives rejected

- Channel logic inside order service — every marketplace change would ripple through core.
- Generic "webhook + mapper config" engine — too weak for typed order/inventory sync; adapters are honest code.
