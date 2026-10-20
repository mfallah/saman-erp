import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryKeyValueStore } from '../../ports/key-value.port';
import { SilentLogger } from '../../ports/logger.port';
import type { ApiCallLogEntry, ApiCallLogPort } from '../../repositories/channel-api-call.repository';
import { PartnerHttpClient } from '../../infrastructure/partner-http.client';
import { TokenBucket } from '../../infrastructure/token-bucket';
import { DigikalaAdapter } from './digikala.adapter';
import { DIGIKALA_HOSTS } from './digikala.constants';
import { IntegrationError, type AdapterAccount } from '../../domain/channel.types';

const account: AdapterAccount = {
  id: '9',
  publicId: '00000000-0000-4000-8000-000000000009',
  channelId: '2',
  channelCode: 'digikala',
  organizationId: '1',
  baseUrl: 'https://seller.digikala.com/open-api/v1',
  sandbox: false,
  rateLimitPerMin: 600,
  settings: {},
  credentials: { client_id: 'client-1', client_secret: 'shhh' },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setup(fetchImpl: (url: string, init: RequestInit) => Promise<Response>): {
  adapter: DigikalaAdapter;
  logs: ApiCallLogEntry[];
} {
  const logs: ApiCallLogEntry[] = [];
  const apiCalls: ApiCallLogPort = {
    record: async (entry) => {
      logs.push(entry);
    },
    list: async () => [],
  };
  const http = new PartnerHttpClient(
    {
      logger: new SilentLogger(),
      apiCalls,
      rateLimiter: new TokenBucket(new InMemoryKeyValueStore(), {
        capacity: 100,
        refillPerSecond: 100,
      }),
      declaredHosts: DIGIKALA_HOSTS,
    },
    { fetchImpl, maxAttempts: 3, random: () => 0, sleepImpl: async () => undefined },
  );
  return {
    adapter: new DigikalaAdapter({
      http,
      store: new InMemoryKeyValueStore(),
      logger: new SilentLogger(),
      tbdEnabled: false,
    }),
    logs,
  };
}

describe('Digikala OAuth2 + retry + rate limit', () => {
  it('caches the client-credentials token and never logs the secret', async () => {
    const paths: string[] = [];
    const { adapter, logs } = setup(async (url) => {
      paths.push(new URL(url).pathname);
      if (url.endsWith('/auth/token')) {
        return json({ access_token: 'token-1', expires_in: 3600 });
      }
      if (url.endsWith('/profile')) return json({});
      return json({}, 404);
    });

    await adapter.authenticate(account);
    await adapter.authenticate(account);

    assert.equal(paths.filter((path) => path.endsWith('/auth/token')).length, 1);
    assert.equal(paths.filter((path) => path.endsWith('/profile')).length, 2);
    assert.equal(JSON.stringify(logs).includes('token-1'), false);
    assert.equal(JSON.stringify(logs).includes('shhh'), false);
  });

  it('refreshes once on 401 and retries the request with the new token', async () => {
    let tokenCalls = 0;
    let refreshCalls = 0;
    const stockAuthorizations: string[] = [];
    const { adapter } = setup(async (url, init) => {
      if (url.endsWith('/auth/token')) {
        tokenCalls += 1;
        return json({ access_token: 'token-old', refresh_token: 'refresh-1', expires_in: 3600 });
      }
      if (url.endsWith('/auth/refresh-token')) {
        refreshCalls += 1;
        return json({ access_token: 'token-new', refresh_token: 'refresh-2', expires_in: 3600 });
      }
      if (url.endsWith('/profile')) return json({});
      if (url.includes('/variants/VAR-1/seller-stock')) {
        const auth = (init.headers as Record<string, string>)['authorization'] ?? '';
        stockAuthorizations.push(auth);
        if (auth.includes('token-old')) return json({ message: 'Invalid token!' }, 401);
        return json({ ok: true });
      }
      return json({}, 404);
    });

    await adapter.authenticate(account);
    const result = await adapter.pushInventory(account, [
      { externalVariantId: 'VAR-1', available: '4' },
    ]);

    assert.equal(result.ok, true);
    assert.equal(tokenCalls, 1);
    assert.equal(refreshCalls, 1);
    assert.deepEqual(stockAuthorizations, ['Bearer token-old', 'Bearer token-new']);
  });

  it('honours 429 with Retry-After and retries instead of failing the job', async () => {
    let stockCalls = 0;
    const { adapter } = setup(async (url) => {
      if (url.endsWith('/auth/token')) return json({ access_token: 'token-1', expires_in: 3600 });
      if (url.endsWith('/profile')) return json({});
      if (url.includes('/variants/VAR-1/seller-stock')) {
        stockCalls += 1;
        if (stockCalls === 1) {
          return new Response(JSON.stringify({ message: 'Too Many Requests' }), {
            status: 429,
            headers: { 'retry-after': '0', 'content-type': 'application/json' },
          });
        }
        return json({ ok: true });
      }
      return json({}, 404);
    });

    await adapter.authenticate(account);
    const result = await adapter.pushInventory(account, [
      { externalVariantId: 'VAR-1', available: '2' },
    ]);

    assert.equal(result.ok, true);
    assert.equal(stockCalls, 2);
  });

  it('keeps unconfirmed TBD-DIGIKALA schemas behind the feature flag', async () => {
    const { adapter } = setup(async () => json({}));
    await assert.rejects(
      adapter.pushPrices(account, [{ externalVariantId: 'VAR-1', value: { price: '1000' } }]),
      (error: unknown) =>
        error instanceof IntegrationError && error.code === 'NOT_IMPLEMENTED',
    );
  });
});
