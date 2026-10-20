import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrap,
  expireSession,
  getAccessToken,
  getSnapshot,
  hasPermission,
  onSessionExpired,
  refreshAccessToken,
  resetAuthStoreForTests,
} from './auth-store';
import { errorResponse, jsonResponse } from '../test/fetch-mocks';

function userPayload(permissions: readonly string[], permissionsVersion = 3) {
  return {
    data: {
      id: 'user-1',
      fullName: 'کاربر آزمایشی',
      mobile: '09121234567',
      permissions,
      permissionsVersion,
      roles: [{ id: 'role-1', name: 'admin' }],
    },
  };
}

describe('auth-store (memory-only token, ADR-0004)', () => {
  beforeEach(() => {
    resetAuthStoreForTests();
    vi.unstubAllGlobals();
  });

  it('bootstraps a session through the refresh cookie and exposes permissions', async () => {
    const storageSpy = vi.spyOn(window.localStorage, 'setItem');
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/auth/refresh')) {
          return Promise.resolve(jsonResponse({ data: { accessToken: 'access-1', permissionsVersion: 3 } }));
        }
        if (url.endsWith('/auth/me')) {
          return Promise.resolve(jsonResponse(userPayload(['product.read', 'sales.order.read'])));
        }
        return Promise.resolve(errorResponse('NOT_FOUND', 404));
      }),
    );

    const restored = await bootstrap();

    expect(restored).toBe(true);
    expect(getSnapshot().status).toBe('authenticated');
    expect(getAccessToken()).toBe('access-1');
    expect(getSnapshot().permissionsVersion).toBe(3);
    expect(hasPermission('product.read')).toBe(true);
    expect(hasPermission('user.read')).toBe(false);
    // Tokens never touch localStorage.
    expect(storageSpy).not.toHaveBeenCalled();
  });

  it('falls back to anonymous when refresh is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(errorResponse('UNAUTHENTICATED', 401))),
    );
    const restored = await bootstrap();
    expect(restored).toBe(false);
    expect(getSnapshot().status).toBe('anonymous');
    expect(getAccessToken()).toBeNull();
    expect(hasPermission('product.read')).toBe(false);
  });

  it('single-flights concurrent refreshes', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ data: { accessToken: 'access-2', permissionsVersion: 1 } })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const [first, second] = await Promise.all([refreshAccessToken(), refreshAccessToken()]);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('notifies listeners and clears state on hard session expiry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/auth/refresh')) {
          return Promise.resolve(jsonResponse({ data: { accessToken: 'access-3', permissionsVersion: 2 } }));
        }
        return Promise.resolve(jsonResponse(userPayload(['dashboard.read'])));
      }),
    );
    await bootstrap();
    expect(getSnapshot().status).toBe('authenticated');

    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);
    expireSession('SESSION_REVOKED');
    unsubscribe();

    expect(listener).toHaveBeenCalledWith('SESSION_REVOKED');
    expect(getSnapshot().status).toBe('anonymous');
    expect(getAccessToken()).toBeNull();
  });
});
