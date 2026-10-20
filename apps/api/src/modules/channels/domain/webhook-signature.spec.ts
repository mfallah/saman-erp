import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeWebhookSignature,
  verifyWebhook,
  WEBHOOK_SIGNATURE_CONFIG,
} from './webhook-signature';

const channelId = '11';
const accountId = '22';
const secret = 'whsec_test_secret';
const now = new Date('2026-10-20T08:00:00.000Z');
const timestamp = String(Math.floor(now.getTime() / 1000));
const rawBody = Buffer.from(
  JSON.stringify({ event_type: 'order.created', data: { id: 'ORD-1', total: '1500000' } }),
  'utf8',
);

function headersFor(eventId: string, body: Buffer = rawBody, ts = timestamp): Record<string, string> {
  const signature = computeWebhookSignature(secret, {
    channelId,
    accountId,
    eventId,
    timestamp: ts,
    rawBody: body,
  });
  return {
    'x-event-id': eventId,
    'x-timestamp': ts,
    'x-signature': `sha256=${signature}`,
    'content-type': 'application/json',
  };
}

describe('verifyWebhook (H-03 / M-03)', () => {
  it('accepts a correctly signed delivery', () => {
    const verdict = verifyWebhook(
      { channelId, accountId, rawBody, headers: headersFor('evt_1'), secrets: [secret], now },
      { config: WEBHOOK_SIGNATURE_CONFIG.carexy },
    );
    assert.equal(verdict.valid, true);
    if (verdict.valid) {
      assert.equal(verdict.eventId, 'evt_1');
      assert.equal(verdict.timestamp.toISOString(), now.toISOString());
    }
  });

  it('rejects a tampered body', () => {
    const verdict = verifyWebhook(
      {
        channelId,
        accountId,
        rawBody: Buffer.from('{"event_type":"order.cancelled"}', 'utf8'),
        headers: headersFor('evt_1'),
        secrets: [secret],
        now,
      },
      { config: WEBHOOK_SIGNATURE_CONFIG.carexy },
    );
    assert.equal(verdict.valid, false);
    assert.equal(verdict.valid ? '' : verdict.reason, 'signature_invalid');
  });

  it('rejects replay with a mutated event id (event id is in the MAC input)', () => {
    const headers = headersFor('evt_original');
    const verdict = verifyWebhook(
      {
        channelId,
        accountId,
        rawBody,
        headers: { ...headers, 'x-event-id': 'evt_attacker' },
        secrets: [secret],
        now,
      },
      { config: WEBHOOK_SIGNATURE_CONFIG.carexy },
    );
    assert.equal(verdict.valid, false);
    assert.equal(verdict.valid ? '' : verdict.reason, 'signature_invalid');
  });

  it('rejects a missing timestamp even when a signature is present', () => {
    const headers = headersFor('evt_1');
    delete headers['x-timestamp'];
    const verdict = verifyWebhook(
      { channelId, accountId, rawBody, headers, secrets: [secret], now },
      { config: WEBHOOK_SIGNATURE_CONFIG.carexy },
    );
    assert.equal(verdict.valid, false);
    assert.equal(verdict.valid ? '' : verdict.reason, 'timestamp_missing');
  });

  it('rejects timestamps outside the ±300 s window', () => {
    const oldTimestamp = String(Math.floor(now.getTime() / 1000) - 301);
    const verdict = verifyWebhook(
      {
        channelId,
        accountId,
        rawBody,
        headers: headersFor('evt_1', rawBody, oldTimestamp),
        secrets: [secret],
        now,
      },
      { config: WEBHOOK_SIGNATURE_CONFIG.carexy },
    );
    assert.equal(verdict.valid, false);
    assert.equal(verdict.valid ? '' : verdict.reason, 'timestamp_skew');
  });

  it('accepts the previous secret during the rotation window', () => {
    const verdict = verifyWebhook(
      {
        channelId,
        accountId,
        rawBody,
        headers: headersFor('evt_1'),
        secrets: ['whsec_rotated', secret],
        now,
      },
      { config: WEBHOOK_SIGNATURE_CONFIG.carexy },
    );
    assert.equal(verdict.valid, true);
  });

  it('rejects when no secret is configured', () => {
    const verdict = verifyWebhook(
      { channelId, accountId, rawBody, headers: headersFor('evt_1'), secrets: [], now },
      { config: WEBHOOK_SIGNATURE_CONFIG.carexy },
    );
    assert.equal(verdict.valid, false);
    assert.equal(verdict.valid ? '' : verdict.reason, 'secret_not_configured');
  });
});
