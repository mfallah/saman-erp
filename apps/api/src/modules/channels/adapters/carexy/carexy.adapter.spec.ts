import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryKeyValueStore } from '../../ports/key-value.port';
import { SilentLogger } from '../../ports/logger.port';
import type { ApiCallLogEntry, ApiCallLogPort } from '../../repositories/channel-api-call.repository';
import { PartnerHttpClient } from '../../infrastructure/partner-http.client';
import { TokenBucket } from '../../infrastructure/token-bucket';
import { CarexyAdapter } from './carexy.adapter';
import { mapCarexyInventory, toCarexyInventoryWrite } from './carexy.types';
import type { ChannelMappingRepositoryPort } from '../../repositories/channel-mapping.repository';
import type { ExternalProduct } from '../../ports/channel-adapter.port';
import type { AdapterAccount } from '../../domain/channel.types';

const account: AdapterAccount = {
  id: '5',
  publicId: '00000000-0000-4000-8000-000000000005',
  channelId: '1',
  channelCode: 'carexy',
  organizationId: '1',
  baseUrl: 'https://carexy.shop',
  sandbox: false,
  rateLimitPerMin: 600,
  settings: { carexyUserId: '77' },
  credentials: { api_key: 'secret-key' },
};

const noopMappings: ChannelMappingRepositoryPort = {
  findProductMapping: async () => null,
  findProductMappingByExternal: async () => null,
  upsertProductMapping: async () => {
    throw new Error('unused');
  },
  recordOrderIntake: async () => ({ duplicate: false, requestMismatch: false }),
  linkOrder: async () => undefined,
};

function apiCalls(calls: ApiCallLogEntry[]): ApiCallLogPort {
  return {
    record: async (entry) => {
      calls.push(entry);
    },
    list: async () => [],
  };
}

describe('Carexy mapping (§8.2, §53–54)', () => {
  it('maps the documented inventory fields without lifting cost into the domain', () => {
    const snapshot = mapCarexyInventory({
      inventory_uuid: 'inv-1',
      product_uuid: 'prod-1',
      variables: { color: 'red', size: 'M' },
      price: 2_500_000,
      discount_price: 2_100_000,
      discount_expire: '2026-11-01T00:00:00.000Z',
      count: 12,
      sale_min: 1,
      max_sale: 5,
      weight: 350,
      purchase_price: 1_800_000,
      time_send: 2,
    });
    assert.equal(snapshot.available, '12');
    assert.equal(snapshot.price, '2500000');
    assert.equal(snapshot.discountPrice, '2100000');
    assert.deepEqual(snapshot.variables, { color: 'red', size: 'M' });
    assert.equal(snapshot.channelAttributes.saleMin, '1');
    assert.equal(snapshot.channelAttributes.maxSale, '5');
    assert.equal(snapshot.channelAttributes.timeSend, '2');
    assert.equal(JSON.stringify(snapshot).includes('purchase_price'), false);
    assert.equal(JSON.stringify(snapshot).includes('1800000'), false);
  });

  it('builds a write payload with count=available and never purchase_price', () => {
    const write = toCarexyInventoryWrite({
      userId: '77',
      available: '9.0000',
      price: '2500000',
      discountPrice: '2100000',
      weight: '350',
      variables: { color: 'red' },
    });
    assert.equal(write.user_id, '77');
    assert.equal(write.count, '9.0000');
    assert.equal(write.price, '2500000');
    assert.equal(write.discount_price, '2100000');
    assert.deepEqual(write.variables, { color: 'red' });
    assert.equal(JSON.stringify(write).includes('purchase_price'), false);
  });

  it('pushes available stock through PUT /inventories/update/{uuid} with X-API-KEY', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const logs: ApiCallLogEntry[] = [];
    const http = new PartnerHttpClient(
      {
        logger: new SilentLogger(),
        apiCalls: apiCalls(logs),
        rateLimiter: new TokenBucket(new InMemoryKeyValueStore(), {
          capacity: 100,
          refillPerSecond: 100,
        }),
        declaredHosts: ['carexy.shop'],
      },
      {
        fetchImpl: async (url, init) => {
          requests.push({ url, init });
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    );
    const adapter = new CarexyAdapter({
      http,
      mappings: noopMappings,
      logger: new SilentLogger(),
    });

    const result = await adapter.pushInventory(account, [
      { externalVariantId: 'var-1', externalInventoryId: 'inv-1', available: '7.0000' },
    ]);

    assert.deepEqual(result, { ok: true, succeeded: 1, failed: [] });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, 'https://carexy.shop/api/v1/inventories/update/inv-1');
    assert.equal(requests[0]?.init.method, 'PUT');
    const headers = requests[0]?.init.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], 'secret-key');
    const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
    assert.equal(body['user_id'], '77');
    assert.equal(body['count'], '7.0000');
    assert.equal(JSON.stringify(body).includes('purchase_price'), false);
    // API log never persists credentials or raw headers.
    assert.equal(JSON.stringify(logs).includes('secret-key'), false);
    assert.equal(JSON.stringify(logs).includes('headers'), false);
  });

  it('reads the Laravel envelope, maps field fallbacks and paginates to a short page', async () => {
    const requests: string[] = [];
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const productsOf = (page: number): unknown[] =>
      page === 1
        ? Array.from({ length: 50 }, (_, index) => ({
            uuid: `p-${index}`,
            name_fa: `کالا ${index}`,
            sale_price: '2,500,000',
            inventories: [{ inventory_uuid: `i-${index}`, count: 2 }],
          }))
        : [{ id: 'p-last', title: 'آخرین', price: 1000 }];

    const http = new PartnerHttpClient(
      {
        logger: new SilentLogger(),
        apiCalls: apiCalls([]),
        rateLimiter: new TokenBucket(new InMemoryKeyValueStore(), {
          capacity: 100,
          refillPerSecond: 100,
        }),
        declaredHosts: ['carexy.shop'],
      },
      {
        fetchImpl: async (url) => {
          requests.push(url);
          const parsed = new URL(url);
          if (parsed.pathname === '/api/v1/inventories/product/p-last') {
            return json({
              data: [
                { inventory_uuid: 'i-last', count: 3 },
                { inventory_uuid: 'i-extra', count: 4 },
              ],
            });
          }
          return json({ data: { data: productsOf(Number(parsed.searchParams.get('page') ?? '1')) } });
        },
      },
    );
    const adapter = new CarexyAdapter({ http, mappings: noopMappings, logger: new SilentLogger() });

    const products: ExternalProduct[] = [];
    for await (const product of adapter.pullProducts(account)) products.push(product);

    assert.equal(products.length, 51);
    assert.equal(products[0]?.externalProductId, 'p-0');
    assert.equal(products[0]?.title, 'کالا 0');
    assert.equal(products[0]?.price, '2500000');
    assert.equal(products[0]?.available, '2');
    assert.equal(products[0]?.externalVariantId, 'i-0');
    // No stock in the list row: inventories are summed, variant id comes from them.
    assert.equal(products[50]?.externalProductId, 'p-last');
    assert.equal(products[50]?.available, '7');
    assert.equal(products[50]?.externalVariantId, 'i-last');
    assert.equal(requests.filter((url) => new URL(url).pathname === '/api/v1/products').length, 2);
    assert.equal(
      requests.filter((url) => new URL(url).pathname.startsWith('/api/v1/inventories/product/'))
        .length,
      1,
    );
  });

  it('refuses to push without a mapping instead of guessing an inventory id', async () => {
    const http = new PartnerHttpClient(
      {
        logger: new SilentLogger(),
        apiCalls: apiCalls([]),
        rateLimiter: new TokenBucket(new InMemoryKeyValueStore(), {
          capacity: 100,
          refillPerSecond: 100,
        }),
        declaredHosts: ['carexy.shop'],
      },
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
    );
    const adapter = new CarexyAdapter({ http, mappings: noopMappings, logger: new SilentLogger() });
    const result = await adapter.pushInventory(account, [
      { externalVariantId: 'var-2', externalProductId: 'prod-2', available: '1' },
    ]);
    assert.equal(result.succeeded, 0);
    assert.equal(result.failed[0]?.code, 'MAPPING_REQUIRED');
  });
});
