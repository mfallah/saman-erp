/**
 * Outbound webhooks (API.md §6.2, R1-security H-04).
 *
 * - Destination hosts come from a code-seeded allowlist; URL edits cannot add
 *   a new host, ports are 443 only and redirects are forbidden.
 * - Cost fields are stripped unconditionally; no subscription can opt in.
 * - Delivery logs store a PII-minimised copy of the payload.
 * - `X-Saman-Signature: sha256=HMAC(secret, timestamp + "." + rawBody)`.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';

import { Inject, Injectable, Optional } from '@nestjs/common';

import { AppError } from '@saman/shared';
import { CRYPTO, DB, type CryptoPort, type Db } from '../../../common/contracts';
import { v4 as uuidv4 } from 'uuid';
import { OUTBOUND_WEBHOOK_OPTIONS } from '../channels.tokens';
import {
  OUTBOUND_WEBHOOK_ALLOWED_HOSTS,
  assertAllowedUrl,
  isPrivateAddress,
} from '../infrastructure/egress';
import { isUniqueViolation } from '../infrastructure/sql';
import { minimizePayload, type JsonValue } from '../domain/pii';
import { backoffDelayMs } from '../infrastructure/backoff';
import type { AppLogger } from '../ports/logger.port';
import { LOGGER } from '../ports/logger.port';
import {
  SqlOutboundWebhookRepository,
  type OutboundSubscriptionRow,
} from '../repositories/outbound-webhook.repository';

export interface OutboundEventInput {
  readonly organizationId: string;
  readonly eventType: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly data: Record<string, unknown>;
  readonly version?: number;
}

export type DeliveryOutcome = 'delivered' | 'retry' | 'dead';

export interface ResolverLike {
  (hostname: string): Promise<readonly { address: string; family: number }[]>;
}

const COST_KEY = /^(cost|cost_amount|purchase_price|buy_price|margin|profit|cogs|unit_cost|total_cost)$/i;

/** Removes cost fields recursively; also drops credential-looking fields. */
export function stripCostFields(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => stripCostFields(item, depth + 1));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (COST_KEY.test(key)) continue;
      if (key.toLowerCase().includes('secret') || key.toLowerCase() === 'authorization') continue;
      result[key] = stripCostFields(child, depth + 1);
    }
    return result;
  }
  return value;
}

@Injectable()
export class OutboundWebhookService {
  private readonly repo: SqlOutboundWebhookRepository;
  private readonly fetchImpl: (input: string, init: RequestInit) => Promise<Response>;
  private readonly resolve: ResolverLike;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CRYPTO) private readonly crypto: CryptoPort,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Optional()
    @Inject(OUTBOUND_WEBHOOK_OPTIONS)
    options: { fetchImpl?: typeof fetch; resolver?: ResolverLike } = {},
  ) {
    this.repo = new SqlOutboundWebhookRepository(db);
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.resolve =
      options.resolver ??
      ((hostname) =>
        lookup(hostname, { all: true, verbatim: true }) as Promise<
          { address: string; family: number }[]
        >);
  }

  async createSubscription(input: {
    organizationId: string;
    code: string;
    name: string;
    endpointUrl: string;
    eventTypes: readonly string[];
    actorId: string | null;
  }): Promise<{ subscription: OutboundSubscriptionRow; secret: string }> {
    const target = assertAllowedUrl(input.endpointUrl, OUTBOUND_WEBHOOK_ALLOWED_HOSTS);
    const secret = randomBytes(32).toString('hex');
    let subscription: OutboundSubscriptionRow;
    try {
      subscription = await this.repo.create({
        organizationId: input.organizationId,
        code: input.code,
        name: input.name,
        endpointUrl: target.url,
        eventFilters: input.eventTypes,
        signingSecretCiphertext: this.crypto.encrypt(secret),
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError('CONFLICT', {
          message: 'اشتراک وبهوک با این کد قبلاً ثبت شده است.',
          details: [{ field: 'code', code: 'duplicate_subscription' }],
        });
      }
      throw error;
    }
    this.logger.info(
      { subscriptionId: subscription.id, host: target.host, actorId: input.actorId },
      'outbound webhook subscription created',
    );
    // Secret is returned once; only ciphertext is stored.
    return { subscription, secret };
  }

  async updateSubscription(input: {
    organizationId: string;
    id: string;
    endpointUrl?: string;
    eventTypes?: readonly string[];
    isActive?: boolean;
  }): Promise<OutboundSubscriptionRow> {
    let next = input;
    if (input.endpointUrl !== undefined) {
      const target = assertAllowedUrl(input.endpointUrl, OUTBOUND_WEBHOOK_ALLOWED_HOSTS);
      next = { ...input, endpointUrl: target.url };
    }
    return this.repo.update(next);
  }

  /** Delivers one attempt; the queue decides whether to schedule a retry. */
  async deliver(
    event: OutboundEventInput,
    attemptNo = 1,
  ): Promise<{ outcomes: readonly { subscriptionId: string; outcome: DeliveryOutcome }[] }> {
    const subscriptions = await this.repo.listActive(event.organizationId, event.eventType);
    const outcomes: { subscriptionId: string; outcome: DeliveryOutcome }[] = [];
    for (const subscription of subscriptions) {
      outcomes.push({
        subscriptionId: subscription.id,
        outcome: await this.deliverOne(subscription, event, attemptNo),
      });
    }
    return { outcomes };
  }

  private async deliverOne(
    subscription: OutboundSubscriptionRow,
    event: OutboundEventInput,
    attemptNo: number,
  ): Promise<DeliveryOutcome> {
    const eventUuid = uuidv4();
    const startedAt = Date.now();
    let secret: string;
    try {
      if (subscription.signingSecretCiphertext === null) throw new Error('missing_secret');
      secret = this.crypto.decrypt(subscription.signingSecretCiphertext);
    } catch {
      await this.record(
        subscription,
        event,
        eventUuid,
        attemptNo,
        'dead',
        null,
        null,
        0,
        null,
        'secret_unreadable',
        null,
      );
      return 'dead';
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = {
      id: eventUuid,
      event: event.eventType,
      occurredAt: new Date().toISOString(),
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      data: stripCostFields(event.data),
      version: event.version ?? 1,
    };
    const rawBody = JSON.stringify(payload);

    try {
      const target = assertAllowedUrl(subscription.endpointUrl, OUTBOUND_WEBHOOK_ALLOWED_HOSTS);
      const addresses = await this.resolve(target.host);
      if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
        throw new Error('private_destination');
      }
      const signature = createHmac('sha256', secret)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');
      const response = await this.fetchImpl(target.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-saman-signature': `sha256=${signature}`,
          'x-saman-timestamp': timestamp,
          'x-saman-event': event.eventType,
          'x-saman-delivery-id': eventUuid,
        },
        body: rawBody,
        redirect: 'error',
        signal: AbortSignal.timeout(subscription.timeoutMs),
      });
      const durationMs = Date.now() - startedAt;
      const responseText = await response.text();
      const snippet = responseText.slice(0, 500);

      if (response.status >= 200 && response.status < 300) {
        await this.record(
          subscription,
          event,
          eventUuid,
          attemptNo,
          'delivered',
          response.status,
          snippet,
          durationMs,
          null,
          null,
          payload,
        );
        return 'delivered';
      }
      if (response.status === 410) {
        await this.repo.deactivate(subscription.id);
        await this.record(
          subscription,
          event,
          eventUuid,
          attemptNo,
          'dead',
          response.status,
          snippet,
          durationMs,
          null,
          'subscription_gone',
          payload,
        );
        this.logger.warn(
          { subscriptionId: subscription.id },
          'outbound subscription auto-disabled (410)',
        );
        return 'dead';
      }
      if (response.status >= 400 && response.status < 500) {
        await this.record(
          subscription,
          event,
          eventUuid,
          attemptNo,
          'dead',
          response.status,
          snippet,
          durationMs,
          null,
          `http_${response.status}`,
          payload,
        );
        return 'dead';
      }
      const nextRetryAt = new Date(Date.now() + backoffDelayMs({ attempts: attemptNo }));
      await this.record(
        subscription,
        event,
        eventUuid,
        attemptNo,
        'failed',
        response.status,
        snippet,
        durationMs,
        nextRetryAt,
        `http_${response.status}`,
        payload,
      );
      return 'retry';
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : 'delivery_failed';
      const nextRetryAt = new Date(Date.now() + backoffDelayMs({ attempts: attemptNo }));
      await this.record(
        subscription,
        event,
        eventUuid,
        attemptNo,
        'failed',
        null,
        null,
        durationMs,
        nextRetryAt,
        message,
        payload,
      );
      this.logger.warn(
        { subscriptionId: subscription.id, host: safeHost(subscription.endpointUrl), error: message },
        'outbound webhook delivery failed',
      );
      return 'retry';
    }
  }

  private async record(
    subscription: OutboundSubscriptionRow,
    event: OutboundEventInput,
    eventUuid: string,
    attemptNo: number,
    status: 'delivered' | 'failed' | 'dead',
    httpStatus: number | null,
    responseSnippet: string | null,
    durationMs: number,
    nextRetryAt: Date | null,
    errorMessage: string | null,
    payload: Record<string, unknown> | null,
  ): Promise<void> {
    await this.repo.recordAttempt({
      subscriptionId: subscription.id,
      eventType: event.eventType,
      entityType: event.entityType,
      entityId: event.entityId,
      eventUuid,
      attemptNo,
      status,
      httpStatus,
      responseSnippet,
      durationMs,
      nextRetryAt,
      errorMessage,
      // Logs keep identifiers/hashes only; the outbound body is not stored raw.
      requestPayload: minimizePayload(payload ?? {}) as JsonValue,
    });
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}
