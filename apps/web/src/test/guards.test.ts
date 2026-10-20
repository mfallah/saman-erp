import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isRedirect } from '@tanstack/react-router';
import { completeLogin, resetAuthStoreForTests } from '../lib/auth-store';
import { guardAuthenticated, guardGuest, guardPermission } from '../lib/guards';
import { errorResponse, jsonResponse, mockFetch } from './fetch-mocks';

interface RedirectLike {
  readonly options: { readonly to: string; readonly search?: Record<string, unknown> };
}

function asRedirect(error: unknown): RedirectLike {
  expect(isRedirect(error)).toBe(true);
  return error as RedirectLike;
}

describe('route guards', () => {
  beforeEach(() => {
    resetAuthStoreForTests();
    vi.unstubAllGlobals();
  });

  it('redirects unauthenticated visitors to /login and preserves the return path', async () => {
    mockFetch(() => errorResponse('UNAUTHENTICATED', 401));

    const error = await guardAuthenticated('/products?page=2').catch((caught: unknown) => caught);

    const redirect = asRedirect(error);
    expect(redirect.options.to).toBe('/login');
    expect(redirect.options.search).toEqual({ redirect: '/products?page=2' });
  });

  it('allows authenticated visitors through', async () => {
    mockFetch((url) => {
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse({ data: { accessToken: 'token', permissionsVersion: 1 } });
      }
      return jsonResponse({
        data: { id: 'u1', fullName: 'کاربر', permissions: [], permissionsVersion: 1 },
      });
    });

    await expect(guardAuthenticated('/products')).resolves.toBeUndefined();
  });

  it('redirects to /forbidden when the permission key is missing', () => {
    const error = (() => {
      try {
        guardPermission('product.read');
        return null;
      } catch (caught) {
        return caught;
      }
    })();

    const redirect = asRedirect(error);
    expect(redirect.options.to).toBe('/forbidden');
  });

  it('does not redirect when the permission is granted', async () => {
    await completeLogin(
      { accessToken: 'token', permissionsVersion: 1 },
      { id: 'u1', fullName: 'کاربر', permissions: ['product.read'], permissionsVersion: 1 },
    );
    expect(() => guardPermission('product.read')).not.toThrow();
  });

  it('sends already-authenticated users away from the login screen', async () => {
    await completeLogin(
      { accessToken: 'token', permissionsVersion: 1 },
      { id: 'u1', fullName: 'کاربر', permissions: [], permissionsVersion: 1 },
    );
    const error = await guardGuest().catch((caught: unknown) => caught);
    const redirect = asRedirect(error);
    expect(redirect.options.to).toBe('/');
  });
});
