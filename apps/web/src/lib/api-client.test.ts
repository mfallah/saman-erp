import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api-client';
import { completeLogin, getAccessToken, resetAuthStoreForTests } from './auth-store';
import { errorResponse, jsonResponse } from '../test/render-app';

const USER = {
  id: 'user-1',
  fullName: 'کاربر آزمایشی',
  permissions: ['product.read'],
  permissionsVersion: 1,
};

function authHeader(init?: RequestInit): string {
  const headers = init?.headers;
  if (headers === undefined) {
    return '';
  }
  return (headers as Record<string, string>)['Authorization'] ?? '';
}

describe('api-client', () => {
  beforeEach(async () => {
    resetAuthStoreForTests();
    vi.unstubAllGlobals();
    await completeLogin({ accessToken: 'old-token', permissionsVersion: 1 }, USER);
  });

  it('refreshes once on 401, replays with the new token, then unwraps the envelope', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/products')) {
          if (authHeader(init) === 'Bearer new-token') {
            return Promise.resolve(
              jsonResponse({
                data: [{ id: 'p1', nameFa: 'کالا' }],
                meta: { pagination: { mode: 'offset', page: 1, perPage: 20, total: 1 } },
              }),
            );
          }
          return Promise.resolve(errorResponse('TOKEN_EXPIRED', 401));
        }
        if (url.endsWith('/auth/refresh')) {
          return Promise.resolve(jsonResponse({ data: { accessToken: 'new-token', permissionsVersion: 1 } }));
        }
        return Promise.resolve(errorResponse('NOT_FOUND', 404));
      }),
    );

    const page = await api.getPage<{ id: string }>('/products', { page: 1 });

    expect(page.items).toHaveLength(1);
    expect(page.pagination?.total).toBe(1);
    expect(getAccessToken()).toBe('new-token');
    expect(calls.filter((call) => call.url.endsWith('/products'))).toHaveLength(2);
    expect(calls.filter((call) => call.url.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('normalizes domain errors to a stable code with a Persian message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          errorResponse('INSUFFICIENT_STOCK', 422, 'موجودی کافی نیست.'),
        ),
      ),
    );

    await expect(api.post('/inventory/reservations', {})).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      status: 422,
      messageFa: 'موجودی کافی برای این اقلام وجود ندارد.',
    });
  });

  it('maps transport failures to NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));

    const error = await api.get('/products').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('NETWORK_ERROR');
    expect((error as ApiError).isNetworkError).toBe(true);
  });

  it('sends Idempotency-Key and If-Match headers on mutations', async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        captured = init;
        return Promise.resolve(jsonResponse({ data: { id: 'x' } }));
      }),
    );

    await api.post('/products', { nameFa: 'کالا' }, { idempotencyKey: 'key-123' });
    expect((captured?.headers as Record<string, string>)['Idempotency-Key']).toBe('key-123');

    await api.patch('/products/x', { nameFa: 'کالا ۲' }, { ifMatch: 7 });
    expect((captured?.headers as Record<string, string>)['If-Match']).toBe('"7"');
  });
});
