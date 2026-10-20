/**
 * Inbound webhook receiver service (API.md §6, R1-security H-03/H-10/M-03).
 *
 * The receiver only: verify → archive (minimised) → insert outbox → 200.
 * Untrusted events are never archived. All parsing/domain work is async.
 */
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { AppError } from '@saman/shared';
import { DB, type Db } from '../../../common/contracts';
import {
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_MAX_HEADER_BYTES,
  rejectionToReason,
} from '../domain/webhook-signature';
import type { ChannelCode } from '../domain/channel.types';
import { minimizePayload, type JsonValue } from '../domain/pii';
import type { AppLogger } from '../ports/logger.port';
import { LOGGER } from '../ports/logger.port';
import type { KeyValueStore } from '../ports/key-value.port';
import { KEY_VALUE } from '../channels.tokens';
import { AdapterRegistry } from './adapter.registry';
import { ChannelAccountService } from './channel-accounts.service';
import {
  SqlChannelWebhookRepository,
  type WebhookEventRow,
} from '../repositories/channel-webhook.repository';
import { SqlChannelAccountRepository } from '../repositories/channel-account.repository';
import { asRecord } from '../infrastructure/sql';

export class WebhookVerificationError extends AppError {
  constructor(readonly reason: string) {
    super('UNAUTHENTICATED', {
      message: 'امضای وبهوک معتبر نیست.',
      messageKey: 'error.webhook_signature',
      details: [{ field: 'signature', code: reason }],
    });
    this.name = 'WebhookVerificationError';
  }
}

export interface WebhookReceiveInput {
  readonly channelCode: string;
  readonly accountPublicId?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly rawBody: Buffer;
  readonly ip?: string;
}

export interface WebhookReceiveResult {
  readonly received: true;
  readonly duplicate: boolean;
}

const RATE_LIMIT_PER_MINUTE = 120;

@Injectable()
export class ChannelWebhookService {
  private readonly accountsRepo: SqlChannelAccountRepository;
  private readonly webhooks: SqlChannelWebhookRepository;
  private readonly now = (): Date => new Date();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(KEY_VALUE) private readonly kv: KeyValueStore,
    @Inject(LOGGER) private readonly logger: AppLogger,
    private readonly accounts: ChannelAccountService,
    private readonly registry: AdapterRegistry,
  ) {
    this.accountsRepo = new SqlChannelAccountRepository(db);
    this.webhooks = new SqlChannelWebhookRepository(db);
  }

  async receive(input: WebhookReceiveInput): Promise<WebhookReceiveResult> {
    if (input.rawBody.length > WEBHOOK_MAX_BODY_BYTES) {
      throw new AppError('PAYLOAD_TOO_LARGE', { message: 'بدنهٔ وبهوک بیش از حد مجاز است.' });
    }
    const headers = normalizeHeaders(input.headers);
    const headerBytes = Object.entries(headers).reduce(
      (total, [key, value]) => total + key.length + (value?.length ?? 0),
      0,
    );
    if (headerBytes > WEBHOOK_MAX_HEADER_BYTES) {
      throw new AppError('PAYLOAD_TOO_LARGE', { message: 'سرآیندهای وبهوک بیش از حد مجاز است.' });
    }

    const account = await this.accountsRepo.findForWebhook(
      input.channelCode as ChannelCode,
      input.accountPublicId,
    );
    if (account === null) {
      throw new AppError('NOT_FOUND', { message: 'حساب کانال برای این وبهوک یافت نشد.' });
    }

    await this.limit(`wh:acct:${account.id}`, RATE_LIMIT_PER_MINUTE);
    if (input.ip !== undefined) await this.limit(`wh:ip:${input.ip}`, RATE_LIMIT_PER_MINUTE);

    const secrets = await this.accounts.webhookSecrets(account.id);
    const adapter = this.registry.get(account.channelCode);
    const verdict = adapter.verifyWebhook({
      channelId: account.channelId,
      accountId: account.id,
      rawBody: input.rawBody,
      headers,
      secrets,
      now: this.now(),
    });
    if (!verdict.valid) {
      // Untrusted events are NOT archived (API.md §6.1).
      this.logger.warn(
        { accountId: account.id, reason: verdict.reason, channel: account.channelCode },
        'webhook rejected',
      );
      throw new WebhookVerificationError(rejectionToReason(verdict.reason));
    }

    const rawBodySha256 = createHash('sha256').update(input.rawBody).digest('hex');
    const { eventType, payload } = this.extractPayload(input.rawBody);
    const minimised = minimizePayload(payload);

    const result = await this.webhooks.archiveAndEmit(
      {
        organizationId: account.organizationId,
        accountId: account.id,
        externalEventId: verdict.eventId,
        eventType,
        payload: minimised,
        rawBodySha256,
      },
      {
        organizationId: account.organizationId,
        type: 'channel.webhook.received',
        aggregateType: 'channel_account',
        aggregateId: account.id,
        payload: {
          channelAccountId: account.id,
          channelCode: account.channelCode,
          externalEventId: verdict.eventId,
          eventType,
          rawBodySha256,
        },
      },
    );

    if (result.duplicate && result.payloadMismatch) {
      this.logger.warn(
        { accountId: account.id, externalEventId: verdict.eventId },
        'replay of a used event id with a mutated payload',
      );
    }
    this.logger.info(
      { accountId: account.id, eventType, duplicate: result.duplicate, rawBodySha256 },
      'webhook accepted',
    );
    return { received: true, duplicate: result.duplicate };
  }

  /** Ops surface: per-channel secret configured + last archived event age. */
  async health(): Promise<
    readonly { code: string; secretConfigured: boolean; lastEventAt: Date | null }[]
  > {
    const rows = await this.db<
      { code: unknown; secret_count: unknown; last_event_at: unknown }[]
    >`
      select c.code,
             count(distinct cred.id) filter (where cred.is_active) as secret_count,
             max(e.received_at) as last_event_at
      from erp.sales_channels c
      left join erp.channel_accounts a on a.channel_id = c.id and a.deleted_at is null
      left join erp.channel_credentials cred
        on cred.channel_account_id = a.id and cred.key_name = 'webhook_secret' and cred.is_active
      left join erp.channel_webhook_events e on e.channel_account_id = a.id
      group by c.code
      order by c.code`;
    return rows.map((row) => ({
      code: String(row.code),
      secretConfigured: Number(row.secret_count ?? 0) > 0,
      lastEventAt:
        row.last_event_at === null || row.last_event_at === undefined
          ? null
          : new Date(String(row.last_event_at)),
    }));
  }

  /** Operator replay of an archived event is idempotent at the business layer. */
  async replay(organizationId: string, eventId: string): Promise<WebhookEventRow> {
    const event = await this.webhooks.findById(eventId);
    if (event === null) throw new AppError('NOT_FOUND');
    const rows = await this.db<{ organization_id: unknown }[]>`
      select organization_id from erp.channel_webhook_events
      where id = ${eventId}::bigint
        and organization_id = ${organizationId}::bigint`;
    if (rows[0] === undefined) throw new AppError('NOT_FOUND');
    await this.webhooks.markStatus(event.id, 'processing');
    this.logger.info({ eventId: event.id }, 'webhook replay requested');
    return event;
  }

  private async limit(key: string, perMinute: number): Promise<void> {
    const count = await this.kv.incrBy(`rate:${key}:${Math.floor(Date.now() / 60_000)}`, 1, 120);
    if (count > perMinute) {
      throw new AppError('RATE_LIMITED', {
        message: 'نرخ درخواست‌های وبهوک بیش از حد مجاز است.',
        retryAfter: 60,
      });
    }
  }

  private extractPayload(rawBody: Buffer): { eventType: string; payload: unknown } {
    try {
      const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
      const body = asRecord(parsed);
      const eventType =
        (typeof body['event_type'] === 'string' && body['event_type']) ||
        (typeof body['event'] === 'string' && body['event']) ||
        (typeof body['type'] === 'string' && body['type']) ||
        'unknown';
      return { eventType: eventType.slice(0, 100), payload: parsed };
    } catch {
      return { eventType: 'unknown', payload: { bodyHashOnly: true } };
    }
  }
}

export function normalizeHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return result;
}
