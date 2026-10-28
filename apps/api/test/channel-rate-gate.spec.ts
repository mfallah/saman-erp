import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AccountRateGate } from '../src/modules/channels/infrastructure/account-rate-gate';
import { PartnerHttpClient, type FetchLike } from '../src/modules/channels/infrastructure/partner-http.client';
import type { ApiCallLogEntry, ApiCallLogPort } from '../src/modules/channels/repositories/channel-api-call.repository';
import { InMemoryKeyValueStore } from '../src/modules/channels/ports/key-value.port';
import { SilentLogger } from '../src/modules/channels/ports/logger.port';
import { TokenBucket } from '../src/modules/channels/infrastructure/token-bucket';
import { IntegrationError, type AdapterAccount } from '../src/modules/channels/domain/channel.types';

const account: AdapterAccount = {
  id: '81',
  publicId: '00000000-0000-4000-8000-000000000081',
  channelId: '1',
  channelCode: 'carexy',
  organizationId: '1',
  baseUrl: 'https://carexy.shop',
  sandbox: false,
  rateLimitPerMin: 600,
  settings: {},
  credentials: { api_key: 'secret-key' },
};

function apiCalls(): ApiCallLogPort {
  const entries: ApiCallLogEntry[] = [];
  return {
    record: async (entry) => {
      entries.push(entry);
    },
    list: async () => [],
  };
}

/** Fake clock: `sleep` advances it, so pacing is asserted without real delays. */
function fakeClock() {
  let time = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
    advance: (ms: number) => {
      time += ms;
    },
    sleeps,
  };
}

function client(options: {
  readonly clock: ReturnType<typeof fakeClock>;
  readonly fetchImpl: FetchLike;
  readonly gate?: AccountRateGate;
}) {
  const gate =
    options.gate ??
    new AccountRateGate({
      now: options.clock.now,
      sleepImpl: options.clock.sleep,
      minIntervalByChannel: { carexy: 1_000 },
    });
  return new PartnerHttpClient(
    {
      logger: new SilentLogger(),
      apiCalls: apiCalls(),
      rateLimiter: new TokenBucket(new InMemoryKeyValueStore(), { capacity: 100, refillPerSecond: 100 }),
      declaredHosts: ['carexy.shop'],
    },
    {
      fetchImpl: options.fetchImpl,
      now: options.clock.now,
      sleepImpl: options.clock.sleep,
      rateGate: gate,
      maxAttempts: 3,
    },
  );
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('channel rate gate', () => {
  it('opens the breaker on 429 and fails fast afterwards without another request', async () => {
    const clock = fakeClock();
    let calls = 0;
    const http = client({
      clock,
      fetchImpl: async () => {
        calls += 1;
        return response(429, { success: false, message: 'مقداری صبر کرده و مجدد تلاش کنید' });
      },
    });
    const request = {
      operation: 'carexy.inventory.list',
      method: 'GET' as const,
      path: '/api/v1/inventories/product/p-1',
      authHeaders: { 'x-api-key': 'secret' },
    };

    await assert.rejects(
      () => http.request(account, request),
      (error: unknown) => error instanceof IntegrationError && error.code === 'RATE_LIMITED' && error.httpStatus === 429,
    );
    assert.equal(calls, 1, 'a 429 must not be retried inline');

    // Second attempt inside the cooldown: typed error, still one network call.
    await assert.rejects(
      () => http.request(account, request),
      (error: unknown) => error instanceof IntegrationError && error.code === 'RATE_LIMITED',
    );
    assert.equal(calls, 1, 'breaker must fail fast: no request may leave');

    // Another operation on the same account is blocked by the account breaker.
    await assert.rejects(
      () => http.request(account, { ...request, operation: 'carexy.inventory.update', method: 'PUT' }),
      (error: unknown) => error instanceof IntegrationError && error.code === 'RATE_LIMITED',
    );
    assert.equal(calls, 1, 'the account-wide breaker covers every operation');
  });

  it('honours Retry-After and defaults to a 60 s cooldown', async () => {
    const clock = fakeClock();
    const gate = new AccountRateGate({
      now: clock.now,
      sleepImpl: clock.sleep,
      minIntervalByChannel: { carexy: 0 },
    });
    gate.noteRateLimited(account, 'carexy.inventory.list', '5');
    assert.equal(gate.snapshot('81', 'carexy.inventory.list').operationCooldownMs, 5_000);

    gate.noteRateLimited(account, 'carexy.inventory.update', null);
    assert.ok(
      gate.snapshot('81', 'carexy.inventory.update').operationCooldownMs >= 60_000,
      'no Retry-After means 60 s',
    );
  });

  it('spaces requests to the same account by the channel minimum interval', async () => {
    const clock = fakeClock();
    const times: number[] = [];
    const http = client({
      clock,
      fetchImpl: async () => {
        times.push(clock.now());
        return response(200, { success: true, response: { data: [] } });
      },
    });
    const request = {
      operation: 'carexy.inventory.list',
      method: 'GET' as const,
      path: '/api/v1/inventories/product/p-1',
      authHeaders: { 'x-api-key': 'secret' },
    };
    await http.request(account, request);
    await http.request(account, request);
    await http.request(account, request);
    assert.equal(times.length, 3);
    assert.equal(times[1]! - times[0]!, 1_000);
    assert.equal(times[2]! - times[1]!, 1_000);
  });

  it('reads the per-channel interval from CHANNEL_MIN_INTERVAL_MS_<CODE>', () => {
    const gate = new AccountRateGate({
      env: { CHANNEL_MIN_INTERVAL_MS_CAREXY: '2500' },
      minIntervalByChannel: { carexy: 1_000, digikala: 300 },
    });
    assert.equal(gate.minIntervalFor('carexy'), 2_500);
    assert.equal(gate.minIntervalFor('digikala'), 300);
    assert.equal(gate.minIntervalFor('unknown'), 250);
  });
});
